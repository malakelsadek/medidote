// Edge Function "delete-account": the signed-in person deletes their own account, from Settings in the app.
// Removes their slide PDFs and covers from storage, then the auth user; every table row (decks, questions, review logs, slides,
// usage, subscription, reports, settings) goes with it because they all reference auth.users "on delete cascade".
// SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY are provided automatically. No other secrets needed.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: who } = await user.auth.getUser();
    if (!who.user) return reply({ error: "Sign in first." }, 401);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const id = who.user.id;
    // everything stored under their folder (PDFs and cover images), a page of up to 1000 at a time
    for (let i = 0; i < 20; i++) {
      const { data: files, error } = await admin.storage.from("slides").list(id, { limit: 1000 });
      if (error) throw error;
      if (!files?.length) break;
      const { error: e2 } = await admin.storage.from("slides").remove(files.map((f) => `${id}/${f.name}`));
      if (e2) throw e2;
    }
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
    return reply({ ok: true });
  } catch (e) {
    console.error(e);
    return reply({ error: "Could not delete the account." }, 500);
  }
});
