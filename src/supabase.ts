import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ||
  "https://novreeapdwjnpzflyiey.supabase.co";
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vdnJlZWFwZHdqbnB6Zmx5aWV5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3MzU3MDUsImV4cCI6MjEwMTMxMTcwNX0.740Rf8QsiSrLBEvZQ8vihY9mF7y2I3RQYc5XCVnnB_0";

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