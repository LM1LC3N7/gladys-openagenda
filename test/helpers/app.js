// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted OpenAgenda API and a
// virtual clock (each read moves it 1 µs).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../../src/app.js';
import { API_BASE } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { AGENDA, event, page } from '../fixtures/openagenda.js';
import { testClock } from './clock.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Saturday 14 November 2026, 14:20 UTC. */
export const NOW = Date.parse('2026-11-14T14:20:00Z');
export const KEY = 'oa_pk_0123456789abcdef0123';

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Two events of the default agenda: tomorrow evening, and an exhibition on three days. */
export function defaultEvents(now = NOW) {
  const day = Math.floor(now / DAY) * DAY;
  return [
    event({
      uid: 501,
      title: 'Concert de jazz',
      timings: [[day + DAY + 19 * HOUR, day + DAY + 21 * HOUR]],
    }),
    event({
      uid: 502,
      title: 'Exposition',
      timings: [0, 1, 2].map((k) => [
        day + (k + 2) * DAY + 10 * HOUR,
        day + (k + 2) * DAY + 18 * HOUR,
      ]),
    }),
  ];
}

/**
 * The API: `source.agendas(request)` and `source.events(request)` may return a
 * Response, a body, 'timeout' or undefined (the default answer).
 */
export function createSource(clock) {
  const source = {
    requests: [],
    agendaList: [AGENDA],
    eventList: defaultEvents(clock.now()),
    agendas: undefined,
    events: undefined,
    count: (kind) => source.requests.filter((r) => !kind || r.kind === kind).length,
  };
  source.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const path = `${u.origin}${u.pathname}`;
    const match = /^\/v2\/agendas\/(\d+)\/events$/.exec(u.pathname);
    const kind = match ? 'events' : u.pathname === '/v2/agendas' ? 'agendas' : 'other';
    const request = {
      url: String(url),
      u,
      kind,
      uid: match ? Number(match[1]) : undefined,
      headers: init.headers ?? {},
      init,
      at: clock.now(),
    };
    source.requests.push(request);
    if (!path.startsWith(API_BASE)) return new Response('nope', { status: 404 });
    const handler =
      kind === 'events' ? source.events : kind === 'agendas' ? source.agendas : undefined;
    let out = handler ? await handler(request) : undefined;
    if (out === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (out instanceof Response) return out;
    // Like the API: an event only carries the fields asked in includeFields[].
    if (out && kind === 'events' && Array.isArray(out.events)) {
      const fields = new Set(u.searchParams.getAll('includeFields[]'));
      out = {
        ...out,
        events: out.events.map((e) =>
          Object.fromEntries(Object.entries(e).filter(([k]) => fields.has(k))),
        ),
      };
    }
    if (out === undefined) {
      if (kind === 'agendas') {
        const slugs = u.searchParams.getAll('slug[]');
        const uids = u.searchParams.getAll('uid[]').map(Number);
        const list = source.agendaList.filter(
          (a) =>
            (slugs.length === 0 && uids.length === 0) ||
            slugs.includes(a.slug) ||
            uids.includes(a.uid),
        );
        out = { total: list.length, agendas: list, after: null };
      } else if (kind === 'events') {
        const size = Number(u.searchParams.get('size'));
        const at = Number(u.searchParams.getAll('after[]')[0] ?? 0);
        const slice = source.eventList.slice(at, at + size);
        const more = at + size < source.eventList.length;
        out = page(slice, more ? [String(at + size)] : null, source.eventList.length);
      } else {
        return new Response('nope', { status: 404 });
      }
      if (kind === 'events') {
        const fields = new Set(u.searchParams.getAll('includeFields[]'));
        out.events = out.events.map((e) =>
          Object.fromEntries(Object.entries(e).filter(([k]) => fields.has(k))),
        );
      }
    }
    return json(out);
  };
  return source;
}

export const account = (user, agendas, extra = {}) => ({
  user: { selector: user, first_name: user, language: extra.language ?? 'fr' },
  config: { agendas, ...(extra.city ? { city: extra.city } : {}) },
});

export async function setup({
  store = createMemoryStore(),
  now = NOW,
  config = { api_key: KEY },
  accounts = [account('alice', 'https://openagenda.com/fr/testville')],
  calendars = [],
  calendarEvents = [],
  start = true,
  clock = testClock({ start: now }),
} = {}) {
  const gladys = createFakeGladys({
    selector: 'openagenda',
    config,
    calendarAccounts: accounts,
    calendars,
    calendarEvents,
  });
  const source = createSource(clock);
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const logger = { info: log, warn: log, error: log, debug: log };
  const app = new App({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: source.fetch,
  });
  registerHandlers(gladys, app, logger);
  // A storm of requests (a broken back-off) fails the test at once, never hangs it.
  clock.between = async () => {
    if (source.requests.length > 1000) throw new Error('request storm: over 1,000 requests');
    await app.idle();
  };
  const wait = async (ms) => {
    await app.idle();
    await clock.advance(ms);
    await app.idle();
  };
  if (start) {
    await gladys.connect();
    await wait(0);
    await wait(10 * SECOND);
  }
  const status = () => gladys.fake.connectionStatus;
  const events = (user = 'alice') =>
    gladys.fake.calendarEvents.filter((e) =>
      e.calendar_external_id.startsWith(`ext:openagenda:${user}:`),
    );
  const calId = (user = 'alice', uid = AGENDA.uid) => `ext:openagenda:${user}:agenda-${uid}`;
  return { app, gladys, clock, store, source, wait, lines, status, events, calId, logger };
}

/** Stops the app and lets everything settle (t.after). */
export async function teardown(env) {
  await env.app.stop();
  await env.app.idle();
}
