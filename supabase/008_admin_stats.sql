-- Run in the Supabase SQL Editor.
-- One function that gathers everything the admin dashboard shows. Only the server (service_role) can run it:
-- the "admin" Edge Function calls it after checking the caller's email is in the ADMIN_EMAILS secret. Browsers can never call it.

create or replace function public.admin_stats() returns jsonb
language plpgsql security definer set search_path = '' stable as $$
declare
  ms7 bigint := (extract(epoch from now() - interval '7 days') * 1000)::bigint;
  ms30 bigint := (extract(epoch from now() - interval '30 days') * 1000)::bigint;
  mon text := to_char(now(), 'YYYY-MM');
  result jsonb;
begin
  with
  plans as (
    select s.user_id,
      case when s.status = 'active' and s.current_period_end > now() then 'active'
           when s.trial_ends_at > now() then 'trial'
           else 'expired' end as k,
      s.status, s.trial_ends_at, s.current_period_end
    from public.subscriptions s),
  last_study as (select user_id, max(at) as at from public.review_logs group by user_id),
  ai_now as (select user_id, questions from public.usage where month = mon),
  deck_n as (select user_id, count(*) as n from public.decks group by user_id),
  q_n as (select user_id, count(*) as n, count(*) filter (where extra ->> 'source' = 'ai') as ai from public.questions group by user_id),
  people as (
    select u.id, u.email, u.created_at, u.last_sign_in_at,
           coalesce(p.k, 'trial') as plan, p.status, p.trial_ends_at, p.current_period_end,
           coalesce(a.questions, 0) as ai_month, coalesce(d.n, 0) as decks, coalesce(q.n, 0) as questions,
           coalesce(q.ai, 0) as ai_questions, l.at as last_study
    from auth.users u
      left join plans p on p.user_id = u.id
      left join ai_now a on a.user_id = u.id
      left join deck_n d on d.user_id = u.id
      left join q_n q on q.user_id = u.id
      left join last_study l on l.user_id = u.id)
  select jsonb_build_object(
    'generated_at', now(),
    'users_total', (select count(*) from people),
    'new_7d', (select count(*) from people where created_at > now() - interval '7 days'),
    'new_30d', (select count(*) from people where created_at > now() - interval '30 days'),
    'active_7d', (select count(distinct user_id) from public.review_logs where at > ms7),
    'active_30d', (select count(distinct user_id) from public.review_logs where at > ms30),
    'plans', (select coalesce(jsonb_object_agg(plan, n), '{}'::jsonb) from (select plan, count(*) as n from people group by plan) x),
    'canceled', (select count(*) from people where status = 'canceled'),
    'signups_weekly', (select coalesce(jsonb_agg(jsonb_build_object('week', w, 'n', n) order by w), '[]'::jsonb) from (
        select g::date as w, (select count(*) from people where created_at >= g and created_at < g + interval '7 days') as n
        from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '7 days') g) s),
    'ai_this_month', (select coalesce(sum(questions), 0) from public.usage where month = mon),
    'ai_generating_users', (select count(*) from public.usage where month = mon and questions > 0),
    'ai_monthly', (select coalesce(jsonb_agg(jsonb_build_object('month', month, 'n', n) order by month), '[]'::jsonb) from (
        select month, sum(questions) as n from public.usage group by month order by month desc limit 6) m),
    'decks', (select count(*) from public.decks),
    'questions', (select count(*) from public.questions),
    'ai_questions', (select count(*) from public.questions where extra ->> 'source' = 'ai'),
    'slide_files', (select count(*) from public.slide_files),
    'reports_total', (select count(*) from public.reports),
    'reports_7d', (select count(*) from public.reports where created_at > now() - interval '7 days'),
    'users', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from people order by created_at desc limit 300) x),
    'reports', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select rp.created_at, u.email, rp.deck, rp.source, rp.stem, rp.reasons, rp.note
        from public.reports rp left join auth.users u on u.id = rp.user_id order by rp.created_at desc limit 50) x)
  ) into result;
  return result;
end $$;

revoke all on function public.admin_stats() from public, anon, authenticated;
grant execute on function public.admin_stats() to service_role;
