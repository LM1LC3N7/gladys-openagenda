// -----------------------------------------------------------------------------
// The OpenAgenda API v2, read only (developers.openagenda.com): the URLs the
// module asks, and the answers checked and reduced to what Gladys stores.
// Nothing here talks to the network nor reads a clock.
//
// - GET /v2/agendas?slug[]=…|uid[]=…: the agenda names (uid, slug, title); the
//   key test asks /v2/agendas?size=1.
// - GET /v2/agendas/{uid}/events: the published events whose timings fall in
//   the read window, `monolingual` in the user's language, sorted by timing,
//   paged with the `after` cursor.
//
// Every timing of an event is one occurrence (the core stores occurrences
// only). The licence is read event by event (`rights`), as OpenAgenda asks.
// -----------------------------------------------------------------------------

import {
  API_BASE,
  EVENT_DESCRIPTION_MAX,
  EVENT_FIELDS,
  EVENT_NAME_MAX,
  LOCATION_MAX,
  MAX_TIMING,
  NAME_MAX,
  PAGE_SIZE,
  SKIPPED_STATUS,
  URL_MAX,
} from './constants.js';

export class DataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataError';
    this.code = 'invalid';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (isObject(o) && Object.hasOwn(o, k) ? o[k] : undefined);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A few HTML entities decoded (named ones above, decimal and hex ones); others left. */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (all, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? all;
    const n =
      code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

/**
 * Text as Gladys shows it: HTML tags out, a few entities decoded, control,
 * zero-width and bidi characters (an U+202E turns a title around) out,
 * spaces collapsed, cut to `max` characters (an ellipsis when cut).
 */
export function clean(value, max) {
  if (typeof value !== 'string') return '';
  const strip = (t) =>
    t
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g, '');
  const text = strip(
    decodeEntities(
      value.slice(0, 20_000).replace(/<\/?[a-z][a-z0-9-]{0,30}(?:\s[^<>]{0,2000})?\/?>/gi, ' '),
    ),
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** A multilingual text (`{ fr, en }`) or a plain one, in `lang` first, then French, English, any. */
export function pick(value, lang) {
  if (typeof value === 'string') return value;
  if (!isObject(value)) return '';
  for (const code of [lang, 'fr', 'en']) {
    const text = own(value, code);
    if (typeof text === 'string' && text.trim()) return text;
  }
  for (const text of Object.values(value)) if (typeof text === 'string' && text.trim()) return text;
  return '';
}

/** An http(s) link of at most URL_MAX characters, or undefined. */
export function safeUrl(value) {
  if (typeof value !== 'string' || value.length > URL_MAX) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A positive integer uid (number or digits), else undefined. */
export function uidOf(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value)) return Number(value);
  return undefined;
}

// --- URLs ---------------------------------------------------------------------

/** The key test: the smallest read the key allows. */
export const keyTestUrl = () => `${API_BASE}/agendas?size=1&includeFields[]=uid`;

/** The names of up to 100 agendas, by slug or by uid (one kind per request). */
export function agendasUrl({ slugs = [], uids = [] }) {
  const q = new URLSearchParams();
  q.append('size', '100');
  for (const f of ['uid', 'slug', 'title']) q.append('includeFields[]', f);
  for (const s of slugs) q.append('slug[]', s);
  for (const u of uids) q.append('uid[]', String(u));
  return `${API_BASE}/agendas?${q.toString()}`;
}

/** One page of the events of agenda `uid` whose timings fall in [from, to]. */
export function eventsUrl(uid, { lang, city, from, to, after }) {
  const q = new URLSearchParams();
  q.append('size', String(PAGE_SIZE));
  q.append('monolingual', lang);
  q.append('sort', 'timings.asc');
  q.append('timings[gte]', new Date(from).toISOString());
  q.append('timings[lte]', new Date(to).toISOString());
  for (const f of EVENT_FIELDS) q.append('includeFields[]', f);
  if (city) q.append('adminLevel4', city);
  for (const value of after ?? []) q.append('after[]', String(value));
  return `${API_BASE}/agendas/${uid}/events?${q.toString()}`;
}

// --- Agendas ------------------------------------------------------------------

/** `[{ uid, slug, title }]` from GET /v2/agendas; an envelope that does not read is a DataError. */
export function parseAgendas(json) {
  const list = own(json, 'agendas');
  if (!Array.isArray(list) || list.length > 200)
    throw new DataError('No agenda list in the answer');
  const out = [];
  for (const item of list) {
    const uid = uidOf(own(item, 'uid'));
    if (uid === undefined) continue;
    const slug = typeof own(item, 'slug') === 'string' ? own(item, 'slug').slice(0, 100) : '';
    out.push({
      uid,
      slug: /^[a-z0-9-]*$/i.test(slug) ? slug.toLowerCase() : '',
      title: clean(pick(own(item, 'title'), 'fr'), NAME_MAX),
    });
  }
  return out;
}

// --- Events -------------------------------------------------------------------

/** An ISO date WITH its offset (or Z): a time without a zone is never guessed. */
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** An instant from an OpenAgenda timing, or undefined. */
export function instant(value) {
  if (typeof value !== 'string' || value.length > 40 || !ZONED.test(value)) return undefined;
  // `+0200` is read like `+02:00`.
  const t = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? t : undefined;
}

const PREFIX = {
  3: { fr: 'En ligne : ', en: 'Online: ' },
  5: { fr: 'Complet : ', en: 'Full: ' },
};
const ONLINE = { fr: 'En ligne', en: 'Online' };
const T = {
  source: { fr: 'Source', en: 'Source' },
  licence: { fr: 'licence', en: 'licence' },
  noLicence: { fr: 'licence non indiquée', en: 'licence not stated' },
  updated: { fr: 'mis à jour le', en: 'updated' },
};
const word = (table, lang) => table[lang === 'fr' ? 'fr' : 'en'];

/** `{ licence, licensor }` names of an event's `rights` (undefined when absent). */
export function rightsOf(rights) {
  const licence = own(rights, 'license');
  const licensor = own(rights, 'licensor');
  const name = (v) =>
    clean(typeof v === 'string' ? v : pick(own(v, 'name'), 'fr'), 120) || undefined;
  return { licence: name(licence), licensor: name(licensor) };
}

/** The attribution line OpenAgenda asks for: licensor, licence, date of the last update. */
export function attribution({ licence, licensor, updated }, lang) {
  const parts = [
    `${word(T.source, lang)}${lang === 'fr' ? ' : ' : ': '}${licensor ? `${licensor} via ` : ''}OpenAgenda`,
  ];
  parts.push(licence ? `${word(T.licence, lang)} ${licence}` : word(T.noLicence, lang));
  if (updated !== undefined)
    parts.push(`${word(T.updated, lang)} ${new Date(updated).toISOString().slice(0, 10)}`);
  return parts.join(', ');
}

/**
 * The occurrences of one event that overlap [from, to), in Gladys' words:
 * `{ id, start, end, name, description, location, url }`, plus the counts of
 * what was left out. A cancelled or postponed event gives none.
 */
export function occurrencesOf(event, { lang, from, to }) {
  const result = { occurrences: [], skipped: 0, rights: undefined };
  const uid = uidOf(own(event, 'uid'));
  if (uid === undefined || own(event, 'removed') === true) return { ...result, skipped: 1 };
  const status = own(event, 'status');
  if (SKIPPED_STATUS.includes(status)) return { ...result, skipped: 1 };
  const title = clean(pick(own(event, 'title'), lang), EVENT_NAME_MAX);
  if (!title) return { ...result, skipped: 1 };
  const timings = own(event, 'timings');
  if (!Array.isArray(timings)) return { ...result, skipped: 1 };
  const prefix = PREFIX[status] ? word(PREFIX[status], lang) : '';
  const name = clean(`${prefix}${title}`, EVENT_NAME_MAX);
  const rights = rightsOf(own(event, 'rights'));
  const updatedRaw = own(event, 'updatedAt');
  const updated =
    typeof updatedRaw === 'string' && updatedRaw.length <= 40 ? Date.parse(updatedRaw) : NaN;
  const credit = attribution(
    { ...rights, updated: Number.isFinite(updated) ? updated : undefined },
    lang,
  );
  const summary = clean(
    pick(own(event, 'description'), lang),
    EVENT_DESCRIPTION_MAX - credit.length - 2,
  );
  const description = clean(summary ? `${summary} — ${credit}` : credit, EVENT_DESCRIPTION_MAX);
  const loc = own(event, 'location');
  const online = own(event, 'attendanceMode') === 2;
  const place = [clean(own(loc, 'name'), 200), clean(own(loc, 'address'), 250)].filter(Boolean);
  const location = online ? word(ONLINE, lang) : clean(place.join(', '), LOCATION_MAX) || undefined;
  const url = safeUrl(own(event, 'canonicalUrl'));
  const seen = new Set();
  // 800 timings at most per event (the API's own bound).
  for (const timing of timings.slice(0, 800)) {
    const start = instant(own(timing, 'begin'));
    const end = instant(own(timing, 'end'));
    if (start === undefined || end === undefined || end < start || end - start > MAX_TIMING) {
      result.skipped += 1;
      continue;
    }
    // In the window: start < to and (end > from, or a zero-length one starting at from).
    if (!(start < to && (end > from || start >= from))) continue;
    const id = `${uid}-${Math.floor(start / 1000)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.occurrences.push({ id, start, end, name, description, location, url });
  }
  result.timings = timings.length;
  result.rights = rights;
  return result;
}

/**
 * One page of GET /v2/agendas/{uid}/events: `{ events, after, total }`.
 * `after` is the cursor of the next page (an array of up to 8 short values),
 * null at the end. An envelope that does not read is a DataError.
 */
export function parseEventsPage(json) {
  const events = own(json, 'events');
  if (!Array.isArray(events) || events.length > PAGE_SIZE * 3) {
    throw new DataError('No event list in the answer');
  }
  const after = own(json, 'after');
  let next = null;
  if (Array.isArray(after) && after.length > 0) {
    if (
      after.length > 8 ||
      !after.every(
        (v) => (typeof v === 'string' && /^[\w.:-]{1,64}$/.test(v)) || Number.isFinite(v),
      )
    ) {
      throw new DataError('Unreadable page cursor');
    }
    next = after.map(String);
  } else if (after !== null && after !== undefined && !Array.isArray(after)) {
    throw new DataError('Unreadable page cursor');
  }
  const total = own(json, 'total');
  return {
    events,
    after: next,
    total: Number.isSafeInteger(total) && total >= 0 ? total : undefined,
  };
}
