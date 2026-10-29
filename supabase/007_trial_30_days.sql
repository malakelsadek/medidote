-- Run in the Supabase SQL Editor.
-- New accounts get a 1 month free period (was 7 days). Existing rows keep their date: see "Managing subscriptions by hand" in TODO.md to extend one.
alter table subscriptions alter column trial_ends_at set default now() + interval '30 days';
