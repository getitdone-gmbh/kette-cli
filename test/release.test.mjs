import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packMismatch, packPluginsFor } from '../scripts/pack-plugins.mjs';
import { COMMUNITY, ENTERPRISE, RENAMED_PLUGINS, pluginsFor } from '../src/editions.mjs';

const ENG = ['kette-engineering-core', 'kette-engineering'];
const needed = [...new Set([...packPluginsFor(pluginsFor(COMMUNITY), ENG), ...packPluginsFor(pluginsFor(ENTERPRISE), ENG)])];
const base = { ref: 'v1.3.0', commit: 'f9165ee0000000', renamed: RENAMED_PLUGINS, needed };

test('pack plugins per edition are the edition plugins kette-engineering does not ship', () => {
  assert.deepEqual(packPluginsFor(pluginsFor(COMMUNITY), ENG), ['ui-laws']);
  assert.deepEqual(packPluginsFor(pluginsFor(ENTERPRISE), ENG), ['design-system-agents', 'design-review-pack']);
});

test('a pack state with every needed plugin passes', () => {
  const all = ['ui-laws', 'design-review-pack', 'design-system-agents'];
  assert.equal(packMismatch({ ...base, packPlugins: all, packDirs: all }), null);
});

test('tag v1.2.2 with ui-gesetze fails and names the rename', () => {
  const old = ['ui-gesetze', 'design-review-pack', 'design-system-agents'];
  const msg = packMismatch({ ...base, ref: 'v1.2.2', commit: '64f989dabc', packPlugins: old, packDirs: old });
  assert.match(msg, /^claude-design-agent-pack v1\.2\.2 \(64f989d\) does not match the editions/);
  assert.match(msg, /The editions need: ui-laws, design-system-agents, design-review-pack/);
  assert.match(msg, /Missing: ui-laws; the pack still has the old name ui-gesetze \(renamed to ui-laws\)/);
});

test('a plugin in the marketplace but without its folder also fails', () => {
  const all = ['ui-laws', 'design-review-pack', 'design-system-agents'];
  const msg = packMismatch({ ...base, packPlugins: all, packDirs: ['design-review-pack', 'design-system-agents'] });
  assert.match(msg, /Missing: ui-laws\n/);
  assert.doesNotMatch(msg, /old name/);
});
