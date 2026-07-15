---
name: verify
description: Drive the Mission Bay shuttle tracker end-to-end — local server, Playwright with Node-fulfilled network, live-data harness, and field-trace replay.
---

# Verifying the shuttle tracker

Static app: `index.html` + `tracker.js` (UMD — loads in browser and Node).
No build step.

## Launch

```bash
(nohup python3 -m http.server 8765 >/dev/null 2>&1 &)   # MUST run from repo root
```

## Browser driving — the one big gotcha

Headless Chromium CANNOT reach HTTPS through this container's agent proxy
(all CONNECTs reset; curl/Node work fine). Intercept and fulfill via Node:

```js
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
await ctx.route(/^https:\/\//, async route => { /* fetch() in Node, route.fulfill(...) */ });
```

- Pusher falls back to HTTPS long-polling under this interception (its
  sockjs POSTs 404 — harness artifact, ignore).
- To simulate buses: rewrite the `/live-tracking-site?` JSON in the route
  handler (set devices' `deviceUpdate` {latitude, longitude, speed, when}).
  With `page.clock.install`, compute `when` from the MOCKED epoch, not
  real `Date.now()` (test-side), or the bus reads as dead.
- Time-of-day states (midday gap, weekend, Friday night, morning rush):
  `page.clock.install({ time: new Date('...T08:35:00-07:00') })`.

## Engine validation (Node, live API)

```bash
NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node .claude/skills/verify/harness.js
NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node .claude/skills/verify/replay.js
```

`harness.js` fetches live Trakk data and runs ~60 scenario checks
(staged buses, stale GPS, passed-stop, hysteresis, departed-bus,
malformed feeds). `replay.js` replays the recorded field GPS traces
(`traces.jsonl`, 2026-07-01 PM service, with its JSON fixtures beside
it) and reports delay-sign flips / trip flips / arrival jumps — expect 0/0/0 for buses on the
standard loop, plus two benign trip-boundary corrections for 66065.

## Service hours (for choosing live vs mocked checks)

Mon–Fri only. AM ~5:59–10:12, PM ~14:30–19:51 PT. Outside those, buses
are absent/parked — use clock mocking.
