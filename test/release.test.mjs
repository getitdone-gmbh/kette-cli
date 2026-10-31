import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packMismatch, packPluginsFor } from '../scripts/pack-plugins.mjs';
import { COMMUNITY, ENTERPRISE, RENAMED_PLUGINS, pluginsFor } from '../src/editions.mjs';
import { TICKETING_PLUGIN } from '../scripts/ticketing-part.mjs';

// kette-ticketing builds its own plugin, like release.mjs passes it
const ENG = ['kette-engineering-core', 'kette-engineering', TICKETING_PLUGIN];
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

test('KETTE-27: the ticketing part names no routing of Get IT Done, no backfill, no migrations', async () => {
  const { PART_FILES } = await import('../scripts/ticketing-part.mjs');
  assert.ok(PART_FILES.includes('routing.default.json'));
  for (const f of ['routing.json', 'backfill', 'migrations', 'scripts/kette-ticket.mjs']) assert.ok(!PART_FILES.includes(f), f);
});

test('KETTE-27: the release refuses a ticketing part with a repo, session name, Figma key, private address or the Spark', async () => {
  const { forbiddenIn } = await import('../scripts/ticketing-part.mjs');
  const { tmp, write } = await import('./helpers.mjs');
  const clean = tmp();
  write(clean, 'ticketing/routing.default.json', '{"stations":{"app":{"aliases":["app"]}},"api":"https://api.example.test"}');
  assert.deepEqual(forbiddenIn(clean), []);
  const dirty = tmp();
  write(dirty, 'a.json', '{"repos":["alexfriedl/cv-manager-gui"]}');
  write(dirty, 'b.mjs', "const OLLAMA = 'http://192.168.178.175:11434';");
  write(dirty, 'c.md', 'run on the Spark first');
  write(dirty, 'd.json', '{"files":[{"name":"Settings","key":"j2RxwrgeeDp9MWTEElzKm3"}]}');
  write(dirty, 'e.json', '{"currentName":"alexanderfriedl-0a"}');
  write(dirty, 'f.md', 'https://www.figma.com/design/bzBnRLfRJNknGg9UYJIHb0/zero');
  write(dirty, 'g.mjs', "const lan = '10.2.1.4';");
  const found = forbiddenIn(dirty).join('\n');
  for (const re of [/a\.json: repo of Get IT Done/, /b\.mjs: private address/, /c\.md: internal machine name/, /d\.json: Figma file key/, /e\.json: session name/, /f\.md: Figma file key/, /g\.mjs: private address/]) assert.match(found, re);
});

test('KETTE-30: the plugin kette-ticketing carries the intake agent and the /intake command', async () => {
  const { TICKETING_PLUGIN, marketEntry, writePlugin } = await import('../scripts/ticketing-part.mjs');
  const { tmp, write } = await import('./helpers.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = tmp();
  write(src, 'agent/kette-intake.md', '---\nname: kette-intake\n---\n');
  write(src, 'commands/intake.md', '---\ndescription: x\n---\n');
  const dest = writePlugin(src, path.join(tmp(), 'plugin'), '0.1.2');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, '.claude-plugin/plugin.json'), 'utf8')).name, TICKETING_PLUGIN);
  assert.ok(fs.existsSync(path.join(dest, 'agents/kette-intake.md')));
  assert.ok(fs.existsSync(path.join(dest, 'commands/intake.md')));
  assert.deepEqual(marketEntry('0.1.2').source, './plugins/kette-ticketing');
  assert.ok(pluginsFor(ENTERPRISE).includes(TICKETING_PLUGIN) && !pluginsFor(COMMUNITY).includes(TICKETING_PLUGIN));
});
