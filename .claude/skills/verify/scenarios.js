#!/usr/bin/env node
/*
 * Holding-bus / false-departure scenarios for the Mission Bay shuttle engine.
 *
 *   node scenarios.js [path/to/tracker.js] [--all] [--only S1a,S2b] [--quiet]
 *
 * Each scenario drives ONE synthetic bus through a physical plan (approach,
 * hold, depart) relative to the rider's stop, evaluating T.predictions every
 * STEP seconds with the bus fix time == evaluation time. Every step is run
 * twice: WARM (one persistent prevFixes object, as the browser does) and
 * COLD (a fresh {} each step, i.e. app just opened).
 *
 * Flags
 *   HARD  FALSE-DEPARTED  bus has not left its stop/hold yet but method=next-trip
 *   HARD  RESURRECTED     bus left >=60 s ago, is >=250 m past and moving, but
 *                         the app still says it is arriving (non next-trip, <10 min)
 *   soft  ETA-HIDES-ARRIVAL  bus is driving to the stop and will be there in
 *                         X, app says >= X+3 min (the "11 min" field complaint)
 *   soft  AT-STOP-SHOWS-MIN  bus is physically at the stop (within 100 m), app
 *                         shows >= 2 min with no holding cue
 *   soft  NOW-TOO-EARLY   app says Now/arriving (<45 s) but the bus is still
 *                         >2 min from pulling in
 * Consecutive steps with identical readings are collapsed (use --all to see
 * every step). Exit code = number of HARD flags in WARM+COLD runs.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const trackerArg = args.find(a => !a.startsWith('--') && /\.js$/.test(a));
const TRACKER = trackerArg ? path.resolve(trackerArg) : path.join(__dirname, '..', '..', '..', 'tracker.js');
const SHOW_ALL = args.includes('--all');
const QUIET = args.includes('--quiet');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : null;

const T = require(TRACKER);
const V = __dirname + '/';
const model = T.buildLoopModel(JSON.parse(fs.readFileSync(V + 'lts-fresh.json', 'utf8')));
const trips = T.buildTrips(JSON.parse(fs.readFileSync(V + 'dep-6467db5ea59bbb100741d7b7.json', 'utf8')), model);
const L = model.path.length;

const DAY = '2026-10-13'; // Tuesday (the field report's morning)
const BASE = new Date(DAY + 'T00:00:00-07:00').getTime();
const STEP = 20; // seconds between evaluations

// ---------------------------------------------------------------- helpers
const hms = s => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + (x || 0); };
const clk = sec => {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
};
const clockMin = secOfDay => T.fmtClock(Math.round(secOfDay / 60) % 1440);
const stopAt = name => model.stops.find(s => s.name.includes(name));

// point on the drawn route at routeDist d, optionally shifted `lat` meters
// perpendicular to the path (GPS cross-track error)
function pointAt(dist, lateral) {
  const p = model.path;
  const d = T.mod(dist, p.length);
  for (let i = 0; i + 1 < p.verts.length; i++) {
    if (p.cum[i + 1] >= d) {
      const f = (d - p.cum[i]) / (p.cum[i + 1] - p.cum[i]);
      const a = p.verts[i], b = p.verts[i + 1];
      let lat = a.lat + f * (b.lat - a.lat), lng = a.lng + f * (b.lng - a.lng);
      if (lateral) {
        const dx = b.x - a.x, dy = b.y - a.y, n = Math.hypot(dx, dy) || 1;
        const MLAT = 111320, MLNG = Math.cos(37.77 * Math.PI / 180) * MLAT;
        lng += (-dy / n) * lateral / MLNG; lat += (dx / n) * lateral / MLAT;
      }
      return { lat, lng };
    }
  }
  return p.verts[p.verts.length - 1];
}

// deterministic jitter in [0,1)
function rnd(k) { const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

/*
 * A plan is a list of phases, each starting where the previous ended:
 *   {move: {to, speed}}             drive forward to offset `to` (m rel. stop)
 *   {hold: {until, jitter, lat}}    sit at the current offset until clock
 *                                   `until`, along-track jitter in [0, jitter]
 *   {move: {speed, until}}          drive until clock `until`
 * tag: 'approach' | 'hold' | 'depart' (the physical truth used for flags)
 */
function buildPlan(startClock, startOff, phases) {
  const segs = [];
  let t = hms(startClock), off = startOff;
  for (const ph of phases) {
    if (ph.move) {
      const sp = ph.move.speed;
      const t1 = ph.move.until ? hms(ph.move.until) : t + (ph.move.to - off) / sp;
      segs.push({ t0: t, t1, kind: 'move', off0: off, speed: sp, tag: ph.tag, lat: ph.lat || 0 });
      off = off + sp * (t1 - t); t = t1;
    } else if (ph.hold) {
      const t1 = hms(ph.hold.until);
      segs.push({ t0: t, t1, kind: 'hold', off0: off, jitter: ph.hold.jitter || 0, tag: ph.tag, lat: ph.lat || 0 });
      t = t1;
    }
  }
  return { segs, tEnd: t };
}
function stateAt(plan, t) {
  const s = plan.segs.find(x => t >= x.t0 && t < x.t1) || plan.segs[plan.segs.length - 1];
  if (s.kind === 'move') return { off: s.off0 + s.speed * (t - s.t0), speed: s.speed, tag: s.tag, lat: s.lat };
  const j = s.jitter ? rnd(t) * s.jitter : 0;
  return { off: s.off0 + j, speed: 0.3, tag: s.tag, lat: s.lat ? (rnd(t + 7) - 0.5) * 2 * s.lat : 0 };
}

// ---------------------------------------------------------------- runner
const totals = { hard: 0, soft: 0, byScenario: [] };

function run(sc) {
  if (ONLY && !ONLY.includes(sc.id)) return;
  const stop = stopAt(sc.stop);
  const plan = buildPlan(sc.start, sc.startOff, sc.phases);
  const tEnd = sc.end ? hms(sc.end) : plan.tEnd;
  // physical truth: when the bus reaches the pole / leaves its hold
  let arriveAt = null, departAt = null;
  for (let t = hms(sc.start); t <= tEnd; t += 1) {
    const s = stateAt(plan, t);
    if (arriveAt === null && s.off >= -15 && s.tag !== 'approach-hold') arriveAt = t;
    if (departAt === null && s.tag === 'depart') departAt = t;
  }
  if (sc.arriveAt) arriveAt = hms(sc.arriveAt);
  const warmFixes = {};
  const rows = [];
  const busId = sc.busName || '76084';
  for (let t = hms(sc.start); t <= tEnd + 0.1; t += sc.step || STEP) {
    const s = stateAt(plan, t);
    const pt = pointAt(stop.routeDist + s.off, s.lat);
    const whenMs = BASE + t * 1000;
    const fixMs = sc.freezeFixAt && t > hms(sc.freezeFixAt) ? BASE + hms(sc.freezeFixAt) * 1000 : whenMs;
    const fs0 = sc.freezeFixAt && t > hms(sc.freezeFixAt) ? stateAt(plan, hms(sc.freezeFixAt)) : s;
    const fpt = fixMs === whenMs ? pt : pointAt(stop.routeDist + fs0.off, fs0.lat);
    const bus = { id: busId, name: busId, lat: fpt.lat, lng: fpt.lng, speed: fs0.speed, when: fixMs, showOnMap: true };
    const now = new Date(whenMs);
    const warm = T.predictions(model, trips, [bus], sc.mode, warmFixes, now)[0] || null;
    const cold = T.predictions(model, trips, [Object.assign({}, bus)], sc.mode, {}, now)[0] || null;
    const projOff = warm ? T.mod(warm.fix.routeDist - stop.routeDist + L / 2, L) - L / 2 : null;
    const flagsFor = (p) => {
      const f = [];
      if (!p) return f;
      const notLeft = departAt === null || t < departAt;
      if (notLeft && p.method === 'next-trip') f.push('HARD:FALSE-DEPARTED');
      if (departAt !== null && t >= departAt + 60 && s.off >= 250 && s.speed > 2 &&
          p.method !== 'next-trip' && p.etaSec < 600) f.push('HARD:RESURRECTED');
      if (arriveAt !== null && t < arriveAt && s.speed > 2 && p.method !== 'next-trip' &&
          p.arrivalSec - arriveAt >= 180) f.push('soft:ETA-HIDES-ARRIVAL(+' + Math.round((p.arrivalSec - arriveAt) / 60) + 'm)');
      // (a reading marked holding, which shows its departure time, is fine)
      if (arriveAt !== null && t >= arriveAt && notLeft && s.off >= -20 && s.off <= 100 &&
          p.method !== 'next-trip' && p.etaSec >= 120 && !p.holding) f.push('soft:AT-STOP-SHOWS-MIN');
      if (arriveAt !== null && t < arriveAt - 120 && p.etaSec < 45) f.push('soft:NOW-TOO-EARLY(' + Math.round((arriveAt - t) / 60) + 'm out)');
      return f;
    };
    const wf = flagsFor(warm), cf = flagsFor(cold).map(x => x + '(cold)');
    rows.push({ t, s, warm, cold, wf, cf, projOff });
  }

  // print
  if (!QUIET) {
    console.log('\n' + '='.repeat(150));
    console.log(`${sc.id}  ${sc.title}`);
    console.log(`   mode=${sc.mode} stop=${stop.name} (rd ${Math.round(stop.routeDist)})  physical: reaches stop ${arriveAt !== null ? clk(arriveAt) : '-'}  departs hold ${departAt !== null ? clk(departAt) : '-'}`);
    if (sc.note) console.log('   note: ' + sc.note);
    console.log('   ' + ['time', 'phase', 'off', 'proj', 'spd', '| WARM method', 'eta', 'arrive', 'delay', 'trip', 'hold', 'holdSec', '| COLD method', 'eta', 'arrive', 'trip', '| flags'].join('  '));
  }
  const sig = r => [r.s.tag, r.warm && r.warm.method, r.warm && clockMin(r.warm.arrivalSec), r.warm && r.warm.tripStartMin, r.warm && r.warm.holding,
    r.cold && r.cold.method, r.cold && clockMin(r.cold.arrivalSec), r.cold && r.cold.tripStartMin, r.wf.join(), r.cf.join()].join('|');
  let i = 0;
  const lineOf = (r, r2, n) => {
    const w = r.warm, c = r.cold;
    const range = n > 1 ? clk(r.t) + '-' + clk(r2.t) + ` (${n})` : clk(r.t);
    const eta = (p, q) => !p ? '-' : (q && q !== p && q.etaMin !== p.etaMin ? p.etaMin + '..' + q.etaMin : String(p.etaMin));
    const offs = n > 1 && Math.round(r2.s.off) !== Math.round(r.s.off) ? Math.round(r.s.off) + '..' + Math.round(r2.s.off) : String(Math.round(r.s.off));
    return '   ' + [range.padEnd(26), r.s.tag.padEnd(8), offs.padStart(9), String(r.projOff === null ? '-' : Math.round(r.projOff)).padStart(5), r.s.speed.toFixed(1),
      '|', (w ? w.method : 'none').padEnd(10), eta(w, r2.warm).padStart(5), (w ? clockMin(w.arrivalSec) : '-').padEnd(8),
      (w && w.delaySec !== null ? String(Math.round(w.delaySec)) : '-').padStart(5), (w && w.tripStartMin ? T.fmtClock(w.tripStartMin) : '-').padEnd(8),
      (w && w.holding ? 'Y' : '.'), (w ? String(Math.round(w.fix.holdSec)) : '-').padStart(4),
      '|', (c ? c.method : 'none').padEnd(10), eta(c, r2.cold).padStart(5), (c ? clockMin(c.arrivalSec) : '-').padEnd(8), (c && c.tripStartMin ? T.fmtClock(c.tripStartMin) : '-').padEnd(8),
      '|', r.wf.concat(r.cf).join(' ')].join(' ');
  };
  let hard = 0, soft = 0, firstHard = null;
  const flagged = new Set();
  rows.forEach(r => r.wf.concat(r.cf).forEach(f => {
    if (f.startsWith('HARD')) { hard++; if (!firstHard) firstHard = clk(r.t) + ' ' + f; } else soft++;
    flagged.add(f.replace(/\(.*?\)/g, '').replace(/\(cold\)/, '') + (f.endsWith('(cold)') ? '(cold)' : ''));
  }));
  while (i < rows.length) {
    let j = i;
    if (!SHOW_ALL) while (j + 1 < rows.length && sig(rows[j + 1]) === sig(rows[i])) j++;
    if (!QUIET) {
      console.log(lineOf(rows[i], rows[j], j - i + 1));
    }
    i = j + 1;
  }
  totals.hard += hard; totals.soft += soft;
  totals.byScenario.push({ id: sc.id, hard, soft, firstHard, flags: [...flagged].join(', ') });
}

// ---------------------------------------------------------------- scenarios
const BMC = 'Berry at Mission Creek', HOW = '500 Howard';
// Berry & King (AM anchor) is 558 m before BMC: the staged lead-in parks
// ~30 m past it (inside the 250 m anchor radius).
const BK_OFF = Math.round(stopAt('Berry St & King St').routeDist - stopAt(BMC).routeDist); // ~ -558

// Lead-in reproducing the field reading ("11 min · arrives ~9:31 · on
// schedule" at 9:19 with the bus 0.2 mi out): the bus laid over at Berry &
// King (staged for the 9:29 departure), then pulled out early.
const stagedLeadIn = (startOff) => [
  { tag: 'approach', hold: { until: '9:18:25', jitter: 8 } },
  { tag: 'approach', move: { to: -320, speed: 6 } },
];
const s1Tail = (holdOff, holdUntil, jitter) => [
  { tag: 'approach', move: { to: holdOff, speed: 6 } },
  { tag: 'hold', hold: { until: holdUntil, jitter: jitter } },
  { tag: 'depart', move: { speed: 6, until: '9:33:00' } },
];

const SCENARIOS = [
  { id: 'S1a', mode: 'work', stop: BMC, title: 'FIELD REPORT: early 9:29-trip bus (staged at Berry&King) pulls out, reaches BMC ~9:20, holds AT the stop (0-20 m past) to 9:30:30, departs',
    start: '9:12:00', startOff: BK_OFF + 30, phases: stagedLeadIn().concat(s1Tail(0, '9:30:30', 20)), end: '9:33:00' },
  { id: 'S1b', mode: 'work', stop: BMC, title: 'S1 with memory starting at 9:19 (no staged history): 320 m out at 6 m/s, holds AT the stop (0-20 m) to 9:30:30',
    start: '9:19:00', startOff: -320, phases: s1Tail(0, '9:30:30', 20), end: '9:33:00' },
  { id: 'S1c', mode: 'work', stop: BMC, title: 'S1a with realistic GPS: along-track jitter 0-20 m AND +/-12 m cross-track while held at the stop',
    start: '9:12:00', startOff: BK_OFF + 30, phases: stagedLeadIn().concat([
      { tag: 'approach', move: { to: 0, speed: 6 } },
      { tag: 'hold', hold: { until: '9:30:30', jitter: 20 }, lat: 12 },
      { tag: 'depart', move: { speed: 6, until: '9:33:00' } }]), end: '9:33:00' },
  { id: 'S2a', mode: 'work', stop: BMC, title: 'S1a but holds 60 m PAST the pole (field-measured at-stop dwell projects +11..+93 m)',
    start: '9:12:00', startOff: BK_OFF + 30, phases: stagedLeadIn().concat(s1Tail(60, '9:30:30', 10)), end: '9:33:00' },
  { id: 'S2b', mode: 'work', stop: BMC, title: 'S1a but holds 130 m PAST the pole (just beyond the 120 m grace)',
    start: '9:12:00', startOff: BK_OFF + 30, phases: stagedLeadIn().concat(s1Tail(130, '9:30:30', 10)), end: '9:33:00' },
  { id: 'S2c', mode: 'work', stop: BMC, title: 'S1a but holds 200 m PAST the pole',
    start: '9:12:00', startOff: BK_OFF + 30, phases: stagedLeadIn().concat(s1Tail(200, '9:30:30', 10)), end: '9:33:00' },
  { id: 'S2d', mode: 'work', stop: BMC, title: 'S1b (memory from 9:19, matched to the LATE 9:05 trip) but holds 60 m past',
    start: '9:19:00', startOff: -320, phases: s1Tail(60, '9:30:30', 10), end: '9:33:00' },
  { id: 'S3', mode: 'work', stop: BMC, title: 'holds 150 m BEFORE the stop until 9:29:30, pulls in (~9:29:55), dwells, departs 9:31',
    start: '9:12:00', startOff: BK_OFF + 30, phases: stagedLeadIn().concat([
      { tag: 'approach', move: { to: -150, speed: 6 } },
      { tag: 'approach', hold: { until: '9:29:30', jitter: 10 } },
      { tag: 'approach', move: { to: 0, speed: 6 } },
      { tag: 'hold', hold: { until: '9:31:00', jitter: 15 } },
      { tag: 'depart', move: { speed: 6, until: '9:33:00' } }]), end: '9:33:00' },
  { id: 'S4', mode: 'work', stop: BMC, title: 'ON-TIME 9:29 trip: departs Berry&King 9:29:00, at BMC 9:31, dwells 3 min (0-20 m), departs 9:34',
    start: '9:26:00', startOff: BK_OFF + 20, phases: [
      { tag: 'approach', hold: { until: '9:29:00', jitter: 5 } },
      { tag: 'approach', move: { to: 0, speed: 538 / 120 } },
      { tag: 'hold', hold: { until: '9:34:00', jitter: 20 } },
      { tag: 'depart', move: { speed: 6, until: '9:36:00' } }], end: '9:36:00' },
  { id: 'S4b', mode: 'work', stop: BMC, title: 'ON-TIME 8:09 trip (15-min headway): at BMC 8:11, dwells 3 min, departs 8:14',
    start: '8:09:00', startOff: BK_OFF, phases: [
      { tag: 'approach', move: { to: 0, speed: 558 / 120 } },
      { tag: 'hold', hold: { until: '8:14:00', jitter: 20 } },
      { tag: 'depart', move: { speed: 6, until: '8:16:00' } }], end: '8:16:00' },
  { id: 'S4L', mode: 'work', stop: BMC, title: 'LATE bus: 9:05 trip ~13 min late reaches BMC 9:20, dwells 3 min (0-20 m), departs 9:23 (no staged history)',
    start: '9:17:30', startOff: BK_OFF + 50, phases: [
      { tag: 'approach', move: { to: 0, speed: 6 } },
      { tag: 'hold', hold: { until: '9:23:00', jitter: 20 } },
      { tag: 'depart', move: { speed: 6, until: '9:25:00' } }], end: '9:25:00' },
  { id: 'S5a', mode: 'home', stop: HOW, title: 'PM early bus (3:30 trip, ~5 min early) reaches 500 Howard ~3:54, holds AT stop (0-20 m) to 3:59:30',
    start: '3:52:30', startOff: -500, phases: [
      { tag: 'approach', move: { to: 0, speed: 6 } },
      { tag: 'hold', hold: { until: '15:59:30', jitter: 20 } },
      { tag: 'depart', move: { speed: 6, until: '16:02:00' } }].map(p => p), end: '16:02:00', pm: true },
  { id: 'S5b', mode: 'home', stop: HOW, title: 'PM early bus holds 60 m past 500 Howard to 3:59:30',
    start: '3:52:30', startOff: -500, phases: [
      { tag: 'approach', move: { to: 60, speed: 6 } },
      { tag: 'hold', hold: { until: '15:59:30', jitter: 10 } },
      { tag: 'depart', move: { speed: 6, until: '16:02:00' } }], end: '16:02:00', pm: true },
  { id: 'S5c', mode: 'home', stop: HOW, title: 'PM early bus holds 130 m past 500 Howard to 3:59:30',
    start: '3:52:30', startOff: -500, phases: [
      { tag: 'approach', move: { to: 130, speed: 6 } },
      { tag: 'hold', hold: { until: '15:59:30', jitter: 10 } },
      { tag: 'depart', move: { speed: 6, until: '16:02:00' } }], end: '16:02:00', pm: true },
  { id: 'S5d', mode: 'home', stop: HOW, title: 'PM early bus holds 150 m BEFORE 500 Howard until 3:58:30, pulls in, departs 3:59:30',
    start: '3:52:30', startOff: -500, phases: [
      { tag: 'approach', move: { to: -150, speed: 6 } },
      { tag: 'approach', hold: { until: '15:58:30', jitter: 10 } },
      { tag: 'approach', move: { to: 0, speed: 6 } },
      { tag: 'hold', hold: { until: '15:59:30', jitter: 15 } },
      { tag: 'depart', move: { speed: 6, until: '16:02:00' } }], end: '16:02:00', pm: true },
  { id: 'S5e', mode: 'home', stop: HOW, title: 'PM LATE bus (3:30 trip ~8 min late) at 500 Howard 4:07, dwells 4 min, departs 4:11',
    start: '4:05:30', startOff: -500, phases: [
      { tag: 'approach', move: { to: 0, speed: 6 } },
      { tag: 'hold', hold: { until: '16:11:00', jitter: 20 } },
      { tag: 'depart', move: { speed: 6, until: '16:13:00' } }], end: '16:13:00', pm: true },
  { id: 'S6a', mode: 'work', stop: BMC, title: 'GENUINE DEPARTURE (control): on-time 9:05 trip, at BMC 9:07, leaves 9:07:30 at 3.3 m/s, +400 m by ~9:09:30',
    start: '9:05:00', startOff: BK_OFF, phases: [
      { tag: 'approach', move: { to: 0, speed: 558 / 120 } },
      { tag: 'hold', hold: { until: '9:07:30', jitter: 10 } },
      { tag: 'depart', move: { speed: 3.3, until: '9:10:30' } }], end: '9:10:30' },
  { id: 'S6b', mode: 'work', stop: BMC, title: 'GENUINE DEPARTURE (control): S1a bus after its hold (left 9:30:30), continues to +700 m',
    start: '9:12:00', startOff: BK_OFF + 30, phases: stagedLeadIn().concat([
      { tag: 'approach', move: { to: 0, speed: 6 } },
      { tag: 'hold', hold: { until: '9:30:30', jitter: 20 } },
      { tag: 'depart', move: { speed: 3.3, until: '9:34:00' } }]), end: '9:34:00' },
  { id: 'S6c', mode: 'work', stop: BMC, title: 'GENUINE EARLY DEPARTURE (control): 9:29-trip bus does NOT hold — passes BMC 9:20 and keeps going',
    start: '9:12:00', startOff: BK_OFF + 30, phases: stagedLeadIn().concat([
      { tag: 'approach', move: { to: 0, speed: 6 } },
      { tag: 'hold', hold: { until: '9:20:15', jitter: 5 } },
      { tag: 'depart', move: { speed: 3.3, until: '9:24:00' } }]), end: '9:24:00' },
  { id: 'S6d', mode: 'home', stop: HOW, title: 'GENUINE DEPARTURE (control, PM): 3:30-trip bus on time, at 500 Howard 3:59, leaves 3:59:30, +400 m ~4:01:30',
    start: '3:57:30', startOff: -500, phases: [
      { tag: 'approach', move: { to: 0, speed: 6 } },
      { tag: 'hold', hold: { until: '15:59:30', jitter: 10 } },
      { tag: 'depart', move: { speed: 3.3, until: '16:02:30' } }], end: '16:02:30', pm: true },
  { id: 'S8', mode: 'work', stop: BMC, title: 'LONG hold at the stop after the trip started: 9:29 trip at BMC 9:31, held (0-20 m) until 9:48 waiting for the next bus',
    start: '9:29:00', startOff: BK_OFF + 20, phases: [
      { tag: 'approach', move: { to: 0, speed: 538 / 120 } },
      { tag: 'hold', hold: { until: '9:48:00', jitter: 20 } },
      { tag: 'depart', move: { speed: 6, until: '9:50:00' } }], end: '9:50:00' },
  { id: 'S9', mode: 'work', stop: BMC, title: 'GPS goes quiet while held at the stop (last fix 9:20:40, at the pole) — S1a lead-in',
    start: '9:12:00', startOff: BK_OFF + 30, freezeFixAt: '9:20:40', phases: stagedLeadIn().concat(s1Tail(0, '9:30:30', 20)), end: '9:30:20' },
  { id: 'S10', mode: 'work', stop: BMC, title: 'held 60 m past BMC with heavy GPS wander (0-45 m along, +/-15 m cross: the 4th&King return passage is ~15 m away)',
    start: '9:12:00', startOff: BK_OFF + 30, phases: stagedLeadIn().concat([
      { tag: 'approach', move: { to: 40, speed: 6 } },
      { tag: 'hold', hold: { until: '9:30:30', jitter: 45 }, lat: 15 },
      { tag: 'depart', move: { speed: 6, until: '9:33:00' } }]), end: '9:33:00' },
];

// PM clocks in the scenario table are written 12h for readability; normalize
for (const sc of SCENARIOS) {
  if (sc.pm) {
    const fix = c => { const [h] = c.split(':').map(Number); return h < 12 ? c.replace(/^\d+/, String(h + 12)) : c; };
    sc.start = fix(sc.start); if (sc.end) sc.end = fix(sc.end);
    sc.phases.forEach(p => { if (p.hold) p.hold.until = fix(p.hold.until); if (p.move && p.move.until) p.move.until = fix(p.move.until); });
  }
}

console.log(`tracker: ${TRACKER}`);
console.log(`day ${DAY} | loop ${Math.round(L)} m | ${trips.length} trips | step ${STEP}s | BMC rd ${Math.round(stopAt(BMC).routeDist)} | 500 Howard rd ${Math.round(stopAt(HOW).routeDist)} | grace ${T.CONFIG.passedStopGraceMeters} m`);
SCENARIOS.forEach(run);

console.log('\n' + '='.repeat(150));
console.log('SUMMARY (HARD = false departure / resurrected; soft = misleading ETA)');
for (const s of totals.byScenario) {
  console.log('  ' + s.id.padEnd(5) + ' hard ' + String(s.hard).padStart(3) + '  soft ' + String(s.soft).padStart(3) +
    (s.firstHard ? '  first: ' + s.firstHard : '') + (s.flags ? '  [' + s.flags + ']' : ''));
}
console.log(`TOTAL hard ${totals.hard}  soft ${totals.soft}`);
process.exitCode = Math.min(totals.hard, 125);
