// -----------------------------------------------------------------------------
// The pure parts: the forms, the OpenAgenda answers, the sub-windows, HTTP.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  languageOf,
  normalizeAccount,
  normalizeConfig,
  parseAgenda,
  tagOf,
} from '../src/config.js';
import { SourceError, getJson, retryAfterMs } from '../src/http.js';
import {
  DataError,
  agendasUrl,
  clean,
  eventsUrl,
  instant,
  occurrencesOf,
  parseAgendas,
  parseEventsPage,
  safeUrl,
} from '../src/openagenda.js';
import { overlaps, splitWindows, toGladysEvents } from '../src/windows.js';
import { event } from './fixtures/openagenda.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-15T00:00:00Z');

test('the form: key checked, secret key refused, numbers bounded', () => {
  assert.equal(normalizeConfig({}).problem, 'missing');
  assert.equal(normalizeConfig({ api_key: '  ' }).problem, 'missing');
  assert.equal(normalizeConfig({ api_key: 42 }).problem, 'malformed');
  assert.equal(normalizeConfig({ api_key: 'short' }).problem, 'malformed');
  assert.equal(normalizeConfig({ api_key: 'oa_pk_0123456789\nabcdef' }).problem, 'malformed');
  assert.equal(normalizeConfig({ api_key: 'oa_sk_0123456789abcdef' }).problem, 'secret_key');
  const ok = normalizeConfig({
    api_key: ' oa_pk_0123456789abcdef ',
    refresh_hours: 1,
    horizon_days: '900',
    max_events: 'x',
  });
  assert.equal(ok.key, 'oa_pk_0123456789abcdef');
  assert.equal(ok.problem, undefined);
  assert.equal(ok.refreshHours, 2, 'never more often than every 2 h');
  assert.equal(ok.horizonDays, 365);
  assert.equal(ok.maxEvents, 500);
  assert.equal(
    normalizeConfig({ api_key: 'oa_pk_0123456789abcdef', refresh_hours: 99 }).refreshHours,
    24,
  );
});

test('a refused key keeps 8 bits of a salted hash', () => {
  const tag = tagOf('a'.repeat(32), 'oa_pk_0123456789abcdef');
  assert.ok(Number.isInteger(tag) && tag >= 0 && tag < 256);
  assert.notEqual(tagOf('b'.repeat(32), 'k'), undefined);
});

test('agenda references: number, short name, links', () => {
  assert.deepEqual(parseAgenda('12345678'), { uid: 12345678 });
  assert.deepEqual(parseAgenda('Testville'), { slug: 'testville' });
  assert.deepEqual(parseAgenda('https://openagenda.com/fr/testville'), { slug: 'testville' });
  assert.deepEqual(parseAgenda('https://openagenda.com/testville/events/1_x?lang=fr'), {
    slug: 'testville',
  });
  assert.deepEqual(parseAgenda('openagenda.com/agendas/987'), { uid: 987 });
  assert.deepEqual(parseAgenda('https://www.openagenda.com/en/agendas/42'), { uid: 42 });
  for (const bad of [
    '',
    '../x',
    'a b',
    'https://evil.example/testville',
    'https://openagenda.com/',
    'javascript:alert(1)',
    'x'.repeat(301),
    '-x',
    'ab:c',
  ]) {
    assert.equal(parseAgenda(bad), undefined, bad);
  }
});

test('accounts: up to 10 agendas, the bad entry numbered, never echoed', () => {
  const a = normalizeAccount({
    user: { selector: 'alice', language: 'en' },
    config: {
      agendas: 'testville, 12; testville\nhttps://openagenda.com/autre',
      city: ' Saint-Malo ',
    },
  });
  assert.deepEqual(a.refs, [{ slug: 'testville' }, { uid: 12 }, { slug: 'autre' }]);
  assert.equal(a.lang, 'en');
  assert.equal(a.city, 'Saint-Malo');
  assert.equal(a.problem, undefined);
  const b = normalizeAccount({ user: { selector: 'bob' }, config: { agendas: 'ok, !!bad!!, 3' } });
  assert.equal(b.problem, 'bad_entry');
  assert.equal(b.entry, 2);
  assert.deepEqual(b.refs, [{ slug: 'ok' }, { uid: 3 }]);
  const c = normalizeAccount({
    user: { selector: 'c' },
    config: { agendas: Array.from({ length: 12 }, (_, i) => `a${i}`).join(',') },
  });
  assert.equal(c.refs.length, 10);
  assert.equal(c.problem, 'too_many');
  assert.equal(normalizeAccount({ user: { selector: 'd' }, config: {} }).problem, 'no_agenda');
  assert.equal(
    normalizeAccount({ user: { selector: 'e' }, config: { agendas: 'x', city: 'a\u0000b' } })
      .problem,
    'bad_city',
  );
  assert.equal(normalizeAccount({ user: { selector: 'a:b' }, config: {} }), undefined);
  assert.equal(normalizeAccount({}), undefined);
  assert.equal(languageOf({ language: 'pt' }), 'fr');
  assert.equal(languageOf({ language: 'de-CH' }), 'de');
});

test('URLs: one host, the key never in them, the window and cursor encoded', () => {
  assert.match(
    agendasUrl({ slugs: ['a', 'b'] }),
    /^https:\/\/api\.openagenda\.com\/v2\/agendas\?size=100&.*slug%5B%5D=a&slug%5B%5D=b$/,
  );
  const u = new URL(
    eventsUrl(12, { lang: 'fr', city: 'Saint-Malo', from: T0, to: T0 + DAY, after: ['0', '17'] }),
  );
  assert.equal(u.pathname, '/v2/agendas/12/events');
  assert.equal(u.searchParams.get('timings[gte]'), '2026-11-15T00:00:00.000Z');
  assert.equal(u.searchParams.get('adminLevel4'), 'Saint-Malo');
  assert.deepEqual(u.searchParams.getAll('after[]'), ['0', '17']);
  assert.equal(u.searchParams.get('size'), '100');
});

test('texts: control characters out, bounded, multilingual picked', () => {
  assert.equal(clean('a\r\nb\u0000c d   e', 100), 'a b c d e');
  assert.equal(clean('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
  assert.equal(clean(undefined, 10), '');
  assert.equal(safeUrl('javascript:alert(1)'), undefined);
  assert.equal(safeUrl('https://a.example/x y'), undefined);
  assert.equal(safeUrl(`https://a.example/${'x'.repeat(500)}`), undefined);
  assert.equal(safeUrl('https://a.example/x'), 'https://a.example/x');
});

test('timings: an offset is required, +0100 read as +01:00', () => {
  assert.equal(instant('2026-11-15T20:00:00+0100'), Date.parse('2026-11-15T19:00:00Z'));
  assert.equal(instant('2026-11-15T20:00:00+01:00'), Date.parse('2026-11-15T19:00:00Z'));
  assert.equal(instant('2026-11-15T19:00:00.000Z'), Date.parse('2026-11-15T19:00:00Z'));
  assert.equal(instant('2026-11-15T20:00:00'), undefined, 'no zone, never guessed');
  assert.equal(instant('2026-11-15'), undefined);
  assert.equal(instant(1794769200000), undefined);
  // A summer date keeps its own offset (+0200): the change of time is the source's.
  assert.equal(instant('2026-03-29T03:30:00+0200'), Date.parse('2026-03-29T01:30:00Z'));
});

test('occurrences: one per timing in the window, the bad timings left out, the licence credited', () => {
  const e = event({
    uid: 7,
    title: 'Expo',
    timings: [
      [T0 - 2 * DAY, T0 - 2 * DAY + HOUR],
      [T0 + HOUR, T0 + 2 * HOUR],
      [T0 + 3 * HOUR, T0 + 2 * HOUR],
      [T0 + DAY, T0 + 4 * DAY],
    ],
  });
  const r = occurrencesOf(e, { lang: 'fr', from: T0 - DAY, to: T0 + 10 * DAY });
  assert.deepEqual(
    r.occurrences.map((o) => o.id),
    [`7-${(T0 + HOUR) / 1000}`],
  );
  assert.equal(r.skipped, 2, 'end before start, longer than 48 h');
  const [o] = r.occurrences;
  assert.equal(o.name, 'Expo');
  assert.match(
    o.description,
    /^Description de Expo — Source : Ville de Testville via OpenAgenda, licence Licence Ouverte v2\.0 \(Etalab\), mis à jour le 2026-11-01$/,
  );
  assert.equal(o.url, 'https://openagenda.com/testville/events/7');
  assert.deepEqual(r.rights, {
    licence: 'Licence Ouverte v2.0 (Etalab)',
    licensor: 'Ville de Testville',
  });
  const none = occurrencesOf(event({ uid: 8, timings: [[T0, T0 + HOUR]], rights: null }), {
    lang: 'en',
    from: T0 - DAY,
    to: T0 + DAY,
  });
  assert.match(none.occurrences[0].description, /Source: OpenAgenda, licence not stated/);
  for (const bad of [
    { uid: -1 },
    { uid: 'x' },
    { title: { fr: '  ' } },
    { timings: 'x' },
    { status: 6 },
    { status: 4 },
    { removed: true },
  ]) {
    const one = occurrencesOf(
      { ...event({ uid: 9, timings: [[T0, T0 + HOUR]] }), ...bad },
      { lang: 'fr', from: T0 - DAY, to: T0 + DAY },
    );
    assert.equal(one.occurrences.length, 0, JSON.stringify(bad));
  }
  const long = occurrencesOf(
    event({
      uid: 10,
      title: 'x'.repeat(500),
      timings: [[T0, T0 + HOUR]],
      description: { fr: 'y'.repeat(5000) },
    }),
    { lang: 'fr', from: T0 - DAY, to: T0 + DAY },
  );
  assert.ok(long.occurrences[0].name.length <= 200);
  assert.ok(long.occurrences[0].description.length <= 1000);
  assert.match(long.occurrences[0].description, /Licence Ouverte/, 'the credit is never cut');
});

test('envelopes: events and agendas lists, cursors checked', () => {
  assert.throws(() => parseEventsPage({}), DataError);
  assert.throws(() => parseEventsPage({ events: [], after: 'x' }), DataError);
  assert.throws(() => parseEventsPage({ events: [], after: ['a b'] }), DataError);
  assert.throws(() => parseEventsPage({ events: new Array(301).fill({}) }), DataError);
  assert.deepEqual(parseEventsPage({ events: [], after: ['0', 17] }).after, ['0', '17']);
  assert.equal(parseEventsPage({ events: [], after: null }).after, null);
  assert.throws(() => parseAgendas({ total: 0 }), DataError);
  assert.deepEqual(
    parseAgendas({
      agendas: [
        { uid: 5, slug: 'Abc', title: 'T' },
        { uid: 'x' },
        { uid: 6, slug: '../x', title: { fr: 'Six' } },
      ],
    }),
    [
      { uid: 5, slug: 'abc', title: 'T' },
      { uid: 6, slug: '', title: 'Six' },
    ],
  );
  assert.equal(JSON.parse('{"__proto__":{"x":1},"agendas":[]}').x, undefined);
});

/** Random occurrences: the sub-windows cover the line, each ≤ max, every occurrence where it overlaps. */
test('sub-windows: disjoint, contiguous, bounded, nothing lost (random agendas)', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 60; round += 1) {
    const n = Math.floor(rnd() * 1800);
    const occ = Array.from({ length: n }, (_, i) => {
      const start = T0 + Math.floor(rnd() * 60) * DAY + Math.floor(rnd() * 24) * HOUR;
      return { id: `${i}-1`, start, end: start + Math.floor(rnd() * 25) * HOUR };
    });
    const max = [10, 100, 500][round % 3];
    const { windows, dropped } = splitWindows(occ, { max });
    assert.equal(windows[0].from, Date.UTC(2000, 0, 1));
    assert.equal(windows.at(-1).to, Date.UTC(2100, 0, 1));
    for (let i = 1; i < windows.length; i += 1) assert.equal(windows[i].from, windows[i - 1].to);
    const kept = new Set();
    for (const w of windows) {
      assert.ok(w.items.length <= max);
      for (const o of w.items) {
        assert.ok(overlaps(o, w.from, w.to));
        kept.add(o.id);
      }
    }
    assert.equal(kept.size + dropped, n);
    // Each kept occurrence is in EVERY window it overlaps (else that window prunes it).
    for (const o of occ.filter((x) => kept.has(x.id))) {
      for (const w of windows) {
        if (overlaps(o, w.from, w.to)) assert.ok(w.items.includes(o), 'straddler missing');
      }
    }
  }
});

test('sub-windows: a crowded instant drops the excess, never a lost window', () => {
  const occ = Array.from({ length: 30 }, (_, i) => ({ id: `${i}-1`, start: T0, end: T0 + HOUR }));
  const { windows, dropped } = splitWindows(occ, { max: 10 });
  assert.equal(dropped, 20);
  assert.equal(
    windows.reduce((n, w) => n + w.items.length, 0),
    10,
  );
  const ev = toGladysEvents(
    windows
      .find((w) => w.items.length)
      .items.slice(0, 1)
      .map((o) => ({ ...o, name: 'n', description: 'd' })),
    (id) => `ext:x:u:${id}`,
  );
  assert.deepEqual(Object.keys(ev[0]).sort(), [
    'description',
    'end',
    'external_id',
    'name',
    'start',
  ]);
});

test('HTTP: statuses mapped, the body bounded, Retry-After read', async () => {
  const answer =
    (status, body = '{}', headers = {}) =>
    async () =>
      new Response(body, { status, headers });
  const KEY = 'oa_pk_SECRETVALUE42';
  const ask = (fetchImpl, limit = 1000) =>
    getJson('https://api.openagenda.com/v2/agendas', { key: KEY, limit, fetchImpl, now: () => 0 });
  assert.deepEqual(await ask(answer(200, '{"a":1}')), { a: 1 });
  for (const [status, code] of [
    [401, 'refused'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [502, 'server'],
    [418, 'http'],
  ]) {
    await assert.rejects(ask(answer(status)), (e) => e instanceof SourceError && e.code === code);
  }
  await assert.rejects(ask(answer(200, 'x'.repeat(2000))), (e) => e.code === 'too_large');
  await assert.rejects(ask(answer(200, 'nope')), (e) => e.code === 'invalid');
  await assert.rejects(
    ask(async () => {
      throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    }),
    (e) => e.code === 'timeout',
  );
  await assert.rejects(
    ask(async () => {
      throw new TypeError('fetch failed');
    }),
    (e) => e.code === 'network' && !e.message.includes(KEY),
  );
  await assert.rejects(
    ask(answer(429, '{}', { 'retry-after': '120' })),
    (e) => e.retryAfter === 120_000,
  );
  assert.equal(
    retryAfterMs('Sat, 14 Nov 2026 14:30:00 GMT', Date.parse('2026-11-14T14:20:00Z')),
    600_000,
  );
  assert.equal(retryAfterMs('-5', 0), undefined);
  assert.equal(retryAfterMs('soon', 0), undefined);
});

test('r1 M2: HTML tags, entities, bidi and zero-width characters out of the texts', () => {
  assert.equal(
    clean('<b>Jazz</b> &amp; <img src=x onerror=alert(1)>blues&#33; &lt;3', 100),
    'Jazz & blues! <3',
  );
  assert.equal(clean('a‮b​c⁦d﻿', 100), 'abcd');
  assert.equal(clean('&unknown; &#x1F600;', 100), '&unknown; 😀');
});

test('r1: a timing given twice in one event is one occurrence', () => {
  const r = occurrencesOf(
    event({
      uid: 11,
      timings: [
        [T0, T0 + HOUR],
        [T0, T0 + HOUR],
      ],
    }),
    {
      lang: 'fr',
      from: T0 - DAY,
      to: T0 + DAY,
    },
  );
  assert.equal(r.occurrences.length, 1);
});

test('r2: only real tags are removed, comparisons kept', () => {
  assert.equal(clean('Tarif < 12 ans et > 6 ans', 100), 'Tarif < 12 ans et > 6 ans');
  assert.equal(clean('a<br/>b <p class="x">c</p> 3<4>2', 100), 'a b c 3<4>2');
});
