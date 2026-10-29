// Edge Function "admin": the numbers for the admin dashboard in the app. Only the people listed in the ADMIN_EMAILS secret can call it.
// Secrets needed (Edge Functions -> Secrets): ADMIN_EMAILS (comma separated, for example "you@gmail.com,other@gmail.com").
// SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY are provided automatically. Needs supabase/008_admin_stats.sql to have been run.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: who } = await user.auth.getUser();
    const admins = (Deno.env.get("ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const email = who.user?.email?.toLowerCase();
    // the check that matters: the server decides, whatever the app shows
    if (!who.user || !who.user.email_confirmed_at || !email || !admins.includes(email)) return reply({ error: "Not allowed." }, 403);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await admin.rpc("admin_stats");
    if (error) throw error;
    return reply(data);
  } catch (e) {
    console.error(e);
    return reply({ error: "Could not load the dashboard." }, 500);
  }
});
