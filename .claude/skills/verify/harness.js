// Live + synthetic validation harness for tracker.js
const T = require(require('path').join(__dirname, '..', '..', '..', 'tracker.js'));

function fmtSec(s) { const m = Math.floor(s / 60); return m + 'm' + String(Math.round(s % 60)).padStart(2, '0'); }
function clockOf(secOfDay) { return T.fmtClock(Math.round(secOfDay / 60)); }

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + label + (detail ? '  [' + detail + ']' : ''));
  if (!cond) failures++;
}

async function main() {
  const [site, dep] = await Promise.all([T.fetchLiveSite(), T.fetchDepartures()]);
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
    check(mode + ' stop image found', !!T.stopImage(dep, mode));
    const nowTz = T.tzNow(now);
    console.log('    next scheduled:', T.nextScheduled(sched, nowTz.minutes, 3).map(T.fmtClock).join(', ') || '(none)');
  }

  console.log('\n=== SYNTHETIC SCENARIOS ===');
  const stopAt = name => model.stops.find(s => s.name.includes(name));
  const mkBus = (lat, lng, speed, when) => ({ id: 'syn', name: 'SYN', lat, lng, speed, when, showOnMap: true });
  const at = iso => new Date(iso);

  {
    // 1. Bus idle at Nektar terminal at 15:25 -> departs 15:30 trip, 500 Howard @ 15:59
    const nek = stopAt('Nektar');
    const d = at('2026-06-29T15:25:00-07:00');
    const preds = T.predictions(model, trips, [mkBus(nek.lat, nek.lng, 0, d.getTime())], 'home', {}, d);
    const p = preds[0];
    console.log('  terminal-hold:', p && p.etaMin + 'min arr ' + clockOf(p.arrivalSec) + ' method ' + p.method);
    check('terminal hold uses 15:59 arrival (34min)', p && Math.abs(p.etaMin - 34) <= 1, p && p.etaMin);
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
    // [33] mid-AM layover at Berry&King. Within 5 min of a missed departure
    // the bus reads as "departing late" (6:56+lateBy); past that it pins to
    // the next departure's stop time (7:09 trip -> Berry@MC 7:11). Either
    // way the prediction is bounded — no unbounded creep + 7-minute jump.
    {
      const d = at('2026-06-29T06:56:00-07:00');
      const p = T.predictions(model, trips, [mkBus(berryKing.lat, berryKing.lng, 0, d.getTime())], 'work', {}, d)[0];
      console.log('  layover-creep 06:56:', p && clockOf(p.arrivalSec) + ' method ' + p.method);
      check('layover at 06:56 reads as late 6:54 departure (<=7:00)', p && p.arrivalSec >= 6 * 3600 + 56 * 60 && p.arrivalSec <= 7 * 3600, p && clockOf(p.arrivalSec));
    }
    {
      const d = at('2026-06-29T07:02:00-07:00');
      const p = T.predictions(model, trips, [mkBus(berryKing.lat, berryKing.lng, 0, d.getTime())], 'work', {}, d)[0];
      console.log('  layover-creep 07:02:', p && clockOf(p.arrivalSec) + ' method ' + p.method);
      check('layover at 07:02 pinned to 7:11', p && Math.abs(p.arrivalSec - (7 * 3600 + 11 * 60)) < 60, p && clockOf(p.arrivalSec));
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
    check('just-past projection holds "arriving" via grace', p && p.method === 'schedule' && p.etaSec < 240, p && p.etaMin + '/' + p.method);
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
    check('stale just-past fix never flips to "passed"', sp && sp.method === 'schedule' && sp.etaSec === 0, sp && sp.method);
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
      check('approaching bus is not teleported to the return passage', p && p.method === 'schedule' && p.arrivalSec < 8 * 3600 + 50 * 60, p && clockOf(p.arrivalSec) + '/' + p.method);
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
  // Post-8:41 headways stretch from 15 to ~25 min; buses wait out the
  // difference parked near the SW corner. The engine read "parked" as
  // "driving, ever later on the old slot" and crept the ETA a second per
  // second (9:49 shown for a bus that would serve the 9:56 slot).
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
      if (p) arrivals.push({ t: k * 30, arr: p.arrivalSec, method: p.method, holding: p.holding });
    }
    const early = arrivals[1], late = arrivals[arrivals.length - 1];
    const held = arrivals.filter(a => a.t >= 180); // hold confirmed by 150s
    console.log('  layover-hold: t=30s ' + clockOf(early.arr) + '/' + early.method +
      '  t=' + late.t + 's ' + clockOf(late.arr) + '/' + late.method + (late.holding ? ' HOLDING' : ''));
    check('confirmed hold pins the arrival to the next future run (9:56)',
      held.length && held.every(a => Math.abs(a.arr - (9 * 3600 + 56 * 60)) < 90),
      held.map(a => a.t + 's:' + clockOf(a.arr)).join(' '));
    const spread = Math.max(...held.map(a => a.arr)) - Math.min(...held.map(a => a.arr));
    check('no per-second creep once holding', spread < 60, spread + 's spread');
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
    console.log('  hold-carry:', p && clockOf(p.arrivalSec) + '/' + p.method + (p.holding ? ' HOLDING' : ''));
    check('render ticks between pings do not reset the hold',
      p && p.holding && Math.abs(p.arrivalSec - (9 * 3600 + 56 * 60)) < 90, p && clockOf(p.arrivalSec));
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

  console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL CHECKS PASSED'));
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
