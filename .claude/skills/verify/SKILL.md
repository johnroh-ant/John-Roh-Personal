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
- `replay.js` — delay-sign flips / trip changes / arrival jumps. Expected:
  0/0/0 except 66065 at 2/1/2 — one is the 14:56:48 correction when it
  leaves the staging lot (re-read off the lot's passage onto its 3:10 run).
  Today's ground truth: FALSE-DEPARTED hard 0 in every replay of both
  recordings.
- Field recordings: `traces.jsonl` (2026-07-01 PM, 3 buses) and
  `field-2026-10-13-am.jsonl` (10:00-10:52 AM, all routes; TransBay buses
  20018, 20024, 76084). Fixtures: `lts-fresh.json`, `dep-*.json` (image URLs
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
