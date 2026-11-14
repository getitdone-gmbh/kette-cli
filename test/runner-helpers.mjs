// Shared setup of the kette runner tests: isolated HOME and KETTE_HOME, a fake runner package, a recording exec and a fake claude
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, tarball, tmp, write } from './helpers.mjs';

// The consent text of the runner; kette shows it, it has no copy of its own (SEC768-04)
export const RUNNER_CONSENT = 'Agents would run without a sandbox: they can read your home folder, including the runner token and your Kette sign-in.';
export const CODE = 'zrc_ABCDEFGH2345_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

// A runner package like zero-agent-runner pack:release builds it; its bin.js logs argv and stdin and acts like register, update and unregister
// sandbox false acts like a machine without a working bwrap: register refuses before the code unless --accept-unsandboxed
export function fakeRunnerPackage(version = '0.3.0', { registerExit = 0, sandbox = true, refuse = '', preflight = true } = {}) {
  const src = tmp();
  write(src, 'zero-agent-runner/package.json', JSON.stringify({ name: 'zero-agent-runner', version }));
  write(src, 'zero-agent-runner/dist/bin.js', `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const [command, ...args] = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const dir = path.join(os.homedir(), '.config', 'zero-runner');
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(os.homedir(), 'runner-calls.log'), JSON.stringify({ command, args, stdin }) + '\\n');
if (command === 'preflight') {
  if (!${preflight}) { console.error('unknown command preflight'); process.exit(64); }
  console.log(JSON.stringify({ platform: 'linux', sandbox: ${sandbox} ? 'bwrap' : 'none', consentRequired: !${sandbox}, ...(${sandbox} ? {} : { consentText: '${RUNNER_CONSENT}' }), claude: { installed: true, signedIn: true, method: 'auth-status' } }));
} else if (command === 'register') {
  if (${JSON.stringify(refuse)}) { console.error(${JSON.stringify(refuse)}); process.exit(2); }
  if (!${sandbox} && !args.includes('--accept-unsandboxed')) { console.error('${RUNNER_CONSENT} Pass --accept-unsandboxed to allow it.'); process.exit(2); }
  if (!/^zrc_/.test(stdin.trim())) { console.error('That does not look like a registration code (zrc_...).'); process.exit(2); }
  if (${registerExit} !== 0) { console.error('The code was not accepted.'); process.exit(${registerExit}); }
  fs.writeFileSync(path.join(dir, 'token'), 'zr_secret_token\\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ installedBy: 'kette', adapter: 'local' }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: '${version}', executorName: 'build-box', workspaceName: 'Acme', licence: { usable: true, state: 'active', stale: false } }), { mode: 0o600 });
  console.log(JSON.stringify({ executorId: 'e1', executorName: 'build-box', workspaceName: 'Acme', licence: { usable: true, state: 'active' }, adapter: 'local', sandbox: 'bwrap' }));
} else if (command === 'unregister') {
  for (const f of ['token', 'config.json', 'state.json']) fs.rmSync(path.join(dir, f), { force: true });
  console.log(JSON.stringify({ revoked: true, removed: ['token', 'config.json', 'state.json'] }));
} else if (command === 'update') {
  console.log(JSON.stringify({ repos: args }));
}
`);
  const { buf, sha256: sum } = tarball(src, ['zero-agent-runner']);
  const file = path.join(tmp(), `zero-agent-runner-${version}.tgz`);
  fs.writeFileSync(file, buf);
  return { file, sha256: sum, buf, version };
}

// Fresh HOME and KETTE_HOME per test; signedIn writes credentials the way kette login keeps them
export function sandboxHome({ signedIn = true } = {}) {
  const homeDir = tmp();
  const ketteHome = path.join(homeDir, '.kette');
  fs.mkdirSync(ketteHome, { recursive: true });
  process.env.KETTE_HOME = ketteHome;
  if (signedIn) write(ketteHome, 'credentials', JSON.stringify({ key: 'CDP-AAAAA-BBBBB-CCCCC-DDDDD' }));
  return { homeDir, ketteHome };
}

// The machine as the runner command sees it; exec records system commands and runs node (the fake runner) for real
export function machine(homeDir, overrides = {}) {
  const calls = [];
  const claudeDir = tmp();
  write(claudeDir, 'claude', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(claudeDir, 'claude'), 0o755);
  const responses = overrides.responses || {};
  const exec = (cmd, args = [], options = {}) => {
    calls.push({ cmd, args, input: options.input });
    const key = [path.basename(cmd), ...args].join(' ');
    if (Object.hasOwn(responses, key)) return { status: 0, stdout: '', stderr: '', ...responses[key] };
    if (cmd === process.execPath) {
      const r = spawnSync(cmd, args, { input: options.input ?? '', encoding: 'utf8', env: { ...process.env, HOME: homeDir } });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    if (path.basename(cmd) === 'claude' && args[0] === '--version') return { status: 0, stdout: '2.1.287 (Claude Code)\n', stderr: '' };
    if (path.basename(cmd) === 'claude' && args.join(' ') === 'auth --help') return { status: 0, stdout: 'Commands:\n  login\n  logout\n  status\n', stderr: '' };
    if (path.basename(cmd) === 'claude' && args.join(' ') === 'auth status') return { status: 0, stdout: '', stderr: '' };
    if (path.basename(cmd) === 'bwrap') return { status: 0, stdout: 'bubblewrap 0.9.0\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const out = [];
  const io = {
    platform: 'linux',
    env: { PATH: `${claudeDir}:/usr/bin:/bin` },
    homeDir,
    uid: 1000,
    user: 'dev',
    nodeBin: process.execPath,
    nodeVersion: '22.11.0',
    exec,
    stdinIsTty: false,
    readStdinLine: async () => CODE,
    askSecret: async () => CODE,
    ask: async () => '',
    confirm: async () => false,
    hasTerminal: false,
    now: () => Date.parse('2026-11-14T22:00:00Z'),
    print: (s = '') => out.push(String(s)),
    printError: (s = '') => out.push(String(s)),
    ...overrides,
  };
  return { io, calls, out: () => out.join('\n'), claudeDir };
}

// The register call that carried the code; the dry runs before it get an empty stdin
export const realRegister = (homeDir) => runnerCalls(homeDir).find((c) => c.command === 'register' && c.stdin !== '');
export const registerCount = (homeDir) => runnerCalls(homeDir).filter((c) => c.command === 'register' && c.stdin !== '').length;

export const runnerCalls = (homeDir) => {
  const f = path.join(homeDir, 'runner-calls.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

// A git token file the way the customer saves it: mode 600, owned by the user
export function tokenFile(homeDir, mode = 0o600) {
  const f = path.join(homeDir, '.config', 'zero-runner-pat');
  write(path.dirname(f), path.basename(f), 'github_pat_value\n');
  fs.chmodSync(f, mode);
  return f;
}

export { sha256, tmp, write };
