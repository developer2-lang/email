/**
 * SMTP email configuration — loaded from environment variables.
 *
 * Deliverability notes:
 *  - From is always the authenticated address (or an explicit EMAIL_FROM that
 *    belongs to the same sending domain). Display name is optional via
 *    EMAIL_FROM_NAME.
 *  - Reply-To defaults to the From address so replies land in the sender's
 *    inbox (EMAIL_REPLY_TO overrides).
 *  - List-Unsubscribe defaults to a mailto: to the From address so recipients
 *    get a working unsubscribe path without an external landing page.
 */
const fromName = (process.env.EMAIL_FROM_NAME || '').trim();
const fromAddress = (process.env.EMAIL_FROM || '').trim() || (process.env.EMAIL_USER || '').trim();

export default {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT, 10) || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  from: fromAddress && fromName
    ? `"${fromName.replace(/["\\]/g, '')}" <${fromAddress}>`
    : fromAddress,
  replyTo: (process.env.EMAIL_REPLY_TO || '').trim() || fromAddress,
  listUnsubscribe:
    (process.env.EMAIL_UNSUBSCRIBE_MAILTO || '').trim() ||
    (fromAddress ? `mailto:${fromAddress}?subject=Unsubscribe` : ''),
};
