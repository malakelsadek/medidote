// Edge Function "admin": the numbers for the admin dashboard in the app. Only the people listed in the ADMIN_EMAILS secret can call it.
// Secrets needed (Edge Functions -> Secrets): ADMIN_EMAILS (comma separated, for example "you@gmail.com,other@gmail.com").
// SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY are provided automatically. Needs supabase/008_admin_stats.sql to have been run.
import { createClient } from "npm:@supabase/supabase-js@2";

const PLAN_EGP = 500;   // keep in step with PLAN.price in app.js
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
    if (req.method === "POST") {   // change someone's plan by hand
      const { action, user_id, plan, days, record } = await req.json();
      if (action === "reports") {   // every report, for the download on the admin page
        const { data: all, error: e1 } = await admin.rpc("admin_reports", { excl: admins });
        if (e1) throw e1;
        return reply(all);
      }
      if (action === "delete_reports") {
        const { error: e1 } = await admin.from("reports").delete().gte("created_at", "1970-01-01");
        if (e1) throw e1;
        return reply({ ok: true });
      }
      const t = new Date(Date.now() + Math.max(0, Math.min(3650, Math.floor(Number(days) || 0))) * 864e5).toISOString(), now = new Date().toISOString();
      const row = plan === "paid" ? { status: "active", current_period_end: t, provider: record ? "manual" : "gift" }
        : plan === "trial" ? { status: "trial", trial_ends_at: t }
        : plan === "free" ? { status: "canceled", trial_ends_at: now, current_period_end: now } : null;
      if (action !== "set_plan" || !row || !/^[0-9a-f-]{36}$/i.test(String(user_id))) return reply({ error: "Bad request." }, 400);
      const { error: e2 } = await admin.from("subscriptions").upsert({ user_id, ...row }, { onConflict: "user_id" });
      if (e2) throw e2;
      if (plan === "paid" && record) {   // money received: add it to the books
        const { error: e3 } = await admin.from("payments").insert({ user_id, amount_egp: PLAN_EGP });
        if (e3) throw e3;
      }
      return reply({ ok: true });
    }
    const { data, error } = await admin.rpc("admin_stats", { excl: admins });
    if (error) throw error;
    return reply(data);
  } catch (e) {
    console.error(e);
    return reply({ error: "Could not load the dashboard." }, 500);
  }
});
