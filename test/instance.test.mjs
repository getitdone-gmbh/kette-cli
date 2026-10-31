import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmp, write } from './helpers.mjs';
import { inherit, newInstance, normalizeUrl, printable, readInstance, redact, repoIdentity, validName, validateInstance, withRepo, writeInstance } from '../src/instance/config.mjs';
import { projectPlugins, renewLocalSettings, renewSettings, settingsStatus, userScopePlugins } from '../src/project-plugins.mjs';
import { buildMarketplace, marketDir } from '../src/marketplace.mjs';
import { enterpriseLeftovers, recordTemplates, removeLeftovers } from '../src/leftovers.mjs';
import { isInside } from '../src/files.mjs';
import { lockDir, withLock } from '../src/lock.mjs';
import { parse, renewProfile } from '../src/cli.mjs';

beforeEach(() => { process.env.KETTE_HOME = tmp(); });

const full = () => ({ ...newInstance('acme', 'enterprise'), bundle: '0.20261025.92', repos: [{ name: 'web', url: 'git@example.com:acme/web.git' }], members: [{ id: 'lead@example.com', role: 'owner' }], ticketing: { adapter: 'workbase', project: 'ZERO' }, wallet: { provider: 'infisical', project: 'acme', env: 'dev' }, overlays: [{ source: 'github:acme/rules' }], stations: ['tokens', 'library'] });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });

test('instance.json: every field is checked, typos and bad values are named', () => {
  assert.deepEqual(validateInstance(full()), []);
  const errs = validateInstance({ ...full(), edition: 'pro', name: 'Acme', reops: [], bundle: '../x', members: [{ id: 'a', role: 'boss' }, { id: 'A', role: 'owner' }], wallet: { provider: 'vaultx' }, stations: ['Tokens'] });
  for (const e of [/unknown field reops/, /edition must be community or enterprise/, /name must be lowercase/, /bundle must be a bundle version/, /members\[0\]\.role must be owner or member/, /wallet\.provider must be one of/, /stations\[0\] must be a station id/]) assert.ok(errs.some((x) => e.test(x)), `${e} in ${errs.join('; ')}`);
  assert.ok(validateInstance({ ...full(), members: [{ id: 'a@b.de', role: 'owner' }, { id: 'A@B.DE', role: 'member' }] }).some((e) => /listed twice/.test(e)), 'member ids are case insensitive');
});

test('CR-SEC-1: a repo URL with user info (a token) is refused in instance.json, CR-SEC-4: control characters too', () => {
  assert.ok(validateInstance({ ...full(), repos: [{ name: 'web', url: 'https://x-access-token:ghp_secret@github.com/acme/web.git' }] }).some((e) => /must not hold user info/.test(e)));
  assert.ok(validateInstance({ ...full(), members: [{ id: 'evil\u001b[31m', role: 'owner' }] }).some((e) => /members\[0\]\.id/.test(e)));
});

test('CR-PLAT-1: names Windows reserves are no instance names; repo folders with such names get a suffix', () => {
  for (const n of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9']) assert.equal(validName(n), false, n);
  for (const n of ['acme', 'con-tools', 'com10']) assert.equal(validName(n), true, n);
  const d = path.join(tmp(), 'nul');
  fs.mkdirSync(d);
  assert.equal(repoIdentity(d).name, 'nul-repo');
});

test('CR-SEC-1, CR-INST-2: origins are normalised, user info dropped, ssh, scp and https forms of one repo share a key', () => {
  const forms = ['https://x-access-token:ghp_secret@GitHub.com/acme/web.git', 'git@github.com:acme/web.git', 'ssh://git@github.com/acme/web', 'https://github.com/acme/web/'];
  const keys = new Set(forms.map((u) => normalizeUrl(u).key));
  assert.deepEqual([...keys], ['github.com/acme/web']);
  for (const u of forms) assert.doesNotMatch(normalizeUrl(u).url, /ghp_secret|x-access-token/);
  assert.equal(normalizeUrl('ssh://git@github.com/acme/web').url, 'ssh://git@github.com/acme/web', 'the ssh user git stays, it is needed to clone');
  assert.equal(normalizeUrl('C:/repos/app.git').url, path.resolve('C:/repos/app.git'), 'a Windows drive path is a local repo, not a URL with the scheme c:');
});

test('CR-SEC-3, CR-SEC-4: printed text loses user info, escape sequences and control characters', () => {
  assert.equal(redact('git clone https://user:pass@host.example/x.git failed'), 'git clone https://host.example/x.git failed');
  assert.equal(printable('ok\u001b[2J\u001b[31mred\u0007\r\nnext'), 'okrednext');
});

test('readInstance refuses a folder whose instance.json names another instance and an unsafe name', () => {
  writeInstance(newInstance('acme', 'community'));
  assert.equal(readInstance('acme').edition, 'community');
  assert.equal(readInstance('none'), null);
  write(path.join(process.env.KETTE_HOME, 'instances', 'copy'), 'instance.json', JSON.stringify(newInstance('acme', 'community')));
  assert.throws(() => readInstance('copy'), /names the instance "acme", its folder is "copy"/);
  assert.throws(() => readInstance('../etc'), /Invalid instance name/);
});

test('CR-INST-2: withRepo matches the same origin in another form; QA-08: two repos without origin and with one name both get an entry', () => {
  let i = newInstance('acme', 'community');
  ({ instance: i } = withRepo(i, { name: 'web', ...normalizeUrl('git@github.com:acme/web.git') }));
  assert.equal(withRepo(i, { name: 'web-renamed', ...normalizeUrl('https://github.com/acme/web.git') }).added, false, 'ssh and https of one repo are one repo');
  const other = withRepo(i, { name: 'web', ...normalizeUrl('https://github.com/other/web.git') });
  assert.equal(other.added, true);
  assert.equal(other.repo.name, 'web-2', 'another repo with the same folder name gets its own name');
  const a = withRepo(i, { name: 'site', url: null, key: 'local:/a/.git' });
  const b = withRepo(a.instance, { name: 'site', url: null, key: 'local:/b/.git' }, { '/a': { repo: 'site', key: 'local:/a/.git' } });
  assert.equal(b.added, true);
  assert.equal(b.repo.name, 'site-2');
  assert.equal(withRepo(a.instance, { name: 'site', url: null, key: 'local:/a/.git' }, { '/a': { repo: 'site', key: 'local:/a/.git' } }).added, false, 'the same repo without origin is matched by its checkout');
});

test('QA-08: a worktree and its main checkout are one repo, a folder inside another repo is its own, the key survives git init', () => {
  const main = path.join(tmp(), 'main');
  fs.mkdirSync(main);
  const before = repoIdentity(main).key;
  git(main, 'init', '-q');
  assert.equal(repoIdentity(main).key, before, 'the key of a new project stays the same after git init');
  write(main, 'README', 'x');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'x');
  const wt = path.join(path.dirname(main), 'main-wt');
  git(main, 'worktree', 'add', '-q', wt);
  assert.equal(repoIdentity(wt).key, repoIdentity(main).key);
  const nested = path.join(main, 'packages', 'tool');
  fs.mkdirSync(nested, { recursive: true });
  assert.notEqual(repoIdentity(nested).key, repoIdentity(main).key);
  git(main, 'remote', 'add', 'origin', 'https://tok@github.com/acme/main.git');
  assert.deepEqual([repoIdentity(main).key, repoIdentity(wt).key], ['github.com/acme/main', 'github.com/acme/main']);
  assert.equal(repoIdentity(main).url, 'https://github.com/acme/main');
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

test('D2: project plugins use the marketplace of their edition, every other Kette ID is off, also the legacy marketplace kette', () => {
  const com = projectPlugins('community');
  assert.equal(com['kette-engineering-core@kette-community'], true);
  assert.equal(com['ui-laws@kette-community'], true);
  for (const id of ['kette-engineering-core@kette-enterprise', 'kette-engineering@kette-enterprise', 'design-system-agents@kette-enterprise', 'design-review-pack@kette-enterprise', 'kette-engineering-core@kette', 'design-system-agents@kette']) assert.equal(com[id], false, id);
  const ent = projectPlugins('enterprise');
  assert.equal(ent['kette-engineering-core@kette-enterprise'], true);
  assert.equal(ent['kette-engineering-core@kette-community'], false);
  const current = JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'other@market': true, 'design-review-pack@kette-enterprise': true } });
  const next = JSON.parse(renewSettings(current, 'community'));
  assert.deepEqual(next.permissions, { allow: ['Bash(ls)'] });
  assert.equal(next.enabledPlugins['other@market'], true);
  assert.equal(next.enabledPlugins['design-review-pack@kette-enterprise'], false);
  assert.equal(renewSettings(JSON.stringify(next, null, 2), 'community'), JSON.stringify(next, null, 2), 'no change when it already matches');
  assert.equal(renewSettings('not json', 'community'), 'not json', 'a broken file stays as it is');
});

test('CR-SCOPE-4: an Enterprise plugin switched on in settings.local.json of a Community repo is reported and removed by the renewal', () => {
  const d = tmp();
  write(d, '.claude/settings.json', renewSettings('', 'community'));
  write(d, '.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'design-system-agents@kette-enterprise': true, 'mine@other': true } }));
  const s = settingsStatus(d, 'community');
  assert.equal(s.state, 'drift');
  assert.deepEqual(s.local, ['design-system-agents@kette-enterprise']);
  const local = JSON.parse(renewLocalSettings(fs.readFileSync(path.join(d, '.claude/settings.local.json'), 'utf8'), 'community', '/m'));
  assert.deepEqual(local.enabledPlugins, { 'mine@other': true });
  assert.equal(local.extraKnownMarketplaces['kette-community'].source.path, '/m');
});

test('settingsStatus names missing, broken and drifted project settings', () => {
  const d = tmp();
  assert.equal(settingsStatus(d, 'community').state, 'missing');
  write(d, '.claude/settings.json', '[1]');
  assert.equal(settingsStatus(d, 'community').state, 'broken');
  write(d, '.claude/settings.json', renewSettings('', 'enterprise'));
  const drift = settingsStatus(d, 'community');
  assert.equal(drift.state, 'drift');
  assert.ok(drift.wrong.includes('design-system-agents@kette-enterprise'));
  assert.equal(settingsStatus(d, 'enterprise').state, 'ok');
});

test('userScopePlugins reads only Kette plugins that are on in the user settings', () => {
  const config = tmp();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    assert.deepEqual(userScopePlugins(), []);
    write(config, 'settings.json', JSON.stringify({ enabledPlugins: { 'ui-laws@kette': true, 'kette-engineering@kette': false, 'x@other': true, 'design-system-agents@kette-enterprise': true } }));
    assert.deepEqual(userScopePlugins(), ['design-system-agents@kette-enterprise', 'ui-laws@kette']);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

const bundle = (plugins, edition) => {
  const d = tmp();
  write(d, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'kette', owner: { name: 'Get IT Done GmbH' }, plugins: plugins.map((p) => ({ name: p, source: `./plugins/${p}`, description: `${p} ${edition}` })) }));
  for (const p of plugins) write(d, `plugins/${p}/EDITION`, edition);
  return d;
};

test('D2/QA-03: each marketplace holds only the copies of its own bundle, a shared plugin comes from the bundle of the edition', () => {
  const com = { version: '1', dir: bundle(['kette-engineering-core', 'ui-laws'], 'community') };
  const ent = { version: '2', dir: bundle(['kette-engineering-core', 'design-system-agents'], 'enterprise') };
  const c = buildMarketplace('community', com);
  const e = buildMarketplace('enterprise', ent);
  assert.deepEqual(c.plugins, ['kette-engineering-core', 'ui-laws']);
  assert.deepEqual(e.plugins, ['design-system-agents', 'kette-engineering-core']);
  assert.equal(fs.readFileSync(path.join(marketDir('community'), 'plugins', 'kette-engineering-core', 'EDITION'), 'utf8'), 'community');
  assert.equal(fs.readFileSync(path.join(marketDir('enterprise'), 'plugins', 'kette-engineering-core', 'EDITION'), 'utf8'), 'enterprise');
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, '.claude-plugin', 'marketplace.json'), 'utf8')).name, 'kette-community');
  const stamp = fs.statSync(path.join(c.dir, '.kette-sources.json')).mtimeMs;
  buildMarketplace('community', com);
  assert.equal(fs.statSync(path.join(c.dir, '.kette-sources.json')).mtimeMs, stamp, 'unchanged bundle keeps the folder');
  buildMarketplace('enterprise', null);
  assert.equal(fs.existsSync(marketDir('enterprise')), false, 'logout removes the Enterprise folder');
});

test('CR-MKT-1: links in a plugin are resolved inside the bundle, a link leaving the bundle is not copied', { skip: process.platform === 'win32' && 'symlinks need admin rights on Windows' }, () => {
  const d = bundle(['ui-laws'], 'community');
  const outside = path.join(tmp(), 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  fs.writeFileSync(path.join(d, 'shared.md'), 'shared');
  fs.symlinkSync(outside, path.join(d, 'plugins', 'ui-laws', 'leak.txt'));
  fs.symlinkSync(path.join(d, 'shared.md'), path.join(d, 'plugins', 'ui-laws', 'shared.md'));
  const m = buildMarketplace('community', { version: '1', dir: d });
  const dir = path.join(m.dir, 'plugins', 'ui-laws');
  assert.equal(fs.existsSync(path.join(dir, 'leak.txt')), false);
  assert.equal(fs.lstatSync(path.join(dir, 'shared.md')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(dir, 'shared.md'), 'utf8'), 'shared');
});

test('CR-PLAT-2: a folder on another Windows drive is never inside ~/.kette', () => {
  assert.equal(isInside('C:\\Users\\jo\\.kette\\bundles', 'D:\\repos\\kette', path.win32), false);
  assert.equal(isInside('C:\\Users\\jo\\.kette\\bundles', 'C:\\Users\\jo\\.kette\\bundles\\active', path.win32), true);
  assert.equal(isInside('/home/jo/.kette/bundles', '/home/jo/.kette/bundles-old', path.posix), false);
});

test('QA-01: a lock of a process that is gone is taken over, a held lock waits', () => {
  const dir = lockDir('state');
  fs.mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: Number(dead), at: Date.now() }));
  assert.equal(withLock('state', () => 'ran'), 'ran');
  assert.equal(fs.existsSync(dir), false, 'released after the run');
  assert.throws(() => withLock('nested', () => withLock('nested', () => 0)), /Another kette process is changing nested/, 'the same lock is never taken twice');
});

test('D7: kette records the Enterprise templates it wrote; leaving removes unchanged ones and the scope line, keeps changed ones', () => {
  const d = tmp();
  write(d, '.github/workflows/ci.yml', 'jobs: {}\n');
  write(d, 'compose.yaml', 'services: {}\n');
  write(d, '.npmrc', 'save-exact=true\n@getitdone-gmbh:registry=https://npm.kette.itdone.de/\n');
  recordTemplates(d, [{ path: '.github/workflows/ci.yml', content: 'jobs: {}\n', template: true, action: 'create' }, { path: 'compose.yaml', content: 'services: {}\n', template: true, action: 'create' }, { path: 'README.md', content: 'x', action: 'create' }]);
  fs.writeFileSync(path.join(d, 'compose.yaml'), 'services: { mine: {} }\n');
  assert.deepEqual(enterpriseLeftovers(d), { files: [{ path: '.github/workflows/ci.yml', changed: false }, { path: 'compose.yaml', changed: true }], npmrc: true });
  const r = removeLeftovers(d);
  assert.deepEqual(r.kept, ['compose.yaml']);
  assert.equal(fs.existsSync(path.join(d, '.github')), false, 'empty folders go with the file');
  assert.equal(fs.readFileSync(path.join(d, '.npmrc'), 'utf8'), 'save-exact=true\n');
  assert.deepEqual(enterpriseLeftovers(d), { files: [{ path: 'compose.yaml', changed: true }], npmrc: false });
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
