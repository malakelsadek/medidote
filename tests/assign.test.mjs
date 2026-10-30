// Run: node tests/assign.test.mjs
import assert from "node:assert";
import { createRequire } from "node:module";
const { assignSlots } = createRequire(import.meta.url)("../js/assign.js");

const angles = ["mechanism", "consequence", "next step", "difference", "interpretation"];
// 3 core, 4 important, 3 minor, in lecture order
const tiers = ["core", "minor", "important", "core", "important", "minor", "important", "core", "minor", "important"];
const cs = tiers.map((tier, i) => ({ name: `c${i}`, tier, order: i, win: 0, pages: [] }));
const names = s => s.slots.map(x => x.concept);

// 1. fewer questions than concepts: all core, then important, no minor
let r = assignSlots(cs, 5, angles);
assert.equal(r.slots.length, 5);
assert.deepEqual(names(r).slice(0, 3).sort(), ["c0", "c3", "c7"]);
assert(names(r).every(n => cs.find(c => c.name === n).tier !== "minor"));

// 2. inside the tier that is cut, the pick is spread through the lecture, not the first ones
r = assignSlots(cs, 5, angles);
const imp = names(r).slice(3).map(n => cs.find(c => c.name === n).order);   // important ones sit at 2, 4, 6, 9: two of four
assert(imp.some(o => o >= 6), "should not take only the early important concepts");

// 3. exactly as many as concepts: every concept once, minor included
r = assignSlots(cs, 10, angles);
assert.deepEqual(names(r).sort(), cs.map(c => c.name).sort());

// 4. more than concepts: second questions go to the most important first, each on a new angle
r = assignSlots(cs, 14, angles);
assert.equal(r.slots.length, 14);
const again = names(r).slice(10);
assert.equal(again.length, 4);
assert(again.filter(n => cs.find(c => c.name === n).tier === "core").length === 3, "core concepts get the variations first");
for (const c of cs) {
  const mine = r.slots.filter(s => s.concept === c.name).map(s => s.angle);
  assert.equal(new Set(mine).size, mine.length, "a concept never repeats an angle");
}

// 5. asking for far more than the material supports returns fewer: 10 once + 7 twice + 7 three times
r = assignSlots(cs, 100, angles);
assert.equal(r.supported, 24);
assert.equal(r.slots.length, 24);

// 6. questions already in the deck count: a concept that has one is skipped in the first pass and gets its next angle
const have = cs.map(c => (c.name === "c0" ? { ...c, have: 1 } : c));
r = assignSlots(have, 9, angles);
assert(!names(r).includes("c0"), "c0 already has a question, the first pass skips it");
r = assignSlots(have, 12, angles);
assert.equal(names(r).filter(n => n === "c0").length, 1);

// 7. the same concept always gets the same starting angle, so a later run knows where it left off
assert.equal(assignSlots(cs, 3, angles).slots[0].angle, assignSlots(cs, 3, angles).slots[0].angle);

console.log("assignSlots ok");
