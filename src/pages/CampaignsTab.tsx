import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';
import type { Campaign, EmailTemplate, PendingFollowup, CampaignAttachment, CampaignScheduleInput } from '../types/campaign';
import type { Contact } from '../types/contact';
import {
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_COLORS,
  CAMPAIGN_TYPE_FALLBACK_COLOR,
  CAMPAIGN_TYPE_TO_TEMPLATE_KEY,
  CAMPAIGN_TYPE_TO_TEMPLATE_NAME,
  normalizeCampaignType,
} from '../constants/constants';
import {
  fetchCampaigns,
  deleteCampaign,
  updateCampaign,
  fetchTemplates,
  buildScheduleInput,
  insertCampaign,
  insertCampaignSchedule,
  sendCampaign,
  scheduleCampaign,
  saveDraft,
  uploadCampaignAttachment,
  fetchCampaignAttachments,
  replaceCampaignAttachments,
  removeCampaignAttachment,
  relocatePendingAttachments,
  uploadEmailTemplate,
  deleteEmailTemplate,
  formatFileSize,
  formatTime,
} from '../services/campaignService';
import { fetchContacts } from '../services/contactsService';
import { resolveSegmentRecipients, isManualAudience } from '../utils/contactSegment';
import {
  fetchPendingFollowups,
  sendPendingFollowup,
} from '../services/followupService';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import { supabase } from '../supabase';

interface CampaignsTabProps {
  campaigns: any[];
  contacts?: any[];
  onPersistCampaigns: (campaigns: any[]) => void;
  onToast: (msg: string, type?: string) => void;
  campTabState: 'list' | 'compose' | 'templates' | 'followups';
  setCampTabState: (state: 'list' | 'compose' | 'templates' | 'followups') => void;
  selectedAudienceEmails?: string[];
  onClearSelectedAudienceEmails?: () => void;
}

const TEMPLATE_CATEGORIES = ['All', 'Outreach', 'Pitch', 'Newsletter', 'Client'];

/**
 * True when a template body is a complete HTML email document, exactly as the
 * Template Editor saves it (full <!DOCTYPE>/<html>/<head>/<body> markup,
 * including images, tables, buttons and inline styles). Such bodies must be
 * loaded verbatim into the Campaign composer — never stripped to plain text —
 * so the Campaign preview and the sent email match the saved template.
 * Legacy plain-text templates (which are not HTML documents) keep the
 * plain-text composer behaviour unchanged.
 */
function isFullHtmlDocument(content: string): boolean {
  return /<(?:!doctype|html|head|body)\b/i.test(String(content || '').trim());
}

/**
 * Load a database-backed template's content into the composer. Templates saved
 * by the Template Editor are full HTML documents stored in the `body` column —
 * those are used verbatim (raw HTML preserved, rendered in the preview, and
 * sent as-is). Legacy plain-text bodies keep the existing strip-to-text
 * behaviour so existing templates continue working unchanged.
 */
function applyDatabaseTemplateBody(
  setCompBody: (v: string) => void,
  setBodyIsHtml: (v: boolean) => void,
  setEditorMode: (m: 'text' | 'html' | 'preview') => void,
  body: string
): void {
  if (isFullHtmlDocument(body)) {
    setCompBody(body);
    setBodyIsHtml(true);
    setEditorMode('preview');
  } else {
    setCompBody(stripHtmlTags(body));
    setBodyIsHtml(false);
    setEditorMode('text');
  }
}

/**
 * Convert HTML (template body or stored campaign body) into readable plain text
 * for the plain-text composer. Tags become line breaks, list items become
 * "- " lines, and HTML entities are decoded so placeholders and text stay
 * intact while editing.
 */
function stripHtmlTags(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert the plain-text composer body into clean HTML for the preview.
 * Mirrors the backend `plainTextToHtml` conversion (paragraphs, <br>, lists,
 * escaped entities) so the preview matches what the recipient receives.
 */
function plainTextToHtml(text: string): string {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = escaped.split(/\r?\n/);
  const out: string[] = [];
  let openList: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const closeList = () => {
    if (openList) {
      out.push(`</${openList}>`);
      openList = null;
    }
  };
  const emitParagraph = () => {
    if (paragraph.length) {
      closeList();
      out.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      emitParagraph();
      closeList();
      continue;
    }
    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    const number = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || number) {
      emitParagraph();
      const type: 'ul' | 'ol' = bullet ? 'ul' : 'ol';
      if (openList !== type) {
        closeList();
        out.push(`<${type}>`);
        openList = type;
      }
      out.push(`<li>${(bullet ? bullet[2] : (number ? number[2] : line)).trim()}</li>`);
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  emitParagraph();
  closeList();

  return out.join('\n');
}

/**
 * True when `content` is a raw SMTP/MIME email message rather than an already
 * rendered HTML template. Raw email source begins with transport/routing
 * headers (Delivered-To, Received, MIME-Version, Content-Type, DKIM-Signature,
 * ...) — those lines never begin a saved email template, so their presence is a
 * reliable signal that the stored value is the email SOURCE and must be parsed
 * before it can be previewed as a normal email.
 */
function isMimeEmailSource(content: string): boolean {
  const text = String(content || '');
  if (!text.trim()) return false;
  // A clean HTML document (full <!DOCTYPE>/<html>/<head>/<body> markup) is not
  // raw email source even if it contains a Content-Type meta tag.
  if (/^\s*<(?:!doctype|html|head|body)\b/i.test(text)) return false;
  return /(?:^|\r?\n)(?:Content-Type|MIME-Version|Content-Transfer-Encoding|Message-ID|Return-Path|Delivered-To|Received-SPF|Authentication-Results|DKIM-Signature|ARC-Seal|ARC-Message-Signature|ARC-Authentication-Results|X-Received|X-Google-|Received|Content-Disposition)\s*:/i.test(text);
}

/**
 * Decode a quoted-printable MIME body. Soft line breaks are removed and `=XX`
 * hex escapes are turned back into bytes, which are then decoded as UTF-8 so
 * multibyte characters survive intact.
 */
function decodeQuotedPrintable(input: string): string {
  const joined = String(input || '')
    .replace(/=\r?\n/g, '')
    .replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=') {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(0x3d); // bare '=' (not a valid escape)
      }
    } else {
      const char = String.fromCodePoint(joined.codePointAt(i)!);
      const encoded = new TextEncoder().encode(char);
      bytes.push(...encoded);
      i += char.length - 1;
    }
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

/**
 * Decode a base64 MIME body as UTF-8 text.
 */
function decodeBase64(input: string): string {
  const clean = String(input || '').replace(/\s+/g, '');
  if (!clean) return '';
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Decode a MIME body according to its Content-Transfer-Encoding header.
 * 7bit / 8bit / binary bodies are already usable text and pass through.
 */
function decodeMimeBody(body: string, encoding: string): string {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') return decodeBase64(body);
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

/**
 * Extract the first `text/html` (or, as a fallback, `text/plain`) body from a
 * raw MIME email source, stopping at the multipart boundary. Returns null when
 * the content has no usable body of the requested type.
 */
function extractMimeBody(source: string, kind: 'html' | 'plain'): string | null {
  const text = String(source || '');
  const lines = text.split(/\r?\n/);
  const boundaryMatch = text.match(/boundary\s*=\s*"?([^"\r\n;]+)"?/i);
  const boundary = boundaryMatch ? boundaryMatch[1] : null;
  const headerRe =
    kind === 'html'
      ? /^Content-Type:\s*text\/html(?:\s*;|$)/i
      : /^Content-Type:\s*text\/plain(?:\s*;|$)/i;

  for (let i = 0; i < lines.length; i++) {
    if (!headerRe.test(lines[i])) continue;

    let encoding = '7bit';
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '') {
      const enc = lines[j].match(/^Content-Transfer-Encoding:\s*(\S+)/i);
      if (enc) encoding = enc[1].toLowerCase();
      j++;
    }
    j++; // skip the blank line separating headers from the body

    const bodyLines: string[] = [];
    while (j < lines.length) {
      const line = lines[j];
      if (boundary && line.trim().startsWith('--' + boundary)) break;
      bodyLines.push(line);
      j++;
    }

    const body = bodyLines.join('\n').replace(/\s+$/, '');
    if (!body.trim()) continue;
    return decodeMimeBody(body, encoding);
  }

  return null;
}

/**
 * Produce the HTML that should be rendered for a stored campaign/template body:
 *  - raw MIME/email source → extract + decode its `text/html` part;
 *  - already-rendered HTML → used verbatim;
 *  - plain text             → kept as-is (the plain-text composer handles it).
 *
 * The raw MIME headers and encoded content are NEVER returned — only the
 * decoded HTML body (or readable plain text) reaches the preview.
 */
function extractRenderableEmailHtml(content: string): { html: string; isHtml: boolean } {
  const text = String(content || '');
  if (isMimeEmailSource(text)) {
    const html = extractMimeBody(text, 'html');
    if (html && html.trim()) return { html, isHtml: true };
    const plain = extractMimeBody(text, 'plain');
    if (plain && plain.trim()) return { html: plain, isHtml: false };
    return { html: stripHtmlTags(text), isHtml: false };
  }
  if (/<[a-z][^>]*>/i.test(text)) return { html: text, isHtml: true };
  return { html: text, isHtml: false };
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHLY_POSITIONS = ['First', 'Second', 'Third', 'Fourth', 'Last'];
const MONTHLY_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const MONTHLY_RULES = MONTHLY_POSITIONS.flatMap((p) => MONTHLY_WEEKDAYS.map((d) => `${p} ${d}`));

// ─── Campaign Excel/CSV import (mirrors the Contacts import feature) ─────────

/** Expected column headers shown to the user in the import modal. */
const CAMPAIGN_IMPORT_EXPECTED_HEADERS = [
  'Campaign Name',
  'Subject Line',
  'From Name',
  'Audience Segment',
  'Campaign Type',
  'Template Name',
  'Schedule Type',
  'Schedule Date',
  'Schedule Time',
  'Repeat Every',
  'Repeat Unit',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'Day of Month',
  'Timezone',
];

/**
 * Audience options already available in the Campaign Composer. The importer only
 * accepts these exact choices (case-insensitive) plus explicit email lists, so
 * it never invents a new audience/contact system.
 */
const CAMPAIGN_IMPORT_AUDIENCE_OPTIONS = [
  'All Contacts',
  'OEM Contacts',
  'International Clients',
  'Existing Clients Only',
  'New Leads',
];

/** Normalize a header label: lowercase, trim, strip everything except letters/digits. */
function normalizeHeaderKey(header: string): string {
  return String(header || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Map a normalized header token to a parsed-row field. */
const IMPORT_HEADER_FIELD_MAP: Record<string, keyof CampaignImportFields> = {
  campaignname: 'campaignName',
  subjectline: 'subjectLine',
  fromname: 'fromName',
  audiencesegment: 'audience',
  audience: 'audience',
  campaigntype: 'campaignType',
  campaign: 'campaignType',
  templatename: 'templateName',
  template: 'templateName',
  scheduletype: 'scheduleType',
  scheduledate: 'scheduleDate',
  scheduletime: 'scheduleTime',
  repeatevery: 'repeatEvery',
  repeatunit: 'repeatUnit',
  monday: 'monday',
  tuesday: 'tuesday',
  wednesday: 'wednesday',
  thursday: 'thursday',
  friday: 'friday',
  saturday: 'saturday',
  sunday: 'sunday',
  dayofmonth: 'dayOfMonth',
  timezone: 'timezone',
};

/** Fields extracted from one Excel/CSV row (before validation). */
interface CampaignImportFields {
  campaignName: string;
  subjectLine: string;
  fromName: string;
  audience: string;
  campaignType: string;
  templateName: string;
  scheduleType: string;
  scheduleDate: string;
  scheduleTime: string;
  repeatEvery: string;
  repeatUnit: string;
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
  dayOfMonth: string;
  timezone: string;
}

/** A fully parsed + validated import row with its computed status. */
interface CampaignImportRow extends CampaignImportFields {
  rowNumber: number;
  errors: string[];
  status: 'valid' | 'invalid' | 'duplicate';
  resolvedTemplate: EmailTemplate | null;
  resolvedBody: string;
  /** Weekday flags resolved from the imported Mon–Sun columns. */
  selectedDays: string[];
}

/** Map a Schedule Type label to the composer's internal key. null = no schedule, undefined = invalid. */
function mapScheduleType(value: string): 'one_time' | 'weekly' | 'monthly' | null | undefined {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'one time' || s === 'onetime' || s === 'one_time') return 'one_time';
  if (s === 'weekly' || s === 'week') return 'weekly';
  if (s === 'monthly' || s === 'month') return 'monthly';
  return undefined;
}

/** Validate a YYYY-MM-DD date string. */
function isValidScheduleDate(value: string): boolean {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/** Validate a time string (12h "10:00 AM" or 24h "14:00"). */
function isValidScheduleTime(value: string): boolean {
  const s = String(value || '').trim();
  if (!s) return false;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return false;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (min > 59) return false;
  const mer = (m[4] || '').toUpperCase();
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return h >= 0 && h <= 23;
}

/**
 * Parse a weekday flag cell. Accepts (case-insensitive):
 *   Yes / No, true / false, 1 / 0, checked / unchecked.
 * Blank / empty returns null (treated as unchecked by callers). Any other
 * non-empty value is leniently treated as unchecked.
 */
function parseWeekdayFlag(value: string): boolean | null {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return null;
  if (['yes', 'true', '1', 'checked', 'y', 'on'].includes(s)) return true;
  if (['no', 'false', '0', 'unchecked', 'n', 'off'].includes(s)) return false;
  return false;
}

/** Parse "Repeat Every" into a positive integer. Blank defaults to 1 (composer default). */
function parseRepeatEvery(value: string): number | null {
  const s = String(value || '').trim();
  if (!s) return 1;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** Parse "Day of Month" into an integer in [1, 31]. Blank/invalid returns null. */
function parseDayOfMonth(value: string): number | null {
  const s = String(value || '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 31) return null;
  return n;
}

/**
 * Normalize a Timezone column value. The application already defaults to IST
 * (Asia/Kolkata), so an empty column keeps that default. Common "IST" spellings
 * are mapped to the IANA zone the scheduler expects; otherwise the value is
 * passed through unchanged.
 */
function normalizeImportTimezone(value: string): string {
  const s = String(value || '').trim();
  if (!s) return 'Asia/Kolkata';
  const u = s.toUpperCase();
  if (
    u === 'IST' ||
    u === 'ASIA/KOLKATA' ||
    u === 'KOLKATA' ||
    u === 'UTC+5:30' ||
    u === 'UTC+05:30' ||
    u === 'GMT+5:30' ||
    u === 'GMT+05:30'
  ) {
    return 'Asia/Kolkata';
  }
  return s;
}

const WEEKDAY_COLUMNS: { col: keyof CampaignImportFields; day: string }[] = [
  { col: 'monday', day: 'Monday' },
  { col: 'tuesday', day: 'Tuesday' },
  { col: 'wednesday', day: 'Wednesday' },
  { col: 'thursday', day: 'Thursday' },
  { col: 'friday', day: 'Friday' },
  { col: 'saturday', day: 'Saturday' },
  { col: 'sunday', day: 'Sunday' },
];

/**
 * Normalize any accepted time string (12h "10:00 AM", 24h "14:00", etc.) into
 * the exact 12-hour display format the Campaign Composer uses ("10:00 AM").
 * The underlying scheduler storage format is handled separately by the shared
 * campaign service, so this only affects what the user sees in the UI.
 */
function normalizeTimeToComposer(value: string): string {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const mer = (m[4] || '').toLowerCase();
  if (mer === 'pm' && h !== 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  const suffix = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, '0')}:${min} ${suffix}`;
}

/** Resolve an audience string to a canonical composer value (or flag invalid). */
function resolveAudience(value: string): { value: string; invalid: boolean } {
  const s = String(value || '').trim();
  if (!s) return { value: '', invalid: true };
  const match = CAMPAIGN_IMPORT_AUDIENCE_OPTIONS.find(
    (o) => o.toLowerCase() === s.toLowerCase()
  );
  if (match) return { value: match, invalid: false };
  // Existing composer logic also accepts explicit email lists (contains @ or comma).
  if (s.includes('@') || s.includes(',')) return { value: s, invalid: false };
  return { value: s, invalid: true };
}

/** Resolve a Campaign Type string to a canonical value (or flag invalid). */
function resolveCampaignType(value: string): { value: string; invalid: boolean } {
  const s = String(value || '').trim();
  if (!s) return { value: '', invalid: true };
  const match = (CAMPAIGN_TYPES as readonly string[]).find(
    (t) => t.toLowerCase() === s.toLowerCase()
  );
  if (match) return { value: match, invalid: false };
  return { value: s, invalid: true };
}

// Standardized icon components (consistent with the Contacts import modal).
const IMPORT_ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const UploadIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...IMPORT_ICON_PROPS} width={size} height={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...IMPORT_ICON_PROPS} width={size} height={size}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// Shared style for the Email Body textarea in both plain-text and HTML-source
// editing modes so switching modes never resizes or restyles the editor.
const BODY_TEXTAREA_STYLE: CSSProperties = {
  flex: 1,
  minHeight: '650px',
  width: '100%',
  border: '1px solid #E2E8F0',
  padding: '16px',
  outline: 'none',
  background: '#FFFFFF',
  borderRadius: '0 0 6px 6px',
  fontSize: '13.5px',
  lineHeight: '1.6',
  color: '#334155',
  overflowY: 'auto',
  resize: 'vertical',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

// Style for the rendered HTML email preview shown in the Email Body card. The
// template's own markup renders at natural size inside a scrollable, white
// container so the design is visible just as a recipient would see it.
const BODY_PREVIEW_STYLE: CSSProperties = {
  flex: 1,
  minHeight: '650px',
  width: '100%',
  border: '1px solid #E2E8F0',
  padding: '16px',
  background: '#FFFFFF',
  borderRadius: '0 0 6px 6px',
  overflowY: 'auto',
  boxSizing: 'border-box',
};

// Style for the editor-mode / HTML view toggle pills (Plain Text · HTML ·
// Preview · Source). `active` renders the pill as selected.
function editorTabStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: '8px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    border: active ? '1px solid #2563EB' : '1px solid #E2E8F0',
    background: active ? '#EFF6FF' : '#FFFFFF',
    color: active ? '#1D4ED8' : '#64748B',
    transition: 'all 0.15s ease',
  };
}

function RateCell({
  rate,
  count,
  delivered,
  label,
}: {
  rate: number;
  count: number;
  delivered: number;
  label: 'opened' | 'clicked';
}) {
  const value = Math.min(100, Math.max(0, Number(rate) || 0));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <LinearProgress
          variant="determinate"
          value={value}
          sx={{
            width: 52,
            height: 6,
            borderRadius: 999,
            backgroundColor: '#E5E7EB',
            '& .MuiLinearProgress-bar': {
              backgroundColor: '#10B981',
              borderRadius: 999,
            },
          }}
        />
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', whiteSpace: 'nowrap' }}>{value.toFixed(1)}%</div>
      </div>
      <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{count}/{delivered} {label}</div>
    </div>
  );
}

function CampaignTypeChip({ type }: { type?: string }) {
  const label = type || 'Campaign';
  const colors = CAMPAIGN_TYPE_COLORS[label] || CAMPAIGN_TYPE_FALLBACK_COLOR;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 10px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: colors.bg,
        color: colors.color,
      }}
    >
      {label}
    </span>
  );
}

export default function CampaignsTab({
  campaigns: _propCampaigns,
  contacts: _propContacts,
  onPersistCampaigns,
  onToast,
  campTabState,
  setCampTabState,
  selectedAudienceEmails,
  onClearSelectedAudienceEmails
}: CampaignsTabProps) {
  // ─── SUPABASE STATE ───
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [audienceContacts, setAudienceContacts] = useState<Contact[]>([]);
  const [saving, setSaving] = useState(false);

  // ─── DROPDOWN OPTIONS (loaded from Supabase, not hardcoded) ───
  const [audienceSegments, setAudienceSegments] = useState<{ id: string; name: string }[]>([]);
  const [campaignTypes, setCampaignTypes] = useState<{ id: string; name: string }[]>([]);
  const [dropdownsLoading, setDropdownsLoading] = useState(true);
  const [dropdownsError, setDropdownsError] = useState<string | null>(null);

  // ─── EDITOR STATE ───
  const [compSubject, setCompSubject] = useState('Partnership Opportunity: Design Intelligence for {{company}}');
  const [compName, setCompName] = useState('');
  const [compAudience, setCompAudience] = useState('All Contacts');
  const [compFromName, setCompFromName] = useState('Rupali Sirsath — IUOVA Design Consultancy');
  const [compType, setCompType] = useState('Custom');
  const [compDate, setCompDate] = useState('');
  const [compTime, setCompTime] = useState('10:00 AM');

  // ─── RECURRING SCHEDULE STATE (UI ONLY — NOT PERSISTED) ───
  const [scheduleType, setScheduleType] = useState<'one_time' | 'weekly' | 'monthly'>('one_time');
  const [repeatEvery, setRepeatEvery] = useState(1);
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [monthlyOption, setMonthlyOption] = useState<'day' | 'weekday'>('day');
  const [dayOfMonth, setDayOfMonth] = useState(15);
  const [weekdayRule, setWeekdayRule] = useState('First Monday');
  const [previewOpen, setPreviewOpen] = useState(false);

  // Batch / throttled sending is HARD-CODED: 30 contacts per batch, 1 hour apart.
  // These are fixed and not user-editable — kept as constants for the send payload.
  const BATCH_SIZE = 30;
  const BATCH_INTERVAL_MINUTES = 60;
  const [batchEnabled, setBatchEnabled] = useState(true);
  const [batchSize, setBatchSize] = useState(BATCH_SIZE);
  const [batchIntervalUnit, setBatchIntervalUnit] = useState<'hours'>('hours');
  const [batchIntervalValue, setBatchIntervalValue] = useState(1);
  const [previewHtml, setPreviewHtml] = useState('');
  const [compBody, setCompBody] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // ─── TEMPLATE LOADING / EDITOR MODE STATE ───
  // id of the template currently fetching its HTML from Supabase Storage.
  const [templateLoadingId, setTemplateLoadingId] = useState<string | null>(null);
  // Error message shown when a storage-backed template fails to load.
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);
  // 'text' = existing plain-text composer (database templates);
  // 'html' = raw HTML source editor (storage-backed templates);
  // 'preview' = rendered email preview (default view after loading a template).
  const [editorMode, setEditorMode] = useState<'text' | 'html' | 'preview'>('text');
  // True when the current Email Body is raw HTML (storage template), false when
  // it is plain text. Drives what the 'preview' mode renders.
  const [bodyIsHtml, setBodyIsHtml] = useState(false);

  // ─── PENDING FOLLOW-UPS STATE (Pending Follow-ups tab) ───
  const [pendingFollowups, setPendingFollowups] = useState<PendingFollowup[]>([]);
  const [pendingFollowupsLoading, setPendingFollowupsLoading] = useState(true);
  const [pendingFollowupsError, setPendingFollowupsError] = useState<string | null>(null);
  const [sendingFollowupId, setSendingFollowupId] = useState<string | null>(null);

  // ─── ATTACHMENTS STATE (composer) ───
  const [attachments, setAttachments] = useState<CampaignAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  // ─── TEMPLATE UPLOAD STATE (Load Template section) ───
  const [templateUploading, setTemplateUploading] = useState(false);
  const [templateUploadError, setTemplateUploadError] = useState<string | null>(null);
  const [templateUploadSuccess, setTemplateUploadSuccess] = useState<string | null>(null);
  const templateFileInputRef = useRef<HTMLInputElement>(null);

  // ─── TEMPLATE DELETE STATE (Load Template section) ───
  const [templateToDelete, setTemplateToDelete] = useState<EmailTemplate | null>(null);
  const [templateDeleting, setTemplateDeleting] = useState(false);
  const [templateInUse, setTemplateInUse] = useState<EmailTemplate | null>(null);
  const [templateDeleteError, setTemplateDeleteError] = useState<string | null>(null);

  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // ─── CAMPAIGN EXCEL/CSV IMPORT STATE ───
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importRows, setImportRows] = useState<CampaignImportRow[]>([]);
  const [importDragging, setImportDragging] = useState(false);
  const [importParsing, setImportParsing] = useState(false);
  const [importSubmitting, setImportSubmitting] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const [prevSelectedEmails, setPrevSelectedEmails] = useState<string[] | undefined>(selectedAudienceEmails);
  if (
    selectedAudienceEmails &&
    selectedAudienceEmails.length > 0 &&
    prevSelectedEmails !== selectedAudienceEmails
  ) {
    setPrevSelectedEmails(selectedAudienceEmails);
    setCompAudience(selectedAudienceEmails.join(', '));
  }

  // ─── TEMPLATES STATE ───
  const [selectedTemplateCategory, setSelectedTemplateCategory] = useState('All');

  const filteredTemplates = templates.filter(t =>
    selectedTemplateCategory === 'All' || t.category === selectedTemplateCategory
  );

  // ─── LOAD DATA FROM SUPABASE ───
  const refreshCampaigns = useCallback(async () => {
    const { data, error } = await fetchCampaigns();
    if (error) {
      setFetchError(error);
      setCampaigns([]);
      onToast('Failed to load campaigns: ' + error, 'error');
    } else {
      setFetchError(null);
      setCampaigns(data);
      onPersistCampaigns(data);
    }
    setLoading(false);
  }, [onPersistCampaigns, onToast]);

  // Silent background refresh — keeps Open Rate / Click Rate live as
  // recipients open and click the sent emails, without spamming toasts.
  const pollCampaigns = useCallback(async () => {
    const { data, error } = await fetchCampaigns();
    if (error) {
      console.error('Campaign auto-refresh failed:', error);
    } else if (data) {
      setFetchError(null);
      setCampaigns(data);
      onPersistCampaigns(data);
    }
  }, [onPersistCampaigns]);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    const { data, error } = await fetchTemplates();
    if (error) {
      setTemplatesError(error);
      setTemplates([]);
      onToast('Failed to load templates: ' + error, 'error');
    } else {
      setTemplates(data);
    }
    setTemplatesLoading(false);
  }, [onToast]);

  const loadAudienceContacts = useCallback(async () => {
    const { data, error } = await fetchContacts();
    if (error) {
      onToast('Failed to load contacts: ' + error, 'error');
    } else {
      setAudienceContacts(data);
    }
  }, [onToast]);

  // Load the Audience Segment + Campaign Type dropdown options from Supabase.
  //
  // The Campaign Audience Segment is driven EXCLUSIVELY by `contact_types`
  // (one option per contact type, e.g. "Existing Client (Vatsal/ Shubham)",
  // "New Client - Inbound", "New Client - Outbound", "New Lead", "Test Client").
  // Each option's value is the EXACT `contacts.contact_type` string, so selecting
  // a segment is a direct connection to `contacts.contact_type` — the resolver
  // resolves `WHERE contact_type = <segment>` (exact, case-insensitive).
  //
  // `company_categories` are intentionally NOT offered as audience segments: per
  // requirement, audience filtering must never use `company_category`.
  //
  // The segment COUNT is computed from the `contacts` table via getSegmentCount,
  // so it always equals the number of recipients the campaign actually emails.
  // Adding a row to `contact_types` makes it appear here automatically — no
  // frontend code change required.
  const loadDropdownOptions = useCallback(async () => {
    setDropdownsLoading(true);
    setDropdownsError(null);
    const [ctRes, typeRes] = await Promise.all([
      supabase
        .from('contact_types')
        .select('id, name')
        .eq('is_active', true)
        .order('name'),
      supabase
        .from('campaign_types')
        .select('*')
        .eq('is_active', true)
        .order('name'),
    ]);
    const errors: string[] = [];
    if (ctRes.error) errors.push('Failed to load contact types.');
    if (typeRes.error) errors.push('Failed to load campaign types.');
    if (errors.length > 0) {
      setDropdownsError(errors.join(' '));
    } else {
      // "All Contacts" is added as the first <option> in the render, showing the
      // total contact count. Every other option is an exact contact_type value.
      const segments: { id: string; name: string }[] = (ctRes.data || []).map(
        (r: any) => ({ id: String(r.id), name: r.name })
      );
      setAudienceSegments(segments);
      setCampaignTypes((typeRes.data || []) as { id: string; name: string }[]);
    }
    setDropdownsLoading(false);
  }, []);

  const loadPendingFollowups = useCallback(async () => {
    setPendingFollowupsLoading(true);
    setPendingFollowupsError(null);
    try {
      const data = await fetchPendingFollowups();
      setPendingFollowups(data || []);
    } catch (err) {
      setPendingFollowupsError(err instanceof Error ? err.message : 'Failed to load follow-ups');
      setPendingFollowups([]);
    } finally {
      setPendingFollowupsLoading(false);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      await Promise.all([
        refreshCampaigns(),
        loadTemplates(),
        loadAudienceContacts(),
        loadDropdownOptions(),
      ]);
    };
    void load();
  }, [refreshCampaigns, loadTemplates, loadAudienceContacts, loadDropdownOptions]);

  // Auto-refresh the campaign list while it is on screen so Open Rate /
  // Click Rate update after sending and as recipients engage.
  useEffect(() => {
    if (campTabState !== 'list') return;
    const interval = window.setInterval(() => {
      void pollCampaigns();
    }, 15000);
    return () => window.clearInterval(interval);
  }, [campTabState, pollCampaigns]);

  // Load the Pending Follow-ups queue whenever that tab is opened. Deferred so
  // the loading setState does not run synchronously inside the effect.
  useEffect(() => {
    if (campTabState !== 'followups') return;
    const timer = window.setTimeout(() => { void loadPendingFollowups(); }, 0);
    return () => window.clearTimeout(timer);
  }, [campTabState, loadPendingFollowups]);

  // ─── PLAIN-TEXT COMPOSER COMMANDS ───
  const insertMergeTag = (tag: string) => {
    const ta = bodyRef.current;
    if (!ta) {
      setCompBody(prev => prev + tag);
      return;
    }
    const start = ta.selectionStart ?? compBody.length;
    const end = ta.selectionEnd ?? compBody.length;
    const next = compBody.slice(0, start) + tag + compBody.slice(end);
    setCompBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + tag.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  // Match a template by id, legacy key slug, OR name. The `templates` table has
  // no key/slug column, so template.key is a UUID — matching by name is what
  // makes dropdown selection and template cards resolve to the right template.
  const findTemplate = (idOrKey: string) =>
    templates.find(t => t.id === idOrKey || t.key === idOrKey || t.name === idOrKey);

  // Apply a template to the composer: highlight the selected card and replace
  // ONLY the Email Body editor with the template content. The Subject Line is
  // never touched by template selection — it is always typed manually.
  //
  //  - template_source === 'database': body is loaded as PLAIN TEXT so
  //    placeholders like {{first_name}} stay intact while the user edits.
  //    Subject and every other field are left exactly as entered (unchanged
  //    legacy behavior).
  //  - template_source === 'storage': the HTML file is fetched from Supabase
  //    Storage using the row's storage_bucket / storage_path, loaded into the
  //    HTML editor (raw HTML preserved, never converted to plain text). The
  //    Subject Line is left exactly as entered.
  //
  // On a storage fetch failure the previous subject/body are kept untouched and
  // a clear error is shown — the editor never falls back to an empty body.
  const handleSelectTemplate = async (t: EmailTemplate) => {
    setSelectedTemplate(t);
    setTemplateLoadError(null);

    if (t.template_source === 'storage') {
      if (!t.storage_bucket || !t.storage_path) {
        setTemplateLoadError(`Template '${t.name}' is missing a storage bucket or file path.`);
        return;
      }
      setTemplateLoadingId(t.id);
      try {
        const { data } = supabase.storage
          .from(t.storage_bucket)
          .getPublicUrl(t.storage_path);
        if (!data?.publicUrl) {
          throw new Error('Could not resolve the template file URL.');
        }
        const response = await fetch(data.publicUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch template file (HTTP ${response.status}).`);
        }
        const html = await response.text();
        if (!html.trim()) {
          throw new Error('The template file is empty.');
        }
        setCompBody(html);
        setBodyIsHtml(true);
        setEditorMode('preview');
        onToast(`Template '${t.name}' loaded successfully.`, 'success');
      } catch (err) {
        setTemplateLoadError(err instanceof Error ? err.message : 'Failed to load template from storage.');
      } finally {
        setTemplateLoadingId(null);
      }
      return;
    }

    applyDatabaseTemplateBody(setCompBody, setBodyIsHtml, setEditorMode, t.body || '');
    onToast(`Template '${t.name}' loaded successfully.`, 'success');
  };

  // Load a template by id/key (used by the Template Library) and switch to the
  // composer so the user can review the prefilled content.
  const loadTemplate = (id: string) => {
    const t = findTemplate(id);
    if (!t) return;
    void handleSelectTemplate(t);
    setCampTabState('compose');
  };

  const handleTypeChange = (val: string) => {
    setCompType(val);
    const key = CAMPAIGN_TYPE_TO_TEMPLATE_KEY[val];
    // Resolve the template by legacy key slug, then by the template NAME that
    // corresponds to this type (templates carry no key column in the DB).
    const t =
      (key ? findTemplate(key) : null) ||
      (CAMPAIGN_TYPE_TO_TEMPLATE_NAME[val] ? findTemplate(CAMPAIGN_TYPE_TO_TEMPLATE_NAME[val]) : null);
    // Only the Email Body is replaced with the linked template's content; all
    // other fields (name, subject, from, audience, schedule) stay as entered.
    if (t) {
      if (t.template_source === 'storage') {
        void handleSelectTemplate(t);
      } else {
        applyDatabaseTemplateBody(setCompBody, setBodyIsHtml, setEditorMode, t.body || '');
      }
    }
  };

  const openComposer = () => {
    setEditingId(null);
    setSelectedTemplate(null);
    setCompName('');
    setCompBody('');
    setBodyIsHtml(false);
    setEditorMode('text');
    setTemplateLoadError(null);
    setTemplateLoadingId(null);
    setAttachments([]);
    setAttachmentError(null);
    setCampTabState('compose');
  };

  const openEditCampaign = (c: Campaign) => {
    setEditingId(c.id);
    setCompName(c.name);
    setCompSubject(c.subject === 'No Subject' ? '' : c.subject);
    setCompAudience(c.audience || 'All Contacts');
    setCompFromName(c.fromName || 'Rupali Sirsath — IUOVA Design Consultancy');
    // Preserve the saved Campaign Type. A legacy key (e.g. 'cold') is normalized
    // to its label; an inactive/removed type (not in the live dropdown) is kept
    // verbatim so the existing campaign keeps displaying its saved value.
    const normalizedType = normalizeCampaignType(c.campaignType);
    const typeStillExists =
      campaignTypes.some((t) => t.name === normalizedType) ||
      (CAMPAIGN_TYPES as readonly string[]).includes(normalizedType as never);
    setCompType(typeStillExists ? normalizedType : (c.campaignType || 'Custom'));
    setCompDate(c.scheduleDate);
    setCompTime(c.scheduleTime || '10:00 AM');
    // Prefill batch / throttled-sending settings (defaults keep existing
    // campaigns sending all recipients at once).
    setBatchEnabled(Boolean(c.batchEnabled));
    setBatchSize(typeof c.batchSize === 'number' ? c.batchSize : 30);
    const savedInterval = typeof c.batchIntervalMinutes === 'number' ? c.batchIntervalMinutes : 60;
    if (savedInterval >= 60 && savedInterval % 60 === 0) {
      setBatchIntervalUnit('hours');
      setBatchIntervalValue(savedInterval / 60);
    } else {
      setBatchIntervalUnit('minutes');
      setBatchIntervalValue(savedInterval);
    }
    // Load the campaign's saved email the way a recipient would see it: raw
    // MIME / email-source bodies are parsed down to their decoded HTML, already
    // rendered HTML is used verbatim, and legacy plain-text bodies stay plain
    // text. The raw MIME headers / encoded content are never shown.
    const extracted = extractRenderableEmailHtml(c.emailBody || '');
    setCompBody(extracted.html);
    setBodyIsHtml(extracted.isHtml);
    setEditorMode(extracted.isHtml ? 'preview' : 'text');
    setAttachments([]);
    setAttachmentError(null);
    setCampTabState('compose');

    // Load the campaign's saved attachments (best-effort).
    void (async () => {
      const { data: savedAttachments, error: attErr } = await fetchCampaignAttachments(c.id);
      if (attErr) {
        onToast('Failed to load attachments: ' + attErr, 'error');
      } else {
        setAttachments(savedAttachments);
      }
    })();
  };

  // The recipient count for the selected segment. This is computed with the
  // EXACT same resolver the campaign is sent with (resolveSegmentRecipients in
  // src/utils/contactSegment → supabase/functions/_shared/audience.ts):
  //   1. filter the Contacts table by the segment's category
  //   2. keep only contacts with a valid, deliverable email
  //   3. remove duplicate email addresses
  // So the number shown in the dropdown is always identical to the number of
  // recipients the campaign actually emails. An explicit email list is also
  // resolved through the same path.
  //
  // Segment → Contacts rules (category prefix, case-insensitive):
  //   All Contacts          → every contact with a valid email
  //   OEM Contacts          → company_category = 'oem'
  //   International Clients  → company_category = 'international'
  //   Existing Clients Only  → contact_type starts with 'existing client'
  //   New Clients            → contact_type starts with 'new client'
  //   New Leads              → contact_type = 'new lead'
  const getSegmentCount = (segment: string) => {
    return resolveSegmentRecipients(audienceContacts, segment).length;
  };

  // ─── LAUNCH OR SCHEDULE ───
  const handleSaveCampaign = async (status: 'sent' | 'scheduled' | 'draft') => {
    if (saving) return;
    if (!compName.trim()) {
      onToast('Campaign Name is required', 'error');
      return;
    }
    const bodyText = compBody;
    if (!bodyText.trim()) {
      onToast('Email Body cannot be empty', 'error');
      return;
    }

    // Confirmation logic for sending or scheduling to target recipients
    if (status === 'sent' || status === 'scheduled') {
      const recipientCount = getSegmentCount(compAudience);
      const actionVerb = status === 'sent' ? 'send immediately' : 'schedule';
      const confirmMsg = `Are you sure you want to ${actionVerb} this campaign to ${recipientCount} recipient(s)?`;
      if (!window.confirm(confirmMsg)) {
        return;
      }
    }

    const selectedTemplate = findTemplate(compType);

    const includeSchedule =
      status === 'scheduled' ||
      scheduleType === 'one_time' ||
      scheduleType === 'weekly' ||
      scheduleType === 'monthly';

    const payload = {
      id: editingId !== null ? String(editingId) : null,
      campaign_name: compName.trim(),
      subject_line: compSubject.trim() || '',
      from_name: compFromName.trim() || '',
      audience_segment: compAudience || 'All Contacts',
      campaign_type: compType || '',
      html_content: bodyText || '',
      schedule_date: status === 'scheduled' ? (compDate || undefined) : undefined,
      schedule_time: status === 'scheduled' ? (compTime || undefined) : undefined,
      template_name: selectedTemplate?.name || null,
      template_id: selectedTemplate?.id || null,
      // Batch / throttled sending is HARD-CODED (30 contacts per batch, 1 hour).
      batch_enabled: true,
      batch_size: 30,
      batch_interval_minutes: 60,
      schedule: includeSchedule
        ? buildScheduleInput({
            scheduleType,
            compDate,
            compTime,
            repeatEvery,
            selectedDays,
            monthlyOption,
            dayOfMonth,
            weekdayRule,
          })
        : null,
      attachments: attachments.map((a) => ({
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        storage_bucket: a.storage_bucket,
        storage_path: a.storage_path,
      })),
    };

    setSaving(true);
    try {
      // Move a brand-new composer's not-yet-persisted files into the campaign's
      // Storage folder (campaign-attachments/{campaign_name}/{file_name}) BEFORE
      // the campaign is sent or its attachment metadata is persisted, so the
      // stored storage_path always equals the real object path. The saved
      // campaign_name equals the trimmed payload.campaign_name (saveCampaignCloud
      // stores String(payload.campaign_name).trim()).
      if (attachments.length > 0) {
        const relocated = await relocatePendingAttachments(payload.campaign_name, attachments);
        setAttachments(relocated);
        payload.attachments = relocated.map((a) => ({
          file_name: a.file_name,
          file_type: a.file_type,
          file_size: a.file_size,
          storage_bucket: a.storage_bucket,
          storage_path: a.storage_path,
        }));
      }

      let savedCampaignId: string | null = null;
      if (status === 'sent') {
        const result = await sendCampaign(payload) as { campaign_id?: string };
        savedCampaignId = result?.campaign_id || null;
        onToast('Campaign sent successfully!', 'success');
      } else if (status === 'scheduled') {
        const result = await scheduleCampaign(payload) as { campaign_id?: string };
        savedCampaignId = result?.campaign_id || null;
        onToast(`Campaign scheduled for ${compDate}`, 'success');
      } else {
        const result = await saveDraft(payload) as { id?: string; campaign_id?: string };
        savedCampaignId = result?.id || result?.campaign_id || null;
        onToast('Campaign saved as draft', 'success');
      }

      // Persist the attachment metadata against the saved campaign. Send Now
      // carries the list inside the send-campaign Edge Function payload (it
      // creates the campaign row), so only schedule/draft persist it here —
      // best-effort: a failure must not undo the campaign save.
      if (savedCampaignId && status !== 'sent') {
        const { error: attError } = await replaceCampaignAttachments(
          String(savedCampaignId),
          payload.attachments
        );
        if (attError) {
          onToast('Campaign saved, but attachments could not be saved: ' + attError, 'error');
        }
      }

      // Reset Form
      setEditingId(null);
      setCompName('');
      setCompSubject('');
      setCompDate('');
      setCompTime('10:00 AM');
      setScheduleType('one_time');
      setRepeatEvery(1);
      setSelectedDays([]);
      setMonthlyOption('day');
      setDayOfMonth(15);
      setWeekdayRule('First Monday');
      setBatchEnabled(false);
      setBatchSize(30);
      setBatchIntervalUnit('hours');
      setBatchIntervalValue(1);
setCompBody('');
    setBodyIsHtml(false);
    setEditorMode('text');
    setAttachments([]);
      setAttachmentError(null);
      setCampTabState('list');
      if (onClearSelectedAudienceEmails) {
        onClearSelectedAudienceEmails();
      }
      setLoading(true);
      await refreshCampaigns();
    } catch (error: any) {
      onToast(error?.message || 'Failed to save campaign', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCampaign = async (id: string) => {
    if (!confirm('Delete this campaign?')) return;
    const { error } = await deleteCampaign(id);
    if (error) {
      onToast('Failed to delete campaign: ' + error, 'error');
      return;
    }
    setLoading(true);
    await refreshCampaigns();
    onToast('Campaign deleted', 'info');
  };

  // Send one pending follow-up from the Pending Follow-ups tab.
  const handleSendFollowup = async (id: string) => {
    if (sendingFollowupId) return;
    if (!window.confirm('Send this follow-up email now?')) return;
    setSendingFollowupId(id);
    try {
      await sendPendingFollowup(id);
      onToast('Follow-up sent', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to send follow-up', 'error');
    } finally {
      setSendingFollowupId(null);
      await loadPendingFollowups();
    }
  };

  const formatDateTime = (input?: string | null) => {
    if (!input) return '—';
    const date = new Date(input);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  // Upload the chosen files to Supabase Storage and add their metadata to the
  // composer's list. For an EXISTING campaign the metadata row is persisted
  // immediately (real campaign_id / storage_bucket / storage_path). For a
  // brand-NEW campaign only the file is uploaded — the attachment stays in
  // temporary composer state (no campaign row is created) and its metadata is
  // persisted after Save Draft / Send Now / Schedule creates the campaign.
  const handleAddAttachments = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingAttachment(true);
    setAttachmentError(null);
    try {
      for (const file of Array.from(files)) {
        const uploaded = await uploadCampaignAttachment(file, editingId);
        setAttachments((prev) => [...prev, uploaded]);
      }
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Failed to upload attachment');
    } finally {
      setUploadingAttachment(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
    }
  };

  // Remove an attachment: delete its Storage object (best-effort) and, when the
  // metadata was already persisted against a saved campaign, its DB row, then
  // drop it from the composer's list. Before a campaign is saved a temporary
  // attachment is only removed from composer state — no campaign row is ever
  // created or deleted here.
  const handleRemoveAttachment = async (attachment: CampaignAttachment) => {
    const { error } = await removeCampaignAttachment(attachment);
    if (error) {
      onToast(error, 'error');
      return;
    }
    const remaining = attachments.filter((a) => a.storage_path !== attachment.storage_path);
    setAttachments(remaining);

    onToast(`Removed ${attachment.file_name}`, 'info');
  };

  // Upload a .html/.htm email template file into the existing template storage
  // + templates table (template_source='storage'), then add it to the local
  // list so the new card shows up in Load Template / Template Library
  // immediately. The template persists in Supabase, so it survives a refresh.
  const handleUploadTemplate = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setTemplateUploading(true);
    setTemplateUploadError(null);
    setTemplateUploadSuccess(null);
    try {
      const uploaded = await uploadEmailTemplate(file);
      setTemplates((prev) =>
        [...prev, uploaded].sort((a, b) => a.name.localeCompare(b.name))
      );
      setTemplateUploadSuccess('Template uploaded successfully');
      onToast(`Template '${uploaded.name}' uploaded successfully.`, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload template';
      setTemplateUploadError(message);
      onToast(message, 'error');
    } finally {
      setTemplateUploading(false);
      if (templateFileInputRef.current) templateFileInputRef.current.value = '';
    }
  };

  // Ask for confirmation before deleting a template. Nothing is deleted until
  // the user confirms in the dialog — Cancel closes it and leaves the card.
  const requestDeleteTemplate = (t: EmailTemplate) => {
    setTemplateDeleteError(null);
    setTemplateToDelete(t);
  };

  // Cancel the delete confirmation — close the dialog, do nothing.
  const cancelDeleteTemplate = () => {
    if (templateDeleting) return;
    setTemplateToDelete(null);
    setTemplateDeleteError(null);
  };

  // Confirm deletion: delete ONLY the selected email template (by its real DB
  // id) through the shared template service. The card is removed from the
  // list on success; a template currently used by a campaign is blocked with a
  // "Template In Use" warning. Other campaign fields / contacts / sequences /
  // follow-ups are never touched.
  const confirmDeleteTemplate = async () => {
    if (!templateToDelete) return;
    setTemplateDeleting(true);
    setTemplateDeleteError(null);
    try {
      const result = await deleteEmailTemplate(templateToDelete);
      if (!result.ok) {
        if (result.inUse) {
          setTemplateInUse(templateToDelete);
          setTemplateToDelete(null);
        } else {
          setTemplateDeleteError(result.error || 'Failed to delete template');
        }
        return;
      }
      const deleted = templateToDelete;
      setTemplates((prev) => prev.filter((t) => t.id !== deleted.id));
      setSelectedTemplate((prev) => (prev && prev.id === deleted.id ? null : prev));
      setTemplateToDelete(null);
      onToast(`Template '${deleted.name}' deleted successfully.`, 'success');
    } catch (err) {
      setTemplateDeleteError(err instanceof Error ? err.message : 'Failed to delete template');
    } finally {
      setTemplateDeleting(false);
    }
  };

  // Open Preview Modal
  const openPreview = () => {
    // In HTML mode the body is already markup; in plain-text mode convert it to
    // the same clean HTML the backend will generate. Then replace merge tags
    // with sample values for the preview. A body loaded as HTML (template or
    // extracted from a raw email source) is always rendered directly — it must
    // never be re-escaped through plainTextToHtml.
    let html =
      bodyIsHtml || editorMode === 'html'
        ? String(compBody || '')
        : plainTextToHtml(compBody);
    html = html
      .replace(/{{first_name}}/g, 'Rajiv')
      .replace(/{{company}}/g, 'Bajaj Electricals')
      .replace(/{{month}}/g, 'May')
      .replace(/{{headline}}/g, 'The Future of Fans')
      .replace(/{{issue}}/g, '08');

    setPreviewHtml(html);
    setPreviewOpen(true);
  };

  // ─── CAMPAIGN IMPORT: file parsing ────────────────────────────────────────
  const processImportFile = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['xlsx', 'xls', 'csv'].includes(ext)) {
      onToast('Please upload a .xlsx, .xls, or .csv file', 'error');
      return;
    }
    setImportParsing(true);
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        let rows: any[] = [];
        const XLSX = (window as any).XLSX;
        if (!XLSX) {
          onToast('Excel parsing library not available', 'error');
          setImportParsing(false);
          return;
        }
        if (ext === 'csv') {
          const wb = XLSX.read(String(e.target.result ?? ''), { type: 'string' });
          rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        } else {
          const wb = XLSX.read(e.target.result, { type: 'binary' });
          rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        }
        setImportRows(parseImportRows(rows));
      } catch (err: any) {
        onToast('Error reading file: ' + err.message, 'error');
        setImportRows([]);
      } finally {
        setImportParsing(false);
      }
    };
    if (ext === 'csv') reader.readAsText(file);
    else reader.readAsBinaryString(file);
  };

  // Map raw Excel/CSV rows into validated CampaignImportRow[] using the existing
  // template list + loaded campaigns for template resolution and duplicate checks.
  const parseImportRows = (rawRows: any[]): CampaignImportRow[] => {
    const seenNames = new Set<string>();
    const existingNames = new Set(
      campaigns
        .map((c) => String(c.name || '').trim().toLowerCase())
        .filter(Boolean)
    );

    return rawRows.map((raw, idx) => {
      // Build a header→value map keyed by normalized token (first match wins).
      const fieldValues: Partial<CampaignImportFields> = {};
      Object.keys(raw).forEach((header) => {
        const key = IMPORT_HEADER_FIELD_MAP[normalizeHeaderKey(header)];
        if (key && fieldValues[key] === undefined) {
          fieldValues[key] = String(raw[header] ?? '').trim();
        }
      });

      const fields: CampaignImportFields = {
        campaignName: fieldValues.campaignName || '',
        subjectLine: fieldValues.subjectLine || '',
        fromName: fieldValues.fromName || '',
        audience: fieldValues.audience || '',
        campaignType: fieldValues.campaignType || '',
        templateName: fieldValues.templateName || '',
        scheduleType: fieldValues.scheduleType || '',
        scheduleDate: fieldValues.scheduleDate || '',
        scheduleTime: fieldValues.scheduleTime || '',
        repeatEvery: fieldValues.repeatEvery || '',
        repeatUnit: fieldValues.repeatUnit || '',
        monday: fieldValues.monday || '',
        tuesday: fieldValues.tuesday || '',
        wednesday: fieldValues.wednesday || '',
        thursday: fieldValues.thursday || '',
        friday: fieldValues.friday || '',
        saturday: fieldValues.saturday || '',
        sunday: fieldValues.sunday || '',
        dayOfMonth: fieldValues.dayOfMonth || '',
        timezone: fieldValues.timezone || '',
      };

      const errors: string[] = [];
      const rowNumber = idx + 1;

      // Required text fields
      if (!fields.campaignName) errors.push('Campaign Name is required');
      if (!fields.subjectLine) errors.push('Subject Line is required');
      if (!fields.fromName) errors.push('From Name is required');

      // Audience Segment
      const audience = resolveAudience(fields.audience);
      if (audience.invalid) {
        errors.push(
          `Invalid audience segment: "${fields.audience}". Valid options: ${CAMPAIGN_IMPORT_AUDIENCE_OPTIONS.join(', ')}`
        );
      }

      // Campaign Type
      const campaignType = resolveCampaignType(fields.campaignType);
      if (campaignType.invalid) {
        errors.push(
          `Invalid campaign type: "${fields.campaignType}". Valid options: ${CAMPAIGN_TYPES.join(', ')}`
        );
      }

      // Template Name (only validated when supplied)
      let resolvedTemplate: EmailTemplate | null = null;
      let resolvedBody = '';
      if (fields.templateName) {
        resolvedTemplate =
          templates.find(
            (t) => t.name.trim().toLowerCase() === fields.templateName.trim().toLowerCase()
          ) || null;
        if (!resolvedTemplate) {
          errors.push(`Template not found: ${fields.templateName}`);
        } else {
          resolvedBody = resolvedTemplate.body || '';
        }
      }

      // Resolve the selected weekdays (Mon–Sun) regardless of schedule type so
      // they can be reused by the preview and the schedule builder.
      const selectedDays = WEEKDAY_COLUMNS
        .filter(({ col }) => parseWeekdayFlag(fields[col]) === true)
        .map(({ day }) => day);

      // Schedule Type
      const scheduleType = mapScheduleType(fields.scheduleType);
      if (scheduleType === undefined) {
        errors.push(
          `Invalid schedule type: "${fields.scheduleType}". Valid options: One Time, Weekly, Monthly`
        );
      }

      // Schedule Date / Time / recurrence validity (only when a schedule is set)
      if (scheduleType) {
        if (scheduleType === 'one_time') {
          if (!fields.scheduleDate) {
            errors.push('Schedule Date is required for One Time');
          } else if (!isValidScheduleDate(fields.scheduleDate)) {
            errors.push(`Invalid schedule date: "${fields.scheduleDate}" (use YYYY-MM-DD)`);
          }
          if (!fields.scheduleTime) {
            errors.push('Schedule Time is required for One Time');
          } else if (!isValidScheduleTime(fields.scheduleTime)) {
            errors.push(`Invalid schedule time: "${fields.scheduleTime}" (use HH:MM or HH:MM AM/PM)`);
          }
        } else if (scheduleType === 'weekly') {
          const repeatEvery = parseRepeatEvery(fields.repeatEvery);
          if (repeatEvery === null) {
            errors.push('Repeat Every must be a positive number for Weekly schedule');
          }
          if (selectedDays.length === 0) {
            errors.push('No weekday selected for Weekly schedule');
          }
          if (fields.repeatUnit && !/week/i.test(fields.repeatUnit)) {
            errors.push('Repeat Unit must be Week(s) for Weekly schedule');
          }
          if (!fields.scheduleTime) {
            errors.push('Schedule Time is required for Weekly schedule');
          } else if (!isValidScheduleTime(fields.scheduleTime)) {
            errors.push(`Invalid schedule time: "${fields.scheduleTime}" (use HH:MM or HH:MM AM/PM)`);
          }
        } else if (scheduleType === 'monthly') {
          const repeatEvery = parseRepeatEvery(fields.repeatEvery);
          if (repeatEvery === null) {
            errors.push('Repeat Every must be a positive number for Monthly schedule');
          }
          const dayOfMonth = parseDayOfMonth(fields.dayOfMonth);
          if (dayOfMonth === null) {
            errors.push('Invalid Day of Month');
          }
          if (fields.repeatUnit && !/month/i.test(fields.repeatUnit)) {
            errors.push('Repeat Unit must be Month(s) for Monthly schedule');
          }
          if (!fields.scheduleTime) {
            errors.push('Schedule Time is required for Monthly schedule');
          } else if (!isValidScheduleTime(fields.scheduleTime)) {
            errors.push(`Invalid schedule time: "${fields.scheduleTime}" (use HH:MM or HH:MM AM/PM)`);
          }
        }
      }

      // Determine status
      let status: CampaignImportRow['status'] = errors.length === 0 ? 'valid' : 'invalid';

      // Duplicate detection against existing campaigns and earlier rows in this file
      if (status === 'valid') {
        const nameKey = fields.campaignName.trim().toLowerCase();
        if (existingNames.has(nameKey) || seenNames.has(nameKey)) {
          status = 'duplicate';
        } else {
          seenNames.add(nameKey);
        }
      }

      return {
        ...fields,
        rowNumber,
        errors,
        status,
        resolvedTemplate,
        resolvedBody,
        selectedDays,
      };
    });
  };

  // Build a CampaignScheduleInput from an imported row, reusing the exact same
  // composer helper (buildScheduleInput) so scheduling behaves identically.
  // The importer never invents scheduling logic — it only maps Excel values
  // into the SAME recurring-schedule UI state the Campaign Composer produces.
  const buildImportScheduleInput = (row: CampaignImportRow): CampaignScheduleInput | null => {
    const scheduleType = mapScheduleType(row.scheduleType);
    if (!scheduleType) return null;

    const repeatEvery = parseRepeatEvery(row.repeatEvery) || 1;
    const dayOfMonth = parseDayOfMonth(row.dayOfMonth) || 1;
    const compTime = normalizeTimeToComposer(row.scheduleTime);

    const input = buildScheduleInput({
      scheduleType,
      compDate: row.scheduleDate,
      compTime,
      repeatEvery,
      selectedDays: row.selectedDays,
      monthlyOption: 'day',
      dayOfMonth,
      weekdayRule: 'First Monday',
    });

    // Timezone is part of the scheduler row (defaults to IST / Asia/Kolkata).
    input.timezone = normalizeImportTimezone(row.timezone);
    return input;
  };

  // ─── CAMPAIGN IMPORT: confirm & insert ─────────────────────────────────────
  const confirmCampaignImport = async () => {
    if (importSubmitting || importRows.length === 0) return;
    const validRows = importRows.filter((r) => r.status === 'valid');
    if (validRows.length === 0) {
      onToast('No valid campaigns to import', 'error');
      return;
    }

    setImportSubmitting(true);
    let imported = 0;
    let failed = 0;
    const failedReasons: string[] = [];

    for (const row of validRows) {
      const scheduleInput = buildImportScheduleInput(row);
      const input: any = {
        campaign_name: row.campaignName.trim(),
        subject_line: row.subjectLine.trim(),
        from_name: row.fromName.trim(),
        audience_segment: resolveAudience(row.audience).value,
        campaign_type: resolveCampaignType(row.campaignType).value,
        schedule_date: scheduleInput ? (scheduleInput.schedule_type === 'one_time' ? row.scheduleDate : null) : null,
        schedule_time: scheduleInput ? normalizeTimeToComposer(row.scheduleTime) : null,
        email_body: row.resolvedBody,
        html_content: row.resolvedBody,
        template_name: row.resolvedTemplate?.name || null,
        status: scheduleInput ? 'scheduled' : 'draft',
      };

      try {
        const { data, error } = await insertCampaign(input);
        if (error || !data) {
          failed++;
          failedReasons.push(`${row.campaignName}: ${error || 'Unknown error'}`);
          continue;
        }
        if (scheduleInput) {
          const sched = await insertCampaignSchedule(String(data.id), scheduleInput);
          if (sched.error) {
            // Roll the campaign back to a draft so the cron never fires a
            // schedule-less "scheduled" campaign, and count the row as failed.
            await updateCampaign(String(data.id), { ...input, status: 'draft' });
            failed++;
            failedReasons.push(`${row.campaignName}: ${sched.error}`);
            continue;
          }
        }
        imported++;
      } catch (err: any) {
        failed++;
        failedReasons.push(`${row.campaignName}: ${err?.message || 'Failed to create campaign'}`);
      }
    }

    setImportSubmitting(false);

    // The Composer's duplicate rule also skips rows already flagged as duplicates.
    const skipped = importRows.filter((r) => r.status === 'duplicate').length;

    setLoading(true);
    await refreshCampaigns();

    setIsImportModalOpen(false);
    setImportRows([]);
    setImportFileName('');

    if (imported === 0 && failed > 0) {
      onToast(`Campaign import failed: ${failedReasons[0]}`, 'error');
    } else {
      let msg = `${imported} campaign${imported === 1 ? '' : 's'} imported successfully`;
      if (skipped > 0) msg += ` (${skipped} skipped)`;
      onToast(msg, 'success');
      if (failed > 0) {
        onToast(`Imported: ${imported} · Skipped: ${skipped} · Failed: ${failed}`, 'error');
      }
    }
  };

  // ─── CAMPAIGN IMPORT: download template ─────────────────────────────────────
  const downloadCampaignTemplate = () => {
    const XLSX = (window as any).XLSX;
    if (!XLSX) {
      onToast('Excel library not available', 'error');
      return;
    }
    const headers = CAMPAIGN_IMPORT_EXPECTED_HEADERS;
    const sampleRows = [
      [
        'Partnership Outreach',
        'Partnership Opportunity: Design Intelligence for {{company}}',
        'Rupali Sirsath — IUOVA Design Consultancy',
        'All Contacts',
        'Custom',
        'IUOVA Attractive',
        'One Time',
        '2026-08-25',
        '10:00',
      ],
      [
        'Newsletter — {{month}} Edition',
        'Fresh Design Intelligence for {{company}}',
        'Rupali Sirsath — IUOVA Design Consultancy',
        'New Leads',
        'Newsletter',
        'IUOVA Attractive',
        'One Time',
        '2026-09-01',
        '09:30 AM',
      ],
      [
        'Cold Outreach — Q3 OEMs',
        'Quick idea for {{company}}',
        'Rupali Sirsath — IUOVA Design Consultancy',
        'OEM Contacts',
        'Cold Outreach',
        'IUOVA Attractive',
        'One Time',
        '2026-09-10',
        '11:00 AM',
      ],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Campaigns');
    XLSX.writeFile(wb, 'campaign-import-template.xlsx');
  };

  return (
    <div className="page active">
      {/* Tab bar header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '18px' }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 700 }}>Campaigns</div>
          <div style={{ fontSize: '12px', color: 'var(--text4)', marginTop: '2px' }}>
            Build and monitor your outreach campaigns
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {campTabState !== 'list' && (
            <button className="btn btn-ghost btn-sm" onClick={() => setCampTabState('list')}>Back to campaigns</button>
          )}
          {campTabState !== 'compose' && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setIsImportModalOpen(true)}
            >
              <UploadIcon size={14} /> Import File
            </button>
          )}
          {campTabState !== 'compose' && (
            <button className="btn btn-primary btn-sm" onClick={openComposer}>Compose Campaign</button>
          )}
        </div>
      </div>

      {/* Mini tabs */}
      <div className="tabs">
        <div className={`tab ${campTabState === 'list' ? 'active' : ''}`} onClick={() => setCampTabState('list')}>Active Campaigns</div>
        <div className={`tab ${campTabState === 'compose' ? 'active' : ''}`} onClick={openComposer}>Composer & Editor</div>
        <div className={`tab ${campTabState === 'templates' ? 'active' : ''}`} onClick={() => setCampTabState('templates')}>Template Library</div>
        <div className={`tab ${campTabState === 'followups' ? 'active' : ''}`} onClick={() => setCampTabState('followups')}>Pending Follow-ups</div>
      </div>

      {/* ─── RENDER: LIST ─── */}
      {campTabState === 'list' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: '24%' }}>Campaign Name</th>
                <th>Type</th>
                <th>Audience</th>
                <th>Sent</th>
                <th style={{ width: '22%' }}>Schedule</th>
                <th>Delivered</th>
                <th>Open Rate</th>
                <th>Click Rate</th>
                <th>Status</th>
                <th style={{ width: '90px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">
                      <div className="empty-icon">⟳</div>
                      <div className="empty-title">Loading campaigns…</div>
                    </div>
                  </td>
                </tr>
              ) : campaigns.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">
                      <div className="empty-icon">✉</div>
                      <div className="empty-title">No campaigns yet</div>
                      <div className="empty-sub">
                        {fetchError ? fetchError : 'Create your first campaign or choose an email template to begin.'}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                campaigns.map(c => {
                  const isSent = c.status.toLowerCase() === 'sent';

                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{c.name}</div>
                      </td>
                      <td>
                        <CampaignTypeChip type={c.campaignType} />
                      </td>
                      <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{c.audience}</td>
                      <td style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text2)' }}>{c.sentCount}</td>
                      <td>
                        <Tooltip title={c.scheduleText} placement="top" arrow>
                          <span style={{
                            display: 'block',
                            fontSize: '11px',
                            color: 'var(--text4)',
                            fontFamily: 'var(--mono)',
                            maxWidth: '260px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            ...(c.scheduleText && c.scheduleText.trim() !== '' && c.scheduleText !== '--'
                              ? { fontWeight: 700, color: 'var(--text2)' }
                              : {}),
                          }}>
                            {c.scheduleText}
                          </span>
                        </Tooltip>
                      </td>
                      <td style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text2)' }}>
                        {isSent ? c.deliveredCount : '—'}
                      </td>
                      <td>
                        {c.deliveredCount > 0 ? (
                          <RateCell rate={c.openRate} count={c.openedCount} delivered={c.deliveredCount} label="opened" />
                        ) : '—'}
                      </td>
                      <td>
                        {c.deliveredCount > 0 ? (
                          <RateCell rate={c.clickRate} count={c.clickedCount} delivered={c.deliveredCount} label="clicked" />
                        ) : '—'}
                      </td>
                      <td>
                        <span className={`tag ${
                          c.status.toLowerCase() === 'sent' ? 'tag-client' :
                          c.status.toLowerCase() === 'scheduled' ? 'tag-oem' : 'tag-draft'
                        }`}>{c.batchEnabled && c.status.toLowerCase() !== 'sent' ? 'Sending in batches' : c.status}</span>
                        {c.batchEnabled && (
                          <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--text3)', lineHeight: 1.5 }}>
                            <div>
                              <strong style={{ color: 'var(--text2)' }}>{c.sentCount}</strong>
                              {' / '}
                              {c.recipientCount || '?'} sent
                            </div>
                            <div>
                              Batch: <strong style={{ color: 'var(--text2)' }}>
                                {c.currentBatchNumber || 0}
                              </strong>
                              {' / '}
                              {c.totalBatches || '?'}
                            </div>
                            {c.status.toLowerCase() === 'scheduled' && c.nextBatchAt && (
                              <div>Next: {formatTime(c.nextBatchAt)}</div>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '3px' }}>
                          <button className="btn-icon" title="Edit campaign" onClick={() => openEditCampaign(c)}>✎</button>
                          <button className="btn-icon" title="Delete" onClick={() => handleDeleteCampaign(c.id)} style={{ color: 'var(--red)' }}>✕</button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── RENDER: COMPOSE ─── */}
      {campTabState === 'compose' && (
        <div className="composer-layout" style={{ fontFamily: '"Inter", sans-serif' }}>
          {/* LEFT COLUMN */}
          <div className="composer-left">
            {/* CARD 1: CAMPAIGN DETAILS */}
            <div className="card" style={{ padding: '24px', background: '#FFFFFF', borderRadius: '16px', border: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)' }}>
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '16px', fontWeight: 700, textTransform: 'uppercase' }}>Campaign Details</div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Campaign Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Polycab Retainer Pitch — June 2026"
                    value={compName}
                    onChange={(e) => setCompName(e.target.value)}
                    style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Subject Line *</label>
                  <input
                    type="text"
                    placeholder="Partnership Opportunity: Design Intelligence for {{company}}"
                    value={compSubject}
                    onChange={(e) => setCompSubject(e.target.value)}
                    style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>From Name</label>
                  <input
                    type="text"
                    value={compFromName}
                    onChange={(e) => setCompFromName(e.target.value)}
                    style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Audience Segment</label>
                  {dropdownsLoading ? (
                    <select
                      disabled
                      value=""
                      style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: '#F8FAFC', cursor: 'wait' }}
                    >
                      <option>Loading...</option>
                    </select>
                  ) : dropdownsError ? (
                    <select
                      disabled
                      value=""
                      style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: '#FEF2F2', color: '#B91C1C', cursor: 'not-allowed' }}
                    >
                      <option>{dropdownsError.includes('audience') ? 'Failed to load audience segments.' : dropdownsError}</option>
                    </select>
                  ) : (
                    <select
                      value={compAudience}
                      onChange={(e) => setCompAudience(e.target.value)}
                      style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: '#FFFFFF', cursor: 'pointer' }}
                    >
                      <option value="All Contacts">All Contacts ({getSegmentCount('All Contacts')})</option>
                      {audienceSegments.map((s) => (
                        <option key={s.id} value={s.name}>{s.name} ({getSegmentCount(s.name)})</option>
                      ))}
                      {(compAudience && compAudience !== 'All Contacts' &&
                        !audienceSegments.some((s) => s.name === compAudience)) && (
                        <option value={compAudience}>
                          {isManualAudience(compAudience)
                            ? `Selected Contacts (${getSegmentCount(compAudience)})`
                            : `${compAudience} (${getSegmentCount(compAudience)})`}
                        </option>
                      )}
                    </select>
                  )}
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Campaign Type</label>
                  {dropdownsLoading ? (
                    <select
                      disabled
                      value=""
                      style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: '#F8FAFC', cursor: 'wait' }}
                    >
                      <option>Loading...</option>
                    </select>
                  ) : dropdownsError ? (
                    <select
                      disabled
                      value=""
                      style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: '#FEF2F2', color: '#B91C1C', cursor: 'not-allowed' }}
                    >
                      <option>{dropdownsError.includes('campaign types') ? 'Failed to load campaign types.' : dropdownsError}</option>
                    </select>
                  ) : (
                    <select
                      value={compType}
                      onChange={(e) => handleTypeChange(e.target.value)}
                      style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: '#FFFFFF', cursor: 'pointer' }}
                    >
                      {(!campaignTypes.some((t) => t.name === compType) && compType) && (
                        <option value={compType}>{compType}</option>
                      )}
                      {campaignTypes.map((t) => (
                        <option key={t.id} value={t.name}>{t.name}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* ─── SCHEDULE SETTINGS ─── */}
                <div style={{ height: '1px', background: '#E5E7EB', margin: '4px 0 8px' }} />
                <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '12px', fontWeight: 700, textTransform: 'uppercase' }}>Schedule Settings</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Schedule Type</div>
                  <div style={{ display: 'flex', gap: '24px' }}>
                    {([
                      { key: 'one_time', label: 'One Time' },
                      { key: 'weekly', label: 'Weekly' },
                      { key: 'monthly', label: 'Monthly' },
                    ] as { key: 'one_time' | 'weekly' | 'monthly'; label: string }[]).map(({ key, label }) => (
                      <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                        <input
                          type="radio"
                          name="scheduleType"
                          checked={scheduleType === key}
                          onChange={() => setScheduleType(key)}
                          style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                {scheduleType === 'one_time' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: '12px' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Schedule Date</label>
                      <input
                        type="date"
                        value={compDate}
                        onChange={(e) => setCompDate(e.target.value)}
                        style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Time (IST)</label>
                      <input
                        type="text"
                        value={compTime}
                        onChange={(e) => setCompTime(e.target.value)}
                        style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                      />
                    </div>
                  </div>
                )}

                {scheduleType === 'weekly' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#334155' }}>Repeat Every</span>
                      <input
                        type="number"
                        min={1}
                        value={repeatEvery}
                        onChange={(e) => setRepeatEvery(Math.max(1, Number(e.target.value) || 1))}
                        style={{ width: '64px', height: '40px', padding: '0 8px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: '13px', color: '#64748B' }}>Week(s)</span>
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Send On</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '8px' }}>
                        {WEEKDAY_NAMES.map((day) => {
                          const isChecked = selectedDays.includes(day);
                          return (
                            <label key={day} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => setSelectedDays((prev) => (isChecked ? prev.filter((d) => d !== day) : [...prev, day]))}
                                style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                              />
                              {day}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Time (IST)</label>
                      <input
                        type="text"
                        value={compTime}
                        onChange={(e) => setCompTime(e.target.value)}
                        style={{ width: '160px', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                      />
                    </div>
                  </div>
                )}

                {scheduleType === 'monthly' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#334155' }}>Repeat Every</span>
                      <input
                        type="number"
                        min={1}
                        value={repeatEvery}
                        onChange={(e) => setRepeatEvery(Math.max(1, Number(e.target.value) || 1))}
                        style={{ width: '64px', height: '40px', padding: '0 8px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: '13px', color: '#64748B' }}>Month(s)</span>
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Monthly Schedule</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                          <input
                            type="radio"
                            name="monthlyOption"
                            checked={monthlyOption === 'day'}
                            onChange={() => setMonthlyOption('day')}
                            style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                          />
                          Day of Month
                          <input
                            type="number"
                            min={1}
                            max={31}
                            value={dayOfMonth}
                            disabled={monthlyOption !== 'day'}
                            onChange={(e) => setDayOfMonth(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
                            style={{ width: '64px', height: '40px', padding: '0 8px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center', background: monthlyOption === 'day' ? '#FFFFFF' : '#F8FAFC', opacity: monthlyOption === 'day' ? 1 : 0.5 }}
                          />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                          <input
                            type="radio"
                            name="monthlyOption"
                            checked={monthlyOption === 'weekday'}
                            onChange={() => setMonthlyOption('weekday')}
                            style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                          />
                          Weekday
                          <select
                            value={weekdayRule}
                            disabled={monthlyOption !== 'weekday'}
                            onChange={(e) => setWeekdayRule(e.target.value)}
                            style={{ height: '40px', padding: '0 10px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: monthlyOption === 'weekday' ? '#FFFFFF' : '#F8FAFC', cursor: 'pointer', opacity: monthlyOption === 'weekday' ? 1 : 0.5, minWidth: '150px' }}
                          >
                            {MONTHLY_RULES.map((rule) => (
                              <option key={rule} value={rule}>{rule}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Time (IST)</label>
                      <input
                        type="text"
                        value={compTime}
                        onChange={(e) => setCompTime(e.target.value)}
                        style={{ width: '160px', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* ─── SENDING LIMITS (BATCH / THROTTLED SENDING) ─── */}
              <div style={{ height: '1px', background: '#E5E7EB', margin: '4px 0 8px' }} />
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '12px', fontWeight: 700, textTransform: 'uppercase' }}>Sending Limits</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', color: '#334155', cursor: 'pointer', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={batchEnabled}
                    onChange={(e) => setBatchEnabled(e.target.checked)}
                    style={{ accentColor: '#2563EB', width: '18px', height: '18px', cursor: 'pointer', margin: 0 }}
                  />
                  Send in batches
                </label>

                {batchEnabled && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingLeft: '8px', borderLeft: '3px solid #EFF6FF' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Batch Size</label>
                        <select
                          value={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 100, 150, 200].includes(Number(batchSize)) ? String(batchSize) : 'custom'}
                          onChange={(e) => {
                            if (e.target.value === 'custom') {
                              setBatchSize(Math.max(1, Number(batchSize) || 30));
                            } else {
                              setBatchSize(Number(e.target.value));
                            }
                          }}
                          style={{ width: '100%', height: '48px', padding: '0 12px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', cursor: 'pointer' }}
                        >
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 100, 150, 200].map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                          <option value="custom">Custom ({batchSize})</option>
                        </select>
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 100, 150, 200].every((n) => n !== Number(batchSize)) && (
                          <input
                            type="number"
                            min={1}
                            value={batchSize}
                            onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 1))}
                            style={{ width: '100%', height: '44px', marginTop: '8px', padding: '0 12px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                          />
                        )}
                      </div>

                      <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Send next batch after</label>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <input
                            type="number"
                            min={1}
                            value={batchIntervalValue}
                            onChange={(e) => setBatchIntervalValue(Math.max(1, Number(e.target.value) || 1))}
                            style={{ width: '72px', height: '48px', padding: '0 10px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center' }}
                          />
                          <select
                            value={batchIntervalUnit}
                            onChange={(e) => setBatchIntervalUnit(e.target.value as 'minutes' | 'hours')}
                            style={{ flex: 1, height: '48px', padding: '0 10px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', cursor: 'pointer' }}
                          >
                            <option value="minutes">Minute(s)</option>
                            <option value="hours">Hour(s)</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {(() => {
                      const audienceCount = getSegmentCount(compAudience);
                      const resolvedBatchSize = Math.max(1, Number(batchSize) || 30);
                      const intervalMinutes =
                        batchIntervalUnit === 'hours'
                          ? Math.max(1, batchIntervalValue) * 60
                          : Math.max(1, batchIntervalValue);
                      const estimatedBatches = audienceCount > 0 ? Math.ceil(audienceCount / resolvedBatchSize) : 0;
                      const totalIntervalHours =
                        estimatedBatches > 1 ? ((estimatedBatches - 1) * intervalMinutes) / 60 : 0;
                      return (
                        <div style={{ fontSize: '13px', color: '#475569', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '10px', padding: '12px 14px', lineHeight: 1.6 }}>
                          <div>
                            <strong style={{ color: '#334155' }}>{resolvedBatchSize}</strong> contacts will be sent every{' '}
                            <strong style={{ color: '#334155' }}>
                              {batchIntervalValue} {batchIntervalUnit === 'hours' ? (batchIntervalValue === 1 ? 'hour' : 'hours') : batchIntervalValue === 1 ? 'minute' : 'minutes'}
                            </strong>
                            .
                          </div>
                          {audienceCount > 0 ? (
                            <>
                              <div style={{ marginTop: '6px' }}>
                                Audience: <strong style={{ color: '#334155' }}>{compAudience}</strong> ({audienceCount})
                              </div>
                              <div style={{ marginTop: '2px' }}>
                                Estimated batches: <strong style={{ color: '#334155' }}>{estimatedBatches}</strong>
                              </div>
                              <div style={{ marginTop: '2px' }}>
                                Estimated completion: approximately{' '}
                                <strong style={{ color: '#334155' }}>
                                  {totalIntervalHours < 1
                                    ? `${Math.round(totalIntervalHours * 60)} minutes`
                                    : `${totalIntervalHours % 1 === 0 ? totalIntervalHours : totalIntervalHours.toFixed(1)} hour(s)`}
                                </strong>{' '}
                                after the first batch
                              </div>
                            </>
                          ) : (
                            <div style={{ marginTop: '6px', color: '#94A3B8' }}>
                              Select an audience to estimate batches.
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* ─── ATTACHMENTS ─── */}
              <div style={{ height: '1px', background: '#E5E7EB', margin: '4px 0 8px' }} />
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '12px', fontWeight: 700, textTransform: 'uppercase' }}>Attachments</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  hidden
                  accept=".pdf,image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv,application/zip"
                  onChange={(e) => void handleAddAttachments(e.target.files)}
                />
                <button
                  type="button"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={uploadingAttachment}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    width: '100%',
                    height: '48px',
                    background: uploadingAttachment ? '#F1F5F9' : '#FFFFFF',
                    color: uploadingAttachment ? '#94A3B8' : '#1D4ED8',
                    border: uploadingAttachment ? '1px solid #E2E8F0' : '1px dashed #93C5FD',
                    borderRadius: '10px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: uploadingAttachment ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseOver={(e) => { if (!uploadingAttachment) e.currentTarget.style.background = '#EFF6FF'; }}
                  onMouseOut={(e) => { if (!uploadingAttachment) e.currentTarget.style.background = '#FFFFFF'; }}
                >
                  {uploadingAttachment ? 'Uploading…' : '+ Add Attachment / Upload File'}
                </button>
                <div style={{ fontSize: '11px', color: '#8A94A6' }}>
                  Supported: PDF, images (JPG, PNG, WEBP, GIF), videos (MP4, MOV, WEBM) and other common email attachments (max 20 MB each).
                </div>

                {attachmentError && (
                  <div style={{ fontSize: '12px', color: '#DC2626' }}>{attachmentError}</div>
                )}

                {attachments.length === 0 ? (
                  <div style={{ fontSize: '12px', color: '#8A94A6', padding: '10px 0' }}>
                    No attachments yet. Upload files to include them when the campaign email is sent.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {attachments.map((att) => (
                      <div
                        key={att.storage_path}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '10px 12px',
                          border: '1px solid #E5E7EB',
                          borderRadius: '10px',
                          background: '#F8FAFC',
                        }}
                      >
                        <span style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          color: '#1D4ED8',
                          background: '#EFF6FF',
                          border: '1px solid #BFDBFE',
                          borderRadius: '6px',
                          padding: '3px 6px',
                          textTransform: 'uppercase',
                          flexShrink: 0,
                        }}>
                          {(att.file_type.split('/').pop() || 'file').slice(0, 10)}
                        </span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.file_name}</span>
                          <span style={{ fontSize: '11.5px', color: '#8A94A6' }}>
                            {att.file_type || 'Unknown type'} • {formatFileSize(att.file_size)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRemoveAttachment(att)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#DC2626',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            padding: '6px 8px',
                            borderRadius: '6px',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}
                          onMouseOver={(e) => { e.currentTarget.style.background = '#FEE2E2'; }}
                          onMouseOut={(e) => { e.currentTarget.style.background = 'none'; }}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              </div>
            </div>

            {/* CARD 2: MERGE TAGS */}
            <div className="card" style={{ padding: '24px', background: '#FFFFFF', borderRadius: '16px', border: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)' }}>
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '12px', fontWeight: 700, textTransform: 'uppercase' }}>Merge Tags - Click to Insert</div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {['{{first_name}}', '{{company}}', '{{designation}}', '{{city}}', '{{month}}'].map(tag => (
                  <button
                    key={tag}
                    onClick={() => insertMergeTag(tag)}
                    style={{
                      background: '#EFF6FF',
                      border: '1px solid #BFDBFE',
                      color: '#1D4ED8',
                      padding: '6px 14px',
                      borderRadius: '999px',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      cursor: 'pointer',
                      fontWeight: 500,
                      transition: 'all 0.15s ease'
                    }}
                    onMouseOver={(e) => { e.currentTarget.style.background = '#DBEAFE'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = '#EFF6FF'; }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            {/* CARD 3: ACTIONS ROW */}
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => setIsImportModalOpen(true)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: '#FFFFFF',
                  color: '#1D4ED8',
                  border: '1px solid #BFDBFE',
                  borderRadius: '10px',
                  padding: '0 20px',
                  height: '44px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer',
                  transition: 'background 0.15s'
                }}
                onMouseOver={(e) => { e.currentTarget.style.background = '#EFF6FF'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = '#FFFFFF'; }}
              >
                <UploadIcon size={15} /> Import File
              </button>
              <button
                onClick={() => handleSaveCampaign('sent')}
                disabled={saving}
                style={{
                  background: '#10B981',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '0 24px',
                  height: '44px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  transition: 'background 0.15s'
                }}
                onMouseOver={(e) => { if (!saving) e.currentTarget.style.background = '#059669'; }}
                onMouseOut={(e) => { if (!saving) e.currentTarget.style.background = '#10B981'; }}
              >
                {saving ? 'Sending…' : 'Send Now'}
              </button>
              <button
                onClick={() => handleSaveCampaign('scheduled')}
                disabled={saving}
                style={{
                  background: '#2563EB',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '0 24px',
                  height: '44px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  transition: 'background 0.15s'
                }}
                onMouseOver={(e) => { if (!saving) e.currentTarget.style.background = '#1D4ED8'; }}
                onMouseOut={(e) => { if (!saving) e.currentTarget.style.background = '#2563EB'; }}
              >
                {saving ? 'Scheduling…' : 'Schedule Campaign'}
              </button>
              <button
                onClick={() => handleSaveCampaign('draft')}
                disabled={saving}
                style={{
                  background: '#FFFFFF',
                  color: '#4A5568',
                  border: '1px solid #E2E8F0',
                  borderRadius: '10px',
                  padding: '0 24px',
                  height: '44px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  transition: 'background 0.15s'
                }}
                onMouseOver={(e) => { if (!saving) e.currentTarget.style.background = '#F8FAFC'; }}
                onMouseOut={(e) => { if (!saving) e.currentTarget.style.background = '#FFFFFF'; }}
              >
                {saving ? 'Saving…' : 'Save Draft'}
              </button>
              <button
                onClick={openPreview}
                style={{
                  background: '#FFFFFF',
                  color: '#4A5568',
                  border: '1px solid #E2E8F0',
                  borderRadius: '10px',
                  padding: '0 24px',
                  height: '44px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer',
                  transition: 'background 0.15s'
                }}
                onMouseOver={(e) => { e.currentTarget.style.background = '#F8FAFC'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = '#FFFFFF'; }}
              >
                Preview
              </button>
            </div>
          </div>

          {/* RIGHT COLUMN */}
          <div className="composer-right">
            {/* CARD 4: LOAD TEMPLATE */}
            <div className="card" style={{ padding: '24px', background: '#FFFFFF', borderRadius: '16px', border: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)' }}>
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '14px', fontWeight: 700, textTransform: 'uppercase' }}>Load Template</div>

              {/* Upload an HTML email template (.html / .htm) */}
              <input
                ref={templateFileInputRef}
                type="file"
                hidden
                accept=".html,.htm,text/html"
                onChange={(e) => void handleUploadTemplate(e.target.files)}
              />
              <button
                type="button"
                onClick={() => templateFileInputRef.current?.click()}
                disabled={templateUploading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  width: '100%',
                  height: '48px',
                  background: templateUploading ? '#F1F5F9' : '#FFFFFF',
                  color: templateUploading ? '#94A3B8' : '#1D4ED8',
                  border: templateUploading ? '1px solid #E2E8F0' : '1px dashed #93C5FD',
                  borderRadius: '10px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: templateUploading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseOver={(e) => { if (!templateUploading) e.currentTarget.style.background = '#EFF6FF'; }}
                onMouseOut={(e) => { if (!templateUploading) e.currentTarget.style.background = '#FFFFFF'; }}
              >
                {templateUploading ? 'Uploading…' : '+ Upload Template'}
              </button>
              <div style={{ fontSize: '11px', color: '#8A94A6', marginTop: '6px' }}>
                Supported: .html / .htm email template files.
              </div>

              {templateUploadSuccess && (
                <div style={{ fontSize: '12px', color: '#059669', marginTop: '8px' }}>{templateUploadSuccess}</div>
              )}
              {templateUploadError && (
                <div style={{ fontSize: '12px', color: '#DC2626', marginTop: '8px' }}>{templateUploadError}</div>
              )}

              {templatesLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
                  <CircularProgress size={26} />
                </div>
              ) : templatesError ? (
                <div style={{ fontSize: '12px', color: 'var(--red)', padding: '8px 0' }}>
                  {templatesError}
                </div>
              ) : templates.length === 0 ? (
                <div style={{ fontSize: '12px', color: 'var(--text4)', padding: '8px 0' }}>
                  No templates available
                </div>
              ) : (
                <>
                  {templateDeleteError && (
                    <div style={{ fontSize: '12px', color: 'var(--red)', padding: '0 0 10px 0', lineHeight: 1.4 }}>
                      Could not delete template: {templateDeleteError}
                    </div>
                  )}
                  {templateLoadError && (
                    <div style={{ fontSize: '12px', color: 'var(--red)', padding: '0 0 10px 0', lineHeight: 1.4 }}>
                      {templateLoadError}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {templates.map((tmpl) => {
                    const isActive = selectedTemplate?.id === tmpl.id;
                    const isLoading = templateLoadingId === tmpl.id;
                    return (
                      <div
                        key={tmpl.id}
                        onClick={() => void handleSelectTemplate(tmpl)}
                        style={{
                          padding: '12px 14px',
                          borderRadius: '12px',
                          border: isActive ? '2px solid #2563EB' : '1px solid #E5E7EB',
                          background: isActive ? '#EFF6FF' : '#FFFFFF',
                          cursor: isLoading ? 'wait' : 'pointer',
                          transition: 'all 0.15s ease',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'center',
                          boxSizing: 'border-box',
                          pointerEvents: isLoading ? 'none' : 'auto',
                          opacity: isLoading ? 0.6 : 1
                        }}
                        onMouseOver={(e) => {
                          if (!isActive && !isLoading) e.currentTarget.style.borderColor = '#CBD5E1';
                        }}
                        onMouseOut={(e) => {
                          if (!isActive && !isLoading) e.currentTarget.style.borderColor = '#E5E7EB';
                        }}
                      >
                        {isLoading ? (
                          <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
                            <CircularProgress size={22} />
                          </div>
                        ) : (
                          <>
                            <div style={{ fontSize: '13px', fontWeight: 700, color: isActive ? '#1E40AF' : '#1E293B', marginBottom: '4px' }}>{tmpl.name}</div>
                            <div style={{ fontSize: '11px', color: isActive ? '#3B82F6' : '#64748B' }}>{tmpl.description}</div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '10px' }}>
                              <button
                                type="button"
                                className="btn btn-danger btn-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestDeleteTemplate(tmpl);
                                }}
                                title="Delete this template"
                                style={{ lineHeight: 1, padding: '5px 10px' }}
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                className="btn btn-primary btn-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleSelectTemplate(tmpl);
                                }}
                                title="Load this template"
                                style={{ lineHeight: 1, padding: '5px 14px' }}
                              >
                                Load
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                </>
              )}
            </div>

          {/* CARD 5: EMAIL BODY */}
          <div className="card" style={{ padding: '24px', background: '#FFFFFF', borderRadius: '16px', border: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)', display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
                <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', fontWeight: 700, textTransform: 'uppercase' }}>Email Body</div>
              </div>
              
              {/* Editor mode toggle: Plain Text (editable) / HTML (editable source) / Preview (rendered email) */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => setEditorMode('text')}
                  style={editorTabStyle(editorMode === 'text')}
                >
                  Plain Text
                </button>
                <button
                  type="button"
                  onClick={() => setEditorMode('html')}
                  style={editorTabStyle(editorMode === 'html')}
                >
                  HTML
                </button>
                <button
                  type="button"
                  onClick={() => setEditorMode('preview')}
                  style={editorTabStyle(editorMode === 'preview')}
                >
                  Preview
                </button>
              </div>

              {editorMode === 'text' ? (
                <>
                  {/* Plain-text editor hint */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '8px 12px',
                    border: '1px solid #E2E8F0',
                    borderBottom: 'none',
                    borderRadius: '6px 6px 0 0',
                    background: '#F8FAFC',
                    flexShrink: 0
                  }}>
                    <span style={{ fontSize: '12px', color: '#475569' }}>Plain text — placeholders like <span style={{ fontFamily: 'monospace', color: '#1D4ED8' }}>{'{{first_name}}'}</span> are replaced automatically when sending.</span>
                  </div>

                  {/* Editable Text Area */}
                  <textarea
                    ref={bodyRef}
                    value={compBody}
                    onChange={(e) => setCompBody(e.target.value)}
                    placeholder="Start drafting your outreach template here..."
                    spellCheck={false}
                    style={BODY_TEXTAREA_STYLE}
                  ></textarea>
                </>
              ) : editorMode === 'html' ? (
                <textarea
                  ref={bodyRef}
                  value={compBody}
                  onChange={(e) => setCompBody(e.target.value)}
                  placeholder="Edit HTML template..."
                  spellCheck={false}
                  style={BODY_TEXTAREA_STYLE}
                />
              ) : (
                <div style={BODY_PREVIEW_STYLE}>
                  {compBody.trim() ? (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: bodyIsHtml ? compBody : plainTextToHtml(compBody),
                      }}
                    />
                  ) : (
                    <div style={{ color: '#94A3B8', fontSize: '13.5px' }}>
                      Load a template to preview its rendered email design.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── RENDER: TEMPLATES ─── */}
      {campTabState === 'templates' && (
        <div>
          {/* Categories select header */}
          <div className="toolbar" style={{ marginBottom: '14px' }}>
            <div className="toolbar-left">
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text3)' }}>Filter by Type:</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {TEMPLATE_CATEGORIES.map(cat => (
                  <button
                    key={cat}
                    className={`btn btn-sm ${selectedTemplateCategory === cat ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setSelectedTemplateCategory(cat)}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {templatesLoading ? (
            <div className="empty-state">
              <div className="empty-icon">⟳</div>
              <div className="empty-title">Loading templates…</div>
            </div>
          ) : filteredTemplates.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">✉</div>
              <div className="empty-title">No templates found</div>
              <div className="empty-sub">Try a different category or add templates to your email_templates table.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px' }}>
              {filteredTemplates.map(t => (
                <div key={t.id} className="card flex flex-col justify-between" style={{ padding: '14px' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <span className="tag tag-prospect" style={{ fontSize: '10px' }}>{t.category}</span>
                      <span style={{ fontSize: '11px', color: 'var(--text4)' }}>{t.description}</span>
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>{t.name}</div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text4)', fontStyle: 'italic', marginBottom: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Sub: {t.subject}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text3)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.4, background: 'var(--surface2)', padding: '8px', borderRadius: '4px', fontStyle: 'italic' }}>
                      {t.body.replace(/<[^>]*>/g, '').substring(0, 140)}...
                    </div>
                  </div>
                  <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid var(--border)', textAlign: 'right' }}>
                    <button className="btn btn-secondary btn-xs" onClick={() => loadTemplate(t.id)}>Use Template →</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── RENDER: PENDING FOLLOW-UPS ─── */}
      {campTabState === 'followups' && (
        <div>
          <div className="toolbar" style={{ marginBottom: '14px' }}>
            <div className="toolbar-left">
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text3)' }}>
                Follow-ups queued when a recipient opens a campaign with Manual mode. Review and send them here.
              </span>
            </div>
            <div className="toolbar-right">
              <button className="btn btn-secondary btn-sm" onClick={() => void loadPendingFollowups()}>⟳ Refresh</button>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Email</th>
                  <th>Original Campaign</th>
                  <th>Follow-up Campaign</th>
                  <th>Opened At</th>
                  <th>Status</th>
                  <th style={{ width: '150px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingFollowupsLoading ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">⟳</div>
                        <div className="empty-title">Loading follow-ups…</div>
                      </div>
                    </td>
                  </tr>
                ) : pendingFollowupsError ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">⚠</div>
                        <div className="empty-title">Could not load follow-ups</div>
                        <div className="empty-sub">{pendingFollowupsError}</div>
                      </div>
                    </td>
                  </tr>
                ) : pendingFollowups.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">⏳</div>
                        <div className="empty-title">No pending follow-ups</div>
                        <div className="empty-sub">
                          Follow-ups appear here when a recipient opens a campaign that has Manual follow-up enabled.
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  pendingFollowups.map((p) => {
                    const canSend = p.status === 'pending' || p.status === 'failed';
                    return (
                      <tr key={p.id}>
                        <td>
                          <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{p.recipient_name || '—'}</div>
                        </td>
                        <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{p.email}</td>
                        <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{p.campaign_name || '—'}</td>
                        <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{p.followup_campaign_name || '—'}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)', fontFamily: 'var(--mono)' }}>{formatDateTime(p.opened_at)}</td>
                        <td>
                          <span className={`tag ${
                            p.status === 'sent' ? 'tag-client' :
                            p.status === 'failed' ? 'tag-oem' : 'tag-draft'
                          }`}>{p.status}</span>
                        </td>
                        <td>
                          {canSend ? (
                            <button
                              className="btn btn-secondary btn-xs"
                              disabled={sendingFollowupId === p.id}
                              onClick={() => void handleSendFollowup(p.id)}
                            >
                              {sendingFollowupId === p.id ? 'Sending…' : 'Send Follow-up'}
                            </button>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── DELETE TEMPLATE CONFIRMATION MODAL ─── */}
      {templateToDelete && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '440px' }}>
            <div className="modal-header">
              <div className="modal-title">Delete Template?</div>
              <button className="btn-icon" onClick={cancelDeleteTemplate} disabled={templateDeleting}>✕</button>
            </div>
            <div className="modal-body" style={{ fontSize: '13px', color: '#475569' }}>
              <div style={{ fontWeight: 600, color: '#1E293B', marginBottom: '6px' }}>
                Are you sure you want to delete "{templateToDelete.name}"?
              </div>
              <div>This template will be permanently removed.</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={cancelDeleteTemplate} disabled={templateDeleting}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                style={{ borderColor: 'var(--red)' }}
                onClick={() => void confirmDeleteTemplate()}
                disabled={templateDeleting}
              >
                {templateDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── TEMPLATE IN USE WARNING MODAL ─── */}
      {templateInUse && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '440px' }}>
            <div className="modal-header">
              <div className="modal-title">Template In Use</div>
              <button className="btn-icon" onClick={() => setTemplateInUse(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ fontSize: '13px', color: '#475569' }}>
              <div>This template is currently used by a campaign.</div>
              <div>You cannot delete it until it is no longer being used.</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setTemplateInUse(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── PREVIEW MODAL: GEORGIA LETTER LAYOUT ─── */}
      {previewOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '640px' }}>
            <div className="modal-header">
              <div className="modal-title">Desktop Campaign Preview</div>
              <button className="btn-icon" onClick={() => setPreviewOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ background: 'var(--surface2)', padding: '20px' }}>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r)', overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                {/* Header bar */}
                <div style={{ background: 'var(--surface2)', padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: '8px', flexDirection: 'column' }}>
                  <div style={{ fontSize: '12px', display: 'flex' }}><span style={{ width: '50px', color: 'var(--text4)' }}>To:</span><span style={{ color: 'var(--text2)', fontWeight: 600 }}>Rajiv Mehta &lt;arvind.mehta@bajajelectricals.com&gt;</span></div>
                  <div style={{ fontSize: '12px', display: 'flex' }}><span style={{ width: '50px', color: 'var(--text4)' }}>From:</span><span style={{ color: 'var(--text2)' }}>Rupali Sirsath &lt;rupali.s@iuova.com&gt;</span></div>
                  <div style={{ fontSize: '12px', display: 'flex' }}><span style={{ width: '50px', color: 'var(--text4)' }}>Subject:</span><span style={{ color: 'var(--text1)', fontWeight: 700 }}>{compSubject.replace(/{{company}}/g, 'Bajaj Electricals').replace(/{{first_name}}/g, 'Rajiv') || '(No Subject)'}</span></div>
                </div>
                {/* Email content */}
                <div
                  style={{
                    padding: '24px 32px',
                    fontSize: '15px',
                    fontFamily: '"Georgia", serif',
                    lineHeight: '1.6',
                    color: '#1E293B',
                    minHeight: '260px',
                    background: '#FFFFFF'
                  }}
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                ></div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setPreviewOpen(false)}>Close Preview</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: IMPORT CAMPAIGNS FROM FILE ─── */}
      {isImportModalOpen && (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <div className="modal-header">
              <div>
                <div className="modal-title">Import Campaigns from File</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Upload an Excel or CSV file to bulk create campaigns
                </div>
              </div>
              <button className="modal-close" onClick={() => setIsImportModalOpen(false)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div
                className={`dropzone ${importDragging ? 'dragging' : ''}`}
                onClick={() => importFileInputRef.current?.click()}
                onDragOver={(e: React.DragEvent) => { e.preventDefault(); setImportDragging(true); }}
                onDragLeave={() => setImportDragging(false)}
                onDrop={(e: React.DragEvent) => {
                  e.preventDefault();
                  setImportDragging(false);
                  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    processImportFile(e.dataTransfer.files[0]);
                  }
                }}
              >
                <div className="dropzone-icon">
                  <UploadIcon />
                </div>
                <div className="dropzone-title">
                  {importParsing
                    ? 'Parsing file…'
                    : importFileName
                      ? `Selected: ${importFileName}`
                      : 'Drag & drop Excel or CSV file here'}
                </div>
                <div className="dropzone-sub">Supports .xlsx, .xls, or .csv formats</div>
              </div>

              <input
                type="file"
                ref={importFileInputRef}
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  if (e.target.files && e.target.files[0]) processImportFile(e.target.files[0]);
                }}
              />

              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div className="ct-record-count" style={{ textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                    Expected Header Format
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {CAMPAIGN_IMPORT_EXPECTED_HEADERS.map(col => (
                      <span key={col} className="chip">{col}</span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text4)', marginTop: 8 }}>
                    Use these column names in your Excel file. One row represents one campaign.
                  </div>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={downloadCampaignTemplate}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  <UploadIcon size={15} /> Download Excel Template
                </button>
              </div>

              {/* Parse summary + preview */}
              {importRows.length > 0 && !importParsing && (
                <div style={{ marginTop: 16 }}>
                  {(() => {
                    const valid = importRows.filter(r => r.status === 'valid').length;
                    const invalid = importRows.filter(r => r.status === 'invalid').length;
                    const duplicate = importRows.filter(r => r.status === 'duplicate').length;
                    return (
                      <>
                        <div style={{
                          padding: '9px 12px',
                          background: 'var(--surface3)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: 11,
                          border: '1px solid var(--border)',
                          borderBottom: 'none',
                          borderRadius: '10px 10px 0 0',
                        }}>
                          <span style={{ fontWeight: 600, color: 'var(--text2)' }}>Preview First 5 Rows</span>
                          <span style={{ fontWeight: 700, color: 'var(--green)' }}>
                            {importRows.length} rows parsed · {valid} valid · {invalid} invalid · {duplicate} duplicate
                          </span>
                        </div>
                        <div style={{ overflowX: 'auto', maxHeight: 260, border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 10px 10px' }}>
                          <table style={{ fontSize: 11, width: '100%', minWidth: `${CAMPAIGN_IMPORT_EXPECTED_HEADERS.length * 130}px` }}>
                            <thead>
                              <tr>
                                {CAMPAIGN_IMPORT_EXPECTED_HEADERS.map(key => (
                                  <th key={key} style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--surface)', textAlign: 'left' }}>
                                    {key}
                                  </th>
                                ))}
                                <th style={{ padding: '8px 10px', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--surface)', textAlign: 'left' }}>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {importRows.slice(0, 5).map((row) => (
                                <tr key={row.rowNumber}>
                                  {CAMPAIGN_IMPORT_EXPECTED_HEADERS.map(key => {
                                    const fieldKey = IMPORT_HEADER_FIELD_MAP[normalizeHeaderKey(key)] as keyof CampaignImportFields;
                                    const val = fieldKey ? (row[fieldKey] as string) : '';
                                    return (
                                      <td key={key} style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', color: 'var(--text3)', whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {val || ''}
                                      </td>
                                    );
                                  })}
                                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                                    <span className={`tag ${row.status === 'valid' ? 'tag-client' : row.status === 'duplicate' ? 'tag-newsletter' : 'tag-draft'}`}>
                                      {row.status === 'valid' ? 'Valid' : row.status === 'duplicate' ? 'Duplicate' : 'Invalid'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Validation result */}
                        <div style={{ marginTop: 14 }}>
                          {valid > 0 && (
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--green)', marginBottom: 6 }}>
                              {valid} campaign{valid === 1 ? '' : 's'} ready to import
                            </div>
                          )}
                          {invalid > 0 && (
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--red)', marginBottom: 6 }}>
                              {invalid} campaign{invalid === 1 ? '' : 's'} has errors
                            </div>
                          )}
                          {duplicate > 0 && (
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber)', marginBottom: 6 }}>
                              {duplicate} campaign{duplicate === 1 ? '' : 's'} will be skipped (duplicate)
                            </div>
                          )}
                          {(invalid > 0 || duplicate > 0) && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                              {importRows.filter(r => r.status !== 'valid').map(row => (
                                <div key={row.rowNumber} style={{ fontSize: 12, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--surface2)' }}>
                                  <div style={{ fontWeight: 700, color: 'var(--text2)', marginBottom: 4 }}>
                                    Row {row.rowNumber}
                                    {row.status === 'duplicate' ? ' — Duplicate campaign' : ''}
                                  </div>
                                  {row.errors.map((err, i) => (
                                    <div key={i} style={{ color: 'var(--red)', paddingLeft: 6 }}>• {err}</div>
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => { setIsImportModalOpen(false); setImportRows([]); setImportFileName(''); }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={importRows.length === 0 || importParsing || importSubmitting || importRows.filter(r => r.status === 'valid').length === 0}
                onClick={confirmCampaignImport}
              >
                {importSubmitting ? 'Importing…' : 'Confirm & Import Campaigns'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
