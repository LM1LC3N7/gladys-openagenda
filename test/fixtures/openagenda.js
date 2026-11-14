// -----------------------------------------------------------------------------
// Fictional OpenAgenda answers, shaped like the API v2 documentation
// (developers.openagenda.com: events, structure, agendas). No real data.
// -----------------------------------------------------------------------------

export const LICENCE = {
  name: 'Licence Ouverte v2.0 (Etalab)',
  id: 'etalab-2.0',
  url: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence',
};

/** An ISO date with a +01:00 offset written the OpenAgenda way (`+0100`). */
export function paris(ms) {
  const local = new Date(ms + 3600_000).toISOString().slice(0, 19);
  return `${local}+0100`;
}

let next = 1000;

/** One event: `timings` as [[startMs, endMs], ...]. */
export function event({
  uid = (next += 1),
  title = `Concert ${uid}`,
  timings,
  status = 1,
  rights = { license: LICENCE, licensor: { name: 'Ville de Testville' } },
  attendanceMode = 1,
  location = { name: 'Salle des fêtes', address: '1 place de la Mairie, Testville' },
  ...rest
}) {
  return {
    uid,
    title: { fr: title, en: `${title} (en)` },
    description: { fr: `Description de ${title}`, en: `About ${title}` },
    timings: timings.map(([b, e]) => ({ begin: paris(b), end: paris(e) })),
    status,
    attendanceMode,
    location,
    canonicalUrl: `https://openagenda.com/testville/events/${uid}`,
    rights,
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...rest,
  };
}

/** A page of events. */
export const page = (events, after = null, total = events.length) => ({ total, events, after });

export const AGENDA = { uid: 12345678, slug: 'testville', title: 'Agenda de Testville' };
