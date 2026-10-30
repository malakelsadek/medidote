const DAY = 864e5, MIN = 6e4;
// the publishable key is meant to sit in browser code; row level security decides what it can reach
const sb = supabase.createClient('https://jfvacwoiwmrbplsodlyk.supabase.co', 'sb_publishable_CFT3niRj-XoY0bLLBw_4Pg_gt66zraO');
const $ = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dayKey = t => { const d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

// ---- storage (IndexedDB) ----
const db = new Promise((res, rej) => {
  const r = indexedDB.open('ankidote', 2);
  r.onupgradeneeded = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('logs')) d.createObjectStore('logs', { autoIncrement: true });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    if (!d.objectStoreNames.contains('pdfs')) d.createObjectStore('pdfs');   // slide PDFs, keyed by deck name
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (store, mode, fn) => {
  const d = await db;
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), out = fn(t.objectStore(store));
    t.oncomplete = () => res(out?.result);
    t.onerror = () => rej(t.error);
  });
};
// ---- cloud storage (Supabase) ----
// Cards, review logs and settings live in the user's account. Everything is loaded once after sign-in and kept in memory;
// writes go to the database before they resolve. Slide PDFs and their file lists stay on this device for now (IndexedDB below).
// ponytail: whole account loaded at startup, switch to per-deck loading if accounts get very large
let cache, ready;
const chk = r => { if (r.error) throw r.error; return r.data; };
// the real error goes to the console for the developer; the user only ever sees the plain sentence
const oops = (e, say) => { console.error(e); return say; };
const chunks = (a, n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const fetchAll = async (table, cols, order) => {   // the API returns at most 1000 rows per request
  const out = [];
  for (let i = 0; ; i += 1000) { const d = chk(await sb.from(table).select(cols).order(order).range(i, i + 999)); out.push(...d); if (d.length < 1000) return out; }
};
const loadAll = async () => {
  const [decks, qs, logs, meta] = await Promise.all([fetchAll('decks', 'id,name', 'id'), fetchAll('questions', '*', 'id'), fetchAll('review_logs', 'data', 'id'), fetchAll('meta', 'key,value', 'key')]);
  const name = new Map(decks.map(d => [d.id, d.name]));
  cache = {
    deckId: new Map(decks.map(d => [d.name, d.id])),
    cards: new Map(qs.map(r => [r.key, { ...r.extra, id: r.key, deck: name.get(r.deck_id), stem: r.stem, options: r.options, answer: r.answer, explanation: r.explanation, ease: r.ease, interval: r.interval, due: Number(r.due), reps: r.reps, lapses: r.lapses }])),
    logs: logs.map(l => l.data),
    meta: new Map(meta.map(m => [m.key, m.value])),
  };
  await pruneDecks().catch(() => {});
};
const pruneDecks = async () => {   // decks with no questions and no slides are invisible leftovers (e.g. from test uploads): remove them
  const withCards = new Set([...cache.cards.values()].map(c => c.deck));
  const used = new Set(chk(await sb.from('slide_files').select('deck_id')).map(f => f.deck_id));
  for (const [n, id] of [...cache.deckId]) if (!withCards.has(n) && !used.has(id)) { chk(await sb.from('decks').delete().eq('id', id)); cache.deckId.delete(n); }
};
const ensureDecks = async names => {
  const miss = [...new Set(names)].filter(n => !cache.deckId.has(n));
  if (!miss.length) return;
  for (const d of chk(await sb.from('decks').upsert(miss.map(name => ({ name })), { onConflict: 'user_id,name' }).select('id,name'))) cache.deckId.set(d.name, d.id);
};
const toRow = c => { const { id, deck, stem, options, answer, explanation, ease, interval, due, reps, lapses, ...extra } = c; return { key: id, deck_id: cache.deckId.get(deck), stem, options, answer, explanation, ease, interval, due, reps, lapses, extra }; };
const all = async s => { await ready; return s === 'cards' ? [...cache.cards.values()] : [...cache.logs]; };
async function putMany(s, items) {
  await ready;
  if (s === 'cards') {
    items = [...new Map(items.map(c => [c.id, c])).values()];   // one row per card per request
    await ensureDecks(items.map(c => c.deck));
    for (const part of chunks(items)) chk(await sb.from('questions').upsert(part.map(toRow), { onConflict: 'user_id,key' }));
    items.forEach(c => cache.cards.set(c.id, c));
  } else {
    for (const part of chunks(items)) chk(await sb.from('review_logs').insert(part.map(l => ({ at: l.t, data: l }))));
    cache.logs.push(...items);
  }
}
async function clear(s) {
  await ready;
  if (s === 'cards') { chk(await sb.from('questions').delete().neq('key', '')); cache.cards.clear(); }
  else { chk(await sb.from('review_logs').delete().gte('id', 0)); cache.logs = []; }
}
async function removeCards(ids) {
  await ready;
  for (const part of chunks(ids, 100)) chk(await sb.from('questions').delete().in('key', part));
  ids.forEach(id => cache.cards.delete(id));
}
// slides used to be kept only in this browser (the "pdfs" store plus a "pdfs:deck" list in meta); migrateDevicePdfs() moves any left into the account
const pdfKey = (deck, id) => deck + '|' + id;
const pdfGet = key => tx('pdfs', 'readonly', o => o.get(key));
const pdfDel = keys => tx('pdfs', 'readwrite', o => keys.forEach(k => o.delete(k)));
const metaKeys = () => tx('meta', 'readonly', o => o.getAllKeys()).then(k => k || []);
const deviceMeta = (k, del) => tx('meta', del ? 'readwrite' : 'readonly', o => del ? o.delete(k) : o.get(k));   // read the on-device list, or delete it

const getMeta = async k => { await ready; return cache.meta.get(k); };
const setMeta = async (k, v) => { await ready; chk(await sb.from('meta').upsert({ key: k, value: v }, { onConflict: 'user_id,key' })); cache.meta.set(k, v); };

// ---- scheduling (Anki-style SM-2) ----
// ponytail: SM-2, swap for FSRS if retention tuning matters
function schedule(c, rating, now) {
  if (rating === 'again') {
    c.lapses++; c.ease = Math.max(1.3, c.ease - 0.2); c.interval = 0; c.due = now + 10 * MIN;
  } else if (c.interval === 0) {
    c.interval = rating === 'easy' ? 4 : rating === 'good' ? 1 : 0;
    c.due = now + (c.interval ? c.interval * DAY : 10 * MIN);
  } else {
    const f = { hard: 1.2, good: c.ease, easy: c.ease * 1.3 }[rating];
    c.ease = Math.max(1.3, c.ease + { hard: -0.15, good: 0, easy: 0.15 }[rating]);
    c.interval = Math.max(c.interval + 1, Math.round(c.interval * f));
    c.due = now + c.interval * DAY;
  }
  c.reps++;
}

// ---- import / export ----
const hash = s => { let h = 5381; for (const ch of s) h = (h * 33) ^ ch.charCodeAt(0); return (h >>> 0).toString(36); };

function validateDeck(d) {
  const errs = [];
  if (typeof d.deck !== 'string' || !d.deck.trim()) errs.push('"deck" must be a non-empty string');
  if (!Array.isArray(d.questions) || !d.questions.length) errs.push('"questions" must be a non-empty array');
  else d.questions.forEach((q, i) => {
    const p = `Question ${i + 1}: `;
    if (typeof q.stem !== 'string' || !q.stem.trim()) errs.push(p + 'missing "stem"');
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => typeof o !== 'string')) errs.push(p + '"options" must be 2+ strings');
    else if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) errs.push(p + '"answer" must be an index into options (0 = first)');
  });
  return errs;
}

// ---- folders: explicit assignments plus empty folders, kept in meta ----
// a deck with no explicit folder falls back to the part of its name before " - "
let FM = { folders: [], assign: {} };
const loadFM = async () => { FM = (await getMeta('fm')) || { folders: [], assign: {} }; };
const saveFM = () => setMeta('fm', FM);
const folderOf = d => FM.assign[d] || (d.includes(' - ') ? d.split(' - ')[0].trim() : 'Unsorted');
const lectureOf = d => { const i = d.indexOf(' - '); return i > 0 && folderOf(d) === d.slice(0, i).trim() ? d.slice(i + 3).trim() : d; };
const allFolders = cards => [...new Set([...FM.folders, ...cards.map(c => folderOf(c.deck))])].sort((a, b) => a.localeCompare(b));

// options are shuffled on import (the same way every time for a given question, so re-importing keeps your progress) so the right answer is not stuck in the first slots
const shuffleOptions = q => {
  let h = parseInt(hash(q.stem), 36) || 1;
  const rnd = () => { h = (h + 0x6D2B79F5) | 0; let t = Math.imul(h ^ h >>> 15, 1 | h); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const order = q.options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const at = order.map((_, k) => order.indexOf(k)), L = 'ABCDEFGH';   // at[old] = new position
  const explanation = (q.explanation || '').split('\n').map(l => { const m = /^([A-H])\s*:/.exec(l); return m && at[L.indexOf(m[1])] !== undefined ? L[at[L.indexOf(m[1])]] + l.slice(1) : l; }).join('\n');
  return { options: order.map(i => q.options[i]), answer: at[q.answer], explanation };
};

let lastDeck = null;   // deck created by the most recent successful import (used to attach slides)
async function importFile(file, folder = '') {
  lastDeck = null;
  let d;
  try { d = JSON.parse((await file.text()).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return 'Not valid JSON.'; }
  const errs = validateDeck(d);
  if (errs.length) return 'Import failed:\n' + errs.slice(0, 10).join('\n') + (errs.length > 10 ? `\n...and ${errs.length - 10} more` : '');
  const have = new Map((await all('cards')).map(c => [c.id, c]));
  let added = 0;
  const out = d.questions.map(q => {
    const id = hash(d.deck + '|' + q.stem), old = have.get(id);
    if (!old) added++;
    const slides = [...new Set([].concat(q.slide ?? q.slides ?? []).filter(n => Number.isInteger(n) && n > 0))], slide = slides[0] || 0;   // one slide, or several for a question that needs more
    const sh = q.options.length > 1 && q.options.length <= 8 && !q.options.every(o => /^[\d.\-+]/.test(o)) ? shuffleOptions(q) : { options: q.options, answer: q.answer, explanation: q.explanation || '' };
    return { ease: 2.5, interval: 0, due: 0, reps: 0, lapses: 0, ...old, id, deck: d.deck, stem: q.stem, options: sh.options, answer: sh.answer, explanation: sh.explanation, ...(slide ? { slide } : {}), ...(slides.length > 1 ? { slides } : {}), ...(typeof q.evidence === 'string' && q.evidence.trim() ? { evidence: q.evidence.trim() } : {}), ...(slide && typeof q.file === 'string' && q.file.trim() ? { file: q.file.trim() } : {}) };
  });
  await putMany('cards', out);
  lastDeck = d.deck;
  if (folder) { FM.assign[d.deck] = folder; if (!FM.folders.includes(folder)) FM.folders.push(folder); await saveFM(); }
  return `${d.deck}: ${added} new question${added === 1 ? '' : 's'}${out.length > added ? `, ${out.length - added} updated` : ''}.`;
}

// ---- stats ----
function streak(logs) {
  const days = new Set(logs.map(l => dayKey(l.t)));
  let n = 0, t = Date.now();
  if (!days.has(dayKey(t))) t -= DAY;
  while (days.has(dayKey(t))) { n++; t -= DAY; }
  return n;
}
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '-';

let sess = 20, smode = null;   // session size, and which set to study (null = pick automatically)
try { sess = +localStorage.getItem('sess') || 20; } catch {}
const wrongIds = logs => { const last = new Map(); for (const l of logs) if (!last.has(l.id) || l.t >= last.get(l.id).t) last.set(l.id, l); return new Set([...last].filter(([, l]) => !l.correct).map(([id]) => id)); };   // cards whose latest answer was wrong
const zoomNow = () => { try { return localStorage.getItem('zoom') || '1'; } catch { return '1'; } };
let hideCh = false;   // answer from memory first: choices stay hidden until you tap Show choices
try { hideCh = localStorage.getItem('hidech') === '1'; } catch {}

// ---- settings: sound + theme ----
let sound = true, actx, keep, keepT;
try { sound = localStorage.getItem('sound') !== '0'; } catch {}
const theme = () => document.documentElement.dataset.theme || 'auto';
function setTheme(v) {
  if (v === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
  try { v === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', v); } catch {}
  syncBar();
}
// synthesized with WebAudio so there are no sound files to cache
// tap = soft pop, ok = bright bell arpeggio, no = soft muffled "bonk", done = little fanfare
//
// iOS quirks this works around:
//  - an AudioContext starts suspended and only resumes from a tap, so we wait for resume() before scheduling notes
//  - Web Audio is muted by the silent/mute setting, but a playing <audio> element is not. Playing a silent looping one
//    (and setting the audioSession to "playback") moves the page onto the media channel so the notes are heard.
//    It only runs for ~2s around each sound so it doesn't hold the audio session (or other apps' music) longer than needed.
//  - the silent clip needs real samples (an empty one never counts as "playing"), so it's 0.5s of 8-bit silence built here
//  - after a call/Siri/backgrounding the context can go "interrupted"/"closed" and resume() can hang, so we time it out and rebuild
const SILENT_WAV = (() => {
  const n = 4000, b = new Uint8Array(44 + n).fill(128), v = new DataView(b.buffer), s = (o, t) => [...t].forEach((c, i) => b[o + i] = c.charCodeAt(0));
  s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true);
  let bin = ''; b.forEach(x => bin += String.fromCharCode(x));
  return 'data:audio/wav;base64,' + btoa(bin);
})();
const mkCtx = () => {
  const c = new (window.AudioContext || window.webkitAudioContext)();
  c.onstatechange = () => { if (c.state !== 'running' && c === actx && sound) c.resume().catch(() => {}); };   // iOS "interrupted" after a call/Siri
  return c;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
let audioQ = Promise.resolve();                           // one audioOn at a time so two quick sounds can't swap the context under each other
const hush = () => { clearTimeout(keepT); keep?.pause(); try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch {} };
const kick = () => {                                      // keep the media channel open while she's studying (30s after the last sound), not toggled around every sound
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  if (!keep) { keep = new Audio(SILENT_WAV); keep.loop = true; keep.preload = 'auto'; }
  keep.play().catch(() => {});
  clearTimeout(keepT); keepT = setTimeout(hush, 30000);
};
const audioOn = () => audioQ = audioQ.then(async () => {
  if (actx && actx.state === 'closed') actx = null;
  actx ||= mkCtx();
  kick();
  if (actx.state !== 'running') {
    await Promise.race([actx.resume().catch(() => {}), wait(400)]);
    if (actx.state !== 'running') {                       // stuck: throw it away and make a fresh one
      try { actx.close(); } catch {}
      actx = mkCtx();
      await Promise.race([actx.resume().catch(() => {}), wait(400)]);
    }
  }
}).catch(() => {});
// unlock on the first touch (iOS only allows starting audio from a tap), and wake up again when the app returns to the foreground
// ponytail: we resume on every tap/return rather than tracking exactly which events iOS killed audio on; it's cheap and idempotent
const wake = () => { if (sound && actx && actx.state !== 'running') audioOn(); };
// iOS can leave the context saying "running" after the app was backgrounded while it is really dead, so drop it on the way out and rebuild on the next tap
const away = () => { hush(); if (actx) { try { actx.close(); } catch {} actx = null; } };
['pointerdown', 'touchend', 'keydown'].forEach(e => addEventListener(e, () => { if (sound && !actx) audioOn(); else wake(); }, { passive: true, capture: true }));
document.addEventListener('visibilitychange', () => { if (document.hidden) away(); });
addEventListener('pagehide', away);
// soft pop on any button/toggle; answer choices and the right/wrong buttons have their own sounds
addEventListener('click', e => {
  const b = e.target.closest('button, .btn, .tgl, [role=button]');
  if (b && !b.disabled && !b.matches('.opt, #t-ok, #t-no')) play('tap');
}, true);
async function play(kind) {
  if (!sound) return;
  try {
    if (actx?.state === 'running') kick(); else await audioOn();   // fast path: no queue, no waiting when the context is already live
    const out = actx.createGain(); out.gain.value = .9; out.connect(actx.destination);
    const bell = (f, t, len = .55, vol = .5) => {            // sine + 2x + 3x partials, fast attack, long exponential decay
      const at = actx.currentTime + t + .01;
      [[1, 1], [2, .35], [3, .12]].forEach(([m, v]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f * m;
        g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(vol * v, at + .008); g.gain.exponentialRampToValueAtTime(.0001, at + len / m);
        o.connect(g).connect(out); o.start(at); o.stop(at + len);
      });
    };
    const tick = () => {                                     // soft "pop": sine with a gentle attack and a low glide down, ~140ms; a little above the very first, quiet version
      const at = actx.currentTime + .01, o = actx.createOscillator(), g = actx.createGain();
      o.frequency.setValueAtTime(680, at); o.frequency.exponentialRampToValueAtTime(430, at + .11);
      g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(.2, at + .014); g.gain.exponentialRampToValueAtTime(.0001, at + .15);
      o.connect(g).connect(out); o.start(at); o.stop(at + .16);
    };
    const bonk = (f, t) => {                                 // low sine through a lowpass, gentle pitch drop
      const at = actx.currentTime + t + .01, o = actx.createOscillator(), g = actx.createGain(), lp = actx.createBiquadFilter();
      o.type = 'triangle'; o.frequency.setValueAtTime(f, at); o.frequency.exponentialRampToValueAtTime(f * .88, at + .22);
      lp.type = 'lowpass'; lp.frequency.value = 700;
      g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(.7, at + .015); g.gain.exponentialRampToValueAtTime(.0001, at + .3);
      o.connect(lp).connect(g).connect(out); o.start(at); o.stop(at + .32);
    };
    if (kind === 'tap') tick();
    else if (kind === 'ok') [[784, 0], [988, .075], [1319, .15]].forEach(([f, t]) => bell(f, t, .6, .45));
    else if (kind === 'done') [[523, 0], [659, .1], [784, .2], [1047, .3], [1319, .42]].forEach(([f, t]) => bell(f, t, .8, .4));
    else { bonk(262, 0); bonk(196, .16); }
  } catch {}
}

// ---- motion helpers ----
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function burst(x, y, n = 26, power = 1) {                 // small confetti burst on a canvas overlay
  if (calm()) return;
  const c = document.createElement('canvas');
  c.className = 'fx'; c.width = innerWidth; c.height = innerHeight;
  document.body.appendChild(c);
  const g = c.getContext('2d'), st = getComputedStyle(document.body);
  const cols = ['#ffc800', st.getPropertyValue('--acc').trim() || '#d9528c', st.getPropertyValue('--blue').trim() || '#4aa3d9', '#ffffff'];
  const ps = Array.from({ length: n }, () => ({ x, y, vx: (Math.random() - .5) * 11 * power, vy: -(Math.random() * 10 + 4) * power, r: 3 + Math.random() * 4, c: cols[Math.floor(Math.random() * cols.length)], a: Math.random() * 6, va: (Math.random() - .5) * .4, t: 0 }));
  let last = performance.now();
  const step = now => {
    const k = Math.min(2, (now - last) / 16.7); last = now;
    g.clearRect(0, 0, c.width, c.height);
    let alive = 0;
    for (const p of ps) {
      p.vy += .35 * k; p.x += p.vx * k; p.y += p.vy * k; p.a += p.va * k; p.t += k;
      if (p.t > 100 || p.y > c.height + 20) continue;
      alive++;
      g.save(); g.globalAlpha = 1 - p.t / 100; g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.c; g.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); g.restore();
    }
    alive ? requestAnimationFrame(step) : c.remove();
  };
  requestAnimationFrame(step);
}
function countUp(el) {                                     // "12 days" -> counts the 12 up, keeps the rest
  const m = /^(\d+)(.*)$/.exec(el.textContent.trim());
  if (!m || calm()) return;
  const to = +m[1], tail = m[2], t0 = performance.now();
  if (to < 2) return;
  const f = t => {
    const p = Math.max(0, Math.min(1, (t - t0) / 800));   // rAF timestamps can be a hair earlier than t0
    el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))) + tail;
    if (p < 1) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}
let lastScreen = null;   // so re-rendering the same screen (e.g. changing a setting) doesn't replay the entrance

// ---- shell / nav ----
let view = 'today', min = false, folder = null, editing = false;
try { min = localStorage.getItem('navmin') === '1'; } catch {}
const ICONS = {
  today: '<path d="M12 6.5C10.5 5 8 4.5 4 4.5v13c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-13c-4 0-6.5.5-8 2zM12 6.5v13"/>',
  stats: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  data: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
  guide: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  folders: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  decks: '<rect x="7" y="3" width="13" height="14" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/>',
  tour: '<path d="M8 5v14l11-7z"/>',
  subscription: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
  generate: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  community: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5.500a3 3 0 0 1 0 5.500M18 20a5 5 0 0 0-3-4.600"/>',
  slides: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  chev: '<path d="m15 6-6 6 6 6"/>',
};
const ICONS_I = {   // pictures for the install steps in the Guide
  safari: '<circle cx="12" cy="12" r="9"/><path d="m15.500 8.500-2 5-5 2 2-5z"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4M6 12H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2h-1"/>',
  plus: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
  tick: '<circle cx="12" cy="12" r="9"/><path d="m8 12.500 3 3 5-6"/>',
  dots: '<circle cx="12" cy="5" r="1.600"/><circle cx="12" cy="12" r="1.600"/><circle cx="12" cy="19" r="1.600"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 7v5m0 0-2-2m2 2 2-2M8 20h8"/>',
};
const svg = (p, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const FILL = {
  flame: '<path d="M12 2s5.5 4.6 5.5 10.2a5.5 5.5 0 0 1-11 0c0-2.2 1-3.800 2.200-4.800.300 1.600 1 2.400 1.900 2.800C10.100 7 10.300 4.400 12 2z"/>',
  bolt: '<path d="M13.500 2 4.500 13.500h6.500L10 22l9-11.500h-6.500z"/>',
  star: '<path d="m12 2.500 2.900 5.900 6.500.9-4.700 4.600 1.100 6.500-5.800-3-5.800 3 1.100-6.500L2.600 9.300l6.500-.9z"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m7.500 12.500 3 3 6-6.500" fill="none" stroke="#fff" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/>',
};
const fsvg = (k, c, s = 26) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">${FILL[k]}</svg>`;
// signed-in account shown above Settings: profile picture (or an initial) and first name; tapping it opens Settings, where Sign out is
let me = null;
const accountBtn = () => {
  const u = me?.user_metadata || {}, name = u.full_name || u.name || me?.email || 'Account', pic = u.avatar_url || u.picture, ini = esc(name[0].toUpperCase());
  // if Google's picture won't load (blocked, rate-limited, offline) swap in the initial instead of a broken image
  return `<button class="nv wo acct" data-v="settings" title="${esc(name)}">${pic ? `<img class="av" src="${esc(pic)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<i class=&quot;av&quot;>${ini}</i>'">` : `<i class="av">${ini}</i>`}<span>${esc(name.split(' ')[0])}</span></button>`;
};
const fitNav = () => {   // sidebar too tall for the screen (zoomed in a lot): hide the extra tabs and show More instead
  const n = document.getElementById('nav');
  n.classList.remove('crowd');
  if (getComputedStyle(n).flexDirection === 'column' && n.scrollHeight > n.clientHeight + 1) n.classList.add('crowd');
};
addEventListener('resize', fitNav);
function renderNav() {
  const nav = document.getElementById('nav');
  nav.className = min ? 'min' : '';
  nav.innerHTML = `<div class="brand"><img src="icon-192.png" alt="" width="36" height="36" style="border-radius:9px;display:block;flex:none">${min ? '' : '<span>medidote</span>'}</div>`
    + [['today', 'Study'], ['stats', 'Stats'], ['folders', 'Folders'], ['decks', 'Decks'], ['slides', 'Slides', 'wo'], ['generate', 'Generate', 'wo'], ['community', 'Community', 'wo'], ['guide', 'Guide', 'wo'], ['subscription', 'MEDIDOTE+', 'wo'], ['settings', 'Settings', 'wo']].map(([v, l, c = '']) => (v === 'subscription' ? accountBtn() : '') +`<button class="nv ${c} ${v === view ? 'on' : ''}" data-v="${v}" title="${l}">${svg(ICONS[v])}<span>${l}</span></button>`).join('')
    + `<button class="nv more ${['more', 'slides', 'generate', 'community', 'subscription', 'guide', 'settings'].includes(view) ? 'on' : ''}" data-v="more" title="More">${svg(ICONS.more)}<span>More</span></button>`
    + `<button class="nv tog" id="tog" title="${min ? 'Expand' : 'Minimize'}">${svg(ICONS.chev)}<span>Minimize</span></button>`;
  nav.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { if (b.dataset.v === 'tour') return walkthrough(); view = b.dataset.v; editing = false; if (view === 'today') folder = null; home(); });
  nav.querySelector('#tog').onclick = () => { min = !min; try { localStorage.setItem('navmin', min ? '1' : '0'); } catch {} renderNav(); };
  fitNav();
}

// ---- folders: "Subject - Lecture" decks are grouped by the part before the dash ----
// folder colours: [key, front, back]; a folder with none follows the colour theme
const FCOLORS = [['red', '#ef5350', '#c62828'], ['orange', '#ff9800', '#e65100'], ['yellow', '#ffd54f', '#f9a825'], ['lime', '#c0ca33', '#9e9d24'], ['green', '#66bb6a', '#2e7d32'], ['teal', '#26a69a', '#00796b'], ['cyan', '#26c6da', '#00838f'], ['blue', '#42a5f5', '#1565c0'], ['indigo', '#7986cb', '#3949ab'], ['purple', '#ab47bc', '#6a1b9a'], ['pink', '#f06292', '#ad1457'], ['brown', '#a1887f', '#5d4037']];
const fcolor = f => FCOLORS.find(c => c[0] === FM.colors?.[f]);
const setFolderColor = async (f, key) => { FM.colors ||= {}; if (key) FM.colors[f] = key; else delete FM.colors[f]; await saveFM(); };
const colorPicker = cur => `<div class="fcl">${[['', 'var(--acc)'], ...FCOLORS.map(c => [c[0], c[1]])].map(([k, c]) => `<button type="button" data-c="${k}" class="${k === (cur || '') ? 'on' : ''}" style="background:${c}" aria-label="${k || 'Theme colour'}"></button>`).join('')}</div>`;
const bindPicker = (o, cur) => { let v = cur || ''; o.querySelectorAll('.fcl button').forEach(b => b.onclick = () => { v = b.dataset.c; o.querySelectorAll('.fcl button').forEach(x => x.classList.toggle('on', x === b)); }); return () => v; };
const folderSvg = (n, f) => { const c = fcolor(f); return `<svg viewBox="0 0 64 64" width="${n}" height="${n}"><path style="fill:${c ? c[2] : 'var(--acc-d)'}" d="M6 16a5 5 0 0 1 5-5h14l6 7h22a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/><path style="fill:${c ? c[1] : 'var(--acc)'}" d="M6 27a5 5 0 0 1 5-5h42a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/></svg>`; };

const TRASH_PATH = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>';

// ---- slide viewer: renders one slide at a time with PDF.js (bundled, so it works offline) ----
const slidesIco = () => svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/>', 18);
let pdfjsReady;
const loadPdfjs = () => pdfjsReady ||= new Promise((res, rej) => {
  const el = document.createElement('script');
  el.src = 'pdf.min.js';
  el.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js'; res(); };
  el.onerror = () => { pdfjsReady = null; rej(new Error('viewer')); };
  document.head.appendChild(el);
});
// ---- deleting (progress history in the logs is kept, so streaks and totals survive) ----
async function removeCloudSlides(d) {   // the deck's slide files and the deck itself; a stored PDF goes too unless another deck still uses it
  const id = cache.deckId.get(d);
  if (!id) return;
  const files = chk(await sb.from('slide_files').select('storage_path').eq('deck_id', id));
  chk(await sb.from('decks').delete().eq('id', id));   // its slide_files and page text are removed with it
  cache.deckId.delete(d);
  for (const p of new Set(files.map(f => f.storage_path))) {
    const { count } = await sb.from('slide_files').select('id', { count: 'exact', head: true }).eq('storage_path', p);
    if (!count) await sb.storage.from('slides').remove([p, coverPath(p)]);
  }
}
async function deleteDeck(d) {
  await removeCards((await all('cards')).filter(c => c.deck === d).map(c => c.id));
  await removeCloudSlides(d);
  delete FM.assign[d]; await saveFM();
}
async function deleteFolder(f) {
  const inF = (await all('cards')).filter(c => folderOf(c.deck) === f);
  await removeCards(inF.map(c => c.id));
  for (const d of new Set(inF.map(c => c.deck))) await removeCloudSlides(d);
  FM.folders = FM.folders.filter(x => x !== f);
  delete FM.colors?.[f];
  for (const k of Object.keys(FM.assign)) if (FM.assign[k] === f) delete FM.assign[k];
  await saveFM();
}

// ---- renaming (card ids stay the same, so progress is kept) ----
async function renameDeck(o, n) {
  await ready;
  const id = cache.deckId.get(o);   // rename the deck row, not just the cards, so its slides stay attached
  if (id) { chk(await sb.from('decks').update({ name: n }).eq('id', id)); cache.deckId.delete(o); cache.deckId.set(n, id); }
  await putMany('cards', (await all('cards')).filter(c => c.deck === o).map(c => ({ ...c, deck: n })));
  if (o in FM.assign) { FM.assign[n] = FM.assign[o]; delete FM.assign[o]; await saveFM(); }
}
async function renameFolder(o, n) {
  const decks = new Set((await all('cards')).filter(c => folderOf(c.deck) === o).map(c => c.deck));
  for (const d of decks) {
    const i = d.indexOf(' - ');
    if (FM.assign[d] === o) FM.assign[d] = n;
    else if (!FM.assign[d] && i > 0) await renameDeck(d, n + d.slice(i));   // folder comes from the deck name
    else FM.assign[d] = n;
  }
  FM.folders = [...new Set(FM.folders.map(x => x === o ? n : x))];
  if (FM.colors?.[o]) { FM.colors[n] = FM.colors[o]; delete FM.colors[o]; }
  await saveFM();
}
function renameDialog(title, cur, max, check, apply, col) {   // col: current colour key, only passed for folders
  modal(`<h2>${esc(title)}</h2><input class="inp" id="rn" maxlength="${max}" value="${esc(cur)}" autocomplete="off">${col === undefined ? '' : colorPicker(col)}
    <div class="row end"><button id="c">Cancel</button><button class="p" id="ok">Save</button></div><p class="err" id="er"></p>`, (o, close) => {
    const q = s => o.querySelector(s), pick = col === undefined ? () => undefined : bindPicker(o, col);
    const go = async () => {
      const n = q('#rn').value.trim();
      if (n === cur && pick() === (col === undefined ? undefined : col || '')) return close();
      const err = !n ? 'Type a name first.' : await check(n);
      if (err) { q('#er').textContent = err; return; }
      close(); await apply(n, pick());
    };
    q('#c').onclick = close; q('#ok').onclick = go;
    q('#rn').onkeydown = e => { if (e.key === 'Enter') go(); };
    q('#rn').select();
  });
}
function renameDeckUI(d) {
  const i = d.indexOf(' - '), pre = lectureOf(d) !== d ? d.slice(0, i) + ' - ' : '';
  renameDialog('Rename deck', lectureOf(d), 80,
    async n => (await all('cards')).some(c => c.deck === pre + n) ? 'A deck with that name already exists.' : '',
    async n => { await renameDeck(d, pre + n); home(`Renamed to "${n}".`); });
}
function renameFolderUI(f) {
  renameDialog('Edit folder', f, 40,
    async n => allFolders(await all('cards')).some(x => x !== f && x.toLowerCase() === n.toLowerCase()) ? 'That folder already exists.' : '',
    async (n, c) => { if (n !== f) await renameFolder(f, n); await setFolderColor(n, c); if (folder === f) folder = n; home(n === f ? 'Folder updated.' : `Renamed to "${n}".`); },
    fcolor(f)?.[0] || '');
}

// ---- dialogs ----
function modal(html, bind) {
  const o = document.createElement('div');
  o.className = 'ovl';
  o.innerHTML = `<div class="sheet">${html}</div>`;
  document.body.appendChild(o);
  const close = () => o.remove();
  o.onclick = e => { if (e.target === o) close(); };
  bind(o, close);
  o.querySelector('input:not([hidden]),select')?.focus();
}
function confirmDialog(title, text, yes, onYes) {
  modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row end"><button id="c">Cancel</button><button class="danger" id="ok">${esc(yes)}</button></div>`, (o, close) => {
    o.querySelector('#c').onclick = close;
    o.querySelector('#ok').onclick = async () => { close(); await onYes(); };
  });
}
function newFolderDialog(done) {
  modal(`<h2>New folder</h2><p>Folders group your decks, for example by subject.</p>
    <input class="inp" id="fn" maxlength="40" placeholder="e.g. Cardiology" autocomplete="off">${colorPicker('')}
    <div class="row end"><button id="c">Cancel</button><button class="p" id="ok">Create</button></div><p class="err" id="er"></p>`, (o, close) => {
    const q = s => o.querySelector(s), pick = bindPicker(o, '');
    const go = async () => {
      const n = q('#fn').value.trim();
      if (!n) { q('#er').textContent = 'Give the folder a name.'; return; }
      if (allFolders(await all('cards')).some(f => f.toLowerCase() === n.toLowerCase())) { q('#er').textContent = 'That folder already exists.'; return; }
      FM.folders.push(n); await setFolderColor(n, pick()); close(); done(n);
    };
    q('#c').onclick = close; q('#ok').onclick = go;
    q('#fn').onkeydown = e => { if (e.key === 'Enter') go(); };
  });
}
// ---- plans: a free period with a smaller AI allowance, then a paid plan (the server enforces this; the app only displays it) ----
// features switched off for now: their pages just say "coming soon" (set to false to turn the real page back on)
const COMING_SOON = { generate: false, subscription: true };
const soon = title => `<h1 class="pt">${title}</h1><p class="tag">Coming soon</p>`;
const PLAN = { name: 'medidote Pro', price: 'EGP 500', questions: 400 }, TRIAL_QUESTIONS = 100;   // keep TRIAL_QUESTIONS in step with generate/index.ts
const planOf = s => {
  const now = Date.now();
  if (s?.status === 'active' && s.current_period_end && new Date(s.current_period_end) > now) return { k: 'active', until: new Date(s.current_period_end) };
  if (s && new Date(s.trial_ends_at) > now) return { k: 'trial', left: Math.ceil((new Date(s.trial_ends_at) - now) / DAY) };
  return { k: 'free' };
};

const coverPath = p => p.replace(/\.pdf$/, '.jpg');
const signedCovers = async files => {   // file id -> temporary image address ('' when a file has no cover)
  if (!files.length) return new Map();
  const { data } = await sb.storage.from('slides').createSignedUrls(files.map(f => coverPath(f.storage_path)), 3600);
  return new Map(files.map((f, i) => [f.id, data?.[i]?.signedUrl || '']));
};
const tileBody = (f, cover, deck = '') => `<span class="scover">${cover ? `<img src="${esc(cover)}" alt="">` : slidesIco()}</span><span class="sname">${esc(f.file_name.replace(/\.pdf$/i, ''))}</span>${deck ? `<small class="sdeck">${esc(lectureOf(deck))}</small>` : ''}<small>${f.week ? 'Week ' + f.week + ' · ' : ''}${f.page_count} page${f.page_count === 1 ? '' : 's'}</small>`;
let slideDeck = '';   // the Slides tab filter: '' = everything, 'f:Folder', or 'd:Deck name'
let slideGroup = 'all', slideLayout = 'tiles';   // Slides tab: grouping (all | deck | folder) and layout (tiles | list)
try { slideGroup = localStorage.getItem('slidegroup') || 'all'; slideLayout = localStorage.getItem('slidelayout') || 'tiles'; } catch {}
let slideSel = null;   // Slides tab: a Set of selected file ids while selecting, otherwise null
async function slideCounts() {   // deck name -> number of slide files attached to it
  await ready;
  const name = new Map([...cache.deckId].map(([n, id]) => [id, n])), m = new Map();
  for (const f of chk(await sb.from('slide_files').select('deck_id'))) { const n = name.get(f.deck_id); m.set(n, (m.get(n) || 0) + 1); }
  return m;
}
async function removeSlideFiles(fs) {   // fs: [{ id, path }]; a stored PDF goes too once no deck uses it
  chk(await sb.from('slide_files').delete().in('id', fs.map(f => f.id)));
  for (const p of new Set(fs.map(f => f.path))) {
    const { count } = await sb.from('slide_files').select('id', { count: 'exact', head: true }).eq('storage_path', p);
    if (!count) await sb.storage.from('slides').remove([p, coverPath(p)]);
  }
  await pruneDecks();
}

// explanation: the reason the answer is right, then one line per wrong option. Accepts the new layout (a line per option: "A: ...")
// and older single-paragraph explanations ("B is correct: ... A is wrong because ...")
const explainParts = text => {
  let t = String(text || '').trim(), wrong = [];
  const line = /^\s*([A-H])\s*[:.)]\s+(.+)$/;
  if (/\n/.test(t)) {
    const why = [];
    for (const l of t.split(/\n+/)) { const m = l.match(line); if (m) wrong.push([m[1], m[2].trim().replace(/^./, c => c.toUpperCase())]); else if (l.trim()) why.push(l.trim()); }
    t = why.join(' ');
  } else {
    const bits = t.split(/\s+(?=[A-H] is (?:wrong|incorrect)\b)/);
    if (bits.length > 1) {
      t = bits.shift();
      for (const b of bits) { const m = b.match(/^([A-H]) is (?:wrong|incorrect)\s*(?:because|as|since|:)?\s*(.+)$/is); if (m) wrong.push([m[1], m[2].charAt(0).toUpperCase() + m[2].slice(1)]); else t += ' ' + b; }
    }
  }
  t = t.replace(/^\s*(?:the\s+)?(?:correct\s+answer\s+is\s+)?[A-H]\s+is\s+correct\s*[:,.\-–]?\s*/i, '').replace(/^\s*correct\s*[:\-–]\s*/i, '');
  return { why: t.charAt(0).toUpperCase() + t.slice(1), wrong };
};
const oexHtml = (c, i) => {   // shown under an option once answered: why the right one is right, why each other one is wrong
  if (!c.explanation) return '';
  const { why, wrong } = explainParts(c.explanation), t = i === c.answer ? why : wrong.find(([k]) => k === 'ABCDEFGH'[i])?.[1];
  return t ? `<div class="fbe oex">${esc(t)}</div>` : '';
};

// ---- the source slide next to a question (AI questions keep card.sources = [{ file_id, page }]) ----
let slideMode = 'after';   // off | before (until you answer) | after (once you have answered) | both
try { slideMode = localStorage.getItem('slidemode') || 'after'; } catch {}
let slideFileMap;
const loadSlideFiles = async () => slideFileMap = new Map(chk(await sb.from('slide_files').select('id,file_name,storage_path,deck_id')).map(f => [f.id, f]));
const slideFile = async id => (slideFileMap?.has(id) ? slideFileMap : await loadSlideFiles()).get(id);
const slideDocs = new Map();   // file id -> opened pdf, kept for the session; pdf.js fetches only the pages it needs
const slideDoc = id => {
  if (!slideDocs.has(id)) slideDocs.set(id, (async () => {
    const f = await slideFile(id);
    if (!f) throw new Error('missing file');
    const { data, error } = await sb.storage.from('slides').createSignedUrl(f.storage_path, 3600);
    if (error) throw error;
    await loadPdfjs();
    return pdfjsLib.getDocument({ url: data.signedUrl }).promise;
  })().catch(e => { slideDocs.delete(id); throw e; }));
  return slideDocs.get(id);
};
const cardSlides = c => {
  const own = (Array.isArray(c.sources) ? c.sources : []).filter(x => x?.file_id && x.page > 0);
  const pages = c.slides?.length ? c.slides : c.slide > 0 ? [c.slide] : [];
  if (own.length || !pages.length) return own;
  // imported JSON has only "slide" (a page number) and maybe "file": link it to the PDF attached to the same deck
  const name = String(c.file || '').toLowerCase().replace(/\.pdf$/, '');
  const pick = (list, nm) => (name && list.find(x => nm(x).toLowerCase().includes(name))) || (list.length === 1 ? list[0] : null);
  const did = cache.deckId.get(c.deck), f = pick([...(slideFileMap?.values() || [])].filter(f => f.deck_id === did), f => f.file_name);
  return f ? pages.map(page => ({ file_id: f.id, page })) : [];
};
async function enlargeSlide(x, title) {   // tap the slide beside a question: the same viewer as "View slide", opened at that page, with back / forward through the whole PDF
  const o = document.createElement('div');
  o.className = 'pdfv';
  o.innerHTML = `<div class="pbar"><button class="x" id="pc" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button><div class="ptitle"></div></div>
    <div class="pstage"><canvas id="pcv"></canvas><div class="pmsg" id="pm">Opening slides…</div></div>
    <div class="pnav"><button id="pp" aria-label="Previous slide">‹</button><span id="pn">–</span><button id="pnx" aria-label="Next slide">›</button></div>`;
  o.querySelector('.ptitle').textContent = title || '';
  document.body.appendChild(o);
  const q = s => o.querySelector(s);
  let doc, cur = x.page, tok = 0, task;
  const onKey = e => {
    e.stopImmediatePropagation();
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight' || e.key === ' ') go(1); else if (e.key === 'ArrowLeft') go(-1);
  };
  const close = () => { document.removeEventListener('keydown', onKey, true); removeEventListener('resize', draw); task?.cancel?.(); o.remove(); };   // the pdf stays open: it is shared with the question panel
  document.addEventListener('keydown', onKey, true);
  q('#pc').onclick = close;
  async function draw() {
    if (!doc) return;
    const my = ++tok, pg = await doc.getPage(cur), stage = q('.pstage');
    if (my !== tok) return;
    const base = pg.getViewport({ scale: 1 });
    const fit = Math.max(.1, Math.min((stage.clientWidth - 24) / base.width, (stage.clientHeight - 24) / base.height));
    const dpr = Math.min(devicePixelRatio || 1, 2.5), vp = pg.getViewport({ scale: fit * dpr }), cv = q('#pcv');
    cv.width = vp.width; cv.height = vp.height; cv.style.width = vp.width / dpr + 'px'; cv.style.height = vp.height / dpr + 'px';
    task?.cancel?.();
    task = pg.render({ canvasContext: cv.getContext('2d'), viewport: vp });
    await task.promise.catch(() => {});
    if (my === tok) { q('#pn').textContent = `${cur} / ${doc.numPages}`; q('#pm').hidden = true; }
  }
  function go(d) { const n = Math.min(doc.numPages, Math.max(1, cur + d)); if (n !== cur) { cur = n; draw(); } }
  q('#pp').onclick = () => go(-1);
  q('#pnx').onclick = () => go(1);
  let x0 = null;
  q('.pstage').addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  q('.pstage').addEventListener('touchend', e => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); }, { passive: true });
  addEventListener('resize', draw);
  try {
    doc = await slideDoc(x.file_id);
    cur = Math.min(doc.numPages, Math.max(1, cur));
    await draw();
  } catch {
    q('#pm').textContent = "Couldn't open these slides.";
  }
}
function showSlide(el, c) {   // the card's source slide beside the question; the arrows page through the whole PDF, tapping opens the full viewer
  const refs = cardSlides(c), x = refs[0], pages = refs.filter(r => r.file_id === x.file_id).map(r => r.page);
  el.innerHTML = `<div class="spbox"><canvas></canvas><span class="spbadge" hidden></span><div class="spmsg">Loading slide…</div></div>
    ${pages.length > 1 ? `<div class="sprefs"><span>This question comes from slides</span>${pages.map(p => `<button type="button" class="dchip" data-p="${p}">${p}</button>`).join('')}</div>` : ''}
    <div class="spnav"><button class="spp" aria-label="Previous slide">‹</button><span class="splab"></span><button class="spn" aria-label="Next slide">›</button></div>`;
  const cv = el.querySelector('canvas'), msg = el.querySelector('.spmsg'), lab = el.querySelector('.splab'), badge = el.querySelector('.spbadge');
  let page = x.page, tok = 0, task, doc, name = '';
  const draw = async () => {
    const my = ++tok;
    msg.hidden = false; msg.textContent = 'Loading slide…';
    try {
      if (!doc) [name, doc] = await Promise.all([slideFile(x.file_id).then(f => f.file_name), slideDoc(x.file_id)]);
      page = Math.min(doc.numPages, Math.max(1, page));
      const pg = await doc.getPage(page);
      if (my !== tok) return;
      name = name.replace(/\.pdf$/i, '');
      lab.textContent = `${name} · ${page} / ${doc.numPages}`;
      badge.textContent = page; badge.hidden = false;
      el.querySelectorAll('[data-p]').forEach(b => b.classList.toggle('on', +b.dataset.p === page));
      const base = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: (el.clientWidth || 400) / base.width * Math.min(devicePixelRatio || 1, 2) });
      cv.width = vp.width; cv.height = vp.height;
      task?.cancel?.();
      task = pg.render({ canvasContext: cv.getContext('2d'), viewport: vp });
      await task.promise;
      if (my === tok) msg.hidden = true;
    } catch (e) { if (my === tok && e?.name !== 'RenderingCancelledException') msg.textContent = "Couldn't load this slide."; }
  };
  const go = d => { if (!doc) return; const n = Math.min(doc.numPages, Math.max(1, page + d)); if (n !== page) { page = n; draw(); } };
  el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { page = +b.dataset.p; draw(); });
  el.querySelector('.spp').onclick = () => go(-1);
  el.querySelector('.spn').onclick = () => go(1);
  cv.onclick = () => { if (doc && msg.hidden) enlargeSlide({ ...x, page }, name); };
  draw();
}

// ---- slides in the cloud: PDF goes to private storage, each page's text to the "slides" table (questions are generated from that text) ----
const MAX_CLOUD_PDF = 50 * 1024 * 1024;   // Supabase free-plan upload limit
async function uploadSlides(deckNames, files, say) {
  await loadPdfjs();
  await ensureDecks(deckNames);
  const uid = (await sb.auth.getUser()).data.user.id, notes = [];
  for (const f of files) {
    if (f.size > MAX_CLOUD_PDF) { notes.push(`"${f.name}" is over 50 MB, so it was skipped.`); continue; }
    const doc = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise, pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      say(`${f.name}: reading page ${p} of ${doc.numPages}…`);
      const t = await (await doc.getPage(p)).getTextContent();
      pages.push(t.items.map(i => i.str).join(' ').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim());
    }
    say(`${f.name}: saving…`);
    const path = `${uid}/${crypto.randomUUID()}.pdf`;   // stored once, however many decks it is attached to
    chk(await sb.storage.from('slides').upload(path, f, { contentType: 'application/pdf' }));
    try {   // cover image = first page, stored next to the PDF under the same name with .jpg
      const pg = await doc.getPage(1), w = pg.getViewport({ scale: 1 }).width, vp = pg.getViewport({ scale: 480 / w });
      const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
      await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      chk(await sb.storage.from('slides').upload(coverPath(path), await new Promise(r => cv.toBlob(r, 'image/jpeg', .8)), { contentType: 'image/jpeg' }));
    } catch {}   // no cover is fine, the tile shows an icon
    for (const deckName of deckNames) {   // each deck gets its own file row and page text, so each can be read and generated from separately
      const id = crypto.randomUUID();
      chk(await sb.from('slide_files').insert({ id, deck_id: cache.deckId.get(deckName), file_name: f.name, storage_path: path, page_count: doc.numPages }));
      for (const part of chunks(pages.map((body, i) => ({ file_id: id, page: i + 1, body })), 200)) chk(await sb.from('slides').insert(part));
    }
  }
  return notes;
}
// slides used to be saved only in this browser: move any left over into the account, attached to their deck, then clear them from the device
// ponytail: runs on every start until the device is empty; two tabs open at once could upload a file twice
async function migrateDevicePdfs() {
  let moved = 0;
  for (const k of (await metaKeys()).filter(k => typeof k === 'string' && k.startsWith('pdfs:'))) {
    const deck = k.slice(5);
    let keep = false;
    for (const p of (await deviceMeta(k)) || []) {
      try {
        const data = await pdfGet(pdfKey(deck, p.id));
        if (data && !cache.deckId.has(deck)) { keep = true; continue; }   // its deck is not in the account: leave it
        if (data) {
          const f = new File([data], p.name, { type: 'application/pdf' });
          if (f.size > MAX_CLOUD_PDF) { keep = true; continue; }   // too big for the account: leave it on the device rather than lose it
          await uploadSlides([deck], [f], () => {});
          moved++;
        }
        await pdfDel([pdfKey(deck, p.id)]);
      } catch { return moved; }   // offline or out of space: try again next start
    }
    if (!keep) await deviceMeta(k, true);
  }
  return moved;
}
// the two "add" popups share one shape: step 1 picks the file(s), step 2 connects them, and the last step can be skipped
const dropHtml = (id, title, sub, accept, multi) => `<label class="drop" id="${id}z">${svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/>', 30)}<b>${title}</b><small>${sub}</small><input type="file" id="${id}" accept="${accept}" ${multi ? 'multiple' : ''} hidden></label>`;
const bindDrop = (zone, onFiles) => {
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('over'); onFiles([...e.dataTransfer.files]); };
};
const stepper = (o, say) => (n, text) => { o.querySelectorAll('[data-step]').forEach(el => el.hidden = +el.dataset.step !== n); o.querySelector('#st').textContent = `Step ${n} of 2 · ${text}`; };
const sizeText = f => (f.size / 1048576).toFixed(1) + ' MB';
const pdfList = (files, id = 'fl') => files.map((f, i) => `<div class="ref ok"><span>✓</span><div><b>${esc(f.name)}</b><small>${sizeText(f)}</small></div><button type="button" class="fx" data-rm="${i}" aria-label="Remove ${esc(f.name)}">✕</button></div>`).join('');
const addPdfs = (list, incoming) => {   // append new PDFs, skipping repeats
  for (const f of incoming) if (/\.pdf$/i.test(f.name) && !list.some(x => x.name === f.name && x.size === f.size)) list.push(f);
};

function uploadDialog(pre = '') {
  const cards = [...cache.cards.values()], decks = [...new Set(cards.map(c => c.deck))].sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || a.localeCompare(b));
  const nq = d => cards.filter(c => c.deck === d).length, refs = d => cards.filter(c => c.deck === d && c.file).map(c => c.file);
  let pdfs = [], picked = new Set(pre ? [pre] : []), auto = new Set();
  modal(`<div class="dlg"><div><h2>Upload slides</h2><p class="dstep" id="st"></p></div>
    <div class="dsec" data-step="1">
      ${dropHtml('pf', 'Choose PDFs', 'Tap here, or drop them in. Up to 50 MB each.', 'application/pdf,.pdf', true)}
      <div id="fl"></div>
    </div>
    <div class="dsec" data-step="2" hidden>
      <p class="dnote" id="dhelp"></p>
      ${decks.length > 6 ? '<input class="inp" id="dq" type="search" placeholder="Search decks" autocomplete="off">' : ''}
      <div class="dlist" id="dl"></div>
    </div>
    <div class="row end" data-step="1"><button id="c">Cancel</button><button class="p" id="nx" disabled>Next</button></div>
    <div class="row end" data-step="2" hidden><button id="bk">Back</button><button class="p" id="ok">Upload</button></div>
    <p class="err" id="er"></p></div>`, (o, close) => {
    const q = s => o.querySelector(s), go = stepper(o);
    const drawFiles = () => { q('#fl').innerHTML = pdfList(pdfs); q('#nx').disabled = !pdfs.length; q('#fl').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { pdfs.splice(+b.dataset.rm, 1); drawFiles(); }); };
    const take = fs => { addPdfs(pdfs, fs); q('#er').textContent = ''; drawFiles(); };
    q('#pf').onchange = e => { take([...e.target.files]); e.target.value = ''; };
    bindDrop(q('#pfz'), take);
    const label = () => { q('#ok').textContent = picked.size ? `Upload to ${picked.size} deck${picked.size === 1 ? '' : 's'}` : 'Skip and upload'; };
    const drawDecks = () => {
      const term = (q('#dq')?.value || '').toLowerCase(), folders = new Map();
      decks.filter(d => !term || d.toLowerCase().includes(term)).forEach(d => folders.set(folderOf(d), [...(folders.get(folderOf(d)) || []), d]));
      q('#dl').innerHTML = decks.length ? ([...folders].map(([f, ds]) => `<p class="dlbl">${esc(f)}</p>${ds.map(d => `<button type="button" class="drow${picked.has(d) ? ' on' : ''}" data-d="${esc(d)}"><span class="dchk">✓</span><span><span class="dname">${esc(lectureOf(d))}</span><small>${nq(d)} question${nq(d) === 1 ? '' : 's'}${auto.has(d) ? ' · mentions these files' : ''}</small></span></button>`).join('')}`).join('') || '<p class="dnote">No decks match.</p>') : '';
      q('#dl').querySelectorAll('.drow').forEach(b => b.onclick = () => { const d = b.dataset.d; picked.has(d) ? picked.delete(d) : picked.add(d); b.classList.toggle('on'); label(); });
      label();
    };
    q('#nx').onclick = () => {
      auto = new Set(decks.filter(d => refs(d).some(r => pdfs.some(f => fileMatches(f.name, r)))));   // decks whose questions name these files are ticked for you
      auto.forEach(d => picked.add(d));
      q('#dhelp').textContent = decks.length ? (auto.size ? 'Decks that mention these files are already ticked. Tick any others, or untick to skip.' : 'Tick the decks these slides belong to, or skip and attach them later.') : 'You have no decks yet. The slides will wait in "Unsorted slides", and a deck you add later that mentions them will pick them up.';
      if (q('#dq')) q('#dq').oninput = drawDecks;
      drawDecks(); go(2, 'Choose the decks');
    };
    q('#bk').onclick = () => go(1, 'Choose your PDFs');
    q('#c').onclick = close;
    q('#ok').onclick = async () => {
      const to = picked.size ? [...picked] : ['Unsorted slides'];
      q('#ok').disabled = q('#bk').disabled = true;
      try {
        const notes = await uploadSlides(to, pdfs, t => q('#er').textContent = t);
        close(); home(['Slides uploaded.', ...(picked.size ? [] : ['They are in "Unsorted slides" until you attach them to a deck.']), ...notes].join(' '));
      } catch (e) { q('#ok').disabled = q('#bk').disabled = false; q('#er').textContent = oops(e, 'Upload failed. Check your connection and try again.'); }
    };
    go(1, 'Choose your PDFs'); drawFiles();
  });
}
// ---- AI generation: the "generate" Edge Function writes up to 10 questions per call; we call it until we have enough ----
async function callGenerate(body) {
  const { data, error } = await sb.functions.invoke('generate', { body });
  if (!error) return data;
  let m = {}; try { m = await error.context.json(); } catch {}
  throw Object.assign(new Error(m.error || 'Something went wrong. Try again.'), { code: m.code, friendly: true });
}
// ---- the Generate tab: pick slides (existing or new), a deck (existing or new), a folder for a new deck, how many questions, then Generate ----
const GEN = { src: 'existing', sel: new Set(), pdfs: [], deckMode: 'existing', nameMode: 'auto', deck: '', newDeck: '', folder: '', newFolder: '', count: 30 };   // kept between redraws; sel holds slide file storage paths
let genCtx = null;   // { files, by } for the page on screen
const GEN_MAX = 100, GEN_PAGES = 60;   // questions per run, and pages the AI reads in one go (see generate/index.ts)
const segHtml = (cur, attr, opts) => `<div class="seg2">${opts.map(([k, l]) => `<button type="button" ${attr}="${k}" class="${k === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
// the same PDF can sit in several decks (one file row each): reach the row that belongs to this deck, attaching it first when needed
const slideRowId = async (f, deckName) => {
  await attachExisting(f, deckName);
  return chk(await sb.from('slide_files').select('id').eq('deck_id', cache.deckId.get(deckName)).eq('storage_path', f.storage_path))[0].id;
};
// split the slide files into reads of at most GEN_PAGES pages
function planWindows(files, max = GEN_PAGES) {
  const wins = [], small = [];
  for (const f of files) {
    if (f.page_count > max) for (let p = 1; p <= f.page_count; p += max) wins.push({ ids: [f.id], from: p, to: Math.min(f.page_count, p + max - 1), pages: Math.min(max, f.page_count - p + 1) });
    else small.push(f);
  }
  let cur = null;
  for (const f of small) { if (!cur || cur.pages + f.page_count > max) wins.push(cur = { ids: [], pages: 0 }); cur.ids.push(f.id); cur.pages += f.page_count; }
  return wins;
}
// "Auto" deck name: the slide file's title (a few files: the first, plus how many more), made unique
function autoDeckName(fileNames) {
  const t = fileNames.map(n => String(n || '').replace(/\.pdf$/i, '').replace(/_+/g, ' ').trim()).filter(Boolean);
  const base = ((t[0] || 'New deck') + (t.length > 1 ? ` + ${t.length - 1} more` : '')).slice(0, 80);
  let name = base, i = 2;
  while ([...cache.cards.values()].some(c => c.deck === name)) name = `${base} (${i++})`;
  return name;
}
function generateBody({ files, by, dn, covers, note }) {
  const cards = [...cache.cards.values()], qn = new Map();
  cards.forEach(c => qn.set(c.deck, (qn.get(c.deck) || 0) + 1));
  const decks = [...new Set([...qn.keys(), ...by.keys()])].filter(d => d && d !== 'Unsorted slides').sort((a, b) => a.localeCompare(b));
  const folders = allFolders(cards);
  if (!decks.includes(GEN.deck)) GEN.deck = decks[0] || '';
  if (!decks.length) GEN.deckMode = 'new';
  const seen = new Set(), pdfs = files.filter(f => !seen.has(f.storage_path) && seen.add(f.storage_path));   // one tile per stored PDF
  const source = GEN.src === 'existing'
    ? (pdfs.length ? `<div class="gpick">${pdfs.map(f => `<div class="prow${GEN.sel.has(f.storage_path) ? ' sel' : ''}" data-gf="${esc(f.storage_path)}" role="button" tabindex="0"><span class="pcov">${covers.get(f.id) ? `<img src="${esc(covers.get(f.id))}" alt="">` : slidesIco()}</span><span class="pinfo"><b>${esc(f.file_name.replace(/\.pdf$/i, ''))}</b><small>${[dn.get(f.deck_id) ? esc(lectureOf(dn.get(f.deck_id))) : '', f.page_count + ' page' + (f.page_count === 1 ? '' : 's')].filter(Boolean).join(' · ')}</small></span><span class="dchk">✓</span></div>`).join('')}</div><p class="fine" id="gsel">${GEN.sel.size} selected</p>` : '<p class="dnote">You have no slides yet. Upload new slides instead.</p>')
    : `${dropHtml('gpf', 'Choose PDFs', 'Tap here, or drop them in. Up to 50 MB each.', 'application/pdf,.pdf', true)}<div id="gfl">${pdfList(GEN.pdfs)}</div>`;
  const deckPart = `${decks.length ? segHtml(GEN.deckMode, 'data-gdm', [['existing', 'Existing deck'], ['new', 'New deck']]) : ''}
    ${GEN.deckMode === 'existing' ? `<select class="inp" id="gdk" aria-label="Deck">${decks.map(d => `<option value="${esc(d)}" ${d === GEN.deck ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>`
      : `${segHtml(GEN.nameMode, 'data-gnm', [['auto', 'Auto name'], ['custom', 'Type a name']])}${GEN.nameMode === 'custom' ? `<input class="inp" id="gdn" maxlength="80" placeholder="Name of the new deck, e.g. Cardiac cycle" value="${esc(GEN.newDeck)}" autocomplete="off">` : '<p class="fine">Named after your slides, for example “Thorax overview”.</p>'}`}`;
  const folderPart = GEN.deckMode === 'new' ? `<div class="dsec"><p class="dlbl">Folder</p>
      <select class="inp" id="gfs" aria-label="Folder"><option value="">Auto (from the deck name)</option>${folders.map(f => `<option value="${esc(f)}" ${f === GEN.folder ? 'selected' : ''}>${esc(f)}</option>`).join('')}<option value="__new" ${GEN.folder === '__new' ? 'selected' : ''}>+ New folder…</option></select>
      <input class="inp" id="gfn" maxlength="40" placeholder="New folder name" value="${esc(GEN.newFolder)}" ${GEN.folder === '__new' ? '' : 'hidden'}></div>` : '';
  const mine = decks.filter(d => qn.get(d));
  return `<div class="toprow"><div><h1 class="pt">Generate with AI</h1><p class="tag">the AI writes exam-style questions from your slides</p></div></div>
    <div class="gwrap"><section class="card gform">
      <div class="dlg"><div class="dsec"><p class="dlbl">1 · Slides</p>${segHtml(GEN.src, 'data-gsrc', [['existing', 'My slides'], ['new', 'Upload new']])}${source}</div></div>
      <div class="dlg"><div class="dsec"><p class="dlbl">2 · Deck</p>${deckPart}</div>
      ${folderPart}
      <div class="dsec"><p class="dlbl">${GEN.deckMode === 'new' ? '4' : '3'} · How many questions</p>
        <div class="gcount"><input type="range" id="gcr" min="1" max="${GEN_MAX}" value="${GEN.count}" aria-label="Number of questions"><input class="inp" type="number" id="gcn" min="1" max="${GEN_MAX}" value="${GEN.count}" inputmode="numeric" aria-label="Number of questions"></div>
        <p class="fine">Most decks use about 30. The most you can ask for at once is ${GEN_MAX}. Every topic gets a question first; if you ask for more, the main topics come back from a new angle.</p></div>
      <div class="dsec"><button class="p gbig" id="ggo">Generate questions</button><p class="err" id="ger"></p>
        <p class="fine gnote">${note}</p><p class="fine gnote">AI can make mistakes. Report any that look wrong.</p></div></div>
    </section>
    ${mine.length ? `<h2 class="sgh">Your decks</h2><div class="gdecks">${mine.map(d => `<section class="card gdeck"><div><h2 style="margin:0 0 4px">${esc(lectureOf(d))}</h2><p style="margin:0">${esc(folderOf(d))} · ${qn.get(d)} question${qn.get(d) === 1 ? '' : 's'} · ${(by.get(d) || []).length} slide file${(by.get(d) || []).length === 1 ? '' : 's'}</p></div><button class="p" data-more="${esc(d)}">Generate more</button></section>`).join('')}</div>` : ''}</div>`;
}
function bindGenerate() {
  if (!genCtx) return;
  const { files, by } = genCtx, q = s => $.querySelector(s), er = t => { const e = q('#ger'); if (e) e.textContent = t; };
  $.querySelectorAll('[data-gsrc]').forEach(b => b.onclick = () => { GEN.src = b.dataset.gsrc; home(); });
  $.querySelectorAll('[data-gnm]').forEach(b => b.onclick = () => { GEN.nameMode = b.dataset.gnm; home(); });
  $.querySelectorAll('[data-gdm]').forEach(b => b.onclick = () => { GEN.deckMode = b.dataset.gdm; home(); });
  $.querySelectorAll('[data-gf]').forEach(b => b.onclick = () => { const p = b.dataset.gf; GEN.sel.has(p) ? GEN.sel.delete(p) : GEN.sel.add(p); b.classList.toggle('sel'); q('#gsel').textContent = GEN.sel.size + ' selected'; });
  const drawPdfs = () => { q('#gfl').innerHTML = pdfList(GEN.pdfs); q('#gfl').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { GEN.pdfs.splice(+b.dataset.rm, 1); drawPdfs(); }); };
  if (q('#gpf')) {
    const take = fs => { addPdfs(GEN.pdfs, fs); drawPdfs(); };
    q('#gpf').onchange = e => { take([...e.target.files]); e.target.value = ''; };
    bindDrop(q('#gpfz'), take);
    drawPdfs();
  }
  if (q('#gdk')) q('#gdk').onchange = e => { GEN.deck = e.target.value; };
  if (q('#gdn')) q('#gdn').oninput = e => { GEN.newDeck = e.target.value; };
  if (q('#gfs')) q('#gfs').onchange = e => { GEN.folder = e.target.value; q('#gfn').hidden = GEN.folder !== '__new'; if (!q('#gfn').hidden) q('#gfn').focus(); };
  if (q('#gfn')) q('#gfn').oninput = e => { GEN.newFolder = e.target.value; };
  const setCount = (n, from) => { GEN.count = Math.max(1, Math.min(GEN_MAX, Math.floor(+n) || 1)); if (from !== 'r') q('#gcr').value = GEN.count; if (from !== 'n') q('#gcn').value = GEN.count; };
  q('#gcr').oninput = e => setCount(e.target.value, 'r');
  q('#gcn').oninput = e => { if (e.target.value !== '') setCount(e.target.value, 'n'); };
  q('#gcn').onblur = () => setCount(q('#gcn').value || 30);
  $.querySelectorAll('[data-more]').forEach(b => b.onclick = () => {   // Generate more: that deck, with its own slides ticked
    GEN.src = 'existing'; GEN.deckMode = 'existing'; GEN.deck = b.dataset.more;
    GEN.sel = new Set((by.get(b.dataset.more) || []).map(f => f.storage_path));
    home().then(() => { $.scrollTop = 0; });
  });
  q('#ggo').onclick = async () => {
    er('');
    const count = Math.max(1, Math.min(GEN_MAX, Math.floor(+GEN.count) || 30)), isNew = GEN.deckMode === 'new';
    let deck = isNew ? GEN.newDeck.trim() : GEN.deck;
    if (GEN.src === 'existing' && !GEN.sel.size) return er('Tap at least one slide file, or choose Upload new slides.');
    if (GEN.src === 'new' && !GEN.pdfs.length) return er('Choose the PDFs to read first.');
    if (isNew && GEN.nameMode === 'auto') deck = autoDeckName(GEN.src === 'existing' ? [...GEN.sel].map(p => files.find(x => x.storage_path === p)?.file_name) : GEN.pdfs.map(f => f.name));
    if (!deck) return er(isNew ? 'Give the new deck a name, or choose Auto name.' : 'Choose a deck.');
    if (isNew && [...cache.cards.values()].some(c => c.deck === deck)) return er('You already have a deck with that name. Pick Existing deck, or choose another name.');
    let folder = isNew ? (GEN.folder === '__new' ? GEN.newFolder.trim() : GEN.folder) : '';
    if (isNew && GEN.folder === '__new' && !folder) return er('Type a name for the new folder.');
    q('#ggo').disabled = true;
    let added = 0, supported = count, err = null;
    try {
      const say = t => er(t);
      await ensureDecks([deck]);
      if (folder) {
        folder = allFolders([...cache.cards.values()]).find(x => x.toLowerCase() === folder.toLowerCase()) || folder;
        FM.assign[deck] = folder; if (!FM.folders.includes(folder)) FM.folders.push(folder); await saveFM();
      }
      let rows = [];
      if (GEN.src === 'existing') {
        for (const p of GEN.sel) { const f = files.find(x => x.storage_path === p); if (f) rows.push({ id: await slideRowId(f, deck), page_count: f.page_count }); }
      } else {
        await uploadSlides([deck], GEN.pdfs, say);
        rows = chk(await sb.from('slide_files').select('id,page_count').eq('deck_id', cache.deckId.get(deck)).in('file_name', GEN.pdfs.map(f => f.name)));
      }
      // 1. the AI lists the concepts in each read of the slides and ranks them; 2. assignSlots picks which to write (every concept once, then variations on the most important); 3. each batch writes its assigned questions
      const wins = planWindows(rows);
      await guideReady;
      if (!GUIDE) throw new Error("Couldn't load the question guide. Check your connection and try again.");
      const concepts = [];
      let objectives = [];
      const planWin = async wi => {
        const w = wins[wi], r = await callGenerate({ deck, fileIds: w.ids, fromPage: w.from, toPage: w.to, plan: true, objectives });
        (r.concepts || []).forEach((c, i) => concepts.push({ ...c, win: wi, order: wi * 1000 + i }));
        return r.objectives || [];
      };
      say('Reading your slides… this can take a minute.');
      objectives = await planWin(0);   // the first read usually holds the objectives slide; every later read ranks against them
      await Promise.all(wins.slice(1).map((_, i) => planWin(i + 1)));
      const plan = assignSlots(concepts, count, GUIDE.angles);
      supported = plan.supported;
      for (const [wi, w] of wins.entries()) {
        const mine = plan.slots.filter(s => s.win === wi);
        for (let i = 0; i < mine.length; i += 10) {
          say(added ? `Writing questions… ${added} of ${plan.slots.length}` : 'Writing questions… this can take a minute.');
          const batch = mine.slice(i, i + 10), r = await callGenerate({ deck, fileIds: w.ids, fromPage: w.from, toPage: w.to, slots: batch.map(({ concept, angle, pages }) => ({ concept, angle, pages })) });
          added += r.added;
          if (!r.added) break;   // the monthly limit was reached, or the AI wrote nothing usable
        }
      }
    } catch (e) { console.error(e); err = e.friendly ? e : new Error('Something went wrong. Try again.'); }
    if (added) { ready = loadAll(); await ready; }
    if (!err || added) { GEN.pdfs = []; GEN.sel = new Set(); GEN.newDeck = ''; }
    view = 'generate';
    if (err && !added) { await home(); er(err.message); return; }
    const short = supported < count ? ` These slides support ${supported} good question${supported === 1 ? '' : 's'}, so that is as many as could be written.` : '';
    home(added ? `Added ${added} question${added === 1 ? '' : 's'} to "${deck}".${short}${err ? ' ' + err.message : ''}` : 'No new questions were written. The slides may not have enough new material.');
  };
}

// slide files are matched to a question's "file" name by the same loose rule everywhere (a file name that contains the name, ignoring case and .pdf)
const normName = s => String(s || '').toLowerCase().replace(/\.pdf$/, '').trim();
const fileMatches = (fileName, ref) => !!normName(ref) && normName(fileName).includes(normName(ref));
// reuse a PDF that is already stored: the deck gets its own file row and page text, the PDF itself is not uploaded again
async function attachExisting(f, deckName) {
  await ensureDecks([deckName]);
  const did = cache.deckId.get(deckName);
  if (chk(await sb.from('slide_files').select('id').eq('deck_id', did).eq('storage_path', f.storage_path)).length) return false;
  const id = crypto.randomUUID(), pages = chk(await sb.from('slides').select('page,body').eq('file_id', f.id).order('page').limit(5000));
  chk(await sb.from('slide_files').insert({ id, deck_id: did, file_name: f.file_name, storage_path: f.storage_path, page_count: f.page_count }));
  for (const part of chunks(pages.map(p => ({ file_id: id, ...p })), 200)) chk(await sb.from('slides').insert(part));
  return true;
}
// "Report a bad question": saved to the reports table (you read them in Supabase) and marked on the card
const REPORT_REASONS = ['Wrong answer marked', 'More than one answer could be right', 'Unclear or badly worded', 'Too easy or too obvious', 'Not from my slides', 'Something else'];
function reportDialog(c, done) {
  modal(`<div class="dlg"><h2>Report this question</h2><p>What is wrong with it? Pick all that apply. It is hidden from your studying until you restore it in Settings, and your report helps make future questions better.</p>
    <div class="dpick" id="rr">${REPORT_REASONS.map(r => `<button type="button" class="dchip" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
    <textarea class="inp" id="rnote" rows="3" maxlength="500" placeholder="Anything else? (optional)"></textarea>
    <div class="row end"><button id="c">Cancel</button><button class="p" id="ok">Send report</button></div><p class="err" id="er"></p></div>`, (o, close) => {
    const q = s => o.querySelector(s);
    o.querySelectorAll('.dchip').forEach(b => b.onclick = () => b.classList.toggle('on'));
    q('#c').onclick = close;
    q('#ok').onclick = async () => {
      const reasons = [...o.querySelectorAll('.dchip.on')].map(b => b.dataset.r), note = q('#rnote').value.trim();
      if (!reasons.length && !note) { q('#er').textContent = 'Pick a reason or write a note.'; return; }
      q('#ok').disabled = true;
      try {
        chk(await sb.from('reports').insert({ deck: c.deck, question_key: c.id, source: c.source || 'imported', stem: c.stem, options: c.options, answer: c.answer, explanation: c.explanation || '', reasons, note: note || null }));
        c.flagged = true; await putMany('cards', [c]);
        close(); done();
      } catch (e) { q('#ok').disabled = false; q('#er').textContent = oops(e, 'Could not send the report. Try again in a moment.'); }
    };
  });
}
async function importDialog(pre = '') {
  const folders = allFolders(await all('cards'));
  const have = chk(await sb.from('slide_files').select('id,file_name,storage_path,deck_id,page_count'));   // every slide file already in the account
  let deck = null, names = [], pdfs = [], json = null;
  modal(`<div class="dlg"><div><h2>Add a deck</h2><p class="dstep" id="st"></p></div>
    <div class="dsec" data-step="1">
      ${dropHtml('fi', 'Choose a deck file', 'The .json file the AI made. Tap here, or drop it in.', '.json,application/json', false)}
      <div id="rs"></div>
      <p class="dlbl">Folder</p>
      <select class="inp" id="fs"><option value="">Auto (from the deck name)</option>${folders.map(f => `<option value="${esc(f)}" ${f === pre ? 'selected' : ''}>${esc(f)}</option>`).join('')}<option value="__new">+ New folder…</option></select>
      <input class="inp" id="fn" maxlength="40" placeholder="New folder name" hidden>
    </div>
    <div class="dsec" data-step="2" hidden>
      <div id="rl"></div>
      ${dropHtml('pf', 'Attach slides (PDFs)', 'Optional. Tap here, or drop them in.', 'application/pdf,.pdf', true)}
      <div id="fl"></div>
    </div>
    <div class="row end" data-step="1"><button id="c">Cancel</button><button class="p" id="nx" disabled>Next</button></div>
    <div class="row end" data-step="2" hidden><button id="bk">Back</button><button class="p" id="ok">Add deck</button></div>
    <p class="err" id="er"></p></div>`, (o, close) => {
    const q = s => o.querySelector(s), er = t => q('#er').textContent = t, go = stepper(o);
    const found = n => have.find(f => fileMatches(f.file_name, n)), attached = n => pdfs.some(p => fileMatches(p.name, n));
    const rows = () => {   // which slide files the deck refers to: already in the account, attached now, or missing
      const did = cache.deckId.get(deck.deck), own = did ? have.filter(f => f.deck_id === did).length : 0;
      const nums = deck.questions.filter(x => x.slide ?? x.slides).length;
      return names.map(n => { const st = attached(n) ? ['ok', 'attached, will be uploaded'] : found(n) ? ['ok', 'already in your account, will be linked'] : ['no', 'not found, attach it below']; return `<div class="ref ${st[0]}"><span>${st[0] === 'ok' ? '✓' : '!'}</span><div><b>${esc(n)}</b><small>${st[1]}</small></div></div>`; }).join('')
        || (nums ? `<p class="dnote">${own ? `This deck already has ${own} slide file${own === 1 ? '' : 's'}, so its questions link to them.` : 'The questions point to slide numbers. Attach the PDF and they link automatically.'}</p>` : '<p class="dnote">This file has no slide links. You can still attach PDFs to the deck, or skip.</p>');
    };
    const paint = () => {
      q('#rl').innerHTML = rows();
      q('#rs').innerHTML = names.length ? '<p class="dlbl">Slides it uses</p>' + rows() : '';
      const own = (cache.deckId.get(deck.deck) ? have.filter(f => f.deck_id === cache.deckId.get(deck.deck)).length : 0);
      q('#fl').innerHTML = pdfList(pdfs);
      q('#fl').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { pdfs.splice(+b.dataset.rm, 1); paint(); });
      q('#ok').textContent = pdfs.length || names.some(found) || own ? 'Add deck' : 'Skip slides and add deck';
    };
    const pick = async f => {
      if (!f) return;
      let d; try { d = JSON.parse((await f.text()).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { er('That is not a valid JSON file.'); return; }
      const errs = validateDeck(d);
      if (errs.length) { er('This deck file has problems:\n' + errs.slice(0, 5).join('\n')); return; }
      er(''); deck = d; json = f;
      names = [...new Set(d.questions.map(x => typeof x.file === 'string' ? x.file.trim() : '').filter(Boolean))];
      const dz = q('#fiz'); dz.classList.add('has'); dz.querySelector('b').textContent = d.deck;
      dz.querySelector('small').textContent = `${d.questions.length} question${d.questions.length === 1 ? '' : 's'} · tap to choose a different file`;
      q('#nx').disabled = false; paint();
    };
    q('#fi').onchange = e => pick(e.target.files[0]);
    bindDrop(q('#fiz'), fs => pick(fs[0]));
    const take = fs => { addPdfs(pdfs, fs); paint(); };
    q('#pf').onchange = e => { take([...e.target.files]); e.target.value = ''; };
    bindDrop(q('#pfz'), take);
    q('#fs').onchange = () => { q('#fn').hidden = q('#fs').value !== '__new'; if (!q('#fn').hidden) q('#fn').focus(); };
    q('#nx').onclick = () => {
      if (q('#fs').value === '__new' && !q('#fn').value.trim()) { er('Type a name for the new folder first.'); return; }
      er(''); paint(); go(2, 'Slides');
    };
    q('#bk').onclick = () => go(1, 'Choose the deck file');
    q('#c').onclick = close;
    q('#ok').onclick = async () => {
      let folder = q('#fs').value;
      if (folder === '__new') { folder = q('#fn').value.trim(); folder = folders.find(x => x.toLowerCase() === folder.toLowerCase()) || folder; }
      q('#ok').disabled = q('#bk').disabled = true; er('Importing…');
      let msg = await importFile(json, folder);
      if (!lastDeck) { close(); return home(msg); }
      try {
        let linked = 0;
        for (const n of names) { const f = !attached(n) && found(n); if (f && await attachExisting(f, lastDeck)) linked++; }
        if (linked) msg += ` Linked ${linked} slide file${linked === 1 ? '' : 's'} already in your account.`;
        if (pdfs.length) msg += ' ' + ['Slides uploaded.', ...await uploadSlides([lastDeck], pdfs, er)].join(' ');
      } catch (err) { msg += oops(err, ' The slides could not be linked. You can add them in the Slides tab.'); }
      const missing = names.filter(n => !attached(n) && !found(n));
      if (missing.length) msg += ` Missing slides: ${missing.join(', ')}. Add them in the Slides tab.`;
      close(); home(msg);
    };
    go(1, 'Choose the deck file');
  });
}

// ---- home ----
async function home(msg = '') {
  onkeydown = null;
  document.body.classList.remove('studying');
  renderNav();
  await loadFM();
  if (view !== 'slides') slideSel = null;
  const [allCards, logs, slideN] = await Promise.all([all('cards'), all('logs'), view === 'decks' || view === 'today' ? slideCounts() : new Map()]);
  const cards = allCards.filter(c => !c.flagged), reported = allCards.filter(c => c.flagged);   // a reported question is hidden from studying and stats until it is restored in Settings
  const now = Date.now(), today = dayKey(now);
  const banner = `${msg ? `<div class="msg ${/failed|valid JSON/.test(msg) ? 'err' : ''}">${esc(msg)}</div>` : ''}`;
  const todoOf = cs => cs.filter(c => !c.reps || c.due <= now).length;
  const trash = svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>', 20);
  const delBadge = (attr, v) => editing ? `<span class="del" data-${attr}="${esc(v)}" role="button" aria-label="Delete">${trash}</span>` : '';
  const renBadge = (attr, v) => editing ? `<span class="ren" data-${attr}="${esc(v)}" role="button" aria-label="Rename">${svg('<path d="M4 20h4L19 9l-4-4L4 16zM13.500 6.500l4 4"/>', 20)}</span>` : '';
  const editBtn = `<button class="edit${editing ? ' on' : ''}" data-act="edit">${editing ? 'Done' : 'Edit'}</button>`;
  const slidesChip = d => { const n = slideN.get(d) || 0; return editing ? '' : `<span class="sl${n ? ' on' : ''}" role="button" data-slides="${esc(d)}" data-n="${n}" aria-label="Slides">${slidesIco()}${n > 1 ? 'Slides · ' + n : n ? 'Slides' : '+ Slides'}</span>`; };
  const deckCard = (d, withFolder) => {
    const cs = cards.filter(c => c.deck === d), n = cs.length, todo = todoOf(cs), mat = cs.filter(c => c.interval >= 21).length;
    return `<button class="deckcard${editing ? ' editing' : ''}" data-deck="${esc(d)}" ${todo ? '' : 'data-practice="1"'}>${delBadge('deldeck', d)}${renBadge('rendeck', d)}
      ${withFolder ? `<span class="fl">${folderSvg(18, folderOf(d))}${esc(folderOf(d))}</span>` : ''}<span class="dn">${esc(lectureOf(d))}</span>
      <span class="dm"><small>${n} question${n === 1 ? '' : 's'}</small>${todo ? `<b class="due">${todo} to do</b>` : '<b class="due done">All done</b>'}</span>
      <span class="bar2"><i style="width:${Math.round(100 * mat / n)}%"></i></span>
      <span class="dfoot">${slidesChip(d)}<span class="go">${todo ? 'Study' : 'Practice'} ›</span></span></button>`;
  };
  let body = '';

  if (view === 'today') {
    const decks = [...new Set(cards.map(c => c.deck))].sort();
        const hp = (k, col, v, t) => `<span class="hp" style="color:${col}" title="${t}">${fsvg(k, 'currentColor', 46)}${v}</span>`;
    if (folder && !allFolders(cards).includes(folder)) folder = null;
    if (!folder) editing = false;
    const scope = folder ? cards.filter(c => folderOf(c.deck) === folder) : cards;
    const sDue = scope.filter(c => c.reps && c.due <= now).length, sNew = scope.filter(c => !c.reps).length;
    const wr = wrongIds(logs), nWrong = scope.filter(c => wr.has(c.id)).length;
    const mode = smode || (sDue ? 'due' : sNew ? 'new' : nWrong ? 'wrong' : 'due'), cnt = { due: sDue, new: sNew, wrong: nWrong }[mode];
    const left = folder ? 'in this folder' : '';
    const head = folder
      ? `<button class="crumb" id="up">${svg('<path d="m15 6-6 6 6 6"/>', 22)} All folders</button><h1 class="pt">${esc(folder)}</h1><p class="tag">${new Set(scope.map(c => c.deck)).size} deck${new Set(scope.map(c => c.deck)).size === 1 ? '' : 's'} · ${scope.length} questions</p>`
      : '<h1 class="pt">Today</h1><p class="tag">the antidote to medical exam stress</p>';
    let list;
    if (folder) {
      const ds = [...new Set(scope.map(c => c.deck))].sort();
      list = `<h2>Decks</h2><div class="deckgrid">${ds.map(d => deckCard(d)).join('')}<button class="addtile" data-act="adddeck" data-pre="${esc(folder)}">${svg('<path d="M12 5v14M5 12h14"/>', 44)}<span>Add deck</span></button></div>`;
    } else if (!cards.length && !FM.folders.length) list = '<p class="tag emptynote">No decks yet. Open the Folders or Decks tab and tap + to add one.</p>';
    else list = `<h2>Folders</h2><div class="folders">${allFolders(cards).map(f => {
      const cs = cards.filter(c => folderOf(c.deck) === f), nd = new Set(cs.map(c => c.deck)).size, todo = todoOf(cs), mat = cs.filter(c => c.interval >= 21).length;
      return `<button class="folder${editing ? ' editing' : ''}" data-folder="${esc(f)}">${delBadge('delfolder', f)}${renBadge('renfolder', f)}<span class="fic">${folderSvg(64, f)}</span>
        <span class="ftx"><span class="nm">${esc(f)}</span><small>${nd} deck${nd === 1 ? '' : 's'} · ${cs.length} questions</small><span class="bar2"><i style="width:${cs.length ? Math.round(100 * mat / cs.length) : 0}%"></i></span></span>${todo ? `<b class="badge2">${todo}</b>` : ''}</button>`;
    }).join('')}</div>`;
    body = `<div class="toprow"><div>${head}</div>
      <div class="hud">${hp('flame', '#ff9600', streak(logs), 'day streak')}${folder && scope.length ? editBtn : ''}</div></div>
    ${banner}
    <div class="herow"><section class="hero">
      <div><span class="big">${cnt}</span><span class="lbl">${cnt || !scope.length ? { due: 'questions due', new: 'new questions', wrong: 'to redo' }[mode] : { due: 'all done for today', new: 'no new questions', wrong: 'nothing to redo' }[mode]} ${left}</span><div class="sub">${sDue} due · ${sNew} new · ${streak(logs)} day streak</div>
        <button class="hct${hideCh ? ' on' : ''}" id="hc" aria-pressed="${hideCh}">Hide choices first: ${hideCh ? 'On' : 'Off'}</button></div>
      <div class="sess"><div class="chips">${[['due', 'Due', sDue], ['new', 'New', sNew], ['wrong', 'Wrong', nWrong]].map(([m, l, n]) => `<button class="chip${m === mode ? ' on' : ''}" data-mode="${m}">${l}<small>${n}</small></button>`).join('')}</div>
        <div class="chips">${[10, 20, 30, 40].map(n => `<button class="chip${n === sess ? ' on' : ''}" data-size="${n}">${n}</button>`).join('')}</div>
        ${cnt ? `<button id="all" data-mode="${mode}" data-limit="${sess}" ${folder ? `data-folder="${esc(folder)}"` : ''}>Start ${Math.min(cnt, sess)} question${Math.min(cnt, sess) === 1 ? '' : 's'}</button>` : scope.length ? `<button id="all" data-practice="1" data-limit="${sess}" ${folder ? `data-folder="${esc(folder)}"` : ''}>Practice anyway</button>` : ''}</div>
    </section></div>
    ${list}`;
  } else if (view === 'more') {
    const row = (v, t, d) => `<button class="morerow" data-go="${v}"><span class="mi">${svg(ICONS[v], 28)}</span><span class="mt"><b>${t}</b><small>${d}</small></span><span class="chv">›</span></button>`;
    body = `<h1 class="pt">More</h1><div style="height:20px"></div>${banner}
    <div class="morelist">${row('slides', 'Slides', 'Your uploaded slides, by deck')}${row('generate', 'Generate', 'Write questions from your slides with AI')}${row('community', 'Community', 'Decks shared by other students')}${row('subscription', 'Subscription', 'Your plan and AI usage')}${row('guide', 'Guide', 'How it works and installing the app')}${row('settings', 'Settings', 'Theme, sounds and reminders')}</div>`;
  } else if (view === 'decks') {
    const names = [...new Set(cards.map(c => c.deck))].sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || a.localeCompare(b));
    body = `<div class="toprow"><div><h1 class="pt">All decks</h1><p class="tag">${names.length ? names.length + ' deck' + (names.length === 1 ? '' : 's') + ' · tap one to study it' : 'tap + to add your first deck'}</p></div>
      <div class="tbtns">${names.length ? editBtn : ''}<button class="p plus" data-act="adddeck" aria-label="Add deck">${svg('<path d="M12 5v14M5 12h14"/>', 30)}</button></div></div>${banner}
    <div class="deckgrid">${names.map(d => deckCard(d, true)).join('')}<button class="addtile" data-act="adddeck">${svg('<path d="M12 5v14M5 12h14"/>', 44)}<span>Add deck</span></button></div>`;
  } else if (view === 'folders') {
    const names = allFolders(cards);
    body = `<div class="toprow"><div><h1 class="pt">Folders</h1><p class="tag">${names.length ? 'tap a folder to open it' : 'tap + to create your first folder'}</p></div>
      <div class="tbtns">${names.length ? editBtn : ''}<button class="p plus" data-act="newfolder" aria-label="New folder">${svg('<path d="M12 5v14M5 12h14"/>', 30)}</button></div></div>${banner}
    <div class="bigf">${names.map(f => {
      const cs = cards.filter(c => folderOf(c.deck) === f), nd = new Set(cs.map(c => c.deck)).size, todo = cs.filter(c => !c.reps || c.due <= now).length, mat = cs.filter(c => c.interval >= 21).length;
      return `<button class="bf${editing ? ' editing' : ''}" data-folder="${esc(f)}">${delBadge('delfolder', f)}${renBadge('renfolder', f)}${todo ? `<b class="badge2">${todo}</b>` : ''}${folderSvg(132, f)}
        <span class="nm">${esc(f)}</span><small>${nd} deck${nd === 1 ? '' : 's'} · ${cs.length} questions</small><span class="bar2"><i style="width:${cs.length ? Math.round(100 * mat / cs.length) : 0}%"></i></span></button>`;
    }).join('')}<button class="addtile" data-act="newfolder">${svg('<path d="M12 5v14M5 12h14"/>', 44)}<span>New folder</span></button></div>`;
  } else if (view === 'stats') {
    const nC = cards.length, known = cards.filter(c => c.interval >= 21).length, unseen = cards.filter(c => !c.reps).length, learning = nC - known - unseen;
    const share = x => nC ? 100 * x / nC : 0;
    // one pass over the logs for everything below (per day, per deck, totals)
    const byDay = new Map(), byDeck = new Map();
    let revOk = 0, revN = 0;
    const tod = ['Morning', 'Afternoon', 'Evening', 'Night'].map(name => ({ name, n: 0, ok: 0 }));
    for (const l of logs) {
      const h = new Date(l.t).getHours(), part = tod[h >= 5 && h < 12 ? 0 : h >= 12 && h < 17 ? 1 : h >= 17 && h < 22 ? 2 : 3];
      part.n++; if (l.correct) part.ok++;
      const k = dayKey(l.t);
      let d = byDay.get(k); if (!d) byDay.set(k, d = { total: 0, ok: 0 });
      let dk = byDeck.get(l.deck); if (!dk) byDeck.set(l.deck, dk = { n: 0, ok: 0 });
      d.total++; dk.n++;
      if (!l.isNew) revN++;
      if (l.correct) { d.ok++; dk.ok++; if (!l.isNew) revOk++; }
    }
    const td = byDay.get(today) || { total: 0, ok: 0 };
    const days = [...Array(14)].map((_, i) => { const t = now - (13 - i) * DAY; return { t, ...(byDay.get(dayKey(t)) || { total: 0, ok: 0 }) }; });
    const dmax = Math.max(1, ...days.map(d => d.total));
    const sum = (a, k) => a.reduce((s, d) => s + d[k], 0);
    const rate = a => sum(a, 'total') ? Math.round(100 * sum(a, 'ok') / sum(a, 'total')) : null;
    const accW = rate(days.slice(7)), accP = rate(days.slice(0, 7));
    const delta = accW !== null && accP !== null ? accW - accP : 0;
    const trend = accW !== null && accP !== null && delta ? `<span class="chip2 ${delta > 0 ? 'up' : 'dn'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}%</span>` : '';
    const fc = Array(7).fill(0);
    cards.filter(c => c.reps).forEach(c => { fc[Math.min(6, Math.max(0, Math.floor((c.due - now) / DAY)))]++; });
    const fmax = Math.max(1, ...fc), dn = i => ['Today', 'Tmrw'][i] || 'SMTWTFS'[new Date(now + i * DAY).getDay()];
    const live = new Set(cards.map(c => c.deck));
    const weak = [...byDeck].filter(([d, v]) => live.has(d) && v.n >= 5).map(([d, v]) => ({ d, n: v.n, acc: Math.round(100 * v.ok / v.n) })).sort((a, b) => a.acc - b.acc).slice(0, 4);
    const hard = cards.filter(c => c.lapses).sort((a, b) => b.lapses - a.lapses).slice(0, 4);
    const stg = [0, 0, 0, 0, 0];   // memory strength: new, under 3 days, under a week, under 3 weeks, 3+ weeks
    cards.forEach(c => { stg[!c.reps ? 0 : c.interval < 3 ? 1 : c.interval < 7 ? 2 : c.interval < 21 ? 3 : 4]++; });
    const smax = Math.max(1, ...stg);
    const WEEKS = 13, start = now - (WEEKS * 7 - 1) * DAY, lead = new Date(start).getDay();   // heat map: 13 weeks, columns start on Sunday
    const hdays = [...Array(WEEKS * 7)].map((_, i) => ({ t: start + i * DAY, n: (byDay.get(dayKey(start + i * DAY)) || { total: 0 }).total }));
    const hmax = Math.max(1, ...hdays.map(d => d.n)), activeDays = hdays.filter(d => d.n).length;
    const missedBy = new Map();
    cards.filter(c => c.lapses).forEach(c => missedBy.set(c.deck, (missedBy.get(c.deck) || 0) + 1));
    const missedDecks = [...missedBy].sort((a, b) => b[1] - a[1]).slice(0, 5), missedAll = cards.filter(c => c.lapses).length;
    const deckProg = [...live].map(d => { const cs = cards.filter(c => c.deck === d), k = cs.filter(c => c.interval >= 21).length, u = cs.filter(c => !c.reps).length; return { d, n: cs.length, k, l: cs.length - k - u }; }).sort((a, b) => a.k / a.n - b.k / b.n).slice(0, 8);
    const tone = a => a < 60 ? 'var(--bad)' : a < 80 ? 'var(--acc)' : 'var(--blue)';
    const TI = { bolt: ['bolt', 'var(--blue)'], flame: ['flame', '#ff9600'], star: ['star', '#ffc800'], check: ['check', 'var(--acc)'] };
    const t4 = (ic, h, v, s) => `<div class="tile"><span class="ti">${fsvg(TI[ic][0], TI[ic][1], 34)}</span><div class="tt"><b>${v}</b><span>${h}</span><small>${s}</small></div></div>`;
    const card = (title, right, inner, cls = '') => `<section class="card sc ${cls}"><div class="ch"><h3>${title}</h3>${right ? `<span class="big2">${right}</span>` : ''}</div>${inner}</section>`;

    const progress = card('Your progress', `${Math.round(share(known))}% known`, `
      <div class="stack"><i style="width:${share(known)}%;background:var(--blue)"></i><i style="width:${share(learning)}%;background:var(--acc)"></i></div>
      <div class="legend"><span><u style="background:var(--blue)"></u><b>${known}</b> known</span><span><u style="background:var(--acc)"></u><b>${learning}</b> learning</span><span><u style="background:var(--line)"></u><b>${unseen}</b> not started</span></div>
      <p class="fine">Known means you've remembered it for 3+ weeks.</p>`, 'full');

    const inner = logs.length ? `
      <div class="grid">
        ${t4('bolt', 'Today', td.total, td.total ? pct(td.ok, td.total) + ' correct' : 'answered so far')}
        ${t4('flame', 'Streak', streak(logs) + (streak(logs) === 1 ? ' day' : ' days'), 'in a row')}
        ${t4('star', 'Known', Math.round(share(known)) + '%', known + ' of ' + nC)}
        ${t4('check', 'On repeats', pct(revOk, revN), 'answered right')}
      </div>
      ${progress}
      ${card('Last 14 days', accW === null ? '' : `${accW}% correct${trend}`, `
        <div class="act">${days.map((d, i) => `<div title="${d.ok}/${d.total} correct"><i class="w" style="height:calc((100% - 22px) * ${(d.total - d.ok) / dmax})"></i><i class="r" style="height:calc((100% - 22px) * ${d.ok / dmax})"></i><span ${i === 13 ? 'class="now"' : ''}>${'SMTWTFS'[new Date(d.t).getDay()]}</span></div>`).join('')}</div>
        <div class="legend"><span><u style="background:var(--blue)"></u>correct</span><span><u style="background:var(--bad)"></u>wrong</span></div>`, 'wide')}
      ${card('Study days', `${activeDays} of the last ${hdays.length}`, `<div class="heat">${'<i class="e"></i>'.repeat(lead)}${hdays.map(d => `<i title="${d.n} answered" style="${d.n ? `background:var(--blue);opacity:${[.3, .5, .75, 1][Math.ceil(4 * d.n / hmax) - 1]}` : ''}"></i>`).join('')}</div><p class="fine">Each square is a day, darker means more questions. Oldest on the left.</p>`, 'narrow')}
        ${card('Weakest topics', '', weak.length ? weak.map(x => `<div class="wkr"><span>${esc(x.d)}</span><b>${x.acc}%</b><div class="meter"><i style="width:${x.acc}%;background:${tone(x.acc)}"></i></div></div>`).join('') : '<p class="fine">Shows up once a deck has 5 answers.</p>')}
        ${card('Keep missing', '', missedAll ? `<button class="p mstudy" data-missed="">Study all ${missedAll} missed</button>${missedDecks.map(([d, k]) => `<div class="mrow"><div><b>${esc(lectureOf(d))}</b><small>${k} question${k === 1 ? '' : 's'} you keep missing</small></div><button data-missed="${esc(d)}">Study</button></div>`).join('')}${hard.slice(0, 3).map(c => `<div class="hard">${esc(c.stem.length > 90 ? c.stem.slice(0, 90) + '…' : c.stem)}<small>missed ${c.lapses}×</small></div>`).join('')}` : '<p class="fine">Questions you get wrong more than once appear here, with a button to study them.</p>')}
        ${card('When you study best', '', tod.some(p => p.n >= 5) ? tod.map(p => { const a = p.n ? Math.round(100 * p.ok / p.n) : 0; return p.n >= 5 ? `<div class="wkr"><span>${p.name}</span><b>${a}%</b><div class="meter"><i style="width:${a}%;background:${tone(a)}"></i></div><small>${p.n} answers</small></div>` : `<div class="wkr"><span>${p.name}</span><small>not enough answers yet</small></div>`; }).join('') : '<p class="fine">Shows up after a few more answers.</p>')}
      ${card('Deck progress', '', deckProg.length ? deckProg.map(x => `<div class="wkr"><span>${esc(lectureOf(x.d))}</span><b>${Math.round(100 * x.k / x.n)}% known</b><div class="stack"><i style="width:${100 * x.k / x.n}%;background:var(--blue)"></i><i style="width:${100 * x.l / x.n}%;background:var(--acc)"></i></div></div>`).join('') : '<p class="fine">Add a deck to see its progress.</p>')}
        ${card('Memory strength', '', `<div class="fc">${stg.map((n, i) => `<div><em>${n || ''}</em><i style="height:${Math.round(70 * n / smax)}px"></i><span>${['New', '<3d', '<1w', '<3w', '3w+'][i]}</span></div>`).join('')}</div><p class="fine">How long until each question comes back. Longer is stronger.</p>`)}
      ${card('Coming up', fc[0] ? `${fc[0]} due today` : 'nothing due today', `<div class="fc">${fc.map((n, i) => `<div><em>${n || ''}</em><i style="height:${Math.round(70 * n / fmax)}px"></i><span>${dn(i)}</span></div>`).join('')}</div>`)}`
      : `${nC ? progress : ''}<section class="card empty"><div class="ei">${svg(ICONS.stats, 40)}</div><h3>No answers yet</h3><p>Study a few questions and your stats will show up here.</p></section>`;
    body = `<h1 class="pt">Stats</h1><p class="tag">how you're doing, and where to focus</p><div style="height:18px"></div><div class="sw"><div class="stats">${inner}</div></div>`;
  } else if (view === 'guide') {
    const plat = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop';
    const how = [['slides', 'Add slides', 'Upload your lecture PDFs and file them under a deck.'], ['generate', 'Generate', 'AI writes exam-style case questions from them.'], ['today', 'Study', 'A short daily session. Misses come back sooner.'], ['stats', 'Track', 'See your streak, weak topics and what is due.']];
    body = `<h1 class="pt">Guide</h1><p class="tag">how medidote works, and how to install it</p><div style="height:18px"></div>${banner}
    <h2>How it works</h2>
    <div class="istepgrid" style="margin-bottom:14px">${how.map(([v, t, d], i) => `<div class="istep"><span class="inum">${i + 1}</span><span class="iico">${svg(ICONS[v], 34)}</span><b>${t}</b><small>${d}</small></div>`).join('')}</div>
    <p class="gdesc" style="margin:0 0 14px">Everything lives in your account, so there are no files to keep track of. Sign in on any device and your decks, slides and progress are there.</p>
    <button id="wt" style="margin:0 0 26px">Replay the app walkthrough</button>
    <h2>Install it as an app</h2>
    <p class="gdesc" style="margin:0 0 14px">Puts medidote on your home screen and opens it full screen, like any other app. Free, and about a minute.</p>
    <div class="seg2 vtog" style="margin-bottom:14px">${[['ios', 'iPad / iPhone'], ['android', 'Android'], ['desktop', 'Computer']].map(([k, l]) => `<button data-inst="${k}" class="${k === plat ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${[
      ['ios', [[ICONS_I.safari, 'Open in Safari', 'Sign in first'], [ICONS_I.share, 'Tap Share', 'Square with an arrow, by the address bar (or ••• first)'], [ICONS_I.plus, 'Add to Home Screen', 'Scroll the menu to find it'], [ICONS_I.tick, 'Tap Add', 'The medidote icon is on your home screen']]],
      ['android', [[ICONS_I.safari, 'Open in Chrome', 'Sign in first'], [ICONS_I.dots, 'Tap the ⋮ menu', 'Top corner'], [ICONS_I.plus, 'Install app', 'Or Add to Home screen'], [ICONS_I.tick, 'Confirm', 'The icon appears on your home screen']]],
      ['desktop', [[ICONS_I.safari, 'Open in Chrome or Edge', 'Sign in first'], [ICONS_I.screen, 'Click the install icon', 'Right end of the address bar'], [ICONS_I.tick, 'Install', 'It opens in its own window']]],
    ].map(([k, steps]) => `<div class="istepgrid" data-ipanel="${k}" ${k === plat ? '' : 'hidden'}>${steps.map(([ic, t, d], i) => `<div class="istep"><span class="inum">${i + 1}</span><span class="iico">${svg(ic, 34)}</span><b>${t}</b><small>${d}</small></div>`).join('')}</div>`).join('')}
    <p class="fine" style="margin:14px 0 0">Open it from the new icon. It needs internet, and updates itself when you close it fully and reopen it. To remove it, press and hold the icon.</p>
`;
  } else if (view === 'slides' || view === 'generate') {
    const gen = view === 'generate';
    const files = chk(await sb.from('slide_files').select('id,file_name,week,page_count,storage_path,deck_id').order('file_name'));
    const dn = new Map([...cache.deckId].map(([n, id]) => [id, n])), by = new Map(), covers = await signedCovers(files);
    files.forEach(f => { const n = dn.get(f.deck_id); by.set(n, [...(by.get(n) || []), f]); });
    const del = f => `data-delfile="${f.id}" data-path="${esc(f.storage_path)}" data-name="${esc(f.file_name)}"`;
    const open = f => `data-open="${f.id}" data-path="${esc(f.storage_path)}" data-oname="${esc(f.file_name.replace(/\.pdf$/i, ''))}"`;
    const deckOf = f => dn.get(f.deck_id) || '', folders = [...new Set([...by.keys()].map(n => folderOf(n || '')))].sort((a, b) => a.localeCompare(b));
    if (slideDeck && !(slideDeck.startsWith('f:') ? folders.includes(slideDeck.slice(2)) : by.has(slideDeck.slice(2)))) slideDeck = '';   // that folder or deck has no slides any more
    const shown = files.filter(f => !slideDeck || (slideDeck.startsWith('f:') ? folderOf(deckOf(f)) === slideDeck.slice(2) : deckOf(f) === slideDeck.slice(2)));
    const showDeck = slideGroup !== 'deck';   // grouped by deck, the heading already says which deck
    const selCls = f => slideSel?.has(f.id) ? ' sel' : '', delBtn = f => slideSel ? '' : `<button class="sx" ${del(f)} aria-label="Remove ${esc(f.file_name)}">${svg(TRASH_PATH, 18)}</button>`;
    const tiles = fs => `<div class="sgrid">${fs.map(f => `<div class="stile${selCls(f)}" ${open(f)} role="button" tabindex="0">${tileBody(f, covers.get(f.id), showDeck ? deckOf(f) : '')}${delBtn(f)}</div>`).join('')}</div>`;
    const rows = fs => `<div class="slist">${fs.map(f => `<div class="stile srow${selCls(f)}" ${open(f)} role="button" tabindex="0"><span class="scover">${covers.get(f.id) ? `<img src="${esc(covers.get(f.id))}" alt="">` : slidesIco()}</span><span class="sinfo"><span class="stitle">${esc(f.file_name.replace(/\.pdf$/i, ''))}</span><small>${[showDeck && deckOf(f) ? esc(lectureOf(deckOf(f))) : '', f.week ? 'Week ' + f.week : '', f.page_count + ' page' + (f.page_count === 1 ? '' : 's')].filter(Boolean).join(' · ')}</small></span>${delBtn(f)}</div>`).join('')}</div>`;
    const groups = slideGroup === 'all' ? [['', shown]] : [...shown.reduce((m, f) => { const k = slideGroup === 'deck' ? deckOf(f) : folderOf(deckOf(f)); return m.set(k, [...(m.get(k) || []), f]); }, new Map())].sort((a, b) => a[0].localeCompare(b[0]));
    const seg = (cur, attr, opts) => `<div class="seg2">${opts.map(([k, l]) => `<button ${attr}="${k}" class="${k === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    if (!gen) body = `<div class="toprow"><div><h1 class="pt">Slides</h1><p class="tag">${files.length ? (shown.length === files.length ? files.length : shown.length + ' of ' + files.length) + ' file' + (files.length === 1 ? '' : 's') + (slideSel ? ' · tap slides to select them' : ' · tap one to open it') : 'all your uploaded slides'}</p></div>
      <div class="tbtns">${files.length ? `<button class="edit${slideSel ? ' on' : ''}" data-act="selslides">${slideSel ? 'Done' : 'Select'}</button>` : ''}<button class="p plus" data-act="uploadslides" aria-label="Upload slides">${svg('<path d="M12 5v14M5 12h14"/>', 30)}</button></div></div>${banner}
    ${slideSel ? `<div class="selbar"><span id="selcount"></span><button id="selall">Select all</button><button class="p" id="seldel" disabled>Delete</button></div>` : ''}
    ${by.size ? `<div class="sctl"><select class="inp" id="sdf" aria-label="Show slides from">
        <option value="">All slides</option>
        ${folders.length ? `<optgroup label="Folders">${folders.map(f => `<option value="f:${esc(f)}" ${slideDeck === 'f:' + f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</optgroup>` : ''}
        <optgroup label="Decks">${[...by.keys()].map(n => `<option value="d:${esc(n)}" ${slideDeck === 'd:' + n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup></select>
      ${seg(slideGroup, 'data-sg', [['all', 'All'], ['deck', 'By deck'], ['folder', 'By folder']])}
      ${seg(slideLayout, 'data-sl', [['tiles', 'Tiles'], ['list', 'List']])}</div>
    ${groups.map(([name, fs]) => `${name ? `<h2 class="sgh">${esc(slideGroup === 'deck' ? lectureOf(name) : name)}<small>${fs.length} file${fs.length === 1 ? '' : 's'}</small></h2>` : ''}${slideLayout === 'list' ? rows(fs) : tiles(fs)}`).join('') || '<p class="tag emptynote">No slides here yet.</p>'}`
      : '<p class="tag emptynote" style="font-size:18px;max-width:46ch">No slides yet. Tap + to upload a PDF and choose the deck it belongs to.</p>'}`;
    else if (COMING_SOON.generate) body = soon('Generate with AI');
    else {
      const [{ data: sub }, { data: us }] = await Promise.all([sb.from('subscriptions').select('*').maybeSingle(), sb.from('usage').select('questions').eq('month', new Date().toISOString().slice(0, 7)).maybeSingle()]);
      const p = planOf(sub), used = us?.questions || 0;
      const note = p.k === 'active' ? `${used} of ${PLAN.questions} questions used this month` : p.k === 'trial' ? `Free period: ${p.left} day${p.left === 1 ? '' : 's'} left · ${Math.max(0, TRIAL_QUESTIONS - used)} of ${TRIAL_QUESTIONS} questions left` : 'Free period ended. Subscribing is coming soon.';
      genCtx = { files, by };
      body = generateBody({ files, by, dn, covers, note });
    }
  } else if (view === 'community') {
    body = `${soon('Community')}<p class="tag" style="font-size:18px;max-width:46ch">Decks shared by other students, ready to add and study.</p>`;
  } else if (view === 'subscription') {
    if (COMING_SOON.subscription) body = soon('Subscription');
    else {
    const [{ data: sub }, { data: us }] = await Promise.all([sb.from('subscriptions').select('*').maybeSingle(), sb.from('usage').select('questions').eq('month', new Date().toISOString().slice(0, 7)).maybeSingle()]);
    const p = planOf(sub), used = us?.questions || 0;
    const status = p.k === 'active' ? `Active until ${p.until.toLocaleDateString()}` : p.k === 'trial' ? `Free trial · ${p.left} day${p.left === 1 ? '' : 's'} left` : 'Free plan';
    const note = p.k === 'active' ? `${used} of ${PLAN.questions} AI questions used this month.`
      : p.k === 'trial' ? `${Math.max(0, TRIAL_QUESTIONS - used)} of ${TRIAL_QUESTIONS} free AI questions left this month.`
      : 'Your trial has ended. Creating, importing and studying decks is still free. Subscribe to write questions with AI.';
    const tick = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.500 4.500 4.500L19 7.500"/></svg>';
    const pill = p.k === 'active' ? ['Active', 'on'] : p.k === 'trial' ? ['Free trial', 'on'] : ['Free plan', ''];
    const frac = p.k === 'active' ? used / PLAN.questions : p.k === 'trial' ? used / TRIAL_QUESTIONS : 0;
    body = `<div class="subpage"><h1 class="pt">Subscription</h1><p class="tag">Pay only for the AI. Everything else is free.</p><div style="height:20px"></div>${banner}
    <section class="card subst"><div class="subrow"><span class="pill ${pill[1]}">${pill[0]}</span><b>${status}</b></div>
      ${p.k === 'free' ? '' : `<div class="meter"><i style="width:${Math.min(100, Math.round(frac * 100))}%;background:var(--acc)"></i></div>`}
      <p>${note}</p></section>
    <section class="card plan"><div class="planh"><div><h2>${PLAN.name}</h2><p>Questions from your own slides, written by AI.</p></div>
        <div class="price"><b>${PLAN.price}</b><small>per month</small></div></div>
      <ul class="feat">${[`Up to ${PLAN.questions} AI questions a month`, 'Hard case-study questions in exam style', 'An explanation for every answer option', 'A link back to the exact slide each question came from'].map(t => `<li>${tick}<span>${t}</span></li>`).join('')}</ul>
      <button class="p" id="subscribe">${p.k === 'active' ? 'Renew or manage' : 'Subscribe'}</button></section>
    <section class="card freecard"><h2>Always free</h2><p>Creating and importing decks, attaching slides, studying and stats never need a plan.</p></section></div>`;
    }
  } else if (view === 'reported') {
    const L = 'ABCDEFGH';
    body = `<div class="toprow"><div><h1 class="pt">Reported questions</h1><p class="tag">hidden from studying until you restore them</p></div><div class="tbtns"><button class="edit" data-go="settings">Back</button></div></div>${banner}
    ${reported.length ? reported.map(c => `<details class="card rq"><summary><span>${esc(c.stem.length > 110 ? c.stem.slice(0, 110) + '…' : c.stem)}</span><small>${esc(lectureOf(c.deck))}</small></summary>
      <p class="rqs">${esc(c.stem)}</p>
      <div class="rqo">${c.options.map((o, i) => `<div class="${i === c.answer ? 'ok' : ''}"><b>${L[i]}</b><span>${esc(o)}</span>${i === c.answer ? '<em>marked correct</em>' : ''}</div>`).join('')}</div>
      ${c.explanation ? `<p class="fine rqe">${esc(c.explanation)}</p>` : ''}
      <div class="row end"><button class="p" data-restore="${esc(c.id)}">Restore to my deck</button></div></details>`).join('') : '<p class="tag emptynote">No reported questions.</p>'}`;
  } else if (view === 'settings') {
    const t = theme(), seg = (v, l) => `<button data-theme-set="${v}" class="${t === v ? 'on' : ''}">${l}</button>`;
    const card = (title, rows) => `<h2>${title}</h2><section class="card" style="padding-top:6px;padding-bottom:6px">${rows}</section>`;
    body = `<h1 class="pt">Settings</h1><div style="height:20px"></div>${banner}
    ${card('Appearance', `
      <div class="set"><div><strong>Mode</strong><p>Light, dark, or follow the iPad.</p></div>
        <div class="seg2">${seg('light', 'Light')}${seg('dark', 'Dark')}${seg('auto', 'Auto')}</div></div>
      <div class="set col"><div><strong>Color theme</strong><p>Pick a palette for the whole app.</p></div>
        <div class="pals">${PALETTES.map(p => `<button class="pal ${p.id === curPalette() ? 'on' : ''}" data-pal="${p.id}" aria-label="${p.label}"><span class="dots"><i style="background:${p.sw[0]}"></i><i style="background:${p.sw[1]}"></i></span>${p.label}</button>`).join('')}</div></div>
      <div class="set"><div><strong>Interface size</strong><p>Zoom the whole app in or out.</p></div>
        <div class="zoomr"><input type="range" id="zm" min="70" max="150" step="5" value="${Math.round(zoomNow() * 100)}" aria-label="Interface size"><b id="zv">${Math.round(zoomNow() * 100)}%</b></div></div>`)}
    ${card('Studying', `
      <div class="set"><div><strong>Slide next to the question</strong><p>Show the slide a question came from, beside the question.</p></div>
        <select class="inp" id="slm" aria-label="Slide next to the question">${[['after', 'After answering'], ['before', 'Before answering'], ['both', 'Before and after'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${v === slideMode ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`)}
    ${card('Sound', `
      <div class="set"><div><strong>Sound effects</strong><p>A soft tick on buttons, a bright chime for correct, a low tone for wrong, and a short fanfare when you finish.</p></div>
        <input type="checkbox" class="tgl" id="snd" ${sound ? 'checked' : ''} aria-label="Sound effects"></div>
      <div class="set"><div><strong>Try the sounds</strong><p>No sound? Turn the volume up and check the device isn't muted (the bell icon in Control Center, or the side switch).</p></div>
        <div class="row" style="flex-wrap:nowrap;flex:none"><button id="t-ok">Correct</button><button id="t-no">Wrong</button></div></div>`)}
    ${card('Help', `
      <div class="set"><div><strong>App walkthrough</strong><p>A quick tour of what medidote can do.</p></div>
        <div class="row"><button id="wt">Start</button></div></div>
      <div class="set"><div><strong>Guide</strong><p>How to install the app.</p></div>
        <div class="row"><button data-go="guide">Open</button></div></div>
      <div class="set"><div><strong>Terms and privacy</strong><p>The rules of using medidote and how your information is handled.</p></div>
        <div class="row"><a class="btn" href="legal/terms.html" target="_blank" rel="noopener">Terms</a><a class="btn" href="legal/privacy.html" target="_blank" rel="noopener">Privacy</a></div></div>`)}
    ${reported.length ? card('Reported questions', `<div class="set"><div><strong>${reported.length} hidden question${reported.length === 1 ? '' : 's'}</strong><p>Questions you reported are kept out of your studying. Open them to look again or restore them.</p></div><div class="row"><button data-go="reported">Open</button></div></div>`) : ''}
    ${card('Account', `
      <div class="set"><div><strong>Signed in</strong><p>${esc(me?.email || 'Your account')}</p></div>
        <div class="row"><button id="so">Sign out</button></div></div>
      <div class="set"><div><strong>Delete account</strong><p>Permanently removes your account, decks, slides and progress.</p></div>
        <div class="row"><button class="danger" id="delacct">Delete</button></div></div>`)}`;
  }
  const screen = view + '|' + folder, still = screen === lastScreen;
  lastScreen = screen;
  $.innerHTML = `<div class="page${still ? ' still' : ''}">${body}</div>`;
  document.body.classList.toggle('scrolled', $.scrollTop > 6);
  if (!still) {
    $.querySelectorAll('.folders>*,.bigf>*,.deckgrid>*,.grid>*,.two>*,.morelist>*').forEach((el, i) => { el.style.animationDelay = Math.min(i, 10) * 55 + 120 + 'ms'; });
    $.querySelectorAll('.act>div,.fc>div').forEach((el, i) => el.style.setProperty('--d', i * 45 + 200 + 'ms'));
    $.querySelectorAll('.big,.tt b').forEach(countUp);
  }

  const q = s => $.querySelector(s);
  if (q('#all')) q('#all').onclick = e => { const d = e.currentTarget.dataset; study({ ...(d.folder && { folder: d.folder }), mode: d.mode, limit: +d.limit || 0 }, !!d.practice); };
  $.querySelectorAll('[data-mode].chip').forEach(b => b.onclick = () => { smode = b.dataset.mode; home(); });
  $.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { sess = +b.dataset.size; try { localStorage.setItem('sess', sess); } catch {} home(); });
  if (q('#up')) q('#up').onclick = () => { folder = null; editing = false; home(); };
  $.querySelectorAll('[data-folder]:not(#all)').forEach(b => b.onclick = () => { if (editing) return renameFolderUI(b.dataset.folder); folder = b.dataset.folder; view = 'today'; home(); });
  $.querySelectorAll('[data-pal]').forEach(b => b.onclick = () => { setPalette(b.dataset.pal); home(); });
  $.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => { const c = reported.find(x => x.id === b.dataset.restore); if (c) { delete c.flagged; await putMany('cards', [c]); if (reported.length === 1) view = 'settings'; home('Question restored. It is back in your study queue.'); } });
  $.querySelectorAll('[data-missed]').forEach(b => b.onclick = () => study({ deck: b.dataset.missed || undefined, mode: 'missed' }));
  $.querySelectorAll('[data-deck]').forEach(b => b.onclick = () => { if (editing) return renameDeckUI(b.dataset.deck); study({ deck: b.dataset.deck }, !!b.dataset.practice); });
  if (q('#hc')) q('#hc').onclick = () => { hideCh = !hideCh; try { localStorage.setItem('hidech', hideCh ? '1' : '0'); } catch {} home(); };
  $.querySelectorAll('[data-act=edit]').forEach(b => b.onclick = () => { editing = !editing; home(); });
  $.querySelectorAll('[data-slides]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    const d = x.dataset.slides;
    if (+x.dataset.n) { slideDeck = 'd:' + d; view = 'slides'; home(); } else uploadDialog(d);   // a deck's slides are listed in the Slides tab; a deck with none gets the upload dialog with the deck picked
  });
  $.querySelectorAll('[data-rendeck],[data-renfolder]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    x.dataset.rendeck ? renameDeckUI(x.dataset.rendeck) : renameFolderUI(x.dataset.renfolder);
  });
  $.querySelectorAll('[data-deldeck]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    const d = x.dataset.deldeck, n = cards.filter(c => c.deck === d).length;
    confirmDialog(`Delete "${lectureOf(d)}"?`, `This removes the deck, its ${n} question${n === 1 ? '' : 's'} and its slides, along with your progress on them. A PDF that another deck also uses stays there. This can't be undone.`, 'Delete', async () => { await deleteDeck(d); home(`Deleted "${lectureOf(d)}".`); });
  });
  $.querySelectorAll('[data-delfolder]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    const f = x.dataset.delfolder, cs = cards.filter(c => folderOf(c.deck) === f), nd = new Set(cs.map(c => c.deck)).size;
    confirmDialog(`Delete the "${f}" folder?`, nd ? `This removes the folder, its ${nd} deck${nd === 1 ? '' : 's'} and ${cs.length} question${cs.length === 1 ? '' : 's'} and their slides, along with your progress on them. A PDF that another deck also uses stays there. This can't be undone.` : 'This folder is empty, so nothing else is removed.', 'Delete', async () => { await deleteFolder(f); if (folder === f) folder = null; home(`Deleted the "${f}" folder.`); });
  });
  if (q('#wt')) q('#wt').onclick = walkthrough;
  if (q('#so')) q('#so').onclick = () => sb.auth.signOut().then(() => location.reload());
  if (q('#delacct')) q('#delacct').onclick = () => confirmDialog('Delete your account?', 'This permanently deletes your account, decks, questions, slides, progress and reports, on every device. This cannot be undone.', 'Delete account', async () => {
    const { data, error } = await sb.functions.invoke('delete-account');
    if (error || data?.error) return home('Could not delete the account. Try again.');
    try { localStorage.clear(); } catch {}
    await sb.auth.signOut().catch(() => {});   // the user is already gone on the server, so this only clears the local session
    location.reload();
  });
  $.querySelectorAll('[data-inst]').forEach(b => b.onclick = () => { $.querySelectorAll('[data-inst]').forEach(x => x.classList.toggle('on', x === b)); $.querySelectorAll('[data-ipanel]').forEach(p => p.hidden = p.dataset.ipanel !== b.dataset.inst); });
  if (q('#slm')) q('#slm').onchange = e => { slideMode = e.target.value; try { localStorage.setItem('slidemode', slideMode); } catch {} };
  if (q('#zm')) {   // applied on release, because zooming while dragging would move the slider out from under the finger
    q('#zm').oninput = e => { q('#zv').textContent = e.target.value + '%'; };
    q('#zm').onchange = e => { const z = e.target.value / 100; try { localStorage.setItem('zoom', z); } catch {} document.documentElement.style.zoom = z;   // interface size belongs to this device only, it is not saved to the account
    fitNav(); };
  }
  $.querySelectorAll('[data-theme-set]').forEach(b => b.onclick = () => { setTheme(b.dataset.themeSet); home(); });
  if (q('#snd')) q('#snd').onchange = e => {
    sound = e.target.checked;
    try { localStorage.setItem('sound', sound ? '1' : '0'); } catch {}
    play('ok');
  };
  if (q('#t-ok')) q('#t-ok').onclick = () => play('ok');
  if (q('#t-no')) q('#t-no').onclick = () => play('no');
  $.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { view = b.dataset.go; home(); });
  $.querySelectorAll('[data-act=newfolder]').forEach(b => b.onclick = () => newFolderDialog(n => home(`Folder "${n}" created.`)));
  $.querySelectorAll('[data-act=adddeck]').forEach(b => b.onclick = () => importDialog(b.dataset.pre || ''));
  $.querySelectorAll('[data-act=uploadslides]').forEach(b => b.onclick = () => uploadDialog());
  if (q('#sdf')) q('#sdf').onchange = e => { slideDeck = e.target.value; slideSel?.clear(); home(); };
  $.querySelectorAll('[data-sg]').forEach(b => b.onclick = () => { slideGroup = b.dataset.sg; try { localStorage.setItem('slidegroup', slideGroup); } catch {} home(); });
  $.querySelectorAll('[data-sl]').forEach(b => b.onclick = () => { slideLayout = b.dataset.sl; try { localStorage.setItem('slidelayout', slideLayout); } catch {} home(); });
  $.querySelectorAll('[data-act=selslides]').forEach(b => b.onclick = () => { slideSel = slideSel ? null : new Set(); home(); });
  const tilesNow = () => [...$.querySelectorAll('[data-open]')];
  const syncSel = () => {
    if (!slideSel) return;
    const n = slideSel.size;
    q('#selcount').textContent = n ? `${n} selected` : 'Nothing selected';
    q('#seldel').disabled = !n; q('#seldel').textContent = n ? `Delete ${n}` : 'Delete';
    q('#selall').textContent = n && n === tilesNow().length ? 'Clear' : 'Select all';
  };
  syncSel();
  if (q('#selall')) q('#selall').onclick = () => { const every = tilesNow().length === slideSel.size; slideSel.clear(); tilesNow().forEach(b => { b.classList.toggle('sel', !every); if (!every) slideSel.add(b.dataset.open); }); syncSel(); };
  if (q('#seldel')) q('#seldel').onclick = () => {
    const picked = tilesNow().filter(b => slideSel.has(b.dataset.open)), n = picked.length;
    confirmDialog(`Remove ${n} slide file${n === 1 ? '' : 's'}?`, 'They are removed from their decks. If another deck uses the same PDF, that deck keeps it. Questions already made from them stay.', 'Remove', async () => {
      await removeSlideFiles(picked.map(b => ({ id: b.dataset.open, path: b.dataset.path })));
      slideSel = null; home(`Removed ${n} slide file${n === 1 ? '' : 's'}.`);
    });
  };
  $.querySelectorAll('[data-open]').forEach(b => b.onclick = e => {
    if (slideSel) { const id = b.dataset.open; slideSel.has(id) ? slideSel.delete(id) : slideSel.add(id); b.classList.toggle('sel'); syncSel(); return; }
    if (!e.target.closest('[data-delfile]')) enlargeSlide({ file_id: b.dataset.open, page: 1 }, b.dataset.oname);
  });
  if (view === 'generate' && !COMING_SOON.generate) bindGenerate();
  if (q('#subscribe')) q('#subscribe').onclick = () => modal(`<h2>Subscribe to ${PLAN.name}</h2><p>Online payment is coming soon. We will let you know here as soon as it is ready.</p><div class="row end"><button class="p" id="c">OK</button></div>`, (o, close) => o.querySelector('#c').onclick = close);
  $.querySelectorAll('[data-delfile]').forEach(b => b.onclick = () => confirmDialog('Remove these slides?', `"${b.dataset.name}" is removed from this deck. If other decks use it, they keep it. Questions already made from it stay.`, 'Remove', async () => {
    await removeSlideFiles([{ id: b.dataset.delfile, path: b.dataset.path }]);   // attached to other decks too? the stored PDF stays
    home('Slides removed.');
  }));
}

// ---- study ----
// practice = review everything now; never touches the schedule or stats
async function study(sel, practice = false) {
  document.body.classList.add('studying');
  const [allCards, logs] = await Promise.all([all('cards'), all('logs'), slideMode === 'off' ? 0 : loadSlideFiles().catch(() => {})]);
  const cards = allCards.filter(c => !c.flagged);   // reported questions stay out of the queue
  const now = Date.now(), pool = sel?.deck ? cards.filter(c => c.deck === sel.deck) : sel?.folder ? cards.filter(c => folderOf(c.deck) === sel.folder) : cards;
  const wrong = wrongIds(logs), due = pool.filter(c => c.reps && c.due <= now).sort((a, b) => a.due - b.due), fresh = pool.filter(c => !c.reps);
  let queue = practice ? pool.map(c => ({ ...c })).sort(() => Math.random() - .5)
    : sel?.mode === 'due' ? due : sel?.mode === 'new' ? fresh
    : sel?.mode === 'wrong' ? pool.filter(c => wrong.has(c.id)).sort(() => Math.random() - .5)
    : sel?.mode === 'missed' ? pool.filter(c => c.lapses).sort(() => Math.random() - .5) : [...due, ...fresh];
  if (sel?.limit) queue = queue.slice(0, sel.limit);
  lastScreen = null;
  const total = queue.length;
  let prevPct = 0;
  const hist = [];   // questions answered this session, for looking back at
  const next = () => {
    if (!queue.length) { play('done'); burst(innerWidth / 2, innerHeight * .55, 150, 1.5); return home(`${practice ? 'Practice done' : 'Done'}. ${total} question${total === 1 ? '' : 's'} reviewed.`); };
    const c = queue[0], isNew = !c.reps, t0 = Date.now(), hasSlide = slideMode !== 'off' && cardSlides(c).length > 0;
    $.innerHTML = `<div class="sbar"><button class="x" id="back" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button>
        <div class="prog"><i style="width:${prevPct}%"></i></div><span class="cnt">${practice ? 'Practice · ' : ''}${queue.length} left</span><button class="hct2${hideCh ? ' on' : ''}" id="hq" aria-pressed="${hideCh}">Hide choices: ${hideCh ? 'On' : 'Off'}</button></div>
      <div class="page study withslide">
      <div class="kick">${isNew ? 'New question' : practice ? 'Practice' : 'Review'}</div>
      <h2 class="qh">Choose the best answer</h2>
      <div class="qgrid"><div class="qcol"><p class="stem">${esc(c.stem)}</p>
      ${hideCh ? '<button class="p" id="rv" style="width:100%;margin-bottom:14px">Show choices</button>' : ''}
      <div id="opts" ${hideCh ? 'hidden' : ''}>${c.options.map((o, i) => `<button class="opt" data-i="${i}"><b>${'ABCDEFGH'[i] || i + 1}</b><span>${esc(o)}</span></button>`).join('')}</div>
      <p class="kbd">A–E to answer · ${practice ? 'Enter to continue' : '1 Again · 2 Hard · 3 Good · 4 Easy · Enter to continue'}</p></div>
      <aside class="sp"><div id="slot"></div><div id="after"></div></aside></div></div>
      <div class="snav"><button id="sb" aria-label="Previous question" ${hist.length ? '' : 'disabled'}>‹ Back</button><span>Current question</span><button id="sf" aria-label="Skip question" ${queue.length > 1 ? '' : 'disabled'}>Skip ›</button></div>`;
    const slot = $.querySelector('#slot');
    const setSlide = answered => {
      const study = $.querySelector('.study'), show = hasSlide && (slideMode === 'both' || slideMode === (answered ? 'after' : 'before'));
      // the question sits centered on its own; once answered it slides left and the side panel pops in on the right (the slide, if shown, with the rating buttons under it)
      const toggle = () => { study.classList.toggle('split', show || answered); };
      if (answered && innerWidth >= 900 && document.startViewTransition && !calm()) document.startViewTransition(toggle); else toggle();
      if (!show) slot.innerHTML = ''; else if (!slot.firstChild) showSlide(slot, c);
    };
    setSlide(false);
    const pct = Math.max(0, 100 * (1 - queue.length / total));
    const bar = $.querySelector('.prog i');
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = pct + '%'; }));
    prevPct = pct;
    $.querySelector('#back').onclick = e => { e.preventDefault(); home(); };
    $.querySelector('#sb').onclick = () => review(hist.length - 1);
    $.querySelector('#sf').onclick = () => { queue.push(queue.shift()); next(); };   // skip: it comes back at the end
    $.querySelector('#hq').onclick = () => { hideCh = !hideCh; try { localStorage.setItem('hidech', hideCh ? '1' : '0'); } catch {} next(); };
    const reveal = () => { $.querySelector('#opts').hidden = false; $.querySelector('#rv')?.remove(); };
    if (hideCh) $.querySelector('#rv').onclick = reveal;
    onkeydown = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase(), rb = $.querySelectorAll('[data-r]');
      if (k === 'arrowleft' || k === 'arrowright') { $.querySelector(k === 'arrowleft' ? '#sb' : '#sf')?.click(); return; }
      if ($.querySelector('#rv')) { if (k === 'enter' || k === ' ' || 'abcdefgh12345678'.includes(k) && k.length === 1) { e.preventDefault(); reveal(); } return; }
      if (rb.length) {
        const r = k === 'enter' || k === ' ' ? $.querySelector('[data-r].p') : rb.length === 4 && '1234'.includes(k) && k ? rb['1234'.indexOf(k)] : null;
        if (r) { e.preventDefault(); r.click(); }
      } else {
        const i = 'abcdefgh'.indexOf(k), o = $.querySelectorAll('.opt')[k >= '1' && k <= '8' ? +k - 1 : i];
        if (o && k.length === 1) o.click();
      }
    };
    $.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      const pick = +b.dataset.i, correct = pick === c.answer, ms = Date.now() - t0;
      play(correct ? 'ok' : 'no');
      setSlide(true);
      hist.push({ c, pick, correct }); $.querySelector('#hq').style.visibility = 'hidden';   // keeps its space so the progress bar doesn't stretch
      const bk = $.querySelector('#sb'), nx = $.querySelector('#sf');   // the bottom bar stays: Back looks at the previous question, Next does what the main button does (rate Good / continue)
      bk.disabled = hist.length < 2; bk.onclick = () => review(hist.length - 2);
      nx.textContent = 'Next ›'; nx.setAttribute('aria-label', 'Next question'); nx.disabled = false; nx.onclick = () => $.querySelector('[data-r].p').click();
      if (correct) { const r = b.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 24); }
      $.querySelectorAll('.opt').forEach((x, i) => { x.disabled = true; if (i === c.answer) x.classList.add('ok'); else if (i === pick) x.classList.add('no'); x.insertAdjacentHTML('afterend', oexHtml(c, i)); });
      const rate = async rating => {
        if (practice) { queue.shift(); if (!correct && !c.flagged) queue.push(c); return next(); }
        const was = c.interval, t = Date.now();
        schedule(c, rating, t);
        await putMany('cards', [c]);
        await putMany('logs', [{ id: c.id, deck: c.deck, t, correct, rating, ms, isNew, interval: was }]);
        queue.shift();
        if ((rating === 'again' || (rating === 'hard' && !c.interval)) && !c.flagged) queue.push(c);
        next();
      };
      const praise = ['Nicely done!', 'Correct!', 'Great job!', 'Spot on!', 'Well done!'][Math.floor(Math.random() * 5)];
      $.querySelector('#after').innerHTML = `<div class="fb ${correct ? 'ok' : 'no'}">
        <div class="fbh"><span class="fbi">${svg(correct ? '<path d="m5 12.500 4.500 4.500L19 7.500"/>' : '<path d="M6 6l12 12M18 6 6 18"/>')}</span>
          <div><strong>${correct ? praise : 'Not quite'}</strong>${correct ? '' : `<small>Correct answer: ${'ABCDEFGH'[c.answer] || c.answer + 1}. ${esc(c.options[c.answer])}</small>`}</div></div>
        <div class="row rate">${correct && !practice
          ? ['again', 'hard', 'good', 'easy'].map(r => `<button data-r="${r}" ${r === 'good' ? 'class="p"' : ''}>${r}</button>`).join('')
          : `<button data-r="again" class="p">${correct ? 'Continue' : 'Next'}</button>`}</div>
        ${correct && !practice ? '<div class="row"><button id="nxt" class="p" style="width:100%">Next</button></div>' : ''}
        ${practice && !correct ? '<p class="hint">Missed ones come back until you get them right.</p>' : ''}
        <p class="hint">${c.source === 'ai' ? 'AI can make mistakes. ' : ''}Something wrong with this question? <button id="flag" class="lnk">${c.flagged ? 'Reported ✓' : 'Report it'}</button></p></div>`;
      $.querySelector('.fbh').onclick = () => $.querySelector('#after').classList.toggle('low');   // tap the card to lower it (reveals the slide's arrows), tap again to raise it
      ($.querySelector('.opt.ok + .oex') || $.querySelector('.fb')).scrollIntoView({ block: 'nearest', behavior: 'smooth' });   // bring the right answer's reason into view (it keeps clear of the bars via scroll-margin)
      $.querySelectorAll('[data-r]').forEach(x => x.onclick = () => rate(x.dataset.r));
      const fl = $.querySelector('#flag'); if (fl) fl.onclick = e => { e.stopPropagation(); reportDialog(c, () => { fl.textContent = 'Reported ✓ (hidden from now on)'; }); };
      const nxt = $.querySelector('#nxt'); if (nxt) nxt.onclick = () => rate('good');   // Next = Good, the default
    });
  };
  const review = i => {   // read-only look at an answered question; Forward walks back toward the current one, which starts fresh
    const { c, pick, correct } = hist[i], last = i === hist.length - 1, hasSlide = slideMode !== 'off' && cardSlides(c).length > 0;
    $.innerHTML = `<div class="sbar"><button class="x" id="back" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button><div class="prog"><i style="width:${prevPct}%"></i></div><span class="cnt">Looking back</span></div>
      <div class="page study withslide split">
      <div class="kick">Looking back</div>
      <div class="qgrid"><div class="qcol"><p class="stem">${esc(c.stem)}</p>
      <div id="opts">${c.options.map((o, j) => `<button class="opt ${j === c.answer ? 'ok' : j === pick ? 'no' : ''}" disabled><b>${'ABCDEFGH'[j] || j + 1}</b><span>${esc(o)}</span></button>${oexHtml(c, j)}`).join('')}</div></div>
      <aside class="sp"><div id="slot"></div><div id="after"><div class="fb ${correct ? 'ok' : 'no'}">
        <div class="fbh"><span class="fbi">${svg(correct ? '<path d="m5 12.500 4.500 4.500L19 7.500"/>' : '<path d="M6 6l12 12M18 6 6 18"/>')}</span>
          <div><strong>${correct ? 'You got this right' : 'You got this wrong'}</strong>${correct ? '' : `<small>Correct answer: ${'ABCDEFGH'[c.answer] || c.answer + 1}. ${esc(c.options[c.answer])}</small>`}</div></div>
        <p class="hint">${c.source === 'ai' ? 'AI can make mistakes. ' : ''}Something wrong with this question? <button id="flag" class="lnk">${c.flagged ? 'Reported ✓' : 'Report it'}</button></p></div></div></aside></div></div>
      <div class="snav"><button id="sb" aria-label="Earlier question" ${i ? '' : 'disabled'}>‹ Back</button><span>${i + 1} of ${hist.length} answered</span><button id="sf" aria-label="${last ? 'Back to current question' : 'Later question'}">${last ? 'Current' : 'Forward'} ›</button></div>`;
    $.querySelector('#back').onclick = () => home();
    if (hasSlide) showSlide($.querySelector('#slot'), c);   // looking back keeps the slide and the Report button; only the rating buttons are left out
    $.querySelector('.fbh').onclick = () => $.querySelector('#after').classList.toggle('low');
    const fl = $.querySelector('#flag'); fl.onclick = e => { e.stopPropagation(); reportDialog(c, () => { fl.textContent = 'Reported ✓ (hidden from now on)'; }); };
    $.querySelector('#sb').onclick = () => review(i - 1);
    $.querySelector('#sf').onclick = () => last ? next() : review(i + 1);
    onkeydown = e => { if (e.key === 'ArrowLeft') $.querySelector('#sb').click(); else if (e.key === 'ArrowRight' || e.key === 'Enter') $.querySelector('#sf').click(); };
  };
  next();
}

// iOS ignores user-scalable=no in places, so also swallow pinch gestures (Safari's gesture* events and multi-finger moves)
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// splash on every launch; the walkthrough only on the first one (or when replayed from the Guide)
const TOUR = [
  { h: 'Welcome to medidote', t: 'Turn your slides into exam-style questions, then study them. Works on any device.' },
  { s: '[data-v="slides"]', v: 'slides', h: '1 · Add your slides', t: 'Upload your lecture PDFs and file each under a deck.' },
  { s: '[data-act="uploadslides"]', v: 'slides', h: 'Upload', t: 'Press + to add a PDF. Questions link back to the exact slide.' },
  { s: '[data-v="generate"]', v: 'generate', h: '2 · Generate questions', t: 'AI writes hard, exam-level case questions from your slides.' },
  { s: '.gform', v: 'generate', h: 'You choose', t: 'Pick the slides, the deck and how many questions. Every option comes with an explanation.' },
  { s: '#ggo', v: 'generate', h: 'Generate', t: 'One press and your deck is ready. AI can make mistakes, so you can report any question.' },
  { s: '[data-v="today"]', v: 'today', h: '3 · Study', t: 'A short daily session. Missed questions come back sooner.' },
  { s: '.hero', v: 'today', h: 'Today at a glance', t: 'What is due, new, or worth redoing. Pick a mode and start.' },
  { s: '#hc', v: 'today', h: 'Hide choices first', t: 'Recall the answer before you see the options. Harder, but it sticks.' },
  { s: '[data-v="folders"]', v: 'folders', h: 'Folders', t: 'Group decks by subject, each with its own colour.' },
  { s: '[data-v="decks"]', v: 'decks', h: 'Decks', t: 'All your decks. Open one to study it, or press + to add one.' },
  { s: '[data-v="stats"]', v: 'stats', h: '4 · Track progress', t: 'See where you stand and what to fix.' },
  { s: '.grid, .card.empty', v: 'stats', h: 'Your numbers', t: 'Streak, what you know, weak topics and the questions you keep missing.' },
  { s: '.nv:not(.acct)[data-v="settings"]', v: 'settings', h: 'Settings', t: 'Theme, size, sounds and slides. Replay this tour from here.' },
  { s: '[data-v="guide"]', v: 'guide', h: 'Install it', t: 'Add medidote to your home screen or desktop to open it like an app.' },
];
function walkthrough() {
  if (document.querySelector('.tr')) return;
  const v0 = view, ov = document.createElement('div'); ov.className = 'tr';
  ov.innerHTML = '<div class="trh"></div><div class="trc"></div>'; document.body.append(ov);
  const [hole, card] = ov.children; let i = 0;
  hole.style.transition = card.style.transition = 'none'; // no sliding in from the corner on the first step
  const end = () => {
    try { localStorage.setItem('onboarded', '1'); } catch {}
    ov.remove();
    if (view !== v0) { view = v0; editing = false; home(); }
  };
  const step = () => {
    const S = TOUR[i], last = i === TOUR.length - 1;
    if (S.v && view !== S.v) { view = S.v; editing = false; if (S.v === 'today') folder = null; home(); }
    card.style.opacity = 0; // hidden until positioned, so it never flashes in the wrong spot
    card.innerHTML = `<small style="opacity:.6">${i + 1} / ${TOUR.length}</small><h3 style="margin:2px 0 6px">${S.h}</h3><p style="margin:0 0 14px">${S.t}</p>
      <div class="row">
      ${last ? '' : '<button id="sk">Skip</button>'}${i ? '<button id="bk">Back</button>' : ''}<button class="p" id="nx">${last ? 'Done' : 'Next'}</button></div>`;
    card.querySelector('#nx').onclick = () => last ? end() : (i++, step());
    if (i) card.querySelector('#bk').onclick = () => (i--, step());
    if (!last) card.querySelector('#sk').onclick = end;
    const place = (tries = 0) => { // views load slides and stats first, so wait for the target to exist
      let t = S.s && document.querySelector(S.s);
      if (!t && S.s && !S.s.includes('data-v=') && tries < 10) return setTimeout(place, 150, tries + 1);
      if ((!t || !t.getBoundingClientRect().width) && S.s?.includes('data-v=')) t = document.querySelector('[data-v="more"]'); // folded into More on small screens
      t?.scrollIntoView({ block: 'nearest' });
      // interface zoom: rects and fixed-position styles can use different units, so measure the ratio with a probe
      const pr = document.createElement('div'); pr.style.cssText = 'position:fixed;left:100px;top:0;width:1px;height:1px'; ov.append(pr);
      const f = pr.getBoundingClientRect().left / 100 || 1; pr.remove();
      const r0 = t?.getBoundingClientRect(), ok = r0 && r0.width > 0, W = innerWidth / f, H = innerHeight / f, w = card.offsetWidth, h = card.offsetHeight;
      const r = ok && { left: r0.left / f, right: r0.right / f, top: r0.top / f, bottom: r0.bottom / f, width: r0.width / f, height: r0.height / f };
      let x = (W - w) / 2, y = (H - h) / 2;
      if (ok) {
        Object.assign(hole.style, { left: r.left - 6 + 'px', top: r.top - 6 + 'px', width: r.width + 12 + 'px', height: r.height + 12 + (t.matches('button:not(.nv)') ? 4 : 0) + 'px' }); // buttons have a 4px drop shadow below their box
        if (r.right + 14 + w <= W - 12) { x = r.right + 14; y = r.top + r.height / 2 - h / 2; }
        else { x = r.left + r.width / 2 - w / 2; y = r.bottom + 14 + h <= H - 12 ? r.bottom + 14 : r.top - 14 - h; }
      } else Object.assign(hole.style, { left: W / 2 + 'px', top: H / 2 + 'px', width: 0, height: 0 });
      card.style.left = Math.max(12, Math.min(x, W - w - 12)) + 'px';
      card.style.top = Math.max(12, Math.min(y, H - h - 12)) + 'px';
      card.style.opacity = 1;
      requestAnimationFrame(() => requestAnimationFrame(() => hole.style.transition = card.style.transition = ''));
    };
    setTimeout(place, 150);
  };
  step();
}
function splash() {
  const el = document.createElement('div'); el.className = 'ob';
  el.innerHTML = '<div class="lr"><img class="logo" src="icon-192.png" alt=""><div class="tx"><div class="brand">medidote</div><p>the antidote to medical exam stress</p></div></div>';
  document.body.append(el);
  setTimeout(() => {
    let seen = false; try { seen = localStorage.getItem('onboarded') === '1'; } catch {}
    if (seen) { el.classList.add('out'); setTimeout(() => el.remove(), 400); }
    else { el.remove(); walkthrough(); }
  }, 1600);
}

navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
function signIn() {
  document.getElementById('nav').style.display = 'none';
  $.innerHTML = `<div class="auth">
    <div class="apanel">
      <div class="lr"><img class="logo" src="icon-192.png" alt=""><div class="tx"><div class="brand">medidote</div><p>the antidote to medical exam stress</p></div></div>
      <h2 class="ahead">Turn your lecture slides into exam-ready questions</h2>
      <ul class="afeat">
        <li><span class="ai">${svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>', 24)}</span><div><b>Case-study questions from your slides</b><small>Written by AI at exam level, with a link back to the exact slide.</small></div></li>
        <li><span class="ai">${svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 24)}</span><div><b>Every option explained</b><small>See why the right answer is right and why each wrong one is wrong.</small></div></li>
        <li><span class="ai">${svg('<path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>', 24)}</span><div><b>Spaced repetition</b><small>Questions you miss come back sooner, the ones you know come back later.</small></div></li>
      </ul>
      <p class="atrial">1 month of AI questions free · no card needed</p>
    </div>
    <section class="card acard">
      <h1>Welcome</h1><p class="asub">Sign in or create your account. It takes a few seconds.</p>
      <button class="gbtn" id="g"><svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.5 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.100 0 24s.9 7.600 2.600 10.800l7.900-6.100z"/><path fill="#34A853" d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.600-5.900c-2.100 1.400-4.900 2.300-8.300 2.300-6.300 0-11.600-4-13.500-9.800l-7.900 6.100C6.500 42.600 14.600 48 24 48z"/></svg> Continue with Google</button>
      <div class="adiv"><span>or</span></div>
      <label class="alab" for="em">Email address</label>
      <input class="inp" id="em" type="email" placeholder="you@example.com" autocomplete="email">
      <button class="p" id="ml" style="width:100%">Email me a sign-in link</button>
      <p id="msg" class="amsg" role="status"></p>
      <p class="fine">By continuing you agree to the <a href="legal/terms.html" target="_blank" rel="noopener">terms</a> and <a href="legal/privacy.html" target="_blank" rel="noopener">privacy policy</a>. You must be 18 or older.</p>
    </section></div>`;
  const msg = t => $.querySelector('#msg').textContent = t;
  $.querySelector('#g').onclick = () => sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } });
  const send = async () => {
    const email = $.querySelector('#em').value.trim(), btn = $.querySelector('#ml');
    if (!/^\S+@\S+\.\S+$/.test(email)) return msg('Type a valid email address first.');
    btn.disabled = true; msg('Sending…');
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
    btn.disabled = false;
    msg(error ? oops(error, 'Could not send the link. Check the address and try again in a minute.') : 'Check your email for the sign-in link.');
  };
  $.querySelector('#ml').onclick = send;
  $.querySelector('#em').onkeydown = e => { if (e.key === 'Enter') send(); };
}
$.addEventListener('scroll', () => document.body.classList.toggle('scrolled', $.scrollTop > 6), { passive: true });   // phone: shows the bar behind the pinned top buttons
sb.auth.getSession().then(({ data }) => {
  if (!data.session) return signIn();
  me = data.session.user;
  ready = loadAll();
  ready.catch(e => $.innerHTML = `<div class="page"><p>${oops(e, "Couldn't load your data. Check your connection and try again.")}</p><button onclick="location.reload()">Try again</button></div>`);
  home(); splash();
  ready.then(migrateDevicePdfs).then(n => { if (n && !document.body.classList.contains('studying')) home(`Moved ${n} slide file${n === 1 ? '' : 's'} from this device into your account.`); }).catch(() => {});
});
