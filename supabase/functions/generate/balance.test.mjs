// Run: node --experimental-strip-types balance.test.mjs
import assert from "node:assert";
import { shuffleQ, lopsided } from "./balance.ts";

const mk = (answer, len) => ({ options: ["a", "b", "c", "d", "e"].map((c, i) => c.repeat(i === answer ? len : 20)), answer, why: ["w0", "w1", "w2", "w3", "w4"] });

// 1. shuffling keeps the right answer and its explanation attached, and spreads positions evenly even when the model always answers 0
const pos = [0, 0, 0, 0, 0];
for (let i = 0; i < 5000; i++) {
  const q = { options: ["right", "x", "y", "z", "w"], answer: 0, why: ["why right", "why x", "why y", "why z", "why w"] };
  const s = shuffleQ(q);
  assert.equal(s.options[s.answer], "right");
  assert.equal(s.why[s.answer], "why right");
  assert.equal(s.options.map((o) => o.length).sort().join(), q.options.map((o) => o.length).sort().join());
  pos[s.answer]++;
}
console.log("answer position spread over 5000 shuffles of always-A:", pos.join(" "));
assert(pos.every((n) => n > 900 && n < 1100), "positions should each be about 20%");

// 2. the length check: the typical bias (right answer far longer) is flagged, balanced questions are not
assert(lopsided(mk(2, 60)), "right answer 3x longer should be flagged");
assert(!lopsided(mk(2, 21)), "right answer about the same length should pass");
assert(!lopsided(mk(2, 24)), "20% longer is under the cap and should pass");
assert(lopsided(mk(2, 30)), "50% longer is over the 25% cap");
assert(lopsided(mk(0, 14)) === false, "right answer shorter than the rest should pass");
assert(lopsided({ options: ["a".repeat(60), "b".repeat(20), "c".repeat(20), "d".repeat(20), "e".repeat(20)], answer: 1, why: [] }), "a long wrong option is flagged too, so nothing stands out");
assert(!lopsided({ options: ["5-10%", "10-30%", "30-70%", "70-90%", "90-100%"], answer: 2, why: [] }), "short numeric options are exempt");
assert(!lopsided(mk(2, 12)), "right answer shorter should pass");

// 3. simulated batch from a model that writes the right answer ~40% longer: how many get flagged
let flagged = 0;
for (let i = 0; i < 1000; i++) flagged += lopsided(mk(i % 5, 28)) ? 1 : 0;
console.log("flagged of 1000 questions with a 40%-longer right answer:", flagged);
assert.equal(flagged, 1000);
console.log("ok");

// 4. the guide file: every example is valid, obeys the length cap, and the prompt text is built from it
import { readFileSync } from "node:fs";
import { rulesText, examplesText, buildSystem, manualPrompt } from "./guide.ts";
const guide = JSON.parse(readFileSync(new URL("./guide.json", import.meta.url), "utf8"));
assert(guide.rules.length >= 5 && guide.examples.length >= 3);
let longest = 0;
for (const e of guide.examples) {
  assert.equal(e.options.length, 5, e.topic);
  assert(e.answer >= 0 && e.answer < 5, e.topic);
  assert.equal(e.why.length, 5, e.topic + ": one explanation per option");
  assert(!lopsided({ options: e.options, answer: e.answer, why: e.why }), e.topic + ": example options break the length cap");
  const len = e.options.map((o) => o.length);
  longest += len[e.answer] === Math.max(...len) ? 1 : 0;
}
assert(longest <= guide.examples.length * 0.4, "examples must not teach the right answer is usually the longest: " + longest + " of " + guide.examples.length);
assert(rulesText(guide).includes("longest") && examplesText(guide).includes("Example 3") && buildSystem(guide).includes("evidence") && manualPrompt(guide, 5).includes("exactly 5 questions"));
console.log("guide ok:", guide.rules.length, "rules,", guide.examples.length, "examples");
