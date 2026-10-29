-- Run in the Supabase SQL Editor.
-- "Report a bad question" on the study screen. Users can add and read their own reports; you read them all in the Table Editor.
create table reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  deck text,
  question_key text,
  source text,                 -- 'ai' or 'imported'
  stem text not null,
  options jsonb,
  answer int,
  explanation text,
  reasons text[] not null default '{}',
  note text
);

alter table reports enable row level security;
grant select, insert on reports to authenticated;
create policy "own reports insert" on reports for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own reports read" on reports for select to authenticated using ((select auth.uid()) = user_id);
