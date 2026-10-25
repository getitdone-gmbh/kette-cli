import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, tmp, write } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { exampleNames, namesFor, newWallet, validateWallet } from '../src/wallet/config.mjs';
import { azureName, fill, reason } from '../src/wallet/providers.mjs';

const saved = { ...process.env };
// process.env is case-insensitive on Windows, a copy is not (the key there is Path)
const basePath = process.env.PATH;
const cwd = process.cwd();
let project;
let bin;
let store;

const run = (...argv) => capture(() => main(argv));
const readStore = () => JSON.parse(fs.readFileSync(store, 'utf8'));
const calls = () => (fs.existsSync(path.join(bin, 'calls.log')) ? fs.readFileSync(path.join(bin, 'calls.log'), 'utf8') : '');

// Stand-in for a provider CLI: keeps values per environment in store.json and logs every call without stdin
function fakeBin(name, body) {
  write(bin, name, `#!/usr/bin/env node
const fs = require('node:fs');
const store = ${JSON.stringify(store)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(bin, 'calls.log'))}, ${JSON.stringify(name)} + ' ' + args.join(' ') + '\\n');
const s = JSON.parse(fs.readFileSync(store, 'utf8'));
const save = () => fs.writeFileSync(store, JSON.stringify(s));
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const stdin = () => fs.readFileSync(0, 'utf8');
${body}
`);
  fs.chmodSync(path.join(bin, name), 0o755);
  // Windows starts neither shebang nor extensionless files; the CLI then falls back to <name>.cmd
  write(bin, `${name}.cmd`, `@node "${path.join(bin, name)}" %*\r\n`);
}

function enterprise(on = true) {
  const kh = process.env.KETTE_HOME;
  if (!on) return;
  write(kh, 'credentials', JSON.stringify({ key: 'CDP-AAAAA-BBBBB-CCCCC-00001' }));
  write(path.join(kh, 'bundle'), 'schema/profile.schema.json', JSON.stringify({ type: 'object' }));
  fs.writeFileSync(path.join(kh, 'state.json'), JSON.stringify({ bundle_enterprise: { version: '0.1.0', dir: path.join(kh, 'bundle') } }));
}

function wallet(provider = { id: 'infisical', project: 'p1' }, secrets = [{ name: 'DATABASE_URL' }, { name: 'API_KEY', apps: ['api'] }], environments = ['dev', 'prod']) {
  write(project, '.kette/wallet.json', JSON.stringify({ version: 1, provider, environments, secrets }));
}

beforeEach(() => {
  process.env.KETTE_HOME = tmp();
  project = tmp();
  bin = tmp();
  store = path.join(bin, 'store.json');
  fs.writeFileSync(store, JSON.stringify({ dev: {}, prod: {} }));
  process.env.PATH = `${bin}${path.delimiter}${basePath}`;
  process.env.KETTE_WALLET_TRUST = '1';
  process.chdir(project);
  fakeBin('infisical', `
if (args[0] === '--version') { console.log('infisical version 0.43.50'); process.exit(0); }
const env = opt('--env');
if (args[0] === 'export') { console.log(JSON.stringify(Object.entries(s[env] || {}).map(([key, value]) => ({ key, value })))); process.exit(0); }
if (args[0] === 'secrets' && args[1] === 'set') {
  const text = fs.readFileSync(opt('--file'), 'utf8').trim();
  const m = text.match(/^([A-Z0-9_]+): (.*)$/);
  s[env][m[1]] = JSON.parse(m[2]); save(); process.exit(0);
}
process.exit(9);`);
  fakeBin('gh', `
if (args[0] === 'secret' && args[1] === 'set') { s.gh = s.gh || {}; s.gh[opt('--env') + ':' + args[2]] = stdin(); save(); process.exit(0); }
process.exit(9);`);
});

afterEach(() => {
  process.chdir(cwd);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  process.env.PATH = basePath;
});

test('wallet needs Enterprise, help works without it', async () => {
  wallet();
  await assert.rejects(run('wallet', 'status'), /part of Enterprise \(Die Kette\)/);
  const { result, out } = await run('wallet', 'help');
  assert.equal(result, 0);
  assert.match(out, /kette wallet run --env <env> -- <command>/);
  assert.match(out, /Get IT Done never sees or stores a value/);
});

test('init writes names from .env.example, default Infisical, and sets platform.secrets in the profile', async () => {
  enterprise();
  write(project, '.env.example', 'DATABASE_URL=postgres://localhost\n# comment\nexport API_KEY=\nlower=x\n');
  write(project, 'apps/api/.env.example', 'JWT_SECRET=\nAPI_KEY=\n');
  write(project, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'Shop' }, apps: { 'nestjs-prisma': 'apps/api' }, platform: { id: 'github-docker' } }));
  process.env.KETTE_WALLET_PROJECT = 'proj-1';
  const { result } = await run('wallet', 'init', '--yes');
  assert.equal(result, 0);
  const w = JSON.parse(fs.readFileSync('.kette/wallet.json', 'utf8'));
  assert.deepEqual(w.provider, { id: 'infisical', project: 'proj-1' });
  assert.deepEqual(w.environments, ['dev', 'staging', 'prod']);
  assert.deepEqual(w.secrets.map((s) => s.name), ['DATABASE_URL', 'API_KEY', 'JWT_SECRET']);
  assert.equal(JSON.parse(fs.readFileSync('.kette/profile.json', 'utf8')).platform.secrets, 'infisical');
  await assert.rejects(run('wallet', 'init', '--yes'), /exists already/);
});

test('init without project ID stops and writes nothing', async () => {
  enterprise();
  await assert.rejects(run('wallet', 'init', '--yes'), /provider\.project is required/);
  assert.equal(fs.existsSync('.kette/wallet.json'), false);
});

test('status lists missing names per environment and never prints a value', async () => {
  enterprise();
  wallet();
  fs.writeFileSync(store, JSON.stringify({ dev: { DATABASE_URL: 'super-secret-1', API_KEY: 'super-secret-2' }, prod: { DATABASE_URL: 'super-secret-3' } }));
  const { result, out } = await run('wallet', 'status');
  assert.equal(result, 1);
  assert.match(out, /dev: all 2 set/);
  assert.match(out, /prod: 1 of 2 set, missing API_KEY/);
  assert.doesNotMatch(out, /super-secret/);
});

test('set stores the value from stdin through a file, not as an argument', async () => {
  enterprise();
  wallet();
  const value = 'p@ss "w0rd" #1 ${X}\nline2';
  const file = path.join(tmp(), 'v');
  fs.writeFileSync(file, value);
  const fd = fs.openSync(file, 'r');
  const orig = fs.readFileSync;
  // --stdin reads fd 0; the test hands it the file instead
  fs.readFileSync = (p, ...rest) => (p === 0 ? orig(fd, ...rest) : orig(p, ...rest));
  try {
    const { result } = await run('wallet', 'set', 'DATABASE_URL', '--env', 'dev', '--stdin');
    assert.equal(result, 0);
  } finally {
    fs.readFileSync = orig;
    fs.closeSync(fd);
  }
  assert.equal(readStore().dev.DATABASE_URL, value);
  assert.doesNotMatch(calls(), /w0rd/);
});

test('set refuses undeclared names and unknown environments', async () => {
  enterprise();
  wallet();
  await assert.rejects(run('wallet', 'set', 'OTHER', '--env', 'dev', '--stdin'), /not declared for dev/);
  await assert.rejects(run('wallet', 'set', 'DATABASE_URL', '--env', 'qa', '--stdin'), /Environment qa is not in the wallet/);
  await assert.rejects(run('wallet', 'set', 'bad-name', '--env', 'dev'), /environment variable names/);
});

test('add and remove change only the declaration', async () => {
  enterprise();
  wallet();
  const { result } = await run('wallet', 'add', 'SMTP_PASSWORD', '--env', 'prod', '--app', 'api', '--note', 'Mail login', '--yes');
  assert.equal(result, 0);
  let w = JSON.parse(fs.readFileSync('.kette/wallet.json', 'utf8'));
  assert.deepEqual(w.secrets.at(-1), { name: 'SMTP_PASSWORD', environments: ['prod'], apps: ['api'], note: 'Mail login' });
  await assert.rejects(run('wallet', 'add', 'SMTP_PASSWORD', '--yes'), /declared already/);
  await run('wallet', 'remove', 'SMTP_PASSWORD');
  w = JSON.parse(fs.readFileSync('.kette/wallet.json', 'utf8'));
  assert.equal(w.secrets.some((s) => s.name === 'SMTP_PASSWORD'), false);
});

test('run passes only the declared secrets of the app and environment to the command', async () => {
  enterprise();
  wallet({ id: 'infisical', project: 'p1' }, [{ name: 'DATABASE_URL' }, { name: 'API_KEY', apps: ['api'] }, { name: 'WEB_ONLY', apps: ['web'] }]);
  fs.writeFileSync(store, JSON.stringify({ dev: { DATABASE_URL: 'db', API_KEY: 'key', WEB_ONLY: 'w', UNDECLARED: 'u' }, prod: {} }));
  const out = path.join(tmp(), 'env.json');
  const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ d: process.env.DATABASE_URL, a: process.env.API_KEY, w: process.env.WEB_ONLY, u: process.env.UNDECLARED }))`;
  const { result } = await run('wallet', 'run', '--env', 'dev', '--app', 'api', '--', process.execPath, '-e', script);
  assert.equal(result, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { d: 'db', a: 'key' });
});

test('run stops before the command when a declared secret is missing, and returns the exit code of the command', async () => {
  enterprise();
  wallet();
  fs.writeFileSync(store, JSON.stringify({ dev: { DATABASE_URL: 'db', API_KEY: 'k' }, prod: { DATABASE_URL: 'db' } }));
  await assert.rejects(run('wallet', 'run', '--env', 'prod', '--', process.execPath, '-e', '1'), /Missing in prod: API_KEY/);
  const { result } = await run('wallet', 'run', '--env', 'dev', '--', process.execPath, '-e', 'process.exit(7)');
  assert.equal(result, 7);
});

test('an unconfirmed provider is refused without a terminal', async () => {
  enterprise();
  wallet();
  delete process.env.KETTE_WALLET_TRUST;
  await assert.rejects(run('wallet', 'run', '--env', 'dev', '--', 'true'), /Run kette wallet trust in a terminal/);
});

// Windows runners ship real gh, aws and az executables, which a stand-in .cmd cannot shadow
const REAL_TOOLS = process.platform === 'win32';

test('sync github copies values on stdin after a yes, dry run copies nothing', { skip: REAL_TOOLS }, async () => {
  enterprise();
  wallet();
  fs.writeFileSync(store, JSON.stringify({ dev: {}, prod: { DATABASE_URL: 'db', API_KEY: 'k' } }));
  const dry = await run('wallet', 'sync', 'github', '--env', 'prod', '--dry-run');
  assert.match(dry.out, /Copies 2 secrets from prod into GitHub environment prod/);
  assert.equal(readStore().gh, undefined);
  const { result } = await run('wallet', 'sync', 'github', '--env', 'prod', '--github-env', 'production', '--yes');
  assert.equal(result, 0);
  assert.deepEqual(readStore().gh, { 'production:DATABASE_URL': 'db', 'production:API_KEY': 'k' });
  assert.doesNotMatch(calls(), /\bdb\b|\bk\b/);
});

test('own wallet through commands: read prints the value, write takes it on stdin', { skip: process.platform === 'win32' }, async () => {
  enterprise();
  const dir = tmp();
  wallet({ id: 'command', read: `cat ${dir}/{env}.{name}`, write: `cat > ${dir}/{env}.{name}` }, [{ name: 'TOKEN' }]);
  fs.writeFileSync(path.join(dir, 'dev.TOKEN'), 'abc\n');
  let r = await run('wallet', 'status', '--env', 'dev');
  assert.match(r.out, /dev: all 1 set/);
  r = await run('wallet', 'status', '--env', 'prod');
  assert.match(r.out, /missing TOKEN/);
  const out = path.join(tmp(), 'v');
  r = await run('wallet', 'run', '--env', 'dev', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.TOKEN)`);
  assert.equal(fs.readFileSync(out, 'utf8'), 'abc');
});

test('doctor names the wallet and its edition', async () => {
  wallet();
  const { out } = await run('doctor');
  assert.match(out, /Secret wallet \(infisical, 2 names, dev, prod\)/);
  assert.match(out, /needs Enterprise/);
});

test('validateWallet catches broken files', () => {
  assert.deepEqual(validateWallet(newWallet({ id: 'infisical', project: 'p' }, ['dev'], ['A'])), []);
  const errs = validateWallet({ version: 2, provider: { id: 'infisical', domain: 'http://x' }, environments: ['Dev'], secrets: [{ name: 'a' }, { name: 'B', environments: ['qa'] }], extra: 1 });
  assert.ok(errs.includes('unknown field extra'));
  assert.ok(errs.includes('version must be 1'));
  assert.ok(errs.includes('provider.project is required for infisical'));
  assert.ok(errs.includes('provider.domain must be an https URL'));
  assert.ok(errs.some((e) => e.startsWith('environments must')));
  assert.ok(errs.some((e) => e.startsWith('secrets[0].name')));
  assert.deepEqual(validateWallet({ version: 1, provider: { id: 'command', read: 'x', write: 'y', shell: 'zsh' }, environments: ['dev'], secrets: [] }), ['provider.shell must be sh, bash or pwsh']);
});

test('helpers: names per app and environment, example names, Azure names, templates, error lines', () => {
  const w = { environments: ['dev', 'prod'], secrets: [{ name: 'A' }, { name: 'B', environments: ['prod'] }, { name: 'C', apps: ['web'] }] };
  assert.deepEqual(namesFor(w, 'dev'), ['A', 'C']);
  assert.deepEqual(namesFor(w, 'prod', 'api'), ['A', 'B']);
  const d = tmp();
  write(d, '.env.example', 'X=1\nY=\n');
  assert.deepEqual(exampleNames(d), ['X', 'Y']);
  assert.equal(azureName('prod', 'DATABASE_URL'), 'prod--DATABASE-URL');
  assert.equal(fill('op read op://{env}/{name}', 'dev', 'TOKEN'), 'op read op://dev/TOKEN');
  assert.equal(reason({ code: 1, err: 'Request: GET https://x\nResponse Code: 404\nMessage: Folder with path \'/a\' was not found.\n' }), "Folder with path '/a' was not found.");
  assert.equal(reason({ code: 1, err: '\x1b[90mtime\x1b[0m INF No valid login session found\nerror: ^D\n' }), 'time INF No valid login session found');
});

test('Vault, AWS and Azure: values round-trip through their CLIs without showing up as arguments', { skip: REAL_TOOLS }, async () => {
  enterprise();
  fakeBin('vault', `
if (args[0] === '--version') { console.log('Vault v1.17.0'); process.exit(0); }
const key = args.at(-1).includes('=') ? args.at(-2) : args.at(-1);
const env = key.split('/').at(-1);
if (args[1] === 'get') { if (!Object.keys(s[env]).length) { console.error('No value found at secret/data/' + key); process.exit(2); } console.log(JSON.stringify({ data: { data: s[env] } })); process.exit(0); }
if (args[1] === 'patch' && !Object.keys(s[env]).length) { console.error('Error: no value found, 404'); process.exit(2); }
const [name] = args.at(-1).split('=');
s[env][name] = stdin(); save(); process.exit(0);`);
  fakeBin('aws', `
if (args[0] === '--version') { console.log('aws-cli/2.17'); process.exit(0); }
const id = opt('--secret-id') || opt('--name'); const env = id.split('/').at(-1);
if (args[1] === 'get-secret-value') { if (!s[env].__aws) { console.error('An error occurred (ResourceNotFoundException)'); process.exit(254); } console.log(s[env].__aws); process.exit(0); }
s[env].__aws = fs.readFileSync(opt('--secret-string').replace('file://', ''), 'utf8'); save(); process.exit(0);`);
  fakeBin('az', `
if (args[0] === 'version') { console.log('2.65.0'); process.exit(0); }
const n = opt('--name');
if (args[2] === 'show') { if (!(n in s.dev)) { console.error('(SecretNotFound) A secret with (name/id) ' + n + ' was not found'); process.exit(3); } console.log(s.dev[n]); process.exit(0); }
s.dev[n] = fs.readFileSync(opt('--file'), 'utf8'); save(); process.exit(0);`);
  const providers = [
    { id: 'vault', path: 'apps/shop' },
    { id: 'aws-secrets-manager', prefix: 'shop', region: 'eu-central-1' },
    { id: 'azure-key-vault', vault: 'kv-shop' },
  ];
  for (const provider of providers) {
    fs.writeFileSync(store, JSON.stringify({ dev: {}, prod: {} }));
    fs.writeFileSync(path.join(bin, 'calls.log'), '');
    wallet(provider, [{ name: 'API_KEY' }, { name: 'DB_URL' }], ['dev']);
    let r = await run('wallet', 'status');
    assert.match(r.out, /dev: 0 of 2 set, missing API_KEY, DB_URL/, provider.id);
    for (const [name, value] of [['API_KEY', 'k "1" #x'], ['DB_URL', 'postgres://u:p@h/d']]) {
      const file = path.join(tmp(), 'v');
      fs.writeFileSync(file, value);
      const fd = fs.openSync(file, 'r');
      const orig = fs.readFileSync;
      fs.readFileSync = (p, ...rest) => (p === 0 ? orig(fd, ...rest) : orig(p, ...rest));
      try { await run('wallet', 'set', name, '--env', 'dev', '--stdin'); } finally { fs.readFileSync = orig; fs.closeSync(fd); }
    }
    r = await run('wallet', 'status');
    assert.match(r.out, /dev: all 2 set/, provider.id);
    const out = path.join(tmp(), 'env.json');
    await run('wallet', 'run', '--env', 'dev', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify([process.env.API_KEY, process.env.DB_URL]))`);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), ['k "1" #x', 'postgres://u:p@h/d'], provider.id);
    assert.doesNotMatch(calls(), /postgres|#x/, provider.id);
  }
});

test('import moves .env values into the wallet, declares new names, prints names only', async () => {
  enterprise();
  wallet();
  write(project, '.env', '# local\nDATABASE_URL="postgres://u:p@h/d"\nexport NEW_TOKEN=tok-1 # comment\nEMPTY=\nlower=x\n');
  const { result, out } = await run('wallet', 'import', '.env', '--env', 'dev', '--yes');
  assert.equal(result, 0);
  assert.deepEqual(readStore().dev, { DATABASE_URL: 'postgres://u:p@h/d', NEW_TOKEN: 'tok-1' });
  const w = JSON.parse(fs.readFileSync('.kette/wallet.json', 'utf8'));
  assert.ok(w.secrets.some((s) => s.name === 'NEW_TOKEN'));
  assert.match(out, /Skipped, not an environment variable name: lower/);
  assert.match(out, /Skipped, empty: EMPTY/);
  assert.doesNotMatch(out, /postgres:|tok-1/);
  assert.equal(fs.existsSync('.env'), true);
  assert.match(out, /Delete \.env once everything starts with kette wallet run --env dev/);
});

test('import --dry-run changes nothing, a name limited to other environments stops it', async () => {
  enterprise();
  wallet({ id: 'infisical', project: 'p1' }, [{ name: 'PROD_ONLY', environments: ['prod'] }]);
  write(project, '.env', 'A=1\n');
  const dry = await run('wallet', 'import', '.env', '--env', 'dev', '--dry-run');
  assert.match(dry.out, /nothing imported/);
  assert.deepEqual(readStore().dev, {});
  write(project, '.env', 'PROD_ONLY=1\n');
  await assert.rejects(run('wallet', 'import', '.env', '--env', 'dev', '--yes'), /Declared for other environments only: PROD_ONLY/);
});

test('init --yes takes the Infisical project from .infisical.json and checks every environment', async () => {
  enterprise();
  write(project, '.infisical.json', JSON.stringify({ workspaceId: 'ws-42', defaultEnvironment: '' }));
  write(project, '.env', 'A=1\n');
  const { result, out } = await run('wallet', 'init', '--yes', '--env', 'dev,prod');
  assert.equal(result, 0);
  assert.equal(JSON.parse(fs.readFileSync('.kette/wallet.json', 'utf8')).provider.project, 'ws-42');
  assert.match(out, /dev reachable/);
  assert.match(out, /prod reachable/);
  assert.match(out, /kette wallet import \.env --env dev/);
});

test('doctor suggests the wallet in an Enterprise project without one, says nothing for Community', async () => {
  write(project, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], platform: { id: 'github-docker' }, patterns: ['layered'], tier: 'enterprise' }));
  let r = await run('doctor');
  assert.doesNotMatch(r.out, /No secret wallet/);
  enterprise();
  r = await run('doctor');
  assert.match(r.out, /INFO No secret wallet in this project yet/);
});

test('helpers: linked Infisical project, sign-in through a machine identity token', async () => {
  const { linkedProject, signedIn } = await import('../src/wallet/infisical.mjs');
  const d = tmp();
  assert.equal(linkedProject(d), null);
  write(d, '.infisical.json', '{"workspaceId":" ws-1 "}');
  assert.equal(linkedProject(d), 'ws-1');
  write(d, '.infisical.json', 'not json');
  assert.equal(linkedProject(d), null);
  assert.equal(signedIn('', { INFISICAL_TOKEN: 'x' }), true);
});

test('hidden prompts drop bracketed-paste markers and control characters', async () => {
  const { cleanSecret } = await import('../src/prompt.mjs');
  assert.equal(cleanSecret('\x1b[200~CDP-AB12C-11111-22222-33333\x1b[201~'), 'CDP-AB12C-11111-22222-33333');
  assert.equal(cleanSecret('  p@ss "w0rd" #1\x07 '), 'p@ss "w0rd" #1');
});
