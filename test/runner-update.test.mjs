import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeRunnerPackage, machine, runnerCalls, sandboxHome } from './runner-helpers.mjs';
import { runner } from '../src/runner/index.mjs';

const systemCalls = (calls) => calls.filter((c) => ['systemctl', 'launchctl'].includes(path.basename(c.cmd))).map((c) => [path.basename(c.cmd), ...c.args].join(' '));

test('update: installs the new package, moves current, rewrites the unit and restarts; no code is read', async () => {
  const { homeDir, ketteHome } = sandboxHome();
  const old = fakeRunnerPackage('0.3.0');
  await runner('install', { from: old.file, sha256: old.sha256, repos: ['acme/app'], 'no-agent-push': true }, machine(homeDir).io);
  const next = fakeRunnerPackage('0.3.1');
  let read = false;
  const m = machine(homeDir, { readStdinLine: async () => { read = true; return ''; }, askSecret: async () => { read = true; return ''; } });
  assert.equal(await runner('update', { from: next.file, sha256: next.sha256 }, m.io), 0);
  assert.equal(read, false);
  assert.equal(fs.readlinkSync(path.join(ketteHome, 'runner', 'current')), '0.3.1');
  assert.deepEqual(systemCalls(m.calls), ['systemctl --user daemon-reload', 'systemctl --user restart kette-runner.service']);
  assert.ok(!runnerCalls(homeDir).some((c) => c.command === 'register' && c.stdin === '' ), 'no second register');
  assert.match(m.out(), /0\.3\.0 to 0\.3\.1/);
});

test('update --repo hands the list to zero-runner update; same version without --repo is up to date', async () => {
  const { homeDir } = sandboxHome();
  const pkg = fakeRunnerPackage('0.3.0');
  await runner('install', { from: pkg.file, sha256: pkg.sha256, repos: ['acme/app'], 'no-agent-push': true }, machine(homeDir).io);
  const m = machine(homeDir);
  assert.equal(await runner('update', { from: pkg.file, sha256: pkg.sha256 }, m.io), 0);
  assert.match(m.out(), /up to date/);
  assert.deepEqual(systemCalls(m.calls), []);
  const m2 = machine(homeDir);
  assert.equal(await runner('update', { from: pkg.file, sha256: pkg.sha256, repos: ['acme/app', 'acme/api'] }, m2.io), 0);
  const call = runnerCalls(homeDir).at(-1);
  assert.equal(call.command, 'update');
  assert.deepEqual(call.args, ['--repo', 'acme/app', '--repo', 'acme/api']);
  assert.deepEqual(systemCalls(m2.calls), ['systemctl --user restart kette-runner.service']);
});

test('update without a kette runner points to install', async () => {
  const { homeDir } = sandboxHome();
  const pkg = fakeRunnerPackage();
  await assert.rejects(runner('update', { from: pkg.file, sha256: pkg.sha256 }, machine(homeDir).io), /No runner set up by kette.*kette runner install/s);
});
