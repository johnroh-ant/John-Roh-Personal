#!/usr/bin/env node
/*
 * Ground-truth scorer: replays a recorded field GPS trace through the
 * tracker engine and grades every prediction against what the bus actually
 * did, derived from the trace itself.
 *
 * Usage:
 *   node groundtruth.js <trace.jsonl> [options]
 *
 * Options:
 *   --tracker <path>   engine (default: the repo's tracker.js)
 *   --site <path>      site JSON fixture (route polyline/stops)   (default: verify/lts-fresh.json)
 *   --dep <path>       departure data: a JSON fixture, or a recorder's
 *                      <out>-departures.jsonl (its first snapshot)  (default: verify/dep-*.json)
 *   --modes home,work  rider stops to score (default both)
 *   --tick <sec>       ALSO replay on a render tick of <sec> seconds (the app
 *                      re-renders every 15 s between pings, so GPS silence
 *                      during a hold is visible); 0 disables (default 15)
 *   --bus <name>       only this bus
 *   --radius <m>       "at the stop" radius (default 35)
 *   --gone <m>         "departed" = this far past the stop (default 120)
 *   --window <min>     ETA-error window before an actual arrival (default 25)
 *   --json <path>      write the full structured result here
 *   --log              print every evaluation row
 *
 * Trace format: JSONL, one fix per line {id, name, when(epoch ms), lat, lng, speed(m/s)}
 * (a JSON array of the same objects is also accepted).
 *
 * Ground truth (per bus):
 *   track    Viterbi decode of the fixes onto the loop polyline: forward-only
 *            continuity (small GPS regressions tolerated), emission = distance to
 *            the passage, a "teleport" escape for deadheads/yard moves. This
 *            resolves the parallel passages (Berry@MC approach vs the 4th St
 *            return, Fremont vs Howard) that defeat nearest-line projection.
 *   visit    arrival   = first fix within --radius of the stop (on the stop's passage)
 *            lastNear  = last fix within --radius before the bus is gone
 *            departure = last fix before the bus is > --gone m past and moving away
 *            goneAt    = that first fix > --gone m past
 *            dwell     = lastNear - arrival
 *            A drive-through with no fix inside the radius is recovered from the
 *            track's crossing of the stop's routeDist (interpolated, flagged).
 *   holds    stationary episodes >= 60 s (displacement from the episode start
 *            < 40 m, GPS gaps included) with where they happened.
 *
 * Grading (per mode = rider stop):
 *   FALSE-DEPARTED  engine method 'next-trip' ("already passed your stop") while
 *                   the bus is AT the stop (arrival..lastNear) or still APPROACHING
 *                   it on this side of the loop. 'soft' = bus 35-120 m past, still
 *                   pulling away (departure not yet confirmed).
 *   ETA ERROR       predicted arrival - actual arrival for evaluations in the
 *                   --window minutes before an actual arrival (+ = engine says later).
 *                   While AT the stop the engine should read ~0 min.
 *   INSTABILITY     arrival jumps > 3 min between consecutive evaluations of the
 *                   same bus, excluding the legitimate rollover when the bus
 *                   actually leaves the stop.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const VERIFY = __dirname;
function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const tracePath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(VERIFY, 'traces.jsonl');
const T = require(path.resolve(argOf('tracker', path.join(__dirname, '..', '..', '..', 'tracker.js'))));
const sitePath = argOf('site', path.join(VERIFY, 'lts-fresh.json'));
const depPath = argOf('dep', (() => {
  const f = fs.readdirSync(VERIFY).find(n => /^dep-.*\.json$/.test(n));
  return f ? path.join(VERIFY, f) : null;
})());
const MODES = argOf('modes', 'home,work').split(',');
const TICK = Number(argOf('tick', 15));
const ONLY_BUS = argOf('bus', null);
const R_NEAR = Number(argOf('radius', 35));
const R_GONE = Number(argOf('gone', 120));
const WINDOW_SEC = Number(argOf('window', 25)) * 60;
const LOG = process.argv.includes('--log');
const JSON_OUT = argOf('json', null);

const model = T.buildLoopModel(JSON.parse(fs.readFileSync(sitePath, 'utf8')));
if (!model) throw new Error('no loop model from ' + sitePath);
function loadDepartures(p) {
  const txt = fs.readFileSync(p, 'utf8').trim();
  // record.js writes one {poll, sha1, data} line per changed snapshot
  if (txt.startsWith('{')) return JSON.parse(txt.split('\n')[0]).data;
  return JSON.parse(txt);
}
const trips = T.buildTrips(loadDepartures(depPath), model);
const L = model.path.length;

// ------------------------------------------------------------------ utils
const toRad = Math.PI / 180;
function hav(a, b, c, d) {
  const dl = (c - a) * toRad, dn = (d - b) * toRad;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a * toRad) * Math.cos(c * toRad) * Math.sin(dn / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}
const mod = (n, m) => ((n % m) + m) % m;
const signedOff = (rd, target) => mod(rd - target + L / 2, L) - L / 2; // + = past target
function clock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}
function sodOf(ms) { const z = T.tzNow(new Date(ms)); return z.minutes * 60 + z.seconds; }
function clockSod(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60, s = sec % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
const fmtMin = s => (s === null || s === undefined || !Number.isFinite(s)) ? '-' : (s >= 0 ? '+' : '') + (s / 60).toFixed(1) + 'm';
function pct(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
}

// Where on the loop is route distance rd, in words.
function whereLabel(rd) {
  const n = model.stops.length;
  let k = T.legAt(model, rd);
  const from = model.stops[k - 1], to = model.stops[k];
  const past = mod(rd - from.routeDist, L), ahead = mod(to.routeDist - rd, L);
  if (past < 40) return 'at ' + from.name;
  if (ahead < 40) return 'at ' + to.name;
  return Math.round(ahead) + ' m before ' + to.name + ' (' + Math.round(past) + ' m past ' + from.name + ')';
}

// All distinct passages of the polyline near a point (wider net than the
// engine's projectCandidates, so the true passage survives off-route stretches).
function candidates(lat, lng) {
  const pt = T.toXY(lat, lng), P = model.path, raw = [];
  for (let i = 0; i + 1 < P.verts.length; i++) {
    const a = P.verts[i], b = P.verts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2)) : 0;
    const px = a.x + t * dx, py = a.y + t * dy;
    raw.push({ d: Math.hypot(pt.x - px, pt.y - py), rd: P.cum[i] + t * Math.sqrt(len2) });
  }
  raw.sort((x, y) => x.d - y.d);
  const cap = Math.max(raw[0].d * 3 + 50, 250), out = [];
  for (const c of raw) {
    if (c.d > cap || out.length >= 8) break;
    if (out.some(o => { const g = Math.abs(c.rd - o.rd); return Math.min(g, L - g) < 120; })) continue;
    out.push(c);
  }
  return out;
}

// ------------------------------------------------------- track (Viterbi)
const SIGMA = 25, TELEPORT = 300, MAX_V = 20;
function emission(d) { const x = Math.min(d, 400) / SIGMA; return 0.5 * x * x; }
function decodeTrack(fixes) {
  const S = fixes.map(f => candidates(f.lat, f.lng));
  const cost = [], back = [];
  cost[0] = S[0].map(c => emission(c.d));
  back[0] = S[0].map(() => ({ j: -1, tele: false, delta: 0 }));
  for (let i = 1; i < fixes.length; i++) {
    const dt = (fixes[i].when - fixes[i - 1].when) / 1000;
    const maxAdv = MAX_V * dt + 150;
    let bestPrev = 0;
    cost[i - 1].forEach((c, j) => { if (c < cost[i - 1][bestPrev]) bestPrev = j; });
    cost[i] = []; back[i] = [];
    S[i].forEach((b, jb) => {
      let best = cost[i - 1][bestPrev] + TELEPORT, bk = { j: bestPrev, tele: true, delta: 0 };
      S[i - 1].forEach((a, ja) => {
        const delta = mod(b.rd - a.rd + 150, L) - 150;
        let tr;
        if (delta < -40) tr = ((-delta - 40) / 15) ** 2;
        else if (delta <= maxAdv || dt > 900) tr = 0;
        else return;
        const c = cost[i - 1][ja] + tr;
        if (c < best) { best = c; bk = { j: ja, tele: false, delta }; }
      });
      cost[i][jb] = best + emission(b.d);
      back[i][jb] = bk;
    });
  }
  // backtrack
  const n = fixes.length, pick = new Array(n);
  let j = 0;
  cost[n - 1].forEach((c, k) => { if (c < cost[n - 1][j]) j = k; });
  for (let i = n - 1; i >= 0; i--) {
    pick[i] = { cand: S[i][j], tele: back[i][j].tele, delta: back[i][j].delta };
    j = back[i][j].j;
  }
  // unwrap within continuous segments
  let seg = 0, U = pick[0].cand.rd;
  return fixes.map((f, i) => {
    if (i > 0) {
      if (pick[i].tele) { seg++; U = pick[i].cand.rd; } else U += pick[i].delta;
    }
    return Object.assign({}, f, { rd: pick[i].cand.rd, off: pick[i].cand.d, U, seg, tele: i > 0 && pick[i].tele });
  });
}

// ----------------------------------------------------- stationary episodes
function findHolds(track) {
  const out = [];
  let i = 0;
  while (i < track.length) {
    let j = i;
    while (j + 1 < track.length && hav(track[i].lat, track[i].lng, track[j + 1].lat, track[j + 1].lng) < 40) j++;
    const dur = (track[j].when - track[i].when) / 1000;
    if (dur >= 60) {
      out.push({
        start: track[i].when, end: track[j].when, leftBy: j + 1 < track.length ? track[j + 1].when : null,
        durSec: Math.round(dur), rd: track[i].rd, off: Math.round(track[i].off),
        where: track[i].off > 80 ? 'off-route (' + Math.round(track[i].off) + ' m off; yard/layover?) near ' + whereLabel(track[i].rd) : whereLabel(track[i].rd),
        fixes: j - i + 1,
        maxGapSec: Math.round(Math.max(0, ...track.slice(i + 1, j + 1).map((p, k) => (p.when - track[i + k].when) / 1000)))
      });
    }
    i = j + 1;
  }
  return out;
}

// ------------------------------------------------------------ stop visits
function findVisits(track, stop) {
  const visits = [];
  const target = stop.routeDist;
  const dist = track.map(p => hav(p.lat, p.lng, stop.lat, stop.lng));
  const off = track.map(p => signedOff(p.rd, target));
  const onPassage = i => Math.abs(off[i]) <= 200;
  let i = 0;
  while (i < track.length) {
    if (!(dist[i] <= R_NEAR && onPassage(i))) { i++; continue; }
    const v = { arrival: track[i].when, arrivalIdx: i, lastNear: track[i].when, passThrough: false };
    if (i > 0) v.prevFix = { when: track[i - 1].when, dist: Math.round(dist[i - 1]) };
    let j = i + 1, gone = -1;
    for (; j < track.length; j++) {
      if (dist[j] <= R_NEAR && onPassage(j)) { v.lastNear = track[j].when; continue; }
      if ((off[j] > R_GONE && dist[j] > R_NEAR) || (off[j] > 0 && dist[j] > R_GONE) || dist[j] > 600 || track[j].tele) { gone = j; break; }
    }
    if (gone >= 0) {
      v.goneAt = track[gone].when;
      v.departure = track[gone - 1].when;
      v.goneDist = Math.round(dist[gone]);
    } else {
      v.goneAt = null; v.departure = null; v.openAtTraceEnd = true;
    }
    v.dwellSec = Math.round((v.lastNear - v.arrival) / 1000);
    visits.push(v);
    i = gone >= 0 ? gone : track.length;
  }
  // drive-throughs without a fix inside the radius: crossing of the stop's
  // routeDist by the continuous track
  for (let k = 1; k < track.length; k++) {
    const a = track[k - 1], b = track[k];
    if (b.seg !== a.seg) continue;
    const oa = off[k - 1], ob = off[k];
    if (!(oa < 0 && ob >= 0 && oa > -400 && ob < 400)) continue;
    if (Math.min(dist[k - 1], dist[k]) > 250) continue; // a different passage
    if (visits.some(v => Math.abs(v.arrival - b.when) < 180000 || (v.arrival <= b.when && (v.goneAt || Infinity) >= a.when))) continue;
    const f = -oa / (ob - oa);
    const t = Math.round(a.when + f * (b.when - a.when));
    visits.push({ arrival: t, lastNear: t, departure: t, goneAt: b.when, dwellSec: 0, passThrough: true,
      prevFix: { when: a.when, dist: Math.round(dist[k - 1]) } });
  }
  // trace ends while the bus is closing in on the stop: extrapolate the
  // imminent arrival (flagged; +-~1 min) so the approach can still be scored
  const lastI = track.length - 1, lf = track[lastI];
  if (off[lastI] < -R_NEAR && off[lastI] > -600 && (lf.speed || 0) > 2 && lf.off < 80 &&
      !visits.some(v => v.arrival >= lf.when - 60000)) {
    const t = Math.round(lf.when + (-off[lastI]) / Math.max(lf.speed, 5) * 1000);
    visits.push({ arrival: t, lastNear: t, departure: null, goneAt: null, dwellSec: null, extrapolated: true,
      prevFix: { when: lf.when, dist: Math.round(dist[lastI]) } });
  }
  visits.sort((x, y) => x.arrival - y.arrival);
  // schedule context: nearest published time at this stop
  visits.forEach(v => {
    const sod = sodOf(v.arrival);
    let best = null;
    trips.forEach(tr => tr.entries.forEach(e => {
      if (!T.sameStop(model, e.idx, stop.idx)) return;
      const d = sod - e.min * 60;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { d, min: e.min, trip: tr.startMin };
    }));
    if (best) { v.schedMin = best.min; v.schedTrip = best.trip; v.vsSchedSec = best.d; }
  });
  return visits;
}

// ---------------------------------------------------------- truth at time t
// Position by linear interpolation between bracketing fixes of the same
// continuous segment (a gap with < 40 m displacement = stationary).
function truthAt(track, t) {
  let k = track.length - 1;
  while (k > 0 && track[k].when > t) k--;
  const a = track[k], b = track[k + 1];
  if (!b || b.seg !== a.seg || t <= a.when) return { rd: a.rd, U: a.U, off: a.off, seg: a.seg };
  const f = (t - a.when) / (b.when - a.when);
  const U = a.U + f * (b.U - a.U);
  return { rd: mod(U, L), U, off: a.off + f * (b.off - a.off), seg: a.seg };
}

// The loop anchor (first stop) of the service period around time t: PM
// trips start at the Nektar terminal, AM trips at Berry St & King St.
function anchorAt(sod) {
  let best = null;
  trips.forEach(tr => {
    const d = Math.abs(tr.startMin * 60 - sod);
    if (!best || d < best.d) best = { d, rd: tr.entries[0].routeDist, idx: tr.entries[0].idx };
  });
  return best;
}

/*
 * Truth phase of the bus relative to the rider's stop at time t:
 *   at-stop        between arrival and lastNear of a visit
 *   pulling-away   left the radius but not yet confirmed gone (35-120 m past)
 *   approach-leg   past the trip anchor and short of the stop: on the trip that
 *                  will serve the stop ("already passed" is false)
 *   staging        within 600 m short of the anchor (layover/positioning for the
 *                  trip that serves the stop) - "next loop" label is debatable
 *   departed       anywhere else: the stop was served on this loop
 *   yard/off-route parked > 80 m off the route (out of service)
 */
function phaseAt(track, visits, holds, stop, t, lastFixWhen) {
  const tr = truthAt(track, t);
  const o = signedOff(tr.rd, stop.routeDist);
  const ph = { truthRd: Math.round(tr.rd), truthOff: Math.round(tr.off), metersToStop: Math.round(mod(stop.routeDist - tr.rd, L)) };
  const hold = holds.find(h => h.start <= t && t <= (h.leftBy || h.end));
  if (hold) { ph.inHold = true; ph.holdElapsedSec = Math.round((t - hold.start) / 1000); ph.holdWhere = hold.where; ph.holdTotalSec = hold.durSec; }
  if (tr.off > 80) ph.offRoute = true;
  const nxt = visits.find(v => v.arrival > t);
  if (nxt) { ph.visit = nxt; ph.secToArrival = Math.round((nxt.arrival - t) / 1000); }
  const cur = visits.find(v => v.arrival <= t && t <= v.lastNear);
  if (cur) return Object.assign(ph, { phase: 'at-stop', visit: cur, metersToStop: 0, secToArrival: undefined, dwellElapsedSec: Math.round((t - cur.arrival) / 1000) });
  const pull = visits.find(v => v.lastNear < t && v.goneAt && t < v.goneAt);
  if (pull) return Object.assign(ph, { phase: 'pulling-away', visit: pull, metersPast: Math.max(0, Math.round(o)), secToArrival: undefined });
  if (ph.offRoute && hold) return Object.assign(ph, { phase: 'yard/off-route' });
  const anc = anchorAt(sodOf(t));
  const fromAnchor = mod(tr.rd - anc.rd, L), stopFromAnchor = mod(stop.routeDist - anc.rd, L);
  if (fromAnchor <= 50 && ph.inHold) ph.phase = 'staging'; // still sitting at the anchor
  else if (fromAnchor <= stopFromAnchor) ph.phase = 'approach-leg';
  else if (L - fromAnchor < 600) ph.phase = 'staging';
  else {
    ph.phase = 'departed';
    ph.metersPast = Math.round(mod(tr.rd - stop.routeDist, L));
    const last = visits.filter(v => (v.goneAt || v.lastNear) <= t).pop();
    if (last) ph.secSinceDeparture = Math.round((t - (last.departure || last.lastNear)) / 1000);
  }
  if (!nxt && ph.phase === 'approach-leg') {
    // upcoming visit not in the trace: extrapolate only when imminent
    const fix = track.filter(p => p.when <= t).pop();
    if (ph.metersToStop < 600 && fix && t - fix.when < 30000 && lastFixWhen - t < 120000) {
      ph.extrapolatedArrival = t + ph.metersToStop / Math.max(fix.speed || 0, 5) * 1000;
    }
  }
  return ph;
}

// -------------------------------------------------------------- main
function loadTrace(p) {
  const txt = fs.readFileSync(p, 'utf8').trim();
  let rows;
  if (txt.startsWith('[')) rows = JSON.parse(txt);
  else rows = txt.split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } });
  // recordings made with the fleet recorder carry every TMA route: keep this one
  // (rows with no route key at all are the older single-route format; a
  // fleet row with route null is a bus not assigned to any route)
  return rows.filter(r => r && Number.isFinite(r.lat) && Number.isFinite(r.lng) && Number.isFinite(r.when) &&
    (!('route' in r) || (r.route && typeof r.route === 'object' ? r.route.id : r.route) === T.CONFIG.routeId));
}

function evaluate(busName, track, visitsByMode, holds, mode, times) {
  const stopIdx = T.findStopIndex(model, mode);
  const stop = model.stops[stopIdx];
  const visits = visitsByMode[mode];
  const prevFixes = {};
  const rows = [];
  const lastFixWhen = track[track.length - 1].when;
  let fi = 0;
  for (const t of times) {
    while (fi + 1 < track.length && track[fi + 1].when <= t) fi++;
    const f = track[fi];
    const bus = { id: f.id || busName, name: busName, lat: f.lat, lng: f.lng, speed: f.speed || 0, when: f.when, showOnMap: true };
    const p0 = T.predictions(model, trips, [bus], mode, prevFixes, new Date(t))[0] || null;
    // a 'parked' row offers no ETA (bus parked off-route, not in service): score it as no prediction
    const p = p0 && p0.method === 'parked' ? null : p0;
    const ph = phaseAt(track, visits, holds, stop, t, lastFixWhen);
    const r = {
      t, clock: clock(t), sod: sodOf(t), fixAgeSec: Math.round((t - f.when) / 1000), speed: +(f.speed || 0).toFixed(1),
      method: p0 ? p0.method : 'NONE', etaSec: p ? p.etaSec : null, arrivalSec: p ? p.arrivalSec : null,
      delaySec: p ? p.delaySec : null, trip: p && p.tripStartMin ? T.fmtClock(p.tripStartMin) : null,
      holding: p ? p.holding : null, stale: p ? p.stale : null,
      engRd: p ? Math.round(p.fix.routeDist) : null, engMeters: p ? Math.round(p.meters) : null,
      engHoldSec: p ? Math.round(p.fix.holdSec || 0) : null,
      engLeg: p ? p.legFrom + ' -> ' + p.legTo : null,
      truth: ph
    };
    // grading
    if (ph.visit) r.actualArrivalSod = sodOf(ph.visit.arrival);
    if (p && p.method === 'next-trip') {
      if (ph.phase === 'at-stop') r.falseDeparted = 'HARD: bus at the stop';
      else if (ph.phase === 'approach-leg') r.falseDeparted = 'HARD: bus on its approach, ' + ph.metersToStop + ' m to go' + (ph.secToArrival !== undefined ? ', arrives in ' + fmtMin(ph.secToArrival) : '');
      else if (ph.phase === 'staging') r.labelOnly = 'next-loop label while staging ' + ph.metersToStop + ' m out';
      else if (ph.phase === 'pulling-away') r.falseDeparted = 'soft: ' + ph.metersPast + ' m past, departure not yet confirmed';
      else if (ph.phase === 'yard/off-route') r.falseDepartedYard = true;
    }
    if (p && ph.phase === 'yard/off-route' && p.method !== 'next-trip' && p.method !== 'scheduled-only' && p.etaSec <= 20 * 60) {
      r.phantom = 'parked off-route ' + ph.truthOff + ' m for ' + ph.holdElapsedSec + ' s, engine says ' + Math.round(p.etaSec / 60) + ' min';
    }
    if (ph.phase === 'at-stop' && p) r.atStopEtaSec = p.etaSec;
    const approaching = ph.phase !== 'at-stop' && ph.phase !== 'pulling-away' && ph.phase !== 'yard/off-route';
    if (approaching && ph.visit && ph.secToArrival <= WINDOW_SEC && p) {
      r.etaErrSec = p.arrivalSec - r.actualArrivalSod;
      // the rider is late if the engine says after the bus actually left
      // the rider is told a time after the bus actually left (would miss it)
      if (!ph.visit.extrapolated) r.afterDeparture = p.arrivalSec > sodOf(ph.visit.departure || ph.visit.lastNear);
      if (ph.visit.extrapolated) r.extrapolatedVisit = true;
    } else if (approaching && !ph.visit && ph.extrapolatedArrival && p) {
      r.etaErrSecExtrap = p.arrivalSec - sodOf(ph.extrapolatedArrival);
    }
    if ((ph.phase === 'approach-leg' || ph.phase === 'at-stop' || ph.phase === 'pulling-away' ||
        (approaching && ph.visit && ph.secToArrival <= WINDOW_SEC)) && !p) r.dropped = ph.phase === 'at-stop' ? 'bus vanished while AT the stop' : true;
    rows.push(r);
  }
  // instability
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.arrivalSec === null || b.arrivalSec === null) continue;
    const jump = b.arrivalSec - a.arrivalSec;
    if (Math.abs(jump) <= 180) continue;
    const rollover = visits.some(v => (v.lastNear >= a.t && v.lastNear < b.t) || (v.goneAt && v.goneAt > a.t && v.goneAt <= b.t)) ||
      ((a.truth.phase === 'at-stop' || a.truth.phase === 'pulling-away') && b.truth.phase !== a.truth.phase);
    b.jumpSec = jump; b.jumpKind = rollover ? 'rollover' : 'jump';
  }
  // per-visit view: what the rider saw around each actual visit
  const perVisit = visits.map(v => {
    const win = rows.filter(r => r.truth.visit === v && r.etaErrSec !== undefined);
    const errs = win.map(r => r.etaErrSec);
    const at = rows.filter(r => r.t >= v.arrival && r.t <= v.lastNear);
    const pull = rows.filter(r => r.t > v.lastNear && v.goneAt && r.t < v.goneAt);
    const firstNext = rows.find(r => r.t >= v.arrival && r.method === 'next-trip' && r.t <= (v.goneAt || v.arrival) + 600000);
    return {
      arrival: clock(v.arrival), lastNear: clock(v.lastNear), goneAt: v.goneAt ? clock(v.goneAt) : null, extrapolated: !!v.extrapolated,
      windowEvals: win.length,
      absErrMedianSec: pct(errs.map(Math.abs), 0.5), absErrP90Sec: pct(errs.map(Math.abs), 0.9),
      maxLateSec: errs.length ? Math.max(...errs) : null, maxEarlySec: errs.length ? Math.min(...errs) : null,
      riderWouldMiss: win.filter(r => r.afterDeparture).length,
      atStopMethods: at.map(r => r.method + '/' + Math.round(r.etaSec / 60) + 'm').join(' '),
      pullingAwayMethods: pull.map(r => r.method + '/' + Math.round((r.etaSec || 0) / 60) + 'm').join(' '),
      firstNextTrip: firstNext ? clock(firstNext.t) + ' (' + (v.goneAt ? fmtMin((firstNext.t - v.goneAt) / 1000) + ' vs gone' : '') + ')' : null
    };
  });
  return { mode, stop: stop.name, rows, perVisit };
}

function summarize(evals) {
  const all = evals.flatMap(e => e.rows);
  const err = all.filter(r => r.etaErrSec !== undefined);
  const abs = err.map(r => Math.abs(r.etaErrSec));
  return {
    evaluations: all.length,
    falseDepartedHard: all.filter(r => r.falseDeparted && r.falseDeparted.startsWith('HARD')).length,
    falseDepartedSoft: all.filter(r => r.falseDeparted && r.falseDeparted.startsWith('soft')).length,
    nextTripAtYard: all.filter(r => r.falseDepartedYard).length,
    nextTripWhileStaging: all.filter(r => r.labelOnly).length,
    droppedWhileApproaching: all.filter(r => r.dropped).length,
    phantomYardEta: all.filter(r => r.phantom).length,
    etaScored: err.length,
    etaAbsMedianSec: pct(abs, 0.5), etaAbsP90Sec: pct(abs, 0.9), etaAbsMaxSec: abs.length ? Math.max(...abs) : null,
    etaMeanSignedSec: err.length ? Math.round(err.reduce((s, r) => s + r.etaErrSec, 0) / err.length) : null,
    etaOver3min: err.filter(r => Math.abs(r.etaErrSec) > 180).length,
    etaOver3minLate: err.filter(r => r.etaErrSec > 180).length,
    etaOver3minEarly: err.filter(r => r.etaErrSec < -180).length,
    saidAfterBusLeft: err.filter(r => r.afterDeparture).length,
    atStopEvals: all.filter(r => r.atStopEtaSec !== undefined).length,
    atStopEtaOver2min: all.filter(r => r.atStopEtaSec !== undefined && r.atStopEtaSec > 120).length,
    jumps: all.filter(r => r.jumpKind === 'jump').length,
    rollovers: all.filter(r => r.jumpKind === 'rollover').length
  };
}

function rowLine(r) {
  const tr = r.truth;
  return `${r.clock} age${String(r.fixAgeSec).padStart(4)}s v${String(r.speed).padStart(4)} | ${r.method.padEnd(14)} arr ${r.arrivalSec !== null ? clockSod(r.arrivalSec) : '--:--:--'} eta ${r.etaSec !== null ? String(Math.round(r.etaSec / 60)).padStart(2) + 'm' : ' - '}` +
    ` trip ${(r.trip || '-').padEnd(8)} dly ${fmtMin(r.delaySec).padStart(6)}${r.holding ? ' HOLDING' : ''}${r.stale ? ' STALE' : ''} engRd ${r.engRd} engHold ${r.engHoldSec}s` +
    ` || truth ${tr.phase}${tr.metersToStop !== undefined ? ' ' + tr.metersToStop + 'm-to-go' : ''}${tr.secToArrival !== undefined ? ' arrIn ' + fmtMin(tr.secToArrival) : ''}${tr.inHold ? ' HOLD+' + tr.holdElapsedSec + 's' : ''} rd ${tr.truthRd}` +
    `${r.etaErrSec !== undefined ? ' ERR ' + fmtMin(r.etaErrSec) : ''}${r.etaErrSecExtrap !== undefined ? ' ERR~' + fmtMin(r.etaErrSecExtrap) : ''}${r.falseDeparted ? ' **FALSE-DEPARTED ' + r.falseDeparted + '**' : ''}${r.jumpKind ? ' [' + r.jumpKind + ' ' + fmtMin(r.jumpSec) + ']' : ''}`;
}


// Group consecutive flagged rows of the same class into episodes.
function flagOf(r) {
  if (r.falseDeparted) return 'FALSE-DEPARTED ' + r.falseDeparted.split(':')[0];
  if (r.atStopEtaSec !== undefined && r.atStopEtaSec > 120) return 'AT-STOP-BUT-ETA>2min';
  if (r.dropped) return 'DROPPED';
  if (r.phantom) return 'PHANTOM (yard bus given a live ETA)';
  if (r.etaErrSec !== undefined && r.etaErrSec > 180) return 'ETA>3min LATE';
  if (r.etaErrSec !== undefined && r.etaErrSec < -180) return 'ETA>3min EARLY';
  if (r.etaErrSecExtrap !== undefined && Math.abs(r.etaErrSecExtrap) > 180) return 'ETA~>3min (extrapolated arrival)';
  if (r.labelOnly) return 'next-loop-while-staging';
  return null;
}
function printEpisodes(rows) {
  let ep = null;
  const flush = () => {
    if (!ep) return;
    const worst = ep.rows.reduce((w, r) => Math.abs(r.etaErrSec || r.etaErrSecExtrap || 0) > Math.abs(w.etaErrSec || w.etaErrSecExtrap || 0) ? r : w, ep.rows[0]);
    console.log(`     ## ${ep.flag}: ${ep.rows[0].clock}-${ep.rows[ep.rows.length - 1].clock} (${ep.rows.length} evals)`);
    console.log('        first ' + rowLine(ep.rows[0]));
    if (worst !== ep.rows[0]) console.log('        worst ' + rowLine(worst));
    if (ep.rows.length > 1) console.log('        last  ' + rowLine(ep.rows[ep.rows.length - 1]));
    ep = null;
  };
  rows.forEach(r => {
    const f = flagOf(r);
    if (r.jumpKind === 'jump') { flush(); console.log('     ## JUMP ' + fmtMin(r.jumpSec) + ': ' + rowLine(r)); }
    if (f && ep && ep.flag === f) { ep.rows.push(r); return; }
    flush();
    if (f) ep = { flag: f, rows: [r] };
  });
  flush();
}

function main() {
  const rows = loadTrace(tracePath);
  const byBus = {};
  rows.forEach(r => (byBus[r.name || r.id] = byBus[r.name || r.id] || []).push(r));
  const result = { trace: tracePath, generated: new Date().toISOString(), loopMeters: Math.round(L), buses: {} };
  const totals = { fix: [], tick: [] };

  for (const [name, pts0] of Object.entries(byBus)) {
    if (ONLY_BUS && name !== ONLY_BUS) continue;
    const pts = pts0.slice().sort((a, b) => a.when - b.when).filter((p, i, a) => i === 0 || p.when !== a[i - 1].when);
    if (pts.length < 2) continue;
    const track = decodeTrack(pts);
    const holds = findHolds(track);
    const visitsByMode = {};
    MODES.forEach(m => { visitsByMode[m] = findVisits(track, model.stops[T.findStopIndex(model, m)]); });
    const B = result.buses[name] = {
      span: clock(pts[0].when) + ' - ' + clock(pts[pts.length - 1].when), fixes: pts.length,
      segments: track[track.length - 1].seg + 1,
      holds, visits: {}, evals: {}
    };

    console.log(`\n================ BUS ${name}  ${B.span}  ${pts.length} fixes, ${B.segments} continuous track segment(s)`);
    console.log('  Stationary episodes >= 60 s:');
    holds.forEach(h => console.log(`    ${clock(h.start)} - ${clock(h.end)}${h.leftBy ? ' (moving by ' + clock(h.leftBy) + ')' : ''}  ${String(h.durSec).padStart(4)} s  ${h.fixes} fixes, max GPS gap ${h.maxGapSec} s  @ ${h.where}`));
    for (const mode of MODES) {
      const stop = model.stops[T.findStopIndex(model, mode)];
      const vs = visitsByMode[mode];
      B.visits[mode] = vs.map(v => ({
        stop: stop.name, arrival: clock(v.arrival), lastNear: clock(v.lastNear), departure: v.departure ? clock(v.departure) : null,
        goneAt: v.goneAt ? clock(v.goneAt) : null, dwellSec: v.dwellSec, passThrough: v.passThrough, extrapolated: !!v.extrapolated,
        prevFix: v.prevFix ? clock(v.prevFix.when) + ' @' + v.prevFix.dist + 'm' : null,
        sched: v.schedMin !== undefined ? T.fmtClock(v.schedMin) + ' (trip ' + T.fmtClock(v.schedTrip) + ')' : null,
        vsSchedMin: v.vsSchedSec !== undefined ? +(v.vsSchedSec / 60).toFixed(1) : null
      }));
      console.log(`  Visits to ${stop.name} [${mode}]: ${vs.length ? '' : 'none in trace'}`);
      B.visits[mode].forEach(v => console.log(`    arrive ${v.arrival} (prev fix ${v.prevFix})  lastNear ${v.lastNear}  departure ${v.departure}  gone ${v.goneAt}  dwell ${v.dwellSec}s${v.passThrough ? ' PASS-THROUGH' : ''}${v.extrapolated ? ' EXTRAPOLATED (trace ends ' + v.prevFix + ' out)' : ''}  sched ${v.sched} -> ${v.vsSchedMin > 0 ? '+' : ''}${v.vsSchedMin} min`));
    }

    for (const kind of ['fix', 'tick']) {
      if (kind === 'tick' && !(TICK > 0)) continue;
      const times = kind === 'fix' ? pts.map(p => p.when) : (() => {
        const out = [];
        for (let t = pts[0].when; t <= pts[pts.length - 1].when; t += TICK * 1000) out.push(t);
        return out;
      })();
      B.evals[kind] = {};
      for (const mode of MODES) {
        const ev = evaluate(name, track, visitsByMode, holds, mode, times);
        B.evals[kind][mode] = ev;
        totals[kind].push(ev);
        const s = summarize([ev]);
        console.log(`  -- [${kind}-replay ${mode}: ${ev.stop}] ${s.evaluations} evals | FALSE-DEPARTED hard ${s.falseDepartedHard} soft ${s.falseDepartedSoft} (yard ${s.nextTripAtYard}) | ETA scored ${s.etaScored}: |err| med ${fmtMin(s.etaAbsMedianSec)} p90 ${fmtMin(s.etaAbsP90Sec)} max ${fmtMin(s.etaAbsMaxSec)} bias ${fmtMin(s.etaMeanSignedSec)} >3min ${s.etaOver3min} (late ${s.etaOver3minLate}/early ${s.etaOver3minEarly}) after-bus-left ${s.saidAfterBusLeft} | at-stop evals ${s.atStopEvals}, eta>2min ${s.atStopEtaOver2min} | jumps ${s.jumps} rollovers ${s.rollovers} | dropped ${s.droppedWhileApproaching}`);
        ev.perVisit.forEach(pv => console.log(`     visit ${pv.arrival}${pv.extrapolated ? ' (extrapolated)' : ''}: ${pv.windowEvals} evals in ${WINDOW_SEC / 60}-min window, |err| med ${fmtMin(pv.absErrMedianSec)} p90 ${fmtMin(pv.absErrP90Sec)}, worst late ${fmtMin(pv.maxLateSec)} / early ${fmtMin(pv.maxEarlySec)}, rider-would-miss ${pv.riderWouldMiss} | at stop: ${pv.atStopMethods || '-'} | pulling away: ${pv.pullingAwayMethods || '-'} | first next-trip ${pv.firstNextTrip || '-'}`));
        if (LOG) { ev.rows.forEach(r => console.log('     ' + rowLine(r))); continue; }
        printEpisodes(ev.rows);
      }
    }
  }
  console.log('\n================ TOTALS');
  for (const kind of Object.keys(totals)) {
    if (!totals[kind].length) continue;
    for (const mode of MODES) {
      const s = summarize(totals[kind].filter(e => e.mode === mode));
      console.log(`  [${kind}-replay ${mode}] ` + JSON.stringify(s));
      result['totals_' + kind + '_' + mode] = s;
    }
  }
  if (JSON_OUT) {
    // strip circular visit refs
    fs.writeFileSync(JSON_OUT, JSON.stringify(result, (k, v) => (k === 'visit' ? undefined : v), 1));
    console.log('wrote', JSON_OUT);
  }
}
main();
