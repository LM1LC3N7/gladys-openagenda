// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. When the Gladys
// core is cloned next to this repository (~/code/Gladys), its own manifest
// validator is run too.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNT_AGENDAS,
  ACCOUNT_CITY,
  ACTION_TEST,
  BOUNDS,
  CONFIG_HORIZON,
  CONFIG_KEY,
  CONFIG_MAX_EVENTS,
  CONFIG_REFRESH,
  DEFAULTS,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

function* objects(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* objects(item);
  } else if (node && typeof node === 'object') {
    yield node;
    for (const value of Object.values(node)) yield* objects(value);
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'calendar');
  assert.equal(manifest.gladys_version, '>=5.3.0', 'countries needs Gladys 5.3');
  assert.deepEqual(manifest.categories, ['services', 'leisure']);
  assert.deepEqual(manifest.transports, ['cloud']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /^Unofficial/);
  assert.match(manifest.description.fr, /^Non officiel/);
  assert.equal(manifest.keywords, undefined);
  assert.deepEqual(manifest.countries, ['FR', 'BE', 'CH', 'LU']);
  for (const code of manifest.countries) assert.match(code, /^[A-Z]{2}$/);
});

test('one version everywhere, semver, never pinned by hand twice', () => {
  const semver = /^\d+\.\d+\.\d+$/;
  assert.match(pkg.version, semver);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-openagenda:${pkg.version}`);
  assert.match(manifest.gladys_version, /^>=\d+\.\d+\.\d+$/, 'a range, never one version');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
});

test('every text is bilingual, and the words the rules forbid are absent', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
  const all = [
    'gladys-assistant-integration.json',
    'README.md',
    'docs/en.md',
    'docs/fr.md',
    'src/i18n.js',
    'CHANGELOG.md',
  ]
    .map(read)
    .join('\n');
  assert.doesNotMatch(all, /chiffr|encrypt|hachage/i);
});

test('the configuration: the key is a secret without default, defaults and bounds as in the code', () => {
  for (const field of [...manifest.config_schema, ...manifest.account_schema]) {
    assert.doesNotMatch(field.key, /^gladys_/i);
    for (const link of field.links ?? []) assert.match(link.url, /^https:\/\//);
  }
  const key = manifest.config_schema.find((f) => f.key === CONFIG_KEY);
  assert.equal(key.type, 'secret');
  assert.equal(key.required, true);
  assert.equal(key.default, undefined, 'never a default secret');
  assert.match(
    key.description.en,
    /Kept by Gladys in its database, never shown again, sent only to OpenAgenda/,
  );
  assert.match(
    key.description.fr,
    /Gardée par Gladys dans sa base, jamais réaffichée, envoyée seulement à OpenAgenda/,
  );
  for (const name of [CONFIG_REFRESH, CONFIG_HORIZON, CONFIG_MAX_EVENTS]) {
    const field = manifest.config_schema.find((f) => f.key === name);
    assert.equal(field.default, DEFAULTS[name], name);
    assert.deepEqual([field.min, field.max], BOUNDS[name], name);
  }
  assert.deepEqual(
    manifest.account_schema.filter((f) => f.type !== 'section').map((f) => f.key),
    [ACCOUNT_AGENDAS, ACCOUNT_CITY],
  );
  assert.ok(!manifest.account_schema.some((f) => f.type === 'secret'), 'no secret per user');
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    [ACTION_TEST],
  );
  assert.ok(handlers.includes('onAction(ACTION_TEST'));
  assert.ok(handlers.includes('onCalendarAccountUpdated'));
});

test('the source and its licence are named in the manifest, the docs and the notices', () => {
  const intro = manifest.config_schema.find((f) => f.key === 'intro');
  for (const lang of ['en', 'fr']) {
    assert.match(intro.description[lang], /OpenAgenda/);
    assert.match(intro.description[lang], /Licence Ouverte/);
    assert.match(intro.description[lang], /^(Unofficial|Intégration non officielle)/);
  }
  for (const file of ['README.md', 'docs/en.md', 'docs/fr.md', 'THIRD_PARTY_NOTICES.md']) {
    assert.match(read(file), /api\.openagenda\.com\/v2/, file);
    assert.match(read(file), /Licence Ouverte/, file);
  }
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  assert.doesNotMatch(read('LICENSE'), /Copyright \d{4} [A-Z]/, 'no personal name');
});

test('every select option follows the core rules (label, value, unique)', () => {
  // No feature here: the rule is checked on every select the manifest may carry.
  for (const node of objects(manifest)) {
    if (node.type !== 'select' || !Array.isArray(node.options)) continue;
    const values = node.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length);
    for (const option of node.options) {
      assert.ok(typeof option.value === 'string' || Number.isInteger(option.value));
      for (const l of Object.values(option.label)) assert.equal(typeof l, 'string');
    }
  }
  assert.equal(
    JSON.stringify(manifest).includes('supported_options'),
    false,
    'no feature published',
  );
});

const core = join(homedir(), 'code/Gladys/server/lib');
const coreCloned = existsSync(
  join(core, 'external-integration/externalIntegration.validateManifest.js'),
);

test(
  'the Gladys core validator accepts the manifest',
  { skip: !coreCloned && 'Gladys core not cloned' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'openagenda-core-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const script = `
      const mod = require(${JSON.stringify(join(core, 'external-integration/externalIntegration.validateManifest.js'))});
      const validate = mod.validateManifest ?? mod;
      let out;
      try { validate(${JSON.stringify(manifest)}); out = 'ok'; } catch (err) { out = err.message; }
      console.log('RESULT' + JSON.stringify(out));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT'));
    assert.ok(line, `${result.stdout}\n${result.stderr}`.slice(-2000));
    assert.equal(JSON.parse(line.slice(6)), 'ok');
  },
);
