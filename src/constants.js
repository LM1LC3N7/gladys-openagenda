// -----------------------------------------------------------------------------
// Fixed values of the integration: the OpenAgenda API v2, the bounds of what is
// read and pushed, and the rhythm of the requests. Times are in milliseconds.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
export const USER_AGENT = `gladys-openagenda/${VERSION} (+https://github.com/LM1LC3N7/gladys-openagenda)`;

/** The only host ever asked: the official OpenAgenda API v2. */
export const API_BASE = 'https://api.openagenda.com/v2';
/** The key travels in this header (never in the URL: it would land in logs). */
export const API_KEY_HEADER = 'key';

// Configuration keys (manifest config_schema) and account keys (account_schema).
export const CONFIG_KEY = 'api_key';
export const CONFIG_REFRESH = 'refresh_hours';
export const CONFIG_HORIZON = 'horizon_days';
export const CONFIG_MAX_EVENTS = 'max_events';
export const ACCOUNT_AGENDAS = 'agendas';
export const ACCOUNT_CITY = 'city';
export const ACTION_TEST = 'test_key';

export const DEFAULTS = { refresh_hours: 6, horizon_days: 60, max_events: 500 };
export const BOUNDS = {
  refresh_hours: [2, 24],
  horizon_days: [7, 365],
  max_events: [50, 2000],
};

export const MIN_KEY_LENGTH = 16;
export const MAX_KEY_LENGTH = 128;
/** At most this many agendas per user (the core takes 50 calendars per user). */
export const MAX_AGENDAS = 10;
export const MAX_CITY_LENGTH = 80;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Events per page (the API takes 300 at most) and pages per agenda read. */
export const PAGE_SIZE = 100;
export const MAX_PAGES = 25;
/** Pages read for the past part (yesterday) when the upcoming one was cut early. */
export const PAST_PAGES = 5;
/** One answer of the API: bounded in size and in time. */
export const MAX_ANSWER_BYTES = 6 * 1024 * 1024;
export const HTTP_TIMEOUT = 20 * SECOND;
/** The key test answers well within the 30 s the manifest gives the action. */
export const TEST_TIMEOUT = 10 * SECOND;
/** Two requests to the API never leave closer than this. */
export const MIN_GAP = 2 * SECOND;
/** The key test button: once every 10 seconds at most. */
export const TEST_GAP = 10 * SECOND;
/** An agenda read again after a failure: 5 min, 15 min, 30 min, 1 h, then the refresh interval. */
export const RETRY_STEPS = [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR];
/** A pause after a 429 or a 5xx: Retry-After, bounded; 10 min by default, doubled up to 6 h. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_DEFAULT = 10 * MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The agenda names (titles, slugs) are read again once a day. */
export const AGENDA_TTL = DAY;
/** A timer never sleeps longer (a wall clock that jumps is caught up). */
export const MAX_SLEEP = HOUR;

/** The Gladys core takes 30 calendar writes a minute per integration: the module keeps under 25. */
export const WRITES_PER_MINUTE = 25;
/** A Gladys 429 on a write: waited out, then the same write again, 3 times at most. */
export const GLADYS_RETRY = MINUTE;
export const GLADYS_RETRIES = 3;
/** Events per request to the core (500 at most, the straddling ones included). */
export const EVENTS_PER_REQUEST = 500;
/**
 * The pushed windows cover everything the integration ever pushed in a
 * calendar: from this date to FAR_TO. An occurrence that left the agenda, or
 * that ended before the read window, is pruned by the core.
 */
export const FAR_FROM = Date.UTC(2000, 0, 1);
export const FAR_TO = Date.UTC(2100, 0, 1);
/** The read window starts a day back (yesterday's events stay a day). */
export const PAST = DAY;
/** A timing longer than this is not read (the API caps them at 24 h). */
export const MAX_TIMING = 48 * HOUR;

/** /data: one JSON file, bounded. */
export const MAX_STATE_BYTES = 32 * 1024 * 1024;
/** What is written stays well under what is read back. */
export const MAX_SAVE_BYTES = 16 * 1024 * 1024;
export const STORE_RETRY = 10 * SECOND;
export const LOAD_TIMEOUT = 10 * SECOND;
export const SAVE_TIMEOUT = 10 * SECOND;
export const STATUS_TIMEOUT = 5 * SECOND;
export const CONFIG_RETRY = 10 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** A Gladys read (accounts, calendars) that does not answer in time is a failure. */
export const GLADYS_TIMEOUT = 20 * SECOND;

/** Gladys field bounds (capabilities/calendar-type.md). */
export const NAME_MAX = 100;
export const CAL_DESCRIPTION_MAX = 500;
export const EVENT_NAME_MAX = 200;
export const EVENT_DESCRIPTION_MAX = 1000;
export const LOCATION_MAX = 500;
export const URL_MAX = 500;

/** Status codes of an OpenAgenda event that are left out (4 postponed, 6 cancelled). */
export const SKIPPED_STATUS = [4, 6];
/** Languages asked to the API (`monolingual`); any other user language reads French. */
export const LANGUAGES = ['fr', 'en', 'de', 'it', 'es', 'nl'];
/** Fields asked for each event (includeFields): nothing else is read. */
export const EVENT_FIELDS = [
  'uid',
  'title',
  'description',
  'timings',
  'location',
  'status',
  'attendanceMode',
  'onlineAccessLink',
  'canonicalUrl',
  'rights',
  'updatedAt',
];
