import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMUNITY, ENTERPRISE, editionLabel, isLegacyTier, normalizeProfile, normalizeTier, pluginsFor } from '../src/editions.mjs';

test('alte Editionsnamen werden auf die neuen abgebildet', () => {
  assert.equal(normalizeTier('free'), COMMUNITY);
  assert.equal(normalizeTier('kette'), ENTERPRISE);
  assert.equal(normalizeTier('community'), COMMUNITY);
  assert.equal(normalizeTier('enterprise'), ENTERPRISE);
  assert.equal(isLegacyTier('free'), true);
  assert.equal(isLegacyTier('enterprise'), false);
});

test('Anzeigenamen und Plugins je Edition', () => {
  assert.equal(editionLabel('community'), 'Community');
  assert.equal(editionLabel('kette'), 'Enterprise (Die Kette)');
  assert.deepEqual(pluginsFor('free'), ['kette-engineering-core']);
  assert.deepEqual(pluginsFor('enterprise'), ['kette-engineering-core', 'kette-engineering']);
});

test('Profil aus 0.1.0 wird gelesen, ohne das Original zu ändern', () => {
  const old = { version: 1, tier: 'kette' };
  assert.deepEqual(normalizeProfile(old), { version: 1, tier: 'enterprise' });
  assert.equal(old.tier, 'kette');
  assert.deepEqual(normalizeProfile({ version: 1 }), { version: 1 });
  assert.equal(normalizeProfile(null), null);
});

test('isNewer vergleicht Versionen numerisch', async () => {
  const { isNewer } = await import('../src/editions.mjs');
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
});
