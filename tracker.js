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
    staleMs: 120000,         // position pings older than this are flagged stale
    deadMs: 600000,          // and older than this are dropped entirely
    holdDeadMs: 1200000,     // ...unless the last fix was stopped: devices go quiet while
                             // parked (field gaps up to 14 min during layovers)
    fallbackSpeedMps: 5.5,   // assumed speed where the schedule gives no duration
    maxSpeedMps: 18,         // cap on plausible bus speed for projection continuity
    parkedSpeedMps: 1.5,     // below this a bus is treated as holding in place
    anchorRadiusMeters: 350, // a parked bus this far BEFORE a trip's first stop is staged
                             // for it (covers the AM staging lot ~300 m before Berry & King)
    anchorPastMeters: 60,    // ...or this far past it (GPS jitter at the pole). Farther past,
                             // the bus has left the anchor and its real earliness counts
    anchorHoldPastMeters: 250, // ...except a confirmed hold (>= holdSec) this far past it
    stagedGraceSec: 300,     // parked this long past a departure = waiting for the next one
    passedStopGraceMeters: 120, // STOP ZONE: within this past the pole a bus is at the
                                // stop whatever its trip or schedule says (covers the
                                // measured drawn-vs-real overshoot, <= ~100 m); a bus
                                // is only "gone" once a fix shows it beyond the zone
    stoppedZoneMeters: 160,     // ...a STOPPED bus not seen driving away counts as not-
                                // yet-gone this far past (dwells measured to +93 m)...
    stationaryZoneMeters: 250,  // ...and one HOLDING (>= holdSec) this far: departed buses
                                // wait at the next light 183-238 m past both stops, holds
                                // there were never recorded
    stopApproachMeters: 60,     // a stopped bus this close before the pole is at the stop
    atStopOffMeters: 45,        // ...and only a fix this close to the drawn line is "at" a
                                // pole on it (at-stop fixes measured <= 19 m off; leaving
                                // Berry at Mission Creek buses drive 84-204 m off the drawing)
    stoppedEtaFloorSec: 60,     // ...and one stopped farther out is at least this far away
                                // (while its fix is fresh)
    recededMs: 600000,          // a bus seen driving away from a stop stays "gone" from it
                                // for this long (fix time) when it stops nearby
    passageNoiseMeters: 20,     // a stopped bus's other passage is as likely as the nearest
                                // only within GPS noise of it: the outbound dwell past Berry
                                // wanders up to ~15 m toward the return line, while the 4th
                                // at Library pole (return leg) is 25 m from the outbound line
    garageMeters: 1500,      // beyond this from the route, a fix predicts nothing
    fitPerMeterSec: 0.6,     // exchange rate between distance and schedule-fit
                             // evidence when resolving an ambiguous passage: a
                             // meter closer is worth this many seconds of fit
    regressMeters: 25,       // backward motion along the locked passage beyond
                             // GPS jitter counts toward the wrong-passage unlock
    regressUnlockCount: 3,   // consecutive regressing fixes that break the lock
                             // (~30-45 s at typical ping cadence)
    resumeMeters: 60,        // after any GPS silence, a fix this close to the last one
                             // continues the same passage (42 of 43 recorded resumes)
    holdJitterMeters: 75,    // a stopped bus's fixes stay this close to where it
                             // stopped (staging-lot jitter measured 61-72 m)
    holdSec: 150,            // stationary this long = holding, not paused at a
                             // light (red lights run ~60-90 s)
    holdFreezeSec: 30,       // a bus stopped this long keeps its trip match: elapsed
                             // time while parked is not evidence for a later trip
    yardOffMeters: 90,       // a bus holding this far off the drawn line is parked
                             // off-route (staging lot), not running toward a stop...
    yardQuietMs: 600000,     // ...unless it drove the route in the last 10 min (a queue
                             // on a street the drawing misses is still service)
    stagingLots: [            // where idle buses park (centroid of 55 recorded fixes)
      { lat: 37.76884, lng: -122.39762, radius: 75 }
    ],
    minLegSpeedMps: 2.0,     // Trakk leg durations are capped at this pace (one leg
                             // lists 769 s for 147 m — a routing artifact)
    serviceTailSec: 45 * 60, // buses run this long past the last published trip end
                             // (late buses / trips missing from the feed's timetable)
    teleportMeters: 2500,    // a continuity break implying a jump this far ahead...
    wideContinuityMeters: 220, // ...looks for the bus's own passage this far off the line
                             // (recorded detours run up to 204 m off the drawing past Berry,
                             // 187 m at Fremont; farther out the bus is on another passage)
    tripMatch: {
      windowBeforeSec: 15 * 60, // how early a trip is considered active (must not
                                // exceed maxDelaySec or staged buses fall in a gap)
      windowAfterSec: 20 * 60,  // how long past its last stop it stays active
                                // (must cover maxDelaySec or a very late
                                // bus's own trip drops out of the match set
                                // and hysteresis releases at the worst time)
      maxDelaySec: 20 * 60,     // beyond this the trip match is distrusted;
                                // also bounds how late a comeback bus can
                                // still be running a slot (nextOwnArrival)
      stickySec: 150            // a challenger trip must beat the currently
                                // matched one by this margin — a bus ~half a
                                // headway late scores almost identically as
                                // "early on the next trip", and without
                                // hysteresis projection noise flips the match
                                // (and the early/late badge) every render
    },
    // plausible service area; rejects garbage fixes like Trakk's -404 sentinel
    bounds: { latMin: 37.5, latMax: 38.1, lngMin: -122.8, lngMax: -122.0 },
    // Corrections to Trakk's drawn polyline where it cuts across blocks
    // instead of following the streets the buses actually drive (verified
    // against recorded GPS traces). Each patch replaces the drawn segment
    // between the vertices nearest `from` and `to` with `points` (an encoded
    // polyline). Anchors must land within 120 m of an existing vertex or
    // the patch is skipped (i.e. Trakk redrew the route).
    geometryPatches: []
  };

  // ---------------------------------------------------------------- geometry

  var REF_LAT = 37.77;
  var M_LAT = 111320;
  var M_LNG = Math.cos(REF_LAT * Math.PI / 180) * M_LAT;

  function toXY(lat, lng) { return { x: lng * M_LNG, y: lat * M_LAT }; }

  // Straight-line ground distance (m) between two {lat, lng} points.
  function groundMeters(a, b) {
    var p = toXY(a.lat, a.lng), q = toXY(b.lat, b.lng);
    return Math.hypot(p.x - q.x, p.y - q.y);
  }

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
  function projectCandidates(path, pt, minCapMeters) {
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
    // within 3x best, or 50 m (or the caller's wider radius)
    var cap = Math.max(raw.length ? raw[0].d2 * 9 : 0, 2500,
      minCapMeters ? minCapMeters * minCapMeters : 0);
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

  // Splice geometry corrections into the drawn polyline (see
  // CONFIG.geometryPatches). Anchors must land within 120 m of an existing
  // vertex or the patch is skipped as no longer applicable.
  function applyGeometryPatches(latlngs, patches) {
    (patches || []).forEach(function (patch) {
      // First passage wins: on a self-crossing loop the globally nearest
      // vertex can belong to the other passage, which would splice out
      // everything in between. Take the local minimum of the first run of
      // vertices inside the tolerance.
      var nearest = function (target, lo) {
        var d2at = function (i) {
          var dx = (latlngs[i].lng - target[1]) * M_LNG;
          var dy = (latlngs[i].lat - target[0]) * M_LAT;
          return dx * dx + dy * dy;
        };
        for (var i = lo; i < latlngs.length; i++) {
          if (d2at(i) > 120 * 120) continue;
          while (i + 1 < latlngs.length && d2at(i + 1) <= d2at(i)) i++;
          return i;
        }
        return -1;
      };
      var i = nearest(patch.from, 0);
      var j = i >= 0 ? nearest(patch.to, i + 1) : -1;
      if (i < 0 || j < 0) return;
      latlngs = latlngs.slice(0, i + 1).concat(decodePolyline(patch.points), latlngs.slice(j));
    });
    return latlngs;
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

    var path = buildPath(applyGeometryPatches(decodePolyline(src.polyline), CONFIG.geometryPatches));
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
      if (idx > 0) legDur = Math.min(legDur, legDist / CONFIG.minLegSpeedMps);
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

  // One live-feed device, normalized for any route (shared by the app and
  // the field recorder): route id whether the feed sends an id or {id}, fix
  // time from `when` or the ISO `updatedAt` fallback.
  function normalizeDevice(d) {
    var u = d.deviceUpdate || {};
    var w = u.when || u.updatedAt;
    if (typeof w !== 'number') w = Date.parse(w) || 0;
    return {
      id: d.id,
      name: (d.settings && d.settings.nickname) || d.displayId || d.deviceName || 'Shuttle',
      routeId: typeof d.route === 'object' && d.route ? d.route.id : d.route,
      online: d.online,
      lat: u.latitude, lng: u.longitude,
      speed: u.speed, heading: u.heading,
      when: w,
      showOnMap: d.showOnMap !== false
    };
  }

  function extractBuses(site) {
    var devices = (site.liveTrackingSite || {}).devices || [];
    return devices.filter(function (d) { return d.deviceUpdate; }).map(normalizeDevice).filter(function (b) {
      return b.routeId === CONFIG.routeId && b.online !== false && validCoord(b.lat, b.lng);
    }).map(function (b) {
      return {
        id: b.id,
        name: b.name,
        lat: b.lat, lng: b.lng,
        speed: b.speed || 0,
        // clamp clock skew: a future timestamp would otherwise pin the bus
        // as eternally fresh and outvote every later update
        when: Math.min(b.when, Date.now() + 5000),
        showOnMap: b.showOnMap
      };
    });
  }

  // Single definition of bus liveness, shared by predictions and the map.
  function busStatus(bus, nowMs) {
    var age = bus.when ? nowMs - bus.when : Infinity;
    return {
      ageSec: Math.round(age / 1000),
      stale: age > CONFIG.staleMs,
      dead: age > ((bus.speed || 0) < CONFIG.parkedSpeedMps ? CONFIG.holdDeadMs : CONFIG.deadMs) ||
        !bus.showOnMap
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
   * Match a route position against the timetable: the best-fitting active
   * trip by |delay|, with pre-start candidates penalized by the hysteresis
   * margin — a trip already underway is a more plausible explanation than
   * one that hasn't started (a bus just past a stop, slightly late on its
   * own trip, projects almost identically to "slightly early" on the next
   * trip, and picking the future trip resurrects departed buses).
   */
  function matchTrips(model, trips, routeDist, busSec, prevTripStartMin) {
    var best = null, prevMatch = null;
    (trips || []).forEach(function (trip) {
      var winLo = trip.startMin * 60 - CONFIG.tripMatch.windowBeforeSec;
      var winHi = trip.endMin * 60 + CONFIG.tripMatch.windowAfterSec;
      if (busSec < winLo || busSec > winHi) return;
      var tau = tripTau(trip, model, routeDist);
      if (!tau) return;
      var delay = busSec - tau.tauSec;
      var score = Math.abs(delay) + (busSec >= trip.startMin * 60 ? 0 : CONFIG.tripMatch.stickySec);
      var cand = { trip: trip, tau: tau, delay: delay, score: score };
      if (trip.startMin === prevTripStartMin) prevMatch = cand;
      if (!best || score < best.score) best = cand;
    });
    return { best: best, prevMatch: prevMatch };
  }

  // How well a route position agrees with the timetable right now — capped
  // so hopeless positions compare on distance alone.
  function tripFitSec(model, trips, routeDist, busSec) {
    if (!trips || !trips.length || typeof busSec !== 'number') return 0;
    var m = matchTrips(model, trips, routeDist, busSec);
    return m.best ? Math.min(m.best.score, CONFIG.tripMatch.maxDelaySec) : CONFIG.tripMatch.maxDelaySec;
  }

  /*
   * Locate a bus on the loop. Continuity follows the passage consistent
   * with the previous fix; a fix with no usable history (cold start, stale
   * prev, or a persistent-regression unlock) is resolved jointly: among
   * the distance-plausible passages, the one whose schedule fit is best
   * wins — in the Mission Bay corridor the outbound approach and the
   * return legs run within ~40 m of each other while sitting ~25 scheduled
   * minutes apart, so nearest-line-wins routinely teleports an arriving
   * bus half a loop ahead.
   */
  function locateBus(model, bus, prev, trips, busSec) {
    var cands = projectCandidates(model.path, toXY(bus.lat, bus.lng));
    if (!cands.length) return null;
    var L = model.path.length;
    var pick = null;
    var regressCount = 0;
    // A bus that keeps moving BACKWARD along its locked passage is really
    // driving forward along another one (real buses never reverse around
    // the loop) — treat the lock as broken and re-resolve from scratch.
    // A bus that hasn't moved since its last fix keeps its passage however
    // long the GPS was quiet: devices go silent while parked, and right past
    // Berry at Mission Creek the return line crosses the outbound one, so a
    // cold re-resolution after a long hold can land on the wrong leg.
    var stillThere = prev && typeof prev.lat === 'number' && groundMeters(prev, bus) < CONFIG.resumeMeters;
    // A stopped bus whose passage was left open (several equally near
    // passages, see earliestPlausible) is re-resolved on every fix until it
    // moves: the reading it was given was the benefit of the doubt, not a
    // position to continue from.
    var usablePrev = prev && !prev.unresolved && bus.when && prev.when &&
      (bus.when - prev.when < 240000 || stillThere) &&
      !(prev.regressCount >= CONFIG.regressUnlockCount);
    var pickedByContinuity = false;
    var guarded = false;
    if (usablePrev) {
      var maxAdvance = CONFIG.maxSpeedMps * Math.max(0, (bus.when - prev.when) / 1000) + 250;
      var best = Infinity;
      cands.forEach(function (c) {
        // no distance filter here: where the route crosses itself (e.g.
        // Fremont & Howard) the bus hugs the other passage's line, and
        // dropping the farther-but-continuous candidate flips the
        // projection ±minutes on every ping at the crossing
        var fwd = mod(c.routeDist - prev.routeDist + 120, L) - 120;
        if (fwd >= -120 && fwd <= maxAdvance && Math.abs(fwd) < best) {
          best = Math.abs(fwd); pick = c;
        }
      });
      if (pick) {
        pickedByContinuity = true;
        if (bus.when === prev.when || (bus.speed || 0) < CONFIG.parkedSpeedMps) {
          // same fix re-evaluated (render tick, mode switch), or a parked
          // bus whose GPS wobbles in place: no evidence either way — carry
          // the count, don't wipe it and don't grow it
          regressCount = prev.regressCount || 0;
        } else {
          var picked = mod(pick.routeDist - prev.routeDist + 120, L) - 120;
          regressCount = picked < -CONFIG.regressMeters ? (prev.regressCount || 0) + 1
            : picked > CONFIG.regressMeters ? 0            // clear forward progress
              : (prev.regressCount || 0);                  // dwell: hold
        }
      }
    }
    if (!pick && usablePrev) {
      // Teleport guard: where the real street runs well off the drawn line
      // (just past Berry at Mission Creek buses drive 50-200 m from the
      // drawing, 7-100 m from the return leg), the capped candidate set
      // loses the bus's own passage and the fallthrough would jump it
      // kilometers ahead. A bus can't do that in under two minutes: look
      // for its own passage in a wider radius first.
      var nearest = cands[0];
      if (mod(nearest.routeDist - prev.routeDist, L) > CONFIG.teleportMeters) {
        var wide = projectCandidates(model.path, toXY(bus.lat, bus.lng), CONFIG.wideContinuityMeters);
        var maxAdv = CONFIG.maxSpeedMps * Math.max(0, (bus.when - prev.when) / 1000) + 250;
        var bestFwd = Infinity;
        wide.forEach(function (c) {
          if (Math.sqrt(c.d2) > CONFIG.wideContinuityMeters) return;
          var fwd = mod(c.routeDist - prev.routeDist + 120, L) - 120;
          if (fwd >= -120 && fwd <= maxAdv && Math.abs(fwd) < bestFwd) { bestFwd = Math.abs(fwd); pick = c; }
        });
        if (pick) {
          regressCount = prev.regressCount || 0;
          pickedByContinuity = true;
          guarded = true;
        }
      }
    }
    if (!pick) {
      // Joint resolution: the nearest passage wins by default — position is
      // strong evidence — but another distance-plausible passage takes the
      // fix when its schedule fit is DECISIVELY better (a bus mid-corridor
      // whose nearest line implies being 25 minutes off-schedule while the
      // line a few meters farther matches to the second). Comparable fits
      // must never override distance: at the pinch points both passages
      // often fit within seconds of each other.
      var d0 = Math.sqrt(cands[0].d2);
      var fit0 = tripFitSec(model, trips, cands[0].routeDist, busSec);
      pick = cands[0];
      var bestAdv = 0;
      cands.forEach(function (c, i) {
        if (i === 0) return;
        var d = Math.sqrt(c.d2);
        if (d > d0 * 2 + 30) return;
        var adv = fit0 - tripFitSec(model, trips, c.routeDist, busSec) -
          (d - d0) * CONFIG.fitPerMeterSec - CONFIG.tripMatch.stickySec;
        if (adv > bestAdv) { bestAdv = adv; pick = c; }
      });
    }
    var offBy = Math.sqrt(pick.d2);
    return {
      routeDist: pick.routeDist,
      offRoute: offBy > CONFIG.offRouteMeters,
      offBy: offBy,
      regressCount: regressCount,
      // held on its own passage by the teleport guard: the bus is somewhere
      // off the drawn line, not at a point on it
      guarded: guarded,
      // no continuity behind this fix (cold open, stale or unlocked prev):
      // the other passages it could be on, for a stop-aware second look
      alts: usablePrev && pickedByContinuity ? null : cands
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
      var e = firstEntryFor(model, trips[t], targetIdx);
      if (!e) continue;
      var sec = e.min * 60;
      if (sec >= secOfDay && (!best || sec < best.arrivalSec)) {
        best = { arrivalSec: sec, tripStartMin: trips[t].startMin };
      }
    }
    return best;
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
  // At a trip's first stop for staging purposes: up to anchorRadiusMeters
  // BEFORE it (the approach / staging lot) or GPS jitter past the pole. One-
  // sided on purpose: a bus farther past the anchor has left it, and staging
  // it onto the next departure pins a moving bus to a published time it is
  // ~10 minutes ahead of (the 2026-10-13 "11 min" report).
  function atAnchor(model, d, anchorRd, holdSec) {
    var L = model.path.length;
    // a confirmed hold (not a light) a little past the pole is still a layover
    var past = holdSec >= CONFIG.holdSec ? CONFIG.anchorHoldPastMeters : CONFIG.anchorPastMeters;
    return mod(anchorRd - d, L) < CONFIG.anchorRadiusMeters || mod(d - anchorRd, L) < past;
  }

  // The loop anchor (some trip's first stop) route distance d is at, or null.
  function anchorNear(model, trips, d) {
    for (var t = 0; t < trips.length; t++) {
      var s = trips[t].entries[0];
      if (s && atAnchor(model, d, s.routeDist, 0)) return model.stops[s.idx] || null;
    }
    return null;
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
      if (!atAnchor(model, fix.routeDist, s0.routeDist, fix.holdSec)) return;
      if (t.startMin * 60 < nowSecOfDay - CONFIG.stagedGraceSec) return;
      if (!staged || t.startMin < staged.startMin) staged = t;
    });
    return staged ? { trip: staged, lateBy: Math.max(0, nowSecOfDay - staged.startMin * 60) } : null;
  }

  // A trip has started and service hasn't wound down: from a trip's start
  // until well past its end (late buses, and trips missing from the feed's
  // timetable — on 2026-10-13 buses served both stops 21-40 minutes after
  // the last AM visits the feed lists).
  function inService(trips, sec) {
    return (trips || []).some(function (t) {
      return sec >= t.startMin * 60 && sec <= t.endMin * 60 + CONFIG.serviceTailSec;
    });
  }

  // A position-based arrival at the stop is believable only near a
  // published visit to that same stop: a bus whose estimate lands deep in a
  // service gap is deadheading to the yard, not coming to the rider.
  function plausibleArrival(model, trips, targetIdx, arrSec) {
    return (trips || []).some(function (t) {
      var e = firstEntryFor(model, t, targetIdx);
      return e && Math.abs(e.min * 60 - arrSec) <= CONFIG.serviceTailSec;
    });
  }

  // First timetable entry of a trip serving the target stop (entries are
  // time-ordered, so the first match is the earliest visit).
  function firstEntryFor(model, trip, targetIdx) {
    for (var i = 0; i < trip.entries.length; i++) {
      if (sameStop(model, trip.entries[i].idx, targetIdx)) return trip.entries[i];
    }
    return null;
  }

  /*
   * The bus's own next service of the target after passing it: it drives on
   * to a coming trip's first stop, departs at max(published start, when it
   * physically gets there), and carries that lateness to the target's
   * published time on that trip. Published times alone are not enough — a
   * bus finishing its loop 8 minutes late serves the "8:41" slot at 8:49,
   * and flooring on published times skips that visit entirely and reports
   * the following one (the field bug: "passed your stop — 9:07" for a bus
   * five minutes out).
   */
  function nextOwnArrival(model, trips, fix, busSec, targetIdx, futureOnly) {
    var best = null;
    (trips || []).forEach(function (t) {
      var s0 = t.entries[0];
      var last = t.entries[t.entries.length - 1];
      if (!s0 || !last) return;
      // a parked bus is not running a slot whose departure already passed
      if (futureOnly && t.startMin * 60 < busSec) return;
      var tEntry = firstEntryFor(model, t, targetIdx);
      if (!tEntry) return;
      var anchorIdx = s0.idx === 0 ? model.stops.length - 1 : s0.idx;
      var lastIdx = last.idx === 0 ? model.stops.length - 1 : last.idx;
      // Trakk's per-leg durations run ~25% slower than the printed
      // timetable (69 vs 54 minutes per loop), so raw drive times overshoot
      // long comebacks by double-digit minutes and can push the bus's real
      // slot over the plausibility cap. Scale by this trip's own printed
      // span over its engine-leg span.
      var engineSpan = etaSeconds(model, mod(s0.routeDist + 1, model.path.length), lastIdx);
      var printedSpan = (t.endMin - t.startMin) * 60;
      var pace = engineSpan > 0 ? Math.min(1.2, Math.max(0.5, printedSpan / engineSpan)) : 1;
      var reach = busSec + etaSeconds(model, fix.routeDist, anchorIdx) * pace;
      // maxDelaySec doubles as the comeback-slot window: beyond it the bus
      // plausibly waits for the next departure instead of running this one
      var lateBy = Math.max(0, reach - t.startMin * 60);
      if (lateBy > CONFIG.tripMatch.maxDelaySec) return;
      var arrival = tEntry.min * 60 + lateBy;
      if (!best || arrival < best.arrivalSec) {
        best = { arrivalSec: arrival, tripStartMin: t.startMin };
      }
    });
    return best;
  }

  // Prediction for a bus staged at a trip's first stop: it leaves at the
  // published start (or now, if it is late leaving) and carries that
  // lateness to the rider's stop.
  function stagedResult(model, trips, staged, targetIdx, fix, busSec) {
    var e = firstEntryFor(model, staged.trip, targetIdx);
    if (!e) return null;
    var anchor = model.stops[staged.trip.entries[0].idx];
    var timetabled = e.min * 60 + staged.lateBy;
    // The feed's timetable is stale and anchor departures were seen 9-11 min
    // ahead of it: the bus could leave now. Once service is running, the
    // countdown is the earliest it can physically be at the stop and the
    // timetable time is the latest. Before the period's first departure there
    // is nothing to leave early for.
    var earliest = inService(trips, busSec)
      ? Math.min(timetabled, busSec + etaSeconds(model, fix.routeDist, targetIdx)) : timetabled;
    return {
      arrivalSec: earliest, latestSec: timetabled > earliest + 90 ? timetabled : null,
      delaySec: staged.lateBy, method: 'schedule',
      tripStartMin: staged.trip.startMin, matchedTripStartMin: staged.trip.startMin,
      anchoredTripStartMin: staged.trip.startMin,
      waitingAt: anchor ? anchor.name : null, departsSec: staged.trip.startMin * 60 + staged.lateBy
    };
  }

  // A bus that passed the rider's stop comes back on its own next run when
  // the timetable has one for it this service period; otherwise — the feed's
  // timetable can be missing trips — from its position around the loop, as
  // long as service is still running.
  function comebackResult(model, trips, fix, busSec, targetIdx, nowSecOfDay, own, holding, memory) {
    var physical = busSec + etaSeconds(model, fix.routeDist, targetIdx);
    var estimated = false;
    if ((!own || own.arrivalSec > physical + CONFIG.serviceTailSec) && inService(trips, busSec) &&
        plausibleArrival(model, trips, targetIdx, physical)) {
      own = { arrivalSec: physical, tripStartMin: null };
      estimated = true;
    }
    if (!own) return null; // no more service to that stop today
    var L = model.path.length;
    var res = {
      arrivalSec: Math.max(own.arrivalSec, nowSecOfDay), delaySec: null,
      method: 'next-trip', holding: holding, tripStartMin: own.tripStartMin,
      estimated: estimated,
      // passed this stop recently (vs. on the far side of the loop, heading
      // back toward it) — the rider copy differs
      recentlyPassed: mod(fix.routeDist - model.stops[targetIdx].routeDist, L) < L / 2
    };
    if (memory) {
      res.matchedTripStartMin = memory.matchedTripStartMin;
      res.matchedTauSec = memory.matchedTauSec;
    }
    return res;
  }

  /*
   * Schedule-adherence prediction for one bus.
   *
   * All schedule reasoning (trip matching, delay, staged departures, the
   * passed-the-stop decision) is evaluated AS OF THE BUS'S LAST GPS FIX
   * (fixSecOfDay), not wall-clock time: when the GPS goes quiet, elapsed
   * time must not count against the bus — otherwise a silent bus "drifts"
   * onto a later trip and the app claims it already left when the only
   * evidence says it was still approaching. Only arrival floors use real
   * now (an arrival can't be in the past). A bus is declared past the stop
   * solely from its position at fix time.
   *
   * Returns { arrivalSec (seconds-of-day), delaySec, method, tripStartMin }
   * or null when no more service reaches the stop today.
   */
  function predictBus(model, trips, fix, bus, targetIdx, nowSecOfDay, fixSecOfDay, prev) {
    var prevTripStartMin = prev && prev.tripStartMin;
    var L = model.path.length;
    // fixSecOfDay is required — a silent wall-clock fallback would reintroduce
    // the "quiet bus drifts onto a later trip" bug for any future caller.
    // mod-wrap: a fix taken just before midnight viewed just after stays on
    // the previous evening instead of becoming second 0 of the new day.
    var busSec = mod(fixSecOfDay, 86400);
    var stopped = (bus.speed || 0) < CONFIG.parkedSpeedMps;

    // STOP ZONE — no departure without evidence. A bus inside the zone
    // around the rider's stop is AT the stop, whatever trip it matches and
    // whether that trip has started: early buses wait there, late ones
    // dwell, and a stopped bus's elapsed time says nothing about a later
    // trip. Only a fix beyond the zone can make it "gone". The core zone
    // covers projection overshoot for any bus (ground distance to the pole
    // keeps a fix a street away out of it); a stopped bus on the drawn line
    // also counts a little farther past and just before the pole.
    var targetRd = model.stops[targetIdx].routeDist;
    var pastBy = mod(fix.routeDist - targetRd, L);
    var stopPt = model.stops[targetIdx];
    var poleM = groundMeters(bus, stopPt);
    var onLine = fix.offBy < CONFIG.atStopOffMeters && !fix.guarded;
    // a bus already seen driving away beyond the core zone stays gone when
    // it stops at the next light, unless its own fixes then show it sitting
    // there as long as a hold (GPS silence after the stop is no such evidence)
    var recededAt = prev && prev.recededFrom && prev.recededFrom[targetIdx];
    var receded = typeof recededAt === 'number' && bus.when - recededAt < CONFIG.recededMs &&
      !(fix.fixHoldSec >= CONFIG.holdSec);
    // Outside service a bus parked at the stop is not coming for the rider
    // (a driver's break, the midday gap): the next published time below is.
    var serving = !trips || !trips.length || inService(trips, busSec) ||
      plausibleArrival(model, trips, targetIdx, busSec);
    // The band past the core zone is for a bus HOLDING there (longer than a
    // light): the recorded stops 180-240 m past both rider stops were all
    // departed buses waiting at the next signal.
    if (serving && (
        (!fix.guarded && pastBy < CONFIG.passedStopGraceMeters && poleM < CONFIG.passedStopGraceMeters) ||
        (onLine && stopped && L - pastBy < CONFIG.stopApproachMeters) ||
        (onLine && stopped && !receded && pastBy < CONFIG.stoppedZoneMeters && poleM < CONFIG.stoppedZoneMeters) ||
        (onLine && stopped && !receded && fix.holdSec >= CONFIG.holdSec &&
          pastBy < CONFIG.stationaryZoneMeters && poleM < CONFIG.stationaryZoneMeters))) {
      return {
        arrivalSec: nowSecOfDay, delaySec: null, method: 'at-stop', tripStartMin: null,
        justPast: pastBy >= CONFIG.passedStopGraceMeters && pastBy < L / 2,
        pastMeters: pastBy < L / 2 ? pastBy : 0, poleMeters: poleM
      };
    }

    // A bus holding well off the drawn line is in a staging lot: it runs
    // the next departure from a nearby anchor, or nothing yet.
    var recentlyInService = prev && prev.onRouteMovingAt &&
      bus.when - prev.onRouteMovingAt < CONFIG.yardQuietMs;
    var inLot = stopped && CONFIG.stagingLots.some(function (lot) {
      return groundMeters(bus, lot) < lot.radius;
    });
    if (!recentlyInService &&
        (inLot || (fix.holdSec >= CONFIG.holdSec && fix.offBy > CONFIG.yardOffMeters))) {
      var lot = stagedDeparture(model, trips, fix, bus, busSec);
      var lotResult = lot && stagedResult(model, trips, lot, targetIdx, fix, busSec);
      return lotResult || { arrivalSec: null, delaySec: null, method: 'parked', tripStartMin: null };
    }

    var matched = matchTrips(model, trips, fix.routeDist, busSec, prevTripStartMin);
    var best = matched.best;
    var prevMatch = matched.prevMatch;
    // Hysteresis: keep the trip this bus was already matched to unless the
    // challenger is decisively better (same scoring as the selection above).
    // While the bus sits still, keep its trip outright: its delay on its own
    // trip grows a second per second while a later trip's "earliness"
    // shrinks, so after a minute of dwell plain scoring hops it onto a trip
    // that hasn't started.
    if (prevMatch && best !== prevMatch &&
        Math.abs(prevMatch.delay) <= CONFIG.tripMatch.maxDelaySec &&
        (prevMatch.score <= best.score + CONFIG.tripMatch.stickySec ||
          (stopped && fix.holdSec >= CONFIG.holdFreezeSec))) {
      best = prevMatch;
    }

    // A bus holding at a loop anchor departs at the next published start
    // from that anchor. This only applies when the bus is not demonstrably
    // mid-trip (a trustworthy match that has progressed past its first leg
    // wins): a bus merely dwelling at a stop the loop passes through must
    // not be hijacked onto a much later trip anchored there.
    var trusted = best && Math.abs(best.delay) <= CONFIG.tripMatch.maxDelaySec;
    if (!trusted || best.tau.entryIdx === 0 || best.tau.entryIdx === best.trip.entries.length - 1) {
      var staged = stagedDeparture(model, trips, fix, bus, busSec);
      var stagedRes = staged && stagedResult(model, trips, staged, targetIdx, fix, busSec);
      if (stagedRes) return stagedRes;
    }

    if (trusted) {
      var trip = best.trip;
      // Schedule-position is monotone within a trip: buses do not move
      // backward along their route. When a street variant overlaps an
      // earlier passage (e.g. approaching 500 Howard via Fremont instead of
      // Steuart), the raw projection regresses by minutes — hold the last
      // known position instead, which also means the bus reads later, not
      // earlier, until real forward progress shows up.
      var tauSec = best.tau.tauSec;
      // "Hasn't started" means the clock says so AND the bus hasn't left
      // the trip's first stop. A bus already rolling along the trip ahead
      // of its published start is simply early: clamping it to the
      // published time shows an arrival after the bus has come and gone
      // (2026-07-01: left 9 min early, app said 3:21, bus came 3:16:43).
      var first = trip.entries[0], lastE = trip.entries[trip.entries.length - 1];
      var along = mod(fix.routeDist - first.routeDist, L);
      var span = mod(lastE.routeDist - first.routeDist, L);
      if (span < 1) span = L; // PM trips start and end at the same terminal
      // ...but only a bus actually SEEN at this trip's first stop has left
      // it: the off-route staging lot sits on the PM trips' path, so a bus
      // parked there pre-service merely looks "1.7 km into its trip"
      var seenAtAnchor = atAnchor(model, fix.routeDist, first.routeDist, fix.holdSec) ||
        (prev && prev.anchoredTripStartMin === trip.startMin);
      // Within the trip's FIRST leg no history is needed: a bus there is
      // either running this trip early or the previous one late — the same
      // physical bus either way — and only the clamp would tell them apart
      // (a cold open at 9:19:30 flipped to "11 min · 9:31" for a bus a
      // minute out). Deadheads and the staging lot never sit in a first leg.
      var firstLeg = trip.entries[1] ? mod(trip.entries[1].routeDist - first.routeDist, L) : 0;
      var leftAnchor = along > CONFIG.anchorPastMeters &&
        (seenAtAnchor ? along <= span : along <= firstLeg);
      var preStart = busSec < trip.startMin * 60 && !leftAnchor;
      var anchoredTrip = seenAtAnchor && busSec < trip.startMin * 60 ? trip.startMin : null;
      if (preStart) {
        // pre-start, the projection is deadhead/staging noise, not trip
        // progress — the honest trip position is the start itself
        tauSec = trip.startMin * 60;
      } else if (prev && prevTripStartMin === trip.startMin &&
          typeof prev.tauSec === 'number' && tauSec < prev.tauSec - 120) {
        tauSec = prev.tauSec;
      }
      var rawDelay = busSec - tauSec;
      // A trip cannot run ahead of its own start while the bus is still at
      // or before its first stop: that is deadheading or staging, and the
      // bus departs at the published time.
      var delay = (rawDelay < 0 && preStart) ? 0 : rawDelay;
      var parkedHold = fix.holdSec >= CONFIG.holdSec;
      var schedResult = function (arrivalSec) {
        var r = {
          arrivalSec: arrivalSec, delaySec: delay, method: 'schedule',
          tripStartMin: trip.startMin, matchedTripStartMin: trip.startMin,
          matchedTauSec: tauSec, anchoredTripStartMin: anchoredTrip
        };
        // Before its trip starts the timetable is only the latest it comes,
        // as for a staged bus: the feed's timetable is stale (departures seen
        // 9-11 min ahead of it), and once service runs it can go any time.
        var earliest = busSec + etaSeconds(model, fix.routeDist, targetIdx);
        if (preStart && inService(trips, busSec) && earliest < arrivalSec - 90) {
          r.arrivalSec = earliest;
          r.latestSec = arrivalSec;
          r.beforeRun = true;
        }
        return r;
      };
      // First entry for the target stop that is still ahead of the bus.
      var tEntry = null;
      for (var i = 0; i < trip.entries.length; i++) {
        if (!sameStop(model, trip.entries[i].idx, targetIdx)) continue;
        tEntry = trip.entries[i];
        if (i > best.tau.entryIdx) return schedResult(tEntry.min * 60 + delay);
      }
      // Bus genuinely passed the stop on this loop (per its fix-time
      // position): predict its own comeback — drive to the next trip's
      // anchor, depart at max(published start, arrival there), carry the
      // lateness to the target.
      // ...and a confirmed-parked bus never claims a slot whose departure
      // already passed, whichever old trip it happened to match: the parked
      // reading flip-flops between "late on the finished trip" and "early
      // returning on a running one", and both creep the comeback a second
      // per second while the bus sits out its layover.
      var own = nextOwnArrival(model, trips, fix, busSec, targetIdx, parkedHold);
      return comebackResult(model, trips, fix, busSec, targetIdx, nowSecOfDay, own, parkedHold, {
        matchedTripStartMin: own && parkedHold ? own.tripStartMin : trip.startMin,
        matchedTauSec: parkedHold ? null : tauSec
      });
    }

    if (trips && trips.length) {
      // No trustworthy trip match (very late, or running a trip the feed's
      // timetable doesn't list): during service the live position is the
      // answer — a bus parked at a loop anchor with no published departure
      // to stage for leaves whenever its driver does. Outside service
      // (pre-service / midday deadhead), the position would beat every
      // published arrival, so the next published trip is the answer.
      var anchor = stopped ? anchorNear(model, trips, fix.routeDist) : null;
      var legsArrival = busSec + etaSeconds(model, fix.routeDist, targetIdx);
      if (inService(trips, busSec) && plausibleArrival(model, trips, targetIdx, legsArrival)) {
        return { arrivalSec: legsArrival, delaySec: null, method: 'legs', tripStartMin: null, holding: !!anchor,
          waitingAt: anchor ? anchor.name : null };
      }
      // Between service periods (or holding for one): the next published
      // trip is the real answer.
      var sched = firstPublishedArrival(model, trips, targetIdx, nowSecOfDay + 1);
      if (sched) return { arrivalSec: sched.arrivalSec, delaySec: null, method: 'scheduled-only', tripStartMin: sched.tripStartMin };
      return null; // no service left today
    }

    // Timetable unavailable: integrate scheduled leg durations from the
    // last known position.
    return {
      arrivalSec: busSec + etaSeconds(model, fix.routeDist, targetIdx),
      delaySec: null,
      method: 'legs',
      tripStartMin: null
    };
  }

  // A STOPPED bus with no continuity behind its fix (every fresh app open,
  // or a re-resolution) can sit where passages run side by side — dwelling
  // past Berry at Mission Creek next to the return leg, or at the Fremont &
  // Howard light short of 500 Howard — and one fix can't tell which. A stopped
  // bus has no motion to disambiguate with, and schedule fit can't either
  // (holding IS being off schedule), so the rider gets the benefit of the
  // doubt: the earliest reading among the near-equal passages.
  // Returns {p, fix, contested}: contested = another passage was as near
  // (the caller must not continue from this fix's passage).
  function earliestPlausible(model, trips, fix, bus, targetIdx, nowSecOfDay, fixSecOfDay, prev) {
    var best = { p: predictBus(model, trips, fix, bus, targetIdx, nowSecOfDay, fixSecOfDay, prev), fix: fix, contested: false };
    if (!fix.alts || (bus.speed || 0) >= CONFIG.parkedSpeedMps) return best;
    var d0 = Math.sqrt(fix.alts[0].d2);
    var others = fix.alts.filter(function (c) {
      var d = Math.sqrt(c.d2);
      return c.routeDist !== fix.routeDist && d <= d0 + CONFIG.passageNoiseMeters && d <= CONFIG.offRouteMeters;
    });
    best.contested = others.length > 0;
    // already at the stop: no other passage reads sooner
    if (best.p && best.p.method === 'at-stop') return best;
    var rank = function (r) { return r && r.arrivalSec != null ? r.arrivalSec : Infinity; };
    others.forEach(function (c) {
      var alt = Object.assign({}, fix, { routeDist: c.routeDist, offBy: Math.sqrt(c.d2), offRoute: false });
      var q = predictBus(model, trips, alt, bus, targetIdx, nowSecOfDay, fixSecOfDay, prev);
      if (rank(q) < rank(best.p)) { best.p = q; best.fix = alt; }
    });
    // the reading rests on the benefit of the doubt, not on the evidence
    if (best.fix !== fix && best.p) best.p.ambiguous = true;
    return best;
  }

  // Per stop: has this bus been seen MOVING away beyond the stop's core zone
  // (and not yet far gone)? Then a stop at the next light is not "back at the
  // stop". Cleared once the bus is well past or before the stop again.
  function recededMemory(model, fix, bus, targetIdx, prev) {
    var mem = Object.assign({}, prev && prev.recededFrom);
    var past = mod(fix.routeDist - model.stops[targetIdx].routeDist, model.path.length);
    if (past >= CONFIG.passedStopGraceMeters && past < 1000 && (bus.speed || 0) >= CONFIG.parkedSpeedMps) {
      mem[targetIdx] = bus.when;
    } else if (past < CONFIG.passedStopGraceMeters || past >= 1000) {
      delete mem[targetIdx];
    }
    return mem;
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
      var prev = prevFixes && prevFixes[bus.id];
      var fix = locateBus(model, bus, prev, trips, mod(nowSecOfDay - status.ageSec, 86400));
      if (!fix || fix.offBy > CONFIG.garageMeters) return; // garage/no-fix positions predict nothing
      // Stationary-episode tracking: how long has this bus been parked?
      // Displacement is measured from where the episode STARTED, not
      // fix-over-fix — a bus crawling 30 m per ping through congestion
      // moves hundreds of meters and must never read as parked — and on the
      // ground, not along the route, so a projection that switches passages
      // (two route passages run within meters near Berry at Mission Creek)
      // can't reset a hold. A same-fix re-evaluation (render tick) carries
      // the episode unchanged.
      var holdSince = null, holdAt = null;
      if (prev && prev.when) {
        if (bus.when === prev.when) {
          holdSince = prev.holdSince || null;
          holdAt = prev.holdAt || null;
        } else if ((bus.speed || 0) < CONFIG.parkedSpeedMps) {
          // any moving fix ends an episode; parked GPS jitter reaches ~70 m
          var anchorAt = prev.holdAt || (typeof prev.lat === 'number' ? { lat: prev.lat, lng: prev.lng } : null);
          if (anchorAt && groundMeters(bus, anchorAt) < CONFIG.holdJitterMeters) {
            holdSince = prev.holdSince || prev.when;
            holdAt = anchorAt;
          }
        }
      }
      // A stopped fix starts an episode on its own, and while the last fix
      // is stopped the episode keeps accruing on the wall clock: devices go
      // quiet while parked (field gaps up to 14 min), and silence after a
      // stopped fix is the hold continuing, not missing data.
      var parkedNow = (bus.speed || 0) < CONFIG.parkedSpeedMps;
      if (!holdSince && parkedNow && bus.when) {
        holdSince = bus.when;
        holdAt = { lat: bus.lat, lng: bus.lng };
      }
      fix.holdSec = holdSince
        ? Math.max(0, ((parkedNow ? now.getTime() : bus.when) - holdSince) / 1000) : 0;
      // ...and the part of it the bus's own fixes show (no wall-clock accrual)
      fix.fixHoldSec = holdSince ? Math.max(0, (bus.when - holdSince) / 1000) : 0;
      var ep = earliestPlausible(model, trips, fix, bus, targetIdx, nowSecOfDay,
        nowSecOfDay - status.ageSec, prev);
      var p = ep.p;
      fix = ep.fix;
      if (prevFixes) {
        prevFixes[bus.id] = {
          routeDist: fix.routeDist, when: bus.when, lat: bus.lat, lng: bus.lng,
          unresolved: ep.contested,
          recededFrom: recededMemory(model, fix, bus, targetIdx, prev),
          onRouteMovingAt: fix.offBy < CONFIG.atStopOffMeters && (bus.speed || 0) >= CONFIG.parkedSpeedMps
            ? bus.when : (prev ? prev.onRouteMovingAt : null),
          regressCount: fix.regressCount,
          // keep the trip memory through transient non-matches (one noisy
          // ping must not disarm the hysteresis); the hysteresis gate
          // re-validates it against maxDelaySec every evaluation anyway
          tripStartMin: p && typeof p.matchedTripStartMin === 'number' ? p.matchedTripStartMin
            : (prev ? prev.tripStartMin : null),
          tauSec: p && typeof p.matchedTauSec === 'number' ? p.matchedTauSec
            : (prev ? prev.tauSec : null),
          holdSince: holdSince, holdAt: holdAt,
          // the pre-start trip this bus was seen staged for, kept while that
          // trip is still the bus's match (so its early departure counts)
          anchoredTripStartMin: p && p.anchoredTripStartMin != null ? p.anchoredTripStartMin
            : (prev && p && p.matchedTripStartMin === prev.anchoredTripStartMin ? prev.anchoredTripStartMin : null)
        };
      }
      if (!p) return;
      var k = legAt(model, fix.routeDist);
      if (p.method === 'parked') {
        out.push({
          bus: bus, etaSec: Infinity, etaMin: null, arrivalSec: null, delaySec: null,
          method: 'parked', tripStartMin: null, meters: distanceAlong(model, fix.routeDist, targetIdx),
          legFrom: model.stops[k - 1].name, legTo: model.stops[k].name,
          stale: status.stale, ageSec: status.ageSec, offRoute: fix.offRoute, fix: fix
        });
        return;
      }
      // a displayed arrival is never in the past — a stale fix's "due" time
      // floors to now rather than rendering a clock time that already went by
      var arrivalSec = Math.max(p.arrivalSec, nowSecOfDay);
      // a bus stopped short of the stop zone (a light, or waiting) is at
      // least a minute away — not "Now · pulling up" for as long as it sits.
      // Only while its fix is fresh: a floor on a quiet bus would tick along
      // with the clock forever; stale, it reads "due · awaiting GPS".
      var latestSec = typeof p.latestSec === 'number' ? p.latestSec : null;
      if ((bus.speed || 0) < CONFIG.parkedSpeedMps && (p.method === 'schedule' || p.method === 'legs')) {
        if (!status.stale) arrivalSec = Math.max(arrivalSec, nowSecOfDay + CONFIG.stoppedEtaFloorSec);
        // holding (not a light) ahead of its timetable: it may sit until then
        if (fix.holdSec >= CONFIG.holdSec && p.method === 'schedule' && p.delaySec < -90 && latestSec === null) {
          latestSec = p.arrivalSec - p.delaySec;
        }
      }
      var etaSec = arrivalSec - nowSecOfDay;
      out.push({
        bus: bus,
        etaSec: etaSec,
        etaMin: Math.round(etaSec / 60),
        arrivalSec: arrivalSec,
        delaySec: p.delaySec,
        method: p.method,
        holding: !!p.holding,
        holdSec: fix.holdSec,
        stopped: (bus.speed || 0) < CONFIG.parkedSpeedMps,
        justPast: !!p.justPast,
        pastMeters: p.pastMeters || 0,
        poleMeters: typeof p.poleMeters === 'number' ? p.poleMeters : null,
        ambiguous: !!p.ambiguous,
        waitingAt: p.waitingAt || null,
        beforeRun: !!p.beforeRun,
        latestSec: latestSec !== null && latestSec > arrivalSec + 90 ? latestSec : null,
        departsSec: typeof p.departsSec === 'number' ? p.departsSec : null,
        estimated: !!p.estimated,
        recentlyPassed: !!p.recentlyPassed,
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
    out.sort(function (a, b) { return (a.etaSec - b.etaSec) || 0; }); // parked rows (Infinity) last
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
    normalizeDevice: normalizeDevice,
    busStatus: busStatus,
    applyPing: applyPing,
    locateBus: locateBus,
    legAt: legAt,
    etaSeconds: etaSeconds,
    matchTrips: matchTrips,
    tripFitSec: tripFitSec,
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
    sameStop: sameStop,
    applyGeometryPatches: applyGeometryPatches,
    nextScheduled: nextScheduled,
    fmtClock: fmtClock,
    fetchLiveSite: fetchLiveSite,
    fetchDepartures: fetchDepartures
  };
});
