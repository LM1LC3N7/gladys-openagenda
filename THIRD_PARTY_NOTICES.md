# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). Its
code is its own: no third-party code is copied or ported.

## OpenAgenda API v2 (data)

At run time the integration reads the official OpenAgenda API v2,
`https://api.openagenda.com/v2` (agendas list and events of an agenda), with
the public API key of the administrator's OpenAgenda account. Using the API
means accepting the OpenAgenda terms (<https://developers.openagenda.com/licence>).
"OpenAgenda" is a name of its owner, used here only to say which data is read.

The events are the data of their publishers, under the licence each one sets,
event by event (the `rights` field): most often the Licence Ouverte / Etalab
2.0 (<https://www.etalab.gouv.fr/licence-ouverte-open-licence>), which requires
crediting the source and the date of the last update. The integration shows the
licensor, the licence and that date in the description of every event it
pushes, and the licences seen in the description of every calendar. Nothing of
these data is shipped in this repository nor in the Docker image (the test
fixtures are made up).

Changes made to the data: each timing of an event becomes a separate event;
texts are cut to the Gladys bounds (name 200, description 1,000, place 500
characters) and their control characters removed; the "full" and "online"
statuses become a prefix of the name; cancelled and postponed events are left
out.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), the Gladys SDK.
