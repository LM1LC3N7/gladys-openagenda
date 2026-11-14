// -----------------------------------------------------------------------------
// The app against the fake Gladys of the SDK, a scripted OpenAgenda API and a
// virtual clock that moves at every read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { event, page } from './fixtures/openagenda.js';
import {
  DAY,
  HOUR,
  KEY,
  MINUTE,
  NOW,
  SECOND,
  account,
  json,
  setup,
  teardown,
} from './helpers/app.js';

const start = async (t, options) => {
  const env = await setup(options);
  t.after(() => teardown(env));
  return env;
};
const statusText = (env) => env.status()?.message?.en ?? '';

test('an agenda followed by link: named, read once, its occurrences in a private calendar', async (t) => {
  const env = await start(t);
  assert.equal(env.source.count('agendas'), 1);
  assert.equal(env.source.count('events'), 1);
  const [cal] = env.gladys.fake.calendars;
  assert.equal(cal.external_id, env.calId());
  assert.equal(cal.name, 'Agenda de Testville');
  assert.equal(cal.shared, false);
  assert.match(cal.description, /Licence Ouverte v2\.0 \(Etalab\)/);
  assert.match(cal.description, /Ville de Testville/);
  const events = env.events();
  assert.equal(events.length, 4, 'one concert, an exhibition on three days');
  for (const e of events) {
    assert.match(e.external_id, /^ext:openagenda:alice:a12345678-50[12]-\d+$/);
    assert.match(
      e.description,
      /Source : Ville de Testville via OpenAgenda, licence Licence Ouverte/,
    );
  }
  const concert = events.find((e) => e.name === 'Concert de jazz');
  // 20:00+0100 is 19:00 UTC.
  assert.equal(
    concert.start,
    new Date(Math.floor(NOW / DAY) * DAY + DAY + 19 * HOUR).toISOString(),
  );
  assert.equal(env.status().connected, true);
  // The key in its header only, the module's User-Agent, never a redirect.
  for (const r of env.source.requests) {
    assert.equal(r.headers.key, KEY);
    assert.match(
      r.headers['User-Agent'],
      /^gladys-openagenda\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-openagenda\)$/,
    );
    assert.ok(!r.url.includes(KEY), 'never in the URL');
    assert.equal(r.init.redirect, 'error');
  }
  const req = env.source.requests.find((r) => r.kind === 'events');
  assert.equal(req.u.searchParams.get('monolingual'), 'fr');
  assert.equal(req.u.searchParams.get('sort'), 'timings.asc');
  assert.ok(req.u.searchParams.getAll('includeFields[]').includes('rights'));
});

test('read once per interval, never sooner: reconnection and restart republish from /data', async (t) => {
  const store = createMemoryStore();
  const env = await start(t, { store });
  assert.equal(env.source.count('events'), 1);
  await env.wait(5 * HOUR);
  assert.equal(env.source.count('events'), 1, 'not before 6 h');
  await env.wait(HOUR + MINUTE);
  assert.equal(env.source.count('events'), 2, 'again after 6 h');
  // A restart an hour later: nothing read, the calendar republished from /data.
  await env.app.stop();
  env.gladys.fake.calendarEvents = [];
  const again = await setup({ store, now: env.clock.now() + HOUR });
  t.after(() => teardown(again));
  assert.equal(again.source.count('events'), 0, 'the attempt was in /data');
  assert.equal(again.source.count('agendas'), 0, 'names are kept a day');
  assert.equal(again.events().length, 4, 'republished from the last read');
  await again.wait(4 * HOUR + 30 * MINUTE);
  assert.equal(again.source.count('events'), 0);
  await again.wait(HOUR);
  assert.equal(again.source.count('events'), 1);
});

test('a read that fails half-way pushes nothing and keeps the last one; retried 5 min later', async (t) => {
  const env = await start(t);
  const before = env
    .events()
    .map((e) => e.external_id)
    .sort();
  let n = 0;
  env.source.events = (r) => {
    n += 1;
    if (!r.u.searchParams.has('after[]'))
      return page([event({ uid: 900, timings: [[NOW + DAY, NOW + DAY + HOUR]] })], ['x1']);
    return 'timeout';
  };
  await env.wait(6 * HOUR + SECOND);
  assert.equal(n, 2);
  assert.deepEqual(
    env
      .events()
      .map((e) => e.external_id)
      .sort(),
    before,
    'nothing pruned',
  );
  assert.equal(env.status().connected, false);
  assert.match(statusText(env), /1 in error \(no answer in time\)/);
  env.source.events = undefined;
  await env.wait(4 * MINUTE);
  assert.equal(n, 2);
  assert.equal(env.source.count('events'), 3);
  await env.wait(2 * MINUTE);
  assert.equal(env.source.count('events'), 4);
  assert.equal(env.status().connected, true);
});

test('an event gone from the agenda is pruned; cancelled and postponed ones left out, full ones marked', async (t) => {
  const env = await start(t);
  const day = Math.floor(NOW / DAY) * DAY;
  env.source.eventList = [
    event({
      uid: 501,
      title: 'Concert de jazz',
      timings: [[day + DAY + 19 * HOUR, day + DAY + 21 * HOUR]],
      status: 5,
    }),
    event({ uid: 503, title: 'Annulé', timings: [[day + DAY, day + DAY + HOUR]], status: 6 }),
    event({ uid: 504, title: 'Reporté', timings: [[day + DAY, day + DAY + HOUR]], status: 4 }),
    event({
      uid: 505,
      title: 'Webinaire',
      timings: [[day + DAY, day + DAY + HOUR]],
      attendanceMode: 2,
      status: 3,
    }),
  ];
  await env.wait(6 * HOUR + MINUTE);
  const names = env
    .events()
    .map((e) => e.name)
    .sort();
  assert.deepEqual(names, ['Complet : Concert de jazz', 'En ligne : Webinaire']);
  assert.equal(env.events().find((e) => e.name.startsWith('En ligne')).location, 'En ligne');
});

test('an English user reads the English texts; two users alike share one read', async (t) => {
  const env = await start(t, {
    accounts: [
      account('alice', 'testville'),
      account('bob', '12345678', { language: 'en' }),
      account('carol', 'testville'),
    ],
  });
  // Alice and Carol share the French read; Bob has his own (English).
  const reads = env.source.requests.filter((r) => r.kind === 'events');
  assert.deepEqual(reads.map((r) => r.u.searchParams.get('monolingual')).sort(), ['en', 'fr']);
  assert.equal(env.events('alice').length, 4);
  assert.equal(env.events('carol').length, 4);
  const bob = env.events('bob');
  assert.equal(bob.length, 4);
  assert.match(
    bob[0].description,
    /^About .* — Source: Ville de Testville via OpenAgenda, licence/,
  );
  assert.ok(bob.every((e) => e.external_id.startsWith('ext:openagenda:bob:')));
});

test('a city filter is sent as adminLevel4 and names the calendar', async (t) => {
  const env = await start(t, { accounts: [account('alice', 'testville', { city: 'Rennes' })] });
  const req = env.source.requests.find((r) => r.kind === 'events');
  assert.equal(req.u.searchParams.get('adminLevel4'), 'Rennes');
  assert.equal(env.gladys.fake.calendars[0].name, 'Agenda de Testville (Rennes)');
});

test('more than 500 occurrences: disjoint sub-windows, ≤ 500 per request, all kept, none lost', async (t) => {
  const day = Math.floor(NOW / DAY) * DAY;
  const many = [];
  for (let k = 0; k < 1200; k += 1) {
    // Overlapping 3-hour slots every hour: many straddle the boundaries.
    const s = day + DAY + k * HOUR;
    many.push(event({ uid: 10_000 + k, timings: [[s, s + 3 * HOUR]] }));
  }
  const env = await setup({
    config: { api_key: KEY, max_events: 2000, horizon_days: 90 },
    start: false,
  });
  t.after(() => teardown(env));
  env.source.eventList = many;
  await env.gladys.connect();
  await env.wait(60 * SECOND);
  const pushes = env.gladys.fake.publishedCalendarEvents;
  assert.ok(pushes.length >= 3, `${pushes.length} requests`);
  for (const p of pushes) assert.ok(p.events.length <= 500);
  for (let i = 1; i < pushes.length; i += 1)
    assert.equal(pushes[i].window.from, pushes[i - 1].window.to);
  assert.equal(pushes[0].window.from, '2000-01-01T00:00:00.000Z');
  assert.equal(pushes.at(-1).window.to, '2100-01-01T00:00:00.000Z');
  assert.equal(env.events().length, 1200);
});

test('the time slots are capped (the soonest kept) and the calendar says so', async (t) => {
  const day = Math.floor(NOW / DAY) * DAY;
  const env = await setup({ config: { api_key: KEY, max_events: 50 }, start: false });
  t.after(() => teardown(env));
  env.source.eventList = Array.from({ length: 80 }, (_, k) =>
    event({ uid: 20_000 + k, timings: [[day + DAY + k * HOUR, day + DAY + k * HOUR + HOUR]] }),
  );
  await env.gladys.connect();
  await env.wait(5 * SECOND);
  assert.equal(env.events().length, 50);
  const latest = Math.max(...env.events().map((e) => Date.parse(e.start)));
  assert.equal(latest, day + DAY + 49 * HOUR);
  assert.match(env.gladys.fake.calendars[0].description, /Limité aux 50 premiers créneaux/);
});

test('pages follow the after cursor and stop at the end', async (t) => {
  const env = await setup({ start: false });
  t.after(() => teardown(env));
  const day = Math.floor(NOW / DAY) * DAY;
  env.source.events = (r) => {
    const after = r.u.searchParams.getAll('after[]');
    if (after.length === 0)
      return page([event({ uid: 1, timings: [[day + DAY, day + DAY + HOUR]] })], ['0', 'c1']);
    if (after[1] === 'c1')
      return page(
        [event({ uid: 2, timings: [[day + 2 * DAY, day + 2 * DAY + HOUR]] })],
        ['0', 'c2'],
      );
    return page([], null);
  };
  await env.gladys.connect();
  await env.wait(20 * SECOND);
  assert.equal(env.source.count('events'), 3);
  assert.equal(env.events().length, 2);
});

test('a 429 pauses every request for its Retry-After, kept in /data across a restart', async (t) => {
  const store = createMemoryStore();
  const env = await start(t, { store });
  env.source.events = () => json({ message: 'slow down' }, 429, { 'retry-after': '7200' });
  await env.wait(6 * HOUR + MINUTE);
  assert.equal(env.source.count('events'), 2);
  assert.match(statusText(env), /paused until .* \(OpenAgenda asked to slow down \(429\)\)/);
  assert.equal(env.status().connected, false);
  await env.app.stop();
  const again = await setup({ store, now: env.clock.now() + 30 * MINUTE });
  t.after(() => teardown(again));
  again.source.events = undefined;
  await again.wait(HOUR);
  assert.equal(again.source.count('events'), 0, 'still paused after the restart');
  assert.equal(
    await again.gladys.fake.action('test_key').then((a) => /Paused until/.test(a.data.message.en)),
    true,
  );
  await again.wait(31 * MINUTE);
  assert.equal(again.source.count('events'), 1);
  assert.equal(again.status().connected, true);
});

test('a 5xx pauses 10 minutes, then 20: a growing back-off, never a storm', async (t) => {
  const env = await start(t);
  env.source.events = () => new Response('oops', { status: 503 });
  await env.wait(6 * HOUR + SECOND);
  assert.equal(env.source.count('events'), 2);
  await env.wait(9 * MINUTE);
  assert.equal(env.source.count('events'), 2);
  await env.wait(2 * MINUTE);
  assert.equal(env.source.count('events'), 3);
  await env.wait(18 * MINUTE);
  assert.equal(env.source.count('events'), 3);
  await env.wait(2 * MINUTE);
  assert.equal(env.source.count('events'), 4);
});

test('a 403 on the agendas list refuses the key: nothing more, even after a restart; a new key is tried', async (t) => {
  const store = createMemoryStore();
  const env = await setup({ store, start: false });
  t.after(() => teardown(env));
  env.source.agendas = () => json({ message: 'could not find user or agenda matching key' }, 403);
  await env.gladys.connect();
  await env.wait(5 * SECOND);
  assert.equal(env.source.count(), 1);
  assert.match(statusText(env), /OpenAgenda refused the key/);
  await env.wait(2 * DAY);
  assert.equal(env.source.count(), 1, 'never sent again by itself');
  assert.equal(JSON.stringify(store.data).includes(KEY), false, 'the key is not in /data');
  assert.ok(store.data.refused && Number.isInteger(store.data.refused.tag));
  await env.app.stop();
  const again = await setup({ store, start: true });
  t.after(() => teardown(again));
  assert.equal(again.source.count(), 0, 'the tag in /data holds the same key back');
  await again.gladys.fake.configUpdated({ api_key: 'oa_pk_another-key-0123456789' });
  await again.wait(5 * SECOND);
  assert.ok(again.source.count() >= 2, 'a new key is always tried');
  assert.equal(again.status().connected, true);
});

test('a 403 on one agenda is that agenda, never the key', async (t) => {
  const env = await setup({
    accounts: [account('alice', 'testville, 999')],
    start: false,
  });
  t.after(() => teardown(env));
  env.source.events = (r) => (r.uid === 999 ? json({ message: 'private' }, 403) : undefined);
  await env.gladys.connect();
  await env.wait(10 * SECOND);
  assert.equal(env.app.keyRefused(), false);
  assert.equal(env.events().length, 4, 'the readable agenda is fed');
  assert.match(statusText(env), /1 in error \(agenda not readable with this key/);
  // Every agenda refused: the key itself is checked on its own route (200 here).
  env.source.events = () => json({ message: 'private' }, 403);
  await env.wait(6 * HOUR + MINUTE);
  assert.equal(env.app.keyRefused(), false);
});

test('a secret key is refused before anything is sent', async (t) => {
  const env = await start(t, { config: { api_key: 'oa_sk_0123456789abcdef0123' } });
  assert.equal(env.source.count(), 0);
  assert.match(statusText(env), /SECRET key/);
  assert.equal(env.status().connected, false);
  const ack = await env.gladys.fake.action('test_key');
  assert.match(ack.data.message.en, /SECRET key/);
  assert.equal(env.source.count(), 0);
});

test('the test button: too soon, refused then lifted by a success, licences listed', async (t) => {
  const env = await start(t);
  let ack = await env.gladys.fake.action('test_key');
  assert.match(
    ack.data.message.en,
    /Key accepted by OpenAgenda\. Agendas and data licences : Agenda de Testville \(Licence Ouverte v2\.0 \(Etalab\)\)/,
  );
  ack = await env.gladys.fake.action('test_key');
  assert.match(ack.data.message.en, /try again in 1\d s|try again in \d s/);
  env.source.agendas = () => json({}, 401);
  await env.wait(11 * SECOND);
  ack = await env.gladys.fake.action('test_key');
  assert.match(ack.data.message.en, /OpenAgenda refused the key/);
  assert.equal(env.app.keyRefused(), true);
  env.source.agendas = undefined;
  await env.wait(11 * SECOND);
  ack = await env.gladys.fake.action('test_key');
  assert.match(ack.data.message.en, /Key accepted/);
  assert.equal(env.app.keyRefused(), false);
  assert.equal(env.status().connected, true);
});

test('a calendar turned off is skipped; turned back on, it is refilled without asking OpenAgenda', async (t) => {
  const env = await start(t);
  const cal = env.gladys.fake.calendars[0];
  cal.sync = false;
  env.gladys.fake.calendarEvents = [];
  await env.gladys.fake.calendarAccountUpdated('alice');
  await env.wait(SECOND);
  await env.wait(6 * HOUR + MINUTE);
  assert.equal(env.events().length, 0, 'nothing pushed to a calendar turned off');
  const reads = env.source.count('events');
  cal.sync = true;
  await env.gladys.fake.calendarAccountUpdated('alice');
  await env.wait(SECOND);
  assert.equal(env.events().length, 4);
  assert.equal(env.source.count('events'), reads, 'from the last read');
});

test('an agenda removed from the account deletes its calendar; a new one is read at once', async (t) => {
  const env = await start(t);
  env.source.agendaList.push({ uid: 777, slug: 'autre', title: 'Autre agenda' });
  env.gladys.fake.calendarAccounts = [account('alice', 'autre')];
  await env.gladys.fake.calendarAccountUpdated('alice');
  await env.wait(10 * SECOND);
  assert.deepEqual(env.gladys.fake.deletedCalendars, [env.calId()]);
  assert.deepEqual(
    env.gladys.fake.calendars.map((c) => c.name),
    ['Autre agenda'],
  );
  assert.equal(env.source.requests.filter((r) => r.uid === 777).length, 1);
});

test('an unknown slug is said, never echoed; nothing deleted while a slug is unknown', async (t) => {
  const env = await start(t);
  env.gladys.fake.calendarAccounts = [
    account('alice', 'testville, nope-xyz, https://evil.example/x'),
  ];
  await env.gladys.fake.calendarAccountUpdated('alice');
  await env.wait(10 * SECOND);
  const text = statusText(env);
  assert.match(text, /an entry is not an agenda/);
  assert.match(text, /agenda not found on OpenAgenda/);
  assert.ok(!text.includes('nope-xyz') && !text.includes('evil'));
  assert.equal(env.gladys.fake.deletedCalendars.length, 0);
});

test('Gladys 429 on a write: waited out, written again; never more than 25 writes in a minute', async (t) => {
  const accounts = Array.from({ length: 20 }, (_, i) => account(`u${i}`, 'testville'));
  const env = await setup({ accounts, start: false });
  t.after(() => teardown(env));
  const times = [];
  let fail = 1;
  for (const name of ['publishCalendars', 'publishCalendarEvents', 'deleteCalendar']) {
    const original = env.gladys[name].bind(env.gladys);
    env.gladys[name] = async (...args) => {
      times.push(env.clock.elapsed);
      if (name === 'publishCalendarEvents' && fail > 0) {
        fail -= 1;
        const err = new Error('Too many');
        err.name = 'GladysApiError';
        err.status = 429;
        throw err;
      }
      return original(...args);
    };
  }
  await env.gladys.connect();
  await env.wait(4 * MINUTE);
  for (let i = 0; i < 20; i += 1) assert.equal(env.events(`u${i}`).length, 4, `u${i}`);
  assert.equal(times.length, 41, '20 calendars, 20 event pushes, one written again');
  for (const t0 of times) {
    const inMinute = times.filter((x) => x >= t0 && x < t0 + MINUTE).length;
    assert.ok(inMinute <= 25, `${inMinute} writes in a minute`);
  }
  const retried = times.findIndex((x, i) => i > 0 && x - times[i - 1] >= MINUTE - SECOND);
  assert.ok(retried > 0, 'the 429 was waited out');
});

test('getConfig and the accounts failing once are asked again, spaced, then everything runs', async (t) => {
  const env = await setup({ start: false });
  t.after(() => teardown(env));
  const getConfig = env.gladys.getConfig.bind(env.gladys);
  const getAccounts = env.gladys.getCalendarAccounts.bind(env.gladys);
  // The SDK reads the configuration once itself at connect: the app's read fails.
  let c = 2;
  let a = 1;
  env.gladys.getConfig = async () => {
    c -= 1;
    if (c === 0) throw new Error('down');
    return getConfig();
  };
  env.gladys.getCalendarAccounts = async () => {
    if (a-- > 0) throw new Error('down');
    return getAccounts();
  };
  await env.gladys.connect();
  await env.wait(SECOND);
  assert.match(statusText(env), /Configuration not read from Gladys/);
  assert.equal(env.source.count(), 0);
  await env.wait(10 * SECOND);
  assert.match(statusText(env), /accounts were not read from Gladys/);
  await env.wait(15 * SECOND);
  assert.equal(env.events().length, 4);
  assert.equal(env.status().connected, true);
});

test('getConfig failing in a later connection too: retried, status exact, then resumes', async (t) => {
  const env = await start(t);
  await env.gladys.disconnect();
  await env.wait(SECOND);
  const getConfig = env.gladys.getConfig.bind(env.gladys);
  let c = 2;
  env.gladys.getConfig = async () => {
    c -= 1;
    if (c === 0) throw new Error('down');
    return getConfig();
  };
  await env.gladys.connect();
  await env.wait(SECOND);
  assert.match(statusText(env), /Configuration not read/);
  await env.wait(11 * SECOND);
  assert.equal(env.status().connected, true);
  assert.equal(env.source.count('events'), 1, 'a reconnection reads nothing');
});

test('/data unreadable: nothing asked, read again every 10 s; then the state is used', async (t) => {
  const store = createMemoryStore();
  store.unreadable = true;
  const env = await setup({ store, start: false });
  t.after(() => teardown(env));
  await env.gladys.connect();
  await env.wait(SECOND);
  assert.match(statusText(env), /\/data unreadable/);
  await env.wait(30 * SECOND);
  assert.equal(env.source.count(), 0);
  store.unreadable = false;
  await env.wait(11 * SECOND);
  await env.wait(5 * SECOND);
  assert.equal(env.source.count('events'), 1);
  assert.equal(env.events().length, 4);
});

test('/data that cannot be written: no read (a restart could not know it was made)', async (t) => {
  const store = createMemoryStore();
  store.failSave = true;
  const env = await start(t, { store });
  assert.equal(env.source.count('events'), 0);
  assert.match(statusText(env), /\/data cannot be written/);
  store.failSave = false;
  await env.wait(5 * MINUTE + SECOND);
  assert.equal(env.source.count('events'), 1);
});

test('an answer too large, or not JSON, or without events: nothing pushed, said', async () => {
  for (const [answer, word] of [
    [() => new Response('x'.repeat(7 * 1024 * 1024), { status: 200 }), /answer too large/],
    [() => new Response('<html>', { status: 200 }), /unreadable answer/],
    [() => ({ total: 1 }), /unreadable answer/],
  ]) {
    const env = await setup({ start: false });
    env.source.events = answer;
    await env.gladys.connect();
    await env.wait(5 * SECOND);
    assert.equal(env.events().length, 0);
    assert.match(statusText(env), word);
    await teardown(env);
  }
});

test('no secret in logs, status or /data; no request nor timer after stop', async (t) => {
  const store = createMemoryStore();
  const env = await start(t, { store });
  env.source.agendas = () => json({}, 401);
  await env.wait(11 * SECOND);
  await env.gladys.fake.action('test_key');
  const everything = [
    ...env.lines,
    JSON.stringify(env.gladys.fake.connectionStatuses),
    JSON.stringify(store.data),
    JSON.stringify(env.gladys.fake.calendars),
  ].join('\n');
  assert.equal(everything.includes(KEY), false);
  await env.app.stop();
  const count = env.source.count();
  const pending = env.clock.pending;
  await env.wait(2 * DAY);
  assert.equal(env.source.count(), count);
  assert.equal(pending, 0, 'no timer left');
});

test('a scene-free private calendar: nothing shared by the module, the user fields kept', async (t) => {
  const env = await start(t);
  const cal = env.gladys.fake.calendars[0];
  cal.shared = true;
  cal.selector = 'mine';
  await env.wait(6 * HOUR + MINUTE);
  assert.equal(cal.shared, true);
  assert.equal(cal.selector, 'mine');
  for (const body of env.gladys.fake.bodies('POST', '/calendar')) {
    for (const c of body.calendars)
      assert.deepEqual(Object.keys(c).sort(), ['description', 'external_id', 'name']);
  }
});

test('an agenda switched from its number to its short name keeps its calendar (no delete before the name is read)', async (t) => {
  const env = await start(t, { accounts: [account('alice', '12345678')] });
  assert.equal(env.gladys.fake.calendars.length, 1);
  env.gladys.fake.calendarAccounts = [account('alice', 'testville')];
  await env.gladys.fake.calendarAccountUpdated('alice');
  await env.wait(10 * SECOND);
  assert.deepEqual(env.gladys.fake.deletedCalendars, []);
  assert.equal(env.events().length, 4);
});

test('a pause started during a read (by the test button) stops its next page', async (t) => {
  const env = await start(t);
  const day = Math.floor(NOW / DAY) * DAY;
  env.source.events = (r) => {
    if (r.u.searchParams.has('after[]')) return page([], null);
    // The first page answers 8 s later.
    return new Promise((resolve) => {
      env.clock.timers.setTimeout(
        () => resolve(page([event({ uid: 1, timings: [[day + DAY, day + DAY + HOUR]] })], ['c1'])),
        8 * SECOND,
      );
    });
  };
  env.source.agendas = () => json({}, 429, { 'retry-after': '3600' });
  // The setup ran 10 s; the first read started at 0 s: the next starts at 6 h,
  // its first page answers at 6 h 8 s. The button is clicked at 6 h 5 s.
  await env.wait(6 * HOUR - 5 * SECOND);
  const before = env.source.count('events');
  const ack = await env.gladys.fake.action('test_key');
  assert.match(ack.data.message.en, /slow down/);
  await env.wait(10 * SECOND);
  assert.equal(env.source.count('events'), before, 'no page asked during the pause');
  assert.equal(env.events().length, 4, 'the read cut short pushed nothing');
  await env.wait(HOUR);
  assert.equal(env.source.count('events'), before + 2, 'read again whole when the pause ends');
});

test('an account disabled then enabled again gets its calendars back from the last read', async (t) => {
  const env = await start(t);
  const reads = env.source.count('events');
  // Disabled: the core destroys the calendars.
  env.gladys.fake.calendarAccounts = [];
  env.gladys.fake.calendars = [];
  env.gladys.fake.calendarEvents = [];
  await env.gladys.fake.calendarAccountUpdated('alice');
  await env.wait(SECOND);
  env.gladys.fake.calendarAccounts = [account('alice', 'https://openagenda.com/fr/testville')];
  await env.gladys.fake.calendarAccountUpdated('alice');
  await env.wait(SECOND);
  assert.equal(env.gladys.fake.calendars.length, 1);
  assert.equal(env.events().length, 4);
  assert.equal(env.source.count('events'), reads, 'no new read');
});

test('the cap keeps the soonest slots even when an event of the first page has many dates', async (t) => {
  const day = Math.floor(NOW / DAY) * DAY;
  const env = await setup({ config: { api_key: KEY, max_events: 50 }, start: false });
  t.after(() => teardown(env));
  // Page 1: one event every day for 59 days; page 2: a concert tomorrow evening.
  const long = event({
    uid: 1,
    timings: Array.from({ length: 59 }, (_, k) => [
      day + k * DAY + 9 * HOUR,
      day + k * DAY + 10 * HOUR,
    ]),
  });
  const soon = event({
    uid: 2,
    title: 'Bientôt',
    timings: [[day + DAY + 20 * HOUR, day + DAY + 22 * HOUR]],
  });
  env.source.events = (r) =>
    r.u.searchParams.has('after[]') ? page([soon], null) : page([long], ['p2']);
  await env.gladys.connect();
  await env.wait(10 * SECOND);
  assert.equal(env.source.count('events'), 2, 'the second page is read');
  assert.equal(env.events().length, 50);
  assert.ok(env.events().some((e) => e.name === 'Bientôt'));
});
