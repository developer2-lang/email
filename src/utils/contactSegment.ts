/**
 * Audience-segment classification for Contacts.
 *
 * The actual implementation lives in the canonical, shared module
 * `supabase/functions/_shared/audience.ts` so the SAME logic powers the dropdown
 * count, the campaign preview AND the real send (both Edge Functions import it
 * directly). This file re-exports it so existing importers
 * (sequenceApi.ts, contactSegment.test.ts, CampaignsTab.tsx) keep working
 * unchanged while there remains exactly ONE source of truth.
 *
 * The Audience Segment table stores only segment *names* (labels). The actual
 * count and recipient list are always derived from the Contacts table using the
 * category rules in the shared module — never from an exact segment-name match.
 */
export {
  normalizeAudienceValue,
  normalizeContactType,
  normalizeCompanyCategory,
  isDeliverableRecipientEmail,
  registerSegmentRule,
  contactMatchesSegment,
  isManualAudience,
  filterContactsBySegment,
  resolveSegmentRecipients,
  resolveSegmentCount,
  resolveContactListRecipients,
  isCustomListSegment,
} from '../../supabase/functions/_shared/audience';

export type { SegmentContact, SegmentRule } from '../../supabase/functions/_shared/audience';
