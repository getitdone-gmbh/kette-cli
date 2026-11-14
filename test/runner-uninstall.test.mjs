import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeRunnerPackage, machine, runnerCalls, sandboxHome, write } from './runner-helpers.mjs';
import { runner } from '../src/runner/index.mjs';

const systemCalls = (calls) => calls.filter((c) => ['systemctl', 'launchctl'].includes(path.basename(c.cmd))).map((c) => [path.basename(c.cmd), ...c.args].join(' '));
const opts = (pkg, extra = {}) => ({ from: pkg.file, sha256: pkg.sha256, repos: ['acme/app'], 'no-agent-push': true, ...extra });

test('uninstall on Linux: stops and removes the service, unregisters, removes the packages; the work folder only with --purge', async () => {
  const { homeDir, ketteHome } = sandboxHome();
  const pkg = fakeRunnerPackage();
  await runner('install', opts(pkg), machine(homeDir).io);
  const work = path.join(homeDir, '.kette', 'runner-work', 'runs');
  fs.mkdirSync(work, { recursive: true });
  const m = machine(homeDir);
  assert.equal(await runner('uninstall', {}, m.io), 0);
  assert.deepEqual(systemCalls(m.calls), ['systemctl --user disable --now kette-runner.service', 'systemctl --user daemon-reload']);
  assert.ok(!fs.existsSync(path.join(homeDir, '.config', 'systemd', 'user', 'kette-runner.service')));
  assert.equal(runnerCalls(homeDir).at(-1).command, 'unregister');
  assert.ok(!fs.existsSync(path.join(homeDir, '.config', 'zero-runner', 'token')));
  assert.ok(!fs.existsSync(path.join(ketteHome, 'runner')));
  assert.ok(fs.existsSync(work), 'work folder stays without --purge');
  assert.match(m.out(), /token revoked/i);
  const { homeDir: h2 } = sandboxHome();
  await runner('install', opts(pkg), machine(h2).io);
  fs.mkdirSync(path.join(h2, '.kette', 'runner-work', 'runs'), { recursive: true });
  assert.equal(await runner('uninstall', { purge: true }, machine(h2).io), 0);
  assert.ok(!fs.existsSync(path.join(h2, '.kette', 'runner-work')));
});

test('uninstall on macOS: launchctl bootout and the plist is gone', async () => {
  const { homeDir } = sandboxHome();
  const pkg = fakeRunnerPackage();
  await runner('install', opts(pkg, { 'accept-unsandboxed': true }), machine(homeDir, { platform: 'darwin', uid: 501 }).io);
  const m = machine(homeDir, { platform: 'darwin', uid: 501 });
  assert.equal(await runner('uninstall', {}, m.io), 0);
  assert.deepEqual(systemCalls(m.calls), ['launchctl bootout gui/501/de.itdone.kette-runner']);
  assert.ok(!fs.existsSync(path.join(homeDir, 'Library', 'LaunchAgents', 'de.itdone.kette-runner.plist')));
});

test('uninstall: a failed unregister is reported, local token and config of the kette install are still removed', async () => {
  const { homeDir, ketteHome } = sandboxHome();
  const pkg = fakeRunnerPackage();
  await runner('install', opts(pkg), machine(homeDir).io);
  fs.rmSync(path.join(ketteHome, 'runner'), { recursive: true, force: true });
  const m = machine(homeDir);
  assert.equal(await runner('uninstall', {}, m.io), 0);
  assert.match(m.out(), /could not be revoked.*workload\.zero/s);
  assert.ok(!fs.existsSync(path.join(homeDir, '.config', 'zero-runner', 'token')));
  assert.ok(!fs.existsSync(path.join(homeDir, '.config', 'zero-runner', 'config.json')));
});

test('uninstall never touches a runner kette did not set up', async () => {
  const { homeDir } = sandboxHome();
  write(path.join(homeDir, '.config', 'zero-runner'), 'config.json', JSON.stringify({ adapter: 'spark' }));
  write(path.join(homeDir, '.config', 'zero-runner'), 'token', 'zr_x\n');
  const m = machine(homeDir);
  assert.equal(await runner('uninstall', {}, m.io), 1);
  assert.match(m.out(), /not set up by kette/);
  assert.ok(fs.existsSync(path.join(homeDir, '.config', 'zero-runner', 'token')));
  assert.deepEqual(systemCalls(m.calls), []);
});

test('uninstall without any runner says so and exits 0', async () => {
  const { homeDir } = sandboxHome();
  const m = machine(homeDir);
  assert.equal(await runner('uninstall', {}, m.io), 0);
  assert.match(m.out(), /No runner set up by kette/);
});
