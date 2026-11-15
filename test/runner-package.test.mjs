import { unixTest as test } from './runner-helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fakeRunnerPackage, machine, runnerCalls, sandboxHome, tmp, write } from './runner-helpers.mjs';
import { runner } from '../src/runner/index.mjs';
import { installPackage, packageFromBundle } from '../src/runner/package.mjs';

const opts = (pkg, extra = {}) => ({ from: pkg.file, sha256: pkg.sha256, repos: ['acme/app'], 'no-agent-push': true, ...extra });

test('a wrong checksum installs nothing and reads no code', async () => {
  const { homeDir, ketteHome } = sandboxHome();
  const pkg = fakeRunnerPackage();
  let read = false;
  const m = machine(homeDir, { readStdinLine: async () => { read = true; return ''; } });
  await assert.rejects(runner('install', opts(pkg, { sha256: '0'.repeat(64) }), m.io), /Checksum does not match.*nothing was installed/);
  assert.equal(read, false);
  const dir = path.join(ketteHome, 'runner');
  assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'no version folder and no leftovers');
  assert.deepEqual(runnerCalls(homeDir), []);
});

test('--from and --sha256 belong together; --sha256 must be 64 hex characters', async () => {
  const { homeDir } = sandboxHome();
  const pkg = fakeRunnerPackage();
  await assert.rejects(runner('install', opts(pkg, { sha256: undefined }), machine(homeDir).io), /--from needs --sha256/);
  await assert.rejects(runner('install', opts(pkg, { sha256: 'xyz' }), machine(homeDir).io), /64 hex/);
  await assert.rejects(runner('install', opts(pkg, { from: undefined }), machine(homeDir).io), /--sha256 only with --from/);
});

test('a package without zero-agent-runner/dist/bin.js or with a bad version is refused', () => {
  sandboxHome();
  const src = tmp();
  write(src, 'zero-agent-runner/package.json', JSON.stringify({ version: '../x' }));
  write(src, 'zero-agent-runner/dist/bin.js', '');
  const file = path.join(tmp(), 'bad.tgz');
  execFileSync('tar', ['-czf', file, '-C', src, 'zero-agent-runner']);
  const sum = sha(file);
  assert.throws(() => installPackage({ file, sha256: sum }), /version/);
  const src2 = tmp();
  write(src2, 'zero-agent-runner/package.json', JSON.stringify({ version: '0.3.0' }));
  const file2 = path.join(tmp(), 'nobin.tgz');
  execFileSync('tar', ['-czf', file2, '-C', src2, 'zero-agent-runner']);
  assert.throws(() => installPackage({ file: file2, sha256: sha(file2) }), /dist\/bin\.js/);
});

test('the bundle manifest version must match the package; a runner folder outside the bundles folder is ignored', () => {
  const { ketteHome } = sandboxHome();
  const pkg = fakeRunnerPackage('0.3.0');
  const bundle = path.join(ketteHome, 'bundles', 'enterprise', '1');
  write(bundle, 'runner/manifest.json', JSON.stringify({ version: '0.4.0', file: path.basename(pkg.file), sha256: pkg.sha256, node: '>=22' }));
  fs.copyFileSync(pkg.file, path.join(bundle, 'runner', path.basename(pkg.file)));
  const source = packageFromBundle({ dir: bundle });
  assert.throws(() => installPackage(source), /0\.4\.0.*0\.3\.0/);
  const outside = tmp();
  write(outside, 'runner/manifest.json', '{}');
  assert.equal(packageFromBundle({ dir: outside }), null);
  write(bundle, 'runner/manifest.json', JSON.stringify({ version: '0.3.0', file: '../../x.tgz', sha256: pkg.sha256 }));
  assert.equal(packageFromBundle({ dir: bundle }), null, 'a file name with a path is refused');
});

test('the same version twice keeps the installed folder', () => {
  const { ketteHome } = sandboxHome();
  const pkg = fakeRunnerPackage('0.3.0');
  const a = installPackage({ file: pkg.file, sha256: pkg.sha256 });
  const marker = path.join(a.dir, 'marker');
  fs.writeFileSync(marker, 'x');
  const b = installPackage({ file: pkg.file, sha256: pkg.sha256 });
  assert.equal(a.dir, b.dir);
  assert.ok(fs.existsSync(marker));
  assert.deepEqual(fs.readdirSync(path.join(ketteHome, 'runner')).sort(), ['0.3.0']);
});

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
