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
stop. A bus staged at the loop terminal is assumed to depart on schedule.
If the timetable can't be fetched, it falls back to integrating Trakk's
per-leg scheduled durations from the bus's live position.

The API allows cross-origin requests (`Access-Control-Allow-Origin: *`),
so the page is fully static — no server or build step.

## Files

- `index.html` — UI, map, live updates (polling every 45 s + Pusher pushes)
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

- Unofficial personal tool; the org token comes from the TMA's public embed
  and could change if they re-publish their map. If the page stops working,
  grab the new `customerToken`/`customerId` from the iframe on the official
  predictions page and update `CONFIG` in `tracker.js`.
- Trakk's drawn polyline simplifies a few blocks of the downtown loop; a bus
  on one of those blocks is flagged "off usual route — approximate".
