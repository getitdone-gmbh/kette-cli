import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve, tarball, tmp, write } from './helpers.mjs';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(repo, 'install', 'install.sh');
const LINE = 'export PATH="$HOME/.kette/bin:$PATH"';
const shells = ['/bin/sh', '/bin/dash'].filter((s) => fs.existsSync(s));
const pwsh = ['pwsh', 'pwsh.exe'].find((bin) => spawnSync(bin, ['-NoProfile', '-Command', 'exit 0']).status === 0);
let mirror;
let cli;
let manifest;
const goodManifest = () => ({ version: 'test', cli: { version: 'test', url: 'kette-cli-test.tgz', sha256: cli.sha256 }, bundles: {} });

before(async () => {
  cli = tarball(repo, ['bin', 'src', 'package.json', 'LICENSE']);
  manifest = goodManifest();
  mirror = await serve((req, res) => {
    if (req.url === '/manifest.json') { res.writeHead(200); return res.end(JSON.stringify(manifest)); }
    if (req.url === '/kette-cli-test.tgz') { res.writeHead(200); return res.end(cli.buf); }
    res.writeHead(404); res.end();
  });
});
after(() => mirror.close());

// Installer in einem leeren HOME ausführen; PATH ohne ein vorhandenes ~/.kette/bin
function install(shell, home, env = {}) {
  const PATH = process.env.PATH.split(path.delimiter).filter((p) => !p.includes('.kette')).join(path.delimiter);
  const base = { PATH, HOME: home, SHELL: '/bin/zsh', KETTE_MIRROR: mirror.url };
  return exec(shell, [script], { env: { ...base, ...env } });
}
const count = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l === LINE).length : 0);

for (const shell of shells) {
  test(`${shell}: PATH-Zeile genau einmal in ~/.zshrc, vorhandener Inhalt bleibt`, { skip: process.platform === 'win32' }, async () => {
    const home = tmp();
    write(home, '.zshrc', 'alias ll="ls -l"\n');
    const first = await install(shell, home);
    assert.match(first.stdout, /PATH updated in .*\.zshrc/);
    const second = await install(shell, home);
    assert.doesNotMatch(second.stdout, /PATH updated/);
    const rc = path.join(home, '.zshrc');
    assert.equal(count(rc), 1);
    assert.match(fs.readFileSync(rc, 'utf8'), /^alias ll="ls -l"\n/);
    const { stdout } = await exec(path.join(home, '.kette', 'bin', 'kette'), ['version']);
    assert.equal(stdout.trim(), JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
  });
}

test('bash schreibt in ~/.bashrc (macOS: ~/.bash_profile), andere Shells in ~/.profile', { skip: process.platform === 'win32' }, async () => {
  const bashHome = tmp();
  await install('/bin/sh', bashHome, { SHELL: '/bin/bash' });
  assert.equal(count(path.join(bashHome, process.platform === 'darwin' ? '.bash_profile' : '.bashrc')), 1);
  assert.equal(fs.existsSync(path.join(bashHome, '.zshrc')), false);
  const otherHome = tmp();
  await install('/bin/sh', otherHome, { SHELL: '/usr/bin/fish' });
  assert.equal(count(path.join(otherHome, '.profile')), 1);
});

test('KETTE_NO_MODIFY_PATH=1 ändert keine Datei und zeigt die Zeile zum Selbsteintragen', { skip: process.platform === 'win32' }, async () => {
  const home = tmp();
  const { stdout } = await install('/bin/sh', home, { KETTE_NO_MODIFY_PATH: '1' });
  assert.equal(fs.existsSync(path.join(home, '.zshrc')), false);
  assert.match(stdout, /PATH not changed \(KETTE_NO_MODIFY_PATH=1\)/);
  assert.ok(stdout.includes(LINE));
});

// Installer with a changed manifest; returns the failure (or null) and restores the good manifest
async function installWith(changes, run) {
  manifest = { ...goodManifest(), cli: { ...goodManifest().cli, ...changes } };
  try { await run(); return null; } catch (err) { return err; } finally { manifest = goodManifest(); }
}

const HOSTILE = [
  ['a wrong checksum', { sha256: '0'.repeat(64) }, /Checksum does not match/],
  ['version ../../outside', { version: '../../outside' }, /invalid CLI version/],
  ['version ..', { version: '..' }, /invalid CLI version/],
  ['version -rf', { version: '-rf' }, /invalid CLI version/],
  ['url ../secret.tgz', { url: '../secret.tgz' }, /invalid CLI download/],
  ['a url on a foreign host', { url: 'https://evil.example/kette-cli-test.tgz' }, /invalid CLI download/],
];

for (const [label, changes, message] of HOSTILE) {
  test(`install.sh rejects ${label} and installs nothing`, { skip: process.platform === 'win32' }, async () => {
    const home = tmp();
    write(home, 'outside/keep.txt', 'stays');
    const err = await installWith(changes, () => install('/bin/sh', home, { KETTE_HOME: path.join(home, 'a', 'b') }));
    assert.ok(err, 'installer must fail');
    assert.match(err.stderr, message);
    assert.equal(fs.existsSync(path.join(home, 'outside', 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(home, 'a', 'b', 'bin', 'kette')), false);
  });

  test(`install.ps1 rejects ${label} and installs nothing`, { skip: !pwsh && 'pwsh not available' }, async () => {
    const home = tmp();
    write(home, 'outside/keep.txt', 'stays');
    const env = { ...process.env, KETTE_MIRROR: mirror.url, KETTE_HOME: path.join(home, 'a', 'b'), KETTE_NO_MODIFY_PATH: '1' };
    const err = await installWith(changes, () => exec(pwsh, ['-NoProfile', '-File', path.join(repo, 'install', 'install.ps1')], { env }));
    assert.ok(err, 'installer must fail');
    assert.match(err.stderr + err.stdout, message);
    assert.equal(fs.existsSync(path.join(home, 'outside', 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(home, 'a', 'b', 'bin', 'kette.cmd')), false);
  });
}

test('install.sh refuses a plain http mirror that is not local', { skip: process.platform === 'win32' }, async () => {
  const err = await install('/bin/sh', tmp(), { KETTE_MIRROR: 'http://kette.example/dl' }).catch((e) => e);
  assert.match(err.stderr, /Mirror must use https/);
});

test('install.ps1 installs from the local mirror and kette.cmd runs', { skip: (!pwsh || process.platform !== 'win32') && 'needs pwsh on Windows' }, async () => {
  const home = tmp();
  const env = { ...process.env, KETTE_MIRROR: mirror.url, KETTE_HOME: home, KETTE_NO_MODIFY_PATH: '1' };
  const { stdout } = await exec(pwsh, ['-NoProfile', '-File', path.join(repo, 'install', 'install.ps1')], { env });
  assert.match(stdout, /Installed: /);
  assert.equal(fs.existsSync(path.join(home, 'cli', 'test', 'bin', 'kette.mjs')), true);
  const version = spawnSync(path.join(home, 'bin', 'kette.cmd'), ['version'], { shell: true, encoding: 'utf8' });
  assert.equal(version.stdout.trim(), JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
});
