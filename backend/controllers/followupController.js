/**
 * Follow-up automation route handlers.
 *
 * Thin controllers that delegate to the follow-up service and return the
 * standard JSON envelope.
 */
import * as followupService from '../services/followupService.js';

async function getFollowupConfig(req, res, next) {
  try {
    const data = await followupService.getFollowupConfig(req.params.id);
    res.json({ success: true, data: data || null });
  } catch (error) {
    console.error('[Followup] getFollowupConfig FAILED:', error.message);
    next(error);
  }
}

async function saveFollowupConfig(req, res, next) {
  try {
    const data = await followupService.saveFollowupConfig(req.params.id, req.body || {});
    res.json({ success: true, message: 'Follow-up settings saved.', data });
  } catch (error) {
    console.error('[Followup] saveFollowupConfig FAILED:', error.message);
    next(error);
  }
}

async function listPendingFollowups(req, res, next) {
  try {
    const data = await followupService.listPendingFollowups();
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Followup] listPendingFollowups FAILED:', error.message);
    next(error);
  }
}

async function sendPendingFollowup(req, res, next) {
  try {
    const data = await followupService.sendPendingFollowup(req.params.id);
    res.json({ success: true, message: 'Follow-up sent.', data });
  } catch (error) {
    console.error('[Followup] sendPendingFollowup FAILED:', error.message);
    next(error);
  }
}

async function getOpenedContacts(req, res, next) {
  try {
    const data = await followupService.getOpenedContacts(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Followup] getOpenedContacts FAILED:', error.message);
    next(error);
  }
}

async function getOpenedContactsForAll(req, res, next) {
  try {
    const data = await followupService.getOpenedContactsForAll();
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Followup] getOpenedContactsForAll FAILED:', error.message);
    next(error);
  }
}

async function sendSelectedFollowups(req, res, next) {
  try {
    const data = await followupService.sendFollowupsToSelected(req.params.id, req.body || {});
    res.json({ success: true, message: 'Follow-ups processed.', data });
  } catch (error) {
    console.error('[Followup] sendSelectedFollowups FAILED:', error.message);
    next(error);
  }
}

async function listFollowupConfigs(req, res, next) {
  try {
    const data = await followupService.listFollowupConfigs();
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Followup] listFollowupConfigs FAILED:', error.message);
    next(error);
  }
}

async function createFollowupConfig(req, res, next) {
  try {
    const data = await followupService.createFollowupConfig(req.body || {});
    res.status(201).json({ success: true, message: 'Follow-up created.', data });
  } catch (error) {
    console.error('[Followup] createFollowupConfig FAILED:', error.message);
    next(error);
  }
}

async function updateFollowupConfig(req, res, next) {
  try {
    const data = await followupService.updateFollowupConfig(req.params.id, req.body || {});
    res.json({ success: true, message: 'Follow-up configuration updated.', data });
  } catch (error) {
    console.error('[Followup] updateFollowupConfig FAILED:', error.message);
    next(error);
  }
}

async function deleteFollowupConfig(req, res, next) {
  try {
    const data = await followupService.deleteFollowupConfig(req.params.id);
    res.json({ success: true, message: 'Follow-up configuration deleted.', data });
  } catch (error) {
    console.error('[Followup] deleteFollowupConfig FAILED:', error.message);
    next(error);
  }
}

export {
  getFollowupConfig,
  saveFollowupConfig,
  listPendingFollowups,
  sendPendingFollowup,
  getOpenedContacts,
  getOpenedContactsForAll,
  sendSelectedFollowups,
  listFollowupConfigs,
  createFollowupConfig,
  updateFollowupConfig,
  deleteFollowupConfig,
};
