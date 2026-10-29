// Pure helpers (no Deno APIs) so they can be tested with node: shuffle the options of a question, and spot questions where the right answer gives itself away by length.
export type Q = { options: string[]; answer: number; why: string[] };

// Fisher-Yates in code, so the position of the right answer does not depend on the model
export function shuffleQ<T extends Q>(q: T, rnd: () => number = Math.random): T {
  const order = q.options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return { ...q, options: order.map((i) => q.options[i]), why: order.map((i) => q.why[i] ?? ""), answer: order.indexOf(q.answer) };
}

// No option may be longer than this share of the average of the others. Models tend to make the right answer the longest, so the cap stops any option standing out.
export const MAX_LONGEST = 1.25;
export function lopsided(q: Q): boolean {
  const len = q.options.map((o) => o.length), top = Math.max(...len);
  const others = len.filter((_, i) => i !== len.indexOf(top));
  const mean = others.reduce((a, b) => a + b, 0) / others.length;
  return top >= 25 && top > MAX_LONGEST * mean;   // very short options (numbers, gene names) are exempt
}
