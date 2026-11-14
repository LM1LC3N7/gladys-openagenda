// -----------------------------------------------------------------------------
// The only place that talks to the network: `fetch` with a timeout, the
// module's User-Agent, the key in its `key` header (never in the URL), and a
// body read up to a bound, never whole. Only api.openagenda.com is asked; no
// redirect is followed (the key never leaves for another host). The key never
// appears in an error, a log or a URL. Taken from gladys-aeso.
// -----------------------------------------------------------------------------

import { API_KEY_HEADER, HTTP_TIMEOUT, USER_AGENT } from './constants.js';

export class SourceError extends Error {
  /**
   * `code`: 'refused' (401), 'forbidden' (403: the caller decides what it
   * means on its route), 'not_found' (404), 'rate_limited' (429), 'server'
   * (5xx), 'http', 'network', 'timeout', 'too_large', 'invalid'.
   */
  constructor(code, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent or invalid. */
export function retryAfterMs(value, now) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  if (/^\d{1,9}$/.test(value.trim())) return Number(value.trim()) * 1000;
  // An HTTP date names its day and month: a bare number or sign is not one.
  if (!/^[A-Za-z]{3}, /.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The body as text, refused past `limit` bytes (read in chunks, never whole). */
export async function readBounded(response, limit) {
  const tooLarge = () => new SourceError('too_large', `The answer is larger than ${limit} bytes`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function networkError(err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return timedOut
    ? new SourceError('timeout', 'OpenAgenda did not answer in time')
    : new SourceError('network', 'OpenAgenda is unreachable (network error)');
}

/**
 * GET the JSON answer of `url` with the key: resolves the parsed body, throws
 * a SourceError otherwise. `limit` bounds the body, `timeout` the whole
 * exchange (body included).
 */
export async function getJson(
  url,
  { key, limit, fetchImpl = globalThis.fetch, now = Date.now, timeout = HTTP_TIMEOUT } = {},
) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    [API_KEY_HEADER]: key,
  };
  let response;
  const signal = AbortSignal.timeout(Math.max(1, timeout));
  try {
    response = await fetchImpl(url, { headers, signal, redirect: 'error' });
  } catch (err) {
    throw networkError(err);
  }
  const { status } = response;
  if (status === 200) {
    let body;
    try {
      body = await readBounded(response, limit);
    } catch (err) {
      throw err instanceof SourceError ? err : networkError(err);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new SourceError('invalid', 'OpenAgenda answered something else than JSON');
    }
  }
  await response.body?.cancel?.().catch(() => {});
  if (status === 401)
    throw new SourceError('refused', 'OpenAgenda refused the key (401)', { status });
  if (status === 403) throw new SourceError('forbidden', 'OpenAgenda answered 403', { status });
  if (status === 404) throw new SourceError('not_found', 'OpenAgenda answered 404', { status });
  if (status === 429) {
    const served = Date.parse(response.headers?.get?.('date') ?? '');
    throw new SourceError('rate_limited', 'OpenAgenda asked to slow down (429)', {
      status,
      retryAfter: retryAfterMs(
        response.headers?.get?.('retry-after'),
        Number.isFinite(served) ? served : now(),
      ),
    });
  }
  if (status >= 500) {
    throw new SourceError('server', `OpenAgenda answered ${status}`, {
      status,
      retryAfter: retryAfterMs(response.headers?.get?.('retry-after'), now()),
    });
  }
  throw new SourceError('http', `OpenAgenda answered ${status}`, { status });
}
