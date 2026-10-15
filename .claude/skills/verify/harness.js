// Live + synthetic validation harness for tracker.js
const T = require(require('path').join(__dirname, '..', '..', '..', 'tracker.js'));

function fmtSec(s) { const m = Math.floor(s / 60); return m + 'm' + String(Math.round(s % 60)).padStart(2, '0'); }
function clockOf(secOfDay) { return T.fmtClock(Math.round(secOfDay / 60)); }

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + label + (detail ? '  [' + detail + ']' : ''));
  if (!cond) failures++;
}

// Live data when the feed is reachable; otherwise (or with HARNESS_OFFLINE=1)
// the committed fixtures, so the scenario checks still run in restricted networks.
let OFFLINE = !!process.env.HARNESS_OFFLINE;
async function loadData() {
  if (!OFFLINE) {
    try {
      return await Promise.all([T.fetchLiveSite(), T.fetchDepartures()]);
    } catch (e) {
      console.log('live feed unreachable (' + e.message + ') — using committed fixtures');
      OFFLINE = true;
    }
  }
  const fs = require('fs'), path = require('path');
  return [JSON.parse(fs.readFileSync(path.join(__dirname, 'lts-fresh.json'))),
    JSON.parse(fs.readFileSync(path.join(__dirname, 'dep-6467db5ea59bbb100741d7b7.json')))];
}

// The committed route and timetable, for checks pinned to what the field
// recordings were scored against (a live redraw would shift route distances).
let fixtureCache = null;
function fixture() {
  if (!fixtureCache) {
    const fs = require('fs'), path = require('path');
    const model = T.buildLoopModel(JSON.parse(fs.readFileSync(path.join(__dirname, 'lts-fresh.json'), 'utf8')));
    const dep = JSON.parse(fs.readFileSync(path.join(__dirname, 'dep-6467db5ea59bbb100741d7b7.json'), 'utf8'));
    fixtureCache = { model, dep, trips: T.buildTrips(dep, model) };
  }
  return fixtureCache;
}

// The feed's own timetable, without the observed morning clock: for checks
// of a mechanism under the stale timetable it was recorded against.
function feedTrips(dep, model) {
  const clock = T.CONFIG.observedClock;
  T.CONFIG.observedClock = null;
  try { return T.buildTrips(dep, model); } finally { T.CONFIG.observedClock = clock; }
}

async function main() {
  const [site, dep] = await loadData();
  const model = T.buildLoopModel(site);
  if (!model) throw new Error('no model');
  const trips = T.buildTrips(dep, model);

  console.log('=== MODEL ===');
  console.log('loop length:', model.path.length.toFixed(0), 'm | stops:', model.stops.length, '| trips:', trips.length);
  check('29 trips parsed', trips.length === 29, trips.length);
  check('trips sorted', trips.every((t, i) => i === 0 || t.startMin >= trips[i - 1].startMin));
  const homeIdx = T.findStopIndex(model, 'home');
  const workIdx = T.findStopIndex(model, 'work');
  check('500 Howard idx found', homeIdx > 0, homeIdx);
  check('Berry@MC idx found', workIdx > 0, workIdx);

  // every trip should cover the loop forward: entry routeDist arcs sum to <= L (+tail)
  const L = model.path.length;
  let arcsOk = true;
  for (const trip of trips) {
    let sum = 0;
    for (let i = 0; i + 1 < trip.entries.length; i++) {
      sum += T.mod(trip.entries[i + 1].routeDist - trip.entries[i].routeDist, L) || L;
    }
    if (sum > L + 1) { arcsOk = false; console.log('  arc overflow', trip.startMin, sum); }
  }
  check('trip arcs cover loop at most once', arcsOk);

  console.log('\n=== LIVE BUSES ===');
  const buses = T.extractBuses(site);
  const now = new Date();
  for (const b of buses) {
    console.log(' ', b.name, '| age', ((now - b.when) / 1000).toFixed(0) + 's | speed', b.speed.toFixed(1), '| pos', b.lat.toFixed(5), b.lng.toFixed(5));
  }
  for (const mode of ['home', 'work']) {
    console.log('  -- mode', mode, '->', T.CONFIG.modes[mode].label);
    const preds = T.predictions(model, trips, buses, mode, {}, now);
    for (const p of preds) {
      console.log('   ', p.bus.name, 'ETA', p.etaMin + 'min', 'arr', clockOf(p.arrivalSec),
        '| method', p.method, '| delay', p.delaySec === null ? '-' : fmtSec(Math.abs(p.delaySec)) + (p.delaySec >= 0 ? ' late' : ' early'),
        '| trip', p.tripStartMin ? T.fmtClock(p.tripStartMin) : '-',
        '| between', JSON.stringify(p.legFrom), '->', JSON.stringify(p.legTo),
        p.stale ? 'STALE' : '', p.offRoute ? 'OFFROUTE' : '');
    }
    const sched = T.stopScheduleMinutes(dep, mode);
    check(mode + ' schedule parsed (>=25 times)', sched.length >= 25, sched.length);
    // the committed fixtures have their signed image URLs scrubbed
    if (!OFFLINE) check(mode + ' stop image found', !!T.stopImage(dep, mode));
    const nowTz = T.tzNow(now);
    console.log('    next scheduled:', T.nextScheduled(sched, nowTz.minutes, 3).map(T.fmtClock).join(', ') || '(none)');
  }

  console.log('\n=== SYNTHETIC SCENARIOS ===');
  const stopAt = name => model.stops.find(s => s.name.includes(name));
  const mkBus = (lat, lng, speed, when) => ({ id: 'syn', name: 'SYN', lat, lng, speed, when, showOnMap: true });
  const at = iso => new Date(iso);

  {
    // 1. Bus idle at Nektar terminal at 15:25 -> departs 15:30 trip, 500 Howard @ 15:59.
    //    Staged at its first stop it reads earliest..timetable: it could leave
    //    now and make the printed 29-min run (Trakk's legs say 34 min, slower
    //    than 12 of 14 recorded morning runs Berry & King -> 500 Howard).
    const nek = stopAt('Nektar');
    const d = at('2026-06-29T15:25:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(nek.lat, nek.lng, 0, d.getTime())], 'home', {}, d);
    const p = preds[0];
    console.log('  terminal-hold:', p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) +
      (p && p.latestSec ? '..' + clockOf(p.latestSec) : '') + ' method ' + p.method);
    check('terminal hold: 15:59 is the latest, the printed 29-min run the earliest',
      p && Math.abs((p.latestSec || p.arrivalSec) - (15 * 3600 + 59 * 60)) < 60 && Math.abs(p.etaMin - 29) <= 1,
      p && p.etaMin + 'min..' + clockOf(p.latestSec || p.arrivalSec));
  }
  {
    // 2. Bus at Mission & Spear moving, 07:55 AM. The 7:39-start trip is
    //    scheduled at M&S ~7:54, 500 Howard 7:57 -> 1 min late -> arrive 7:58.
    const ms = stopAt('Mission St & Spear');
    const d = at('2026-06-29T07:55:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(ms.lat, ms.lng, 6, d.getTime())], 'home', {}, d);
    const p = preds[0];
    console.log('  am-adherence:', p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) + ' method ' + p.method + ' delay ' + p.delaySec + ' trip ' + T.fmtClock(p.tripStartMin));
    check('AM bus at M&S 7:55 arrives 500 Howard ~7:58', p && p.method === 'schedule' && Math.abs(p.arrivalSec - (7 * 3600 + 58 * 60)) <= 90, p && clockOf(p.arrivalSec));
    check('AM trip matched is 7:39 start', p && p.tripStartMin === 7 * 60 + 39, p && p.tripStartMin);
  }
  {
    // 3. Midday 12:00, bus parked at Nektar -> scheduled-only, next 500 Howard = 14:59
    const nek = stopAt('Nektar');
    const d = at('2026-06-29T12:00:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(nek.lat, nek.lng, 0, d.getTime())], 'home', {}, d);
    const p = preds[0];
    console.log('  midday:', p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) + ' method ' + p.method);
    check('midday parked bus points at 14:59', p && Math.abs(p.arrivalSec - (14 * 3600 + 59 * 60)) < 60, p && clockOf(p.arrivalSec));
  }
  {
    // 4. After last trip (21:00) -> no prediction rows
    const nek = stopAt('Nektar');
    const d = at('2026-06-29T21:00:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(nek.lat, nek.lng, 0, d.getTime())], 'home', {}, d);
    console.log('  late-night rows:', preds.length);
    check('no predictions after service end', preds.length === 0);
  }
  {
    // 5. Bus passed 500 Howard (at 4th at Library) on the 15:30 trip at 16:11
    //    -> next-trip: 15:45 trip hits 500 Howard 16:14... but bus IS the 15:30 trip;
    //    soonest OTHER arrival comes from schedule; this bus's own next pass ~16:14+delay? It reports next trip time >= now.
    const lib = stopAt('4th at Library');
    const d = at('2026-06-29T16:11:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(lib.lat, lib.lng, 6, d.getTime())], 'home', {}, d);
    const p = preds[0];
    console.log('  passed-stop:', p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) + ' method ' + p.method + ' trip ' + T.fmtClock(p.tripStartMin));
    check('passed stop falls to a later trip arrival', p && p.method === 'next-trip' && p.arrivalSec > 16 * 3600 + 11 * 60, p && clockOf(p.arrivalSec));
  }
  {
    // 6. Stale bus (8 min old ping) flagged, dead bus (12 min) dropped
    const ms = stopAt('Mission St & Spear');
    const d = at('2026-06-29T07:55:00-07:00');
    const stale = T.predictions(model, trips, [mkBus(ms.lat, ms.lng, 6, d.getTime() - 8 * 60000)], 'home', {}, d);
    const dead = T.predictions(model, trips, [mkBus(ms.lat, ms.lng, 6, d.getTime() - 12 * 60000)], 'home', {}, d);
    check('8min-old ping flagged stale', stale.length === 1 && stale[0].stale);
    check('12min-old ping dropped', dead.length === 0);
  }
  {
    // 7. tzNow parses correctly
    const tz = T.tzNow(at('2026-06-29T07:55:30-07:00'));
    check('tzNow minutes', tz.minutes === 7 * 60 + 55 && tz.weekday === 'Monday', JSON.stringify(tz));
    const tzMid = T.tzNow(at('2026-06-29T00:05:00-07:00'));
    check('tzNow midnight hour', tzMid.minutes === 5, tzMid.minutes);
    check('operates Mon', T.operatesToday(model, tz) === true);
    check('no service Sat', T.operatesToday(model, T.tzNow(at('2026-06-27T10:00:00-07:00'))) === false);
  }
  {
    // 8. applyPing
    const bus = mkBus(37.77, -122.39, 0, 1000);
    check('applyPing', T.applyPing(bus, { l: [37.78, -122.40], s: 5, w: 2000 }) && bus.lat === 37.78 && bus.speed === 5 && bus.when === 2000);
    check('applyPing rejects bad', !T.applyPing(bus, { s: 5 }));
  }

  console.log('\n=== REGRESSIONS (workflow findings) ===');
  // point on the route at a given routeDist, for synthetic bus placement
  const pointAt = (dist) => {
    const path = model.path;
    const d = T.mod(dist, path.length);
    for (let i = 0; i + 1 < path.verts.length; i++) {
      if (path.cum[i + 1] >= d) {
        const f = (d - path.cum[i]) / (path.cum[i + 1] - path.cum[i]);
        const a = path.verts[i], b = path.verts[i + 1];
        return { lat: a.lat + f * (b.lat - a.lat), lng: a.lng + f * (b.lng - a.lng) };
      }
    }
    return path.verts[path.verts.length - 1];
  };
  const berryKing = stopAt('Berry St & King St');
  {
    // [31][32] staged AM bus must never show a pre-departure phantom ETA
    for (const [hhmm, label] of [['05:36', 'outside window'], ['05:50', 'inside window']]) {
      const d = at(`2026-06-29T${hhmm}:00-07:00`);
      const preds = T.predictions(model, trips, [mkBus(berryKing.lat, berryKing.lng, 0, d.getTime())], 'work', {}, d);
      const p = preds[0];
      console.log(`  staged-am ${hhmm} (${label}):`, p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) + ' method ' + p.method);
      check(`staged bus at ${hhmm} predicts 6:01, not phantom`, p && Math.abs(p.arrivalSec - (6 * 3600 + 60)) < 60 && p.method !== 'legs', p && clockOf(p.arrivalSec) + '/' + p.method);
    }
  }
  {
    // [20][21] post-AM layover at the terminal must point at PM service, not 11:00
    const nek = stopAt('Nektar');
    const d = at('2026-06-29T10:40:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(nek.lat, nek.lng, 0, d.getTime())], 'work', {}, d);
    const p = preds[0];
    console.log('  post-am-layover:', p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) + ' method ' + p.method);
    check('post-AM layover predicts 14:41 (PM), no phantom 11:00', p && Math.abs(p.arrivalSec - (14 * 3600 + 41 * 60)) < 90, p && clockOf(p.arrivalSec));
  }
  {
    // [33] mid-AM layover at Berry&King, on the observed morning clock
    // (:59/:19/:39). Laid over there (5+ min) before its slot the bus leaves
    // on it (6:59 -> Berry@MC 7:01); within 5 min after a slot it reads as
    // "departing late" (now + the drive); laid over past that it waits for
    // the next slot (7:19 -> 7:21). Either way the prediction is bounded — no
    // unbounded creep + jump. A bus stopped there only as long as boarding
    // could be running the previous slot late: a range from now.
    const layover = (hhmm, heldMin) => {
      const end = at('2026-06-29T' + hhmm + ':00-07:00').getTime(), fixes = {};
      let p = null;
      for (let w = end - heldMin * 60000; w <= end; w += 30000) {
        p = T.predictions(model, trips, [mkBus(berryKing.lat, berryKing.lng, 0, w)], 'work', fixes, new Date(w))[0];
      }
      console.log('  layover-creep ' + hhmm + ' (held ' + heldMin + ' min):', p && clockOf(p.arrivalSec) + (p.latestSec ? '-' + clockOf(p.latestSec) : '') + ' method ' + p.method);
      return p;
    };
    let p = layover('06:56', 6);
    check('laid over at 06:56 it leaves on the 6:59 slot: 7:01, no range from now', p && Math.abs(p.arrivalSec - (7 * 3600 + 60)) < 30 && !p.latestSec,
      p && clockOf(p.arrivalSec));
    p = layover('06:56', 0);
    check('...just stopped at 06:56: a range from now to 7:01', p && p.latestSec && Math.abs(p.latestSec - (7 * 3600 + 60)) < 30 &&
      p.arrivalSec < 6 * 3600 + 59 * 60, p && clockOf(p.arrivalSec) + '-' + (p.latestSec ? clockOf(p.latestSec) : '-'));
    p = layover('07:02', 5);
    check('layover at 07:02 reads as late on 6:59, leaving now (<=7:05)', p && p.arrivalSec <= 7 * 3600 + 5 * 60 && !p.latestSec, p && clockOf(p.arrivalSec));
    p = layover('07:05', 6);
    check('laid over at 07:05 it waits for the 7:19 slot: 7:21', p && Math.abs(p.arrivalSec - (7 * 3600 + 21 * 60)) < 30 && !p.latestSec,
      p && clockOf(p.arrivalSec));
    // a bus running late that stops at 07:05 to board (2026-07-20: one 8 min
    // behind ran the 8:39 at 8:47) is not pinned to the next slot, even
    // boarding for 3 minutes (since 7:02:30)
    for (const heldMin of [0, 2.5]) {
      p = layover('07:05', heldMin);
      check('...stopped at 07:05 for ' + heldMin + ' min: a range from now (~7:07) to 7:21, never a 7:21 pin', p && p.arrivalSec <= 7 * 3600 + 8 * 60 &&
        p.latestSec && Math.abs(p.latestSec - (7 * 3600 + 21 * 60)) < 30, p && clockOf(p.arrivalSec) + '-' + (p.latestSec ? clockOf(p.latestSec) : '-'));
    }
  }
  {
    // [19] bus that passed the rider's stop predicts its own comeback: drive
    // to the next trip's anchor (timetable-paced), depart at max(start,
    // arrival there), carry the lateness to the target's published time.
    const pos = pointAt(stopAt('Berry at Mission Creek').routeDist + 900);
    const d = at('2026-06-29T06:25:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(pos.lat, pos.lng, 8, d.getTime())], 'work', {}, d);
    const p = preds[0];
    console.log('  comeback:', p && clockOf(p.arrivalSec) + ' method ' + p.method + ' trip ' + T.fmtClock(p.tripStartMin));
    check('passed-stop comeback lands on a plausible own-service slot',
      p && p.method === 'next-trip' && p.arrivalSec >= 7 * 3600 && p.arrivalSec <= 7 * 3600 + 30 * 60, p && clockOf(p.arrivalSec));
  }
  {
    // [26] grace: bus projecting just past 500 Howard at its scheduled passing time is still "arriving", not next-loop
    const hw = stopAt('500 Howard');
    const pos = pointAt(hw.routeDist + 100);
    const d = at('2026-06-29T15:59:30-07:00');
    const preds = T.predictions(model, trips, [mkBus(pos.lat, pos.lng, 6, d.getTime())], 'home', {}, d);
    const p = preds[0];
    console.log('  passed-grace:', p && p.etaMin + 'min method ' + p.method);
    check('just-past projection holds "arriving" (stop zone)', p && p.method === 'at-stop' && p.etaSec < 240, p && p.etaMin + '/' + p.method);
  }
  {
    // [22][3][13] garbage coordinates are rejected end to end
    const d = at('2026-06-29T15:59:00-07:00');
    const sentinel = T.predictions(model, trips, [mkBus(-404, -404, 0, d.getTime())], 'home', {}, d);
    check('-404 sentinel bus produces no prediction', sentinel.length === 0);
    const bus = mkBus(37.77, -122.39, 0, d.getTime());
    check('ping with null coords rejected', !T.applyPing(bus, { l: [null, null], w: d.getTime() }));
    check('ping with string coords rejected', !T.applyPing(bus, { l: ['37.7', '-122.4'], w: d.getTime() }));
    check('ping outside service area rejected', !T.applyPing(bus, { l: [0, 0], w: d.getTime() }));
  }
  {
    // [1][9][10] malformed departure data must not throw
    check('non-array dep -> empty trips', Array.isArray(T.buildTrips({ message: 'no departures' }, model)) && T.buildTrips({ error: 1 }, model).length === 0);
    check('nameless dep stop tolerated', (() => { try { T.buildTrips([{ stops: [{ displayTime: '6:00' }, { displayTime: '6:05' }] }], model); return true; } catch (e) { return false; } })());
    check("parseDisplayTime '7:05 AM'", T.stopScheduleMinutes([{ stops: [{ name: '500 Howard St', displayTime: '7:05 AM' }] }], 'home')[0] === 425);
    check("parseDisplayTime ' 14:41 '", T.stopScheduleMinutes([{ stops: [{ name: '500 Howard St', displayTime: ' 14:41 ' }] }], 'home')[0] === 881);
  }
  {
    // [7] string updatedAt timestamps are coerced, not NaN
    const site = { liveTrackingSite: { devices: [{ id: 'x', route: T.CONFIG.routeId, online: true, deviceUpdate: { latitude: 37.77, longitude: -122.39, updatedAt: '2026-06-29T10:00:00Z' } }] } };
    const b = T.extractBuses(site);
    check('ISO updatedAt coerced to epoch ms', b.length === 1 && b[0].when === Date.parse('2026-06-29T10:00:00Z'), b[0] && b[0].when);
    const site2 = { liveTrackingSite: { devices: [{ id: 'x', route: T.CONFIG.routeId, online: true, deviceUpdate: { latitude: 37.77 } }] } };
    check('device missing longitude filtered out', T.extractBuses(site2).length === 0);
  }
  {
    // [36] nextScheduled is strict
    check('nextScheduled strict >', T.nextScheduled([432, 447], 432, 2)[0] === 447);
  }
  {
    // [B#1 cross-period] bus dwelling at the Nektar STOP mid-AM-trip (speed 0
    // while boarding) must NOT be hijacked onto the 14:30 PM trip
    const nek = stopAt('Nektar');
    const d = at('2026-06-29T08:00:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(nek.lat, nek.lng, 0, d.getTime())], 'work', {}, d);
    const p = preds[0];
    console.log('  mid-am-dwell:', p && clockOf(p.arrivalSec) + ' method ' + p.method);
    check('mid-AM dwell at Nektar predicts a morning arrival, not 2:41 PM', p && p.arrivalSec < 9 * 3600, p && clockOf(p.arrivalSec));
  }
  {
    // [tracer#2] future-skewed ping timestamps are clamped
    const bus = mkBus(37.77, -122.39, 0, 1000);
    T.applyPing(bus, { l: [37.78, -122.40], w: Date.now() + 3600 * 1000 });
    check('future ping timestamp clamped to ~now', bus.when <= Date.now() + 5000);
    // [B#5] NaN timestamp falls back to receipt time instead of poisoning liveness
    const bus2 = mkBus(37.77, -122.39, 0, 1000);
    T.applyPing(bus2, { l: [37.78, -122.40], w: NaN });
    check('NaN ping timestamp falls back to now', Math.abs(bus2.when - Date.now()) < 5000);
  }
  {
    // [B#6] null elements in departure data are survivable
    check('null loop tolerated by schedule parse', Array.isArray(T.stopScheduleMinutes([null, { stops: [{ name: '500 Howard St', displayTime: '7:05' }] }], 'home')));
    check('null loop tolerated by buildTrips', Array.isArray(T.buildTrips([null, { stops: [] }], model)));
  }
  {
    // [A#4] one malformed stop coordinate degrades, not destroys, the model
    const site2 = JSON.parse(JSON.stringify(site));
    const tb = site2.liveTrackingSite.routes.find(r => r.id === T.CONFIG.routeId);
    const src = tb.runs[0].linkedRun;
    src.stops.find(s => s.name === '341 3rd St').coordinates = null;
    const m2 = T.buildLoopModel(site2);
    check('model survives one bad stop coordinate', !!m2 && m2.stops.length === model.stops.length - 1, m2 && m2.stops.length);
    check('skipped stop duration carried into next leg', !!m2 && Math.abs(m2.stops.find(s => s.name.includes('181 Fremont')).legDur - (467.25 + 592.2)) < 1);
  }

  console.log('\n=== STALE-GPS REGRESSIONS (never claim the bus left while blind) ===');
  {
    // Morning bug: bus parked at Berry&King, last ping 7:55, GPS silent for
    // 8 minutes. Old behavior rolled it onto the 8:09 trip ("it left",
    // Berry@MC 8:11). It must stay pinned to the 7:54 departure it was
    // boarding for: arrival ~7:57, i.e. "due" by 8:03 — never a later trip.
    const fixT = at('2026-06-29T07:55:00-07:00');
    const nowT = at('2026-06-29T08:03:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(berryKing.lat, berryKing.lng, 0, fixT.getTime())], 'work', {}, nowT);
    const p = preds[0];
    console.log('  stale-staged:', p && clockOf(p.arrivalSec) + ' eta ' + p.etaMin + 'min method ' + p.method + (p.stale ? ' STALE' : ''));
    check('stale staged bus stays on its own departure (due, not 8:11)', p && p.method === 'schedule' && p.arrivalSec <= 8 * 3600 + 3 * 60 && p.stale, p && clockOf(p.arrivalSec));
  }
  {
    // Frozen mid-route: fix at Mission & Spear 7:55 (1 min late on the 7:39
    // trip), GPS silent 9 minutes. Delay must be measured at fix time, so
    // the arrival stays ~7:58 ("due") instead of drifting to 8:07 or
    // flipping to the next trip.
    const ms = stopAt('Mission St & Spear');
    const fixT = at('2026-06-29T07:55:00-07:00');
    const nowT = at('2026-06-29T08:04:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(ms.lat, ms.lng, 6, fixT.getTime())], 'home', {}, nowT);
    const p = preds[0];
    console.log('  stale-midroute:', p && clockOf(p.arrivalSec) + ' eta ' + p.etaMin + 'min method ' + p.method);
    // fix-time anchoring makes the raw arrival 7:58; the display floor lifts
    // it to "due now" — what must never happen is drift or a next-trip flip
    check('stale mid-route bus reads as due now (no drift, no next-trip)', p && p.method === 'schedule' && p.etaSec === 0 && p.stale, p && clockOf(p.arrivalSec) + '/' + p.method);
  }
  {
    // "Passed" needs evidence: a fix just past the stop that has gone stale
    // must keep reading "due / arriving", not flip to next-loop. Only a
    // fix clearly past the stop may say passed.
    const hw = stopAt('500 Howard');
    const justPast = pointAt(hw.routeDist + 100);
    const fixT = at('2026-06-29T15:59:30-07:00');
    const nowT = at('2026-06-29T16:06:00-07:00');
    const stalePreds = T.predictions(model, trips, [mkBus(justPast.lat, justPast.lng, 6, fixT.getTime())], 'home', {}, nowT);
    const sp = stalePreds[0];
    console.log('  stale-justpast:', sp && clockOf(sp.arrivalSec) + ' method ' + sp.method);
    check('stale just-past fix never flips to "passed"', sp && sp.method === 'at-stop' && sp.etaSec === 0, sp && sp.method);
    const farPast = pointAt(hw.routeDist + 400);
    const freshT = at('2026-06-29T16:00:30-07:00');
    const freshPreds = T.predictions(model, trips, [mkBus(farPast.lat, farPast.lng, 6, freshT.getTime())], 'home', {}, freshT);
    const fp = freshPreds[0];
    console.log('  fresh-farpast:', fp && clockOf(fp.arrivalSec) + ' method ' + fp.method);
    check('fresh fix clearly past the stop still says passed (next-trip)', fp && fp.method === 'next-trip');
  }

  console.log('\n=== TRIP-MATCH HYSTERESIS (no early/late flip-flop) ===');
  {
    // A bus ~half a headway late scores almost identically as "early on the
    // next trip". Without hysteresis the match (and the early/late badge)
    // flips on projection noise. Two evaluations 12s apart straddling the
    // naive tie point must keep the same trip and stay "late".
    const ms = stopAt('Mission St & Spear');
    const trip1545 = trips.find(t => t.startMin === 15 * 60 + 45);
    const msMin = trip1545.entries.find(e => e.name.includes('Mission St & Spear')).min;
    const fixes = {};
    const mk = (lateSec) => {
      const d = new Date(new Date('2026-06-29T00:00:00-07:00').getTime() + (msMin * 60 + lateSec) * 1000);
      return T.predictions(model, trips, [mkBus(ms.lat, ms.lng, 6, d.getTime())], 'home', fixes, d)[0];
    };
    const p1 = mk(444); // +7.4 min late -> naive keeps 15:45 trip
    const p2 = mk(456); // +7.6 min late -> naive would flip to the 16:00 trip as -7.4 early
    console.log('  call1:', p1 && 'trip ' + T.fmtClock(p1.tripStartMin) + ' delay ' + Math.round(p1.delaySec) + 's');
    console.log('  call2:', p2 && 'trip ' + T.fmtClock(p2.tripStartMin) + ' delay ' + Math.round(p2.delaySec) + 's');
    check('first match lands on the 15:45 trip, late', p1 && p1.tripStartMin === 945 && p1.delaySec > 0, p1 && p1.tripStartMin);
    check('hysteresis holds the match past the naive tie point', p2 && p2.tripStartMin === 945 && p2.delaySec > 0, p2 && p2.tripStartMin + '/' + Math.round(p2.delaySec));
    // and a decisively better challenger still wins: +13 min late on 15:45
    // reads as only ~2 early on 16:00 — flip expected
    const p3 = mk(780);
    console.log('  call3:', p3 && 'trip ' + T.fmtClock(p3.tripStartMin) + ' delay ' + Math.round(p3.delaySec) + 's');
    check('decisive challenger still flips the match', p3 && p3.tripStartMin === 16 * 60 && p3.delaySec < 0, p3 && p3.tripStartMin);
  }

  console.log('\n=== TRACE-DERIVED REGRESSIONS (2026-07-01 field data) ===');
  {
    // Deadhead clamp: a bus driving toward the terminal before its trip's
    // start matched as "-14 min early" and predicted a 2:44 arrival when the
    // published first arrival is 2:59. A trip cannot run ahead of its start.
    const d = at('2026-06-29T14:23:00-07:00');
    const p = T.predictions(model, trips, [mkBus(37.7695, -122.3936, 5, d.getTime())], 'home', {}, d)[0];
    console.log('  deadhead:', p && clockOf(p.arrivalSec) + ' delay ' + p.delaySec + ' method ' + p.method);
    check('pre-start bus predicts published 14:59, not earlier', p && p.arrivalSec >= 14 * 3600 + 59 * 60 - 30 && (p.delaySec === 0 || p.delaySec === null), p && clockOf(p.arrivalSec));
  }
  {
    // Fremont & Howard crossing: the route crosses itself there ~6 published
    // minutes apart. With a previous fix on the Fremont passage, a ping that
    // hugs the Howard passage's line must stay projected on Fremont
    // (continuity), not flip the delay by ±5 minutes.
    const trip1545 = trips.find(t => t.startMin === 15 * 60 + 45);
    const f181 = trip1545.entries.find(e => e.name.includes('181 Fremont'));
    const fixes = {};
    const t1 = new Date(new Date('2026-06-29T00:00:00-07:00').getTime() + (f181.min * 60 - 60) * 1000);
    const p1 = T.predictions(model, trips, [mkBus(37.78850, -122.39420, 6, t1.getTime())], 'home', fixes, t1)[0];
    const t2 = new Date(t1.getTime() + 20000);
    const p2 = T.predictions(model, trips, [mkBus(37.78920, -122.39520, 6, t2.getTime())], 'home', fixes, t2)[0];
    console.log('  crossing:', p1 && 'd1=' + Math.round(p1.delaySec) + 's', p2 && 'd2=' + Math.round(p2.delaySec) + 's');
    check('projection holds its passage at the self-crossing', p1 && p2 && Math.abs(p2.delaySec - p1.delaySec) < 90, p1 && p2 && Math.round(p2.delaySec - p1.delaySec) + 's swing');
  }

  {
    // Shortcut re-anchor: a late bus turning from Fremont straight onto
    // Howard (skipping the Financial District sub-loop) jumps ~1300m of
    // route distance. Continuity must not leave the projection stuck at
    // the crossing — the fixes along Howard re-anchor within a ping or two.
    const trip1545 = trips.find(t => t.startMin === 15 * 60 + 45);
    const f181 = trip1545.entries.find(e => e.name.includes('181 Fremont'));
    const hw = stopAt('500 Howard');
    const fixes = {};
    const t0 = new Date(new Date('2026-06-29T00:00:00-07:00').getTime() + (f181.min * 60 + 30) * 1000);
    // on Fremont just before the crossing
    T.predictions(model, trips, [mkBus(37.78850, -122.39420, 6, t0.getTime())], 'home', fixes, t0);
    // 20s later: 200m down Howard WB (took the shortcut)
    const t1 = new Date(t0.getTime() + 20000);
    T.predictions(model, trips, [mkBus(37.78900, -122.39548, 8, t1.getTime())], 'home', fixes, t1);
    // 20s more: at 500 Howard
    const t2 = new Date(t1.getTime() + 20000);
    const p = T.predictions(model, trips, [mkBus(hw.lat, hw.lng, 4, t2.getTime())], 'home', fixes, t2)[0];
    console.log('  shortcut:', p && p.etaMin + 'min method ' + p.method + ' offRoute ' + p.offRoute + ' meters ' + Math.round(p.meters));
    check('shortcutting bus re-anchors onto Howard (arriving, on-route)', p && p.etaSec < 120 && !p.offRoute && p.meters < 400, p && p.etaMin + 'min/' + Math.round(p.meters) + 'm');
  }

  {
    // Variant street path (field-recorded 2026-07-01 15:35-15:38): after
    // Mission & Spear the bus approached 500 Howard via Folsom -> Fremont
    // NB -> left on Howard. On Fremont its projection lands on the EARLIER
    // passage, regressing its schedule-position ~6 min and flipping the
    // delay badge. Within-trip tau monotonicity must hold the reading.
    const trip1510 = trips.find(t => t.startMin === 15 * 60 + 10);
    const msEntry = trip1510.entries.find(e => e.name.includes('Mission St & Spear'));
    const fixes = {};
    const base = new Date('2026-06-29T00:00:00-07:00').getTime();
    const evalAt = (lat, lng, secOfDay) => {
      const d = new Date(base + secOfDay * 1000);
      return T.predictions(model, trips, [mkBus(lat, lng, 5, d.getTime())], 'home', fixes, d)[0];
    };
    const t0 = msEntry.min * 60 + 60;
    const p1 = evalAt(37.79304, -122.39348, t0);          // at Mission & Spear (on trip)
    const p2 = evalAt(37.78871, -122.39287, t0 + 60);     // Folsom approach (variant)
    const p3 = evalAt(37.78890, -122.39485, t0 + 120);    // ON Fremont NB (earlier passage!)
    const p4 = evalAt(37.78870, -122.39607, t0 + 150);    // on Howard past the crossing
    const ds = [p1, p2, p3, p4].map(p => p && Math.round(p.delaySec));
    console.log('  variant-path delays (s):', ds.join(' -> '));
    const maxSwing = Math.max(...ds) - Math.min(...ds);
    check('variant path never swings the delay by minutes', ds.every(d => d !== null && d !== undefined) && maxSwing < 150, maxSwing + 's swing');
    check('variant path keeps the same trip', [p1, p2, p3, p4].every(p => p && p.tripStartMin === 15 * 60 + 10));
  }

  console.log('\n=== FIELD BUG 2026-07-15: departed bus resurrected as "5 min" ===');
  {
    // Screenshot repro: 8:35 AM, cold app open (no per-bus memory), bus just
    // past Berry at Mission Creek running ~8 min late on the 8:24 trip. Its
    // projection also reads "~6 min early" on the not-yet-started 8:39 trip;
    // the naive tie-break picked the future trip and the grace branch
    // printed "5 min · arrives 8:41 · on schedule" for a bus that was gone.
    const bmc = stopAt('Berry at Mission Creek');
    const fixes = {};
    const d1 = at('2026-06-29T08:35:00-07:00');
    const past1 = pointAt(bmc.routeDist + 250);
    const p1 = T.predictions(model, trips, [mkBus(past1.lat, past1.lng, 7, d1.getTime())], 'work', fixes, d1)[0];
    console.log('  resurrect(cold):', p1 && p1.etaMin + 'min arr ' + clockOf(p1.arrivalSec) + ' method ' + p1.method + ' trip ' + T.fmtClock(p1.tripStartMin));
    check('cold open reads departed bus as passed immediately', p1 && p1.method === 'next-trip' && p1.arrivalSec >= 9 * 3600, p1 && clockOf(p1.arrivalSec) + '/' + p1.method);
    // ten seconds later the bus has receded 70m further -> demonstrably departed
    const d2 = at('2026-06-29T08:35:10-07:00');
    const past2 = pointAt(bmc.routeDist + 320);
    const p2 = T.predictions(model, trips, [mkBus(past2.lat, past2.lng, 7, d2.getTime())], 'work', fixes, d2)[0];
    console.log('  resurrect(+10s):', p2 && p2.etaMin + 'min arr ' + clockOf(p2.arrivalSec) + ' method ' + p2.method);
    check('receding bus reads as passed (next loop) within one ping', p2 && p2.method === 'next-trip' && p2.arrivalSec >= 9 * 3600, p2 && clockOf(p2.arrivalSec) + '/' + p2.method);
  }
  console.log('\n=== FIELD BUG 2026-07-17: wrong-passage lock in the Mission Bay corridor ===');
  // The outbound approach (Owens->Berry&King->Berry@MC, rd ~1500-2900) and
  // the return legs (4th@Library->LongBridge, rd ~8200-9000) run within
  // ~40 m of each other. An approaching bus that projects onto the return
  // passage reads ~25 scheduled minutes ahead -> "passed your stop, 9:07".
  {
    // T1: cold open mid-corridor, fix nearer the WRONG (return) passage.
    // Joint distance+schedule resolution must still pick the approach side.
    // find the tightest pre-stop/return pinch with the approach side still
    // BEFORE the stop, then stand the bus mid-corridor nearer the wrong side
    let pinch = null;
    for (let a = 2450; a < 2860; a += 20) for (let b = 8200; b < 9100; b += 20) {
      const pa = T.toXY(pointAt(a).lat, pointAt(a).lng), pb = T.toXY(pointAt(b).lat, pointAt(b).lng);
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (!pinch || d < pinch.d) pinch = { a, b, d };
    }
    check('corridor geometry still ambiguous (test precondition)', pinch && pinch.d < 130, pinch && Math.round(pinch.d) + 'm @' + pinch.a);
    if (pinch && pinch.d < 130) {
      const aPt = pointAt(pinch.a), bPt = pointAt(pinch.b);
      const pos = { lat: 0.4 * aPt.lat + 0.6 * bPt.lat, lng: 0.4 * aPt.lng + 0.6 * bPt.lng };
      const d = at('2026-06-29T08:40:30-07:00'); // 8:39 trip started, bus ~on time approaching
      const p = T.predictions(model, trips, [mkBus(pos.lat, pos.lng, 6, d.getTime())], 'work', {}, d)[0];
      console.log('  corridor-cold:', p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) + ' method ' + p.method + ' trip ' + T.fmtClock(p.tripStartMin));
      check('approaching bus is not teleported to the return passage', p && (p.method === 'schedule' || p.method === 'at-stop') && p.arrivalSec < 8 * 3600 + 50 * 60, p && clockOf(p.arrivalSec) + '/' + p.method);
    }
  }
  {
    // T2: the wrong-passage unlock, in browser reality. Synthetic rectangle
    // loop with two antiparallel passages 40 m apart; the bus drives forward
    // along the outbound side but starts locked onto the return side, so its
    // return-projection regresses ~40 m per ping. Crucially, every ping is
    // followed by a same-fix re-evaluation (the app's 15 s render tick) —
    // the regression count must survive those or the unlock never fires.
    const REF = 37.77, MLAT = 111320, MLNG = Math.cos(REF * Math.PI / 180) * MLAT;
    const ll = (x, y) => ({ lat: REF + y / MLAT, lng: x / MLNG });
    const rect = { path: T.buildPath([ll(0, 0), ll(2000, 0), ll(2000, 40), ll(0, 40), ll(0, 0)]) };
    const retRd = x => 2040 + (2000 - x);
    const t0 = 1750000000000;
    let prev = { routeDist: retRd(500), when: t0 - 15000 };
    let unlockedAt = -1;
    for (let k = 0; k < 8; k++) {
      const x = 500 + 40 * k;
      const bus = { id: 's', name: 'S', lat: ll(x, 19).lat, lng: ll(x, 19).lng, speed: 6, when: t0 + k * 15000, showOnMap: true };
      let fx = T.locateBus(rect, bus, prev, null, 30000);
      prev = { routeDist: fx.routeDist, when: bus.when, regressCount: fx.regressCount };
      // interleaved same-fix render (the part that used to wipe the counter)
      fx = T.locateBus(rect, bus, prev, null, 30000);
      prev = { routeDist: fx.routeDist, when: bus.when, regressCount: fx.regressCount };
      if (unlockedAt < 0 && fx.routeDist < 2000) unlockedAt = k;
    }
    console.log('  corridor-unlock: correct passage from ping', unlockedAt);
    check('wrong-passage lock breaks within ~5 pings despite render ticks', unlockedAt >= 0 && unlockedAt <= 5, 'ping ' + unlockedAt);
  }

  console.log('\n=== FIELD BUG 2026-07-20: late comeback skipped to the next published slot ===');
  {
    // 8:44 AM, bus finishing its previous loop between Owens and Berry&King,
    // running ~8 min behind. It reaches the anchor ~8:46 and serves the 8:41
    // slot late, arriving Berry@MC ~8:49 — five minutes out. The published-
    // floor logic skipped the already-printed 8:41 and reported 9:07.
    const pos = pointAt(1600);
    const d = at('2026-06-29T08:44:00-07:00');
    const p = T.predictions(model, trips, [mkBus(pos.lat, pos.lng, 6, d.getTime())], 'work', {}, d)[0];
    console.log('  late-comeback:', p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) + ' method ' + p.method + ' trip ' + T.fmtClock(p.tripStartMin));
    check('late comeback predicts its own delayed service (~8:48), not 9:07',
      p && p.arrivalSec >= 8 * 3600 + 45 * 60 && p.arrivalSec <= 8 * 3600 + 52 * 60,
      p && clockOf(p.arrivalSec) + '/' + p.method);
  }
  {
    // ...and a tail bus between printed slots reads earliest-plausible: at
    // 8:33 it could be the 8:24 slot running ~11 late (arrive ~8:37) or hold
    // for 8:39 (arrive 8:41). Earlier-is-safer — a rider told 8:41 misses a
    // roll-through, one told 8:37 waits four minutes — and the staged rule
    // corrects to the published time within a ping of the bus parking.
    const pos = pointAt(1600);
    const d = at('2026-06-29T08:33:00-07:00');
    const p = T.predictions(model, trips, [mkBus(pos.lat, pos.lng, 6, d.getTime())], 'work', {}, d)[0];
    console.log('  early-comeback:', p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) + ' method ' + p.method);
    check('tail comeback reads earliest-plausible, never later than published',
      p && p.arrivalSec >= 8 * 3600 + 35 * 60 && p.arrivalSec <= 8 * 3600 + 42 * 60 + 30,
      p && clockOf(p.arrivalSec));
  }

  {
    // Mid-loop comebacks must use timetable pace, not Trakk's padded leg
    // durations (69 vs 54 min/loop): a bus just past Berry@MC at 8:35
    // reaches the anchor ~9:26 by the printed timetable and serves the 9:29
    // slot at ~9:31 — raw leg durations said 9:40+, and further round the
    // loop pushed the real slot over the plausibility cap entirely.
    const bmc = stopAt('Berry at Mission Creek');
    const d1 = at('2026-06-29T08:35:00-07:00');
    const p1 = T.predictions(model, trips, [mkBus(pointAt(bmc.routeDist + 250).lat, pointAt(bmc.routeDist + 250).lng, 7, d1.getTime())], 'work', {}, d1)[0];
    console.log('  midloop-comeback:', p1 && clockOf(p1.arrivalSec) + ' trip ' + T.fmtClock(p1.tripStartMin));
    check('mid-loop comeback stays near the printed 9:31 slot', p1 && p1.arrivalSec >= 9 * 3600 + 25 * 60 && p1.arrivalSec <= 9 * 3600 + 38 * 60, p1 && clockOf(p1.arrivalSec));
    const d2 = at('2026-06-29T08:50:00-07:00');
    const p2 = T.predictions(model, trips, [mkBus(pointAt(3400).lat, pointAt(3400).lng, 7, d2.getTime())], 'work', {}, d2)[0];
    console.log('  midloop-comeback-late:', p2 && clockOf(p2.arrivalSec) + ' trip ' + T.fmtClock(p2.tripStartMin));
    check('padding never pushes the real slot over the cap', p2 && p2.arrivalSec <= 9 * 3600 + 46 * 60, p2 && clockOf(p2.arrivalSec));
  }

  console.log('\n=== FIELD 2026-08-06: deadhead inside the last trip window ===');
  {
    // Seen live at 10:25: a bus deadheading home while the last AM trip's
    // window is still open fell to the position-based path and projected a
    // phantom "11:18 AM" into the midday gap. A legs arrival landing in a
    // published-service gap must defer to the next published time.
    const pos = pointAt(4900);
    const d = at('2026-06-29T10:40:00-07:00');
    const p = T.predictions(model, trips, [mkBus(pos.lat, pos.lng, 6, d.getTime())], 'work', {}, d)[0];
    console.log('  deadhead-tail:', p && clockOf(p.arrivalSec) + '/' + p.method);
    check('deadhead never projects a phantom arrival into the midday gap',
      !p || p.arrivalSec >= 14 * 3600 || p.arrivalSec <= 11 * 3600,
      p && clockOf(p.arrivalSec) + '/' + p.method);
  }

  console.log('\n=== FIELD BUG 2026-08-06: layover hold creeping the comeback ETA ===');
  // Buses wait out the slack before their next run parked past Owens St. The
  // engine read "parked" as "driving, ever later on the old slot" and crept
  // the ETA a second per second (9:49 shown for a bus that would serve the
  // feed's 9:56 slot).
  {
    const mkParked = (rd, whenMs) => {
      const pt = pointAt(rd);
      return mkBus(pt.lat, pt.lng, 0.3, whenMs);
    };
    const t0 = new Date('2026-06-29T09:41:00-07:00').getTime();
    const fixes = {};
    let arrivals = [];
    // parked at rd 1700 (short of the Berry&King anchor), pinging every 30s
    for (let k = 0; k <= 12; k++) {
      const d = new Date(t0 + k * 30000);
      const p = T.predictions(model, trips, [mkParked(1700 + (k % 2), d.getTime())], 'work', fixes, d)[0];
      if (p) arrivals.push({ t: k * 30, arr: p.arrivalSec, latest: p.latestSec || p.arrivalSec, method: p.method, holding: p.holding });
    }
    const early = arrivals[1], late = arrivals[arrivals.length - 1];
    const held = arrivals.filter(a => a.t >= 180); // hold confirmed by 150s
    console.log('  layover-hold: t=30s ' + clockOf(early.arr) + '/' + early.method +
      '  t=' + late.t + 's ' + clockOf(late.arr) + '..' + clockOf(late.latest) + '/' + late.method + (late.holding ? ' HOLDING' : ''));
    // Laid over where runs end (AM: past Owens St) it is staged like a bus at
    // Berry & King, for the next slot of the morning clock: the 9:39 run left
    // while it sat, so the 9:59 (Berry at Mission Creek 10:01) — the latest
    // it comes, and once it has sat longer than boarding (5 min), the time
    check('confirmed hold: it waits for the next slot (9:59 run, 10:01 at Berry)',
      held.length && held.every(a => Math.abs(a.latest - (10 * 3600 + 60)) < 90 && a.method === 'schedule' &&
        (a.t < 330 || Math.abs(a.arr - (10 * 3600 + 60)) < 90)),
      held.map(a => a.t + 's:' + clockOf(a.arr) + '..' + clockOf(a.latest)).join(' '));
    const spread = Math.max(...held.map(a => a.latest)) - Math.min(...held.map(a => a.latest));
    check('no per-second creep of the timetable end once holding', spread < 60, spread + 's spread');
  }
  {
    // A brief pause (one light cycle) must NOT reroute a genuinely late,
    // moving comeback: the 2026-07-20 case still reads ~8:48.
    const t0 = new Date('2026-06-29T08:43:00-07:00').getTime();
    const fixes = {};
    let p = null;
    [1560, 1600, 1601, 1602, 1640].forEach((rd, k) => {
      const pt = pointAt(rd);
      const d = new Date(t0 + k * 20000);
      p = T.predictions(model, trips, [mkBus(pt.lat, pt.lng, 4, d.getTime())], 'work', fixes, d)[0];
    });
    console.log('  brief-pause:', p && clockOf(p.arrivalSec) + '/' + p.method);
    check('an 80s pause keeps the late-comeback reading (~8:48)',
      p && p.method === 'next-trip' && !p.holding && p.arrivalSec < 8 * 3600 + 52 * 60,
      p && clockOf(p.arrivalSec));
  }
  {
    // The hold must survive same-fix render ticks (the counter-wipe class).
    const t0 = new Date('2026-06-29T09:41:00-07:00').getTime();
    const fixes = {};
    const pt = pointAt(1700);
    let p = null;
    for (let k = 0; k <= 6; k++) {
      const busWhen = t0 + Math.floor(k / 2) * 90000; // new fix every OTHER eval
      const d = new Date(t0 + k * 45000);
      p = T.predictions(model, trips, [mkBus(pt.lat, pt.lng, 0.3, busWhen)], 'work', fixes, d)[0];
    }
    console.log('  hold-carry:', p && clockOf(p.arrivalSec) + (p.latestSec ? '..' + clockOf(p.latestSec) : '') +
      '/' + p.method + (p.holding ? ' HOLDING' : ''));
    // (an unconfirmed hold reads as the late comeback, ~9:46/next-trip)
    check('render ticks between pings do not reset the hold',
      p && p.method === 'schedule' && Math.abs((p.latestSec || p.arrivalSec) - (10 * 3600 + 60)) < 90, p && clockOf(p.arrivalSec) + '/' + p.method);
  }

  {
    // A bus CRAWLING below the per-ping jitter threshold covers real ground
    // and must never read as holding (displacement is measured from the
    // episode anchor, not fix-over-fix).
    const t0 = new Date('2026-06-29T09:41:00-07:00').getTime();
    const fixes = {};
    let p = null;
    for (let k = 0; k <= 10; k++) {
      const pt = pointAt(1500 + k * 30); // 1 m/s, 30 m per 30 s ping
      const d = new Date(t0 + k * 30000);
      p = T.predictions(model, trips, [mkBus(pt.lat, pt.lng, 1, d.getTime())], 'work', fixes, d)[0];
    }
    console.log('  crawl:', p && clockOf(p.arrivalSec) + '/' + p.method + (p.holding ? ' HOLDING' : ''));
    check('a slow crawl through congestion never reads as holding', p && !p.holding, p && p.method);
  }
  {
    // A bus blocked mid-trip BEFORE the rider's stop arrives later the
    // longer it sits -- it must keep its (late) schedule reading, never be
    // reclassified as holding for a future run.
    const bmc = stopAt('Berry at Mission Creek');
    const pt = pointAt(bmc.routeDist - 400);
    const t0 = new Date('2026-06-29T09:12:00-07:00').getTime(); // on the 9:05 trip, ~6 min late
    const fixes = {};
    let p = null;
    for (let k = 0; k <= 8; k++) {
      const d = new Date(t0 + k * 30000);
      p = T.predictions(model, trips, [mkBus(pt.lat, pt.lng, 0.3, d.getTime())], 'work', fixes, d)[0];
    }
    console.log('  blocked-midtrip:', p && clockOf(p.arrivalSec) + '/' + p.method + (p.holding ? ' HOLDING' : ''));
    check('a blocked mid-trip bus keeps its schedule reading (target ahead)',
      p && p.method === 'schedule' && !p.holding && p.arrivalSec < 9 * 3600 + 35 * 60,
      p && clockOf(p.arrivalSec) + '/' + p.method);
  }

  console.log('\n=== FIELD 2026-10-13: holds near the stop, stale timetable (never say it left) ===');
  {
    const bmc = stopAt('Berry at Mission Creek');
    const bk = stopAt('Berry St & King St');
    const sod = d => T.tzNow(d).minutes * 60 + T.tzNow(d).seconds;
    // (a) the field report, warm: laid over at Berry & King (staged for 9:29),
    // pulls out early; at 9:19 it is 0.2 mi from the stop and a minute away
    {
      const fixes = {};
      const pk = pointAt(bk.routeDist + 5);
      for (let k = 0; k <= 8; k++) {
        const d = at('2026-06-29T09:12:00-07:00'); d.setTime(d.getTime() + k * 40000);
        T.predictions(model, trips, [mkBus(pk.lat, pk.lng, 0.1, d.getTime())], 'work', fixes, d);
      }
      let p = null;
      for (let k = 0; k <= 5; k++) {
        const d = at('2026-06-29T09:18:30-07:00'); d.setTime(d.getTime() + k * 6000);
        const q = pointAt(bk.routeDist + 60 + k * 36);
        p = T.predictions(model, trips, [mkBus(q.lat, q.lng, 6, d.getTime())], 'work', fixes, d)[0];
      }
      console.log('  field-report warm:', p && p.etaMin + 'min ' + clockOf(p.arrivalSec) + ' ' + p.method);
      check('early bus that left Berry & King reads ~1 min, not "11 min · 9:31"', p && p.etaSec <= 150 && p.method === 'schedule', p && clockOf(p.arrivalSec));
    }
    // (b) cold opens anywhere in the first leg never pin to the published 9:31
    {
      let worst = 0;
      for (const off of [100, 240, 320, 400, 500]) for (const hh of ['09:18:00', '09:19:00', '09:19:30', '09:20:30']) {
        const d = at('2026-06-29T' + hh + '-07:00');
        const q = pointAt(bk.routeDist + off);
        const p = T.predictions(model, trips, [mkBus(q.lat, q.lng, 6, d.getTime())], 'work', {}, d)[0];
        worst = Math.max(worst, p ? p.etaSec : 9999);
      }
      check('cold open in the first leg: physical ETA at every second (no 9:19:30 knife edge)', worst <= 180, Math.round(worst) + 's');
    }
    // (c) an early bus waiting at the stop is AT the stop the whole time, warm and cold
    {
      const fixes = {}; let bad = 0, n = 0;
      const q = pointAt(bmc.routeDist + 12);
      for (let k = 0; k <= 30; k++) {
        const d = at('2026-06-29T09:20:00-07:00'); d.setTime(d.getTime() + k * 20000);
        for (const f of [fixes, {}]) {
          const p = T.predictions(model, trips, [mkBus(q.lat, q.lng, 0.2, d.getTime())], 'work', f, d)[0];
          n++; if (!p || p.method !== 'at-stop') bad++;
        }
      }
      check('bus waiting 10 min just past the pole reads "at your stop" (warm and cold)', bad === 0, bad + '/' + n + ' not at-stop');
    }
    // (d) GPS goes quiet while it waits there: still at the stop 9 min later, not dropped
    {
      const fixes = {};
      const q = pointAt(bmc.routeDist + 20);
      const t0 = at('2026-06-29T09:20:10-07:00');
      T.predictions(model, trips, [mkBus(q.lat, q.lng, 0, t0.getTime())], 'work', fixes, t0);
      const d = new Date(t0.getTime() + 9 * 60000);
      const p = T.predictions(model, trips, [mkBus(q.lat, q.lng, 0, t0.getTime())], 'work', fixes, d)[0];
      check('quiet GPS at the stop: still "at your stop" after 9 min', p && p.method === 'at-stop' && p.stale, p && p.method);
    }
    // (e) Trakk lists 769 s for the 147 m leg into 73-99 Mission St: capped
    {
      const leg = model.stops.find(s => s.name.indexOf('73-99') >= 0);
      check('routing-artifact leg duration is capped at a physical pace', leg && leg.legDur <= leg.legDist / 2 + 1, leg && Math.round(leg.legDur) + 's/' + Math.round(leg.legDist) + 'm');
    }
    // (f) a run missing from the feed's timetable: bus holding at Berry & King
    // at 10:20 (after the last listed AM departure) is coming, not "2:41 PM"
    {
      const q = pointAt(bk.routeDist + 5);
      const fixes = {}; let p = null;
      for (let k = 0; k <= 4; k++) {
        const d = at('2026-06-29T10:20:00-07:00'); d.setTime(d.getTime() + k * 30000);
        p = T.predictions(model, trips, [mkBus(q.lat, q.lng, 0.2, d.getTime())], 'work', fixes, d)[0];
      }
      console.log('  unlisted-run:', p && p.etaMin + 'min ' + clockOf(p.arrivalSec) + ' ' + p.method);
      check('bus at the anchor on a run the timetable lacks reads minutes away, not PM',
        p && p.arrivalSec < 11 * 3600, p && clockOf(p.arrivalSec) + '/' + p.method);
      // ...while a bus heading to the yard well after the last visit is not a phantom
      const y = pointAt(1600);
      const dy = at('2026-06-29T10:55:00-07:00');
      const py = T.predictions(model, trips, [mkBus(y.lat, y.lng, 6, dy.getTime())], 'work', {}, dy)[0];
      check('estimate far past the last published visit defers to the PM timetable', !py || py.arrivalSec >= 14 * 3600, py && clockOf(py.arrivalSec) + '/' + py.method);
    }
    // (g) wrong-street snap leaving Berry at Mission Creek: a fix ~150 m off the
    // drawn outbound line (near the return leg) seconds later stays outbound
    {
      const fixes = {};
      const a = pointAt(bmc.routeDist + 90);
      const d0 = at('2026-06-29T15:18:00-07:00');
      T.predictions(model, trips, [mkBus(a.lat, a.lng, 6, d0.getTime())], 'home', fixes, d0);
      // shift ~150 m toward the return passage near 4th & Library
      const ret = pointAt(8400), b = pointAt(bmc.routeDist + 150);
      const mix = { lat: b.lat + 0.85 * (ret.lat - b.lat), lng: b.lng + 0.85 * (ret.lng - b.lng) };
      const d1 = new Date(d0.getTime() + 8000);
      const p = T.predictions(model, trips, [mkBus(mix.lat, mix.lng, 6, d1.getTime())], 'home', fixes, d1)[0];
      check('departing bus off the drawn line is not teleported onto the return leg', p && p.method !== 'next-trip', p && p.method + '@' + Math.round(p.fix.routeDist));
    }
    // (h) holding at the anchor during service: the morning clock is not
    // stale (no run left before its slot), so it reads its slot — the 9:19
    // run, there 9:21 — not a range from "now" to the feed's 9:31 (the
    // October 13 report: "11 min · 9:31" for a bus that came 9:21). The
    // afternoon's stale timetable still gives a range (checks above).
    {
      const q = pointAt(bk.routeDist + 5), fixes = {};
      let p = null;
      for (let k = 0; k <= 12; k++) {
        const d = at('2026-06-29T09:09:00-07:00'); d.setTime(d.getTime() + k * 30000);
        p = T.predictions(model, trips, [mkBus(q.lat, q.lng, 0.1, d.getTime())], 'work', fixes, d)[0];
      }
      console.log('  staged-clock:', p && clockOf(p.arrivalSec) + '-' + (p.latestSec ? clockOf(p.latestSec) : '-') + ' at ' + p.waitingAt);
      check('staged bus laid over on the morning clock reads its 9:19 slot (9:21), no range', p && Math.abs(p.arrivalSec - (9 * 3600 + 21 * 60)) < 30 &&
        !p.latestSec && p.onClock && p.departsFrom === 'Berry St & King St' && p.departsSec === 9 * 3600 + 19 * 60, p && clockOf(p.arrivalSec));
    }
    // (i) parked off-route (staging lot) is listed, never the headline; a bus that
    // just drove the route and queues off the drawing is still in service
    {
      const lot = { lat: 37.7686, lng: -122.3976 };
      const fixes = {}; let p = null;
      for (let k = 0; k <= 8; k++) {
        const d = at('2026-06-29T15:30:00-07:00'); d.setTime(d.getTime() + k * 30000);
        p = T.predictions(model, trips, [mkBus(lot.lat, lot.lng, 0, d.getTime())], 'work', fixes, d)[0];
      }
      check('bus parked in the staging lot reads "parked", no countdown', p && p.method === 'parked', p && p.method);
    }
    // (j) seen driving away past the zone, then stopped at the next light: still gone
    {
      const fixes = {};
      const d0 = at('2026-06-29T09:10:00-07:00');
      let p = null;
      [[30, 4], [100, 6], [160, 6], [200, 0], [200, 0]].forEach(([off, v], k) => {
        const d = new Date(d0.getTime() + k * 10000), q = pointAt(bmc.routeDist + off);
        p = T.predictions(model, trips, [mkBus(q.lat, q.lng, v, d.getTime())], 'work', fixes, d)[0];
      });
      check('departed bus stopped at the next light stays "passed" (no flap back)', p && p.method === 'next-trip', p && p.method);
      // ...also when its GPS then goes quiet (silence is not a hold)
      const quiet = T.predictions(model, trips, [mkBus(pointAt(bmc.routeDist + 200).lat, pointAt(bmc.routeDist + 200).lng, 0,
        d0.getTime() + 40000)], 'work', fixes, new Date(d0.getTime() + 40000 + 300000))[0];
      check('departed bus stopped at the next light, then GPS-quiet 5 min: still "passed"', quiet && quiet.method === 'next-trip', quiet && quiet.method);
      // ...but that memory is about this pass: a full loop later a dwell there is at the stop
      const later = T.predictions(model, trips, [mkBus(pointAt(bmc.routeDist + 130).lat, pointAt(bmc.routeDist + 130).lng, 0,
        d0.getTime() + 55 * 60000)], 'work', fixes, new Date(d0.getTime() + 55 * 60000 + 5000))[0];
      check('a loop later, a bus stopped 130 m past is at the stop again', later && later.method === 'at-stop', later && later.method);
    }
  }

  console.log('\n=== CODE REVIEW 2026-10-13: passages, service hours, quiet GPS ===');
  {
    const bmc = stopAt('Berry at Mission Creek');
    const how = stopAt('500 Howard St');
    const lib = stopAt('4th at Library (Caltrain)');
    const pred = (lat, lng, v, whenIso, nowIso, mode, fixes) => T.predictions(model, trips,
      [mkBus(lat, lng, v, at(whenIso).getTime())], mode, fixes || {}, at(nowIso || whenIso))[0];
    // the 4th at Library pole (return leg) is 25 m from the outbound line just
    // past Berry: a bus dwelling there is not "at" Berry at Mission Creek
    const pl = pred(lib.lat, lib.lng, 0, '2026-06-29T09:49:55-07:00', '2026-06-29T09:50:00-07:00', 'work');
    check('bus dwelling at 4th at Library is not at Berry at Mission Creek', pl && pl.method !== 'at-stop' && pl.etaSec > 600, pl && pl.method + ' ' + pl.etaMin + 'min');
    // ...but at 9:40 a run of the morning clock is due just past Berry (the 9:39,
    // there 9:41), and schedule fit reads the fix there: with the nearer
    // passage as near, it is "can't tell which way", never a plain "Here"
    const pf = pred(lib.lat, lib.lng, 0, '2026-06-29T09:39:55-07:00', '2026-06-29T09:40:00-07:00', 'work');
    check('...at 9:40, read at Berry by schedule fit: flagged "can\'t tell which way"',
      pf && (pf.method !== 'at-stop' || pf.ambiguous), pf && pf.method + (pf.ambiguous ? '/ambiguous' : ''));
    // stopped where the passages cross: the benefit of the doubt holds on every
    // render tick and new stopped fix (it must not harden into "Here")
    {
      const fixes = {}, q = pointAt(8446), seen = [];
      [['09:39:55', '09:40:00'], ['09:39:55', '09:40:15'], ['09:40:25', '09:40:30']].forEach(([w, n]) => {
        const p = pred(q.lat, q.lng, 0, '2026-06-29T' + w + '-07:00', '2026-06-29T' + n + '-07:00', 'work', fixes);
        seen.push(p && p.method + (p.ambiguous ? '/ambiguous' : ''));
      });
      check('stopped at the passage crossing: "near, can\'t tell which way" on every tick', seen.every(x => x === 'at-stop/ambiguous'), seen.join(' '));
    }
    // outside service a bus parked at the stop is not "Here — head out now"
    // (11:40: past the morning clock's last run, 10:19, by more than a late run)
    for (const [hh, mode, st] of [['12:00:00', 'home', how], ['21:30:00', 'home', how], ['12:00:00', 'work', bmc], ['11:40:00', 'work', bmc]]) {
      const q = pointAt(st.routeDist + 15);
      const p = pred(q.lat, q.lng, 0, '2026-06-29T' + hh + '-07:00', null, mode);
      check('bus parked at ' + st.name + ' at ' + hh + ' (no service) is not "at your stop"', !p || p.method !== 'at-stop', p && p.method);
    }
    // a stopped bus short of the stop whose GPS goes quiet: due, not "1 min" forever
    {
      const q = pointAt(bmc.routeDist - 250);
      const p = pred(q.lat, q.lng, 0, '2026-06-29T09:00:00-07:00', '2026-06-29T09:06:00-07:00', 'work');
      check('quiet stopped bus short of the stop reads due (no endless 1-min floor)', p && p.stale && p.etaSec === 0, p && p.etaSec + 's');
    }
    // approaching 500 Howard with the fix 60 m off the drawing, 40 m past the pole
    {
      const fixes = {};
      const a = pointAt(how.routeDist - 150);
      pred(a.lat, a.lng, 6, '2026-06-29T15:57:45-07:00', '2026-06-29T15:58:00-07:00', 'home', fixes);
      // 60 m to the side of the line (perpendicular to the drawn segment)
      const b = pointAt(how.routeDist + 40), b2 = pointAt(how.routeDist + 45);
      const ex = (b2.lng - b.lng) * Math.cos(37.77 * Math.PI / 180), ey = b2.lat - b.lat, n = Math.hypot(ex, ey);
      const side = { lat: b.lat + (ex / n) * 60 / 111320, lng: b.lng - (ey / n) * 60 / (111320 * Math.cos(37.77 * Math.PI / 180)) };
      const p = pred(side.lat, side.lng, 6, '2026-06-29T15:58:10-07:00', '2026-06-29T15:58:15-07:00', 'home', fixes);
      check('approaching bus with an off-line fix just past the pole is at the stop', p && p.method === 'at-stop', p && p.method);
      check('...that fix really is just past the pole and 60 m off the line', p && Math.abs(p.fix.offBy - 60) < 5 &&
        T.mod(p.fix.routeDist - how.routeDist, model.path.length) < 50, p && Math.round(p.fix.offBy) + ' m off');
    }
    // July 1 66065: leaving the staging lot before its 3:10 PM trip, it reached
    // Berry at 3:16:47 — the stale timetable says 3:21, so that is only the latest
    {
      const q = pointAt(1581);
      const p = pred(q.lat, q.lng, 2.7, '2026-06-29T14:56:48-07:00', '2026-06-29T14:56:50-07:00', 'work');
      check('bus before its trip start shows earliest-to-timetable range (3:16:47 inside)', p && p.latestSec &&
        p.arrivalSec <= 15 * 3600 + 16 * 60 + 47 && p.latestSec >= 15 * 3600 + 16 * 60 + 47, p && clockOf(p.arrivalSec) + '-' + (p.latestSec ? clockOf(p.latestSec) : '?'));
    }
    // PM 76084: finished its 3:10 loop and laid over 20 m SHORT of the Nektar
    // pole (still the trip's last leg by projection) from 3:57; it left at 4:15
    // and reached Berry at 4:27:56. As a comeback it read "holding · 4:41".
    {
      const fixes = {};
      const L = model.path.length;
      let p = null;
      [L - 600, L - 400, L - 200].forEach((rd, k) => {
        const q = pointAt(rd);
        const d = at('2026-06-29T15:56:30-07:00'); d.setTime(d.getTime() + k * 10000);
        T.predictions(model, trips, [mkBus(q.lat, q.lng, 8, d.getTime())], 'work', fixes, d);
      });
      const q = pointAt(L - 20);
      for (let k = 0; k <= 18; k++) {
        const d = at('2026-06-29T15:57:00-07:00'); d.setTime(d.getTime() + k * 30000);
        p = T.predictions(model, trips, [mkBus(q.lat, q.lng, 0.3, d.getTime())], 'work', fixes, d)[0];
      }
      const came = 16 * 3600 + 27 * 60 + 56;
      console.log('  terminal-layover:', p && p.method + ' ' + clockOf(p.arrivalSec) + (p.latestSec ? '-' + clockOf(p.latestSec) : '') + (p.waitingAt ? ' waiting at ' + p.waitingAt : ''));
      check('layover just short of the terminal pole is staged: range covers 4:27:56, never a 4:41 pin', p &&
        p.method === 'schedule' && p.arrivalSec <= came && (p.latestSec || p.arrivalSec) >= came, p && p.method + ' ' + clockOf(p.arrivalSec));
    }
  }

  console.log('\n=== FIELD 2026-10-13 PM: off the drawn return leg (Howard -> 4th St) ===');
  {
    // Bus 20024 served 500 Howard at 6:44 PM, then left the drawn return leg
    // for 4th St: 225-300 m off its own line it crossed the outbound line,
    // held 2.5 min, and rejoined the drawing at 4th & King. The engine read it
    // as 760 m past Berry at Mission Creek on the outbound ("7:41-7:46 PM");
    // it reached Berry at 7:12:42 PM.
    // pinned to the committed route and timetable the recording was scored
    // against (a live redraw would shift route distances)
    const fs = require('fs'), path = require('path');
    const { model, trips } = fixture();
    const L = model.path.length;
    const how = model.stops.find(s => s.name.includes('500 Howard St'));
    const lo = at('2026-10-13T18:40:00-07:00').getTime(), hi = at('2026-10-13T18:59:00-07:00').getTime();
    const rows = fs.readFileSync(path.join(__dirname, 'field-2026-10-13-pm.jsonl'), 'utf8').trim().split('\n')
      .map(l => JSON.parse(l)).filter(r => r.name === '20024' && r.when >= lo && r.when <= hi);
    const fixes = {}, out = [];
    rows.forEach(r => {
      const p = T.predictions(model, trips, [mkBus(r.lat, r.lng, r.speed || 0, r.when)], 'work', fixes, new Date(r.when))[0];
      if (r.when >= at('2026-10-13T18:52:30-07:00').getTime()) out.push(p);
    });
    const ret = p => p && T.mod(p.fix.routeDist - how.routeDist, L) < T.mod(model.stops[0].routeDist - how.routeDist, L) + 1;
    check('a bus detouring off the return leg stays on its own passage', out.length > 30 && out.every(ret),
      out.filter(p => !ret(p)).length + ' of ' + out.length + ' read elsewhere');
    const worst = out.length ? Math.max(...out.map(p => p ? p.arrivalSec : Infinity)) : Infinity;
    check('...and its comeback reads ~7:15, never the 7:22 PM run (7:41+)', worst <= 19 * 3600 + 20 * 60, clockOf(worst));
  }
  {
    // Stuck in traffic 2 km short of the PM terminal past its next run's
    // departure is not a layover: that run is still the one it makes, late.
    const q = pointAt(7456);
    const fixes = {};
    let p = null;
    for (let k = 0; k <= 6; k++) {
      const d = at('2026-06-29T18:49:40-07:00'); d.setTime(d.getTime() + k * 30000);
      p = T.predictions(model, trips, [mkBus(q.lat, q.lng, 0.3, d.getTime())], 'work', fixes, d)[0];
    }
    check('a bus held mid-run keeps the run it can still make (6:52 PM slot, not 7:22)',
      p && p.method === 'next-trip' && p.arrivalSec < 19 * 3600 + 25 * 60, p && clockOf(p.arrivalSec) + '/' + p.method);
  }

  console.log('\n=== FIELD 2026-10-14 AM: never a time after the bus came ===');
  {
    // Replays of the recording (committed route and timetable): each window
    // ends before the bus reached the stop, and no reading may be later than
    // when it got there. The feed's AM timetable is stale (one run every 15
    // min to 8:39, then 9:05, 9:29, 9:54); the app runs the morning on the
    // observed clock (Berry & King every 20 min, at :19/:39/:59).
    const fs = require('fs'), path = require('path');
    const { model, trips } = fixture();
    const all = fs.readFileSync(path.join(__dirname, 'field-2026-10-14-am.jsonl'), 'utf8').trim().split('\n')
      .map(l => JSON.parse(l)).filter(r => r.route === T.CONFIG.routeId && T.validCoord(r.lat, r.lng));
    const replay = (bus, mode, from, to) => {
      const lo = at('2026-10-14T' + from + '-07:00').getTime(), hi = at('2026-10-14T' + to + '-07:00').getTime();
      const fixes = {}, out = [];
      all.filter(r => r.name === bus && r.when <= hi).forEach(r => {
        const p = T.predictions(model, trips, [mkBus(r.lat, r.lng, r.speed || 0, r.when)], mode, fixes, new Date(r.when))[0];
        if (r.when >= lo && p) out.push(p);
      });
      return out;
    };
    const sod = hms => { const [h, m, x] = hms.split(':').map(Number); return h * 3600 + m * 60 + x; };
    const late = (out, came, slack) => out.filter(p => p.arrivalSec > sod(came) + (slack || 0));
    [
      // laid over at Owens St 9:25-9:34 (where AM runs end) after the feed's
      // 9:29 slot passed: "holding · 9:56" at Berry at Mission Creek; it came
      // 9:40:53. On the clock it reads the 9:39 run's printed 9:41:00, 7 s
      // late: the fastest recorded run reached Berry at Mission Creek 1.8 min
      // after its slot, 12 s ahead of the printed 2 (well before it left)
      ['1738', 'work', '09:25:00', '09:34:05', '09:40:53', 'held at Owens St, its run\'s slot passed', 15],
      // driving from the Owens layover to Berry & King before the 6:19 run, no
      // trip to match yet: Trakk legs alone said 6:43 at 500 Howard; there 6:38:52
      ['76084', 'home', '06:14:00', '06:17:15', '06:38:52', 'out of the layover before its run'],
      // stopped 45 s at the Berry & King pole running 6 min late: staged for the
      // next run with Trakk's 26-min legs as the earliest (7:25); there 7:19:39
      ['20024', 'home', '06:58:00', '07:00:20', '07:19:39', 'a brief stop at Berry & King'],
      // left Berry & King 4 min ahead of the 7:24 run; one moving fix at the pole
      // read as its last loop dropped "seen at the anchor", and past Berry at
      // Mission Creek the run was clamped back to 7:42; there 7:40:33
      ['76084', 'home', '07:16:30', '07:24:05', '07:40:33', 'a run that left early stays early']
    ].forEach(([bus, mode, from, to, came, what, slack]) => {
      const out = replay(bus, mode, from, to), bad = late(out, came, slack);
      check(what + ': never after ' + came + (slack ? ' (+' + slack + ' s)' : '') + ' (bus ' + bus + ', ' + mode + ')', out.length > 5 && !bad.length,
        bad.length + ' of ' + out.length + ' later' + (bad.length ? ', worst ' + clockOf(Math.max(...bad.map(p => p.arrivalSec))) : ''));
    });
    const gone = replay('76084', 'home', '07:19:40', '07:24:05').filter(p => p.beforeRun || p.latestSec);
    check('...read as running early once it has left, never "its run hasn\'t started"', !gone.length,
      gone.length + ' readings clamped to the 7:24 run');
  }

  console.log('\n=== CODE REVIEW 2026-10-13 PM: passage hold edge cases ===');
  {
    const how = stopAt('500 Howard St');
    const run = (mode, t0, steps) => {
      const fixes = {}; let p = null;
      steps.forEach(([rd, v, dt]) => {
        const q = pointAt(rd), w = at(t0).getTime() + dt * 1000;
        p = T.predictions(model, trips, [mkBus(q.lat, q.lng, v, w)], mode, fixes, new Date(w + 2000))[0];
      });
      return p;
    };
    // waiting at the pole, one GPS fix 380 m ahead, then back at the pole
    const p = run('home', '2026-06-29T16:00:00-07:00', [[how.routeDist - 300, 6, 0], [how.routeDist - 100, 6, 10],
      [how.routeDist, 0, 20], [how.routeDist, 0, 30], [how.routeDist + 380, 0, 35], [how.routeDist + 5, 0, 40], [how.routeDist + 3, 0, 50]]);
    check('one GPS spike ahead while waiting at the stop does not leave it "passed"', p && p.method === 'at-stop', p && p.method);
    // a 2.5-min hold at SF Mission Bay (243 m short of the terminal) at the end
    // of a PM run is a layover there: named for where it waits
    const sf = stopAt('SF Mission Bay');
    const q = run('work', '2026-06-29T15:55:00-07:00', [[sf.routeDist - 300, 7, 0], [sf.routeDist - 100, 7, 10]]
      .concat(Array.from({ length: 9 }, (_, k) => [sf.routeDist + 5, 0, 30 + k * 20])));
    check('layover at SF Mission Bay reads waiting at SF Mission Bay, not the terminal', q && q.waitingAt === sf.name,
      q && q.method + ' ' + q.waitingAt);
  }

  console.log('\n=== FIELD 2026-10-14 AM: fresh app open, GPS course ===');
  {
    // Bus 20024 on its way to 500 Howard (there 8:22:18). Opening the app at
    // 8:11:15 with no history, the nearest drawn line is the return leg: it
    // read "already passed · next loop 8:54". Its GPS course (56°, 9 m/s)
    // runs along the outbound passage instead.
    const fs = require('fs'), path = require('path');
    const { model: fxModel, dep: fxDep } = fixture();
    const r = fs.readFileSync(path.join(__dirname, 'field-2026-10-14-am.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
      .find(x => x.name === '20024' && Math.floor(x.when / 1000) === at('2026-10-14T08:11:15-07:00').getTime() / 1000);
    // on the feed's stale timetable (as recorded) schedule fit picks the
    // return leg; the morning clock fits the outbound passage on its own
    for (const [label, fxTrips] of [['feed timetable', feedTrips(fxDep, fxModel)], ['morning clock', T.buildTrips(fxDep, fxModel)]]) {
      const open = heading => r && T.predictions(fxModel, fxTrips, [Object.assign(mkBus(r.lat, r.lng, r.speed, r.when), { heading })],
        'home', {}, new Date(r.when + 2000))[0];
      const withCourse = open(r && r.heading), without = open(null);
      console.log('  fresh open 8:11:15 (' + label + '):', without && without.method, '->', withCourse && withCourse.method + ' ' + clockOf(withCourse.arrivalSec));
      check('fresh open (' + label + '): a bus on its way is not "already passed" when its course runs along its passage',
        withCourse && withCourse.method !== 'next-trip' && withCourse.arrivalSec <= 8 * 3600 + 22 * 60 + 18, withCourse && withCourse.method);
      if (label === 'feed timetable') {
        check('...(without the course this fix reads passed: the check exercises the heading rule)', without && without.method === 'next-trip',
          without && without.method);
      }
    }
  }

  console.log('\n=== MORNING CLOCK (observed 2026-10-14) ===');
  {
    const { model: fxModel, dep: fxDep } = fixture();
    const hm = m => Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
    const amStarts = ts => ts.filter(t => t.startMin < 12 * 60).map(t => hm(t.startMin)).join(' ');
    const clockTrips = T.buildTrips(fxDep, fxModel);
    const grid = Array.from({ length: 14 }, (_, k) => hm(359 + 20 * k)).join(' ');
    check('AM runs leave Berry & King on the 20-minute clock, 5:59 to 10:19', amStarts(clockTrips) === grid, amStarts(clockTrips));
    check('...marked observed, the afternoon runs not',
      clockTrips.every(t => t.observed === (t.startMin < 12 * 60)));
    const am = clockTrips.find(t => t.startMin === 7 * 60 + 19);
    const feedAm = feedTrips(fxDep, fxModel).filter(t => t.startMin < 12 * 60);
    check('...keeping the feed\'s stop-to-stop times', am && feedAm.length === 14 && feedAm.every(fd => am.entries.length === fd.entries.length &&
      am.entries.every((e, i) => e.idx === fd.entries[i].idx && e.min - am.startMin === fd.entries[i].min - fd.startMin)));
    check('...in the stop schedule too (Berry at Mission Creek 6:01, 6:21, 6:41)',
      T.stopScheduleMinutes(fxDep, 'work').slice(0, 3).join() === [361, 381, 401].join(), T.stopScheduleMinutes(fxDep, 'work').slice(0, 3).map(hm).join(' '));
    // any other morning list is a real timetable change: used as is
    const moved = JSON.parse(JSON.stringify(fxDep));
    const run654 = moved.find(l => l.stops && l.stops[0] && l.stops[0].displayTime === '6:54');
    run654.stops[0].displayTime = '6:55';
    const movedTrips = T.buildTrips(moved, fxModel);
    check('a changed feed timetable is used as is (no clock runs)', movedTrips.every(t => !t.observed) &&
      movedTrips.some(t => t.startMin === 6 * 60 + 55), amStarts(movedTrips));
    const dropped = fxDep.filter(l => !(l.stops && l.stops[0] && l.stops[0].displayTime === '9:05'));
    check('...and so is one missing a run', T.buildTrips(dropped, fxModel).every(t => !t.observed));
    const retimed = JSON.parse(JSON.stringify(fxDep));
    retimed.find(l => l.stops && l.stops[0] && l.stops[0].displayTime === '8:24').stops[1].displayTime = '8:27';
    check('...or one whose stop-to-stop times changed', T.buildTrips(retimed, fxModel).every(t => !t.observed));
  }

  console.log('\n=== SLOW TRAFFIC: a range, never a later point time ===');
  {
    const bmc = stopAt('Berry at Mission Creek'), fre = stopAt('181 Fremont Street 181'), how = stopAt('500 Howard St');
    // drive from rd `from` toward 500 Howard at `pace` x each leg's scheduled
    // speed, one fix every 10 s, starting at `iso`; optionally holding at
    // rd `holdAt` for `holdSec` first, and with a GPS fix `spike` m behind
    // every 30th fix
    const drive = (iso, from, pace, opts) => {
      const o = opts || {}, fixes = {};
      let t = at(iso).getTime(), rd = from, p = null, held = !o.holdSec, k = 0;
      const fix = (v, back) => {
        const q = pointAt(rd - (back || 0));
        p = T.predictions(model, trips, [mkBus(q.lat, q.lng, v, t)], 'home', fixes, new Date(t + 1000))[0];
        t += 10000;
      };
      while (rd < how.routeDist - 600) {
        if (!held && rd >= o.holdAt) {
          rd = o.holdAt;
          for (let h = 0; h * 10 < o.holdSec; h++) fix(0);
          held = true;
        }
        const st = model.stops[T.legAt(model, rd)], v = st.legDist / st.legDur * pace;
        fix(v, o.spike && ++k % 30 === 0 ? o.spike : 0);
        rd += v * 10;
      }
      return p;
    };
    const pm = '2026-06-29T16:15:00-07:00', bmcOut = bmc.routeDist + 100;
    const free = drive(pm, bmcOut, 1), crawl = drive(pm, bmcOut, 0.4), hold = drive(pm, bmcOut, 1, { holdAt: fre.routeDist + 5, holdSec: 600 });
    const spiky = drive(pm, bmcOut, 0.4, { spike: 250 });
    // an 11-min layover 222 m past Owens St (no stop pole), then on through
    // Berry & King without stopping, at scheduled pace
    const owensLay = drive('2026-06-29T09:41:00-07:00', 1700, 1, { holdAt: 1700, holdSec: 660 });
    const show = p => p && p.method + ' ' + clockOf(p.arrivalSec) + (p.latestSec ? '..' + clockOf(p.latestSec) : '') + ' slow ' + p.slowBySec + 's';
    console.log('  free:', show(free), '| crawl:', show(crawl), '| 10-min hold at Fremont:', show(hold));
    console.log('  crawl with spikes:', show(spiky), '| layover past Owens:', show(owensLay));
    check('a bus at its scheduled pace gets a single time', free && !free.latestSec && !free.slowBySec, show(free));
    check('a bus crawling at 0.4x pace gets a range up to its lost time again', crawl && crawl.slowBySec >= T.CONFIG.slowRunSec &&
      crawl.latestSec > crawl.arrivalSec + 90 && crawl.latestSec <= crawl.arrivalSec + crawl.slowBySec + 1, show(crawl));
    check('a 10-min hold at a stop pole is not traffic', hold && !hold.slowBySec, show(hold));
    check('...nor an 11-min layover past Owens St (then through Berry & King)', owensLay && !owensLay.slowBySec, show(owensLay));
    check('a 250 m GPS spike every 5 min doesn\'t count the same ground twice', spiky && crawl &&
      Math.abs(spiky.slowBySec - crawl.slowBySec) < 120, show(spiky) + ' vs ' + crawl.slowBySec + 's');
    // 2026-10-13 PM: 20024 queued from 73-99 Mission St to 500 Howard (there
    // 18:43:15), reading "2 min" for 13 minutes; the range's late end covers it
    const fs = require('fs'), path = require('path');
    const { model: fxModel, trips: fxTrips } = fixture();
    const fixes = {}, out = [];
    const lo = at('2026-10-13T18:28:00-07:00').getTime(), hi = at('2026-10-13T18:41:00-07:00').getTime();
    fs.readFileSync(path.join(__dirname, 'field-2026-10-13-pm.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
      .filter(r => r.name === '20024' && r.route === T.CONFIG.routeId && T.validCoord(r.lat, r.lng) && r.when <= hi)
      .forEach(r => {
        const p = T.predictions(fxModel, fxTrips, [mkBus(r.lat, r.lng, r.speed || 0, r.when)], 'home', fixes, new Date(r.when))[0];
        if (r.when >= lo && p) out.push(p);
      });
    const came = 18 * 3600 + 43 * 60 + 15;
    const short = out.filter(p => !(p.latestSec >= came - 180 && p.slowBySec > 0) || p.arrivalSec > came);
    check('queued toward 500 Howard: every reading a range reaching its 18:43:15 arrival (bus 20024)', out.length > 20 && !short.length,
      short.length + ' of ' + out.length + ' short' + (short.length ? ', e.g. ' + show(short[0]) : ''));
  }

  console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL CHECKS PASSED'));
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
