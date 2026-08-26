/**
 * Shared email-rendering step used by every Edge Function that sends email.
 *
 * Takes the SAVED template HTML (personalized for one recipient) and converts
 * it into Gmail-safe markup before it is handed to `wrapHtmlDocument`:
 *
 *   1. A full-width wrapper table (email background) containing ONE centered
 *      content container. Templates with an explicit user-created Container
 *      (marked `data-te-role="container"`) are preserved VERBATIM — the
 *      container→children hierarchy stays intact and content the user placed
 *      outside the Container stays outside (nothing is folded or moved).
 *   2. Legacy templates without an explicit Container are normalized in place:
 *      content pasted outside the scaffold table is folded back into the SAME
 *      centered content container (exactly ONE content box, nothing escapes the
 *      resolved width), and a degenerate empty/tiny content card is widened to
 *      a usable email width instead of rendering as a tiny 100px box.
 *   3. Every <img> is constrained to the container (display:block,
 *      max-width:100%, and height:auto unless an explicit height was authored).
 *   4. camelCase CSS (maxWidth etc., emitted by GrapeJS) is normalized to
 *      kebab-case — Gmail silently drops camelCase rules.
 *   5. Inline-SVG social icons (Gmail strips <svg>) are converted to <img>
 *      tags served from public HTTPS icon CDNs, keeping each anchor's authored
 *      background / radius / size.
 *   6. All template content — logo, headings, paragraphs, buttons, images,
 *      dividers, sections, columns, social-icon tables, links, background
 *      colors, padding, merge placeholders — is preserved verbatim.
 *
 * Templates saved by the Template Editor already contain the editor scaffold
 * (a full-width wrapper table with a centered <td> holding the Container);
 * those are normalized/preserved in place. Any other HTML (uploaded templates,
 * legacy bodies, plain-text-converted bodies) is wrapped in the same safe
 * scaffold.
 */

const EMAIL_SAFE_WIDTH = 520;

// A degenerate content card (an EMPTY stub, or a card narrower than a usable
// email column) must be widened before folded content is injected, so the final
// email always has ONE properly-sized white card instead of a tiny 100px box.
const CONTENT_WIDTH_MIN = 480;
const CONTENT_WIDTH_DEFAULT = 600;

const STYLE_ATTR_RE = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i;

function getTagStyle(tag: string): string {
  const m = tag.match(STYLE_ATTR_RE);
  return m ? m[2] : '';
}

function setTagStyle(tag: string, newStyle: string): string {
  const styleMatch = tag.match(STYLE_ATTR_RE);
  if (styleMatch) {
    const pre = tag.slice(0, styleMatch.index);
    const post = tag.slice(styleMatch.index + styleMatch[0].length);
    return pre + ` style="${newStyle}"` + post;
  }
  return tag.replace(/\s*>$/, (end: string) => ` style="${newStyle}"${end}`);
}

function hasStyleRule(style: string, name: string): boolean {
  return new RegExp(`(?:^|;)\\s*${name}\\s*:`).test(style);
}

// ─── CSS normalization ─────────────────────────────────────────────────────

const CSS_KEBAB_RE = /([a-z0-9])([A-Z])/g;

function kebabCaseCssProp(prop: string): string {
  return String(prop || '').replace(CSS_KEBAB_RE, '$1-$2').toLowerCase();
}

function normalizeCssDeclaration(css: string): string {
  return String(css || '')
    .split(';')
    .map((part) => {
      const p = part.trim();
      if (!p) return '';
      const colon = p.indexOf(':');
      if (colon < 0) return p;
      const prop = p.slice(0, colon).trim();
      const value = p.slice(colon + 1).trim();
      return `${kebabCaseCssProp(prop)}:${value}`;
    })
    .filter((p) => p !== '')
    .join(';');
}

/** Rewrite camelCase CSS to kebab-case in inline styles and <style> blocks. */
function normalizeCssInHtml(html: string): string {
  let out = String(html || '').replace(
    /\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi,
    (_m: string, quote: string, css: string) => ` style=${quote}${normalizeCssDeclaration(css)}${quote}`,
  );
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m: string, css: string) => {
    const normalized = css.replace(
      /(\{)([\s\S]*?)(\})/g,
      (_r: string, open: string, body: string, close: string) => `${open}${normalizeCssDeclaration(body)}${close}`,
    );
    return `<style>${normalized}</style>`;
  });
  return out;
}

// ─── Email background extraction ───────────────────────────────────────────

function extractBackgroundColor(bodyAttrs: string, styleBlock: string): string {
  const colors: string[] = [];
  const bodyStyle = (String(bodyAttrs || '').match(/style\s*=\s*["']([\s\S]*?)["']/i) || [])[1] || '';
  const styleColor = (bodyStyle.match(/background-color\s*:\s*([^;]+)/i) || [])[1];
  if (styleColor) colors.push(styleColor.trim());
  const bgShorthand = (bodyStyle.match(/background\s*:\s*([^;]+)/i) || [])[1];
  if (bgShorthand) colors.push(bgShorthand.trim());

  const block = String(styleBlock || '');
  const bodyRule = block.match(/body\s*\{([^}]*)\}/i);
  const htmlRule = block.match(/\bhtml\s*\{([^}]*)\}/i);
  const rule = bodyRule || htmlRule;
  if (rule) {
    const ruleColor = (rule[1].match(/background(?:-color)?\s*:\s*([^;]+)/i) || [])[1];
    if (ruleColor) colors.push(ruleColor.trim());
  }

  for (const color of colors) {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) return color;
  }
  return '';
}

// ─── Social icons (inline SVG → <img>) ─────────────────────────────────────

interface SocialIconItem {
  id: string;
  url: string;
  size: number;
  color: string;
  bg: string;
  shape: string;
  radius: string;
}

function decodeAttrEntities(value: string): string {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseSocialIcons(rawJson: string): SocialIconItem[] | null {
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && Array.isArray(parsed.icons)) {
      return parsed.icons.map((ic: any) => ({
        id: String((ic && ic.id) || ''),
        url: String((ic && ic.url) || ''),
        size: Number(ic && ic.size) || 40,
        color: String((ic && ic.color) || '#FFFFFF'),
        bg: String((ic && ic.bg) || ''),
        shape: String((ic && ic.shape) || 'circle'),
        radius: String((ic && ic.radius) || ''),
      }));
    }
  } catch (_e) {
    // unparseable config → leave the block untouched
  }
  return null;
}

// The editor renders white glyphs on colored circles. Gmail strips <svg> and
// also blocks SVG images (cdn.simpleicons.org serves SVG), so the email must
// reference a PNG. The five standard brands + website/email use Icons8's `ios`
// white-glyph PNGs; any other simple-icons slug falls back to the same glyphs
// rendered as PNG (simple-icons-png on jsDelivr).
const ICONS8_ICON_NAMES: Record<string, string> = {
  instagram: 'instagram-new',
  linkedin: 'linkedin',
  facebook: 'facebook',
  youtube: 'youtube-play',
  google: 'google',
  website: 'globe',
  email: 'mail',
};

function socialIconImageUrl(brand: string, fill: string): string {
  const hex = String(fill || '#FFFFFF').replace(/^#/, '');
  const key = String(brand || 'website').toLowerCase();
  const iconName = ICONS8_ICON_NAMES[key];
  if (iconName) {
    return `https://img.icons8.com/ios/48/${hex}/${iconName}.png`;
  }
  return `https://cdn.jsdelivr.net/npm/simple-icons-png@latest/icons/${encodeURIComponent(key)}.png`;
}

/**
 * Guess the brand of a social icon from its anchor href. Used only when the
 * block's `data-te-social` config cannot be parsed — which happens when the
 * send pipeline already ran `decodeHtmlEntities()` over the whole body and the
 * double-quoted JSON inside the attribute lost its `&quot;` escaping. The
 * anchor itself (href + svg + fill) is untouched, so the brand is recovered
 * from the URL. Click-tracked links are unwrapped first (the original URL is
 * preserved in the `?url=` parameter).
 */
function socialBrandFromHref(href: string): string {
  let value = String(href || '');
  const urlParam = (value.match(/[?&]url=([^&#]+)/i) || [])[1];
  if (urlParam) {
    try {
      value = decodeURIComponent(urlParam);
    } catch (_e) {
      value = urlParam;
    }
  }
  value = value.toLowerCase();
  if (/^mailto:/i.test(value)) return 'email';
  const table: Array<[string, string]> = [
    ['instagram.com', 'instagram'],
    ['linkedin.com', 'linkedin'],
    ['facebook.com', 'facebook'],
    ['youtube.com', 'youtube'],
    ['wa.me', 'whatsapp'],
    ['whatsapp.com', 'whatsapp'],
    ['t.me', 'telegram'],
    ['telegram.org', 'telegram'],
    ['pinterest', 'pinterest'],
    ['tiktok.com', 'tiktok'],
    ['snapchat.com', 'snapchat'],
    ['reddit.com', 'reddit'],
    ['discord', 'discord'],
    ['github.com', 'github'],
    ['medium.com', 'medium'],
    ['threads.net', 'threads'],
    ['google.com', 'google'],
    ['x.com', 'x'],
    ['twitter.com', 'x'],
  ];
  for (const [needle, brand] of table) {
    if (value.includes(needle)) return brand;
  }
  return '';
}

function socialAnchorToImg(anchor: string, item: SocialIconItem | null): string {
  const openTag = (anchor.match(/<a\b[^>]*>/i) || [])[0];
  if (!openTag) return anchor;
  const href = (openTag.match(/\bhref\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
  const fillMatch = anchor.match(/<path\b[^>]*\bfill\s*=\s*["']([^"']*)["']/i);
  const fill = fillMatch ? fillMatch[1] : String((item && item.color) || '#FFFFFF');
  // When the block config is missing/unparseable (see socialBrandFromHref),
  // derive the brand from the anchor's own URL so the icon still renders.
  const brand = (item && item.id) || socialBrandFromHref(href);
  if (!brand) return anchor;
  const svgTag = (anchor.match(/<svg\b[^>]*>/i) || [])[0] || '';
  const sizeMatch = (svgTag.match(/\b(?:width|height)\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i) || [])[1];
  const size = sizeMatch ? Number(sizeMatch) : 24;
  const svgStyle = getTagStyle(svgTag);
  const marginMatch = svgStyle.match(/margin\s*:\s*([^;]+)/i);
  const margin = marginMatch ? marginMatch[1].trim() : '';
  const style = `display:block;background:transparent;border:0;${margin ? `margin:${margin};` : ''}`;
  const img =
    `<img src="${socialIconImageUrl(brand, fill)}" width="${size}" height="${size}" ` +
    `alt="${brand || 'social'}" style="${style}" />`;
  return anchor.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, img);
}

/** Convert social blocks' inline-SVG icons to <img> (Gmail strips <svg>). */
function convertSocialSvgToImgs(content: string): string {
  return String(content || '').replace(
    /<table\b[^>]*\bdata-te-social\b[^>]*>([\s\S]*?)<\/table>/gi,
    (whole: string, inner: string) => {
      const attrMatch = whole.match(/\bdata-te-social\s*=\s*["']([^"']*)["']/i);
      const raw = attrMatch ? attrMatch[1] : '';
      const icons = raw ? parseSocialIcons(decodeAttrEntities(raw)) : null;
      if (icons && icons.length === 0) return whole;
      let idx = 0;
      const newInner = inner.replace(
        /<a\b[^>]*>[\s\S]*?<svg\b[^>]*>[\s\S]*?<\/svg>[\s\S]*?<\/a>/gi,
        (anchor: string) => {
          const item = icons ? icons[idx % icons.length] : null;
          idx += 1;
          return socialAnchorToImg(anchor, item);
        },
      );
      return whole.replace(inner, newInner);
    },
  );
}

/** Keep template images from overflowing the content container. */
function constrainEmailImages(content: string): string {
  return String(content || '').replace(/<img\b[^>]*>/gi, (tag: string) => {
    const style = getTagStyle(tag);
    const adds: string[] = [];
    if (!hasStyleRule(style, 'display')) adds.push('display:block');
    if (!hasStyleRule(style, 'max-width')) adds.push('max-width:100%');
    const hasExplicitHeight =
      /\sheight\s*=\s*["']?[^"'\s>]+/i.test(tag) ||
      /(?:^|;)\s*height\s*:\s*(?!auto\b)[^;]+/i.test(style);
    if (!hasExplicitHeight && !hasStyleRule(style, 'height')) {
      adds.push('height:auto');
    }
    if (adds.length === 0) return tag;
    const merged = adds.join(';') + (style ? ';' + style : '');
    return setTagStyle(tag, merged);
  });
}

/** True when a <table> tag declares a full (100%) width. */
function isFullWidthTable(tag: string): boolean {
  if (/\swidth\s*=\s*["']?100%["']?/i.test(tag)) return true;
  return /(?:^|;)\s*width\s*:\s*100%/i.test(getTagStyle(tag));
}

/** Scan forward and return the inner HTML of the table opened at `from`. */
function scanTable(
  content: string,
  from: number,
): { inner: string; end: number; closeTag: string } | null {
  let depth = 1;
  let i = from;
  while (i < content.length) {
    const rest = content.slice(i);
    const comment = rest.match(/^<!--[\s\S]*?-->/);
    if (comment) {
      i += comment[0].length;
      continue;
    }
    const close = rest.match(/^<\/table\s*>/i);
    if (close) {
      depth -= 1;
      if (depth === 0) {
        return { inner: content.slice(from, i), end: i + close[0].length, closeTag: close[0] };
      }
      i += close[0].length;
      continue;
    }
    const open = rest.match(/^<table\b/i);
    if (open) {
      depth += 1;
      i += open[0].length;
      continue;
    }
    i += 1;
  }
  return null;
}

interface FirstTable {
  prefix: string;
  openTag: string;
  inner: string;
  suffix: string;
}

/** Extract the first top-level <table> (if any) that opens the content. */
function extractFirstTable(content: string): FirstTable | null {
  const m = String(content || '').match(/^((?:\s|<!--[\s\S]*?-->)*)(<table\b[^>]*>)/i);
  if (!m || m.index == null) return null;
  const found = scanTable(content, m.index + m[0].length);
  if (!found) return null;
  return { prefix: m[1], openTag: m[2], inner: found.inner, suffix: content.slice(found.end) };
}

/** True when the template contains an explicit user-created Container block. */
function hasExplicitContainer(content: string): boolean {
  return /<table\b[^>]*\bdata-te-role\s*=\s*["']container["']/i.test(String(content || ''));
}

function ensureWrapperAttrs(openTag: string): string {
  let tag = openTag;
  const style = getTagStyle(tag);
  const keep: string[] = [];
  for (const part of style.split(';')) {
    const p = part.trim();
    if (!p) continue;
    if (/^(width|max-width|margin(-left|-right)?)\s*:/i.test(p)) continue;
    keep.push(p);
  }
  // The wrapper spans the full message width so the EMAIL BACKGROUND COLOR
  // fills the whole area around the single centered content container.
  tag = setTagStyle(tag, `width:100%;${keep.join(';')}`);
  const setAttr = (name: string, value: string) => {
    const attrRe = new RegExp(`\\s${name}\\s*=\\s*["'][^"']*["']`, 'i');
    if (attrRe.test(tag)) {
      tag = tag.replace(attrRe, ` ${name}="${value}"`);
    } else {
      tag = tag.replace(/>$/, ` ${name}="${value}">`);
    }
  };
  setAttr('width', '100%');
  setAttr('align', 'center');
  setAttr('cellpadding', '0');
  setAttr('cellspacing', '0');
  setAttr('role', 'presentation');
  return tag;
}

function ensureCenteredCell(inner: string): string {
  const m = inner.match(/<td\b[^>]*>/i);
  if (!m) return inner;
  const td = m[0];
  if (/\balign\s*=\s*["']?center["']?/i.test(td)) return inner;
  if (hasStyleRule(getTagStyle(td), 'text-align')) return inner;
  return inner.replace(td, td.replace(/>$/, ' align="center">'));
}

/** Resolve the email width for a content table: authored px width, then px max-width, then default. */
function resolveContentWidth(tag: string): number {
  const styleMatch = tag.match(STYLE_ATTR_RE);
  const style = styleMatch ? styleMatch[2] : '';

  let widthPx: number | null = null;
  let maxPx: number | null = null;
  for (const part of style.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const lower = p.toLowerCase();
    const wm = lower.match(/^width\s*:\s*(\d+(?:\.\d+)?)px$/);
    const mm = lower.match(/^max-width\s*:\s*(\d+(?:\.\d+)?)px$/);
    if (wm) widthPx = Number(wm[1]);
    else if (mm) maxPx = Number(mm[1]);
  }

  const attrMatch = tag.match(/\swidth\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i);
  const attrWidth = attrMatch ? Number(attrMatch[1]) : null;
  if (widthPx == null && attrWidth != null) widthPx = attrWidth;

  if (widthPx != null && widthPx > 0) return widthPx;
  if (maxPx != null && maxPx > 0) return maxPx;
  return EMAIL_SAFE_WIDTH;
}

/** Cap the first nested table (the content container) to the resolved width. */
function capContentTable(tag: string, opts: { forceWidth?: number; clamp?: boolean } = {}): string {
  const styleMatch = tag.match(STYLE_ATTR_RE);
  const style = styleMatch ? styleMatch[2] : '';

  const keep: string[] = [];
  for (const part of style.split(';')) {
    const p = part.trim();
    if (!p) continue;
    if (/^(width|max-width|margin(-left|-right)?)\s*:/i.test(p)) continue;
    keep.push(p);
  }

  // The authored width (px width, then px max-width) is preserved; EMAIL_SAFE_WIDTH
  // is used only as the fallback default when no width was authored. A degenerate
  // empty/tiny card is widened via `forceWidth` (see normalizeScaffold).
  let target = opts.forceWidth != null ? opts.forceWidth : resolveContentWidth(tag);
  if (opts.clamp) target = Math.max(target, CONTENT_WIDTH_MIN);

  const newStyle = `width:100%;max-width:${target}px;margin:0 auto;` + keep.join(';');
  let out = setTagStyle(tag, newStyle);

  if (/\swidth\s*=/i.test(out)) {
    out = out.replace(
      /(\swidth\s*=\s*["'])\d+(?:\.\d+)?(?:px)?(["'])/i,
      (_m: string, p: string, q: string) => `${p}${target}${q}`,
    );
  } else {
    out = out.replace(/>$/, ` width="${target}">`);
  }
  return out;
}

/** True when a table's inner markup contains no real content (empty cells/rows only). */
function isEmptyCardInner(inner: string): boolean {
  const s = String(inner || '').replace(/\s+/g, '');
  if (!s) return true;
  const stripped = s
    .replace(/<tbody\b[^>]*>/gi, '')
    .replace(/<\/tbody\s*>/gi, '')
    .replace(/<tr\b[^>]*>/gi, '')
    .replace(/<\/tr\s*>/gi, '')
    .replace(/<td\b[^>]*>/gi, '')
    .replace(/<\/td\s*>/gi, '');
  return stripped === '';
}

/** Locate the first nested table (the content card) inside a wrapper's inner HTML. */
function findContentCard(inner: string): { tag: string; inner: string } | null {
  const open = inner.match(/<table\b[^>]*>/i);
  if (!open || open.index == null) return null;
  const region = scanTable(inner, open.index + open[0].length);
  if (!region) return null;
  return { tag: open[0], inner: region.inner };
}

/**
 * True when the first (wrapper) table holds a nested content card that is an
 * EMPTY or undersized styled card — the shape a broken editor produces when the
 * real content was saved OUTSIDE the scaffold. Such templates must still be
 * normalized/folded even when the wrapper is not full-width (e.g. width="50%").
 */
function isBrokenEmptyCardScaffold(first: FirstTable): boolean {
  const card = findContentCard(first.inner);
  if (!card) return false;
  if (!/(?:background(?:-color)?\s*:|bgcolor\s*=|border-radius\s*:)/i.test(card.tag)) return false;
  return isEmptyCardInner(card.inner) || resolveContentWidth(card.tag) < CONTENT_WIDTH_MIN;
}

/**
 * Find the first `<td ...>` starting at/after `from` together with its matching
 * `</td>`. Nested `<td>` depth is tracked so tables living inside a cell never
 * break the scan. Returns `{ openStart, openEnd, inner, closeStart, closeTag,
 * end }` or null when no cell exists in the region.
 */
interface TableCell {
  openStart: number;
  openEnd: number;
  inner: string;
  closeStart: number;
  closeTag: string;
  end: number;
}

function findTableCell(content: string, from: number): TableCell | null {
  const rest = content.slice(from);
  const open = rest.match(/<td\b[^>]*>/i);
  if (!open || open.index == null) return null;
  const openStart = from + open.index;
  const openEnd = openStart + open[0].length;
  let depth = 1;
  let i = openEnd;
  while (i < content.length) {
    const tail = content.slice(i);
    const comment = tail.match(/^<!--[\s\S]*?-->/);
    if (comment) {
      i += comment[0].length;
      continue;
    }
    const close = tail.match(/^<\/td\s*>/i);
    if (close) {
      depth -= 1;
      if (depth === 0) {
        return {
          openStart,
          openEnd,
          inner: content.slice(openEnd, i),
          closeStart: i,
          closeTag: close[0],
          end: i + close[0].length,
        };
      }
      i += close[0].length;
      continue;
    }
    const nested = tail.match(/^<td\b/i);
    if (nested) {
      depth += 1;
      i += nested[0].length;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * Fold every block that the editor saved OUTSIDE the content table back into the
 * single centered content container, so the final email has exactly ONE content
 * box (plus the full-width email-background wrapper):
 *
 *   OUTER EMAIL TABLE (EMAIL BACKGROUND COLOR)
 *     └─ centered cell
 *        └─ CONTENT TABLE (CONTENT BACKGROUND COLOR, resolved width)
 *           └─ logo / image / text / all other template blocks
 *
 * Stray content is anything not already inside the content table: blocks the
 * editor placed in the wrapper cell before it, blocks placed after it (still in
 * the wrapper cell), and content that follows the wrapper table entirely (the
 * suffix). Blocks are injected inside the content table's first cell (the cell
 * is created when a template saved an empty content table), preserving authored
 * order: cell-before + existing cell content + cell-after + suffix.
 */
function foldStrayBlocks(inner: string, suffix: string): string {
  const open = inner.match(/<table\b[^>]*>/i);
  if (!open || open.index == null) return inner;
  const openEnd = open.index + open[0].length;
  const region = scanTable(inner, openEnd);
  if (!region) return inner;
  const tableCloseEnd = region.end;

  // The wrapper's first cell wraps the content table; locate it so stray blocks
  // can be separated from the wrapper's structural <tbody>/<tr>/<td> markup.
  const cell = findTableCell(inner, 0);
  if (!cell) return inner;

  const straySuffix = String(suffix || '').trim();
  const pre = inner.slice(cell.openEnd, open.index).trim();
  const post = inner.slice(tableCloseEnd, cell.closeStart).trim();
  if (!pre && !post && !straySuffix) return inner;

  // Remove the stray blocks from their original location (the wrapper cell),
  // keeping only the structural markup and the content table.
  const preLen = open.index - cell.openEnd;
  const s1 = inner.slice(0, cell.openEnd) + inner.slice(open.index);
  const s1TableCloseEnd = tableCloseEnd - preLen;
  const s1CellCloseStart = cell.closeStart - preLen;
  const s2 = s1.slice(0, s1TableCloseEnd) + s1.slice(s1CellCloseStart);

  // Inject the stray blocks into the content table's first cell, preserving
  // authored order: cell-before + existing cell content + cell-after + suffix.
  const cellContent = findTableCell(s2, cell.openEnd);
  if (cellContent) {
    return (
      s2.slice(0, cellContent.openEnd) +
      pre +
      s2.slice(cellContent.openEnd, cellContent.closeStart) +
      [post, straySuffix].filter(Boolean).join('\n') +
      s2.slice(cellContent.closeStart)
    );
  }

  // The content table has no cell (e.g. an empty <tr>) — create one. Prefer
  // injecting the cell into the first row, otherwise add a fresh row.
  const tableInner = s2.slice(cell.openEnd, s1TableCloseEnd);
  const tr = tableInner.match(/<tr\b[^>]*>/i);
  const injected = `<td align="left" valign="top">${pre}${[post, straySuffix].filter(Boolean).join('\n')}</td>`;
  if (tr && tr.index != null) {
    const trOpenEnd = cell.openEnd + tr.index + tr[0].length;
    return s2.slice(0, trOpenEnd) + injected + s2.slice(trOpenEnd);
  }
  const s2TableCloseStart = s1TableCloseEnd - region.closeTag.length;
  return (
    s2.slice(0, s2TableCloseStart) +
    `<tr>${injected}</tr>` +
    s2.slice(s2TableCloseStart)
  );
}

/** Normalize an existing editor/uploaded scaffold that is already full-width. */
function normalizeScaffold(first: FirstTable, bg = ''): string {
  let inner = first.inner;
  inner = ensureCenteredCell(inner);

  // A degenerate content card (an EMPTY stub, or one narrower than a usable
  // column) must be widened so everything folded into it forms ONE properly
  // sized card instead of a tiny 100px box.
  const card = findContentCard(inner);
  let forceWidth: number | null = null;
  if (card) {
    if (isEmptyCardInner(card.inner)) forceWidth = CONTENT_WIDTH_DEFAULT;
    else if (resolveContentWidth(card.tag) < CONTENT_WIDTH_MIN) forceWidth = CONTENT_WIDTH_MIN;
  }
  inner = inner.replace(/<table\b[^>]*>/i, (tag: string) => capContentTable(tag, { forceWidth: forceWidth ?? undefined }));

  let wrapper = ensureWrapperAttrs(first.openTag);
  if (bg && !/\bbgcolor\s*=/i.test(wrapper)) {
    wrapper = wrapper.replace(/>\s*$/, (end: string) => ` bgcolor="${bg}"${end}`);
    const wStyle = getTagStyle(wrapper);
    if (!hasStyleRule(wStyle, 'background-color')) {
      wrapper = setTagStyle(wrapper, `background-color:${bg};${wStyle}`);
    }
  }

  // Content that lives OUTSIDE the scaffold table (blocks the visual editor
  // saved before/after the content table or past the wrapper, as happens with
  // edited/uploaded templates) must still render inside the SAME centered
  // content container — otherwise it would form a second white box or sit
  // directly on the email background. Fold it in; never append a second scaffold.
  inner = foldStrayBlocks(inner, String(first.suffix || '').trim());

  return first.prefix + wrapper + inner + '</table>';
}

/**
 * Preserve a template that contains an explicit user-created Container. The
 * email-background wrapper stays full-width (with the extracted background
 * colour), and the Container — with EVERY block inside it — is preserved
 * verbatim. Content the user deliberately placed OUTSIDE the Container is left
 * exactly where they put it: nothing is folded or moved, because the user
 * explicitly chose where it belongs. Also used for a full-width wrapper that
 * holds no content card yet (a fresh Blank Template before the Container is
 * added) so the background-only email is not double-wrapped.
 */
function normalizeContainerScaffold(first: FirstTable, bg = ''): string {
  let inner = first.inner;
  inner = ensureCenteredCell(inner);

  let wrapper = ensureWrapperAttrs(first.openTag);
  if (bg && !/\bbgcolor\s*=/i.test(wrapper)) {
    wrapper = wrapper.replace(/>\s*$/, (end: string) => ` bgcolor="${bg}"${end}`);
    const wStyle = getTagStyle(wrapper);
    if (!hasStyleRule(wStyle, 'background-color')) {
      wrapper = setTagStyle(wrapper, `background-color:${bg};${wStyle}`);
    }
  }

  return first.prefix + wrapper + inner + '</table>';
}

/** Wrap non-scaffold content in a safe, centered 600px email container. */
function buildEmailScaffold(content: string, bg = ''): string {
  const bgStyle = bg ? `background-color:${bg};` : '';
  const bgAttr = bg ? ` bgcolor="${bg}"` : '';
  return (
    `<table width="100%" align="center" cellpadding="0" cellspacing="0" border="0" role="presentation"${bgAttr} style="width:100%;${bgStyle}">` +
    '<tr><td align="center" valign="top">' +
    `<table width="${EMAIL_SAFE_WIDTH}" cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;max-width:${EMAIL_SAFE_WIDTH}px;margin:0 auto;">` +
    '<tr><td align="left" valign="top" style="padding:24px 16px;">' +
    content +
    '</td></tr>' +
    '</table>' +
    '</td></tr>' +
    '</table>'
  );
}

// ─── Email link normalization ───────────────────────────────────────────────
// Every real text hyperlink in an email must render as ONE continuous, blue,
// underlined, clickable <a> element — even when the URL has no break
// opportunity and wraps across multiple lines. Gmail/Outlook are notoriously
// inconsistent about long URLs: without `overflow-wrap:anywhere;word-break:
// break-word;` the URL overflows or (worse) only the first visual line stays
// coloured while the wrapped continuation turns black. We also defend against
// a known authoring artifact where the browser's contenteditable auto-link
// splits a pasted long URL at a soft wrap — leaving the first line inside the
// <a> and the rest as plain (black) text outside it. We re-merge that
// continuation back into the original anchor so the link stays intact.
//
// Buttons (`data-te-button`) and social-icon anchors (which contain an
// <img>/<svg> or carry a background colour) are deliberately left untouched.

const LINK_STYLE =
  'color:#0066cc !important;' +
  'text-decoration:underline !important;' +
  'overflow-wrap:anywhere;' +
  'word-break:break-word;';

/** True for anchors that are buttons or social icons — never restyle these. */
function isLinkButton(openTag: string, inner: string): boolean {
  if (/\bdata-te-button\s*=/i.test(openTag)) return true;
  if (/<img\b/i.test(inner) || /<svg\b/i.test(inner)) return true;
  const style = getTagStyle(openTag);
  if (/(?:^|;)\s*background(?:-color)?\s*:\s*(?!transparent|none)/i.test(style)) return true;
  return false;
}

/** Add the canonical email-safe link styling to an <a> opening tag. */
function addLinkStyle(openTag: string): string {
  let style = getTagStyle(openTag);
  style = style
    .replace(/color\s*:[^;]+;?/gi, '')
    .replace(/text-decoration(-line)?\s*:[^;]+;?/gi, '')
    .replace(/overflow-wrap\s*:[^;]+;?/gi, '')
    .replace(/word-break\s*:[^;]+;?/gi, '')
    .replace(/;+/g, ';')
    .replace(/^;+|;+$/g, '');
  const merged = LINK_STYLE + (style ? style + ';' : '');
  return setTagStyle(openTag, merged);
}

/** Strip colour/decoration/background from a nested <span> so it cannot
 *  override the link colour. */
function stripSpanConflictStyles(spanOpen: string): string {
  let style = getTagStyle(spanOpen);
  if (!style) return spanOpen;
  style = style
    .replace(/color\s*:[^;]+;?/gi, '')
    .replace(/text-decoration(-line)?\s*:[^;]+;?/gi, '')
    .replace(/background(?:-color)?\s*:[^;]+;?/gi, '')
    .replace(/;+/g, ';')
    .replace(/^;+|;+$/g, '');
  if (!style) return spanOpen.replace(/\s+style\s*=\s*["'][^"']*["']/i, '');
  return setTagStyle(spanOpen, style);
}

function normalizeInnerSpans(inner: string): string {
  return inner.replace(/<span\b([^>]*)>/gi, (full: string) => stripSpanConflictStyles(full));
}

/** Plain-text content of an HTML fragment (tag-stripped). */
function textContentOf(html: string): string {
  return String(html || '').replace(/<[^>]+>/g, '');
}

/** Recover the original destination URL from a click-tracking href so the
 *  split-continuation check can compare against the real link target. */
function originalUrlFromHref(href: string): string {
  const m = href.match(/[?&]url=([^&#]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href;
}

/**
 * If the anchor's text is a prefix of its destination URL and the following
 * markup is the (whitespace/`<br>`-separated) continuation of that same URL,
 * absorb the continuation back into the anchor so the link is never split.
 * Returns the merged text and the index just past the consumed continuation.
 */
function mergeUrlContinuation(
  html: string,
  startIndex: number,
  target: string,
  startText: string,
): { text: string; index: number } | null {
  let i = startIndex;
  let text = startText;
  let consumed = '';
  while (i < html.length) {
    const ws = /^[\s]+/.exec(html.slice(i));
    if (ws) {
      i += ws[0].length;
    }
    const br = /^<br\s*\/?>|^<wbr\s*\/?>/i.exec(html.slice(i));
    if (br) {
      i += br[0].length;
      continue;
    }
    if (/^</.test(html.slice(i))) break;
    const run = /^[^\s<]+/.exec(html.slice(i));
    if (!run) break;
    const candidate = text + run[0];
    if (target.startsWith(candidate)) {
      text = candidate;
      consumed += run[0];
      i += run[0].length;
    } else {
      break;
    }
  }
  if (consumed) return { text: consumed, index: i };
  return null;
}

/**
 * Ensure every real text hyperlink in the email HTML is rendered as one
 * continuous, blue, underlined, wrapping-safe <a>. Buttons and social-icon
 * anchors are preserved verbatim. Existing anchors are NOT recreated from plain
 * text — only normalized in place (style + nested-span + split-merge).
 */
export function normalizeEmailLinks(html: string): string {
  const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let result = '';
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(html))) {
    const openTag = '<a' + m[1] + '>';
    const inner = m[2];
    const hrefMatch = openTag.match(/\bhref\s*=\s*["']([^"']*)["']/i);
    const href = hrefMatch ? hrefMatch[1] : '';
    const isRealLink =
      /^(?:https?:\/\/|mailto:|tel:|ftp:)/i.test(href) ||
      /[?&]url=/.test(href);
    let newOpen = openTag;
    let newInner = inner;
    if (isRealLink && !isLinkButton(openTag, inner)) {
      newOpen = addLinkStyle(openTag);
      newInner = normalizeInnerSpans(inner);
      const target = originalUrlFromHref(href);
      const baseText = textContentOf(newInner);
      if (target.length > baseText.length) {
        const merged = mergeUrlContinuation(html, ANCHOR_RE.lastIndex, target, baseText);
        if (merged) {
          newInner = newInner + merged.text;
          ANCHOR_RE.lastIndex = merged.index;
        }
      }
    }
    result += html.slice(lastIndex, m.index) + newOpen + newInner + '</a>';
    lastIndex = ANCHOR_RE.lastIndex;
  }
  result += html.slice(lastIndex);
  return result;
}

/** Wrap/convert saved template HTML into a Gmail-safe, centered layout. */
export function toEmailSafeHtml(html: string): string {
  const sourceRaw = String(html || '');
  if (!sourceRaw.trim()) return sourceRaw;

  // Normalize camelCase CSS first (inline styles AND <style> blocks).
  const source = normalizeCssInHtml(sourceRaw);

  const bodyMatch = source.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  const isFullDocument = !!bodyMatch;
  const bodyAttrs = bodyMatch ? bodyMatch[1] : '';
  const styleBlock = (source.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || '';
  const bg = extractBackgroundColor(bodyAttrs, styleBlock);

  const bodyContent = bodyMatch
    ? bodyMatch[2]
    : source
        .replace(/<!doctype[^>]*>/i, '')
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<\/?(?:html|body)[^>]*>/gi, '')
        .trim();

  let safeBody = constrainEmailImages(bodyContent);
  safeBody = convertSocialSvgToImgs(safeBody);

  const first = extractFirstTable(safeBody);
  // Treat the first table as an editor scaffold (normalize/fold in place) when
  // it is a full-width wrapper OR a wrapper holding a broken empty/tiny content
  // card — even when the wrapper is not full-width (e.g. width="50%").
  const isScaffold =
    first &&
    /<table\b/i.test(first.inner) &&
    (isFullWidthTable(first.openTag) || isBrokenEmptyCardScaffold(first));

  if (first && hasExplicitContainer(safeBody)) {
    // Templates with an explicit Container are preserved VERBATIM — the
    // container→children hierarchy stays intact and nothing is folded/moved.
    safeBody = normalizeContainerScaffold(first, bg);
  } else if (isScaffold) {
    // Legacy/uploaded scaffolds: fold stray blocks into the content card.
    safeBody = normalizeScaffold(first, bg);
  } else if (first && isFullWidthTable(first.openTag)) {
    // Full-width wrapper with no content card yet (a fresh Blank Template
    // before the user adds a Container): keep the background only.
    safeBody = normalizeContainerScaffold(first, bg);
  } else {
    safeBody = buildEmailScaffold(safeBody, bg);
  }

  if (isFullDocument) {
    return source.replace(
      /(<body[^>]*>)([\s\S]*?)(<\/body>)/i,
      (_m: string, open: string, _inner: string, close: string) =>
        `${open}\n${normalizeEmailLinks(safeBody)}\n${close}`,
    );
  }
  return normalizeEmailLinks(safeBody);
}