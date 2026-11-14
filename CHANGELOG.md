# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- OpenAgenda agendas as Gladys calendars (`type: calendar`): each user enables
  the integration in "My calendars" and lists up to 10 agendas (link, short
  name or number), optionally a city; one private calendar per agenda, its
  published events from yesterday to the horizon (60 days by default), one
  Gladys event per timing, in the user's language.
- Read from the official API v2 with the administrator's free public key
  (`key` header, never logged nor kept in /data; a secret key is refused),
  once per refresh interval (6 h by default, 2 h at least), all pages in a
  row, 2 s apart; a restart, a reconnection or a toggle republish the last read
  kept in /data instead of reading again.
- The data licence, event by event (`rights`): licensor, licence and date of
  the last update in each event, the licences and sources seen in each
  calendar, listed agenda by agenda by the "Test the key" button.
- Cancelled and postponed events left out; "Full:" and "Online:" marked; an
  event gone from the agenda is pruned at the next read; a read cut short pushes
  nothing.
- A refused key (401/403 on the agendas list) stops every automatic request,
  across restarts, until the key changes or the button succeeds; a 403 on one
  agenda is never a refused key. 429 and 5xx pause every request (Retry-After,
  bounded, kept in /data).
- At most 25 calendar writes a minute (the core takes 30), a Gladys 429 waited
  out; more than 500 events cut into disjoint sub-windows.
- `countries: ["FR", "BE", "CH", "LU"]` in the manifest (Gladys 5.3.0 or later).

[Unreleased]: https://github.com/LM1LC3N7/gladys-openagenda/commits/main
