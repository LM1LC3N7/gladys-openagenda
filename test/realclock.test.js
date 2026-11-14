// -----------------------------------------------------------------------------
// The real clock (performance.now, setTimeout) sped up 3,000 times and a real
// local HTTP server: an agenda is read once per refresh interval (2 h here),
// never sooner, the key goes in its header, and nothing leaves after stop.
// Wide margins: a timer is late under load, never early.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../src/app.js';
import { API_BASE } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { AGENDA, event, page } from './fixtures/openagenda.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';

const HOUR = 60 * 60_000;
const KEY = 'oa_pk_real-clock-key-0123';

test('real clock: an agenda read once every 2 h, nothing after stop', async (t) => {
  const clock = realClock({ speed: 3_000 });
  const requests = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push({ path: u.pathname, ua: req.headers['user-agent'], key: req.headers.key });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/v2/agendas') {
      res.end(JSON.stringify({ total: 1, agendas: [AGENDA], after: null }));
      return;
    }
    const s = clock.now() + 24 * HOUR;
    res.end(JSON.stringify(page([event({ uid: 1, timings: [[s, s + HOUR]] })])));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gladys = createFakeGladys({
    selector: 'openagenda',
    config: { api_key: KEY, refresh_hours: 2 },
    calendarAccounts: [
      {
        user: { selector: 'alice', first_name: 'A', language: 'fr' },
        config: { agendas: 'testville' },
      },
    ],
  });
  const app = new App({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: (url, init) =>
      fetch(String(url).replace(API_BASE, `${base}/v2`), {
        ...init,
        signal: AbortSignal.timeout(5000),
      }),
  });
  t.after(async () => {
    await app.stop();
    clock.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const spy = spyOn(app, 'readSource', clock);
  await gladys.connect();
  await app.connected();
  const gaps = await measurePeriod(spy, { count: 3, period: 2 * HOUR, timeoutMs: 20_000 });
  assert.equal(gaps.length, 2);
  const reads = () => requests.filter((r) => r.path.endsWith('/events')).length;
  const deadline = performance.now() + 10_000;
  while (reads() < 3 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(reads(), 3, 'one read per period');
  assert.match(requests[0].ua, /^gladys-openagenda\//);
  assert.equal(requests[0].key, KEY);
  assert.ok(gladys.fake.calendarEvents.length >= 1);
  await app.stop();
  const count = requests.length;
  const timers = clock.timersSet;
  await clock.sleep(6 * HOUR);
  assert.equal(requests.length, count, 'no request after stop');
  assert.equal(clock.timersSet, timers, 'no timer after stop');
});
