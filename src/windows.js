// -----------------------------------------------------------------------------
// The pushes to the Gladys calendar of one user: the occurrences of an agenda
// cut into DISJOINT sub-windows covering [FAR_FROM, FAR_TO), at most 500
// events each, an occurrence straddling a boundary included in every
// sub-window it overlaps (one window, one request: a window request replaces
// the window's content with its own list, capabilities/calendar-type.md).
// Covering the whole time line, the pushes leave in Gladys exactly the
// occurrences of the last read: one gone from the agenda is pruned.
// -----------------------------------------------------------------------------

import { EVENTS_PER_REQUEST, FAR_FROM, FAR_TO } from './constants.js';

/** The core's overlap rule: start < to and (end > from, or start >= from). */
export const overlaps = (o, from, to) => o.start < to && (o.end > from || o.start >= from);

/**
 * `{ windows: [{ from, to, items }], dropped }`: the sub-windows, in order,
 * each with the occurrences overlapping it (≤ `max`). Only a degenerate
 * agenda (more than `max` occurrences at one instant) drops some: the
 * latest-starting of the crowded slot, counted in `dropped`.
 */
export function splitWindows(
  occurrences,
  { max = EVENTS_PER_REQUEST, from = FAR_FROM, to = FAR_TO } = {},
) {
  let items = occurrences
    .filter((o) => overlaps(o, from, to))
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1));
  let dropped = occurrences.length - items.length;
  const windows = [];
  const members = (lo, hi) => items.filter((o) => overlaps(o, lo, hi));
  let lo = from;
  // Each turn either closes a window (lo moves on) or drops at least one
  // occurrence: the loop ends.
  for (let guard = 0; guard < 100_000; guard += 1) {
    const rest = members(lo, to);
    if (rest.length <= max) {
      windows.push({ from: lo, to, items: rest });
      return { windows, dropped };
    }
    const starts = [...new Set(items.map((o) => o.start).filter((s) => s > lo && s < to))];
    // The count grows with the upper bound: the largest bound that fits.
    let low = 0;
    let high = starts.length - 1;
    let best = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (members(lo, starts[mid]).length <= max) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best >= 0) {
      const hi = starts[best];
      windows.push({ from: lo, to: hi, items: members(lo, hi) });
      lo = hi;
      continue;
    }
    // Too many at once before the next start: the latest-starting go. The
    // ones straddling `lo` come first and were all in the previous window
    // (≤ max), so only occurrences starting at or after `lo`, in no earlier
    // window, are dropped.
    const crowd = members(lo, starts[0] ?? to);
    const drop = new Set(crowd.slice(max).map((o) => o.id));
    items = items.filter((o) => !drop.has(o.id));
    dropped += drop.size;
  }
  throw new Error('splitWindows did not end');
}

/** The Gladys events of one user for the occurrences of a window (ids user-scoped). */
export function toGladysEvents(items, idOf) {
  return items.map((o) => {
    const event = {
      external_id: idOf(o.id),
      name: o.name,
      start: new Date(o.start).toISOString(),
      end: new Date(o.end).toISOString(),
      description: o.description,
    };
    if (o.location) event.location = o.location;
    if (o.url) event.url = o.url;
    return event;
  });
}
