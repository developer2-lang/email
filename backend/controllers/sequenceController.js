/**
 * Sequence route handlers.
 *
 * Thin controllers that validate nothing beyond routing, delegate to the
 * sequence service, and return the standard JSON envelope
 * ({ success, message, data }). Errors flow to the centralized handler.
 */
import * as sequenceService from '../services/sequenceService.js';

async function listSequences(req, res, next) {
  try {
    const data = await sequenceService.listSequences();
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Sequence] listSequences FAILED:', error.message);
    next(error);
  }
}

async function getSequence(req, res, next) {
  try {
    const data = await sequenceService.getSequence(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Sequence] getSequence FAILED:', error.message);
    next(error);
  }
}

async function createSequence(req, res, next) {
  try {
    const data = await sequenceService.createSequence(req.body || {});
    res.status(201).json({ success: true, message: 'Sequence created.', data });
  } catch (error) {
    console.error('[Sequence] createSequence FAILED:', error.message);
    next(error);
  }
}

async function updateSequence(req, res, next) {
  try {
    const data = await sequenceService.updateSequence(req.params.id, req.body || {});
    res.json({ success: true, message: 'Sequence updated.', data });
  } catch (error) {
    console.error('[Sequence] updateSequence FAILED:', error.message);
    next(error);
  }
}

async function deleteSequence(req, res, next) {
  try {
    await sequenceService.deleteSequence(req.params.id);
    res.json({ success: true, message: 'Sequence deleted.' });
  } catch (error) {
    console.error('[Sequence] deleteSequence FAILED:', error.message);
    next(error);
  }
}

async function listAudienceOptions(req, res, next) {
  try {
    const data = await sequenceService.listAudienceOptions();
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Sequence] listAudienceOptions FAILED:', error.message);
    next(error);
  }
}

async function listBranchSteps(req, res, next) {
  try {
    const data = await sequenceService.listBranchSteps(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Sequence] listBranchSteps FAILED:', error.message);
    next(error);
  }
}

async function updateBranchStep(req, res, next) {
  try {
    const data = await sequenceService.updateBranchStep(
      req.params.id,
      req.params.branchStepId,
      req.body || {}
    );
    res.json({ success: true, message: 'Branch step updated.', data });
  } catch (error) {
    console.error('[Sequence] updateBranchStep FAILED:', error.message);
    next(error);
  }
}

async function deleteBranchStep(req, res, next) {
  try {
    const data = await sequenceService.deleteBranchStep(req.params.id, req.params.branchStepId);
    res.json({ success: true, message: 'Branch step deleted.', data });
  } catch (error) {
    console.error('[Sequence] deleteBranchStep FAILED:', error.message);
    next(error);
  }
}

async function createStep(req, res, next) {
  try {
    const data = await sequenceService.createStep(req.params.id, req.body || {});
    res.status(201).json({ success: true, message: 'Step created.', data });
  } catch (error) {
    console.error('[Sequence] createStep FAILED:', error.message);
    next(error);
  }
}

async function updateStep(req, res, next) {
  try {
    const data = await sequenceService.updateStep(
      req.params.id,
      req.params.stepId,
      req.body || {}
    );
    res.json({ success: true, message: 'Step updated.', data });
  } catch (error) {
    console.error('[Sequence] updateStep FAILED:', error.message);
    next(error);
  }
}

async function deleteStep(req, res, next) {
  try {
    const data = await sequenceService.deleteStep(req.params.id, req.params.stepId, {
      cascade: req.query && req.query.cascade === 'true',
    });
    res.json({ success: true, message: 'Step deleted.', data });
  } catch (error) {
    console.error('[Sequence] deleteStep FAILED:', error.message);
    next(error);
  }
}

async function activateSequence(req, res, next) {
  try {
    const data = await sequenceService.activateSequence(req.params.id);
    res.json({ success: true, message: 'Sequence activated.', data });
  } catch (error) {
    console.error('[Sequence] activateSequence FAILED:', error.message);
    next(error);
  }
}

async function pauseSequence(req, res, next) {
  try {
    const data = await sequenceService.pauseSequence(req.params.id);
    res.json({ success: true, message: 'Sequence paused.', data });
  } catch (error) {
    console.error('[Sequence] pauseSequence FAILED:', error.message);
    next(error);
  }
}

async function listSequenceContacts(req, res, next) {
  try {
    const data = await sequenceService.listSequenceContacts(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Sequence] listSequenceContacts FAILED:', error.message);
    next(error);
  }
}

async function listSequenceLogs(req, res, next) {
  try {
    const data = await sequenceService.listSequenceLogs(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Sequence] listSequenceLogs FAILED:', error.message);
    next(error);
  }
}

async function listSequenceRecipients(req, res, next) {
  try {
    const data = await sequenceService.listSequenceRecipients(
      req.params.id,
      req.query && req.query.step_id
    );
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Sequence] listSequenceRecipients FAILED:', error.message);
    next(error);
  }
}

async function manualSendSequence(req, res, next) {
  try {
    const data = await sequenceService.manualSendSequence(req.params.id, req.body || {});
    res.json({ success: true, message: 'Manual send completed.', data });
  } catch (error) {
    console.error('[Sequence] manualSendSequence FAILED:', error.message);
    next(error);
  }
}

export {
  listSequences,
  getSequence,
  createSequence,
  updateSequence,
  deleteSequence,
  listAudienceOptions,
  listBranchSteps,
  updateBranchStep,
  deleteBranchStep,
  createStep,
  updateStep,
  deleteStep,
  activateSequence,
  pauseSequence,
  listSequenceContacts,
  listSequenceLogs,
  listSequenceRecipients,
  manualSendSequence,
};
