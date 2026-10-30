-- Run in the Supabase SQL Editor (before the updated 008_admin_stats.sql, then redeploy the admin function).
-- 1. payments: one row per payment received (the admin page records one when you mark someone Paid; Paymob can insert here later).
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete set null,   -- kept for the books even if the account is deleted
  amount_egp int not null,
  paid_at timestamptz not null default now(),
  source text not null default 'manual'
);
alter table payments enable row level security;   -- no policies: only the server (service_role) reads or writes it
grant select, insert on payments to service_role;

-- 2. every reported question with the reporter's email, for the report download on the admin page (excl = admin emails left out)
create or replace function public.admin_reports(excl text[] default '{}') returns jsonb
language sql security definer set search_path = '' stable as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
    select rp.created_at, u.email, rp.deck, rp.source, rp.stem, rp.options, rp.answer, rp.explanation, rp.reasons, rp.note
    from public.reports rp left join auth.users u on u.id = rp.user_id
    where lower(coalesce(u.email, '')) <> all (excl) limit 5000) x;
$$;
revoke all on function public.admin_reports(text[]) from public, anon, authenticated;
grant execute on function public.admin_reports(text[]) to service_role;
