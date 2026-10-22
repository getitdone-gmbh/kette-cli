import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdLine } from '../src/claude.mjs';
import { COMMUNITY, ENTERPRISE, editionLabel, isLegacyTier, normalizeProfile, normalizeTier, pluginContents, pluginDetails, pluginsFor, pluginSummary, retiredPlugins } from '../src/editions.mjs';
import { tmp, write } from './helpers.mjs';

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
  assert.deepEqual(pluginsFor('free'), ['kette-engineering-core', 'ui-gesetze']);
  assert.deepEqual(pluginsFor('enterprise'), ['kette-engineering-core', 'kette-engineering', 'design-system-agents', 'design-review-pack']);
});

test('beim Wechsel der Edition fallen nur die Plugins weg, die die neue Edition nicht hat', () => {
  assert.deepEqual(retiredPlugins(COMMUNITY, ENTERPRISE), ['ui-gesetze']);
  assert.deepEqual(retiredPlugins(ENTERPRISE, COMMUNITY), ['kette-engineering', 'design-system-agents', 'design-review-pack']);
});

// Paket mit Plugin-Ordnern wie aus scripts/release.mjs
function bundleWithPlugins() {
  const d = tmp();
  write(d, 'plugins/kette-engineering-core/skills/engineering-rules/SKILL.md', 'x');
  write(d, 'plugins/kette-engineering-core/skills/architecture-patterns/SKILL.md', 'x');
  write(d, 'plugins/kette-engineering-core/agents/kette-check.md', 'x');
  write(d, 'plugins/kette-engineering-core/skills/kein-skill/README.md', 'x');
  write(d, 'plugins/kette-engineering/agents/code-reviewer.md', 'x');
  write(d, 'plugins/kette-engineering/skills/platform-profile/SKILL.md', 'x');
  for (const a of ['a', 'b', 'c', 'd']) write(d, `plugins/design-system-agents/agents/${a}.md`, 'x');
  write(d, 'plugins/design-system-agents/commands/feature-loop.md', 'x');
  write(d, 'plugins/design-system-agents/skills/loop-contract/SKILL.md', 'x');
  return d;
}

test('Inhalt der Plugins wird aus den Ordnern im Paket gezählt', () => {
  const d = bundleWithPlugins();
  assert.deepEqual(pluginContents(d, 'kette-engineering-core'), { agents: ['kette-check'], skills: ['architecture-patterns', 'engineering-rules'], commands: [] });
  assert.deepEqual(pluginContents(d, 'design-system-agents').commands, ['/feature-loop']);
  assert.equal(pluginContents(d, 'design-review-pack'), null);
  assert.equal(pluginContents(null, 'kette-engineering'), null);
  assert.equal(pluginSummary(ENTERPRISE, 'kette', d), 'kette-engineering-core@kette (Agent kette-check, Skills architecture-patterns, engineering-rules), kette-engineering@kette (Agent code-reviewer, Skill platform-profile), design-system-agents@kette (4 Agents, Skill loop-contract, Command /feature-loop), design-review-pack@kette');
  const details = pluginDetails(ENTERPRISE, 'kette', d);
  assert.deepEqual(details[2], { id: 'design-system-agents@kette', lines: ['Agents (4): a, b, c, d', 'Skills (1): loop-contract', 'Commands (1): /feature-loop'] });
  assert.deepEqual(details[3].lines, ['not in the bundle']);
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

test('Windows claude.cmd: arguments quoted for cmd.exe, unsafe ones refused', () => {
  assert.equal(cmdLine(['plugin', 'install', 'kette-engineering@kette']), 'claude.cmd plugin install kette-engineering@kette');
  assert.equal(cmdLine(['plugin', 'marketplace', 'add', 'C:\\Users\\Jo Do\\.kette\\bundles\\active']), 'claude.cmd plugin marketplace add "C:\\Users\\Jo Do\\.kette\\bundles\\active"');
  assert.equal(cmdLine(['plugin', 'marketplace', 'add', 'C:\\%PATH%']), null);
  assert.equal(cmdLine(['a"b']), null);
  assert.equal(cmdLine(['plugin', 'marketplace', 'add', 'C:\\Jo Do\\']), null, 'a trailing backslash would escape the closing quote');
});
