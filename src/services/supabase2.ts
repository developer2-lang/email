/**
 * `supabase2` — real Supabase client.
 *
 * Uses the same env vars as src/supabase.ts so there is a single source of
 * truth for the project URL and anon key.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase2 = createClient(supabaseUrl, supabaseAnonKey);

// Re-export a compatible SupabaseResult type used by older callers.
export interface SupabaseResult {
  data: any;
  error: { message: string } | null;
}
