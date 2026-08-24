import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// These are inlined from the root `.env` at build time (Vite only exposes
// variables prefixed with VITE_). If they are missing, the running bundle was
// built/started before the env was available — set them in `.env` and
// RESTART the dev server or REBUILD (`npm run build`).
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase environment variables (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). " +
      "Add them to the root .env file and restart the dev server or rebuild the app."
  );
}

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey
);