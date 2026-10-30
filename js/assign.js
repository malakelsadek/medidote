// Decides which questions to write: one per concept first (most important first), then variations on the most important concepts from a new angle.
// A plain script so the page and the node test share it. concepts: [{ name, tier: core | important | minor, order, win, pages, have }]
// have = questions the deck already holds on that concept, so "generate more" carries on instead of repeating.
(function (root) {
  const TIER = { core: 0, important: 1, minor: 2 };
  const hash = s => [...String(s).toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

  // keep `room` concepts: whole tiers in order of importance, and inside the tier that is cut, evenly spaced through the lecture
  function pick(pool, room) {
    const out = [];
    for (const rank of [0, 1, 2]) {
      const tier = pool.filter(c => c.rank === rank).sort((a, b) => a.order - b.order), left = room - out.length;
      if (left <= 0) break;
      out.push(...(tier.length <= left ? tier : Array.from({ length: left }, (_, k) => tier[Math.floor((k + .5) * tier.length / left)])));
    }
    return out;
  }

  function assignSlots(concepts, m, angles, maxVariants = 3) {
    const list = concepts.map(c => ({ ...c, rank: TIER[c.tier] ?? 1, have: c.have || 0 }));
    const slots = [];
    for (let p = 0; p < Math.min(maxVariants, angles.length) && slots.length < m; p++) {   // pass p writes each concept's (p+1)th question
      const pool = list.filter(c => c.have <= p && (p === 0 || c.rank < 2));   // minor concepts are covered once, never repeated
      for (const c of pick(pool, m - slots.length)) slots.push({ concept: c.name, angle: angles[(hash(c.name) + p) % angles.length], win: c.win, pages: c.pages });
    }
    return { slots, supported: slots.length };
  }

  root.assignSlots = assignSlots;
  if (typeof module !== 'undefined') module.exports = { assignSlots };
})(typeof window !== 'undefined' ? window : globalThis);
