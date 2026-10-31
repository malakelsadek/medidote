-- Run in the Supabase SQL Editor.
-- New accounts get a 1 week free period (was 1 month). Existing rows keep their date: see "Managing subscriptions by hand" in TODO.md to change one.
alter table subscriptions alter column trial_ends_at set default now() + interval '7 days';
