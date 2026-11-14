import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fakeRunnerPackage, machine, sandboxHome, write } from './runner-helpers.mjs';
import { runner } from '../src/runner/index.mjs';

const NOW = Date.parse('2026-11-14T22:00:00Z');
const state = (homeDir, s) => write(path.join(homeDir, '.config', 'zero-runner'), 'state.json', JSON.stringify(s));
const config = (homeDir) => write(path.join(homeDir, '.config', 'zero-runner'), 'config.json', JSON.stringify({ installedBy: 'kette' }));
const active = { responses: { 'systemctl --user is-active kette-runner.service': { status: 0, stdout: 'active\n' } } };
const good = { version: '0.3.0', executorName: 'build-box', workspaceName: 'Acme', registeredAt: '2026-11-14T20:00:00Z', lastHeartbeatAt: '2026-11-14T21:59:20Z', licence: { usable: true, state: 'active', stale: false, checkedAt: '2026-11-14T21:59:20Z' } };

async function installed(homeDir) {
  const pkg = fakeRunnerPackage();
  await runner('install', { from: pkg.file, sha256: pkg.sha256, repos: ['acme/app'], 'no-agent-push': true }, machine(homeDir).io);
}

test('status: without a runner it says how to install one and exits 1', async () => {
  const { homeDir } = sandboxHome();
  const m = machine(homeDir);
  assert.equal(await runner('status', {}, m.io), 1);
  assert.match(m.out(), /No runner set up by kette on this machine\. Set one up with: kette runner install/);
});

test('status: everything fine exits 0 and shows version, executor, workspace, heartbeat, licence and service', async () => {
  const { homeDir } = sandboxHome();
  await installed(homeDir);
  state(homeDir, good);
  const m = machine(homeDir, { ...active, now: () => NOW });
  assert.equal(await runner('status', {}, m.io), 0);
  const out = m.out();
  for (const re of [/Runner 0\.3\.0/, /build-box/, /Acme/, /OK +Service kette-runner is running/, /OK +Last heartbeat 40 s ago/, /OK +Licence active/, /OK +Claude Code signed in/]) assert.match(out, re);
});

test('status: stale heartbeat, blocked licence and a stopped service fail with exit 1', async () => {
  const { homeDir } = sandboxHome();
  await installed(homeDir);
  state(homeDir, { ...good, lastHeartbeatAt: '2026-11-14T21:50:00Z', licence: { usable: false, state: 'licence_expired', stale: false } });
  const m = machine(homeDir, { now: () => NOW, responses: { 'systemctl --user is-active kette-runner.service': { status: 3, stdout: 'inactive\n' } } });
  assert.equal(await runner('status', {}, m.io), 1);
  const out = m.out();
  assert.match(out, /FAIL +Service kette-runner is not running \(inactive\)/);
  assert.match(out, /FAIL +Last heartbeat 10 min ago/);
  assert.match(out, /FAIL +Licence licence_expired: agents get no new runs/);
});

test('status --json: one object, no token, never the config contents', async () => {
  const { homeDir } = sandboxHome();
  await installed(homeDir);
  state(homeDir, good);
  const m = machine(homeDir, { ...active, now: () => NOW });
  assert.equal(await runner('status', { json: true }, m.io), 0);
  const j = JSON.parse(m.out());
  assert.equal(j.ok, true);
  assert.equal(j.version, '0.3.0');
  assert.equal(j.package, '0.3.0');
  assert.equal(j.service.active, true);
  assert.equal(j.heartbeat.ok, true);
  assert.equal(j.licence.usable, true);
  assert.ok(!m.out().includes('zr_'));
});

test('status on macOS asks launchctl print', async () => {
  const { homeDir } = sandboxHome();
  config(homeDir);
  state(homeDir, good);
  write(path.join(homeDir, 'Library', 'LaunchAgents'), 'de.itdone.kette-runner.plist', '<plist/>');
  const m = machine(homeDir, { platform: 'darwin', uid: 501, now: () => NOW, responses: { 'launchctl print gui/501/de.itdone.kette-runner': { status: 0, stdout: 'gui/501/de.itdone.kette-runner = {\n\tstate = running\n' } } });
  await runner('status', {}, m.io);
  assert.match(m.out(), /OK +Service kette-runner is running/);
});

test('status names a refused token and the way back (E2E-02)', async () => {
  const { homeDir, ketteHome } = sandboxHome();
  await installed(homeDir);
  state(homeDir, good);
  const m = machine(homeDir, { now: () => NOW, responses: {
    'systemctl --user is-active kette-runner.service': { status: 3, stdout: 'inactive\n' },
    'systemctl --user show kette-runner.service --property=ExecMainStatus': { status: 0, stdout: 'ExecMainStatus=3\n' },
  } });
  assert.equal(await runner('status', {}, m.io), 1);
  assert.match(m.out(), /FAIL +Runner token revoked, run kette runner install --replace/);
  const { homeDir: h2 } = sandboxHome();
  config(h2);
  state(h2, good);
  write(path.join(h2, 'Library', 'LaunchAgents'), 'de.itdone.kette-runner.plist', '<plist/>');
  write(path.join(process.env.KETTE_HOME, 'runner'), 'api-refused', '');
  const mac = machine(h2, { platform: 'darwin', uid: 501, now: () => NOW, responses: { 'launchctl print gui/501/de.itdone.kette-runner': { status: 0, stdout: '\tstate = not running\n' } } });
  assert.equal(await runner('status', { json: true }, mac.io), 1);
  assert.equal(JSON.parse(mac.out()).service.tokenRefused, true);
  void ketteHome;
});
