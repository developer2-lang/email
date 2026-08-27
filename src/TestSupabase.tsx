import { useEffect } from "react";
import { supabase } from "./supabase";

export default function TestSupabase() {
  useEffect(() => {
    async function test() {
      const { data, error } = await supabase
        .from("contacts")
        .select("*");

      console.log("Data:", data);
      console.log("Error:", error);
    }

    test();
  }, []);

  return <h2>Testing Supabase Connection...</h2>;
}