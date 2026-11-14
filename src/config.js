// -----------------------------------------------------------------------------
// The configuration of the form (the administrator's: the OpenAgenda key and
// the rhythm) and the account of each user (their agendas, an optional city),
// normalized. Nothing here talks to the network; no text built here carries
// the key or repeats an entry the user typed.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  ACCOUNT_AGENDAS,
  ACCOUNT_CITY,
  BOUNDS,
  CONFIG_HORIZON,
  CONFIG_KEY,
  CONFIG_MAX_EVENTS,
  CONFIG_REFRESH,
  DEFAULTS,
  LANGUAGES,
  MAX_AGENDAS,
  MAX_CITY_LENGTH,
  MAX_KEY_LENGTH,
  MIN_KEY_LENGTH,
} from './constants.js';

/** Printable ASCII without space: never a control character (CR, LF, tab) in a header. */
const KEY = /^[\x21-\x7e]+$/;

/** An integer of the form, bounded; the default when absent or unreadable. */
function boundedInteger(value, name) {
  const [min, max] = BOUNDS[name];
  let n = value;
  if (typeof n === 'string' && /^\s*\d{1,6}\s*$/.test(n)) n = Number(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULTS[name];
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * `{ key, problem, refreshHours, horizonDays, maxEvents }`: `problem`
 * ('missing', 'malformed', 'secret_key') keeps anything from being sent.
 */
export function normalizeConfig(raw) {
  const form = raw && typeof raw === 'object' ? raw : {};
  const out = {
    key: '',
    problem: undefined,
    refreshHours: boundedInteger(form[CONFIG_REFRESH], CONFIG_REFRESH),
    horizonDays: boundedInteger(form[CONFIG_HORIZON], CONFIG_HORIZON),
    maxEvents: boundedInteger(form[CONFIG_MAX_EVENTS], CONFIG_MAX_EVENTS),
  };
  const value = form[CONFIG_KEY];
  if (value === undefined || value === null) return { ...out, problem: 'missing' };
  if (typeof value !== 'string') return { ...out, problem: 'malformed' };
  const key = value.trim();
  if (!key) return { ...out, problem: 'missing' };
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !KEY.test(key)) {
    return { ...out, problem: 'malformed' };
  }
  // A secret key can write to the agendas of its owner: this module only
  // reads, the public key is enough and is never kept.
  if (/^oa_sk_/i.test(key)) return { ...out, problem: 'secret_key' };
  return { ...out, key };
}

/**
 * 8 bits of a salted hash of a refused key: enough to keep a restart from
 * sending the same key again, nothing to find it back from (one key in 256
 * shares any tag).
 */
export const tagOf = (salt, key) =>
  createHash('sha256').update(`${salt}\u0000${key}`, 'utf8').digest()[0];

/** A refusal read back from /data: `{ salt, tag }`, or undefined. */
export function validRefused(value) {
  return value &&
    typeof value === 'object' &&
    typeof value.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(value.salt) &&
    Number.isInteger(value.tag) &&
    value.tag >= 0 &&
    value.tag < 256
    ? { salt: value.salt, tag: value.tag }
    : undefined;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const UID = /^[1-9]\d{0,11}$/;

/**
 * One agenda reference: an uid (digits), a slug, or a link to
 * openagenda.com (`/agendas/<uid>`, `/<slug>`, `/<lang>/<slug>`, with or
 * without the rest of the path). Returns `{ uid }`, `{ slug }` or undefined.
 */
export function parseAgenda(text) {
  if (typeof text !== 'string') return undefined;
  const entry = text.trim();
  if (!entry || entry.length > 300) return undefined;
  if (UID.test(entry)) return { uid: Number(entry) };
  let path;
  const link = /^(?:https?:\/\/)?(?:www\.)?openagenda\.com(\/[^?#\s]*)?(?:[?#]\S*)?$/i.exec(entry);
  if (link) {
    path = (link[1] ?? '/').split('/').filter(Boolean);
    if (path.length > 0 && /^[a-z]{2}$/i.test(path[0]) && path.length > 1) path = path.slice(1);
    if (path.length === 0) return undefined;
    if (path[0].toLowerCase() === 'agendas') {
      return path[1] && UID.test(path[1]) ? { uid: Number(path[1]) } : undefined;
    }
    const slug = path[0].toLowerCase();
    return SLUG.test(slug) ? { slug } : undefined;
  }
  const slug = entry.toLowerCase();
  return SLUG.test(slug) ? { slug } : undefined;
}

/** The language the API is asked in for a user ('fr' unless one of LANGUAGES). */
export function languageOf(user) {
  const lang = typeof user?.language === 'string' ? user.language.slice(0, 2).toLowerCase() : '';
  return LANGUAGES.includes(lang) ? lang : 'fr';
}

/** A city name, as OpenAgenda writes it (adminLevel4), or undefined; `false` when unreadable. */
function normalizeCity(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return false;
  const city = value.trim().replace(/\s+/g, ' ');
  if (!city) return undefined;
  if (city.length > MAX_CITY_LENGTH || !/^[\p{L}\p{M}0-9 '’.()-]+$/u.test(city)) return false;
  return city;
}

/**
 * One enabled user, from GET /calendar/account: `{ user, lang, refs, city,
 * problem }`. `problem`: 'no_agenda', 'too_many', 'bad_entry' (with the
 * 1-based `entry` number, never the text), 'bad_city'. `refs` keeps the
 * readable entries even when one is not, in their order, without duplicates.
 */
export function normalizeAccount(account) {
  const selector = account?.user?.selector;
  if (
    typeof selector !== 'string' ||
    !selector ||
    selector.length > 200 ||
    selector.includes(':')
  ) {
    return undefined;
  }
  const config = account.config && typeof account.config === 'object' ? account.config : {};
  const out = {
    user: selector,
    lang: languageOf(account.user),
    refs: [],
    city: undefined,
    problem: undefined,
    entry: undefined,
  };
  const city = normalizeCity(config[ACCOUNT_CITY]);
  if (city === false) out.problem = 'bad_city';
  else out.city = city;
  const raw = typeof config[ACCOUNT_AGENDAS] === 'string' ? config[ACCOUNT_AGENDAS] : '';
  const entries = raw
    .slice(0, 4000)
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (entries.length === 0) {
    out.problem ??= 'no_agenda';
    return out;
  }
  const seen = new Set();
  for (const [i, text] of entries.entries()) {
    const ref = parseAgenda(text);
    if (!ref) {
      if (!out.problem) {
        out.problem = 'bad_entry';
        out.entry = i + 1;
      }
      continue;
    }
    const id = ref.uid !== undefined ? `u${ref.uid}` : `s${ref.slug}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (out.refs.length >= MAX_AGENDAS) {
      out.problem ??= 'too_many';
      break;
    }
    out.refs.push(ref);
  }
  return out;
}
