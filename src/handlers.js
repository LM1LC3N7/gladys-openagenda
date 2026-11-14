// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container. Every handler is registered
// before connect(). Read-only: the calendars are pushed, nothing is ever
// written back to OpenAgenda.
// -----------------------------------------------------------------------------

import { ACTION_TEST } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Configuration screen button.
  gladys.onAction(ACTION_TEST, () => app.testKey());

  // Configuration saved by the administrator: a new key is tried at once
  // (never sooner than 2 s after the last request).
  gladys.onConfigUpdated((config) => app.configure(config));

  // A user enabled, disabled or changed their account, or toggled a calendar:
  // accounts and calendars read again, nothing asked to OpenAgenda for that.
  gladys.onCalendarAccountUpdated((user) => app.accountUpdated(user));

  // Every connection (the first one and each reconnection): /data once, the
  // configuration and the accounts read again (retried for ever), the
  // calendars republished from the last reads.
  gladys.on('connected', async () => {
    try {
      await app.connected();
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  });
  gladys.on('disconnected', () => {
    app.stop().catch((err) => logger?.error(`Stop failed (${err?.name ?? 'Error'})`));
  });
  gladys.handleShutdown(() => app.stop());
}
