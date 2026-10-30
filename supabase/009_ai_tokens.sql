-- Run in the Supabase SQL Editor (before redeploying generate and admin).
-- Records the real tokens the AI used, per person per month, so the admin page shows true cost instead of a guess.
alter table usage add column if not exists input_tokens bigint not null default 0;
alter table usage add column if not exists output_tokens bigint not null default 0;

-- adds to the running totals; only the server (service_role) can call it
create or replace function public.add_ai_tokens(p_user uuid, p_month text, p_in bigint, p_out bigint) returns void
language sql security definer set search_path = '' as $$
  insert into public.usage (user_id, month, questions, input_tokens, output_tokens) values (p_user, p_month, 0, p_in, p_out)
  on conflict (user_id, month) do update set input_tokens = public.usage.input_tokens + p_in, output_tokens = public.usage.output_tokens + p_out;
$$;
revoke all on function public.add_ai_tokens(uuid, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.add_ai_tokens(uuid, text, bigint, bigint) to service_role;
