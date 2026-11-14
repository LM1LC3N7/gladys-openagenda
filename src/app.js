// -----------------------------------------------------------------------------
// The integration: each user who enabled it in Gladys ("My calendars") lists
// the OpenAgenda agendas they follow; each agenda becomes one of their Gladys
// calendars, private until they share it, holding the occurrences of its
// published events from yesterday to the horizon.
//
// When OpenAgenda is asked: an agenda (in one language, for one city filter:
// a "source", shared by the users who follow it alike) is read once per
// refresh interval (6 h by default, 2 h at least), all its pages in a row; a
// failed read is tried again 5 min, 15 min, 30 min, 1 h later, never more
// often than the interval after that. Nothing else: a restart, a
// reconnection, a new account or a toggle never reads sooner (the time of the
// attempt is in /data BEFORE the read); they republish the last read kept in
// /data. A 429 or a 5xx pauses every request (Retry-After, bounded, kept in
// /data). Two requests never leave closer than 2 s; one at a time.
//
// The key: a 401/403 on the agendas list (the key test and the agenda names)
// is a refusal, kept in /data as 8 bits of a salted hash; nothing is asked
// with that key again until it changes or the "Test the key" button succeeds.
// A 401/403 on one agenda's events is that agenda not readable (a private
// one), never a refusal.
//
// Gladys: the core takes 30 calendar writes a minute; the module keeps under
// 25, waits out a 429 and writes again (an upsert is idempotent). A read of
// OpenAgenda that failed half-way pushes nothing (a partial list would prune
// the rest).
//
// Clocks: the gaps, back-offs and pauses run on the monotonic clock; the wall
// clock dates /data and the read windows. Timers never sleep more than an hour.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import {
  AGENDA_TTL,
  CAL_DESCRIPTION_MAX,
  CONFIG_RETRY,
  CONFIG_RETRY_MAX,
  DAY,
  GLADYS_RETRIES,
  GLADYS_RETRY,
  GLADYS_TIMEOUT,
  HOUR,
  LOAD_TIMEOUT,
  MAX_ANSWER_BYTES,
  MAX_PAGES,
  PAST_PAGES,
  MAX_SAVE_BYTES,
  MAX_SLEEP,
  MIN_GAP,
  MINUTE,
  NAME_MAX,
  PAST,
  PAUSE_DEFAULT,
  PAUSE_MAX,
  PAUSE_MIN,
  RETRY_STEPS,
  SAVE_TIMEOUT,
  STATUS_TIMEOUT,
  STORE_RETRY,
  TEST_GAP,
  TEST_TIMEOUT,
  WRITES_PER_MINUTE,
} from './constants.js';
import { normalizeAccount, normalizeConfig, tagOf, validRefused } from './config.js';
import { SourceError, getJson } from './http.js';
import { REASON_CODES, T, calendarDescription } from './i18n.js';
import {
  DataError,
  agendasUrl,
  clean,
  eventsUrl,
  keyTestUrl,
  occurrencesOf,
  parseAgendas,
  parseEventsPage,
} from './openagenda.js';
import { splitWindows, toGladysEvents } from './windows.js';

const realTimers = { setTimeout, clearTimeout };

/** A wall date read from /data: a finite number not in the future, else undefined. */
const pastDate = (value, now) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now
    ? value
    : undefined;

const byStart = (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sourceKey = (uid, lang, city) => `${uid}|${lang}|${city ?? ''}`;
const signature = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/**
 * The occurrences as kept in /data: the texts of an event once (`texts`:
 * [name, description, location, url]), each occurrence as [text index, id,
 * start, end]. A recurring event costs its texts once, not per date.
 */
export function packOccurrences(list) {
  const texts = [];
  const index = new Map();
  const occ = [];
  for (const o of list) {
    const t = [o.name, o.description, o.location ?? null, o.url ?? null];
    const key = JSON.stringify(t);
    let i = index.get(key);
    if (i === undefined) {
      i = texts.length;
      texts.push(t);
      index.set(key, i);
    }
    occ.push([i, o.id, o.start, o.end]);
  }
  return { texts, occ };
}

const optional = (v, max, pattern) =>
  v === null || (typeof v === 'string' && v.length <= max && (!pattern || pattern.test(v)));

/**
 * Occurrences read back from /data: each field checked, bounded, an id kept
 * once; undefined when one does not read.
 */
export function restoreOccurrences(packed) {
  const texts = packed?.texts;
  const occ = packed?.occ;
  if (!Array.isArray(texts) || !Array.isArray(occ) || occ.length > 2000 || texts.length > 2000) {
    return undefined;
  }
  for (const t of texts) {
    if (
      !Array.isArray(t) ||
      t.length !== 4 ||
      typeof t[0] !== 'string' ||
      !t[0] ||
      t[0].length > 200 ||
      typeof t[1] !== 'string' ||
      t[1].length > 1000 ||
      !optional(t[2], 500) ||
      !optional(t[3], 500, /^https?:\/\//)
    ) {
      return undefined;
    }
  }
  const out = [];
  const seen = new Set();
  for (const o of occ) {
    if (
      !Array.isArray(o) ||
      !Number.isInteger(o[0]) ||
      o[0] < 0 ||
      o[0] >= texts.length ||
      typeof o[1] !== 'string' ||
      !/^\d{1,15}-\d{1,12}$/.test(o[1]) ||
      !Number.isFinite(o[2]) ||
      !Number.isFinite(o[3]) ||
      o[3] < o[2]
    ) {
      return undefined;
    }
    if (seen.has(o[1])) continue;
    seen.add(o[1]);
    const [name, description, location, url] = texts[o[0]];
    out.push({
      id: o[1],
      start: o[2],
      end: o[3],
      name,
      description,
      location: location ?? undefined,
      url: url ?? undefined,
    });
  }
  return out.sort(byStart);
}

const names = (list) =>
  Array.isArray(list)
    ? list.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 120).slice(0, 5)
    : [];

export class App {
  constructor({
    gladys,
    logger = console,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = realTimers,
    store,
    fetchImpl = (...args) => globalThis.fetch(...args),
    random = randomBytes,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.random = random;

    /** `{ key, problem, refreshHours, horizonDays, maxEvents }` once read from Gladys. */
    this.config = undefined;
    this.pendingConfig = undefined;
    /** user selector -> normalized account (config.js). */
    this.accounts = new Map();
    this.accountsRead = false;
    /** calendar external_id -> { user, sync } (GET /calendar). */
    this.calendars = new Map();
    /** agenda uid -> { title, slug, at } ; slug -> { uid (null: unknown), at }. */
    this.agendas = new Map();
    this.slugs = new Map();
    this.namesFailures = 0;
    this.namesMono = undefined;
    /** source key -> { key, uid, lang, city, attemptAt, attemptMono, failures, error, cache }. */
    this.sources = new Map();
    /** calendar external_id -> signature of what it received (memory: republished at each connection). */
    this.sent = new Map();
    /** `{ until (wall), due (mono), code, step }` after a 429 or a 5xx. */
    this.pause = undefined;
    /** `{ salt, tag }` of the refused key (/data), and the key itself (memory only). */
    this.refused = undefined;
    this.refusedKey = undefined;
    /** Monotonic time of the last request to OpenAgenda (any). */
    this.requestMono = undefined;
    this.testMono = undefined;
    this.gladysError = false;
    this.pushFailures = 0;
    this.pushTimer = undefined;
    /** calendar external_id -> user: the calendars Gladys did not take whole (pushed again). */
    this.due = new Map();
    this.dataBound = false;
    this.dataError = undefined;
    /** Monotonic times of the last calendar writes (the core's 30 a minute). */
    this.writes = [];

    this.loaded = false;
    this.loading = undefined;
    this.running = false;
    this.generation = 0;
    this.timer = undefined;
    this.storeTimer = undefined;
    this.configTimer = undefined;
    this.accountsTimer = undefined;
    this.configFailures = 0;
    this.configRetryAt = undefined;
    this.accountsFailures = 0;
    this.accountsRetryAt = undefined;
    /** One job at a time: the reads of OpenAgenda and the writes to Gladys. */
    this.queue = Promise.resolve();
    this.pending = 0;
    this.working = false;
    this.sleeps = new Set();
    this.lastStatus = undefined;
    this.statusJob = Promise.resolve();
    this.saving = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Every connection: /data once, the configuration and the accounts read again, the calendars republished. */
  async connected() {
    this.running = true;
    this.generation += 1;
    const gen = this.generation;
    this.lastStatus = undefined;
    // Everything the calendars held may be gone (a Gladys database restored): sent again.
    this.sent.clear();
    await this.loading?.catch(() => {});
    if (gen !== this.generation) return;
    if (!this.loaded) {
      this.publishStatus(false, T.starting);
      await this.load(gen);
      if (gen !== this.generation || !this.loaded) return;
    }
    this.configFailures = 0;
    await this.readConfig(gen);
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    for (const wake of [...this.sleeps]) wake();
    await this.queue.catch(() => {});
    if (this.loaded) await this.save();
  }

  clearTimers() {
    for (const name of ['timer', 'storeTimer', 'configTimer', 'accountsTimer', 'pushTimer']) {
      if (this[name]) this.timers.clearTimeout(this[name]);
      this[name] = undefined;
    }
  }

  /** Every pending piece of work (tests). */
  async idle() {
    // A job waiting on a timer of the virtual clock never ends by itself:
    // turns of the event loop, until nothing is pending or 100 turns passed.
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (i >= 5 && this.pending === 0 && !this.loading) break;
    }
    await this.statusJob;
  }

  /** Waits `ms` on the injected timers; ends at once when the app stops (resolves false). */
  sleep(ms, gen) {
    if (gen !== this.generation || !this.running) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        this.timers.clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve(gen === this.generation && this.running);
      };
      timer = this.timers.setTimeout(wake, Math.max(0, ms));
      this.sleeps.add(wake);
    });
  }

  /** Runs `job` after the previous one; never throws. */
  enqueue(job) {
    this.pending += 1;
    const run = this.queue.then(async () => {
      this.working = true;
      try {
        await job();
      } catch (err) {
        this.logger.error(
          `Job failed (${err?.name ?? 'Error'}: ${String(err?.message).slice(0, 200)})`,
        );
      } finally {
        this.working = false;
        this.pending -= 1;
      }
    });
    this.queue = run;
    return run;
  }

  // --- Configuration and accounts ----------------------------------------------

  /** Reads the configuration from Gladys; a failure is retried for ever, spaced. */
  async readConfig(gen) {
    if (this.configTimer) this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (gen !== this.generation || !this.running) return;
      this.configFailures += 1;
      const wait = Math.min(CONFIG_RETRY * 2 ** (this.configFailures - 1), CONFIG_RETRY_MAX);
      this.logger.warn(
        `Configuration not read (${err?.name ?? 'Error'}): asked again in ${wait / 1000} s`,
      );
      this.configRetryAt = this.now() + wait;
      this.publishStatus();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.readConfig(gen).catch((e) => this.logger.error(`Config failed (${e?.name})`));
      }, wait);
      return;
    }
    if (gen !== this.generation || !this.running) return;
    this.configFailures = 0;
    this.configRetryAt = undefined;
    await this.configure(config);
    this.accountsFailures = 0;
    await this.readAccounts(gen);
  }

  /** The configuration saved by the admin (or read at a connection). */
  async configure(raw) {
    if (!this.loaded) {
      this.pendingConfig = raw;
      return;
    }
    const next = normalizeConfig(raw);
    const changed = this.config !== undefined && this.config.key !== next.key;
    this.config = next;
    if (changed) {
      // A changed key is always tried: the refusal and the errors of the old one go.
      for (const src of this.sources.values()) {
        src.failures = 0;
        src.error = undefined;
      }
      this.namesFailures = 0;
      if (this.refused) {
        this.refused = undefined;
        this.refusedKey = undefined;
        await this.save();
      }
    }
    this.publishStatus();
    this.tick(this.generation);
  }

  /**
   * GET /calendar/account and GET /calendar (every user's, or one), then the
   * calendars of those users set right. A failure is retried, spaced.
   */
  async readAccounts(gen, user) {
    if (this.accountsTimer) this.timers.clearTimeout(this.accountsTimer);
    this.accountsTimer = undefined;
    let accounts;
    let calendars;
    try {
      accounts = await this.bounded(this.gladys.getCalendarAccounts());
      calendars = await this.bounded(this.gladys.getCalendars());
      if (!Array.isArray(accounts) || !Array.isArray(calendars)) throw new TypeError('not a list');
    } catch (err) {
      if (gen !== this.generation || !this.running) return;
      this.accountsFailures += 1;
      const wait = Math.min(CONFIG_RETRY * 2 ** (this.accountsFailures - 1), CONFIG_RETRY_MAX);
      this.logger.warn(
        `Accounts not read (${err?.name ?? 'Error'}): asked again in ${wait / 1000} s`,
      );
      this.accountsRetryAt = this.now() + wait;
      this.publishStatus();
      this.accountsTimer = this.timers.setTimeout(() => {
        this.accountsTimer = undefined;
        this.readAccounts(gen).catch((e) => this.logger.error(`Accounts failed (${e?.name})`));
      }, wait);
      return;
    }
    if (gen !== this.generation || !this.running) return;
    this.accountsFailures = 0;
    this.accountsRetryAt = undefined;
    this.accountsRead = true;
    const next = new Map();
    for (const raw of accounts) {
      const account = normalizeAccount(raw);
      if (account && !next.has(account.user)) next.set(account.user, account);
    }
    this.accounts = next;
    const prefix = this.gladys.externalId('');
    this.calendars = new Map();
    for (const c of calendars) {
      if (typeof c?.external_id !== 'string' || !c.external_id.startsWith(prefix)) continue;
      const owner =
        typeof c.user === 'string' ? c.user : c.external_id.slice(prefix.length).split(':')[0];
      this.calendars.set(c.external_id, { user: owner, sync: c.sync !== false });
      // A calendar the user turned off was emptied by the core: sent again once back on.
      if (c.sync === false) this.sent.delete(c.external_id);
    }
    // A calendar Gladys no longer holds (account disabled then enabled again,
    // database restored) is sent again whole.
    for (const id of [...this.sent.keys()]) if (!this.calendars.has(id)) this.sent.delete(id);
    this.forgetSources();
    this.publishStatus();
    await this.enqueue(() => this.reconcile(gen, user));
    this.tick(gen);
  }

  /** A promise bounded in time (a Gladys read that hangs is a failure). */
  bounded(promise) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = this.timers.setTimeout(() => reject(new Error('timeout')), GLADYS_TIMEOUT);
    });
    return Promise.race([promise, late]).finally(() => this.timers.clearTimeout(timer));
  }

  /** The sources nobody follows any more leave memory and /data (a day after their last attempt). */
  forgetSources() {
    const wanted = new Set();
    for (const account of this.accounts.values()) {
      for (const uid of this.uidsOf(account))
        wanted.add(sourceKey(uid, account.lang, account.city));
    }
    // Kept a day after the last attempt: a user who comes back (account
    // enabled again, agenda added back) gets the last read, never a new one
    // sooner than the interval.
    const now = this.now();
    for (const [key, src] of [...this.sources]) {
      if (wanted.has(key)) continue;
      if (src.attemptAt === undefined || now - src.attemptAt >= DAY) this.sources.delete(key);
    }
  }

  /** The agenda uids an account follows, as far as they are known (slugs resolved). */
  uidsOf(account) {
    const out = [];
    if (account.problem === 'bad_city') return out;
    for (const ref of account.refs) {
      const uid = ref.uid ?? this.slugs.get(ref.slug)?.uid;
      if (uid && !out.includes(uid)) out.push(uid);
    }
    return out;
  }

  /** Every slug of an account resolved (to an agenda or to "unknown"). */
  resolved(account) {
    return account.refs.every((ref) => ref.uid !== undefined || this.slugs.has(ref.slug));
  }

  calendarId(user, uid) {
    return this.gladys.externalId(`${user}:agenda-${uid}`);
  }

  /** The source a user's agenda is read from (created on first use). */
  sourceOf(account, uid) {
    const key = sourceKey(uid, account.lang, account.city);
    let src = this.sources.get(key);
    if (!src) {
      src = { key, uid, lang: account.lang, city: account.city, failures: 0 };
      this.sources.set(key, src);
    }
    return src;
  }

  /**
   * The calendars of the users (all, or one) set right: the ones of agendas
   * no longer followed deleted (only once every slug of the account is
   * resolved), the followed ones published, their events sent from the last
   * read when they lack them. No request to OpenAgenda here.
   */
  async reconcile(gen, only) {
    for (const account of this.accounts.values()) {
      if (gen !== this.generation) return;
      if (only !== undefined && account.user !== only) continue;
      // An unreadable city: nothing read, pushed nor deleted for this account.
      if (account.problem === 'bad_city') continue;
      const uids = this.uidsOf(account);
      const wanted = new Set(uids.map((uid) => this.calendarId(account.user, uid)));
      if (this.resolved(account)) {
        for (const [id, cal] of this.calendars) {
          if (cal.user !== account.user || wanted.has(id)) continue;
          const result = await this.write(gen, () => this.gladys.deleteCalendar(id));
          if (result === 'ok' || result === 'gone') {
            this.calendars.delete(id);
            this.sent.delete(id);
            this.due.delete(id);
          } else if (result === 'failed') {
            this.due.set(id, account.user);
          }
        }
      }
      for (const uid of uids) {
        if (gen !== this.generation) return;
        await this.pushCalendar(gen, account, this.sourceOf(account, uid));
      }
    }
    this.afterPushes(gen);
  }

  /** One user's calendar of one source: the calendar, then its events from the last read. */
  async pushCalendar(gen, account, src) {
    const id = this.calendarId(account.user, src.uid);
    const known = this.calendars.get(id);
    if (known && !known.sync) {
      this.due.delete(id);
      return 'skip';
    }
    // Nothing read yet: the calendar comes with its first read (one write less a user).
    if (!src.cache) return 'skip';
    const result = await this.pushCalendarNow(gen, account, src, id, known);
    // Per calendar: a calendar not taken whole stays due until it goes through.
    if (result === 'failed') this.due.set(id, account.user);
    else if (result !== 'stopped') this.due.delete(id);
    return result;
  }

  async pushCalendarNow(gen, account, src, id, known) {
    const agenda = this.agendas.get(src.uid);
    const title = agenda?.title || `OpenAgenda ${src.uid}`;
    const name = clean(account.city ? `${title} (${account.city})` : title, NAME_MAX);
    const cache = src.cache;
    const description = clean(
      calendarDescription(
        {
          slug: agenda?.slug,
          uid: src.uid,
          licences: cache?.licences,
          unstated: cache?.unstated,
          licensors: cache?.licensors,
          truncated: cache?.truncated,
          max: this.config?.maxEvents,
        },
        account.lang,
      ),
      CAL_DESCRIPTION_MAX,
    );
    const calendar = { external_id: id, name, description };
    // What the calendar holds, not when it was read: an unchanged read writes nothing.
    const sig = signature({ calendar, occurrences: cache.occurrences });
    if (this.sent.get(id) === sig) return 'ok';
    // From the first write on, the calendar holds a mix until the last window
    // went through: never "already sent" before that.
    this.sent.delete(id);
    const result = await this.write(gen, () =>
      this.gladys.publishCalendars(account.user, [calendar]),
    );
    if (result !== 'ok') return result === 'failed' || result === 'stopped' ? result : 'skip';
    if (!known) this.calendars.set(id, { user: account.user, sync: true });
    const { windows } = splitWindows(cache.occurrences);
    const idOf = (occ) => this.gladys.externalId(`${account.user}:a${src.uid}-${occ}`);
    for (const w of windows) {
      const events = toGladysEvents(w.items, idOf);
      const pushed = await this.write(gen, () =>
        this.gladys.publishCalendarEvents(id, events, {
          from: new Date(w.from).toISOString(),
          to: new Date(w.to).toISOString(),
        }),
      );
      if (pushed === 'off') {
        this.calendars.set(id, { user: account.user, sync: false });
        return 'skip';
      }
      if (pushed !== 'ok') return pushed === 'failed' || pushed === 'stopped' ? pushed : 'skip';
    }
    this.sent.set(id, sig);
    return 'ok';
  }

  /**
   * After a round of pushes: while a calendar Gladys did not take is due, it
   * is pushed again from the last read (no request to OpenAgenda) 5, 15,
   * 30 min, then every hour; the warning goes once none is due. A round that
   * did not touch a due calendar changes nothing of that.
   */
  afterPushes(gen) {
    if (gen !== this.generation || !this.running) return;
    // A due calendar of a user who left the integration is not due any more.
    for (const [id, user] of this.due) if (!this.accounts.has(user)) this.due.delete(id);
    if (this.due.size === 0) {
      if (this.pushTimer) this.timers.clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
      this.pushFailures = 0;
      if (this.gladysError) {
        this.gladysError = false;
        this.publishStatus();
      }
      return;
    }
    if (!this.gladysError) {
      this.gladysError = true;
      this.publishStatus();
    }
    if (this.pushTimer) return;
    this.pushFailures += 1;
    const wait = RETRY_STEPS[Math.min(this.pushFailures, RETRY_STEPS.length) - 1];
    this.pushTimer = this.timers.setTimeout(() => {
      this.pushTimer = undefined;
      this.enqueue(() => this.reconcile(gen));
    }, wait);
  }

  /**
   * One calendar write: a slot among the 25 a minute, a Gladys 429 waited
   * out and written again (3 times at most). 'ok', 'off' (403: sync turned
   * off), 'gone' (404: account disabled), 'failed', 'stopped'.
   */
  async write(gen, fn) {
    for (let attempt = 0; attempt <= GLADYS_RETRIES; attempt += 1) {
      if (!(await this.writeSlot(gen))) return 'stopped';
      try {
        await fn();
        return 'ok';
      } catch (err) {
        if (gen !== this.generation || !this.running) return 'stopped';
        const status = err?.status;
        if (status === 429) {
          this.logger.warn('Gladys asked to slow down the calendar writes (429): waiting a minute');
          if (!(await this.sleep(GLADYS_RETRY, gen))) return 'stopped';
          continue;
        }
        if (status === 403) return 'off';
        if (status === 404) return 'gone';
        this.logger.warn(`Calendar write refused (${err?.name ?? 'Error'} ${status ?? ''})`.trim());
        this.publishStatus();
        return 'failed';
      }
    }
    return 'failed';
  }

  /** Waits for a write slot (25 in any minute, on the monotonic clock); false when stopped. */
  async writeSlot(gen) {
    for (;;) {
      if (gen !== this.generation || !this.running) return false;
      const mono = this.monotonic();
      this.writes = this.writes.filter((t) => mono - t < MINUTE);
      if (this.writes.length < WRITES_PER_MINUTE) {
        this.writes.push(mono);
        return true;
      }
      if (!(await this.sleep(this.writes[0] + MINUTE - mono + 1, gen))) return false;
    }
  }

  // --- /data ----------------------------------------------------------------------

  /** Reads /data once (bounded); unreadable: read again every 10 s, nothing asked meanwhile. */
  async load(gen) {
    if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
    this.storeTimer = undefined;
    this.loading = (async () => {
      let timer;
      const late = new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve({ status: 'unreadable' }), LOAD_TIMEOUT);
      });
      const read = Promise.resolve()
        .then(() => this.store.load())
        .catch(() => ({ status: 'unreadable' }));
      const result = await Promise.race([read, late]).finally(() =>
        this.timers.clearTimeout(timer),
      );
      if (gen !== this.generation || !this.running) return;
      if (result.status === 'unreadable') {
        this.logger.warn('/data unreadable: read again in 10 s');
        this.publishStatus(false, T.storeUnreadable);
        // The next read waits for this one to end (one read at a time).
        const retry = () => {
          this.storeTimer = this.timers.setTimeout(() => {
            this.storeTimer = undefined;
            if (gen !== this.generation || !this.running) return;
            if (this.loading) {
              retry();
              return;
            }
            this.load(gen)
              .then(() =>
                gen === this.generation && this.loaded ? this.readConfig(gen) : undefined,
              )
              .catch((err) => this.logger.error(`Load failed (${err?.name})`));
          }, STORE_RETRY);
        };
        read.finally(retry);
        return;
      }
      if (result.status === 'ok') this.restore(result.data);
      this.loaded = true;
    })().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
    if (this.loaded && this.pendingConfig !== undefined) {
      const raw = this.pendingConfig;
      this.pendingConfig = undefined;
      await this.configure(raw);
    }
  }

  /** The state of /data, each part checked; a part that does not read is dropped. */
  restore(data) {
    const now = this.now();
    const mono = this.monotonic();
    this.refused = validRefused(data.refused);
    const pause = data.pause;
    if (pause && Number.isFinite(pause.until) && pause.until > now) {
      // A pause past its maximum is capped: its rest counts from now on the monotonic clock.
      const left = Math.min(pause.until - now, PAUSE_MAX);
      this.pause = {
        until: now + left,
        due: mono + left,
        code: REASON_CODES.includes(pause.code) ? pause.code : 'rate_limited',
        step: Number.isInteger(pause.step) && pause.step >= 0 && pause.step < 20 ? pause.step : 0,
      };
    }
    const agendas = data.agendas && typeof data.agendas === 'object' ? data.agendas : {};
    for (const [uid, a] of Object.entries(agendas)) {
      if (!/^[1-9]\d{0,14}$/.test(uid) || !a || typeof a.title !== 'string') continue;
      const at = pastDate(a.at, now);
      if (at === undefined) continue;
      this.agendas.set(Number(uid), {
        title: a.title.slice(0, NAME_MAX),
        slug: typeof a.slug === 'string' && /^[a-z0-9-]{0,100}$/.test(a.slug) ? a.slug : '',
        at,
      });
    }
    const slugs = data.slugs && typeof data.slugs === 'object' ? data.slugs : {};
    for (const [slug, s] of Object.entries(slugs)) {
      const at = pastDate(s?.at, now);
      if (!/^[a-z0-9-]{1,100}$/.test(slug) || at === undefined) continue;
      const uid = Number.isSafeInteger(s.uid) && s.uid > 0 ? s.uid : null;
      this.slugs.set(slug, { uid, at });
    }
    const sources = Array.isArray(data.sources) ? data.sources.slice(0, 500) : [];
    for (const s of sources) {
      if (!s || !Number.isSafeInteger(s.uid) || s.uid <= 0 || typeof s.lang !== 'string') continue;
      const city = typeof s.city === 'string' && s.city.length <= 80 ? s.city : undefined;
      const src = {
        key: sourceKey(s.uid, s.lang, city),
        uid: s.uid,
        lang: s.lang,
        city,
        failures: 0,
      };
      src.attemptAt = pastDate(s.attemptAt, now);
      // The time since the last attempt, capped at a day: a restart never reads sooner.
      if (src.attemptAt !== undefined) src.attemptMono = mono - Math.min(now - src.attemptAt, DAY);
      if (Number.isInteger(s.failures) && s.failures >= 0 && s.failures < 1000)
        src.failures = s.failures;
      src.error = REASON_CODES.includes(s.error) ? s.error : undefined;
      const c = s.cache;
      const occurrences = c ? restoreOccurrences(c.packed) : undefined;
      const at = c ? pastDate(c.at, now) : undefined;
      if (occurrences && at !== undefined) {
        src.cache = {
          at,
          occurrences,
          licences: names(c.licences),
          licensors: names(c.licensors),
          unstated: c.unstated === true,
          truncated: c.truncated === true,
        };
      } else if (c) {
        this.logger.warn(`Stored events of agenda ${s.uid} unusable: read again when due`);
      }
      this.sources.set(src.key, src);
    }
  }

  stateToSave() {
    const agendas = {};
    for (const [uid, a] of this.agendas) agendas[uid] = a;
    const slugs = {};
    for (const [slug, s] of this.slugs) slugs[slug] = s;
    const followed = new Set(this.followed().map((src) => src.key));
    const sources = [...this.sources.values()].map((s) => ({
      uid: s.uid,
      lang: s.lang,
      city: s.city,
      attemptAt: s.attemptAt,
      failures: s.failures,
      error: s.error,
      cache: s.cache
        ? {
            at: s.cache.at,
            licences: s.cache.licences,
            licensors: s.cache.licensors,
            unstated: s.cache.unstated,
            truncated: s.cache.truncated,
            packed: packOccurrences(s.cache.occurrences),
          }
        : undefined,
    }));
    const state = {
      version: 2,
      refused: this.refused,
      pause: this.pause
        ? { until: this.pause.until, code: this.pause.code, step: this.pause.step }
        : undefined,
      agendas,
      slugs,
      sources,
    };
    // Written well under what is read back (MAX_STATE_BYTES): past the bound,
    // the last reads of the agendas nobody follows, then the oldest, stay in
    // memory only (their calendars keep their events in Gladys; only a
    // republication after a restart waits for the next read).
    let size = Buffer.byteLength(JSON.stringify(state));
    if (size <= MAX_SAVE_BYTES) this.dataBound = false;
    if (size > MAX_SAVE_BYTES) {
      const order = sources
        .map((entry, i) => ({ entry, key: [...this.sources.values()][i].key }))
        .filter((x) => x.entry.cache)
        .sort(
          (a, b) =>
            Number(followed.has(a.key)) - Number(followed.has(b.key)) ||
            a.entry.cache.at - b.entry.cache.at,
        );
      for (const { entry } of order) {
        if (size <= MAX_SAVE_BYTES) break;
        size -= Buffer.byteLength(JSON.stringify(entry.cache));
        entry.cache = undefined;
      }
      if (!this.dataBound) {
        this.logger.warn('/data bound reached: the oldest reads are kept in memory only');
      }
      this.dataBound = true;
    }
    return state;
  }

  /**
   * One write at a time, bounded in time: a write that hangs counts as a
   * failed one (the data stays in memory). Never throws. True when written.
   */
  async save() {
    if (this.saving) {
      await Promise.race([
        this.saving,
        new Promise((r) => this.timers.setTimeout(r, SAVE_TIMEOUT)),
      ]);
      if (this.saving) {
        this.dataError = 'timeout';
        return false;
      }
    }
    let timer;
    const job = Promise.resolve().then(() => this.store.save(this.stateToSave()));
    const done = job.then(
      () => {},
      () => {},
    );
    this.saving = done;
    done.then(() => {
      if (this.saving === done) this.saving = undefined;
    });
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), SAVE_TIMEOUT);
    });
    try {
      const result = await Promise.race([job.then(() => 'ok'), late]);
      this.dataError = result === 'ok' ? undefined : 'timeout';
    } catch (err) {
      this.logger.warn(`Could not write /data: ${err?.code ?? 'error'}`);
      this.dataError = 'write';
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (this.dataError === 'timeout') this.logger.warn('Writing /data takes too long');
    return this.dataError === undefined;
  }

  // --- The key --------------------------------------------------------------------

  /** The key held is the one OpenAgenda refused (exactly in memory, by its tag after a restart). */
  keyRefused() {
    if (!this.refused || !this.config?.key) return false;
    if (this.refusedKey !== undefined) return this.config.key === this.refusedKey;
    return tagOf(this.refused.salt, this.config.key) === this.refused.tag;
  }

  async refuseKey(key) {
    const salt = this.random(16).toString('hex');
    this.refused = { salt, tag: tagOf(salt, key) };
    this.refusedKey = key;
    this.logger.warn('OpenAgenda refused the key: nothing asked until it changes');
    await this.save();
    this.publishStatus();
  }

  /** Everything needed to ask: /data read, a valid key not refused. */
  ready() {
    return this.loaded && this.config !== undefined && !this.config.problem && !this.keyRefused();
  }

  // --- Requests to OpenAgenda -------------------------------------------------------

  /**
   * One GET, after the 2-second gap; a 429 or 5xx starts a pause (kept in
   * /data). Returns the JSON or throws the SourceError/DataError.
   */
  async ask(gen, url, { timeout } = {}) {
    // The gap is measured again after each wait: the test button may have asked meanwhile.
    for (let i = 0; i < 10 && this.requestMono !== undefined; i += 1) {
      const wait = this.requestMono + MIN_GAP - this.monotonic();
      if (wait <= 0) break;
      if (!(await this.sleep(wait, gen))) throw new SourceError('stopped', 'stopped');
    }
    if (gen !== this.generation || !this.running) throw new SourceError('stopped', 'stopped');
    // Checked after the gap: a pause may have started meanwhile (the test button).
    if (this.pause && this.pause.due > this.monotonic()) {
      throw new SourceError('rate_limited', 'paused');
    }
    const key = this.config.key;
    this.requestMono = this.monotonic();
    try {
      const json = await getJson(url, {
        key,
        limit: MAX_ANSWER_BYTES,
        fetchImpl: this.fetchImpl,
        now: this.now,
        timeout,
      });
      // A success ends the back-off of an expired pause; an answer to a request
      // sent before a pause began never lifts it.
      if (this.pause && this.pause.due <= this.monotonic()) this.pause = undefined;
      return json;
    } catch (err) {
      if (err instanceof SourceError) err.key = key;
      if ((err?.code === 'rate_limited' || err?.code === 'server') && err.message !== 'paused') {
        await this.startPause(err);
      }
      throw err;
    }
  }

  async startPause(err) {
    const step = this.pause ? Math.min(this.pause.step + 1, 10) : 0;
    const growing = Math.min(PAUSE_DEFAULT * 2 ** step, PAUSE_MAX);
    // A first pause takes Retry-After as given; a pause in a row grows all the same.
    let wanted = err.retryAfter !== undefined ? err.retryAfter : growing;
    if (this.pause && err.retryAfter !== undefined) wanted = Math.max(wanted, growing);
    const left = Math.min(Math.max(wanted, PAUSE_MIN), PAUSE_MAX);
    this.pause = { until: this.now() + left, due: this.monotonic() + left, code: err.code, step };
    this.logger.warn(`OpenAgenda paused for ${Math.round(left / 1000)} s (${err.code})`);
    await this.save();
    this.publishStatus();
  }

  /** The agenda names (titles, slugs) the accounts need, asked once a day. */
  namesNeeded(now) {
    const slugs = new Set();
    const uids = new Set();
    for (const account of this.accounts.values()) {
      for (const ref of account.refs) {
        if (ref.slug !== undefined) {
          const s = this.slugs.get(ref.slug);
          if (!s || now - s.at >= AGENDA_TTL) slugs.add(ref.slug);
        } else {
          const a = this.agendas.get(ref.uid);
          if (!a || now - a.at >= AGENDA_TTL) uids.add(ref.uid);
        }
      }
    }
    // A slug resolved to an uid also names that agenda.
    for (const slug of slugs) {
      const uid = this.slugs.get(slug)?.uid;
      if (uid) uids.delete(uid);
    }
    return { slugs: [...slugs].slice(0, 100), uids: [...uids].slice(0, 100) };
  }

  /** Asks the names; true when done (or nothing to ask), false when it failed. */
  async readNames(gen, { slugs, uids }) {
    try {
      const now = this.now();
      if (slugs.length > 0) {
        const found = parseAgendas(await this.ask(gen, agendasUrl({ slugs })));
        if (gen !== this.generation) return false;
        for (const slug of slugs) this.slugs.set(slug, { uid: null, at: now });
        for (const a of found) {
          if (a.slug) this.slugs.set(a.slug, { uid: a.uid, at: now });
          this.agendas.set(a.uid, { title: a.title, slug: a.slug, at: now });
        }
      }
      if (uids.length > 0) {
        const found = parseAgendas(await this.ask(gen, agendasUrl({ uids })));
        if (gen !== this.generation) return false;
        for (const uid of uids) {
          // A private agenda is not listed: named by its uid, read all the same.
          if (!found.some((a) => a.uid === uid)) {
            const old = this.agendas.get(uid);
            this.agendas.set(uid, { title: old?.title ?? '', slug: old?.slug ?? '', at: now });
          }
        }
        for (const a of found) this.agendas.set(a.uid, { title: a.title, slug: a.slug, at: now });
      }
      this.namesFailures = 0;
      return true;
    } catch (err) {
      if (err?.code === 'stopped' || gen !== this.generation) return false;
      if (err?.code === 'refused' || err?.code === 'forbidden') {
        // The agendas list is the key's own route: a 401/403 there is the key.
        if (err.key === this.config.key) await this.refuseKey(err.key);
        return false;
      }
      this.namesFailures += 1;
      this.namesMono = this.monotonic();
      this.logger.warn(`Agenda names not read (${err?.code ?? err?.name})`);
      return false;
    }
  }

  /**
   * Reads one source, every page, then pushes it to its users. Nothing is
   * kept nor pushed from a read that failed half-way.
   */
  async readSource(gen, src) {
    const now = this.now();
    const dayStart = Math.floor(now / DAY) * DAY;
    const from = dayStart - PAST;
    const to = dayStart + (this.config.horizonDays + 1) * DAY;
    // The attempt is in /data before the read: a restart never reads sooner.
    src.attemptAt = now;
    src.attemptMono = this.monotonic();
    if (!(await this.save())) {
      src.failures += 1;
      src.error = 'data';
      this.publishStatus();
      return;
    }
    const max = this.config.maxEvents;
    /** occurrence id -> occurrence: an id read twice (pages that overlap) counts once. */
    const found = new Map();
    const licences = new Map();
    const licensors = new Map();
    let truncated = false;
    // Kept bounded while reading: the `max` soonest, the rest dropped at each page.
    const trim = () => {
      if (found.size <= max) return;
      const kept = [...found.values()].sort(byStart).slice(0, max);
      found.clear();
      for (const o of kept) found.set(o.id, o);
      truncated = true;
    };
    /**
     * Reads the pages of [lo, hi], all or until the soonest `max` are known
     * (`early`: the API orders by the next timing to come, so only the
     * upcoming part may stop early).
     */
    const readRange = async (lo, hi, { early, pages }) => {
      let after;
      const seen = new Set();
      for (let page = 0; ; page += 1) {
        if (page >= pages) return 'cut';
        const json = await this.ask(
          gen,
          eventsUrl(src.uid, { lang: src.lang, city: src.city, from: lo, to: hi, after }),
        );
        if (gen !== this.generation) return 'stopped';
        const result = parseEventsPage(json);
        // The latest first upcoming occurrence of this page: the next pages start later.
        let pageFirst = -Infinity;
        for (const event of result.events) {
          const one = occurrencesOf(event, { lang: src.lang, from, to });
          for (const o of one.occurrences) found.set(o.id, o);
          const upcoming = one.occurrences.filter((o) => o.end > now);
          if (upcoming.length > 0) {
            pageFirst = Math.max(pageFirst, Math.min(...upcoming.map((o) => o.start)));
          }
          if (one.occurrences.length > 0 && one.rights) {
            const lic = one.rights.licence ?? '';
            licences.set(lic, (licences.get(lic) ?? 0) + 1);
            if (one.rights.licensor) {
              licensors.set(one.rights.licensor, (licensors.get(one.rights.licensor) ?? 0) + 1);
            }
          }
        }
        trim();
        after = result.after;
        if (!after) return 'end';
        // A cursor with an empty page, or a cursor served again: the list is
        // cut short, never taken as its end (it would prune the rest).
        if (result.events.length === 0) throw new DataError('Empty page before the end');
        // A cursor served twice would loop: the list ends there.
        const key = after.join('\u0000');
        if (seen.has(key)) throw new DataError('Page cursor served again');
        seen.add(key);
        if (early && found.size >= max) {
          const last = [...found.values()].sort(byStart)[max - 1];
          if (last.start <= pageFirst) return 'cut';
        }
      }
    };
    try {
      const ended = await readRange(from, to, { early: true, pages: MAX_PAGES });
      if (ended === 'stopped') return;
      if (ended === 'cut') {
        truncated = true;
        // Cut early, the events whose timings are all past (yesterday,
        // listed last by the API) were not reached: read on their own.
        if ((await readRange(from, now, { early: false, pages: PAST_PAGES })) === 'stopped') return;
      }
    } catch (err) {
      if (err?.code === 'stopped' || gen !== this.generation) return;
      src.error =
        err instanceof DataError
          ? 'invalid'
          : REASON_CODES.includes(err?.code)
            ? err.code
            : 'invalid';
      // A pause (429, 5xx) holds every source: not a failure of this one.
      if (src.error !== 'rate_limited' && src.error !== 'server') src.failures += 1;
      this.logger.warn(`Agenda ${src.uid} not read (${src.error})`);
      // Every followed agenda answering 401/403: the key is checked on its own route.
      if (src.error === 'forbidden' || src.error === 'refused')
        await this.checkKeyAfterDenials(gen);
      await this.save();
      this.publishStatus();
      return;
    }
    trim();
    const occurrences = [...found.values()].sort(byStart);
    const top = (m) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k)
        .slice(0, 5);
    const licenceNames = top(licences);
    src.cache = {
      at: this.now(),
      occurrences,
      // An event without a licence counts as '': `unstated`.
      licences: licenceNames.filter(Boolean),
      unstated: licences.has(''),
      licensors: top(licensors),
      truncated,
    };
    src.failures = 0;
    src.error = undefined;
    await this.save();
    this.publishStatus();
    for (const account of this.accounts.values()) {
      if (gen !== this.generation) return;
      if (account.lang !== src.lang || account.city !== src.city) continue;
      if (!this.uidsOf(account).includes(src.uid)) continue;
      await this.pushCalendar(gen, account, src);
    }
    // A retry pushes every due calendar (those holding their read are
    // skipped by their signature).
    this.afterPushes(gen);
  }

  /** When every source with a read answers 401/403, the key is tested on the agendas list. */
  async checkKeyAfterDenials(gen) {
    const tried = [...this.sources.values()].filter((s) => s.attemptAt !== undefined);
    if (tried.length === 0 || !tried.every((s) => s.error === 'forbidden' || s.error === 'refused'))
      return;
    try {
      await this.ask(gen, keyTestUrl());
    } catch (err) {
      const denied = err?.code === 'refused' || err?.code === 'forbidden';
      if (gen === this.generation && denied && err.key === this.config.key) {
        await this.refuseKey(err.key);
      }
    }
  }

  // --- Scheduling ------------------------------------------------------------------

  /** The gap of a source after its last attempt (the interval, or a shorter retry after a failure). */
  gapOf(src) {
    const interval = this.config.refreshHours * HOUR;
    // Held by a pause (429, 5xx): read again as soon as the pause ends.
    if (src.error === 'rate_limited' || src.error === 'server') return 0;
    // A gone agenda (404) waits the interval; other failures 5, 15, 30 min,
    // 1 h, then the interval.
    if (src.error === 'not_found' || src.failures > RETRY_STEPS.length) return interval;
    if (src.failures > 0) return Math.min(RETRY_STEPS[src.failures - 1], interval);
    return interval;
  }

  /** The earliest a source may be read, on one reading of the monotonic clock. */
  dueAt(src, mono) {
    let due = src.attemptMono === undefined ? mono : src.attemptMono + this.gapOf(src);
    if (this.pause && this.pause.due > due) due = this.pause.due;
    return due;
  }

  /** The sources followed now (one per agenda, language and city). */
  followed() {
    const out = new Map();
    for (const account of this.accounts.values()) {
      for (const uid of this.uidsOf(account)) {
        const src = this.sourceOf(account, uid);
        out.set(src.key, src);
      }
    }
    return [...out.values()];
  }

  /**
   * The next decision after a job, on a timer of its own (0 ms): a job that
   * ends at once (a broken back-off) never chains the next one without
   * giving the event loop a turn.
   */
  soon(gen) {
    if (gen !== this.generation || !this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.tick(gen);
    }, 0);
  }

  /** Decides now: the names, then the most overdue source; else sleeps until the next one. */
  tick(gen) {
    if (gen !== this.generation || !this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.working || this.pending > 0 || !this.ready() || !this.accountsRead) return;
    const mono = this.monotonic();
    const now = this.now();
    let wake = mono + MAX_SLEEP;
    const paused = this.pause && this.pause.due > mono;
    if (paused) {
      wake = Math.min(wake, this.pause.due);
    } else {
      const names = this.namesNeeded(now);
      if (names.slugs.length > 0 || names.uids.length > 0) {
        const namesDue =
          this.namesFailures > 0 && this.namesMono !== undefined
            ? this.namesMono + RETRY_STEPS[Math.min(this.namesFailures, RETRY_STEPS.length) - 1]
            : mono;
        if (namesDue <= mono) {
          this.enqueue(async () => {
            if (await this.readNames(gen, names)) {
              this.forgetSources();
              await this.save();
              await this.reconcile(gen);
            }
          }).then(() => this.soon(gen));
          return;
        }
        wake = Math.min(wake, namesDue);
      }
      let best;
      let bestDue = Infinity;
      for (const src of this.followed()) {
        const due = this.dueAt(src, mono);
        if (due < bestDue) {
          best = src;
          bestDue = due;
        }
      }
      if (best && bestDue <= mono) {
        this.enqueue(() => this.readSource(gen, best)).then(() => this.soon(gen));
        return;
      }
      if (best) wake = Math.min(wake, bestDue);
    }
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        this.tick(gen);
      },
      Math.max(1000, wake - mono),
    );
    this.publishStatus();
  }

  // --- Status -----------------------------------------------------------------------

  publishStatus(connected, message) {
    let state = { connected, message };
    if (message === undefined) state = this.statusState();
    const key = JSON.stringify(state);
    if (key === this.lastStatus) return this.statusJob;
    this.lastStatus = key;
    this.statusJob = this.statusJob.then(() => this.sendStatus(state));
    return this.statusJob;
  }

  statusState() {
    if (!this.loaded) return { connected: false, message: T.starting };
    if (this.configRetryAt !== undefined) {
      return { connected: false, message: T.configUnreadable(this.configRetryAt) };
    }
    if (this.config === undefined) return { connected: false, message: T.starting };
    if (this.config.problem) return { connected: false, message: T[this.config.problem] };
    if (this.keyRefused()) return { connected: false, message: T.refused };
    if (this.accountsRetryAt !== undefined) {
      return { connected: false, message: T.accountsUnreadable(this.accountsRetryAt) };
    }
    const sources = this.followed();
    const problems = new Set();
    for (const account of this.accounts.values()) {
      if (account.problem) problems.add(account.problem);
      for (const ref of account.refs) {
        if (ref.slug !== undefined && this.slugs.get(ref.slug)?.uid === null)
          problems.add('unknown');
      }
    }
    const failing = sources.filter((s) => s.error);
    const read = sources.filter((s) => s.cache);
    const readAt = read.length ? Math.max(...read.map((s) => s.cache.at)) : undefined;
    const mono = this.monotonic();
    const paused = this.pause && this.pause.due > mono ? this.pause : undefined;
    return {
      connected: !paused && failing.length === 0 && !this.dataError,
      message: T.status({
        users: this.accounts.size,
        agendas: sources.length,
        ok: read.length,
        readAt,
        failing: failing.length,
        error: failing[0]?.error,
        problems: [...problems].sort(),
        pauseUntil: paused?.until,
        pauseCode: paused?.code,
        gladysError: this.gladysError,
        dataError: this.dataError,
      }),
    };
  }

  async sendStatus(state) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), STATUS_TIMEOUT);
    });
    try {
      const sent = Promise.resolve().then(() =>
        this.gladys.setConnectionStatus(state.connected, state.message),
      );
      if ((await Promise.race([sent.then(() => 'ok'), late])) === 'timeout') {
        sent.catch(() => {});
        this.logger.warn('Status not published in time');
      }
    } catch (err) {
      this.logger.warn(`Status not published: ${err?.name ?? 'error'}`);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // --- The "Test the key" button ----------------------------------------------------

  /**
   * One small request with the key saved (the agendas list), never closer
   * than 10 s to the last test nor 2 s to any request, nor during a pause. A
   * success lifts a refusal of that key; a 401/403 is one.
   */
  async testKey() {
    if (!this.loaded || !this.running) return T.testStarting;
    if (this.config === undefined) {
      try {
        await this.configure(await this.bounded(this.gladys.getConfig()));
      } catch {
        return T.testStarting;
      }
    }
    if (this.config.problem) return T[this.config.problem];
    const mono = this.monotonic();
    if (this.pause && this.pause.due > mono) return T.testPaused(this.pause.until, this.pause.code);
    let wait = 0;
    if (this.testMono !== undefined) wait = this.testMono + TEST_GAP - mono;
    if (this.requestMono !== undefined) wait = Math.max(wait, this.requestMono + MIN_GAP - mono);
    if (wait > 0) return T.testTooSoon(Math.ceil(wait / 1000));
    const key = this.config.key;
    this.testMono = mono;
    this.requestMono = mono;
    try {
      await getJson(keyTestUrl(), {
        key,
        limit: 64 * 1024,
        fetchImpl: this.fetchImpl,
        now: this.now,
        timeout: TEST_TIMEOUT,
      });
    } catch (err) {
      if (err?.code === 'refused' || err?.code === 'forbidden') {
        if (this.config.key === key) await this.refuseKey(key);
        return T.testRefused;
      }
      if (err?.code === 'rate_limited' || err?.code === 'server') await this.startPause(err);
      return T.testFailed(REASON_CODES.includes(err?.code) ? err.code : 'invalid');
    }
    if (this.refused && this.config.key === key) {
      this.refused = undefined;
      this.refusedKey = undefined;
      for (const src of this.sources.values()) src.failures = 0;
      await this.save();
      this.publishStatus();
    }
    this.tick(this.generation);
    const seen = new Set();
    const agendas = [];
    for (const src of this.followed()) {
      if (seen.has(src.uid)) continue;
      seen.add(src.uid);
      agendas.push({
        title: this.agendas.get(src.uid)?.title || `OpenAgenda ${src.uid}`,
        licences: src.cache?.licences ?? [],
        unstated: src.cache?.unstated === true,
        read: src.cache !== undefined,
      });
    }
    return T.testOk({ agendas });
  }

  /** A user enabled, disabled or changed their account, or toggled a calendar. */
  async accountUpdated(user) {
    if (!this.running || !this.loaded || this.config === undefined) return;
    await this.readAccounts(this.generation, typeof user === 'string' ? user : undefined);
  }
}
