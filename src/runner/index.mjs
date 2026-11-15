// kette runner install | status | update | uninstall: connects this machine as agent runner of a workload.zero workspace (docs/adr/0004, docs/runner.md)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ExitError } from '../errors.mjs';
import { credentialsStatus } from '../enterprise.mjs';
import { ENTERPRISE } from '../editions.mjs';
import { installedBundle } from '../manifest.mjs';
import { ask, askSecret, confirm } from '../prompt.mjs';
import { cmd, status } from '../out.mjs';
import { RUNNER_ASKS_CONSENT, RUNNER_WANTS_CODE, SIGN_IN, SIGN_IN_CLAUDE, checkClaude, checkNode, checkPlatform, checkTokenFile, claudeStatus, confirmUnsandboxed, findOnPath, repoList, walletOption } from './preflight.mjs';
import { currentEntry, currentVersion, discardIfUnused, installPackage, minNode, packageFromBundle, packageFromFile, removePackages, setCurrent } from './package.mjs';
import { SERVICE, UNIT, enableService, removeService, restartService, serviceFile, serviceStatus, writeService } from './service.mjs';
import { readCode, readStdinLine } from './secret-input.mjs';

// Production address of the run protocol; --api or KETTE_RUNNER_API for a test server
export const DEFAULT_API = 'https://api.workbase.itdone.de/api/project-manager/api/run-protocol';
export const RUNNER_HELP = `kette runner install | status | update | uninstall
                        Connect this machine as agent runner of your workload.zero workspace (macOS, Linux; not supported on Windows in this version)`;
const USAGE = 'Usage: kette runner install | status | update | uninstall (see kette help and docs/runner.md)';
const NONE = `No runner set up by kette on this machine. Set one up with: ${cmd('kette runner install')}`;
const FOREIGN = 'This machine has a runner that was not set up by kette. Remove it first; kette never changes it.';
const HEARTBEAT_OK_MS = 2 * 60 * 1000;

function canOpenTerminal() {
  if (process.stdin.isTTY) return true;
  if (process.platform === 'win32') return false;
  try { fs.closeSync(fs.openSync('/dev/tty', 'r')); return true; } catch { return false; }
}

function defaultIo() {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: os.homedir(),
    uid: process.getuid?.(),
    user: os.userInfo().username,
    nodeBin: process.execPath,
    nodeVersion: process.versions.node,
    exec: (command, args = [], { input } = {}) => {
      const r = spawnSync(command, args, { input: input ?? '', encoding: 'utf8', maxBuffer: 16 << 20 });
      return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    stdinIsTty: Boolean(process.stdin.isTTY),
    get hasTerminal() { return canOpenTerminal(); },
    readStdinLine,
    askSecret,
    ask,
    confirm,
    now: () => Date.now(),
    print: (s = '') => console.log(s),
    printError: (s = '') => console.error(s),
  };
}

const runnerConfigDir = (io) => path.join(io.homeDir, '.config', 'zero-runner');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// none, kette (config with installedBy kette) or foreign (any other config, or a token without config)
function existingRunner(io) {
  const dir = runnerConfigDir(io);
  const config = readJson(path.join(dir, 'config.json'));
  const token = fs.existsSync(path.join(dir, 'token'));
  if (!config && !fs.existsSync(path.join(dir, 'config.json'))) return { kind: token ? 'foreign' : 'none', token };
  return { kind: config?.installedBy === 'kette' ? 'kette' : 'foreign', token };
}

// The code must never come back through output of the child, even if it echoed it
const scrub = (text, code) => (code ? String(text).split(code).join('[code]') : String(text));
const lastJson = (stdout) => { const line = String(stdout).trim().split('\n').pop(); try { return JSON.parse(line); } catch { return null; } };

function source(opts) {
  if (opts.from || opts.sha256) return packageFromFile(opts.from, opts.sha256);
  const found = packageFromBundle(installedBundle(ENTERPRISE));
  if (!found) throw new ExitError(`The Enterprise bundle on this machine has no runner yet. Run kette update to get the runner.`, 1);
  return found;
}

// The JSON line of zero-runner preflight, null for a package without it
function runnerPreflight(io, bin) {
  const r = io.exec(io.nodeBin, [bin, 'preflight']);
  if (r.status !== 0) return null;
  const j = lastJson(r.stdout);
  return j && typeof j.consentRequired === 'boolean' ? j : null;
}

function requireLogin() {
  if (credentialsStatus() !== 'valid') throw new ExitError(SIGN_IN, 1);
}

function apiBase(opts, io) {
  return opts.api || io.env.KETTE_RUNNER_API || DEFAULT_API;
}

async function install(opts, io) {
  requireLogin();
  checkNode(io.nodeVersion);
  const claude = checkClaude(io);
  const wallet = walletOption(opts);
  const repos = await repoList(opts, io);
  const tokenFile = checkTokenFile(opts, io);
  const existing = existingRunner(io);
  if (existing.kind === 'foreign') throw new ExitError(FOREIGN, 1);
  if (existing.kind === 'kette' && existing.token && !opts.replace) {
    throw new ExitError(`A runner is already set up on this machine. Show it with ${cmd('kette runner status')}; register it again with a new code: ${cmd('kette runner install --replace')}`, 1);
  }
  const src = source(opts);
  if (src.node) checkNode(io.nodeVersion, minNode(src.node));
  const hadService = fs.existsSync(serviceFile(io));
  const pkg = installPackage(src);
  const bin = path.join(pkg.dir, pkg.entry);
  const args = (accept) => [
    'register', '--api', apiBase(opts, io),
    ...repos.flatMap((r) => ['--repo', r]),
    ...(tokenFile ? ['--git-token-file', tokenFile] : []),
    ...(opts['no-agent-push'] ? ['--no-agent-push'] : []),
    ...(wallet ? ['--wallet', wallet] : []),
    ...(opts.name ? ['--name', opts.name] : []),
    ...(accept ? ['--accept-unsandboxed'] : []),
    ...(opts.replace ? ['--replace'] : []),
  ];
  let accept = Boolean(opts['accept-unsandboxed']);
  let code;
  let r;
  try {
    // zero-runner preflight decides the sandbox with the runner's own probe and owns the consent text (CR768-09, SEC768-04)
    const pre = runnerPreflight(io, bin);
    if (pre?.claude && pre.claude.signedIn === false) throw new ExitError(pre.claude.installed ? SIGN_IN_CLAUDE : 'Install Claude Code first: https://docs.claude.com/en/docs/claude-code/setup', 1);
    if (pre?.consentRequired && !accept) {
      await confirmUnsandboxed(String(pre.consentText || '').trim(), io);
      accept = true;
    }
    // Dry run with an empty stdin: the runner runs all its own checks (sandbox, claude, config, socket path) and stops only at the missing code;
    // a package without preflight answers here with its consent text
    let dry = io.exec(io.nodeBin, [bin, ...args(accept)], { input: '' });
    if (!accept && dry.status !== 0 && RUNNER_ASKS_CONSENT.test(dry.stderr)) {
      await confirmUnsandboxed(String(dry.stderr).trim(), io);
      accept = true;
      dry = io.exec(io.nodeBin, [bin, ...args(accept)], { input: '' });
    }
    if (dry.status === 0 || !RUNNER_WANTS_CODE.test(dry.stderr)) {
      throw new ExitError(`The runner refused the setup, no code was read:\n${String(dry.stderr || dry.stdout).trim()}`, 1);
    }
    code = await readCode(opts, io);
    r = io.exec(io.nodeBin, [bin, ...args(accept)], { input: `${code}\n` });
    if (r.stderr) io.printError(scrub(r.stderr, code).trimEnd());
    if (r.status !== 0) throw new ExitError(`The runner registration failed (exit ${r.status}). The service was not set up; fix the cause and run the command again with a new code if the code was used.`, 1);
  } catch (err) {
    discardIfUnused(pkg);
    throw err;
  }
  const info = lastJson(scrub(r.stdout, code)) || {};

  setCurrent(pkg.version);
  writeService(io, { entry: currentEntry(pkg.entry), claudeBin: claude.bin });
  let hints = [];
  if (opts['no-service']) hints = [noServiceHint(io)];
  else {
    try {
      hints = enableService(io);
      // enable --now leaves a running unit on the old token; a replaced install restarts it (CR768-10)
      if (hadService && io.platform !== 'darwin') restartService(io);
    } catch (err) {
      throw new ExitError(`The runner is registered, but the service ${SERVICE} did not start: ${err.message}. Fix it and run ${cmd('kette runner update')}.`, 1);
    }
  }
  const unsandboxed = info.sandbox === 'none' || (accept && !info.sandbox);
  const licence = info.licence ? (info.licence.usable ? 'active' : `${info.licence.state || 'not usable'}, agents get no new runs until it is active`) : 'reported with the first heartbeat';
  io.print(`${status('ok', 'OK  ')} Runner ${pkg.version} connected: ${info.executorName || 'this machine'} in workspace ${info.workspaceName || '(unknown)'}.`);
  io.print(`${status('ok', 'OK  ')} Licence ${licence}.`);
  io.print(`${status('ok', 'OK  ')} Service ${SERVICE} ${opts['no-service'] ? 'written' : 'set up'} (${serviceFile(io)}).`);
  if (unsandboxed) io.print(`${status('warn', 'WARN')} Agents run without a sandbox on this machine.`);
  for (const h of hints) io.print(`${status('info', 'INFO')} ${h}`);
  io.print(`Check it with: ${cmd('kette runner status')}`);
  return 0;
}

const noServiceHint = (io) => (io.platform === 'darwin'
  ? `Service files written, not started (--no-service). Start it with: launchctl bootstrap gui/${io.uid} ${serviceFile(io)}`
  : `Service files written, not started (--no-service). Start it with: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}`);

// " (last checked YYYY-MM-DD HH:MM UTC)" for a known time of the last licence check, empty otherwise
const checkedText = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? ` (last checked ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''; };

const ago = (ms) => (ms < 120_000 ? `${Math.max(0, Math.round(ms / 1000))} s ago` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`);

function runnerStatus(opts, io) {
  const existing = existingRunner(io);
  if (existing.kind === 'foreign') {
    if (opts.json) io.print(JSON.stringify({ installed: false, foreign: true, ok: false }, null, 2)); else io.print(FOREIGN);
    return 1;
  }
  const state = readJson(path.join(runnerConfigDir(io), 'state.json'));
  if (existing.kind === 'none' && !state) {
    if (opts.json) io.print(JSON.stringify({ installed: false, ok: false }, null, 2)); else io.print(NONE);
    return 1;
  }
  const service = serviceStatus(io);
  const at = state?.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : NaN;
  const age = Number.isNaN(at) ? null : io.now() - at;
  const heartbeat = { at: state?.lastHeartbeatAt || null, ok: age !== null && age < HEARTBEAT_OK_MS };
  const licence = state?.licence || null;
  const claude = claudeStatus(io);
  const ok = service.active && heartbeat.ok && licence?.usable === true && claude.signedIn;
  const result = {
    installed: true, ok, version: state?.version || null, package: currentVersion(), executorName: state?.executorName || null, workspaceName: state?.workspaceName || null,
    registeredAt: state?.registeredAt || null, service: { name: SERVICE, ...service }, heartbeat, licence, claude: { installed: claude.installed, signedIn: claude.signedIn },
  };
  if (opts.json) { io.print(JSON.stringify(result, null, 2)); return ok ? 0 : 1; }
  const line = (good, text) => io.print(`${good ? status('ok', 'OK  ') : status('fail', 'FAIL')} ${text}`);
  io.print(`Runner ${result.version || result.package || '(unknown version)'} · ${result.executorName || 'unnamed'} in workspace ${result.workspaceName || '(unknown)'}`);
  if (service.tokenRefused) line(false, `Runner token revoked, run ${cmd('kette runner install --replace')} with a new code`);
  else line(service.active, service.active ? `Service ${SERVICE} is running` : `Service ${SERVICE} is not running (${service.detail}). ${io.platform === 'darwin' ? `Log: ~/Library/Logs/${SERVICE}.log` : `Log: journalctl --user -u ${SERVICE}`}`);
  line(heartbeat.ok, age === null ? 'No heartbeat yet' : `Last heartbeat ${ago(age)}`);
  if (!licence) line(false, 'Licence not reported yet');
  else if (licence.usable !== true && (!licence.state || /unknown/.test(licence.state))) line(false, `Licence status unknown${checkedText(licence.checkedAt)}, the check will be retried`);
  else line(licence.usable === true, licence.usable === true ? `Licence ${licence.state || 'active'}${licence.stale ? ' (last known state, the check is late)' : ''}` : `Licence ${licence.state}: agents get no new runs`);
  line(claude.signedIn, claude.signedIn ? 'Claude Code signed in' : claude.installed ? SIGN_IN_CLAUDE : 'Claude Code not found');
  return ok ? 0 : 1;
}

async function update(opts, io) {
  const existing = existingRunner(io);
  if (existing.kind === 'foreign') throw new ExitError(FOREIGN, 1);
  if (existing.kind !== 'kette') throw new ExitError(NONE, 1);
  requireLogin();
  checkNode(io.nodeVersion);
  const repos = opts.repos?.length ? await repoList(opts, io) : null;
  const src = source(opts);
  if (src.node) checkNode(io.nodeVersion, minNode(src.node));
  const pkg = installPackage(src);
  const before = currentVersion();
  if (pkg.version === before && !repos) { io.print(`Runner ${before} is up to date.`); return 0; }
  if (repos) {
    const r = io.exec(io.nodeBin, [path.join(pkg.dir, pkg.entry), 'update', ...repos.flatMap((x) => ['--repo', x])]);
    if (r.stderr) io.printError(String(r.stderr).trimEnd());
    if (r.status !== 0) throw new ExitError(`The repo list was not changed (exit ${r.status}).`, 1);
  }
  if (pkg.version !== before) {
    setCurrent(pkg.version);
    writeService(io, { entry: currentEntry(pkg.entry), claudeBin: findOnPath('claude', io.env.PATH) });
    if (!opts['no-service']) restartService(io, { reload: true });
    io.print(`${status('ok', 'OK  ')} Runner updated from ${before || '(none)'} to ${pkg.version}.`);
  } else if (!opts['no-service']) restartService(io);
  if (repos) io.print(`${status('ok', 'OK  ')} Agents may work on: ${repos.join(', ')}`);
  return 0;
}

function uninstall(opts, io) {
  const existing = existingRunner(io);
  if (existing.kind === 'foreign') { io.print(FOREIGN); return 1; }
  const work = path.join(io.homeDir, '.kette', 'runner-work');
  if (existing.kind === 'none' && !fs.existsSync(serviceFile(io)) && !currentVersion()) {
    io.print(NONE.split('.')[0] + '.');
    if (opts.purge && fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
    return 0;
  }
  if (removeService(io, { noService: Boolean(opts['no-service']) })) io.print(`${status('ok', 'OK  ')} Service ${SERVICE} stopped and removed.`);
  if (existing.kind === 'kette') {
    const entry = currentEntry();
    const r = fs.existsSync(entry) ? io.exec(io.nodeBin, [entry, 'unregister']) : { status: 1, stdout: '', stderr: '' };
    const reply = r.status === 0 ? lastJson(r.stdout) : null;
    if (reply?.revoked) io.print(`${status('ok', 'OK  ')} Runner token revoked on workload.zero.`);
    else io.print(`${status('warn', 'WARN')} The runner token could not be revoked on the server. Remove the runner in workload.zero under Settings, Agents.`);
    // unregister removes token, config and state itself; without it kette removes them, only for its own install
    for (const f of ['token', 'config.json', 'state.json']) fs.rmSync(path.join(runnerConfigDir(io), f), { force: true });
  }
  removePackages();
  if (opts.purge) fs.rmSync(work, { recursive: true, force: true });
  io.print(`${status('ok', 'OK  ')} Runner removed from this machine.`);
  if (!opts.purge && fs.existsSync(work)) io.print(`${status('info', 'INFO')} Work folder kept: ${work} (remove it with ${cmd('kette runner uninstall --purge')})`);
  return 0;
}

export async function runner(action, opts = {}, overrides = {}) {
  const io = { ...defaultIo(), ...overrides };
  checkPlatform(io.platform);
  if (action === 'install') return install(opts, io);
  if (action === 'status') return runnerStatus(opts, io);
  if (action === 'update') return update(opts, io);
  if (action === 'uninstall') return uninstall(opts, io);
  throw new ExitError(USAGE, 2);
}
