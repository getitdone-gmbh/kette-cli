import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODE, fakeRunnerPackage, machine, runnerCalls, sandboxHome, tokenFile, write } from './runner-helpers.mjs';
import { runner } from '../src/runner/index.mjs';
import { parse } from '../src/cli.mjs';

const base = (pkg, extra = {}) => ({ from: pkg.file, sha256: pkg.sha256, repos: ['acme/app'], 'no-agent-push': true, ...extra });
const unit = (homeDir) => path.join(homeDir, '.config', 'systemd', 'user', 'kette-runner.service');
const plist = (homeDir) => path.join(homeDir, 'Library', 'LaunchAgents', 'de.itdone.kette-runner.plist');
const systemCalls = (calls) => calls.filter((c) => ['systemctl', 'launchctl', 'loginctl'].includes(path.basename(c.cmd))).map((c) => [path.basename(c.cmd), ...c.args].join(' '));

async function fails(promise, re, code) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, re);
    if (code !== undefined) assert.equal(err.exitCode, code);
    return true;
  });
}

test('parse: runner options, --repo repeatable and comma separated', () => {
  const o = parse(['runner', 'install', '--repo', 'acme/app', '--repo', 'acme/api,acme/web', '--code-stdin', '--accept-unsandboxed', '--no-agent-push', '--replace',
    '--wallet', 'file', '--git-token-file', '~/pat', '--name', 'box', '--api', 'http://localhost:1/run-protocol', '--from', 'r.tgz', '--sha256', 'ab', '--purge']);
  assert.deepEqual(o._, ['runner', 'install']);
  assert.deepEqual(o.repos, ['acme/app', 'acme/api', 'acme/web']);
  assert.equal(o.repo, 'acme/api,acme/web', 'kette wallet sync keeps its single --repo');
  for (const k of ['code-stdin', 'accept-unsandboxed', 'no-agent-push', 'replace', 'purge']) assert.equal(o[k], true, k);
  assert.equal(o.wallet, 'file');
  assert.equal(o['git-token-file'], '~/pat');
  assert.equal(o.sha256, 'ab');
});

test('install on Linux: verifies the package, pipes the code on stdin, writes the unit and enables it through exec', async () => {
  const { homeDir, ketteHome } = sandboxHome();
  const pkg = fakeRunnerPackage('0.3.0');
  const m = machine(homeDir);
  const pat = tokenFile(homeDir);
  const code = await runner('install', base(pkg, { 'no-agent-push': false, 'git-token-file': pat, wallet: 'file', name: 'box', replace: false }), m.io);
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(ketteHome, 'runner', '0.3.0', 'zero-agent-runner', 'dist', 'bin.js')));
  assert.equal(fs.readlinkSync(path.join(ketteHome, 'runner', 'current')), '0.3.0');
  const [reg] = runnerCalls(homeDir);
  assert.equal(reg.command, 'register');
  assert.equal(reg.stdin, `${CODE}\n`, 'the code arrives on stdin');
  assert.deepEqual(reg.args, ['--api', 'https://api.workbase.itdone.de/api/project-manager/api/run-protocol', '--repo', 'acme/app', '--git-token-file', pat, '--wallet', 'file', '--name', 'box']);
  for (const c of m.calls) assert.ok(!c.args.join(' ').includes(CODE), `code in argv of ${c.cmd}`);
  assert.ok(!m.out().includes(CODE), 'the code is never printed');
  assert.ok(!m.out().includes('zr_secret_token'), 'the token is never printed');
  assert.match(m.out(), /build-box/);
  assert.match(m.out(), /Acme/);
  assert.match(m.out(), /kette runner status/);
  const text = fs.readFileSync(unit(homeDir), 'utf8');
  const entry = path.join(ketteHome, 'runner', 'current', 'zero-agent-runner', 'dist', 'bin.js');
  assert.match(text, new RegExp(`^ExecStart="${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" "${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" start$`, 'm'));
  for (const line of ['Restart=on-failure', 'UMask=0077', 'NoNewPrivileges=yes', 'WantedBy=default.target']) assert.ok(text.includes(line), line);
  assert.doesNotMatch(text, /zrc_|zr_|TOKEN|SECRET|KEY=/i, 'no secrets in the unit');
  assert.deepEqual(systemCalls(m.calls), ['systemctl --user daemon-reload', 'systemctl --user enable --now kette-runner.service', 'loginctl show-user dev --property=Linger']);
  assert.match(m.out(), /loginctl enable-linger dev/);
});

test('install reads a hidden code at a terminal and warns for --code', async () => {
  const { homeDir } = sandboxHome();
  const pkg = fakeRunnerPackage();
  let asked = 0;
  const m = machine(homeDir, { stdinIsTty: true, hasTerminal: true, askSecret: async () => { asked++; return CODE; }, readStdinLine: async () => { throw new Error('stdin read'); } });
  assert.equal(await runner('install', base(pkg), m.io), 0);
  assert.equal(asked, 1);
  const { homeDir: h2 } = sandboxHome();
  const m2 = machine(h2, { stdinIsTty: true, hasTerminal: true, askSecret: async () => { throw new Error('asked'); } });
  assert.equal(await runner('install', base(pkg, { code: CODE }), m2.io), 0);
  assert.match(m2.out(), /The code may stay in your shell history/);
  assert.equal(runnerCalls(h2)[0].stdin, `${CODE}\n`);
});

test('install refuses a code that is no runner code before anything is registered', async () => {
  const { homeDir } = sandboxHome();
  const m = machine(homeDir, { readStdinLine: async () => 'hello' });
  await fails(runner('install', base(fakeRunnerPackage()), m.io), /does not look like a runner code/, 1);
  assert.deepEqual(runnerCalls(homeDir), []);
});

test('preflight: no kette login, old Node, no claude, claude not signed in; nothing written, no code read', async () => {
  const pkg = fakeRunnerPackage();
  const cases = [
    [{ signedIn: false }, {}, /Sign in first: kette login <key>/],
    [{}, { nodeVersion: '20.18.0' }, /Node 22 or newer/],
    [{}, { env: { PATH: '/nonexistent' } }, /Install Claude Code first/],
    [{}, { responses: { 'claude auth status': { status: 1 } } }, /Sign in to Claude Code first/],
  ];
  for (const [home, over, re] of cases) {
    const { homeDir, ketteHome } = sandboxHome(home);
    let read = false;
    const m = machine(homeDir, { ...over, readStdinLine: async () => { read = true; return CODE; } });
    await fails(runner('install', base(pkg), m.io), re, 1);
    assert.equal(read, false, `code read despite ${re}`);
    assert.ok(!fs.existsSync(path.join(ketteHome, 'runner')), `runner folder written despite ${re}`);
    assert.deepEqual(systemCalls(m.calls), []);
  }
});

test('preflight: an ANTHROPIC_API_KEY of the customer counts as signed in, older claude falls back to the credentials file', async () => {
  const pkg = fakeRunnerPackage();
  const { homeDir } = sandboxHome();
  const m = machine(homeDir, { responses: { 'claude auth status': { status: 1 } } });
  m.io.env.ANTHROPIC_API_KEY = 'sk-own';
  assert.equal(await runner('install', base(pkg), m.io), 0);
  const { homeDir: h2 } = sandboxHome();
  const m2 = machine(h2, { responses: { 'claude auth --help': { status: 1, stdout: '' } } });
  await fails(runner('install', base(pkg), m2.io), /Sign in to Claude Code first/, 1);
  write(path.join(h2, '.claude'), '.credentials.json', '{}');
  assert.equal(await runner('install', base(pkg), m2.io), 0);
  assert.ok(!m2.calls.some((c) => c.args.join(' ') === 'auth status'), 'auth status only when claude lists it');
});

test('repos: required, asked at a terminal, exit 64 without one; owner/name only', async () => {
  const pkg = fakeRunnerPackage();
  const { homeDir } = sandboxHome();
  await fails(runner('install', base(pkg, { repos: undefined }), machine(homeDir).io), /--repo owner\/name/, 64);
  await fails(runner('install', base(pkg, { repos: ['acme'] }), machine(homeDir).io), /acme is not owner\/name/, 64);
  const m = machine(homeDir, { hasTerminal: true, ask: async () => 'acme/app, acme/api' });
  assert.equal(await runner('install', base(pkg, { repos: undefined }), m.io), 0);
  assert.deepEqual(runnerCalls(homeDir)[0].args.filter((a, i, all) => all[i - 1] === '--repo'), ['acme/app', 'acme/api']);
});

test('git token file: required unless --no-agent-push, mode 600 checked, the value never read', async () => {
  const pkg = fakeRunnerPackage();
  const { homeDir } = sandboxHome();
  await fails(runner('install', base(pkg, { 'no-agent-push': false }), machine(homeDir).io), /--git-token-file/, 64);
  const loose = tokenFile(homeDir, 0o644);
  await fails(runner('install', base(pkg, { 'no-agent-push': false, 'git-token-file': loose }), machine(homeDir).io), /chmod 600/, 1);
  await fails(runner('install', base(pkg, { 'no-agent-push': false, 'git-token-file': path.join(homeDir, 'missing') }), machine(homeDir).io), /not found/, 1);
  const m = machine(homeDir);
  assert.equal(await runner('install', base(pkg), m.io), 0);
  assert.ok(runnerCalls(homeDir)[0].args.includes('--no-agent-push'));
  assert.ok(!m.out().includes('github_pat_value'));
});

test('wallet: file passes through, vault and infisical end with 64 and the manual setup', async () => {
  const pkg = fakeRunnerPackage();
  const { homeDir } = sandboxHome();
  for (const w of ['vault', 'infisical']) await fails(runner('install', base(pkg, { wallet: w }), machine(homeDir).io), /by hand.*vendor\/zero-wallet\/README\.md/, 64);
  await fails(runner('install', base(pkg, { wallet: 'aws' }), machine(homeDir).io), /--wallet file/, 64);
});

test('sandbox: without bwrap only with consent; --accept-unsandboxed passes through', async () => {
  const pkg = fakeRunnerPackage();
  const { homeDir } = sandboxHome();
  const noBwrap = { responses: { 'bwrap --version': { status: 127 } } };
  await fails(runner('install', base(pkg), machine(homeDir, noBwrap).io), /without a sandbox.*--accept-unsandboxed/s, 1);
  await fails(runner('install', base(pkg), machine(homeDir, { ...noBwrap, hasTerminal: true, confirm: async () => false }).io), /Cancelled/, 1);
  let question = '';
  const m = machine(homeDir, { ...noBwrap, hasTerminal: true, confirm: async (q) => { question = q; return true; } });
  assert.equal(await runner('install', base(pkg), m.io), 0);
  assert.match(question, /read your home folder/);
  assert.match(question, /git and gh login/);
  assert.ok(runnerCalls(homeDir)[0].args.includes('--accept-unsandboxed'));
  const { homeDir: h2 } = sandboxHome();
  assert.equal(await runner('install', base(pkg, { 'accept-unsandboxed': true }), machine(h2, noBwrap).io), 0);
  assert.ok(runnerCalls(h2)[0].args.includes('--accept-unsandboxed'));
});

test('macOS: LaunchAgent plist and launchctl bootstrap gui/<uid>, always with consent for running without sandbox', async () => {
  const { homeDir, ketteHome } = sandboxHome();
  const pkg = fakeRunnerPackage();
  const m = machine(homeDir, { platform: 'darwin', uid: 501 });
  await fails(runner('install', base(pkg), m.io), /without a sandbox/, 1);
  assert.equal(await runner('install', base(pkg, { 'accept-unsandboxed': true }), m.io), 0);
  const text = fs.readFileSync(plist(homeDir), 'utf8');
  assert.match(text, /<key>Label<\/key>\s*<string>de\.itdone\.kette-runner<\/string>/);
  assert.ok(text.includes(`<string>${path.join(ketteHome, 'runner', 'current', 'zero-agent-runner', 'dist', 'bin.js')}</string>`));
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.ok(text.includes(path.join(homeDir, 'Library', 'Logs', 'kette-runner.log')));
  assert.doesNotMatch(text, /zrc_|zr_|TOKEN|SECRET/i);
  assert.deepEqual(systemCalls(m.calls), [`launchctl bootout gui/501/de.itdone.kette-runner`, `launchctl bootstrap gui/501 ${plist(homeDir)}`]);
  assert.ok(!fs.existsSync(unit(homeDir)));
});

test('idempotent: a second install stops before the code, --replace registers again', async () => {
  const { homeDir } = sandboxHome();
  const pkg = fakeRunnerPackage();
  assert.equal(await runner('install', base(pkg), machine(homeDir).io), 0);
  let read = false;
  await fails(runner('install', base(pkg), machine(homeDir, { readStdinLine: async () => { read = true; return CODE; } }).io), /already set up.*--replace/s, 1);
  assert.equal(read, false);
  assert.equal(await runner('install', base(pkg, { replace: true }), machine(homeDir).io), 0);
  const regs = runnerCalls(homeDir).filter((c) => c.command === 'register');
  assert.equal(regs.length, 2);
  assert.ok(regs[1].args.includes('--replace'));
});

test('a runner kette did not set up (no installedBy kette) is never touched, not even with --replace', async () => {
  const { homeDir } = sandboxHome();
  write(path.join(homeDir, '.config', 'zero-runner'), 'config.json', JSON.stringify({ adapter: 'spark' }));
  write(path.join(homeDir, '.config', 'zero-runner'), 'token', 'zr_x\n');
  const m = machine(homeDir);
  await fails(runner('install', base(fakeRunnerPackage(), { replace: true }), m.io), /not set up by kette/, 1);
  assert.deepEqual(runnerCalls(homeDir), []);
  assert.deepEqual(systemCalls(m.calls), []);
});

test('a refused registration leaves no service and does not move current', async () => {
  const { homeDir, ketteHome } = sandboxHome();
  const m = machine(homeDir);
  await fails(runner('install', base(fakeRunnerPackage('0.3.0', { registerExit: 1 })), m.io), /registration failed/i, 1);
  assert.match(m.out(), /The code was not accepted/);
  assert.ok(!fs.existsSync(path.join(ketteHome, 'runner', 'current')));
  assert.ok(!fs.existsSync(unit(homeDir)));
  assert.deepEqual(systemCalls(m.calls), []);
});

test('--api and KETTE_RUNNER_API override the run protocol address', async () => {
  const pkg = fakeRunnerPackage();
  const { homeDir } = sandboxHome();
  await runner('install', base(pkg, { api: 'http://localhost:3011/api/run-protocol' }), machine(homeDir).io);
  assert.deepEqual(runnerCalls(homeDir)[0].args.slice(0, 2), ['--api', 'http://localhost:3011/api/run-protocol']);
  const { homeDir: h2 } = sandboxHome();
  const m = machine(h2);
  m.io.env.KETTE_RUNNER_API = 'http://127.0.0.1:9/api/run-protocol';
  await runner('install', base(pkg), m.io);
  assert.deepEqual(runnerCalls(h2)[0].args.slice(0, 2), ['--api', 'http://127.0.0.1:9/api/run-protocol']);
});

test('without --from the runner comes from the Enterprise bundle; a bundle without runner names kette update', async () => {
  const { homeDir, ketteHome } = sandboxHome();
  const pkg = fakeRunnerPackage('0.3.1');
  const bundle = path.join(ketteHome, 'bundles', 'enterprise', '0.20261114.9');
  write(bundle, '.claude-plugin/marketplace.json', '{}');
  write(path.join(ketteHome), 'state.json', JSON.stringify({ bundle_enterprise: { version: '0.20261114.9', dir: bundle } }));
  await fails(runner('install', { repos: ['acme/app'], 'no-agent-push': true }, machine(homeDir).io), /Run kette update to get the runner/, 1);
  fs.mkdirSync(path.join(bundle, 'runner'));
  fs.copyFileSync(pkg.file, path.join(bundle, 'runner', path.basename(pkg.file)));
  write(bundle, 'runner/manifest.json', JSON.stringify({ version: '0.3.1', file: path.basename(pkg.file), sha256: pkg.sha256, node: '>=22', entry: 'zero-agent-runner/dist/bin.js' }));
  assert.equal(await runner('install', { repos: ['acme/app'], 'no-agent-push': true }, machine(homeDir).io), 0);
  assert.equal(fs.readlinkSync(path.join(ketteHome, 'runner', 'current')), '0.3.1');
});

test('kette runner without action or with an unknown one shows the usage', async () => {
  const { homeDir } = sandboxHome();
  await fails(runner(undefined, {}, machine(homeDir).io), /Usage: kette runner install \| status \| update \| uninstall/, 2);
  await fails(runner('start', {}, machine(homeDir).io), /Usage: kette runner/, 2);
});
