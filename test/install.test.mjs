import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { serve, tarball, tmp, write } from './helpers.mjs';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const script = path.join(repo, 'install', 'install.sh');
const LINE = 'export PATH="$HOME/.kette/bin:$PATH"';
const shells = ['/bin/sh', '/bin/dash'].filter((s) => fs.existsSync(s));
let mirror;

before(async () => {
  const cli = tarball(repo, ['bin', 'src', 'package.json', 'LICENSE']);
  const manifest = JSON.stringify({ version: 'test', cli: { version: 'test', url: 'kette-cli-test.tgz', sha256: cli.sha256 }, bundles: {} });
  mirror = await serve((req, res) => {
    if (req.url === '/manifest.json') { res.writeHead(200); return res.end(manifest); }
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
    assert.match(first.stdout, /PATH ergänzt in .*\.zshrc/);
    const second = await install(shell, home);
    assert.doesNotMatch(second.stdout, /PATH ergänzt/);
    const rc = path.join(home, '.zshrc');
    assert.equal(count(rc), 1);
    assert.match(fs.readFileSync(rc, 'utf8'), /^alias ll="ls -l"\n/);
    const { stdout } = await exec(path.join(home, '.kette', 'bin', 'kette'), ['version']);
    assert.equal(stdout.trim(), JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
  });
}

test('bash schreibt in ~/.bashrc, andere Shells in ~/.profile', { skip: process.platform === 'win32' }, async () => {
  const bashHome = tmp();
  await install('/bin/sh', bashHome, { SHELL: '/bin/bash' });
  assert.equal(count(path.join(bashHome, '.bashrc')), 1);
  assert.equal(fs.existsSync(path.join(bashHome, '.zshrc')), false);
  const otherHome = tmp();
  await install('/bin/sh', otherHome, { SHELL: '/usr/bin/fish' });
  assert.equal(count(path.join(otherHome, '.profile')), 1);
});

test('KETTE_NO_MODIFY_PATH=1 ändert keine Datei und zeigt die Zeile zum Selbsteintragen', { skip: process.platform === 'win32' }, async () => {
  const home = tmp();
  const { stdout } = await install('/bin/sh', home, { KETTE_NO_MODIFY_PATH: '1' });
  assert.equal(fs.existsSync(path.join(home, '.zshrc')), false);
  assert.match(stdout, /PATH nicht geändert \(KETTE_NO_MODIFY_PATH=1\)/);
  assert.ok(stdout.includes(LINE));
});
