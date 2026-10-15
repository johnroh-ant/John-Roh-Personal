---
name: verify
description: Drive the Mission Bay shuttle tracker end-to-end — offline page simulator, scenario/regression harness, and ground-truth scoring against recorded field GPS.
---

# Verifying the shuttle tracker

Static app: `index.html` + `tracker.js` (UMD — loads in browser and Node).
No build step. All commands below run from the repo root.

## Network

The live feed (`api.gettrakk.com`) and the page's CDN libraries (`unpkg.com`,
`js.pusher.com`) may be blocked in the session's network. Everything here
works offline from the committed fixtures; live data is a bonus, never a
requirement. Do not route around a blocked host — ask the user.

## Engine checks (Node, offline-capable)

```bash
node .claude/skills/verify/harness.js        # ~85 checks; falls back to fixtures
HARNESS_OFFLINE=1 node .claude/skills/verify/harness.js   # force fixtures
node .claude/skills/verify/scenarios.js      # 23 hold scenarios, warm + cold
node .claude/skills/verify/groundtruth.js .claude/skills/verify/traces.jsonl
node .claude/skills/verify/groundtruth.js .claude/skills/verify/field-2026-10-13-am.jsonl
node .claude/skills/verify/groundtruth.js .claude/skills/verify/field-2026-10-13-pm.jsonl
node .claude/skills/verify/groundtruth.js .claude/skills/verify/field-2026-10-14-am.jsonl
node .claude/skills/verify/groundtruth.js <recording> --cold 60 --tick 0   # fresh app opens
node .claude/skills/verify/replay.js         # older stability replay (July traces)
```

- `harness.js` — scenario checks, each FIELD section encodes a real report.
- `scenarios.js` — synthetic holds before/at/past the rider's stops; exit
  code = HARD flags (false "passed"). Expected today: 39 hard, all in S2c — a
  bus that drives 200 m past the stop and only then stops reads "passed" for
  its first 150 s there (recorded stops that far past were all departed buses
  at the next light). Controls S4/S4b/S6a-d must stay at 0.
- `groundtruth.js <trace>` — replays a recording through the engine every
  fix and every 15 s tick and grades each prediction against what the bus
  actually did (Viterbi-decoded track): FALSE-DEPARTED, late/early ETA error,
  "after-bus-left" (rider would miss it). Accepts the fleet recorder's
  all-route files (filters to the TransBay route). `--tracker <path>` scores a
  modified engine copy; `--bus`, `--modes`, `--log`, `--json` narrow/dump.
  `--cold <sec>` adds a `cold-replay`: the engine's history is wiped every
  `<sec>` seconds, as when the rider opens the app (it re-resolves each bus
  from one fix). Every replay passes the GPS heading only at the app's
  ~15 s poll cadence (and on an app open's first fix): the poll carries it,
  live pings in between don't. The normal replays keep
  history from the first fix, so they never covered fresh opens: with the
  app left open FALSE-DEPARTED hard is 0 everywhere, but fresh opens every
  60 s still give 62 home-mode (500 Howard) false departures across the four
  recordings (81 before the morning clock, 165 before heading was used; 0 at
  Berry at Mission Creek).
  Ranges: a reading shown as a range whose late end reaches within 3 min of
  the actual arrival isn't "confidently early". `early-uncovered` counts the
  >3 min early readings that are not (a single time, or a range ending too
  soon); `ranges` and `ending >10min late` (late end more than 10 min after
  the bus came) show what that costs. Slow-traffic ranges build from the
  app's own history, so fresh opens don't get them.
  FALSE-DEPARTED hard excludes "unproven" rows (shown as `unproven N`): a
  next-trip reading where the decoded truth runs backward within ±2 min of
  the fix (after 500 Howard buses head to 4th St off the drawn return leg,
  and the decoder puts them on the outbound line) or the bus is within 60 m
  past the loop anchor — unless the bus then reached the stop 3+ min sooner
  than the app said. Watch that count too: a real regression could hide
  there. On the 10-13 PM recording all unproven rows are in its six 4th St
  detours (1738 15:08, 16:20, 17:57; 20024 18:52; 76084 17:46, 19:31) or at
  the terminal (1738 18:09, 20024 15:51 and 19:03); none elsewhere.
- `replay.js` — delay-sign flips / trip changes / arrival jumps. Expected:
  0/0/0 except 66065 at 2/1/0 — one is the 14:56:48 correction when it
  leaves the staging lot (re-read off the lot's passage onto its 3:10 run).
  Today's ground truth: FALSE-DEPARTED hard 0 in every warm replay of all
  four recordings.
- Field recordings: `traces.jsonl` (2026-07-01 PM, 3 buses),
  `field-2026-10-13-am.jsonl` (10:00-10:52 AM, all routes; TransBay buses
  20018, 20024, 76084) and `field-2026-10-13-pm.jsonl` (2:31-8:35 PM; 1738,
  20024, 76084; its `-departures.jsonl` has the same times as the fixture)
  and `field-2026-10-14-am.jsonl` (5:57-11:05 AM, the whole morning service;
  1738, 20024, 76084 — AM runs leave Berry & King every 20 min at :59/:19/:39,
  not the feed's 15; the engine runs the morning on that clock,
  `CONFIG.observedClock`, while the feed lists the stale times). Fixtures: `lts-fresh.json`, `dep-*.json` (image URLs
  scrubbed, so the two stop-image checks only run live).

## Page checks (offline simulator)

Headless Chromium cannot use the agent proxy. `pagesim.js` serves the real
page from a local server, fulfills the CDN libraries from npm copies,
answers the Trakk API from the fixtures with scripted buses, and mocks the
clock:

```bash
mkdir -p "$SCRATCH/pagesim" && cd "$SCRATCH/pagesim" && \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright leaflet@1.9.4 pusher-js@8.2.0
(cd /path/to/repo && nohup python3 -m http.server 8765 >/dev/null 2>&1 &)   # repo root!
PAGESIM_MODULES="$SCRATCH/pagesim/node_modules" \
  node .claude/skills/verify/pagesim.js .claude/skills/verify/scenarios/field-report.js
```

A scenario module exports `{name, start, mode, duration, readEvery,
buses(tSec) -> [{name, rd, speed, ageSec?}]}` (rd = route distance in m;
`ageSec` makes the fix stale). Output is one line per read: hero big text,
arrive line, detail, badges. `PAGE=http://localhost:8766/` points it at
another server root (e.g. a scratch copy of the app).

## Recording field data

Recording is a data-collection run the user approves: ask before starting
one unless the user asked for it. It needs the live feed, which the
"John-Roh-Personal" cloud environment reaches (the default one gets a proxy
403, and the recorder then stops with exit 1 after ~30 s).

```bash
# end time needs an explicit zone: Pacific is -07:00 until Nov 1, -08:00 after
node .claude/skills/verify/record.js /tmp/field-2026-10-14-am.jsonl 2026-10-14T11:00:00-07:00
```

Run it as a background command with a 2-hour timeout (`timeout: 7200000`;
the default is 30 min). Each run stops at the end time or after
`--max-minutes` (default 100) and prints a JSON summary; run it again with
the same arguments until the summary says `"done":true` — it resumes without
duplicating fixes. It records every route (5 s polls, one line per device per
distinct fix) and the feed's departure data every 15 min when it changed
(`<out>-departures.jsonl`, image URLs scrubbed). Score a recording against
the timetable the app saw that day with
`groundtruth.js <out>.jsonl --dep <out>-departures.jsonl`. Copy both files
into `.claude/skills/verify/` to commit them.

## Service hours

Mon–Fri only. AM ~5:59–10:46 (buses observed in service until ~10:52), PM
~14:30–20:15 PT. The feed's timetable is stale (see README Caveats).
