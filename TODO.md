# ankidote: progress and to-do

Last updated: 2026-10-29. Nothing below is on the live site yet (commits are local).

## Launch plan
- AI generator only: the copy-a-prompt Guide is gone; **importing a .json deck stays** (Data page, Add a deck)
- Testing: my own Claude key. Launch: every new user gets **1 month free** on a limited AI allowance, then subscribes (ankidote Pro, EGP 500 a month)
- First: streamline the app and get question quality right

## Done

**Setup and accounts**
- [x] Supabase project (Data API on, auto RLS on), Claude API workspace `ankidote` (key kept private), Cloudflare site (`ankidote.elsadek-malak.workers.dev`), Google login, Supabase URL and Redirect URLs

**Backend and app**
- [x] Per-user database (`supabase/schema.sql`), sign-in (Google or emailed link), cards, folders, history and settings stored in the account
- [x] Slides: PDF to private storage, page text saved, cover image; Slides tab (tiles, deck filter, upload to one or more decks, multi-select delete); slides belong to a deck, renaming a deck keeps them, deleting a deck or folder deletes its slides
- [x] Generate with AI tab (pick deck, files, page range, 10-50 questions); Claude Sonnet 5.5 writes case-study questions with an explanation for every option and the source slides; picture slides (tables, diagrams, charts) are shown to the AI
- [x] Plan: free period (see below), "ankidote Pro" EGP 500 a month, 400 AI questions a month, Subscription page (online payment later with Paymob, no InstaPay)
- [x] Subscription shows "Coming soon" (`COMING_SOON` in app.js); Generate is open to everyone
- [x] Community tab placeholder ("Coming soon")
- [x] Privacy policy (`legal/privacy.html`, name and email filled in)
- [x] Add a deck imports the .json and uploads its PDFs in one go; imported questions link to slides by `slide` (one number or a list) and `file`

**Study screen**
- [x] Slide beside the question (setting: after answering, before, both, off; several slides get buttons, tap to open the viewer); the explanation for the right option and each wrong option sits under that option; rating card (Again / Hard / Good / Easy, Next) pinned bottom-right on wide screens, result card above the bottom bar; bar positions follow the sidebar
- [x] "AI can make mistakes" note and a Flag it button (saved on the card as `flagged`)
- [x] Click "pop" sound and a sound fix for the iPad mute switch and interruptions (needs an iPad re-test)

**Layout and polish**
- [x] Interface size is saved per device (this browser only), not in the account; walkthrough survives zoom; More tab when zoomed in; Settings in headed sections; Stats under Study; Account, Subscription, Settings and Minimize pinned at the bottom of the sidebar
- [x] Phone: pinned top bar, matching status bar colour, slim answer bar, splash is just the logo, tab bar fixed, "due" card layouts; Guide is now a visual "Install it as an app"
- [x] The app always loads fresh code (service worker checks the server)

**Question quality**
- [x] One guide file, `supabase/functions/generate/guide.json` (rules and examples), used by the generator. Options are shuffled in code, the right answer is not allowed to be the longest (no option over 125% of the average of the others, one retry, import warning), and a blind second call drops any question where it disagrees with the key
- [x] 2026-10-29: Removed the copy-a-prompt steps from the Guide page (prompts, question count picker, walkthrough step, `GUIDE`/`PROMPTS` code in app.js). Import is unchanged
- [x] 2026-10-29: Rewrote the guide: 7 short rules (correct first, case-study stem, application not recall, right option never the longest, near-miss wrong options, things to avoid, spread and variety) and a shorter system prompt
- [x] 2026-10-29: Backups removed (export, restore, reminders, banner, Settings section); deck .json import and slide upload stay
- [x] 2026-10-29: Stats revamp: Keep missing now lists the decks you keep missing with a Study button each (and Study all missed); new cards: Study days heat map (13 weeks), Memory strength, When you study best, Deck progress. Needs a look in the browser
- [x] 2026-10-29: Stats layout follows the width of the page itself (container queries, so it also follows interface size and the sidebar): 1 column on phones, 2 columns from about 620px, tiles 4 across from about 860px; progress and tiles always full width; Last 14 days is wide and Study days narrow with square cells, Memory strength sits beside Coming up; with a minimized sidebar the page uses the full width (3 cards per row from about 1250px)
- [x] 2026-10-29: Folder colours: 12 colours plus the theme colour, picked when creating a folder or from Edit, then tap the folder (rename badge); the colour shows on the folder tile and on its decks. Stored with the folder list (`fm`)
- [x] 2026-10-29: Add a deck popup redone (pick the .json first, see its name and question count, then the slides it refers to: already in your account / attached now / missing) and the Data tab removed. Slides and decks connect on their own: slide files already in the account are linked to the new deck without uploading again, and uploading slides later ticks the decks whose questions name those files. Needs a real test with a deck and PDFs

## To do next

### Admin dashboard (do later)
- [ ] Set it up and look at it: run `supabase/008_admin_stats.sql`, deploy the `admin` function (`supabase/functions/admin/index.ts`), add the `ADMIN_EMAILS` secret, add `http://localhost:8001` to the Supabase Redirect URLs, then double-click `start-admin.bat` in the `ankidote-admin` folder. Check phone width and fix anything off
- [ ] Later: put it behind Cloudflare Access if it is ever put online, add real cost once the Claude Console shows it, and add more numbers as you find you need them (retention, drop-off, income once Paymob exists)

### Test the AI (needs a few dollars of credit)
- [ ] Run `supabase functions deploy generate` (guide.json, balance.ts, guide.ts, pdfpages.ts must be deployed with it)
- [ ] Confirm the `ANTHROPIC_API_KEY` secret exists, add $5 credit in the Claude Console
- [ ] Re-upload slides uploaded before covers existed (they show an icon)
- [ ] Generate 10 questions from a small PDF; if it fails read Edge Functions, generate, Logs
- [ ] Read 20+ questions with the new guide: case-study? hard enough? right answer correct? right answer not the longest? If not, send me examples and I add them to `guide.json`
- [ ] Check real cost per question in the Console Usage page (estimate $0.01-0.015, more now with the blind check), then fix the price and the 400 cap
- [ ] Optional: compare Haiku 5.5 vs Sonnet 5.5 blind on 3 decks; switch the `MODEL` line if Haiku is good enough
- [ ] Test the trial limits and the 400 cap (set `status` to `active` in `subscriptions` to test paid)
- [ ] Study screen check with real AI questions (slide beside the question, per-option explanations)

### Change the trial to match the launch plan
- [x] 2026-10-29: Generate with AI is open to everyone. Free period = 1 month for new accounts (`007_trial_30_days.sql`) with 100 AI questions a month (`TRIAL_QUESTIONS` in `generate/index.ts` and app.js, keep them equal); subscribers keep 400. Tighten the free allowance when paid plans start
- [ ] Run `supabase/006_reports.sql` and `supabase/007_trial_30_days.sql` and redeploy `generate`. Accounts made before this keep their 7-day trial: extend them with the restart-trial SQL below



### Costs (what I need to pay for)
- [ ] **Domain**: $16-20 a year. Needed first (Google publishing needs a real home page and legal links on your own domain)
- [ ] **Supabase Pro**: $25 a month. Free plan pauses after a week idle, has no daily backups and 1 GB of storage
- [ ] **Claude API credit**: $5 to start testing, then pay as you go. Rough guess $0.012 per question, so a free-period student using all 100 questions costs about $1.20 and a paying student's 400 questions about $5. Check the real figure in the Claude Console, Usage, and set a monthly spend limit (start $100)
- [ ] **Supabase custom auth domain** (fixes the odd `...supabase.co` link on the sign-in screen): about $10 a month, check current pricing. Needs Pro and my own domain
- [ ] **Email sender for sign-in links**: Supabase's built-in sender allows only a few emails an hour, so use a custom one such as Resend or Brevo (free plans cover this size, about $0)
- Free: Cloudflare hosting and a custom domain on it, publishing the Google login (only name, email and picture are asked for)
- Later: Apple Developer Program $99 a year (App Store); Paymob charges a fee per payment, check when applying
- Rough first month: about $45-65 fixed ($25 Supabase + $10 custom auth domain + $1.50 domain + $5-10 Claude) plus Claude cost per student

### Before the first real users
- [ ] Domain bought and pointed at the site
- [x] 2026-10-29: Terms page (`legal/terms.html`) written, linked from sign-in and Settings; privacy policy cleaned up (no Data page export, picture slides, question reports, Paymob). Have a lawyer read both before launch. Both pages now live in the `legal` folder
- [x] 2026-10-29: "Report it" on every question (reasons and a note, saved to the `reports` table; read them in the Supabase Table Editor). Replaces Flag it
- [x] 2026-10-29: Sign-in page redone: brand panel with what the app does and the free month beside the sign-in card (stacked on phones), email check and Enter key
- [x] 2026-10-29: A reported question is hidden from studying and stats; Settings has a Reported questions row that opens a page listing them; tap one to open it (question, options, marked answer, explanation) and Restore it
- [x] 2026-10-29: Generate tab rebuilt: 1 slides (from my slides, or upload new), 2 deck (existing or new), folder (new deck only), how many questions (1 to 100, default 30), one big Generate button, and cards for your decks with Generate more. Big slide sets are split into reads of 60 pages and the count shared out by pages. The button needs credit in the Claude account to work
- [x] 2026-10-29: Generate tab layout checked in a real browser at phone, tablet and desktop widths: slide picker is compact rows (cover, title, deck, tick), the form is two columns when the page is wide (slides left, deck / count / button right), one column otherwise, Generate more cards sit in a grid
- [x] 2026-10-29: Generate: bigger step titles, shorter notes, and a new deck can be named Auto (from the slide file title, made unique) or typed
- [x] 2026-10-29: Interface size (zoom) is now per device: it is kept in this browser only and no longer synced through the account, so a phone, an iPad and a laptop can each have their own size
- [x] 2026-10-29: Scrollbars restyled app-wide: thin, rounded, theme colours, no white track or arrows
- [x] 2026-10-29: Admin dashboard, kept OUT of the app and the repo: a separate private page in `ankidote-admin` (a folder next to this project, not in git, never uploaded with the app). Double-click `start-admin.bat` to open it at http://localhost:8001. Tiles (users, active, paying, AI questions and estimated cost), new users per week, plans, AI use per month, content counts, a searchable user table and the latest reports. Data comes from `supabase/008_admin_stats.sql` through the `admin` Edge Function, which refuses anyone not in its `ADMIN_EMAILS` secret. To switch on: run 008, deploy `supabase/functions/admin/index.ts`, add the `ADMIN_EMAILS` secret, add `http://localhost:8001` to the Supabase Redirect URLs. Needs a look in the browser
- [x] 2026-10-29: Service worker no longer tries to cache POST requests (it caused "Failed to execute put on Cache" errors on every AI call)
- [x] 2026-10-29: `node supabase/functions/generate/build-single.mjs` bundles the whole function into one file, `supabase/paste-into-dashboard/generate.ts`, for pasting into the Supabase dashboard (Edge Functions, generate, Code, Deploy updates). Run it again after any change to the function files
- [x] 2026-10-29: Prompt: one builder (`generate/guide.ts`) feeds both the AI function and a copy-paste prompt for testing in claude.ai. Run `node supabase/functions/generate/prompt.mjs 30` (30 questions) or add `| clip` to copy it, attach your PDF in claude.ai, paste, save the reply as .json, then Add a deck. Each question now starts with an `evidence` quote from the slides (kept on the card), and the model re-solves each question before returning it
- [x] 2026-10-29: Changes after review: rule 2 is now 3-5 sentences; the length check and blind check are switched off (`SELF_CHECKS = false` in `generate/index.ts`, one switch turns both back on) until the prompt is tested; shuffle proven by `shuffle.test.mjs` (right answer and every explanation stay matched, generator and import); the import warning is now a clear "This deck could be biased" message; `node supabase/functions/generate/prompt.mjs ai` prints the exact system prompt the AI uses
- [x] 2026-10-29: Length rule changed: the right option is allowed to be the longest (or shortest) sometimes; it just must not be longer or more specific by habit. Examples test now allows up to 40% longest. First manual batch (20 questions): all keys and slide numbers right, 7 passed, 13 failed on difficulty and style (stems that name the answer or hand over the rule, absurd options, tiny details, too-easy recall); proposed rule changes are waiting for a yes
- [x] 2026-10-29: Rules added from the first manual batch review: the stem must not hand over the answer, the method or the slide wording; calculations need a reasoning step; no tiny or practice-dependent details; no absurd wrong options; never test the same fact twice; explanations must be accurate; the re-solve check now also asks whether the stem gives the answer away. Next: generate a fresh batch with the new prompt and review it again
- [x] 2026-10-29: Second manual batch (endocrine, 10 questions): 7 pass, 3 rewrite, 0 drop. Rules added: one "normal finding" sentence must not rule out several wrong options at once, distractors for "which gland or structure" questions stay in the same plausible region, list the topics and cover each major one before going deeper, and a spot-check for stems that only describe one slide bullet. Noted for next time: the right option was the shortest in 2 of 10 (fine, but watch it), Q2 and Q10 repeat the ACTH fact, and the pancreas, ovaries and most adrenal and thyroid functions were never tested
- [x] 2026-10-29: The sidebar entry for the plan page now reads ANKIDOTE+ (the page itself and the More list still say Subscription)
- [x] 2026-10-29: Looking back at an answered question now keeps the slide beside it and the Report it link, with a plain verdict card instead of the rating buttons (Again / Hard / Good / Easy)
- [x] 2026-10-29: `QUALITY-CHECK.md` added: a rubric for reviewing every batch (automatic fails, quality yes/no list, three quick tests, whole-batch checks, a score sheet and what to send back). Section 5 is a ready prompt for asking Claude to review a batch in a fixed report format
- [x] 2026-10-29: Examples from `examples-screenshots`: four with an answer shown in the screenshot are in `guide.json` (7 examples in all, used by the AI function and the manual prompt). The four with no answer shown (ganglionic blocker, pelvic splanchnic nerves, L5 dorsal root, white ramus) are kept under `unverified_examples` with `answer: null` and are never sent to the AI; confirm each answer, then move it into `examples`
- [x] 2026-10-29: Upload slides and Add a deck are both two steps now (Upload: 1 choose PDFs, 2 choose decks in a searchable list grouped by folder, with decks that mention the files already ticked; Add a deck: 1 deck file and folder, 2 slides). The last step can be skipped: slides with no deck go to an "Unsorted slides" deck and are picked up when a deck that mentions them is imported
- [x] 2026-10-29: Slides page revamped: one dropdown filters by folder or deck, grouping is All (a flat list, no headings) / By deck / By folder, and layout is Tiles or List (cover image plus a large title); choices are remembered on the device
- [x] 2026-10-29: Added `test-blood-components.json` (20 questions from the Blood components and blood groups lecture, each with evidence, slide and file) for testing import and the question rules
- [x] 2026-10-29: Added `test-decks/test-endocrine-intro.json` (10 questions from the Introduction to endocrine and reproduction lecture; the deck only supports 10 good ones) for testing import and the stricter question rules
- [x] 2026-10-29: Added `test-decks/test-significance-testing.json` (8 questions from the Significance Testing lecture; the deck is one topic so 8 good ones, not 20) for testing import and the newest question rules
- [ ] Read the reports now and then and turn repeated problems into examples in `guide.json`
- [ ] Supabase Pro (about $25 a month), check backups are on. Free plan limits: 1 GB storage (about 6-10 students), 5 GB egress a month, 500 MB database, pauses after 1 week idle, no daily backups. Pro: 100 GB storage, 250 GB egress, 8 GB database
- [ ] Claude Console spend limit (start $100 a month) with an alert
- [ ] Delete a deck / delete account in the app (Apple needs account deletion)
- [ ] Google sign-in: decide the route. Testing (add up to 100 classmate emails by hand under Audience, Test users; logins expire after about 7 days) or Publish app (needs domain, privacy and terms pages, Branding filled in; required past 100 people). The sign-in screen shows "supabase.co" until Branding is set (free) or a paid Supabase custom auth domain is used
- [ ] Push to the live site: confirm the live address is in Supabase Redirect URLs and Google JavaScript origins, sign in on the iPad
- [ ] Test with 5-10 classmates for a week
- [ ] Offline study (needs a connection now)
- [ ] Order: domain, terms, Branding and Publish, Supabase Pro, Claude spend limit, account deletion, live push, classmate test, then payments and the App Store

### Payments (EGP)
- Decision: web app uses **Paymob**; App Store in-app subscriptions later (Apple requires its own billing in the iOS app)
- [ ] Apply for a Paymob merchant account (ask: what an individual needs, card and wallet fees, saved-card recurring billing, payout time, refunds by API)
- [ ] Checkout plus a webhook function that sets `status = 'active'` and `current_period_end`
- [ ] Wire the Subscribe button and a Manage/cancel flow; refund and cancellation policy on the site
- Until then: switch testers to `active` by hand (below)

### Ideas
- [ ] Difficulty check (later): a second AI call that reads only the question stem and asks "does this stem give the answer away, or is it answerable without the slides?". The blind check (`SELF_CHECKS` in `generate/index.ts`, off for now) only tests whether the answer key is right, not whether the question is too easy, so this would catch stems that hand over the answer. Only worth adding if the prompt rules alone do not fix too-easy questions
- [ ] Question quality: editing so a wrong question can be corrected
- [ ] Deck creation in one place: AI, community import, or by hand
- [ ] Explainer: link to the slide plus a better explanation, maybe voice or a character
- [ ] Community tab: share and import decks and whole folders
- [ ] Vibration on taps (light), wrong answer (stronger), session done (pattern), with a setting. `navigator.vibrate` works on Android, not iOS Safari; iPad needs Capacitor haptics
- [ ] Owner-only dashboard (outside the app): subscribed / unsubscribed, money, feature requests, member activity

### Demo video
- [ ] Script (60-90 s): problem, upload slides, generate, every option explained, source slide, stats
- [ ] Record on iPad and desktop with a demo account and slides you may show
- [ ] Motion graphics (intro, title cards, callouts, outro) written as code, e.g. Remotion, combined with screen recordings
- [ ] Captions, 1080p, unlisted on YouTube/Vimeo, a 15-30 s cut for the App Store

### App Store (later)
- [ ] Apple Developer Program ($99 a year), Sign in with Apple (required with Google login)
- [ ] Wrap with Capacitor, test with TestFlight, at least one native touch (e.g. study reminders)
- [ ] Icon, screenshots, description, privacy labels, in-app subscription; submit and fix review flags

## SQL files, run in this order in Supabase (SQL Editor)
`supabase/schema.sql`, `002_storage.sql`, `003_usage_grants.sql`, `004_subscriptions.sql`, `005_usage_questions.sql`, `006_reports.sql` and `007_trial_30_days.sql`

## Managing subscriptions by hand (until payments are automatic)

One row per user in `subscriptions` (Table Editor, or the SQL Editor). Replace `person@example.com` with their sign-in email. Users can only read their own row.

- `status`: `trial`, `active` or `canceled`. `current_period_end`: paid access lasts until then. `trial_ends_at`: end of the free trial. `provider`: `manual` (later `paymob`)
- **Plan:** active = `status` is `active` and `current_period_end` is in the future; trial = otherwise, `trial_ends_at` in the future; free = anything else (decks, slides, studying, stats are always free). Changes show after a reload
- Subscription says "Coming soon" (`COMING_SOON` in app.js). Status changes still decide what Generate allows: 100 questions a month on the free period, 400 when active

```sql
-- find a user / see everyone
select id, email from auth.users where email = 'person@example.com';
select u.email, s.status, s.trial_ends_at, s.current_period_end, s.provider
from subscriptions s join auth.users u on u.id = s.user_id order by u.email;

-- activate (one month from now)
update subscriptions set status = 'active', current_period_end = now() + interval '1 month', provider = 'manual'
where user_id = (select id from auth.users where email = 'person@example.com');

-- renew (adds a month to the time they have left)
update subscriptions set status = 'active', current_period_end = greatest(coalesce(current_period_end, now()), now()) + interval '1 month', provider = 'manual'
where user_id = (select id from auth.users where email = 'person@example.com');

-- cancel at once (or do nothing to let them finish what they paid for)
update subscriptions set status = 'canceled'
where user_id = (select id from auth.users where email = 'person@example.com');

-- restart the free trial
update subscriptions set status = 'trial', trial_ends_at = now() + interval '30 days'
where user_id = (select id from auth.users where email = 'person@example.com');
```

The Paymob webhook will later set `status = 'active'` and `current_period_end` itself, with `provider = 'paymob'`.

## Known limits and notes
- Slides live in the account and belong to a deck. Old device-only PDFs move into the account on the next start; one over 50 MB stays on the device. Supabase free uploads are limited to 50 MB per PDF
- Folders are stored as one settings row (`fm`), not in the `folders` table yet
- The function writes at most 10 questions per call (time limit); the app calls it repeatedly. It reads at most 60 slide pages per call; image-only slides are sent to the AI as pictures (up to 20 per call)
- Never put the Claude API key, the Supabase `service_role` key or any `#access_token=` address in the repo or in chat
