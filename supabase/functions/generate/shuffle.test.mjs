// Run: node supabase/functions/generate/shuffle.test.mjs
// Shuffling must never separate an option from the fact that it is the right one, or from its explanation.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { shuffleQ } from "./balance.ts";

const L = "ABCDEFGH";
const rand = (n) => Math.floor(Math.random() * n);

// 1. the generator's shuffle (index.ts): options, "why" and the answer index move together
for (let n = 0; n < 3000; n++) {
  const k = 2 + rand(7), options = Array.from({ length: k }, (_, i) => `option ${i}`), answer = rand(k);
  const s = shuffleQ({ options, answer, why: options.map((o) => `why ${o}`) });
  assert.strictEqual(s.options[s.answer], options[answer], "right answer moved away from its index");
  s.options.forEach((o, i) => assert.strictEqual(s.why[i], `why ${o}`, "explanation no longer matches its option"));
  assert.deepStrictEqual([...s.options].sort(), [...options].sort(), "an option was lost or duplicated");
}

// 2. the import shuffle (app.js): same checks, plus the "A: reason" lines in the explanation are re-lettered
const src = readFileSync(new URL("../../../js/app.js", import.meta.url), "utf8");
const from = src.indexOf("const hash = "), mid = src.indexOf("const shuffleOptions = q => {"), to = src.indexOf("let lastDeck = null");
assert(from >= 0 && mid > from && to > mid, "could not find the shuffle code in app.js");
const { hash, shuffleOptions } = new Function(src.slice(from, src.indexOf("\n", from)) + "\n" + src.slice(mid, to) + "\nreturn { hash, shuffleOptions };")();
for (let n = 0; n < 3000; n++) {
  const k = 2 + rand(7), options = Array.from({ length: k }, (_, i) => `option ${i}`), answer = rand(k);
  const explanation = ["Why the right one is right."].concat(options.map((o, i) => i === answer ? null : `${L[i]}: reason for ${o}`).filter(Boolean)).join("\n");
  const q = { stem: "stem " + Math.random(), options, answer, explanation }, s = shuffleOptions(q);
  assert.strictEqual(s.options[s.answer], options[answer], "import: right answer moved away from its index");
  assert.deepStrictEqual([...s.options].sort(), [...options].sort(), "import: an option was lost or duplicated");
  const lines = s.explanation.split("\n");
  assert.strictEqual(lines[0], "Why the right one is right.");
  assert.strictEqual(lines.length, k, "import: explanation lines lost");
  for (const line of lines.slice(1)) {
    const m = /^([A-H]): reason for (option \d+)$/.exec(line);
    assert(m, "import: bad explanation line " + line);
    assert.strictEqual(s.options[L.indexOf(m[1])], m[2], `import: "${line}" now points at the wrong option`);
    assert.notStrictEqual(L.indexOf(m[1]), s.answer, "import: a wrong-option reason landed on the right answer's letter");
  }
  assert.deepStrictEqual(shuffleOptions(q), s, "import: the same question must shuffle the same way every time");
}
console.log("shuffle ok: right answers and explanations stay matched (generator and import)");
