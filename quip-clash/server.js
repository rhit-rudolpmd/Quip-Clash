'use strict';
// Quip Clash server. Zero dependencies: plain Node http + Server-Sent Events.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const FAST = !!process.env.QC_FAST; // shortens timers for automated tests
const T = FAST
  ? { ans: 4000, last: 4000, vote: 3000, lvote: 3000, rev: 700, lrev: 700 }
  : { ans: 75000, last: 60000, vote: 25000, lvote: 40000, rev: 7000, lrev: 10000 };
const rooms = new Map();

/* ---------- prompts ---------- */
const BANK = ["The worst thing to find in your sandwich","What your cat is really thinking when it stares at you","A bad slogan for a funeral home","The least helpful thing a GPS could say","A rejected flavor of ice cream","What the squirrels are plotting","The worst thing to yell during a quiet movie","A title for the autobiography of a traffic cone","Something you should never say to an airport security agent","A surprising use for a banana","What grandma’s secret ingredient actually is","The worst superpower to wake up with","A new Olympic sport that would be mostly arguing","The real reason the dinosaurs went extinct","A terrible thing to whisper to a stranger in an elevator","An unhelpful tip for a first date","What your Wi-Fi password says about you","The least reassuring thing a pilot could announce","A name for a superhero who only fights minor inconveniences","The worst possible theme for a wedding","What the moon would say if it could text","A rejected greeting card","Something you shouldn’t bring to a job interview","The worst thing to discover in your attic","What your dog does while you’re at work","The worst advice from a fortune cookie","An awkward thing to say when meeting your partner’s parents","The real reason the chicken crossed the road","A weird rule at the world’s worst summer camp","What the Mona Lisa is actually smirking about","The worst thing to say right before a bungee jump","A bad title for a horror movie set in a cheese shop","The worst thing a babysitter could say when the parents get home","A deleted scene from your life story","Something you’d hate to hear from your surgeon","A terrible job for someone who’s afraid of ducks","The most useless app ever invented","What the last slice of pizza is thinking","A bad excuse for being late to work","A sketchy product you’d find on a late-night infomercial","What your browser history would say at your funeral","An insult from a Shakespearean character who works at a gas station","The worst thing to find in a hotel bed","A dangerous thing to say to a mime","The worst possible mascot for a bank","What aliens would say about our fast-food menus","A bad thing to hear a robot vacuum say","The worst pickup line for a library","What a goat wants for its birthday","A new law that would ruin brunch","The worst thing to do at a silent retreat","A questionable ingredient in a “famous” family casserole","What the office microwave has seen","The worst thing to tell a child about the tooth fairy"];
const pick = a => a[crypto.randomInt(a.length)];
const TEMPLATES = [
  [() => 'A terrible name for ' + pick(["a pet goldfish","a luxury cruise ship for cats","a haunted pizzeria","a boy band of retired plumbers","a startup that sells air","a heavy metal band for librarians","a robot butler","a perfume for dogs","a children’s show about taxes","a very confident hamster","a bakery run by ghosts","a gym for sloths"])],
  [() => 'The worst thing to ' + pick(["say to a lifeguard","find in a birthday cake","hear from the back seat of a taxi","yell at a wedding","put in a time capsule","bring to a potluck","text your boss at 3 a.m.","say during a eulogy","do on your first day at a new job","discover in your neighbor’s garage","say to your dentist","whisper in a library"])],
  [() => 'What ' + pick(["your toaster","the neighborhood geese","a lonely traffic light","the family minivan","your houseplant","the office printer","a seagull on a pier","the world’s oldest Wi-Fi router","a vending machine","your left sock"]) + ' is secretly thinking'],
  [() => 'A rejected ' + pick(["reality show","candy bar","theme park ride","Olympic event","cartoon character","sports mascot","airline snack","perfume name","board game","superhero sidekick"]) + ' idea'],
  [() => 'The most unhelpful thing a ' + pick(["tour guide","doctor","wedding DJ","flight attendant","personal trainer","furniture store employee","life coach","lifeguard","magician","weather reporter"]) + ' could say'],
];
function genPrompts(n, used) {
  const out = [], seen = new Set();
  let guard = 0;
  while (out.length < n && guard++ < 2000) {
    const p = Math.random() < 0.45 ? pick(BANK) : pick(TEMPLATES)[0]();
    if (seen.has(p) || used.has(p)) continue;
    seen.add(p); used.add(p); out.push(p);
  }
  while (out.length < n) out.push(pick(BANK) + ' (again)'); // practically unreachable
  return out;
}

/* ---------- helpers ---------- */
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function newRoom() {
  let code;
  do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]).join(''); } while (rooms.has(code));
  const r = { code, players: [], hostId: null, phase: 'lobby', round: 0, m: 0, cur: null, deadline: 0, timer: null, used: new Set(), prompts: {}, seq: 0, touched: Date.now() };
  rooms.set(code, r); return r;
}
function addPlayer(r, name) {
  let n = clean(name, 14) || 'Player', base = n, i = 2;
  while (r.players.some(p => p.name.toLowerCase() === n.toLowerCase())) n = base + ' ' + i++;
  const p = { id: 'p' + r.seq++, token: crypto.randomBytes(12).toString('hex'), name: n, score: 0, ans: {}, vote: null, picks: [], locked: false, res: null, connected: false, drop: null };
  r.players.push(p);
  if (!r.hostId) r.hostId = p.id;
  return p;
}
const connected = r => r.players.filter(p => p.connected);
const byId = (r, id) => r.players.find(p => p.id === id);
function promptFor(r) { return r.round === 3 ? r.prompts[3][0] : r.prompts[r.round][r.m]; }
function voters(r) {
  if (r.phase !== 'vote' || !r.cur) return [];
  const cands = r.cur.c.map(x => x.p);
  return connected(r).filter(p => r.round === 3 || !cands.includes(p.id));
}
function options(r, p) { return r.cur.c.filter(x => x.p !== p.id); }
const voteDone = (r, p) => r.round === 3 ? (p.locked || options(r, p).length === 0) : p.vote !== null;

/* ---------- views ---------- */
function view(r, p) {
  const N = r.players.length, k = r.players.indexOf(p);
  const o = {
    code: r.code, phase: r.phase, round: r.round, me: p.id, host: r.hostId,
    players: r.players.map((q, i) => ({ id: q.id, name: q.name, score: q.score, ci: i, on: q.connected })),
    ms: Math.max(0, r.deadline - Date.now())
  };
  if (r.phase === 'answer') {
    const idxs = r.round === 3 ? [0] : [k, (k + N - 1) % N];
    o.tasks = idxs.map(i => ({ idx: i, q: r.prompts[r.round][i], a: p.ans[i] || null }));
    const need = r.round === 3 ? 1 : 2, cn = connected(r);
    o.done = cn.filter(q => Object.keys(q.ans).length >= need).length; o.total = cn.length;
  } else if (r.phase === 'vote') {
    o.q = promptFor(r);
    o.cands = r.cur.c.map(x => ({ o: x.o, t: x.t, mine: x.p === p.id }));
    o.isCand = r.cur.c.some(x => x.p === p.id);
    o.choice = p.vote; o.picks = p.picks; o.locked = p.locked;
    const vs = voters(r); o.votesTotal = vs.length; o.votesIn = vs.filter(q => voteDone(r, q)).length;
  } else if (r.phase === 'reveal') {
    o.q = promptFor(r);
    o.res = r.cur.c.map(x => ({ name: byId(r, x.p).name, t: x.t, v: x.v, d: x.d }));
    o.qp = !!r.cur.qp;
  }
  return o;
}
function broadcast(r) {
  r.touched = Date.now();
  for (const p of r.players) if (p.res) { try { p.res.write('data: ' + JSON.stringify(view(r, p)) + '\n\n'); } catch (e) {} }
}

/* ---------- game engine ---------- */
function schedule(r, ms, fn, grace) {
  clearTimeout(r.timer); r.deadline = Date.now() + ms; r.timer = setTimeout(fn, ms + (grace || 0));
}
function startGame(r) {
  const N = r.players.length; if (N < 3 || N > 6) return;
  const pr = genPrompts(2 * N + 1, r.used);
  r.prompts = { 1: pr.slice(0, N), 2: pr.slice(N, 2 * N), 3: [pr[2 * N]] };
  r.players.forEach(p => { p.score = 0; });
  startRound(r, 1);
}
function startRound(r, rd) {
  r.round = rd; r.m = 0; r.cur = null; r.phase = 'answer';
  r.players.forEach(p => { p.ans = {}; p.vote = null; p.picks = []; p.locked = false; });
  schedule(r, rd === 3 ? T.last : T.ans, () => afterAnswers(r), 1500);
  broadcast(r);
}
function afterAnswers(r) { if (r.round === 3) startLastVote(r); else startMatchup(r, 0); }
function labelOptions(c) { c.forEach((x, i) => { x.o = 'o' + i; }); return c; }
function startMatchup(r, m) {
  const N = r.players.length, A = r.players[m], B = r.players[(m + 1) % N];
  r.m = m;
  const c = labelOptions(shuffle([{ p: A.id, t: A.ans[m] || '' }, { p: B.id, t: B.ans[m] || '' }]));
  r.players.forEach(p => { p.vote = null; p.picks = []; p.locked = false; });
  if (c.filter(x => x.t).length < 2) {
    c.forEach(x => { x.v = 0; x.d = x.t ? 500 * r.round : 0; byId(r, x.p).score += x.d; });
    r.cur = { c, qp: false }; r.phase = 'reveal';
    schedule(r, T.rev, () => afterReveal(r)); broadcast(r); return;
  }
  r.cur = { c }; r.phase = 'vote';
  schedule(r, T.vote, () => tally(r), 1500); broadcast(r); check(r);
}
function startLastVote(r) {
  const c = labelOptions(shuffle(r.players.map(p => ({ p: p.id, t: p.ans[0] || '' })).filter(x => x.t)));
  r.m = 0;
  r.players.forEach(p => { p.vote = null; p.picks = []; p.locked = false; });
  if (c.length < 2) {
    c.forEach(x => { x.v = 0; x.d = 0; });
    r.cur = { c }; r.phase = 'reveal'; schedule(r, T.lrev, () => afterReveal(r)); broadcast(r); return;
  }
  r.cur = { c }; r.phase = 'vote';
  schedule(r, T.lvote, () => tally(r), 1500); broadcast(r); check(r);
}
function tally(r) {
  if (r.phase !== 'vote') return;
  const c = r.cur.c.map(x => ({ p: x.p, t: x.t, o: x.o, v: 0, d: 0 })), rd = r.round;
  let qp = false;
  if (rd < 3) {
    for (const p of r.players) {
      if (c.some(x => x.p === p.id) || p.vote === null) continue;
      const k = c.find(x => x.o === p.vote); if (k) k.v++;
    }
    const tot = c.reduce((s, x) => s + x.v, 0);
    c.forEach(x => {
      if (tot > 0) { x.d = Math.round(1000 * rd * x.v / tot / 10) * 10; if (tot >= 2 && x.v === tot) { x.d += 250 * rd; qp = true; } }
      byId(r, x.p).score += x.d;
    });
  } else {
    for (const p of r.players) for (const o of new Set(p.picks)) {
      const k = c.find(x => x.o === o); if (k && k.p !== p.id) k.v++;
    }
    c.forEach(x => { x.d = x.v * 200; byId(r, x.p).score += x.d; });
    c.sort((a, b) => b.v - a.v);
  }
  r.cur = { c, qp }; r.phase = 'reveal';
  schedule(r, rd === 3 ? T.lrev : T.rev, () => afterReveal(r)); broadcast(r);
}
function afterReveal(r) {
  if (r.phase !== 'reveal') return;
  if (r.round < 3) { if (r.m + 1 < r.players.length) startMatchup(r, r.m + 1); else startRound(r, r.round + 1); }
  else { clearTimeout(r.timer); r.phase = 'final'; r.cur = null; r.deadline = 0; broadcast(r); }
}
function check(r) {
  if (!connected(r).length) return;
  if (r.phase === 'answer') {
    const need = r.round === 3 ? 1 : 2;
    if (connected(r).every(p => Object.keys(p.ans).length >= need)) afterAnswers(r);
  } else if (r.phase === 'vote') {
    if (voters(r).every(p => voteDone(r, p))) tally(r);
  }
}
function toLobby(r) {
  clearTimeout(r.timer); r.phase = 'lobby'; r.round = 0; r.cur = null; r.deadline = 0;
  r.players = r.players.filter(p => p.connected);
  if (!r.players.some(p => p.id === r.hostId)) r.hostId = r.players[0] ? r.players[0].id : null;
  r.players.forEach(p => { p.score = 0; p.ans = {}; p.vote = null; p.picks = []; p.locked = false; });
  broadcast(r);
}
function reassignHost(r) {
  const h = byId(r, r.hostId);
  if (!h || !h.connected) { const n = connected(r)[0]; if (n) r.hostId = n.id; }
}

/* ---------- HTTP ---------- */
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', d => { b += d; if (b.length > 4096) { req.destroy(); resolve(null); } });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function findPlayer(code, token) {
  const r = rooms.get(String(code || '').toUpperCase()); if (!r) return {};
  const p = r.players.find(q => q.token === token); return { r, p };
}
const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    fs.readFile(INDEX, (e, d) => {
      if (e) { res.writeHead(500); return res.end('Missing public/index.html'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(d);
    }); return;
  }
  if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const { r, p } = findPlayer(url.searchParams.get('room'), url.searchParams.get('token'));
    if (!p) { res.writeHead(404); return res.end(); }
    if (p.res) { try { p.res.end(); } catch (e) {} }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    p.res = res; p.connected = true; clearTimeout(p.drop);
    reassignHost(r); broadcast(r); check(r);
    req.on('close', () => {
      if (p.res !== res) return;
      p.res = null; p.connected = false;
      if (r.phase === 'lobby') {
        p.drop = setTimeout(() => {
          if (p.connected) return;
          r.players = r.players.filter(q => q !== p); reassignHost(r);
          if (!r.players.some(q => q.id === r.hostId)) r.hostId = r.players[0] ? r.players[0].id : null;
          broadcast(r);
        }, 30000);
      }
      reassignHost(r); broadcast(r); check(r);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const b = await readBody(req); if (!b) return send(res, 400, { error: 'Bad request' });
    const op = url.pathname.slice(5);
    if (op === 'create') {
      if (rooms.size > 500) return send(res, 503, { error: 'Server is busy, try again later.' });
      const r = newRoom(), p = addPlayer(r, b.name); return send(res, 200, { room: r.code, token: p.token });
    }
    if (op === 'join') {
      const r = rooms.get(String(b.room || '').toUpperCase().trim());
      if (!r) return send(res, 404, { error: 'No room with that code.' });
      if (r.phase !== 'lobby') return send(res, 409, { error: 'That game has already started.' });
      if (r.players.length >= 6) return send(res, 409, { error: 'That room is full (6 players).' });
      const p = addPlayer(r, b.name); return send(res, 200, { room: r.code, token: p.token });
    }
    const { r, p } = findPlayer(b.room, b.token);
    if (!p) return send(res, 404, { error: 'Not in that room.' });
    const isHost = r.hostId === p.id;
    if (op === 'start') { if (isHost && r.phase === 'lobby' && r.players.length >= 3) startGame(r); }
    else if (op === 'end') { if (isHost && r.phase !== 'lobby') toLobby(r); }
    else if (op === 'answer') {
      if (r.phase === 'answer') {
        const N = r.players.length, k = r.players.indexOf(p), idx = Number(b.idx);
        const ok = r.round === 3 ? [0] : [k, (k + N - 1) % N], t = clean(b.text, 55);
        if (ok.includes(idx) && t && p.ans[idx] === undefined) { p.ans[idx] = t; check(r); }
      }
    } else if (op === 'vote') {
      if (r.phase === 'vote' && r.round < 3 && !r.cur.c.some(x => x.p === p.id) && r.cur.c.some(x => x.o === b.o)) { p.vote = b.o; check(r); }
    } else if (op === 'picks') {
      if (r.phase === 'vote' && r.round === 3 && !p.locked && Array.isArray(b.picks)) {
        const opts = options(r, p).map(x => x.o), cap = Math.min(3, opts.length);
        p.picks = [...new Set(b.picks)].filter(o => opts.includes(o)).slice(0, cap);
      }
    } else if (op === 'lock') {
      if (r.phase === 'vote' && r.round === 3) { p.locked = true; check(r); }
    } else return send(res, 404, { error: 'Unknown action' });
    broadcast(r); return send(res, 200, { ok: true });
  }
  res.writeHead(404); res.end('Not found');
});

setInterval(() => { for (const r of rooms.values()) for (const p of r.players) if (p.res) { try { p.res.write(': ping\n\n'); } catch (e) {} } }, 20000);
setInterval(() => {
  for (const [code, r] of rooms) if (!connected(r).length && Date.now() - r.touched > 30 * 60000) { clearTimeout(r.timer); rooms.delete(code); }
}, 60000);

server.listen(PORT, () => console.log('Quip Clash running on http://localhost:' + PORT));
