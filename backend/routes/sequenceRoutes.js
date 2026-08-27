/**
 * Sequence automation API routes.
 *
 * Mounted at /api/sequences in server.js.
 *
 *   GET    /api/sequences                List sequences (with step counts).
 *   GET    /api/sequences/:id            Sequence detail + steps.
 *   POST   /api/sequences                Create a sequence (starts as draft).
 *   PUT    /api/sequences/:id            Update sequence config.
 *   DELETE /api/sequences/:id            Delete a sequence (children cascade).
 *
 *   GET    /api/sequences/audiences      Audience options (from the DB).
 *
 *   POST   /api/sequences/:id/steps              Add a step.
 *   PUT    /api/sequences/:id/steps/:stepId      Update a step.
 *   DELETE /api/sequences/:id/steps/:stepId      Delete a step.
 *
 *   POST   /api/sequences/:id/activate   Activate (validates readiness).
 *   POST   /api/sequences/:id/pause      Pause.
 *
 *   GET    /api/sequences/:id/contacts   Enrolled contacts (canonical enrollments).
 *   GET    /api/sequences/:id/logs       Sent step logs.
 *   GET    /api/sequences/:id/recipients Eligible recipients + engagement
 *                                        (optional ?step_id for already-sent).
 *   POST   /api/sequences/:id/manual-send Send a step to selected recipients now.
 */
import express from 'express';
import * as controller from '../controllers/sequenceController.js';

const router = express.Router();

// Fixed routes FIRST — these must match before the /:id param routes.
router.get('/audiences', controller.listAudienceOptions);

// RESTful CRUD.
router.get('/', controller.listSequences);
router.post('/', controller.createSequence);
router.get('/:id', controller.getSequence);
router.put('/:id', controller.updateSequence);
router.delete('/:id', controller.deleteSequence);

// Steps.
router.post('/:id/steps', controller.createStep);
router.put('/:id/steps/:stepId', controller.updateStep);
router.delete('/:id/steps/:stepId', controller.deleteStep);

// Activate / pause.
router.post('/:id/activate', controller.activateSequence);
router.post('/:id/pause', controller.pauseSequence);

// Data.
router.get('/:id/contacts', controller.listSequenceContacts);
router.get('/:id/logs', controller.listSequenceLogs);
router.get('/:id/recipients', controller.listSequenceRecipients);
router.post('/:id/manual-send', controller.manualSendSequence);
router.get('/:id/branch-steps', controller.listBranchSteps);
router.put('/:id/branch-steps/:branchStepId', controller.updateBranchStep);
router.delete('/:id/branch-steps/:branchStepId', controller.deleteBranchStep);

// 405 for the wrong method on action-only paths.
router.post('/audiences', methodNotAllowed);
router.get('/:id/steps', methodNotAllowed);
router.get('/:id/activate', methodNotAllowed);
router.get('/:id/pause', methodNotAllowed);
router.post('/:id/recipients', methodNotAllowed);
router.get('/:id/manual-send', methodNotAllowed);

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
