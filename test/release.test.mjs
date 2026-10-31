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
  for (const re of [/a\.json: internal word \(alexfriedl\)/, /b\.mjs: private address/, /c\.md: internal word \(spark\)/, /d\.json: Figma file key/, /e\.json: session name/, /f\.md: Figma URL/, /g\.mjs: private address/]) assert.match(found, re);
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

test('KETTE-32 (KT-N1): the bypasses from the review are found, in any case, URL-encoded and in Base64', async () => {
  const { forbiddenIn } = await import('../scripts/ticketing-part.mjs');
  const { tmp, write } = await import('./helpers.mjs');
  const cases = {
    'ssh.md': 'then ssh spark and run it',
    'upper.md': 'runs on the SPARK',
    'b64.mjs': `const x = '${Buffer.from('alexfriedl/kneier').toString('base64')}';`,
    'b64-offset.mjs': `const x = '${Buffer.from('xxalexfriedl/kneier').toString('base64')}';`,
    'filekey.mjs': "const fileKey = 'j2RxwrgeeDp9MWTEElzKm3';",
    'make.md': 'https://www.figma.com/make/AbCdEf123456/prototype',
    'mail.json': '{"owner":"lead@customer.example"}',
    'hex.json': '{"project":"6ae510fc15371242272a4278"}',
    'urlenc.md': 'see github.com/alexfriedl%2Fkette-ticketing',
    'mixed.md': 'see AlexFriedl/kette-ticketing',
    'ula.mjs': "const m = 'http://[fd00::12]:11434/v1';",
    'host.md': 'deployed to zero-design-intern.itdone.de',
    'customer1.md': 'built for kneier',
    'customer2.md': 'built for Braun-Partner',
  };
  for (const [f, content] of Object.entries(cases)) {
    const dir = tmp();
    write(dir, f, content);
    assert.ok(forbiddenIn(dir).length > 0, `${f} must be refused: ${content}`);
  }
  const clean = tmp();
  write(clean, 'ok.mjs', "const api = 'https://api.workbase.itdone.de/api/project-manager/api'; const spec = 'spec';");
  assert.deepEqual(forbiddenIn(clean), []);
});

test('KETTE-32 (KT-N1): every string of the instance fragment of Get IT Done is a word that never ships, apart from what the neutral routing uses', async () => {
  const { denyWordsFrom, forbiddenIn } = await import('../scripts/ticketing-part.mjs');
  const { tmp, write } = await import('./helpers.mjs');
  const fragment = { members: [{ id: 'alex', role: 'owner' }], stations: [{ id: 'prototype', owner: 'session:app', builder: 'ux-designer', targets: ['workload-zero-dashboard', 'Settings', 'Records', 'Design-Tokens'] }] };
  const neutral = { stations: { prototype: { aliases: ['settings'] } }, members: { 'ux-designer': { kind: 'agent' } }, routes: [{ builder: 'ux-designer', owner: '@owner' }] };
  const words = denyWordsFrom(fragment, neutral);
  assert.deepEqual(words.sort(), ['Design-Tokens', 'alex', 'session:app', 'workload-zero-dashboard'].sort());
  const agentName = tmp();
  write(agentName, 'r.json', '{"builder":"design-tokens-maintainer","text":"it records the prompt"}');
  assert.deepEqual(forbiddenIn(agentName, { denyWords: words }), [], 'an agent name and an ordinary word are no hit');
  const dir = tmp();
  write(dir, 'a.mjs', "const target = 'Workload-Zero-Dashboard';");
  assert.match(forbiddenIn(dir, { denyWords: words }).join('\n'), /internal word \(workload-zero-dashboard\)/);
});

test('KETTE-32 (KT-N1, KT-N4): the shipped routing holds only neutral fields and agent roles of the bundle', async () => {
  const { routingErrors } = await import('../scripts/ticketing-part.mjs');
  const agents = new Set(['ux-designer', 'code-reviewer', 'fullstack-developer']);
  const good = { version: 1, members: { 'ux-designer': { kind: 'agent' } }, stations: { app: { visible: true, defaultArtifact: 'screen', aliases: ['app'] } }, routes: [{ station: 'app', artifact: 'screen', owner: '@owner', builder: 'fullstack-developer', review: 'batch', gates: ['kette-engineering:code-reviewer'] }], rules: { maxHeavyAgents: 4 } };
  assert.deepEqual(routingErrors(good, agents), []);
  const bad = {
    ...good,
    members: { alex: { kind: 'human' }, 'session:ds': { kind: 'session', currentName: 'x' }, 'theme-rollout-engineer': { kind: 'agent' } },
    stations: { app: { ...good.stations.app, repos: ['acme/web'], files: [], hosts: [], tooling: [], storybook: 'x' } },
    routes: [{ ...good.routes[0], owner: 'alex', approve: 'alex' }],
  };
  const errs = routingErrors(bad, agents).join('\n');
  for (const re of [/members\.alex is human/, /members\.session:ds is session/, /currentName is not allowed/, /members\.theme-rollout-engineer is no agent of the Enterprise bundle/, /stations\.app\.repos is not allowed/, /stations\.app\.files/, /stations\.app\.hosts/, /stations\.app\.tooling/, /stations\.app\.storybook/, /routes\[0\]\.owner must be @owner/, /routes\[0\]\.approve is not allowed/]) assert.match(errs, re);
});

test('KETTE-39: fixed deny words match inside other names, Base64 in any case, the new private ranges, ordinary words by list', async () => {
  const { ORDINARY_WORDS, denyWordsFrom, forbiddenIn } = await import('../scripts/ticketing-part.mjs');
  const { tmp, write } = await import('./helpers.mjs');
  const hit = (content, opts) => { const d = tmp(); write(d, 'f.txt', content); return forbiddenIn(d, opts).length > 0; };
  for (const c of ['github.com/x/alexfriedl-portfolio', 'see spark-cockpit', 'repo x-kneier-web', 'ALEXFRIEDL', Buffer.from('AlexFriedl').toString('base64'), Buffer.from('ALEXFRIEDL').toString('base64'), Buffer.from('Spark-Cockpit').toString('base64'), 'http://100.64.3.4:11434', 'listen on 0.0.0.0', 'http://[fec0::7]/', 'http://[64:ff9b::c0a8:105]/']) assert.ok(hit(c), c);
  assert.deepEqual(ORDINARY_WORDS.sort(), ['Admin', 'Community', 'Persönlich', 'Records', 'Settings']);
  const words = denyWordsFrom({ targets: ['Records', 'Studio', 'Basic'] }, {});
  assert.deepEqual(words.sort(), ['Basic', 'Studio'], 'only the listed ordinary words stay allowed');
  assert.equal(hit('the design-tokens-maintainer records it', { denyWords: ['Design-Tokens'] }), false, 'dash rule for fragment words');
});
