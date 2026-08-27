import 'dotenv/config';
import { supabase } from './services/supabaseService.js';
import * as sequenceService from './services/sequenceService.js';

const detail = await sequenceService.getSequence('6df7f5d6-dac9-44cc-b721-99ff47d615f2');
for (const p of detail.steps_progress || []) {
  console.log(`step=${p.step.step_number} path=${p.path} eligible=${p.eligible} sent=${p.sent} opened=${p.opened} next=${JSON.stringify(p.next)} parent=${p.parent_label}`);
}