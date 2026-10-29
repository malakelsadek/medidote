# Question quality check

Use this to review every batch of questions, whether it came from claude.ai or from the in-app AI. Keep the JSON file open beside the app so you can read each question's `evidence` line. The rules the AI follows live in `supabase/functions/generate/guide.json`; this page is how you check that it followed them.

## 1. Per question

### A. Automatic fails
If any of these is true, the question fails, however good the rest is.

1. **Wrong key.** The marked answer is not right, no option is right, or two options could be right.
2. **Not from the slides.** The `evidence` quote is not on the slide, or the slide does not support the answer.
3. **The stem gives it away.** It names the answer, says what the patient made or took when that is the answer, states the rule or formula needed, or copies the slide's own wording.
4. **Wrong source.** The slide number or file name does not match.

### B. Quality (yes or no for each)
A good question is a yes on all of them. Anything less gets rewritten.

- **Stem:** a reasoning question has 3 to 5 sentences, a realistic case with the findings and numbers needed, and exactly one clear question. A recall question has one or two sentences and one clear question. No "which is NOT".
- **Right type:** the kind of question fits the material: direct recall for a fact, definition or classification, multi-step reasoning (which may include recall) for a mechanism, finding or decision. Reasoning is favoured where the material allows. A reasoning question must not be answerable by word matching alone, and a recall question must not be answerable by elimination. No tiny details that differ between hospitals (storage temperature, shelf life, time windows). A calculation needs a thinking step, not just plugging a given rule into numbers.
- **Right difficulty:** a student who revised well gets it right about two times in three, and one who only memorised the headings can be caught.
- **Wrong options are real:** each could tempt a half-prepared student. None is absurd, impossible, overlapping, or a synonym of another.
- **Options match:** five options of the same kind in the same sentence shape. No grammar clue, no "all/none of the above".
- **Numbers:** in order, with units.
- **Explanations:** the first line says why the right one is right. Each wrong option says what it actually is and why it does not fit this case, and is itself accurate. The teaching point states the key idea.

### C. Three quick tests (about 20 seconds)
- **Cover the options.** Read only the stem. If you can name the answer, the stem gives it away.
- **Cover the stem.** If the options alone point at one answer (the most detailed, the odd one out), the options give it away.
- **Check the slide.** Find the evidence quote. If it does not say what the answer needs, fail the question.

## 2. Whole batch (for example 20 questions)

- **Length not favoured.** The right option is the longest in about 20% of questions (chance) and no more than 30%. Also check it is not the shortest too often. The import warns about the longest case.
- **No repeats.** Every concept gets a question before any concept gets a second one. A second question on the same concept is fine only from a different angle (mechanism, consequence, next step, difference, interpretation) with a different case and different options; a reworded copy fails. The AI saves each question's `concept` and `angle` so you can check this.
- **Count.** A batch can be shorter than you asked for: the app then says the slides support N good questions. That is correct, not a fault. Padding to reach the number is the fault.
- **Spread.** The questions cover the whole lecture, not one section.
- **Variety.** A mix of mechanism, consequence, next step, and difference between similar things.
- **Pass rate.** At least 80% of questions pass A and B, and 0 automatic fails. That is the bar before real students see them.
- **After launch.** The share of questions reported stays under about 3%. Read the `reports` table now and then and turn repeated problems into rules or examples in `guide.json`.

## 3. Score sheet (copy per batch)

| Q | Key right, one answer | Stem no give-away | Reasoning needed | Options plausible | Explanations accurate | Slide correct | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | pass / rewrite / drop |
| 2 | | | | | | | |

## 4. What to send back
For every question that fails, send the question plus one line saying why (for example "stem names the answer", "absurd option C", "too easy: wording copied from the slide"). Five or six of these teach the prompt more than anything else, and they become rules and examples in `guide.json`.

## 5. Ask Claude to review a batch
Use a **new claude.ai chat** (the chat that wrote the questions tends to approve its own work). Attach the lecture PDF and the deck's JSON file, then paste this:

```
Review the attached question deck (JSON) against the attached slides, using the rubric below. Do not rewrite any questions unless I ask.

Rubric:
- Automatic fails: wrong key or more than one defensible answer; evidence not on the slide; stem gives the answer away (names it, says what the patient made or took, states the rule or formula, copies the slide wording); wrong slide number or file.
- Quality (yes/no each): the question is the kind that best tests the material, either multi-step reasoning (which may include recall) with a 3 to 5 sentence realistic case for mechanisms, findings and decisions, or a short direct recall question (one or two sentences) for facts, definitions and classifications, and has one clear question; either way it is hard, with no answer by elimination or by matching wording; no tiny or practice-dependent details; a calculation needs more than plugging into a given rule; right difficulty (a student who revised well gets it right about 2 in 3); every wrong option is plausible (none absurd or overlapping); five options of the same kind and shape, no grammar clue; numbers in order with units; explanations are specific and accurate for every option.
- Batch: right option longest in no more than about 30% of questions and not shortest too often; every concept covered once before any concept repeats, and repeats only from a different angle with a different case (no reworded copies); the stem and answer follow from what the slides state, not an inference the writer added; no two questions share the same option list; the number of questions matches what was asked for (say how many were requested if you know it); whole lecture covered, including facts that are only recall; variety of question types; at least 80% pass.

Report in this exact format:
1. One summary line: how many pass, rewrite, drop.
2. A table: Q number | verdict | the first failing criterion | one-line reason.
3. For each question that is not a pass: the question number, the stem's first 10 words and a short explanation of the problem.
4. Batch checks: how often the right option is the longest, the shortest and in the middle; any repeated facts; coverage gaps.
5. Three prompt rules or examples that would stop the most common problems.
```

What you get back is a summary line, a verdict table with the reason for each failure, the failed questions, the batch numbers, and suggested rule changes. Paste that report to me and I turn it into rules and examples.

Limits:
- Without the PDF attached, Claude cannot check the evidence or the slide numbers.
- It can still miss a wrong key or judge difficulty differently from you, so spot-check about five questions yourself with the three quick tests in section 1C.
