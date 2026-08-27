/**
 * Follow-up automation routes.
 *
 * Mounted at /api/followups in server.js.
 *   GET  /api/followups/pending    List follow-up records (manual queue + history).
 *   POST /api/followups/send/:id   Send one pending follow-up now.
 *
 * The per-campaign config routes live on the campaign resource:
 *   GET  /api/campaigns/:id/followup   Fetch a campaign's follow-up settings.
 *   POST /api/campaigns/:id/followup   Create / update the settings.
 */
import express from 'express';
import * as controller from '../controllers/followupController.js';

const router = express.Router();

// Dedicated Follow-ups page:
//   GET  /api/followups           List configured follow-up relationships.
//   POST /api/followups           Create a follow-up (original + follow-up campaign).
router.get('/', controller.listFollowupConfigs);
router.post('/', controller.createFollowupConfig);

router.get('/pending', controller.listPendingFollowups);
router.post('/send/:id', controller.sendPendingFollowup);

// Union of opened contacts across ALL eligible campaigns (the "All" option).
router.get('/opened/all', controller.getOpenedContactsForAll);

// Manage an existing follow-up configuration.
router.patch('/:id', controller.updateFollowupConfig);
router.delete('/:id', controller.deleteFollowupConfig);

// 405 for the wrong method on the above paths.
router.post('/pending', methodNotAllowed);
router.get('/send/:id', methodNotAllowed);

function methodNotAllowed(req, res) {
  res.status(405).json({
    success: false,
    error: {
      status: 405,
      message: `Method ${req.method} not allowed for ${req.originalUrl}.`,
    },
  });
}

export default router;
