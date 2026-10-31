import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeBundle, fakeClaude, json, serve, sha256, tmp, write } from './helpers.mjs';
import { PART_FILES } from '../scripts/ticketing-part.mjs';

// Harness of the sandbox tests: every command of the CLI in a fresh sandbox HOME (HOME, ~/.kette, ~/.npmrc and the Claude Code config all in temp folders,
// delivery service and mirror as local fake servers), followed by a file system diff: outside the project folder only the
// allowed machine files may change. KETTE_MATRIX_OUT=<file> writes the results as JSON for the matrix in docs/instances.md.

export const BIN = fileURLToPath(new URL('../bin/kette.mjs', import.meta.url));
export const KEY = 'CDP-AAAAA-BBBBB-CCCCC-00001';
export const V = '0.20261020.9';
export const CV = '0.20261022.40';
// Every plugin carries an EDITION marker, so a test can see which bundle a copy in a marketplace came from
const marked = (edition, plugins) => Object.fromEntries([['rules/core/readability.md', `# Readability ${edition}\n`], ...plugins.map((p) => [`plugins/${p}/EDITION`, edition])]);
const ENTERPRISE_PLUGINS = ['kette-engineering-core', 'kette-engineering', 'design-system-agents', 'design-review-pack', 'kette-ticketing'];
const COMMUNITY_PLUGINS = ['kette-engineering-core', 'ui-laws'];
// Enterprise templates as kette-engineering ships them, so switching a repo to Community has files to remove
const TEMPLATES = {
  'profiles/stack/index.json': JSON.stringify({ 'nestjs-prisma': { role: 'api', flags: ['node', 'ts', 'nest', 'prisma', 'postgres'] } }),
  'profiles/platform/github-docker/render/index.json': JSON.stringify({ apps: { 'nestjs-prisma': { files: [{ from: 'nest/Dockerfile', to: 'Dockerfile' }] } }, files: [{ from: 'root/compose.yaml', to: 'compose.yaml' }, { from: 'root/ci.yml', to: '.github/workflows/ci.yml' }] }),
  'profiles/platform/github-docker/render/nest/Dockerfile': 'FROM node\n',
  'profiles/platform/github-docker/render/root/compose.yaml': 'services: {}\n',
  'profiles/platform/github-docker/render/root/ci.yml': 'jobs: {}\n',
  'checks/render/index.json': JSON.stringify({ files: [{ from: 'gitleaks.toml', to: '.gitleaks.toml' }] }),
  'checks/render/gitleaks.toml': '# gitleaks\n',
};
// The ticketing library is private (docs/adr/0003): tests take a built checkout from KETTE_TICKETING (default ../kette-ticketing) and
// ship it in the fake Enterprise bundle as the real release does; KETTE_TICKETING_DOUBLE=1 ships the public test double of the contract
// instead (test/fixtures/ticketing-double); KETTE_TICKETING_REQUIRED=1 fails when no built library is there (kette-ticketing CI)
export const TICKETING = path.resolve(process.env.KETTE_TICKETING || fileURLToPath(new URL('../../kette-ticketing', import.meta.url)));
export const DOUBLE = fileURLToPath(new URL('./fixtures/ticketing-double', import.meta.url));
export const useDouble = process.env.KETTE_TICKETING_DOUBLE === '1';
export const hasTicketing = !useDouble && fs.existsSync(path.join(TICKETING, 'dist', 'project.js')) && fs.existsSync(path.join(TICKETING, 'scripts', 'cli-facade.mjs'));
if (process.env.KETTE_TICKETING_REQUIRED === '1' && !hasTicketing) throw new Error(`KETTE_TICKETING_REQUIRED=1 but no built kette-ticketing in ${TICKETING}`);
const walkFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const partFrom = (src, prefix) => Object.fromEntries(walkFiles(src).map((f) => [`${prefix}/${path.relative(src, f).split(path.sep).join('/')}`, fs.readFileSync(f, 'utf8')]));
function ticketingPart() {
  if (useDouble) return partFrom(DOUBLE, 'ticketing');
  if (!hasTicketing) return {};
  // The plugin kette-ticketing as the release builds it: the intake agent and the /intake command (KETTE-30)
  const plugin = { ...partFrom(path.join(TICKETING, 'agent'), 'plugins/kette-ticketing/agents'), ...partFrom(path.join(TICKETING, 'commands'), 'plugins/kette-ticketing/commands') };
  return Object.assign(plugin, ...PART_FILES.map((f) => (fs.statSync(path.join(TICKETING, f)).isDirectory() ? partFrom(path.join(TICKETING, f), `ticketing/${f}`) : { [`ticketing/${f}`]: fs.readFileSync(path.join(TICKETING, f), 'utf8') })));
}
const enterpriseBundle = fakeBundle(V, ENTERPRISE_PLUGINS, { ...marked('enterprise', ENTERPRISE_PLUGINS), ...TEMPLATES, ...ticketingPart() });
const communityBundle = fakeBundle(CV, COMMUNITY_PLUGINS, marked('community', COMMUNITY_PLUGINS));
const figmaFiles = { 'zero.fig': 'zero-fig', 'IMPORT.md': '# Import\n' };
export const results = [];
let server;
let tools;
let vault;
export const state = { ci: [], valid: new Set() };

// Machine files a command may change outside the project, as paths relative to HOME
export const MACHINE = [/^\.kette\/(credentials|device-id|state\.json(\.bak)?)$/, /^\.kette\/bundles(\/|$)/, /^\.kette\/instances(\/|$)/, /^\.kette\/locks$/, /^\.kette$/];
// Global files Claude Code itself keeps for plugins of any scope (marketplace names, plugin cache), never the user settings
export const CLAUDE_REGISTRY = [/^\.claude\/plugins(\/|$)/, /^\.claude$/];
// Licence-bound npm auth of kette login (docs/instances.md, open decision D3)
export const NPMRC = [/^\.npmrc$/];
// itdone MCP server of kette cloud setup in the user scope of Claude Code (docs/instances.md, open decision D4)
export const MCP_USER = [/^\.claude\/\.claude\.json$/];

// Fake delivery service, mirror and provider stand-ins for one test file
export async function start() {
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
    // Windows starts neither shebang nor extensionless files; kette then falls back to <name>.cmd
    write(tools, `${name}.cmd`, `@node "${path.join(tools, name)}" %*\r\n`);
  };
  // One store per Infisical project and environment, so two projects on one machine keep their own values
  fake('infisical', `if (args[0] === '--version') { console.log('infisical version 0.43.50'); process.exit(0); }
const env = opt('--projectId') + '/' + opt('--env'); s[env] = s[env] || {};
if (args[0] === 'export') { console.log(JSON.stringify(Object.entries(s[env]).map(([key, value]) => ({ key, value })))); process.exit(0); }
if (args[0] === 'secrets' && args[1] === 'set') { const m = fs.readFileSync(opt('--file'), 'utf8').trim().match(/^([A-Z0-9_]+): (.*)$/); s[env][m[1]] = JSON.parse(m[2]); save(); process.exit(0); }
process.exit(9);`);
  fake('gh', `if (args[0] === 'secret' && args[1] === 'set') { fs.readFileSync(0, 'utf8'); process.exit(0); } process.exit(9);`);
}

// file: name of the test file, so two files never overwrite each other's matrix results
export async function stop(file) {
  await server.close();
  if (process.env.KETTE_MATRIX_OUT) fs.writeFileSync(`${process.env.KETTE_MATRIX_OUT}.${file}.json`, JSON.stringify(results, null, 2));
}

// Fresh machine: HOME with nothing in it, a work folder for projects next to it
// registry(home): marketplaces Claude Code knows already on this machine, e.g. the ones an older kette registered
export function sandbox({ registry = () => [] } = {}) {
  const root = fs.realpathSync(tmp());
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  // One fake claude per machine: it keeps the global marketplace registry of Claude Code
  const claude = fakeClaude(registry(home));
  // The Windows runners have a real gh.exe, which Windows would find before the gh.cmd stand-in; such folders stay out
  const withClaude = process.env.PATH.split(path.delimiter).filter((d) => process.platform !== 'win32' || !fs.existsSync(path.join(d, 'gh.exe'))).join(path.delimiter);
  claude.restore();
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'), KETTE_MIRROR: server.url, KETTE_DELIVERY: server.url, KETTE_REGISTRY: `${server.url}/`, KETTE_CLOUD_AUTH_URL: `${server.url}/realms/itdone`, PATH: `${tools}${path.delimiter}${withClaude}`, NO_COLOR: '1', CI: '1', KETTE_WALLET_TRUST: '1', KETTE_WALLET_PROJECT: 'proj-1', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  // A test run started from Claude Code must not make every sandbox command an agent run
  for (const k of ['KETTE_HOME', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig', 'FORCE_COLOR', 'KETTE_LICENSE_KEY', 'CLAUDECODE', 'KETTE_INTAKE_MODEL_URL', 'KETTE_INTAKE_OLLAMA_URL']) delete env[k];
  return { root, home, work, env, claude };
}

// Path to content hash (files), link target or "dir", for the whole sandbox
export function snapshot(dir) {
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

export function changed(before, afterSnap) {
  const paths = new Set([...before.keys(), ...afterSnap.keys()]);
  return [...paths].filter((p) => before.get(p) !== afterSnap.get(p)).sort();
}

// Runs the CLI as its own process (async, so the fake servers in this process can answer) and checks the diff
// node: extra arguments for node, e.g. --import of a test hook
export async function kette(box, argv, { cwd = box.work, projects = [], allow = [], input = '', record = null, node = [], env = {} } = {}) {
  const before = snapshot(box.root);
  const child = spawn(process.execPath, [...node, BIN, ...argv], { cwd, env: { ...box.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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

export function userScopeKette(box) {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(box.home, '.claude', 'settings.json'), 'utf8')).enabledPlugins || {}).filter((id) => id.endsWith('@kette')); } catch { return []; }
}

// Every check of a step in one place: exit code, nothing changed outside the allowed list, no Kette plugin in the user scope
export function ok(r, code = 0) {
  assert.equal(r.code, code, r.out);
  assert.deepEqual(r.outside, [], `changed outside the project and the allowed machine files:\n${r.outside.join('\n')}\n${r.out}`);
  assert.deepEqual(r.userPlugins, [], 'no Kette plugin in the user scope of Claude Code');
  return r;
}

export const settings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).enabledPlugins;
export const profile = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.kette', 'profile.json'), 'utf8'));
export const readInstanceFile = (box, name) => JSON.parse(fs.readFileSync(path.join(box.home, '.kette', 'instances', name, 'instance.json'), 'utf8'));
export const SETUP = ['--yes', '--stack', 'nestjs-prisma', '--platform', 'github-docker', '--patterns', 'layered'];
export const ENTERPRISE_ONLY = ['kette-engineering@kette-enterprise', 'design-system-agents@kette-enterprise', 'design-review-pack@kette-enterprise'];
export const posixOnly = process.platform === 'win32';


// Bare git repo with an instance.json, the way a team shares an instance
export function instanceRepo(box, name, edition) {
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

// Runs the CLI in a pseudo terminal (python pty) and answers each prompt once it shows up, like a person at the keyboard
export async function interactive(box, argv, answers, { cwd = box.work, allow = [], scenario = 'onboarding' } = {}) {
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
  // A prompt nobody answers must fail the test, not hang it
  const timer = setTimeout(() => { out += '\n[killed after 60 s waiting for a prompt]'; child.kill('SIGKILL'); }, 60000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  const outside = changed(before, snapshot(box.root)).filter((p) => !p.startsWith(path.join(cwd, argv[1] || '.'))).filter((p) => {
    const rel = path.relative(box.home, p).split(path.sep).join('/');
    return rel.startsWith('..') || ![...MACHINE, ...allow].some((r) => r.test(rel));
  });
  results.push({ command: `kette ${argv.join(' ')} (terminal)`, scenario, code, outside: outside.map((p) => path.relative(box.root, p)), userPlugins: userScopeKette(box), out: out.slice(-600) });
  return { code, out, outside: outside.map((p) => path.relative(box.root, p)), userPlugins: userScopeKette(box) };
}


// Fake board API for kette ticket: one simulated board per token (kette-ticketing's workload.zero simulator, or the board of the
// test double); every request is logged with its token; delayMs slows writes and onWrite sees each write as it arrives
export async function startBoard({ delayMs = 0, onWrite = null } = {}) {
  const boards = new Map();
  const requests = [];
  let simulator = null;
  if (hasTicketing) ({ createWorkbaseSimulator: simulator } = await import(pathToFileURL(path.join(TICKETING, 'dist', 'index.js')).href));
  const doubleBoard = () => {
    const tasks = [];
    return {
      async fetch(url, init) {
        const p = new URL(url).pathname.replace(/^\/api/, '');
        const reply = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body) });
        if (init.method === 'GET' && p.startsWith('/tasks/project/')) return reply(200, tasks.filter((t) => t.projectId === decodeURIComponent(p.slice(15))));
        if (init.method === 'POST' && p === '/tasks') { const t = { _id: String(tasks.length + 1).padStart(24, '0'), ...JSON.parse(init.body) }; tasks.push(t); return reply(201, t); }
        return reply(404, { message: 'not in the test double board' });
      },
      tasks,
    };
  };
  const server = await serve(async (req, res, body) => {
    const token = (req.headers.authorization || '').slice('Bearer '.length);
    const entry = { token, method: req.method, path: req.url };
    requests.push(entry);
    const board = boards.get(token);
    if (!board) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"statusCode":401,"message":"Unauthorized"}'); }
    if (req.method !== 'GET') { onWrite?.(entry); if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); }
    board.sim ??= simulator ? simulator({ baseUrl: `${server.url}/api`, projectId: board.project }) : doubleBoard();
    const answer = await board.sim.fetch(`${server.url}${req.url}`, { method: req.method, headers: { Authorization: req.headers.authorization }, ...(body ? { body } : {}) });
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(await answer.text());
  });
  return { url: server.url, api: `${server.url}/api`, boards, requests, close: server.close, writesTo: (t) => requests.filter((r) => r.token === t && r.method !== 'GET').length };
}

// No token value in any file of the sandbox (the provider store lives outside it, like a real vault) nor in the output
export function noSecret(box, r, secrets) {
  const files = [...snapshot(box.root).entries()].filter(([, v]) => v !== 'dir' && v !== 'git' && !v.startsWith('link:')).map(([f]) => f);
  for (const s of secrets) {
    assert.ok(!r.out.includes(s), `token in the output of ${r.out.slice(0, 200)}`);
    for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(s), `token written to ${path.relative(box.root, f)}`);
  }
  return r;
}

export const TICKET_TOKEN = 'KETTE_TICKETING_WORKBASE_TOKEN';

// Steps of the ticket scenarios against one board: each step returns everything that changed anywhere in the sandbox (all)
export function ticketKit(board) {
  const env = () => ({ KETTE_TICKETING_API: board.api, KETTE_INTAKE_OLLAMA_URL: 'http://127.0.0.1:9/v1/chat/completions' });
  async function step(box, argv, opts = {}) {
    const before = snapshot(box.root);
    const r = await kette(box, argv, { record: opts.record || 'ticket', ...opts, env: { ...env(), ...opts.env } });
    return { ...r, all: changed(before, snapshot(box.root)).map((p) => path.relative(box.root, p).split(path.sep).join('/')) };
  }
  const licensed = async (box) => ok(await step(box, ['login', KEY, '--no-plugins', '--no-npm']));
  // An Enterprise repo of instance name with a wallet; extra goes into instance.json (stations, ticketing.session)
  async function enterpriseRepo(box, name, { stations = ['prototype', 'app'], walletProject = `wallet-${name}`, extra = {} } = {}) {
    const dir = path.join(box.work, `${name}-app`);
    ok(await step(box, ['instance', 'create', name, '--edition', 'enterprise']));
    ok(await step(box, ['instance', 'members', 'add', `lead@${name}.test`, '--role', 'owner', '--instance', name]));
    const f = path.join(box.home, '.kette', 'instances', name, 'instance.json');
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), stations, ...extra }, null, 2));
    ok(await step(box, ['init', dir, '--instance', name, '--no-plugins', ...SETUP], { projects: [dir] }));
    ok(await step(box, ['wallet', 'init', '--yes'], { cwd: dir, env: { KETTE_WALLET_PROJECT: walletProject } }));
    return dir;
  }
  async function connected(box, name, project, token, opts = {}) {
    const dir = await enterpriseRepo(box, name, opts);
    noSecret(box, ok(await step(box, ['ticket', 'connect', 'workload-zero', '--project', project, '--yes'], { cwd: dir })), [token]);
    noSecret(box, ok(await step(box, ['wallet', 'set', TICKET_TOKEN, '--env', 'dev', '--stdin'], { cwd: dir, input: `${token}\n` })), [token]);
    board.boards.set(token, { project });
    return dir;
  }
  return { env, step, licensed, enterpriseRepo, connected, rel: (box, dir, f) => path.relative(box.root, path.join(dir, f)).split(path.sep).join('/') };
}
