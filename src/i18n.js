// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (the connection status and the answer of the
// "Test the key" button). Every text is a { en, fr } object: Gladys picks the
// user's language. No text ever carries the key, nor an entry a user typed.
// -----------------------------------------------------------------------------

const reasons = {
  refused: { en: 'OpenAgenda refused the key', fr: 'OpenAgenda a refusé la clé' },
  forbidden: {
    en: 'agenda not readable with this key (403: private agenda?)',
    fr: 'agenda non lisible avec cette clé (403 : agenda privé ?)',
  },
  not_found: { en: 'agenda not found (404)', fr: 'agenda introuvable (404)' },
  rate_limited: {
    en: 'OpenAgenda asked to slow down (429)',
    fr: 'OpenAgenda demande de ralentir (429)',
  },
  server: { en: 'OpenAgenda is unavailable (5xx)', fr: 'OpenAgenda est indisponible (5xx)' },
  http: { en: 'unexpected HTTP answer', fr: 'réponse HTTP inattendue' },
  network: { en: 'network error', fr: 'erreur réseau' },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  invalid: { en: 'unreadable answer', fr: 'réponse illisible' },
  data: { en: '/data cannot be written', fr: '/data ne peut pas être écrit' },
};
export const REASON_CODES = Object.keys(reasons);
export const reason = (code, lang) => (reasons[code] ?? reasons.invalid)[lang];

const both = (fn) => ({ en: fn('en'), fr: fn('fr') });
/** A wall date as `2026-11-14 15:20 UTC`. */
export const when = (t) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const problems = {
  no_agenda: { en: 'no agenda given', fr: 'aucun agenda indiqué' },
  too_many: {
    en: 'more than 10 agendas (the first 10 are followed)',
    fr: 'plus de 10 agendas (les 10 premiers sont suivis)',
  },
  bad_entry: { en: 'an entry is not an agenda', fr: 'une entrée n’est pas un agenda' },
  bad_city: { en: 'unreadable city', fr: 'ville illisible' },
  unknown: { en: 'agenda not found on OpenAgenda', fr: 'agenda introuvable sur OpenAgenda' },
};

export const T = {
  starting: { en: 'Starting…', fr: 'Démarrage…' },
  storeUnreadable: {
    en: '/data unreadable: read again every 10 s, nothing asked to OpenAgenda meanwhile',
    fr: '/data illisible : relu toutes les 10 s, rien n’est demandé à OpenAgenda en attendant',
  },
  configUnreadable: (at) =>
    both((l) =>
      l === 'en'
        ? `Configuration not read from Gladys: asked again at ${when(at)}`
        : `Configuration non lue depuis Gladys : redemandée à ${when(at)}`,
    ),
  accountsUnreadable: (at) =>
    both((l) =>
      l === 'en'
        ? `The users' accounts were not read from Gladys: asked again at ${when(at)}`
        : `Les comptes des utilisateurs n’ont pas été lus depuis Gladys : redemandés à ${when(at)}`,
    ),
  missing: {
    en: 'Enter your OpenAgenda public key in the configuration',
    fr: 'Saisissez votre clé publique OpenAgenda dans la configuration',
  },
  malformed: {
    en: 'The key does not look like an OpenAgenda key (16 to 128 characters, no space)',
    fr: 'La clé ne ressemble pas à une clé OpenAgenda (16 à 128 caractères, sans espace)',
  },
  secret_key: {
    en: 'This is a SECRET key (oa_sk_…): enter the PUBLIC key (oa_pk_…), reading is all this integration does',
    fr: 'Ceci est une clé SECRÈTE (oa_sk_…) : saisissez la clé PUBLIQUE (oa_pk_…), l’intégration ne fait que lire',
  },
  refused: {
    en: 'OpenAgenda refused the key: nothing is asked any more until the key changes or the "Test the key" button succeeds',
    fr: 'OpenAgenda a refusé la clé : plus rien n’est demandé tant que la clé ne change pas ou que le bouton « Tester la clé » ne réussit pas',
  },
  status: (s) =>
    both((l) => {
      const parts = [];
      if (s.users === 0) {
        parts.push(
          l === 'en'
            ? 'Key saved. No user has enabled the integration yet ("My calendars" block)'
            : 'Clé enregistrée. Aucun utilisateur n’a encore activé l’intégration (bloc « Mes calendriers »)',
        );
      } else {
        parts.push(
          l === 'en'
            ? `${s.agendas} agenda(s) followed for ${s.users} user(s), ${s.ok} read`
            : `${s.agendas} agenda(s) suivi(s) pour ${s.users} utilisateur(s), ${s.ok} lu(s)`,
        );
      }
      if (s.readAt !== undefined) {
        parts.push(
          l === 'en' ? `last read ${when(s.readAt)}` : `dernière lecture ${when(s.readAt)}`,
        );
      }
      if (s.failing > 0) {
        parts.push(
          l === 'en'
            ? `${s.failing} in error (${reason(s.error, l)})`
            : `${s.failing} en erreur (${reason(s.error, l)})`,
        );
      }
      if (s.problems.length > 0) {
        const list = s.problems.map((p) => problems[p][l]).join(', ');
        parts.push(l === 'en' ? `account entries to fix: ${list}` : `comptes à corriger : ${list}`);
      }
      if (s.pauseUntil !== undefined) {
        parts.push(
          l === 'en'
            ? `paused until ${when(s.pauseUntil)} (${reason(s.pauseCode, l)})`
            : `en pause jusqu’à ${when(s.pauseUntil)} (${reason(s.pauseCode, l)})`,
        );
      }
      if (s.gladysError) {
        parts.push(
          l === 'en'
            ? 'Gladys refused or did not take some calendar writes (sent again 5, 15, 30 min, then every hour)'
            : 'Gladys a refusé ou pas pris des écritures de calendrier (renvoyées 5, 15, 30 min, puis toutes les heures)',
        );
      }
      if (s.dataError) parts.push(reason('data', l));
      return `${parts.join(' · ')}.`;
    }),
  testStarting: {
    en: 'The integration is starting: try again in a few seconds',
    fr: 'L’intégration démarre : réessayez dans quelques secondes',
  },
  testTooSoon: (s) =>
    both((l) =>
      l === 'en'
        ? `Asked a moment ago: try again in ${s} s`
        : `Demandé à l’instant : réessayez dans ${s} s`,
    ),
  testPaused: (at, code) =>
    both((l) =>
      l === 'en'
        ? `Paused until ${when(at)} (${reason(code, l)}): nothing asked`
        : `En pause jusqu’à ${when(at)} (${reason(code, l)}) : rien n’a été demandé`,
    ),
  testOk: (s) =>
    both((l) => {
      const head = l === 'en' ? 'Key accepted by OpenAgenda.' : 'Clé acceptée par OpenAgenda.';
      if (s.agendas.length === 0) {
        return `${head} ${l === 'en' ? 'No agenda followed yet.' : 'Aucun agenda suivi pour l’instant.'}`;
      }
      const list = s.agendas
        .map((a) => {
          const all = [...a.licences];
          if (a.unstated) all.push(l === 'en' ? 'licence not stated' : 'licence non indiquée');
          let lic = all.join(', ');
          if (!a.read) lic = l === 'en' ? 'not read yet' : 'pas encore lu';
          else if (!lic) lic = l === 'en' ? 'no event' : 'aucun événement';
          return `${a.title} (${lic})`;
        })
        .join(' ; ');
      return `${head} ${l === 'en' ? 'Agendas and data licences' : 'Agendas et licences des données'} : ${list}`.slice(
        0,
        900,
      );
    }),
  testRefused: {
    en: 'OpenAgenda refused the key: check it (public key oa_pk_…, account settings, "API key")',
    fr: 'OpenAgenda a refusé la clé : vérifiez-la (clé publique oa_pk_…, paramètres du compte, « Clé d’API »)',
  },
  testFailed: (code) =>
    both((l) =>
      l === 'en' ? `Test failed: ${reason(code, l)}` : `Échec du test : ${reason(code, l)}`,
    ),
};

/** The calendar description, in the user's language (≤ 500 characters, cut by the caller). */
export function calendarDescription(
  { slug, uid, licences, unstated, licensors, readAt, truncated, max },
  lang,
) {
  const fr = lang === 'fr';
  const link = slug ? `https://openagenda.com/${slug}` : `OpenAgenda ${uid}`;
  const parts = [fr ? `Agenda OpenAgenda ${link}.` : `OpenAgenda agenda ${link}.`];
  if (licences !== undefined) {
    const all = [...licences];
    if (unstated || all.length === 0) all.push(fr ? 'non indiquée' : 'not stated');
    const lic = all.join(', ');
    parts.push(fr ? `Licence des données : ${lic}.` : `Data licence: ${lic}.`);
  }
  if (licensors?.length)
    parts.push(fr ? `Sources : ${licensors.join(', ')}.` : `Sources: ${licensors.join(', ')}.`);
  if (readAt !== undefined) parts.push(fr ? `Lu le ${when(readAt)}.` : `Read ${when(readAt)}.`);
  if (truncated) {
    parts.push(
      fr
        ? `Limité aux ${max} premiers créneaux (réglage « Créneaux par agenda »).`
        : `Limited to the first ${max} time slots ("Time slots per agenda" setting).`,
    );
  }
  return parts.join(' ');
}
