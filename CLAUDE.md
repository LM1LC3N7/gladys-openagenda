# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** of type `calendar` (Node.js 22+,
ESM, no build step, sandboxed Docker container, `@gladysassistant/integration-sdk`
0.16). It reads the published events of the OpenAgenda agendas each user
follows (official API v2, the administrator's free public key) and pushes them
as Gladys calendars, one per user and agenda. Unofficial. Read-only.

## Commands

```bash
npm install
npm test                                  # node --test (or gi test)
npm run lint && npm run format:check
memcap node scripts/mutants.mjs           # mutation check, one mutant at a time
```

## Architecture

```
index.js            SDK wiring only (src/handlers.js)
src/app.js          App: lifecycle, config, accounts, /data, schedule, requests,
                    refused key, pauses, calendar writes, status, test button
src/openagenda.js   API v2 URLs and strict reading of its answers (pure)
src/windows.js      disjoint sub-windows of at most 500 events (pure)
src/config.js       the form and the accounts normalized, the refused key's tag
src/http.js         the only network access (key header, User-Agent, bounds)
src/store.js        /data state file (missing vs unreadable, atomic write, 0600)
src/i18n.js         status, button and calendar texts (en, fr)
src/constants.js    manifest keys, bounds, rhythm
```

## Module rules

- **Never more than the interval**: an agenda is read once per refresh
  interval (2 h at least); a restart, a reconnection, an account change or a
  toggle republish the last read from /data, never read again; the attempt is
  in /data before the read.
- **Never a partial list**: a read cut short pushes nothing (the windows
  prune what they do not list).
- **The licence**: read event by event (`rights`), credited in every event and
  every calendar; never dropped by a cut (the credit is kept, the summary cut).
- **The key**: never in a URL, a log, a status, /data or an error; a 401/403
  is a refusal only on `/v2/agendas`.
- **Ids are forever**: calendar `<user>:agenda-<uid>`, event
  `<user>:a<uid>-<event uid>-<start s>`, config, account and action keys.
- Bilingual texts (en/fr), CHANGELOG `[Unreleased]`, versions by the Release
  workflow only.

## Rules

- **External ids are forever.** Calendar and event ids are user-scoped
  (`gladys.externalId(`${user}:…`)`, the core's `ext:<selector>:<user>:`
  prefix); changing a rule creates new calendars and orphans the old ones. The
  same goes for every key users store: `config_schema`, `account_schema`,
  `actions`.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except for a hand-pushed release tag, which bumps all three together
  before tagging (0.1.0 was set that way when leaving the template).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`type: "calendar"`: 5.2.0; `countries`: 5.3.0). `test/manifest.test.js`
  ties the manifest to the code (defaults, bounds, keys, action handler):
  change both sides together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
