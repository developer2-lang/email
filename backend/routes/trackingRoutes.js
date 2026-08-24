/**
 * Email open / click tracking endpoints.
 *
 * Mounted at /api/tracking in server.js.
 *
 *   GET /api/tracking/open/:trackingId.png
 *       Email client loads the 1x1 pixel → marks the email as opened and
 *       returns a transparent PNG. Always responds 200 so the mail client
 *       never shows a broken image, even if recording fails.
 *
 *   GET /api/tracking/click/:trackingId?url=https://...
 *       Recipient clicks a link → marks the email as clicked and 302-redirects
 *       to the original destination.
 */
import { Router } from 'express';
import * as trackingService from '../services/trackingService.js';

const router = Router();

// 1x1 transparent PNG.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

router.get('/open/:trackingId', async (req, res) => {
  // Old emails may contain `${trackingId}.png` or `${trackingId}.gif`.
  // Strip the suffix so the UUID still matches email_logs.tracking_id.
  const trackingId = String(req.params.trackingId || '').replace(/\.(png|gif)$/i, '');
  console.log(`[Tracking] GET ${req.originalUrl}`);
  console.log(`[Tracking] Open pixel fired — raw param: ${req.params.trackingId} → tracking_id: ${trackingId}`);

  try {
    const result = await trackingService.recordOpen(trackingId);
    console.log(`[Tracking] Open recorded: ${trackingId}`, result ? JSON.stringify(result) : '(no result)');
  } catch (error) {
    console.error(`[Tracking] Failed to record open for ${trackingId}: ${error.message}`);
    if (error.stack) console.error(`[Tracking] Stack: ${error.stack}`);
  }

  res.set('Content-Type', 'image/png');
  res.set('Content-Length', String(TRANSPARENT_PNG.length));
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.send(TRANSPARENT_PNG);
});

router.get('/click/:campaignId/:recipientId', async (req, res) => {
  const campaignId = String(req.params.campaignId || '').replace(/\.(png|gif)$/i, '');
  const recipientId = String(req.params.recipientId || '').replace(/\.(png|gif)$/i, '');
  const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  console.log(`[Tracking] GET ${req.originalUrl}`);
  console.log(`[Tracking] Click fired — campaign_id: ${campaignId} recipient_id: ${recipientId} → url: ${url}`);

  try {
    const result = await trackingService.recordClick({ campaignId, recipientId });
    console.log(`[Tracking] Click recorded: ${campaignId}/${recipientId}`, result ? JSON.stringify(result) : '(no result)');
  } catch (error) {
    console.error(`[Tracking] Failed to record click for ${campaignId}/${recipientId}: ${error.message}`);
    if (error.stack) console.error(`[Tracking] Stack: ${error.stack}`);
  }

  if (!/^https?:\/\//i.test(url)) {
    console.warn(`[Tracking] Click ${campaignId}/${recipientId} — missing/invalid url, returning 400`);
    return res.status(400).json({
      success: false,
      message: 'Missing or invalid redirect url',
    });
  }

  console.log(`[Tracking] Redirecting ${campaignId}/${recipientId} → ${url}`);
  return res.redirect(302, url);
});

router.get('/click/:trackingId', async (req, res) => {
  const trackingId = String(req.params.trackingId || '').replace(/\.(png|gif)$/i, '');
  const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  console.log(`[Tracking] GET ${req.originalUrl}`);
  console.log(`[Tracking] Click fired — tracking_id: ${trackingId} → url: ${url}`);

  try {
    const result = await trackingService.recordClick({ trackingId });
    console.log(`[Tracking] Click recorded: ${trackingId}`, result ? JSON.stringify(result) : '(no result)');
  } catch (error) {
    console.error(`[Tracking] Failed to record click for ${trackingId}: ${error.message}`);
    if (error.stack) console.error(`[Tracking] Stack: ${error.stack}`);
  }

  if (!/^https?:\/\//i.test(url)) {
    console.warn(`[Tracking] Click ${trackingId} — missing/invalid url, returning 400`);
    return res.status(400).json({
      success: false,
      message: 'Missing or invalid redirect url',
    });
  }

  console.log(`[Tracking] Redirecting ${trackingId} → ${url}`);
  return res.redirect(302, url);
});

export default router;
