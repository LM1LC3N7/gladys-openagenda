# OpenAgenda for Gladys Assistant

**Unofficial**, not affiliated with OpenAgenda. Never tested with a real
OpenAgenda key yet: the answer format comes from the official API v2
documentation (developers.openagenda.com, read on 2026-11-14); the test answers
are made up.

A Gladys Assistant external integration of type `calendar`: the cultural agendas
published on OpenAgenda (concerts, exhibitions, shows…) become Gladys calendars,
one per agenda and per user who follows it.

- It reads `https://api.openagenda.com/v2/agendas/{uid}/events` with the
  administrator's free **public** key (`key` header), once per refresh interval
  (6 h by default), from yesterday to 60 days ahead, every timing of an event
  as one Gladys event; cancelled and postponed events are left out.
- Each user enables it in the **My calendars** block and lists up to 10 agendas
  (link, short name or number), optionally one city. The calendars start
  private; shared, they reach the household and the scenes.
- The data licence is set by each publisher, event by event (most often the
  **Licence Ouverte / Etalab 2.0**): it is credited in each event and each
  calendar, and listed by the "Test the key" button.

Guides: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test                 # node --test, virtual clock, a scripted API, the fake Gladys
npm run lint && npm run format:check
node scripts/mutants.mjs # mutation check of the guards (use memcap)
```

Requires Gladys 5.3.0 or later (`type: calendar`, `countries`). Licence:
Apache-2.0 (`LICENSE`); notices in `THIRD_PARTY_NOTICES.md`.
