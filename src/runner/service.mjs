// The service kette-runner: systemd user unit on Linux, LaunchAgent on macOS; every system call goes through io.exec, so tests never touch real services
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../files.mjs';
import { refusedMarker } from './package.mjs';

export const SERVICE = 'kette-runner';
export const UNIT = `${SERVICE}.service`;
export const LABEL = 'de.itdone.kette-runner';

export const unitFile = (homeDir) => path.join(homeDir, '.config', 'systemd', 'user', UNIT);
export const plistFile = (homeDir) => path.join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const logFile = (homeDir) => path.join(homeDir, 'Library', 'Logs', `${SERVICE}.log`);
export const serviceFile = (io) => (io.platform === 'darwin' ? plistFile(io.homeDir) : unitFile(io.homeDir));

// PATH for the service: node, claude and the usual system folders; no secret goes into the environment of the service
export function servicePath({ nodeBin, claudeBin, platform }) {
  const dirs = [nodeBin && path.dirname(nodeBin), claudeBin && path.dirname(claudeBin), ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set(dirs.filter(Boolean))].join(':');
}

// systemd splits ExecStart on spaces; quoted words keep paths with spaces together
const quote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

export function renderUnit({ nodeBin, entry, pathEnv }) {
  return [
    '[Unit]',
    'Description=Kette runner for workload.zero agents',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quote(nodeBin)} ${quote(entry)} start`,
    `Environment=${quote(`PATH=${pathEnv}`)}`,
    'Restart=on-failure',
    // Exit 3: the API refused the runner token; a restart cannot fix that (E2E-02)
    'RestartPreventExitStatus=3',
    'RestartSec=10',
    'UMask=0077',
    'NoNewPrivileges=yes',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// launchd cannot exclude one exit code from KeepAlive: the wrapper turns exit 3 (token refused) into a clean exit with a marker,
// so SuccessfulExit false restarts every other failure and never a refused token (E2E-02)
export const launchScript = ({ nodeBin, entry, marker }) => `${sh(nodeBin)} ${sh(entry)} start; s=$?; if [ $s -eq 3 ]; then touch ${sh(marker)}; exit 0; fi; exit $s`;

export function renderPlist({ nodeBin, entry, pathEnv, log, marker }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${xml(launchScript({ nodeBin, entry, marker }))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

const domain = (io) => `gui/${io.uid}`;
const run = (io, cmd, args) => io.exec(cmd, args);

function ensure(r, what) {
  if (r.status !== 0) throw new Error(`${what} failed${r.stderr ? `: ${String(r.stderr).trim().split('\n')[0]}` : ''}`);
}

// Writes the unit or plist and (re)starts the service; start false only writes and reloads (update restarts on its own)
export function writeService(io, { entry, claudeBin }) {
  fs.rmSync(refusedMarker(), { force: true });
  const pathEnv = servicePath({ nodeBin: io.nodeBin, claudeBin, platform: io.platform });
  if (io.platform === 'darwin') {
    fs.mkdirSync(path.dirname(logFile(io.homeDir)), { recursive: true });
    fs.mkdirSync(path.dirname(plistFile(io.homeDir)), { recursive: true });
    writeAtomic(plistFile(io.homeDir), renderPlist({ nodeBin: io.nodeBin, entry, pathEnv, log: logFile(io.homeDir), marker: refusedMarker() }), 0o644);
  } else {
    fs.mkdirSync(path.dirname(unitFile(io.homeDir)), { recursive: true });
    writeAtomic(unitFile(io.homeDir), renderUnit({ nodeBin: io.nodeBin, entry, pathEnv }), 0o644);
  }
}

export function enableService(io) {
  if (io.platform === 'darwin') {
    // bootout of a service that is not loaded fails; that is fine before a fresh bootstrap
    run(io, 'launchctl', ['bootout', `${domain(io)}/${LABEL}`]);
    ensure(run(io, 'launchctl', ['bootstrap', domain(io), plistFile(io.homeDir)]), 'launchctl bootstrap');
    return [];
  }
  ensure(run(io, 'systemctl', ['--user', 'daemon-reload']), 'systemctl --user daemon-reload');
  ensure(run(io, 'systemctl', ['--user', 'enable', '--now', UNIT]), `systemctl --user enable --now ${UNIT}`);
  const linger = run(io, 'loginctl', ['show-user', io.user, '--property=Linger']);
  return /Linger=yes/.test(linger.stdout || '') ? [] : [`The runner stops when you log out. Keep it running with: loginctl enable-linger ${io.user}`];
}

export function restartService(io, { reload = false } = {}) {
  if (io.platform === 'darwin') {
    ensure(run(io, 'launchctl', ['kickstart', '-k', `${domain(io)}/${LABEL}`]), 'launchctl kickstart');
    return;
  }
  if (reload) ensure(run(io, 'systemctl', ['--user', 'daemon-reload']), 'systemctl --user daemon-reload');
  ensure(run(io, 'systemctl', ['--user', 'restart', UNIT]), `systemctl --user restart ${UNIT}`);
}

// Stops, disables and deletes; a service that is already gone is no error
export function removeService(io, { noService = false } = {}) {
  const file = serviceFile(io);
  const had = fs.existsSync(file);
  if (noService) { fs.rmSync(file, { force: true }); return had; }
  if (io.platform === 'darwin') {
    if (had) run(io, 'launchctl', ['bootout', `${domain(io)}/${LABEL}`]);
    fs.rmSync(file, { force: true });
    return had;
  }
  if (had) run(io, 'systemctl', ['--user', 'disable', '--now', UNIT]);
  fs.rmSync(file, { force: true });
  if (had) run(io, 'systemctl', ['--user', 'daemon-reload']);
  return had;
}

// { active, detail, tokenRefused }: systemctl is-active and ExecMainStatus, or the state line of launchctl print and the wrapper's marker
export function serviceStatus(io) {
  if (!fs.existsSync(serviceFile(io))) return { active: false, detail: 'not set up' };
  if (io.platform === 'darwin') {
    const r = run(io, 'launchctl', ['print', `${domain(io)}/${LABEL}`]);
    if (r.status !== 0) return { active: false, detail: 'not loaded' };
    const state = /state = ([^\n]+)/.exec(r.stdout || '')?.[1]?.trim() || 'unknown';
    const active = state === 'running';
    return { active, detail: state, tokenRefused: !active && fs.existsSync(refusedMarker()) };
  }
  const r = run(io, 'systemctl', ['--user', 'is-active', UNIT]);
  const detail = String(r.stdout || '').trim() || 'unknown';
  const active = r.status === 0 && detail === 'active';
  const tokenRefused = !active && /ExecMainStatus=3\b/.test(run(io, 'systemctl', ['--user', 'show', UNIT, '--property=ExecMainStatus']).stdout || '');
  return { active, detail, tokenRefused };
}
