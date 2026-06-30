/*
 * Mission Bay TMA shuttle tracker — core logic.
 *
 * Talks to the same Trakk (gettrakk.com) backend that powers the official
 * real-time predictions map at missionbaytma.org. The org id/token below are
 * the public credentials embedded in that page's iframe
 * (https://www.mytrakk.com/live-tracking?customerToken=...&customerId=...).
 *
 * Server-side ETAs are disabled for this site, so ETAs are computed here
 * with schedule-adherence prediction: each bus is projected onto the route
 * loop polyline, matched to the timetable trip it is currently running, and
 * its measured earliness/lateness is applied to the published time at the
 * rider's stop. When the timetable is unavailable the fallback integrates
 * Trakk's per-leg scheduled durations instead.
 *
 * This file runs both in the browser (window.Tracker) and under Node for
 * tests (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tracker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONFIG = {
    apiBase: 'https://api.gettrakk.com/v1',
    orgId: '6467d9a73091da1005b3f438',
    orgToken: 'efbc9cdb-4ad2-4a73-842f-aea6d25df0d0',
    pusherKey: 'bfad5c1e9f141310c9f8',
    pusherCluster: 'us3',
    routeId: '6467dad4a59bbb100741d74d',   // TransBay/Caltrain
    runId: '6467db5ea59bbb100741d7b7',     // "AM/PM" loop run (devices report this id)
    timezone: 'America/Los_Angeles',
    modes: {
      home: { stopId: '6467dc86060fe110044bb04f', label: '500 Howard St', match: /500\s*howard/i },
      work: { stopId: '6467dbd6a59bbb100741d819', label: 'Berry at Mission Creek', match: /berry\s*at\s*mission\s*creek/i }
    },
    offRouteMeters: 150,     // farther than this from the polyline = off-route
    staleMs: 150000,         // position pings older than this are flagged stale
    deadMs: 600000,          // and older than this are dropped entirely
    fallbackSpeedMps: 5.5,   // assumed speed where the schedule gives no duration
    maxSpeedMps: 18,         // cap on plausible bus speed for projection continuity
    parkedSpeedMps: 1.5,     // below this a bus is treated as holding in place
    anchorRadiusMeters: 250, // "at a loop anchor" radius for staged/holding buses
    stagedGraceSec: 300,     // parked this long past a departure = waiting for the next one
    passedStopGraceMeters: 300, // projected just past the stop still counts as arriving
    passedStopGraceSec: 180,    // ...while the schedule agrees within this window
    reachabilityFactor: 0.8, // schedule padding tolerance for loop-around arrivals
    garageMeters: 1500,      // beyond this from the route, a fix predicts nothing
    tripMatch: {
      windowBeforeSec: 15 * 60, // how early a trip is considered active (must not
                                // exceed maxDelaySec or staged buses fall in a gap)
      windowAfterSec: 15 * 60,  // how long past its last stop it stays active
      maxDelaySec: 20 * 60      // beyond this the trip match is distrusted
    },
    // plausible service area; rejects garbage fixes like Trakk's -404 sentinel
    bounds: { latMin: 37.5, latMax: 38.1, lngMin: -122.8, lngMax: -122.0 }
  };

  // ---------------------------------------------------------------- geometry

  var REF_LAT = 37.77;
  var M_LAT = 111320;
  var M_LNG = Math.cos(REF_LAT * Math.PI / 180) * M_LAT;

  function toXY(lat, lng) { return { x: lng * M_LNG, y: lat * M_LAT }; }

  function mod(n, m) { return ((n % m) + m) % m; }

  // Finite and inside the plausible service area (the live feed uses values
  // like -404 as a "no GPS fix" sentinel).
  function validCoord(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= CONFIG.bounds.latMin && lat <= CONFIG.bounds.latMax &&
      lng >= CONFIG.bounds.lngMin && lng <= CONFIG.bounds.lngMax;
  }

  // Google encoded polyline -> [{lat, lng}]
  function decodePolyline(str) {
    var pts = [], index = 0, lat = 0, lng = 0;
    while (index < str.length) {
      var result = 0, shift = 0, b;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      result = 0; shift = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return pts;
  }

  // Build a path with cumulative distances. Zero-length segments (the encoded
  // polyline concatenates sub-paths with repeated points) are dropped.
  function buildPath(latlngs) {
    var verts = [], cum = [0];
    for (var i = 0; i < latlngs.length; i++) {
      var p = toXY(latlngs[i].lat, latlngs[i].lng);
      p.lat = latlngs[i].lat; p.lng = latlngs[i].lng;
      if (verts.length) {
        var q = verts[verts.length - 1];
        var d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < 0.5) continue;
        cum.push(cum[cum.length - 1] + d);
      }
      verts.push(p);
    }
    return { verts: verts, cum: cum, length: cum[cum.length - 1] };
  }

  // Project a point onto every passage of the path and return distinct
  // candidates (the route can pass the same block twice, so the nearest
  // segment is not always the right one). Candidates are sorted by squared
  // distance and deduped so that each represents a separate passage.
  function projectCandidates(path, pt) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return [];
    var raw = [];
    for (var i = 0; i + 1 < path.verts.length; i++) {
      var a = path.verts[i], b = path.verts[i + 1];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2)) : 0;
      var px = a.x + t * dx, py = a.y + t * dy;
      var ddx = pt.x - px, ddy = pt.y - py;
      raw.push({
        d2: ddx * ddx + ddy * ddy,
        routeDist: path.cum[i] + t * Math.sqrt(len2)
      });
    }
    raw.sort(function (a, b) { return a.d2 - b.d2; });
    var picked = [];
    var cap = Math.max(raw.length ? raw[0].d2 * 9 : 0, 2500); // within 3x best, or 50 m
    for (var j = 0; j < raw.length && picked.length < 6; j++) {
      var c = raw[j];
      if (c.d2 > cap) break;
      var dup = picked.some(function (p) {
        var gap = Math.abs(c.routeDist - p.routeDist);
        return Math.min(gap, path.length - gap) < 120;
      });
      if (!dup) picked.push(c);
    }
    return picked;
  }

  // ------------------------------------------------------------- loop model

  function findRoute(site) {
    var routes = (site.liveTrackingSite || {}).routes || [];
    var byId = routes.find(function (r) { return r.id === CONFIG.routeId; });
    if (byId) return byId;
    return routes.find(function (r) { return /transbay|caltrain/i.test(r.name || ''); }) || null;
  }

  // The run's linkedRun carries the complete contiguous stop list for the
  // loop (the primary run's list hides a few stops); prefer it when present.
  function pickLoopSource(run) {
    var lr = run.linkedRun;
    if (lr && lr.stops && lr.stops.length >= (run.stops || []).length && lr.polyline) return lr;
    return run;
  }

  /*
   * Returns the loop model:
   *   path       polyline path with cumulative distances
   *   stops      [{id, name, lat, lng, idx, routeDist, legDur, legDist}]
   *              stops[0] and stops[last] are the same physical terminal;
   *              leg k runs stops[k-1] -> stops[k] taking legDur seconds.
   *   loopSec    total scheduled seconds for one full loop
   * Stops are projected sequentially (each constrained forward of the
   * previous) so repeated street passages cannot reorder them.
   */
  function buildLoopModel(site) {
    var route = findRoute(site);
    if (!route || !route.runs || !route.runs.length) return null;
    var run = route.runs.find(function (r) { return r.id === CONFIG.runId; }) || route.runs[0];
    var src = pickLoopSource(run);
    if (!src.stops || src.stops.length < 2 || !src.polyline) return null;

    var path = buildPath(decodePolyline(src.polyline));
    if (path.verts.length < 2) return null;

    var stops = src.stops.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    var model = { path: path, stops: [], route: route };
    var prevDist = null;
    var carryDur = 0; // scheduled time of any skipped (malformed) stops

    for (var k = 0; k < stops.length; k++) {
      var s = stops[k];
      var c = s.coordinates || {};
      if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
        // one bad stop record must not take the whole route down
        if (s.durationInSeconds > 0) carryDur += s.durationInSeconds;
        continue;
      }
      var cands = projectCandidates(path, toXY(c.lat, c.lng));
      if (!cands.length) return null;
      var pick = cands[0];
      if (prevDist !== null) {
        // expected forward travel from the schedule's leg distance
        var expect = s.distanceInMeters > 0 ? s.distanceInMeters : null;
        var best = Infinity;
        cands.forEach(function (cand) {
          var fwd = mod(cand.routeDist - prevDist, path.length);
          if (fwd < 1 || fwd > path.length * 0.95) fwd = path.length; // not forward
          var score = cand.d2 + (expect ? Math.pow((fwd - expect) / 40, 2) : 0) + fwd * 0.01;
          if (fwd < path.length && score < best) { best = score; pick = cand; }
        });
        // every candidate failed the forward test: colocate with the previous
        // stop rather than fabricating a near-full-loop leg
        if (mod(pick.routeDist - prevDist, path.length) > path.length * 0.95) {
          pick = { routeDist: prevDist, d2: pick.d2 };
        }
      }
      var idx = model.stops.length;
      var legDur = idx === 0 ? 0 : (s.durationInSeconds > 0 ? s.durationInSeconds : null);
      var legDist = idx === 0 ? 0 : mod(pick.routeDist - prevDist, path.length);
      if (idx > 0 && legDur === null) legDur = legDist / CONFIG.fallbackSpeedMps;
      model.stops.push({
        id: s.id, name: (s.name || '').trim(), lat: c.lat, lng: c.lng, idx: idx,
        routeDist: pick.routeDist, legDur: (legDur || 0) + carryDur, legDist: legDist
      });
      carryDur = 0;
      prevDist = pick.routeDist;
    }
    if (model.stops.length < 2) return null;
    model.stops[model.stops.length - 1].isTerminalDup =
      model.stops[model.stops.length - 1].name === model.stops[0].name;
    return model;
  }

  // The one definition of "is this the mode's stop". The AM and PM halves of
  // the timetable use different stop-record ids for the same physical stops
  // (timetable rows also suffix the id with a loop index), so the name match
  // is the workhorse; the id match covers renames.
  function isModeStop(mode, name, id) {
    var cfg = CONFIG.modes[mode];
    if (id && (id === cfg.stopId || id.indexOf(cfg.stopId + '-') === 0)) return true;
    return cfg.match.test((name || '').trim());
  }

  function findStopIndex(model, mode) {
    for (var i = 1; i < model.stops.length; i++) {
      if (isModeStop(mode, model.stops[i].name, model.stops[i].id)) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ buses

  function extractBuses(site) {
    var devices = (site.liveTrackingSite || {}).devices || [];
    return devices.filter(function (d) {
      var routeId = typeof d.route === 'object' && d.route ? d.route.id : d.route;
      return routeId === CONFIG.routeId && d.online !== false && d.deviceUpdate &&
        validCoord(d.deviceUpdate.latitude, d.deviceUpdate.longitude);
    }).map(function (d) {
      var u = d.deviceUpdate;
      var w = u.when || u.updatedAt;
      if (typeof w !== 'number') w = Date.parse(w) || 0;
      return {
        id: d.id,
        name: (d.settings && d.settings.nickname) || d.displayId || d.deviceName || 'Shuttle',
        lat: u.latitude, lng: u.longitude,
        speed: u.speed || 0,
        // clamp clock skew: a future timestamp would otherwise pin the bus
        // as eternally fresh and outvote every later update
        when: Math.min(w, Date.now() + 5000),
        showOnMap: d.showOnMap !== false
      };
    });
  }

  // Single definition of bus liveness, shared by predictions and the map.
  function busStatus(bus, nowMs) {
    var age = bus.when ? nowMs - bus.when : Infinity;
    return {
      ageSec: Math.round(age / 1000),
      stale: age > CONFIG.staleMs,
      dead: age > CONFIG.deadMs || !bus.showOnMap
    };
  }

  // Apply a Pusher "ping_update" event to a bus (returns true if changed).
  function applyPing(bus, ping) {
    if (!ping || !Array.isArray(ping.l) || ping.l.length < 2 || !validCoord(ping.l[0], ping.l[1])) return false;
    var now = Date.now();
    bus.lat = ping.l[0];
    bus.lng = ping.l[1];
    if (Number.isFinite(ping.s)) bus.speed = ping.s;
    // an accepted ping always freshens the fix; fall back to receipt time
    // and clamp device clock skew (see extractBuses)
    bus.when = Math.min(Number.isFinite(ping.w) ? ping.w : now, now + 5000);
    if (typeof ping.showOnMap === 'boolean') bus.showOnMap = ping.showOnMap;
    return true;
  }

  /*
   * Locate a bus along the loop. `prev` is the bus's previous fix
   * ({routeDist, when}) used to keep the projection moving forward when the
   * route doubles back on the same street.
   */
  function locateBus(model, bus, prev) {
    var cands = projectCandidates(model.path, toXY(bus.lat, bus.lng));
    if (!cands.length) return null;
    var pick = null;
    if (prev && bus.when && prev.when && bus.when - prev.when < 240000) {
      var maxAdvance = CONFIG.maxSpeedMps * Math.max(0, (bus.when - prev.when) / 1000) + 250;
      var best = Infinity;
      cands.forEach(function (c) {
        if (c.d2 > cands[0].d2 * 16) return;
        var fwd = mod(c.routeDist - prev.routeDist + 120, model.path.length) - 120;
        if (fwd >= -120 && fwd <= maxAdvance && Math.abs(fwd) < best) {
          best = Math.abs(fwd); pick = c;
        }
      });
    }
    if (!pick) pick = cands[0];
    var offBy = Math.sqrt(pick.d2);
    return {
      routeDist: pick.routeDist,
      offRoute: offBy > CONFIG.offRouteMeters,
      offBy: offBy
    };
  }

  // Which leg (1..n-1) contains route distance d? Leg k spans
  // stops[k-1] -> stops[k] and its length is the stored legDist.
  function legAt(model, d) {
    var n = model.stops.length;
    for (var k = 1; k < n; k++) {
      // a zero-length leg (colocated stops) can't contain anything
      var span = Math.max(model.stops[k].legDist, 0.01);
      if (mod(d - model.stops[k - 1].routeDist, model.path.length) <= span + 0.01) return k;
    }
    return n - 1;
  }

  /*
   * Seconds for a bus at route distance `busDist` to reach stop index
   * `targetIdx` (1-based within model.stops), travelling forward around the
   * loop. Time within the current leg is prorated by distance; the rest uses
   * the scheduled leg durations.
   */
  function etaSeconds(model, busDist, targetIdx) {
    var n = model.stops.length;       // stops 0..n-1; legs 1..n-1; stop 0 == stop n-1
    var k = legAt(model, busDist);
    var L = model.path.length;
    var legSpan = Math.max(model.stops[k].legDist, 0.01);
    var into = Math.min(mod(busDist - model.stops[k - 1].routeDist, L), legSpan);
    var secs = (1 - into / legSpan) * model.stops[k].legDur;
    var i = k;
    var guard = 0;
    while (i !== targetIdx && guard++ < 2 * n) {
      i = i % (n - 1) + 1;           // next leg, wrapping n-1 -> 1
      secs += model.stops[i].legDur;
    }
    return secs;
  }

  function distanceAlong(model, fromDist, targetIdx) {
    return mod(model.stops[targetIdx].routeDist - fromDist, model.path.length);
  }

  // Earliest published arrival at targetIdx at or after secOfDay, across all
  // trips.
  function firstPublishedArrival(model, trips, targetIdx, secOfDay) {
    var best = null;
    for (var t = 0; t < trips.length; t++) {
      for (var j = 0; j < trips[t].entries.length; j++) {
        var e = trips[t].entries[j];
        if (!sameStop(model, e.idx, targetIdx)) continue;
        var sec = e.min * 60;
        if (sec >= secOfDay && (!best || sec < best.arrivalSec)) {
          best = { arrivalSec: sec, tripStartMin: trips[t].startMin };
        }
      }
    }
    return best;
  }

  // Shortest distance between two route positions around the loop.
  function loopGap(a, b, L) {
    return Math.abs(mod(a - b + L / 2, L) - L / 2);
  }

  // Stop indices i and j refer to the same physical stop (the loop terminal
  // appears as both stops[0] and stops[n-1]).
  function sameStop(model, i, j) {
    if (i === j) return true;
    var last = model.stops.length - 1;
    if (!model.stops[last].isTerminalDup) return false;
    return (i === 0 || i === last) && (j === 0 || j === last);
  }

  // Is route distance d within anchor radius of any trip's first stop (a
  // loop anchor where buses stage between runs)?
  function nearTripStart(model, trips, d) {
    for (var t = 0; t < trips.length; t++) {
      var s = trips[t].entries[0];
      if (s && loopGap(d, s.routeDist, model.path.length) < CONFIG.anchorRadiusMeters) return true;
    }
    return false;
  }

  /*
   * A parked bus at a loop anchor is (re)starting a trip: the next published
   * departure from that anchor, with a short grace for departures it is
   * running late on. Returns {trip, lateBy} or null.
   */
  function stagedDeparture(model, trips, fix, bus, nowSecOfDay) {
    if (bus.speed >= CONFIG.parkedSpeedMps || !trips) return null;
    var staged = null;
    trips.forEach(function (t) {
      var s0 = t.entries[0];
      if (!s0) return;
      if (loopGap(fix.routeDist, s0.routeDist, model.path.length) >= CONFIG.anchorRadiusMeters) return;
      if (t.startMin * 60 < nowSecOfDay - CONFIG.stagedGraceSec) return;
      if (!staged || t.startMin < staged.startMin) staged = t;
    });
    return staged ? { trip: staged, lateBy: Math.max(0, nowSecOfDay - staged.startMin * 60) } : null;
  }

  /*
   * Schedule-adherence prediction for one bus.
   *
   * Matches the bus to the timetable trip whose schedule best agrees with
   * the bus's position right now, measures the bus's delay against it, and
   * applies that delay to the published time at the target stop. Falls back
   * to integrating leg durations when no trip matches.
   *
   * Returns { arrivalSec (seconds-of-day), delaySec, method, tripStartMin }
   * or null when no more service reaches the stop today.
   */
  function predictBus(model, trips, fix, bus, targetIdx, nowSecOfDay) {
    var L = model.path.length;
    var best = null;
    (trips || []).forEach(function (trip) {
      var winLo = trip.startMin * 60 - CONFIG.tripMatch.windowBeforeSec;
      var winHi = trip.endMin * 60 + CONFIG.tripMatch.windowAfterSec;
      if (nowSecOfDay < winLo || nowSecOfDay > winHi) return;
      var tau = tripTau(trip, model, fix.routeDist);
      if (!tau) return;
      var delay = nowSecOfDay - tau.tauSec;
      if (!best || Math.abs(delay) < Math.abs(best.delay)) {
        best = { trip: trip, tau: tau, delay: delay };
      }
    });

    // A bus holding at a loop anchor departs at the next published start
    // from that anchor. This only applies when the bus is not demonstrably
    // mid-trip (a trustworthy match that has progressed past its first leg
    // wins): a bus merely dwelling at a stop the loop passes through must
    // not be hijacked onto a much later trip anchored there.
    var trusted = best && Math.abs(best.delay) <= CONFIG.tripMatch.maxDelaySec;
    if (!trusted || best.tau.entryIdx === 0) {
      var staged = stagedDeparture(model, trips, fix, bus, nowSecOfDay);
      if (staged) {
        for (var s = 0; s < staged.trip.entries.length; s++) {
          if (sameStop(model, staged.trip.entries[s].idx, targetIdx)) {
            return {
              arrivalSec: staged.trip.entries[s].min * 60 + staged.lateBy,
              delaySec: staged.lateBy,
              method: 'schedule',
              tripStartMin: staged.trip.startMin
            };
          }
        }
      }
    }

    if (trusted) {
      var trip = best.trip;
      var delay = best.delay;
      // First entry for the target stop that is still ahead of the bus.
      var tEntry = null;
      for (var i = 0; i < trip.entries.length; i++) {
        if (!sameStop(model, trip.entries[i].idx, targetIdx)) continue;
        tEntry = trip.entries[i];
        if (i > best.tau.entryIdx) {
          return {
            arrivalSec: tEntry.min * 60 + delay,
            delaySec: delay,
            method: 'schedule',
            tripStartMin: trip.startMin
          };
        }
      }
      // The drawn polyline simplifies some blocks, so a bus still approaching
      // the stop can project just past it. Hold the arrival while the
      // projection is within the grace zone and the schedule agrees.
      if (tEntry) {
        var pastBy = mod(fix.routeDist - tEntry.routeDist, L);
        var passSec = tEntry.min * 60 + delay;
        if (pastBy < CONFIG.passedStopGraceMeters && Math.abs(nowSecOfDay - passSec) < CONFIG.passedStopGraceSec) {
          return {
            arrivalSec: Math.max(nowSecOfDay, passSec),
            delaySec: delay,
            method: 'schedule',
            tripStartMin: trip.startMin
          };
        }
      }
      // Bus genuinely passed the stop on this loop: its next visit is the
      // first published time it can physically reach by driving around
      // (published times in between are other vehicles' trips).
      var travelSec = etaSeconds(model, fix.routeDist, targetIdx);
      var next = firstPublishedArrival(model, trips, targetIdx, nowSecOfDay + CONFIG.reachabilityFactor * travelSec);
      if (next) return { arrivalSec: next.arrivalSec, delaySec: null, method: 'next-trip', tripStartMin: next.tripStartMin };
      return null; // no more service to that stop today
    }

    if (trips && trips.length) {
      // A parked bus at a loop anchor with no departure to stage for is
      // holding; otherwise a wildly-off-schedule moving bus's live position
      // is more trustworthy than any trip match.
      var holding = bus.speed < CONFIG.parkedSpeedMps && nearTripStart(model, trips, fix.routeDist);
      if (best && !holding) {
        return { arrivalSec: nowSecOfDay + etaSeconds(model, fix.routeDist, targetIdx), delaySec: null, method: 'legs', tripStartMin: null };
      }
      // Between service periods (or holding for one): the next published
      // trip is the real answer.
      var sched = firstPublishedArrival(model, trips, targetIdx, nowSecOfDay + 1);
      if (sched) return { arrivalSec: sched.arrivalSec, delaySec: null, method: 'scheduled-only', tripStartMin: sched.tripStartMin };
      return null; // no service left today
    }

    // Timetable unavailable: integrate scheduled leg durations from the
    // live position.
    return {
      arrivalSec: nowSecOfDay + etaSeconds(model, fix.routeDist, targetIdx),
      delaySec: null,
      method: 'legs',
      tripStartMin: null
    };
  }

  /*
   * Full per-bus ETA summary for a mode, sorted soonest first:
   * [{bus, etaSec, etaMin, arrivalSec, delaySec, method, meters,
   *   legFrom, legTo, stale, ageSec, offRoute, fix}]
   */
  function predictions(model, trips, buses, mode, prevFixes, nowDate) {
    var targetIdx = findStopIndex(model, mode);
    if (targetIdx < 0) return [];
    var now = nowDate || new Date();
    var tz = tzNow(now);
    var nowSecOfDay = tz.minutes * 60 + tz.seconds;
    var out = [];
    buses.forEach(function (bus) {
      var status = busStatus(bus, now.getTime());
      if (status.dead) return;
      var fix = locateBus(model, bus, prevFixes && prevFixes[bus.id]);
      if (!fix || fix.offBy > CONFIG.garageMeters) return; // garage/no-fix positions predict nothing
      if (prevFixes) prevFixes[bus.id] = { routeDist: fix.routeDist, when: bus.when };
      var p = predictBus(model, trips, fix, bus, targetIdx, nowSecOfDay);
      if (!p) return;
      var k = legAt(model, fix.routeDist);
      var etaSec = Math.max(0, p.arrivalSec - nowSecOfDay);
      out.push({
        bus: bus,
        etaSec: etaSec,
        etaMin: Math.round(etaSec / 60),
        arrivalSec: p.arrivalSec,
        delaySec: p.delaySec,
        method: p.method,
        tripStartMin: p.tripStartMin,
        meters: distanceAlong(model, fix.routeDist, targetIdx),
        legFrom: model.stops[k - 1].name,
        legTo: model.stops[k].name,
        stale: status.stale,
        ageSec: status.ageSec,
        offRoute: fix.offRoute,
        fix: fix
      });
    });
    out.sort(function (a, b) { return a.etaSec - b.etaSec; });
    return out;
  }

  // --------------------------------------------------------------- schedule

  // Tolerates whitespace, seconds, and an AM/PM suffix in case the feed's
  // formatting drifts.
  function parseDisplayTime(s) {
    var m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?\s*$/i.exec(s || '');
    if (!m) return null;
    var h = parseInt(m[1], 10);
    if (m[3]) {
      if (/pm/i.test(m[3]) && h < 12) h += 12;
      if (/am/i.test(m[3]) && h === 12) h = 0;
    }
    return h * 60 + parseInt(m[2], 10);
  }

  // Loose key for joining stop names across the timetable and route data, so
  // a cosmetic rename ("Berry St at Mission Creek") doesn't sever the join.
  function nameKey(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // All scheduled minutes-of-day at the mode's stop, across the day's loops.
  function stopScheduleMinutes(depData, mode) {
    var mins = [];
    (Array.isArray(depData) ? depData : []).forEach(function (loop) {
      ((loop && loop.stops) || []).forEach(function (s) {
        if (!isModeStop(mode, s.name, s.id)) return;
        var v = parseDisplayTime(s.displayTime);
        if (v !== null) mins.push(v);
      });
    });
    return Array.from(new Set(mins)).sort(function (a, b) { return a - b; });
  }

  function stopImage(depData, mode) {
    if (!Array.isArray(depData)) return null;
    for (var i = 0; i < depData.length; i++) {
      var stops = (depData[i] && depData[i].stops) || [];
      for (var j = 0; j < stops.length; j++) {
        if (isModeStop(mode, stops[j].name, stops[j].id) && stops[j].imageUrl) return stops[j].imageUrl;
      }
    }
    return null;
  }

  /*
   * Build timetable trips from the departure data. Each trip is one loop:
   *   { startMin, endMin, entries: [{name, idx, routeDist, min}] }
   * Entries follow the trip's own stop order; idx is the model stop index
   * (terminal duplicates resolved by forward progression around the loop).
   */
  function buildTrips(depData, model) {
    var L = model.path.length;
    var byName = {};
    model.stops.forEach(function (s) {
      var key = nameKey(s.name);
      (byName[key] = byName[key] || []).push(s.idx);
    });
    var trips = [];
    (Array.isArray(depData) ? depData : []).forEach(function (loop) {
      var entries = [];
      var prevIdx = null;
      ((loop && loop.stops) || []).forEach(function (s) {
        var min = parseDisplayTime(s.displayTime);
        var nm = (s.name || '').trim();
        var idxs = byName[nameKey(nm)];
        if (min === null || !idxs) return;
        var idx = idxs[0];
        if (prevIdx !== null) {
          // pick the occurrence that moves forward around the loop; on a tie
          // (the terminal is both stops[0] and stops[n-1]) prefer the higher
          // index so closing rows resolve like findStopIndex does
          var best = Infinity;
          idxs.forEach(function (i) {
            var step = i - prevIdx;
            if (step <= 0) step += model.stops.length - 1;
            if (step < best || (step === best && i > idx)) { best = step; idx = i; }
          });
        }
        prevIdx = idx;
        var rd = model.stops[idx].routeDist;
        entries.push({ name: nm, idx: idx, routeDist: rd >= L ? rd - L : rd, min: min });
      });
      if (entries.length >= 2) {
        trips.push({ startMin: entries[0].min, endMin: entries[entries.length - 1].min, entries: entries });
      }
    });
    trips.sort(function (a, b) { return a.startMin - b.startMin; });
    return trips;
  }

  /*
   * Where in this trip's schedule is a bus at route distance d?
   * Returns {tauSec: seconds-of-day, entryIdx: index of the bracketing
   * entry the bus has passed} or null if the position can't be bracketed.
   */
  function tripTau(trip, model, d) {
    var L = model.path.length;
    for (var i = 0; i + 1 < trip.entries.length; i++) {
      var a = trip.entries[i], b = trip.entries[i + 1];
      var span = mod(b.routeDist - a.routeDist, L);
      if (span < 1) continue; // duplicate/colocated entries span nothing
      var into = mod(d - a.routeDist, L);
      if (into <= span) {
        var frac = into / span;
        return { tauSec: (a.min + frac * (b.min - a.min)) * 60, entryIdx: i };
      }
    }
    // Past the last scheduled stop (the short tail back toward the first
    // stop of the next loop): extrapolate at the fallback speed.
    var last = trip.entries[trip.entries.length - 1];
    var over = mod(d - last.routeDist, L);
    return { tauSec: last.min * 60 + over / CONFIG.fallbackSpeedMps, entryIdx: trip.entries.length - 1 };
  }

  var TZ_FORMAT = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.timezone, hour12: false, hourCycle: 'h23', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  var DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone });

  // Current time in the shuttle's timezone.
  function tzNow(date) {
    var parts = TZ_FORMAT.formatToParts(date || new Date());
    var get = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value; };
    var hour = parseInt(get('hour'), 10) % 24; // "24" at midnight in some engines
    return {
      weekday: get('weekday'),
      minutes: hour * 60 + parseInt(get('minute'), 10),
      seconds: parseInt(get('second'), 10)
    };
  }

  // ISO yyyy-mm-dd in the shuttle's timezone (for "has the day rolled over").
  function dayKey(date) {
    return DAY_FORMAT.format(date || new Date());
  }

  var WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  function operatesOnDay(model, dayName) {
    var days = (model.route || {}).operatesOnDays;
    if (!days) return true;
    return dayName in days ? days[dayName] !== false : true;
  }

  function operatesToday(model, now) {
    return operatesOnDay(model, ((now || tzNow()).weekday || '').toLowerCase());
  }

  // "tomorrow", or the name of the next operating day when tomorrow has no
  // service (Friday night the answer is Monday).
  function nextServiceDayLabel(model, weekdayName) {
    var i = WEEKDAYS.indexOf((weekdayName || '').toLowerCase());
    if (i < 0) return 'tomorrow';
    for (var k = 1; k <= 7; k++) {
      var d = WEEKDAYS[(i + k) % 7];
      if (operatesOnDay(model, d)) {
        return k === 1 ? 'tomorrow' : d.charAt(0).toUpperCase() + d.slice(1);
      }
    }
    return 'tomorrow';
  }

  function nextScheduled(scheduleMins, nowMinutes, count) {
    var next = scheduleMins.filter(function (m) { return m > nowMinutes; });
    return next.slice(0, count || 3);
  }

  function fmtClock(minutes) {
    var h = Math.floor(minutes / 60) % 24, m = minutes % 60;
    var ampm = h >= 12 ? 'PM' : 'AM';
    var hh = h % 12 || 12;
    return hh + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  // ------------------------------------------------------------------ fetch

  function getJson(url, label, fetchFn) {
    var opts = { headers: { 'tr-org-id': CONFIG.orgId, 'tr-org-token': CONFIG.orgToken } };
    // a fetch that never settles would wedge the poll loop for good
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(25000);
    return (fetchFn || fetch)(url, opts)
      .then(function (r) {
        if (!r.ok) throw new Error(label + ' HTTP ' + r.status);
        return r.json();
      });
  }

  function fetchLiveSite(fetchFn) {
    return getJson(CONFIG.apiBase + '/live-tracking-site?version=1', 'live-tracking-site', fetchFn);
  }

  function fetchDepartures(fetchFn) {
    var url = CONFIG.apiBase + '/live-tracking-site/fetch-run-departure-data?token=' +
      encodeURIComponent(CONFIG.orgToken) + '&runId=' + encodeURIComponent(CONFIG.runId) +
      '&source=live-tracking';
    return getJson(url, 'departure-data', fetchFn);
  }

  return {
    CONFIG: CONFIG,
    decodePolyline: decodePolyline,
    buildPath: buildPath,
    projectCandidates: projectCandidates,
    toXY: toXY,
    mod: mod,
    buildLoopModel: buildLoopModel,
    findStopIndex: findStopIndex,
    isModeStop: isModeStop,
    extractBuses: extractBuses,
    busStatus: busStatus,
    applyPing: applyPing,
    locateBus: locateBus,
    legAt: legAt,
    etaSeconds: etaSeconds,
    buildTrips: buildTrips,
    tripTau: tripTau,
    predictBus: predictBus,
    predictions: predictions,
    stopScheduleMinutes: stopScheduleMinutes,
    stopImage: stopImage,
    tzNow: tzNow,
    dayKey: dayKey,
    operatesToday: operatesToday,
    nextServiceDayLabel: nextServiceDayLabel,
    loopGap: loopGap,
    sameStop: sameStop,
    nextScheduled: nextScheduled,
    fmtClock: fmtClock,
    fetchLiveSite: fetchLiveSite,
    fetchDepartures: fetchDepartures
  };
});
