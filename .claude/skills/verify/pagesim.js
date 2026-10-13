// Offline page driver for the shuttle tracker.
//
// Serves the real index.html (local http.server on :8765 from the repo root),
// fulfills the CDN libraries from node_modules, answers the Trakk API from the
// committed fixtures with scripted buses injected, and mocks the page clock.
//
// Usage: node pagesim.js <scenario.js>
// A scenario module exports:
//   { name, start: '2026-10-13T09:19:00-07:00', mode: 'work'|'home',
//     duration: seconds, readEvery: seconds,
//     buses(tSec) -> [{ name, rd, speed, ageSec? }] }   // rd = route distance (m)
const path = require('path');
const fs = require('fs');
const { chromium } = require(require.resolve('playwright', { paths: [process.env.PAGESIM_MODULES || path.join(__dirname, 'node_modules')] }));
const REPO = path.join(__dirname, '..', '..', '..');
const V = path.join(REPO, '.claude/skills/verify');
const T = require(path.join(REPO, 'tracker.js'));
// playwright, leaflet@1.9.4 and pusher-js@8.2.0 installed in a scratch dir (see SKILL.md)
const NM = process.env.PAGESIM_MODULES || path.join(__dirname, 'node_modules');

const scenario = require(path.resolve(process.argv[2]));
const site = JSON.parse(fs.readFileSync(path.join(V, 'lts-fresh.json')));
const dep = fs.readFileSync(path.join(V, 'dep-6467db5ea59bbb100741d7b7.json'));
const model = T.buildLoopModel(site);

function pointAt(dist) {
  const p = model.path, L = p.length;
  const d = T.mod(dist, L);
  for (let i = 0; i + 1 < p.verts.length; i++) {
    if (p.cum[i + 1] >= d) {
      const f = (d - p.cum[i]) / (p.cum[i + 1] - p.cum[i] || 1);
      const a = p.verts[i], b = p.verts[i + 1];
      return { lat: a.lat + f * (b.lat - a.lat), lng: a.lng + f * (b.lng - a.lng) };
    }
  }
  const v = p.verts[p.verts.length - 1];
  return { lat: v.lat, lng: v.lng };
}

(async () => {
  const MOCK0 = new Date(scenario.start).getTime();
  let tSec = 0;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const errors = [];
  await ctx.route(/^https?:\/\//, async route => {
    const url = route.request().url();
    if (url.startsWith('http://localhost:87')) return route.continue();
    const ok = (body, type) => route.fulfill({ status: 200, contentType: type, body,
      headers: { 'access-control-allow-origin': '*' } });
    if (url.includes('unpkg.com/leaflet@1.9.4/dist/leaflet.css')) return ok(fs.readFileSync(path.join(NM, 'leaflet/dist/leaflet.css')), 'text/css');
    if (url.includes('unpkg.com/leaflet@1.9.4/dist/leaflet.js')) return ok(fs.readFileSync(path.join(NM, 'leaflet/dist/leaflet.js')), 'application/javascript');
    if (url.includes('js.pusher.com')) return ok(fs.readFileSync(path.join(NM, 'pusher-js/dist/web/pusher.min.js')), 'application/javascript');
    if (url.includes('fetch-run-departure-data')) return ok(dep, 'application/json');
    if (url.includes('/live-tracking-site?')) {
      const j = JSON.parse(JSON.stringify(site));
      (j.liveTrackingSite.devices || []).forEach(d => { d.online = false; d.showOnMap = false; });
      const now = MOCK0 + tSec * 1000;
      const sim = scenario.buses(tSec).map(b => {
        const pt = b.lat ? b : pointAt(b.rd);
        return {
          id: 'sim-' + b.name, online: true, showOnMap: true, route: T.CONFIG.routeId,
          settings: { nickname: b.name },
          deviceUpdate: { latitude: pt.lat, longitude: pt.lng, speed: b.speed, when: now - (b.ageSec || 0) * 1000 },
        };
      });
      j.liveTrackingSite.devices = (j.liveTrackingSite.devices || []).concat(sim);
      return ok(JSON.stringify(j), 'application/json');
    }
    return route.abort(); // tiles, sockets, anything else: offline
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: new Date(MOCK0) });
  await page.goto(process.env.PAGE || 'http://localhost:8765/', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  if (scenario.mode) {
    await page.click(scenario.mode === 'home' ? '#modeHome' : '#modeWork');
    await page.waitForTimeout(800);
  }
  const text = async sel => ((await page.$(sel)) ? (await page.textContent(sel)).replace(/\s+/g, ' ').trim() : '');
  const rows = [];
  for (;;) {
    const clock = new Date(MOCK0 + tSec * 1000).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    const r = { t: tSec, clock, big: await text('#heroBig'), arrive: await text('#heroArrive'),
      detail: await text('#heroDetail'), badges: await text('#heroBadges') };
    rows.push(r);
    console.log(`${clock} | ${r.big.padEnd(8)} | ${r.arrive.slice(0, 44).padEnd(44)} | ${r.detail.slice(0, 70)} | ${r.badges}`);
    if (process.env.PAGESIM_ROWS) console.log('           rows: ' + (await text('#rows')));
    if (tSec >= scenario.duration) break;
    tSec += scenario.readEvery;
    await page.clock.fastForward(scenario.readEvery * 1000);
    await page.click('#refreshBtn').catch(() => {});
    await page.waitForTimeout(900);
  }
  if (errors.length) console.log('PAGE ERRORS:', errors.join(' | '));
  if (scenario.screenshot) await page.screenshot({ path: scenario.screenshot });
  if (process.env.PAGESIM_OUT) fs.writeFileSync(path.join(process.env.PAGESIM_OUT, 'pagesim-' + (scenario.name || 'run') + '.json'), JSON.stringify(rows, null, 1));
  await browser.close();
})();
