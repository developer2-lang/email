/**
 * Tracking configuration.
 *
 * `baseUrl` is the publicly reachable origin where this backend is hosted.
 * It is embedded into every outgoing email as:
 *   - open pixel:  {baseUrl}/api/tracking/open/<trackingId>
 *   - click links: {baseUrl}/api/tracking/click/<trackingId>?url=<destination>
 *
 * It comes exclusively from the TRACKING_BASE_URL env var (backend/.env) so
 * that pointing tracking at a deployed/ngrok URL never requires a code change.
 * Emails opened in Gmail/Outlook CANNOT reach localhost, so when
 * TRACKING_BASE_URL is unset open/click tracking will silently never fire for
 * real recipients. We warn loudly in that case.
 */
const configured = (process.env.TRACKING_BASE_URL || '').trim();
const baseUrl = configured.replace(/\/+$/, '');

if (!baseUrl) {
  console.warn('═══════════════════════════════════════════════════════════════════');
  console.warn('  ⚠ TRACKING_BASE_URL IS NOT SET');
  console.warn('  The open pixel and click links embedded in sent emails will be');
  console.warn('  broken because the base URL is empty.');
  console.warn('  Set TRACKING_BASE_URL in backend/.env to a URL reachable from');
  console.warn('  the public internet:');
  console.warn('    - deployed:  TRACKING_BASE_URL=https://your-public-domain.com');
  console.warn('    - local dev: TRACKING_BASE_URL=https://abc123.ngrok-free.app');
  console.warn('      (start ngrok with: ngrok http 5000)');
  console.warn('═══════════════════════════════════════════════════════════════════');
} else {
  console.log(`[Tracking] Public base URL: ${baseUrl}`);
  if (/ngrok-free\.app/i.test(baseUrl)) {
    console.warn('═══════════════════════════════════════════════════════════════════');
    console.warn('  ⚠ ngrok FREE-tier tunnel detected (ngrok-free.app).');
    console.warn('  ngrok serves a "You are about to visit" browser warning');
    console.warn('  (ERR_NGROK_6024) in front of browser-like requests, which');
    console.warn('  intercepts real Gmail/Outlook recipients BEFORE they reach this');
    console.warn('  backend — so opens/clicks will NOT be recorded. Use a paid ngrok');
    console.warn('  plan with the browser interstitial disabled, a deployed URL, or a');
    console.warn('  Cloudflare Tunnel (https://<id>.trycloudflare.com).');
    console.warn('═══════════════════════════════════════════════════════════════════');
  }
}

export default { baseUrl };
