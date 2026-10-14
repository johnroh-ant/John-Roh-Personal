# Mission Bay Shuttle Tracker

A single-page web app that answers one question: **how far is the
TransBay/Caltrain Mission Bay shuttle from my stop right now?**

- **Leaving work** → pickup at **500 Howard St**
- **Going to work** → pickup at **Berry at Mission Creek**

It uses the same live data source as the official
[Mission Bay TMA real-time predictions map](https://www.missionbaytma.org/real-time-predictions-map/)
— not Google Maps — so the predictions reflect where the buses actually are.

## What you see

- A big minute-level ETA for the soonest bus to your selected stop, with its
  arrival clock time and how early/late it is running vs the timetable.
- Every other live bus on the route, where it is ("between Mission/Spear and
  500 Howard"), and when it would reach your stop.
- A live map (Leaflet/OpenStreetMap) with the route, all stops, your pickup
  stop highlighted, and bus positions that move in real time.
- The next published timetable times at your stop, and a photo of the stop.
- Sensible answers outside service hours: midday break, after the last run,
  and weekends (the route runs Mon–Fri).

The page picks a default direction by time of day (mornings → going to work,
afternoons → leaving work); tap the other button to switch. It is
mobile-first and installable to the home screen (PWA manifest + icons).

## How it works

The official map embeds a tracking app by **Trakk** (`mytrakk.com` /
`api.gettrakk.com`). This page talks to that backend directly using the
public site token from the embed:

| Data | Source |
| --- | --- |
| Routes, stops, loop polyline, live bus positions | `GET /v1/live-tracking-site?version=1` (headers `tr-org-id`, `tr-org-token`) |
| Full daily timetable (29 loops, per-stop times) | `GET /v1/live-tracking-site/fetch-run-departure-data` |
| Second-by-second bus pings | Pusher channel per device, event `ping_update` |

Server-side ETAs are disabled for this Trakk site, so predictions are
computed in `tracker.js` using **schedule adherence**: each bus is projected
onto the route loop, matched to the timetable trip it is currently running,
and its measured earliness/lateness is applied to the published time at your
stop. When the timetable can't explain a bus — it is far behind, or running
a trip the timetable doesn't list (see Caveats) — the live position, driven
forward at Trakk's per-leg pace, is the answer during service hours.

All schedule reasoning is evaluated **as of the bus's last GPS fix**, never
wall-clock time: when a tracker goes quiet, elapsed time doesn't count
against the bus, so the app can never claim a shuttle "already left" without
a fresh position actually past the stop. A quiet bus reads as "Due —
awaiting GPS" with its last-seen position and age. Devices go quiet while
parked (gaps of up to 14 minutes were recorded during layovers), so a bus
whose last fix was stopped is kept for 20 minutes instead of 10, and the
silence counts as the hold continuing. Polling speeds up to
every 15 s (from 45 s) whenever a bus is within 12 minutes or its pings have
gone silent, and the Pusher socket uses tight activity timeouts so a dead
connection is detected within seconds.

Rules derived from recorded field GPS (July 1 and October 13, 2026):

- **No departure without evidence** — a bus within 120 m past your stop (or
  stopped up to 250 m past it, or just before it) is *at your stop*,
  whatever trip it matches, whether that trip has started, and however long
  it waits; only a fix beyond that zone can make it "gone". Early buses
  wait at the stop and late ones dwell, and neither is evidence of leaving.
  The hero says **Here** and never promises a departure time: buses don't
  wait for the clock at your stops (0 of 25 recorded en-route stops left
  within 90 s of their timetable time). This holds during service only — a
  bus parked at the stop midday or after the last run gets the next
  published time — and a bus already seen driving away stays gone when it
  stops at the next light, even if its GPS then goes quiet.
- **Early is early once a bus has left its first stop** — the timetable's
  "a trip can't run ahead of its start" clamp only applies while the bus is
  still at or before the trip's first stop. A bus already rolling toward
  your stop ahead of its slot is shown at its physical arrival (the October
  13 report: "11 min · 9:31" for a bus a minute away). A bus waiting at the
  first stop shows a range, its earliest possible arrival to the timetable
  time ("2–13 min · waiting at Berry & King"), because departures there were
  seen up to 11 minutes ahead of the timetable.
- **Waiting is not drifting** — while a bus sits still it keeps its trip
  match (its "lateness" on its own trip grows a second per second and would
  otherwise hand it to a later trip that hasn't started), GPS wobble while
  parked doesn't count as moving backward, and a stopped bus with no history
  (every fresh app open) gets the earliest reading among the passages it
  could be on — near Berry at Mission Creek and Fremont & Howard two route
  passages run within meters of each other. That reading is labeled
  ("can't tell yet which way it is headed") and re-checked on every fix
  until the bus moves; only passages within GPS noise (20 m) of the nearest
  count, so a bus dwelling at 4th at Library isn't read as at Berry.
- **Trip-match hysteresis** — a bus ~half a headway late scores almost the
  same as "early on the next trip"; the matched trip is kept until a
  challenger wins decisively, so the early/late reading can't flip-flop.
- **Pre-start clamp** — a bus deadheading toward the terminal (or parked in
  the staging lot, which sits on the PM trips' path) before its trip's
  departure isn't read as "running early" from where it happens to be:
  until it is seen leaving the trip's first stop, the trip's published time
  is the *latest* it comes. During service the hero shows a range from the
  earliest it could physically get to your stop (a bus leaving the lot
  before its 3:10 PM trip reached Berry at 3:16:47; the timetable said 3:21).
- **Comebacks are bus-centric** — a bus that passed your stop predicts its
  own next service: drive (at timetable pace) to the next trip's first
  stop, depart at max(published start, arrival there), and carry that
  lateness to your stop. A bus running 8 minutes behind serves the "8:41"
  slot at 8:49 — published times alone would skip that visit and report
  the following one.
- **Layover holds are recognized** — after the morning peak, headways
  stretch from 15 to ~25 minutes and buses wait out the difference parked
  near the yard. A bus stationary past a couple of light cycles stops
  being read as "driving, ever later" (which crept the ETA a second per
  second); it pins to its next published departure, labeled "holding".
  Only where buses lay over (past the last timed stop before a run's first
  stop): a bus stuck in traffic mid-loop still makes the run it is late
  for (stopped 2.5 minutes in traffic 2 km short of the terminal, a bus
  read as "7:33 PM, holding" at Berry; it came at 7:12). A bus laying over
  at the stop that ends its run (PM runs end at the terminal they start
  from) is staged like one waiting at a first stop: a range up to its next
  timetabled departure, not a pin to it (one parked 20 m short of Nektar
  read "holding · 4:41" at Berry and was there at 4:28).
- **Wrong-street guard** — leaving Berry at Mission Creek buses drive 50–200 m
  off the drawn line, closer to the return leg than their own; a projection
  that would jump kilometers ahead in seconds keeps the bus on its own
  passage instead (this told 500 Howard riders a bus 20 minutes away had
  "already passed"). Leaving 500 Howard, buses often head west to 4th St
  instead of following the drawn return leg, up to ~560 m off it, crossing
  the outbound line on 3rd St; read as on that line, a bus heading for the
  terminal was "next run, 7:41 PM" at Berry, where it arrived at 7:12. A bus
  tracked along its route keeps its own passage up to 600 m off it, until it
  is seen driving 50 m along another one (parked GPS jitter doesn't count),
  and one GPS spike ahead while it waits at a stop doesn't move it off the
  stop.
- **Parked off-route is not in service** — a bus holding in the staging lot
  (~100 m off the line near Owens St) is listed as parked, never given a
  countdown, unless it drove the route in the last 10 minutes.
- **Self-crossing continuity** — the route crosses itself at Fremont &
  Howard ~6 scheduled minutes apart; projection follows the passage
  consistent with the bus's recent motion rather than whichever line is
  momentarily nearest, and re-anchors when the bus genuinely jumps (late
  buses sometimes shortcut from Fremont straight onto Howard, skipping the
  Financial District sub-loop).

The drawn route was verified against those traces: buses follow it within
~100 m over the full loop (the larger excursions in the data are pre-service
deadheading and the discretionary Fremont→Howard shortcut above).
`CONFIG.geometryPatches` in `tracker.js` can splice corrected street
geometry into the drawn line if the TMA ever changes routing without
updating Trakk.

The API allows cross-origin requests (`Access-Control-Allow-Origin: *`),
so the page is fully static — no server or build step.

## Files

- `index.html` — UI, map, live updates (adaptive 15–45 s polling + Pusher pushes)
- `tracker.js` — data fetching, geometry, and prediction engine
  (also loadable from Node for testing)
- `manifest.webmanifest`, `icons/` — PWA install support

## Run it

Any static host works.

- **GitHub Pages**: Settings → Pages → deploy from branch → `main` / root.
  The page will be at `https://<user>.github.io/<repo>/`.
- **Locally**: `python3 -m http.server` in the repo and open
  `http://localhost:8000` (opening `index.html` directly also works).

Open it on your phone, add it to your home screen, and "pinging" the app is
just opening it — it fetches fresh data on every open and stays live while
visible.

## Caveats

- **The feed's timetable looks out of date.** Trakk's departure data (last
  updated November 2024 for the PM run) still lists the October 2024 times,
  while the TMA has since published newer timetables. On October 13, 2026 buses
  served Berry at Mission Creek at 10:02 and 10:24 and 500 Howard at 10:33 and
  ~10:52 — up to 40 minutes after the last AM visits the feed lists — and
  terminal departures ran 9–11 minutes ahead of it. The app therefore trusts
  live positions over the timetable: estimates are shown up to 45 minutes
  past a listed visit, and timetable times are labeled as such.

- Unofficial personal tool; the org token comes from the TMA's public embed
  and could change if they re-publish their map. If the page stops working,
  grab the new `customerToken`/`customerId` from the iframe on the official
  predictions page and update `CONFIG` in `tracker.js`.
- Trakk's drawn polyline simplifies a few blocks of the downtown loop; a bus
  on one of those blocks is flagged "off usual route — approximate".
