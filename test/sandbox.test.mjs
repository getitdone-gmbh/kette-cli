import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeBundle, fakeClaude, json, serve, sha256, tmp, write } from './helpers.mjs';

// Every command of the CLI in a fresh sandbox HOME (HOME, ~/.kette, ~/.npmrc and the Claude Code config all in temp folders,
// delivery service and mirror as local fake servers), followed by a file system diff: outside the project folder only the
// allowed machine files may change. KETTE_MATRIX_OUT=<file> writes the results as JSON for the matrix in docs/instances.md.

const BIN = fileURLToPath(new URL('../bin/kette.mjs', import.meta.url));
const KEY = 'CDP-AAAAA-BBBBB-CCCCC-00001';
const V = '0.20261020.9';
const CV = '0.20261022.40';
const enterpriseBundle = fakeBundle(V, ['kette-engineering-core', 'kette-engineering', 'design-system-agents', 'design-review-pack'], { 'rules/core/readability.md': '# Readability\n' });
const communityBundle = fakeBundle(CV, ['kette-engineering-core', 'ui-laws'], { 'rules/core/readability.md': '# Readability\n' });
const figmaFiles = { 'zero.fig': 'zero-fig', 'IMPORT.md': '# Import\n' };
const results = [];
let server;
let tools;
let vault;
const state = { ci: [], valid: new Set() };

// Machine files a command may change outside the project, as paths relative to HOME
const MACHINE = [/^\.kette\/(credentials|device-id|state\.json(\.bak)?)$/, /^\.kette\/bundles(\/|$)/, /^\.kette\/instances(\/|$)/, /^\.kette$/];
// Global files Claude Code itself keeps for plugins of any scope (marketplace names, plugin cache), never the user settings
const CLAUDE_REGISTRY = [/^\.claude\/plugins(\/|$)/, /^\.claude$/];
// Licence-bound npm auth of kette login (docs/instances.md, open decision D3)
const NPMRC = [/^\.npmrc$/];
// itdone MCP server of kette cloud setup in the user scope of Claude Code (docs/instances.md, open decision D4)
const MCP_USER = [/^\.claude\/\.claude\.json$/];

before(async () => {
  server = await serve((req, res, body) => {
    const url = new URL(req.url, server.url);
    const b = body ? JSON.parse(body) : {};
    if (url.pathname === '/manifest.json') return json(res, 200, { version: CV, bundles: { community: { url: `kette-community-${CV}.tgz`, sha256: communityBundle.sha256 } } });
    if (url.pathname === `/kette-community-${CV}.tgz`) { res.writeHead(200); return res.end(communityBundle.buf); }
    if (url.pathname === '/install/token') return json(res, 200, { edition: 'enterprise', version: V, url: `${server.url}/install/download/x`, sha256: enterpriseBundle.sha256, expires_at: '2027-10-20T00:00:00Z', updates_until: '2027-10-20T00:00:00Z', seats: { used: 1, max: 3 } });
    if (url.pathname === '/install/latest') return json(res, 200, { version: V, available: V, updates_until: '2027-10-20T00:00:00Z' });
    if (url.pathname === '/install/download/x') { res.writeHead(200); return res.end(enterpriseBundle.buf); }
    if (url.pathname === '/registry/token') { const t = `kt_${'a'.repeat(43)}`; state.valid.add(t); return json(res, 200, { token: t, registry: `${server.url}/`, scope: '@getitdone-gmbh', kind: 'device' }); }
    if (url.pathname === '/registry/token/revoke') { state.valid.clear(); return json(res, 200, { revoked: true }); }
    if (url.pathname === '/-/whoami') return state.valid.has((req.headers.authorization || '').slice(7)) ? json(res, 200, { username: 'kette-1' }) : json(res, 401, {});
    if (url.pathname === '/registry/ci-tokens/create') { const t = { id: '00000000-0000-4000-8000-000000000001', label: b.label, prefix: 'kt_ZZZZZZZ', created_at: '2026-10-21T10:00:00Z', last_used_at: null }; state.ci.push(t); return json(res, 200, { id: t.id, token: `kt_${'Z'.repeat(43)}`, label: b.label, registry: `${server.url}/`, kind: 'ci' }); }
    if (url.pathname === '/registry/ci-tokens/list') return json(res, 200, { tokens: state.ci, max: 2 });
    if (url.pathname === '/registry/ci-tokens/revoke') { state.ci = state.ci.filter((t) => t.id !== b.id); return json(res, 200, { revoked: true }); }
    if (url.pathname === '/figma/links') return json(res, 200, { version: '2026.11.30', updates_until: '2027-10-20T00:00:00Z', guide_url: `${server.url}/figma/download/IMPORT.md`, files: Object.entries(figmaFiles).map(([name, c]) => ({ name, title: name, size: c.length, sha256: sha256(Buffer.from(c)), url: `${server.url}/figma/download/${name}`, expires_at: '2026-10-21T10:15:00Z' })) });
    const fig = url.pathname.match(/^\/figma\/download\/(.+)$/);
    if (fig) { res.writeHead(200); return res.end(figmaFiles[fig[1]]); }
    return json(res, 404, {});
  });
  // Stand-ins for the wallet provider and gh; their store lives outside the sandbox, like a real vault
  tools = tmp();
  vault = path.join(tools, 'vault.json');
  fs.writeFileSync(vault, JSON.stringify({ dev: {}, prod: {} }));
  const fake = (name, body) => {
    write(tools, name, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst s = JSON.parse(fs.readFileSync(${JSON.stringify(vault)}, 'utf8'));\nconst save = () => fs.writeFileSync(${JSON.stringify(vault)}, JSON.stringify(s));\nconst opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);\n${body}\n`);
    fs.chmodSync(path.join(tools, name), 0o755);
  };
  fake('infisical', `if (args[0] === '--version') { console.log('infisical version 0.43.50'); process.exit(0); }
const env = opt('--env'); s[env] = s[env] || {};
if (args[0] === 'export') { console.log(JSON.stringify(Object.entries(s[env]).map(([key, value]) => ({ key, value })))); process.exit(0); }
if (args[0] === 'secrets' && args[1] === 'set') { const m = fs.readFileSync(opt('--file'), 'utf8').trim().match(/^([A-Z0-9_]+): (.*)$/); s[env][m[1]] = JSON.parse(m[2]); save(); process.exit(0); }
process.exit(9);`);
  fake('gh', `if (args[0] === 'secret' && args[1] === 'set') { fs.readFileSync(0, 'utf8'); process.exit(0); } process.exit(9);`);
});

after(async () => {
  await server.close();
  if (process.env.KETTE_MATRIX_OUT) fs.writeFileSync(process.env.KETTE_MATRIX_OUT, JSON.stringify(results, null, 2));
});

// Fresh machine: HOME with nothing in it, a work folder for projects next to it
function sandbox() {
  const root = fs.realpathSync(tmp());
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  // One fake claude per machine: it keeps the global marketplace registry of Claude Code
  const claude = fakeClaude([]);
  const withClaude = process.env.PATH;
  claude.restore();
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'), KETTE_MIRROR: server.url, KETTE_DELIVERY: server.url, KETTE_REGISTRY: `${server.url}/`, KETTE_CLOUD_AUTH_URL: `${server.url}/realms/itdone`, PATH: `${tools}${path.delimiter}${withClaude}`, NO_COLOR: '1', CI: '1', KETTE_WALLET_TRUST: '1', KETTE_WALLET_PROJECT: 'proj-1', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  for (const k of ['KETTE_HOME', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig', 'FORCE_COLOR', 'KETTE_LICENSE_KEY']) delete env[k];
  return { root, home, work, env, claude };
}

// Path to content hash (files), link target or "dir", for the whole sandbox
function snapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.name === '.git' && e.isDirectory()) { out.set(f, 'git'); continue; }
      if (e.isSymbolicLink()) out.set(f, `link:${fs.readlinkSync(f)}`);
      else if (e.isDirectory()) { out.set(f, 'dir'); walk(f); }
      else out.set(f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function changed(before, afterSnap) {
  const paths = new Set([...before.keys(), ...afterSnap.keys()]);
  return [...paths].filter((p) => before.get(p) !== afterSnap.get(p)).sort();
}

// Runs the CLI as its own process (async, so the fake servers in this process can answer) and checks the diff
async function kette(box, argv, { cwd = box.work, projects = [], allow = [], input = '', record = null } = {}) {
  const before = snapshot(box.root);
  const child = spawn(process.execPath, [BIN, ...argv], { cwd, env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.stdin.end(input);
  const code = await new Promise((resolve) => child.on('close', resolve));
  const roots = [cwd, ...projects].map((p) => fs.realpathSync(p)).filter((p) => p !== box.work);
  const rules = [...MACHINE, ...allow];
  const outside = changed(before, snapshot(box.root)).filter((p) => !roots.some((r) => p === r || p.startsWith(r + path.sep))).filter((p) => {
    const rel = path.relative(box.home, p).split(path.sep).join('/');
    return rel.startsWith('..') || !rules.some((r) => r.test(rel));
  });
  const userPlugins = userScopeKette(box);
  const result = { command: `kette ${argv.join(' ')}`, scenario: record, code, outside: outside.map((p) => path.relative(box.root, p)), userPlugins, out: out.slice(0, 600) };
  if (record) results.push(result);
  return { code, out, outside: result.outside, userPlugins };
}

function userScopeKette(box) {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(box.home, '.claude', 'settings.json'), 'utf8')).enabledPlugins || {}).filter((id) => id.endsWith('@kette')); } catch { return []; }
}

// Every check of a step in one place: exit code, nothing changed outside the allowed list, no Kette plugin in the user scope
function ok(r, code = 0) {
  assert.equal(r.code, code, r.out);
  assert.deepEqual(r.outside, [], `changed outside the project and the allowed machine files:\n${r.outside.join('\n')}\n${r.out}`);
  assert.deepEqual(r.userPlugins, [], 'no Kette plugin in the user scope of Claude Code');
  return r;
}

const settings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).enabledPlugins;
const profile = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.kette', 'profile.json'), 'utf8'));
const readInstanceFile = (box, name) => JSON.parse(fs.readFileSync(path.join(box.home, '.kette', 'instances', name, 'instance.json'), 'utf8'));
const SETUP = ['--yes', '--stack', 'nestjs-prisma', '--platform', 'github-docker', '--patterns', 'layered'];
const ENTERPRISE_ONLY = ['kette-engineering@kette', 'design-system-agents@kette', 'design-review-pack@kette'];
const skip = process.platform === 'win32' && 'the fake claude and providers are POSIX scripts';

test('every command of the help runs in a sandbox and changes nothing global outside the allowed list', { skip }, async () => {
  const box = sandbox();
  const step = (argv, opts = {}) => kette(box, argv, { record: 'all-commands', ...opts });
  const app = path.join(box.work, 'app');
  ok(await step(['version']));
  ok(await step(['help']));
  ok(await step(['state']));
  ok(await step(['update']));
  ok(await step(['doctor']));
  ok(await step(['init', app, ...SETUP], { projects: [app], allow: CLAUDE_REGISTRY }));
  ok(await step(['add', ...SETUP], { cwd: app, allow: CLAUDE_REGISTRY }));
  ok(await step(['doctor'], { cwd: app }));
  ok(await step(['doctor', '--ci'], { cwd: app }));
  ok(await step(['rules'], { cwd: app }));
  ok(await step(['rules', '--path'], { cwd: app }));
  ok(await step(['profile'], { cwd: app }));
  ok(await step(['profile', '--effective'], { cwd: app }));
  ok(await step(['theme', '--primary', '#3366ff', '--out', 'theme.css'], { cwd: app }));
  ok(await step(['cloud', 'status'], { cwd: app }));
  ok(await step(['cloud', 'setup', '--have-account', '--dcr'], { cwd: app, allow: MCP_USER }));
  ok(await step(['login', KEY], { cwd: app, allow: [...NPMRC, ...CLAUDE_REGISTRY] }));
  ok(await step(['token', 'ci', 'create', 'pipeline'], { cwd: app }));
  ok(await step(['token', 'ci', 'list'], { cwd: app }));
  ok(await step(['token', 'ci', 'revoke', '00000000-0000-4000-8000-000000000001'], { cwd: app }));
  ok(await step(['figma', '--out', 'figma'], { cwd: app }));
  ok(await step(['instance'], { cwd: app }));
  ok(await step(['instance', 'list'], { cwd: app }));
  ok(await step(['instance', 'create', 'acme', '--edition', 'enterprise'], { cwd: app }));
  ok(await step(['instance', 'show', 'acme'], { cwd: app }));
  ok(await step(['instance', 'members', 'add', 'alex@example.com', '--role', 'owner', '--instance', 'acme'], { cwd: app }));
  ok(await step(['instance', 'members', '--instance', 'acme'], { cwd: app }));
  ok(await step(['instance', 'members', 'remove', 'alex@example.com', '--instance', 'acme'], { cwd: app }));
  ok(await step(['instance', 'use', 'acme'], { cwd: app, allow: CLAUDE_REGISTRY }));
  ok(await step(['instance', 'add-repo', app, '--instance', 'acme'], { cwd: app }));
  ok(await step(['doctor', '--instance'], { cwd: app }));
  ok(await step(['wallet', 'help'], { cwd: app }));
  ok(await step(['wallet', 'init', '--yes'], { cwd: app }));
  ok(await step(['wallet', 'status'], { cwd: app }));
  ok(await step(['wallet', 'add', 'API_KEY', '--env', 'dev'], { cwd: app }));
  ok(await step(['wallet', 'set', 'API_KEY', '--env', 'dev', '--stdin'], { cwd: app, input: 'secret-value\n' }));
  write(app, '.env', 'DATABASE_URL=postgres://localhost\n');
  ok(await step(['wallet', 'import', '.env', '--env', 'dev', '--yes'], { cwd: app }));
  ok(await step(['wallet', 'run', '--env', 'dev', '--', process.execPath, '-e', 'process.exit(process.env.API_KEY ? 0 : 3)'], { cwd: app }));
  ok(await step(['wallet', 'sync', 'github', '--env', 'dev', '--repo', 'owner/name', '--yes'], { cwd: app }));
  ok(await step(['wallet', 'trust'], { cwd: app }));
  ok(await step(['wallet', 'remove', 'API_KEY'], { cwd: app }));
  ok(await step(['update'], { cwd: app, allow: [...NPMRC, ...CLAUDE_REGISTRY] }));
  ok(await step(['instance', 'create', 'scratch', '--edition', 'community'], { cwd: app }));
  ok(await step(['instance', 'remove', 'scratch', '--yes'], { cwd: app }));
  ok(await step(['logout'], { cwd: app, allow: [...NPMRC, ...CLAUDE_REGISTRY] }));
  assert.equal(fs.existsSync(path.join(box.home, '.claude', 'settings.json')), false, 'the user settings of Claude Code were never written');
});

test('two repos in an Enterprise and a Community instance on one machine do not see each other', { skip }, async () => {
  const box = sandbox();
  const [ent, com] = [path.join(box.work, 'ent'), path.join(box.work, 'com')];
  const rec = { record: 'two-instances' };
  ok(await kette(box, ['login', KEY, '--no-plugins', '--no-npm'], rec));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise'], rec));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec));
  ok(await kette(box, ['init', ent, '--instance', 'acme', ...SETUP], { ...rec, projects: [ent], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['init', com, '--instance', 'oss', ...SETUP], { ...rec, projects: [com], allow: CLAUDE_REGISTRY }));
  assert.deepEqual(readInstanceFile(box, 'acme').repos.map((r) => r.name), ['ent']);
  assert.deepEqual(readInstanceFile(box, 'oss').repos.map((r) => r.name), ['com']);
  for (const id of ENTERPRISE_ONLY) { assert.equal(settings(ent)[id], true, id); assert.equal(settings(com)[id], false, id); }
  assert.equal(settings(com)['ui-laws@kette'], true);
  assert.equal(profile(ent).tier, 'enterprise');
  assert.equal(profile(com).tier, 'community');
  assert.match(fs.readFileSync(path.join(ent, '.kette', 'README.md'), 'utf8'), /kette-engineering:code-reviewer/);
  assert.doesNotMatch(fs.readFileSync(path.join(com, '.kette', 'README.md'), 'utf8'), /design-system-agents/);
  ok(await kette(box, ['doctor'], { ...rec, cwd: ent }));
  ok(await kette(box, ['doctor'], { ...rec, cwd: com }));
  const show = ok(await kette(box, ['instance', 'show', 'oss'], { ...rec, cwd: com }));
  assert.doesNotMatch(show.out, /\bent\b/);
  // claude install calls of the Community repo name Community plugins only
  const comCalls = box.claude.calls().filter((c, i) => fs.realpathSync(box.claude.cwds()[i]) === com && c.startsWith('plugin install'));
  assert.ok(comCalls.length && comCalls.every((c) => /kette-engineering-core|ui-laws/.test(c)), comCalls.join('\n'));
});

test('a repo switches instance: edition, settings and note follow, it leaves the old instance', { skip }, async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'switch-instance' };
  ok(await kette(box, ['login', KEY, '--no-plugins', '--no-npm'], rec));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise'], rec));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec));
  ok(await kette(box, ['init', app, '--instance', 'acme', ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['instance', 'use', 'oss'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  assert.equal(profile(app).instance, 'oss');
  assert.equal(profile(app).tier, 'community');
  assert.equal(settings(app)['design-system-agents@kette'], false);
  assert.doesNotMatch(fs.readFileSync(path.join(app, '.kette', 'README.md'), 'utf8'), /design-system-agents:requirements-engineer/);
  assert.deepEqual(readInstanceFile(box, 'acme').repos, []);
  assert.deepEqual(readInstanceFile(box, 'oss').repos.map((r) => r.name), ['app']);
  ok(await kette(box, ['instance', 'use', 'acme'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  assert.equal(profile(app).tier, 'enterprise');
  assert.equal(settings(app)['design-system-agents@kette'], true);
  ok(await kette(box, ['doctor'], { ...rec, cwd: app }));
});

test('a repo without instance works as before: machine edition, profile without instance, plugins in the project', { skip }, async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'no-instance' };
  ok(await kette(box, ['init', app, ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  const p = profile(app);
  assert.equal('instance' in p, false);
  assert.equal(p.tier, 'community');
  assert.equal(settings(app)['kette-engineering-core@kette'], true);
  ok(await kette(box, ['add', ...SETUP], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['doctor'], { ...rec, cwd: app }));
  ok(await kette(box, ['login', KEY, '--no-npm'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  // ADR-0001 still holds without an instance: add raises the project to the machine edition
  ok(await kette(box, ['add', ...SETUP], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  assert.equal(profile(app).tier, 'enterprise');
  assert.equal(settings(app)['design-review-pack@kette'], true);
});

test('an Enterprise instance without licence stops with a clear message and writes nothing', { skip }, async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'enterprise-no-licence' };
  const create = ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise'], rec), 1);
  assert.match(create.out, /Instance acme is Enterprise \(Die Kette\), this machine has no valid licence\. Sign in with: kette login <key>/);
  assert.equal(fs.existsSync(path.join(box.home, '.kette', 'instances', 'acme')), false);
  // An Enterprise instance from a teammate's repo is refused and its clone removed again
  const repo = instanceRepo(box, 'acme', 'enterprise');
  const clone = ok(await kette(box, ['instance', 'create', 'acme', '--from', repo], rec), 1);
  assert.match(clone.out, /no valid licence/);
  assert.equal(fs.existsSync(path.join(box.home, '.kette', 'instances', 'acme')), false);
  // A licence that is gone again: the instance stays, add and doctor say what is missing
  ok(await kette(box, ['login', KEY, '--no-plugins', '--no-npm'], rec));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise'], rec));
  ok(await kette(box, ['init', app, '--instance', 'acme', ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['logout', '--no-npm'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  const add = ok(await kette(box, ['add', ...SETUP], { ...rec, cwd: app }), 1);
  assert.match(add.out, /Instance acme is Enterprise \(Die Kette\), this machine has no valid licence/);
  const doctor = ok(await kette(box, ['doctor'], { ...rec, cwd: app }), 1);
  assert.match(doctor.out, /FAIL Instance acme is Enterprise, this machine has no valid licence\. Sign in with: kette login <key>/);
});

test('a Community instance on a machine with a licence never enables Enterprise plugins or features', { skip }, async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'community-with-licence' };
  ok(await kette(box, ['login', KEY], { ...rec, allow: NPMRC }));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec));
  const before = box.claude.calls().length;
  ok(await kette(box, ['init', app, '--instance', 'oss', ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  const installs = box.claude.calls().slice(before).filter((c) => c.startsWith('plugin install'));
  assert.deepEqual(installs.sort(), ['plugin install kette-engineering-core@kette --scope project', 'plugin install ui-laws@kette --scope project']);
  for (const id of ENTERPRISE_ONLY) assert.equal(settings(app)[id], false, id);
  assert.equal(fs.existsSync(path.join(app, '.npmrc')), false, 'no Enterprise registry line');
  assert.equal(fs.existsSync(path.join(app, '.github')), false, 'no Enterprise templates');
  const w = ok(await kette(box, ['wallet', 'init', '--yes'], { ...rec, cwd: app }), 1);
  assert.match(w.out, /The secret wallet is part of Enterprise/);
  ok(await kette(box, ['doctor'], { ...rec, cwd: app }));
});

test('login, update and logout with several instances keep every repo in its scope', { skip }, async () => {
  const box = sandbox();
  const [ent, com] = [path.join(box.work, 'ent'), path.join(box.work, 'com')];
  const rec = { record: 'login-update-logout' };
  ok(await kette(box, ['update'], rec));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec));
  ok(await kette(box, ['init', com, '--instance', 'oss', ...SETUP], { ...rec, projects: [com], allow: CLAUDE_REGISTRY }));
  write(ent, '.keep', '');
  ok(await kette(box, ['login', KEY, '--no-npm'], { ...rec, cwd: com, allow: CLAUDE_REGISTRY }));
  assert.equal(settings(com)['design-system-agents@kette'], false, 'login in a Community repo keeps it Community');
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise'], rec));
  ok(await kette(box, ['init', ent, '--instance', 'acme', ...SETUP], { ...rec, projects: [ent], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['update', '--no-npm'], { ...rec, cwd: com, allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['update', '--no-npm'], { ...rec, cwd: ent, allow: CLAUDE_REGISTRY }));
  const market = path.join(box.home, '.kette', 'bundles', 'marketplace', 'plugins');
  assert.deepEqual(fs.readdirSync(market).sort(), ['design-review-pack', 'design-system-agents', 'kette-engineering', 'kette-engineering-core', 'ui-laws']);
  ok(await kette(box, ['doctor'], { ...rec, cwd: ent }));
  ok(await kette(box, ['doctor'], { ...rec, cwd: com }));
  ok(await kette(box, ['logout', '--no-npm'], { ...rec, cwd: com, allow: CLAUDE_REGISTRY }));
  assert.deepEqual(fs.readdirSync(market).sort(), ['kette-engineering-core', 'ui-laws']);
  ok(await kette(box, ['doctor'], { ...rec, cwd: com }));
  ok(await kette(box, ['doctor'], { ...rec, cwd: ent }), 1);
});

test('doctor --instance checks every repo and names a broken one', { skip }, async () => {
  const box = sandbox();
  const rec = { record: 'doctor-instance-broken' };
  const [good, gone, moved] = ['good', 'gone', 'moved'].map((n) => path.join(box.work, n));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec));
  for (const dir of [good, gone, moved]) ok(await kette(box, ['init', dir, '--instance', 'oss', ...SETUP], { ...rec, projects: [dir], allow: CLAUDE_REGISTRY }));
  fs.rmSync(gone, { recursive: true });
  const p = profile(moved);
  fs.writeFileSync(path.join(moved, '.kette', 'profile.json'), JSON.stringify({ ...p, instance: 'other' }, null, 2));
  const r = ok(await kette(box, ['doctor', '--instance', 'oss'], rec), 1);
  assert.match(r.out, /FAIL .*gone is gone\. Check it out again/);
  assert.match(r.out, /FAIL moved uses instance other\. Fix in the repo with: kette instance use oss/);
  assert.match(r.out, /Instance oss: 1 of 3 repos all good/);
});

// Bare git repo with an instance.json, the way a team shares an instance
function instanceRepo(box, name, edition) {
  const bare = path.join(box.root, 'remote', `${name}.git`);
  const work = path.join(box.root, 'remote', `${name}-work`);
  const git = (...args) => execFileSync('git', args, { env: box.env, stdio: 'pipe' });
  git('init', '-q', '--bare', bare);
  git('init', '-q', work);
  write(work, 'instance.json', JSON.stringify({ version: 1, name, edition, repos: [], members: [{ id: 'lead@example.com', role: 'owner' }], ticketing: { adapter: 'workbase', project: 'ZERO' }, wallet: { provider: 'infisical', project: 'team-secrets', env: 'dev' }, stations: ['tokens', 'library'] }, null, 2));
  git('-C', work, 'add', '.');
  git('-C', work, 'commit', '-q', '-m', 'instance');
  git('-C', work, 'push', '-q', bare, 'HEAD:main');
  git('--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  return bare;
}

test('an instance from a git repo is cloned, its settings are inherited, kette never deletes it', { skip }, async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'instance-from-git' };
  const repo = instanceRepo(box, 'team', 'community');
  ok(await kette(box, ['instance', 'create', 'team', '--from', repo], rec));
  const dir = path.join(box.home, '.kette', 'instances', 'team');
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  ok(await kette(box, ['init', app, '--instance', 'team', ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  const eff = JSON.parse(ok(await kette(box, ['profile', '--effective'], { ...rec, cwd: app })).out);
  assert.deepEqual(eff.ticketing, { adapter: 'workbase', project: 'ZERO' });
  assert.equal(eff.stack[0], 'nestjs-prisma', 'repo values stay');
  const member = ok(await kette(box, ['instance', 'members', 'add', 'dev@example.com', '--instance', 'team'], rec));
  assert.match(member.out, /Commit and push the change so the team and agents see it/);
  const rm = ok(await kette(box, ['instance', 'remove', 'team', '--yes'], rec), 1);
  assert.match(rm.out, /kette never deletes an instance repo/);
  assert.ok(fs.existsSync(path.join(dir, 'instance.json')));
  // A linked folder: remove drops only the link
  const linked = path.join(box.root, 'remote', 'team-work');
  ok(await kette(box, ['instance', 'create', 'team-link', '--from', linked], rec), 1);
  fs.writeFileSync(path.join(linked, 'instance.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(linked, 'instance.json'), 'utf8')), name: 'team-link' }));
  ok(await kette(box, ['instance', 'create', 'team-link', '--from', linked], rec));
  ok(await kette(box, ['instance', 'remove', 'team-link'], rec), 1);
  ok(await kette(box, ['instance', 'remove', 'team-link', '--yes'], rec));
  assert.ok(fs.existsSync(path.join(linked, 'instance.json')), 'the linked instance repo stays');
});

// Runs the CLI in a pseudo terminal (python pty) and answers each prompt once it shows up, like a person at the keyboard
async function interactive(box, argv, answers, { cwd = box.work } = {}) {
  const before = snapshot(box.root);
  // python3 -I: isolated mode, nothing from the working folder is imported
  const child = spawn('python3', ['-I', '-c', 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)', process.execPath, BIN, ...argv], { cwd, env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let next = 0;
  const onData = (c) => {
    out += c;
    while (next < answers.length && out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').includes(answers[next][0], answers[next].seen || 0)) {
      const [prompt, reply] = answers[next];
      const clean = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const at = clean.indexOf(prompt, answers[next].seen || 0);
      if (next + 1 < answers.length) answers[next + 1].seen = at + prompt.length;
      child.stdin.write(`${reply}\r`);
      next++;
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const code = await new Promise((resolve) => child.on('close', resolve));
  const outside = changed(before, snapshot(box.root)).filter((p) => !p.startsWith(path.join(cwd, argv[1] || '.'))).filter((p) => {
    const rel = path.relative(box.home, p).split(path.sep).join('/');
    return rel.startsWith('..') || !MACHINE.some((r) => r.test(rel));
  });
  results.push({ command: `kette ${argv.join(' ')} (terminal)`, scenario: 'onboarding', code, outside: outside.map((p) => path.relative(box.root, p)), userPlugins: userScopeKette(box), out: out.slice(-600) });
  return { code, out, outside: outside.map((p) => path.relative(box.root, p)), userPlugins: userScopeKette(box) };
}

test('onboarding: kette init in a terminal asks for the instance, creates a new one or picks an existing one', { skip: (process.platform === 'win32' || spawnSync('python3', ['--version']).status !== 0) && 'needs python3 for a pseudo terminal' }, async () => {
  const box = sandbox();
  ok(await kette(box, ['update'], { record: 'onboarding' }));
  const flags = ['--no-plugins', '--stack', 'nestjs-prisma', '--platform', 'github-docker', '--patterns', 'layered'];
  const fresh = ok(await interactive(box, ['init', 'one', ...flags], [['Choose (numbers', '2'], ['Name of the new instance', 'team'], ['Choose (numbers', '1'], ['Create these files?', 'y']]));
  assert.match(fresh.out, /Which Kette instance does this project belong to\?/);
  assert.equal(profile(path.join(box.work, 'one')).instance, 'team');
  assert.equal(readInstanceFile(box, 'team').edition, 'community');
  assert.deepEqual(readInstanceFile(box, 'team').repos.map((r) => r.name), ['one']);
  const pick = ok(await interactive(box, ['init', 'two', ...flags], [['Choose (numbers', '2'], ['Create these files?', 'y']]));
  assert.match(pick.out, /2\) Instance team \(Community\)/);
  assert.equal(profile(path.join(box.work, 'two')).instance, 'team');
  ok(await interactive(box, ['init', 'three', ...flags], [['Choose (numbers', '1'], ['Create these files?', 'y']]));
  assert.equal('instance' in profile(path.join(box.work, 'three')), false, 'none keeps the old behaviour');
  // A connected project is not asked again
  const again = ok(await kette(box, ['add', '--no-plugins', ...flags.slice(1), '--yes'], { cwd: path.join(box.work, 'one'), record: 'onboarding' }));
  assert.doesNotMatch(again.out, /Which Kette instance/);
});
