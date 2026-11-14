# TODO

## Before announcing

- [ ] Review r1 (high: cloud API with a key, read only, no physical action).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.
- [ ] Store field not set in the manifest: `keywords` (OpenAgenda, agenda,
      concerts, expositions, sorties, culture, événements, Licence Ouverte).

## To watch

- [ ] Never tried with a real OpenAgenda key: the endpoints, the `key` header,
      `includeFields[]`, `monolingual`, `timings[gte]`/`[lte]`, `adminLevel4`,
      `sort=timings.asc`, the `after` cursor and the `rights` object come from
      developers.openagenda.com (read on 2026-11-14; the API answered 403
      "could not find user or agenda matching key" without a key). Check the
      first real answers: a field left out by `includeFields[]` (location,
      rights) would only show as an empty place or "licence not stated".
- [ ] OpenAgenda publishes no quota: about 4 requests a day per agenda at the
      default interval (more for an agenda of several hundred events: 100 a
      page). A 429 pauses.
- [ ] `timings[gte]`/`[lte]` may filter on the first/last timing rather than on
      each one: the module keeps only the timings in its window anyway.
- [ ] A private agenda the key can read is not listed by `/v2/agendas`: named
      "OpenAgenda <uid>" (read all the same).

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- `type: calendar`, `gladys_version: ">=5.3.0"`: `countries` (Louis,
  2026-11-12) needs 5.3.0; the calendar type 5.2.0.
- `countries: ["FR", "BE", "CH", "LU"]`: OpenAgenda is French and used by
  French-speaking towns of Belgium, Switzerland and Luxembourg; the search still
  finds it elsewhere.
- Categories `services` (the catalog maps `calendar` there) and `leisure`.
- Licence of the data: read event by event from `rights` (OpenAgenda says one
  agenda can mix licensors); most often Licence Ouverte / Etalab 2.0. Credited
  in each event (licensor, licence, date of the last update, as the Licence
  Ouverte asks) and in each calendar; an event without a licence is kept and
  says "licence not stated" (personal use inside Gladys; the docs ask to check
  the licence before any reuse outside).
- One source = (agenda, language, city): shared by the users alike; one
  calendar per (user, agenda); event ids `<user>:a<agenda>-<event>-<start s>`
  (the agenda is in the id: the same event in two followed agendas stays in
  both calendars; moves renounced).
- The pushed windows cover 2000-01-01 → 2100-01-01, split in disjoint
  sub-windows of at most 500 events: Gladys holds exactly the last read; past
  events older than the read window (yesterday) are pruned, so the 10,000
  events per calendar cap is never reached.
- A calendar is created with its first read (not before), so a user never sees
  an empty calendar named after an unread agenda.
- Cancelled (6) and postponed (4) events left out (a scene must not fire for
  them); full (5) and online (3) prefixed.
- Secret keys (`oa_sk_`) refused: reading needs the public key only.
- A 401/403 is a refused key only on `/v2/agendas` (the key test and the
  agenda names); on one agenda's events it is that agenda (private). When every
  agenda answers so, the key is checked once on `/v2/agendas`.
- 429/5xx: a pause for every request (Retry-After bounded 1 min-6 h, else
  10 min doubled up to 6 h), kept in /data; the sources it held are read as
  soon as it ends, without counting a failure.
- /data not writable: no read (the attempt must be in /data before the read).
- `.github/workflows/ci.yml`: `timeout-minutes: 30` on both jobs (taken from
  the other modules), so the first release tag must be pushed by hand.
