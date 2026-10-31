import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, write } from './helpers.mjs';
import { inherit, newInstance, readInstance, validateInstance, withRepo, writeInstance } from '../src/instance/config.mjs';
import { projectPlugins, renewSettings, settingsStatus, userScopePlugins } from '../src/project-plugins.mjs';
import { buildMarketplace } from '../src/marketplace.mjs';
import { parse, renewProfile } from '../src/cli.mjs';

beforeEach(() => { process.env.KETTE_HOME = tmp(); });

const full = () => ({ ...newInstance('acme', 'enterprise'), bundle: '0.20261025.92', repos: [{ name: 'web', url: 'git@example.com:acme/web.git' }], members: [{ id: 'lead@example.com', role: 'owner' }], ticketing: { adapter: 'workbase', project: 'ZERO' }, wallet: { provider: 'infisical', project: 'acme', env: 'dev' }, overlays: [{ source: 'github:acme/rules' }], stations: ['tokens', 'library'] });

test('instance.json: every field is checked, typos and bad values are named', () => {
  assert.deepEqual(validateInstance(full()), []);
  const errs = validateInstance({ ...full(), edition: 'pro', name: 'Acme', reops: [], bundle: '../x', members: [{ id: 'a', role: 'boss' }, { id: 'A', role: 'owner' }], wallet: { provider: 'vaultx' }, stations: ['Tokens'] });
  for (const e of [/unknown field reops/, /edition must be community or enterprise/, /name must be lowercase/, /bundle must be a bundle version/, /members\[0\]\.role must be owner or member/, /wallet\.provider must be one of/, /stations\[0\] must be a station id/]) assert.ok(errs.some((x) => e.test(x)), `${e} in ${errs.join('; ')}`);
  assert.ok(validateInstance({ ...full(), members: [{ id: 'a@b.de', role: 'owner' }, { id: 'A@B.DE', role: 'member' }] }).some((e) => /listed twice/.test(e)), 'member ids are case insensitive');
});

test('readInstance refuses a folder whose instance.json names another instance and an unsafe name', () => {
  writeInstance(newInstance('acme', 'community'));
  assert.equal(readInstance('acme').edition, 'community');
  assert.equal(readInstance('none'), null);
  write(path.join(process.env.KETTE_HOME, 'instances', 'copy'), 'instance.json', JSON.stringify(newInstance('acme', 'community')));
  assert.throws(() => readInstance('copy'), /names the instance "acme", its folder is "copy"/);
  assert.throws(() => readInstance('../etc'), /Invalid instance name/);
});

test('withRepo adds a repo once, matched by origin URL, and refuses a taken name with another origin', () => {
  let i = newInstance('acme', 'community');
  ({ instance: i } = withRepo(i, { name: 'web', url: 'u1' }));
  assert.equal(withRepo(i, { name: 'web-renamed', url: 'u1' }).added, false);
  assert.throws(() => withRepo(i, { name: 'web', url: 'u2' }), /already has a repo named web/);
  assert.equal(withRepo(i, { name: 'api', url: null }).instance.repos.length, 2);
});

test('inherit: the instance gives edition and shared settings, repo values win', () => {
  const profile = { project: { name: 'web' }, stack: ['nextjs-ts-tailwind'], tier: 'community', overlays: [{ source: 'own' }], instance: 'acme' };
  const eff = inherit(profile, full());
  assert.equal(eff.tier, 'enterprise');
  assert.deepEqual(eff.overlays, [{ source: 'own' }]);
  assert.deepEqual(eff.ticketing, { adapter: 'workbase', project: 'ZERO' });
  assert.deepEqual(eff.stack, ['nextjs-ts-tailwind']);
  assert.equal(inherit(profile, null), profile);
});

test('project plugins: the edition on, every other Kette plugin off, foreign settings kept', () => {
  assert.deepEqual(projectPlugins('community'), { 'kette-engineering-core@kette': true, 'ui-laws@kette': true, 'kette-engineering@kette': false, 'design-system-agents@kette': false, 'design-review-pack@kette': false });
  const current = JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'other@market': true, 'design-review-pack@kette': true } });
  const next = JSON.parse(renewSettings(current, 'community'));
  assert.deepEqual(next.permissions, { allow: ['Bash(ls)'] });
  assert.equal(next.enabledPlugins['other@market'], true);
  assert.equal(next.enabledPlugins['design-review-pack@kette'], false);
  assert.equal(renewSettings(JSON.stringify(next, null, 2), 'community'), JSON.stringify(next, null, 2), 'no change when it already matches');
  assert.equal(renewSettings('not json', 'community'), 'not json', 'a broken file stays as it is');
});

test('settingsStatus names missing, broken and drifted project settings', () => {
  const d = tmp();
  assert.equal(settingsStatus(d, 'community').state, 'missing');
  write(d, '.claude/settings.json', '[1]');
  assert.equal(settingsStatus(d, 'community').state, 'broken');
  write(d, '.claude/settings.json', renewSettings('', 'enterprise'));
  const drift = settingsStatus(d, 'community');
  assert.equal(drift.state, 'drift');
  assert.ok(drift.wrong.includes('design-system-agents@kette'));
  assert.equal(settingsStatus(d, 'enterprise').state, 'ok');
});

test('userScopePlugins reads only Kette plugins that are on in the user settings', () => {
  const config = tmp();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    assert.deepEqual(userScopePlugins(), []);
    write(config, 'settings.json', JSON.stringify({ enabledPlugins: { 'ui-laws@kette': true, 'kette-engineering@kette': false, 'x@other': true } }));
    assert.deepEqual(userScopePlugins(), ['ui-laws@kette']);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('the merged marketplace copies plugins of both bundles, Enterprise wins, and rebuilds only when a bundle changes', () => {
  const bundle = (plugins, version) => {
    const d = tmp();
    write(d, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'kette', owner: { name: 'Get IT Done GmbH' }, plugins: plugins.map((p) => ({ name: p, source: `./plugins/${p}`, description: `${p} ${version}` })) }));
    for (const p of plugins) write(d, `plugins/${p}/.claude-plugin/plugin.json`, JSON.stringify({ name: p, version }));
    return d;
  };
  const community = { tier: 'community', version: '1', dir: bundle(['kette-engineering-core', 'ui-laws'], '1') };
  const enterprise = { tier: 'enterprise', version: '2', dir: bundle(['kette-engineering-core', 'design-system-agents'], '2') };
  const m = buildMarketplace([community, enterprise]);
  assert.deepEqual(m.plugins, ['design-system-agents', 'kette-engineering-core', 'ui-laws']);
  const manifest = JSON.parse(fs.readFileSync(path.join(m.dir, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(manifest.name, 'kette');
  assert.equal(manifest.plugins.find((p) => p.name === 'kette-engineering-core').description, 'kette-engineering-core 2');
  assert.equal(fs.lstatSync(path.join(m.dir, 'plugins', 'ui-laws')).isSymbolicLink(), false, 'copies, Claude Code refuses links');
  const stamp = fs.statSync(path.join(m.dir, '.kette-sources.json')).mtimeMs;
  buildMarketplace([community, enterprise]);
  assert.equal(fs.statSync(path.join(m.dir, '.kette-sources.json')).mtimeMs, stamp, 'unchanged bundles keep the folder');
  assert.deepEqual(buildMarketplace([community]).plugins, ['kette-engineering-core', 'ui-laws']);
});

test('renewProfile with an instance sets instance after project and follows its edition down to Community', () => {
  const current = JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], tier: 'enterprise' }, null, 2);
  const next = JSON.parse(renewProfile(current, 'community', null, 'oss'));
  assert.deepEqual(Object.keys(next), ['version', 'project', 'instance', 'stack', 'tier']);
  assert.equal(next.tier, 'community');
  assert.equal(JSON.parse(renewProfile(current, 'community', null)).tier, 'enterprise', 'without an instance tier is never lowered (ADR-0001)');
});

test('--instance takes a name, alone it means the instance of the repo in this folder', () => {
  assert.equal(parse(['doctor', '--instance']).instance, true);
  assert.equal(parse(['doctor', '--instance', '--ci']).instance, true);
  assert.equal(parse(['add', '--instance', 'acme', '--yes']).instance, 'acme');
  assert.equal(parse(['instance', 'create', 'acme', '--edition', 'community', '--from', 'git@x:y.git']).from, 'git@x:y.git');
});
