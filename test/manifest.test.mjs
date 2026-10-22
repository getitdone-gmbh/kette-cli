import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeBundle, serve, tmp, write } from './helpers.mjs';
import { installBundle, validVersion } from '../src/manifest.mjs';
import { isSecureUrl, mirror } from '../src/paths.mjs';

let server;
let bundle;

before(async () => {
  bundle = fakeBundle('1.0.0');
  server = await serve((req, res) => {
    if (req.url === '/kette-community.tgz') { res.writeHead(200); return res.end(bundle.buf); }
    res.writeHead(404); res.end();
  });
  process.env.KETTE_MIRROR = server.url;
});
after(() => { delete process.env.KETTE_MIRROR; return server.close(); });

const home = () => { const kh = tmp(); process.env.KETTE_HOME = kh; return kh; };
const manifest = (version, url = 'kette-community.tgz') => ({ version, bundles: { community: { url, sha256: bundle.sha256 } } });

test('version names: plain names only, never a path', () => {
  for (const ok of ['1.0.0', '0.20261022.35', '1.0.0-rc.1+build']) assert.equal(validVersion(ok), true, ok);
  for (const bad of ['..', '../x', '1..2', 'a/b', '-rf', '', null, 7]) assert.equal(validVersion(bad), false, String(bad));
});

test('community bundle installs from a file name on the mirror', async () => {
  const kh = home();
  const dir = await installBundle(manifest('1.0.0'), 'community');
  assert.equal(dir, path.join(kh, 'bundles', 'community', '1.0.0'));
  assert.equal(fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json')), true);
});

test('hostile manifest version: nothing removed, nothing installed', async () => {
  const kh = home();
  write(kh, 'keep/file.txt', 'stays');
  for (const version of ['../../keep', '..', '../keep']) {
    await assert.rejects(installBundle(manifest(version), 'community'), /Invalid bundle version/);
  }
  assert.equal(fs.readFileSync(path.join(kh, 'keep', 'file.txt'), 'utf8'), 'stays');
  assert.equal(fs.existsSync(path.join(kh, 'bundles')), false);
});

test('bundle URL outside the mirror or with a path is refused', async () => {
  home();
  for (const url of ['https://evil.example/kette-community.tgz', '../kette-community.tgz', 'http://evil.example/x.tgz', 'file:///etc/passwd']) {
    await assert.rejects(installBundle(manifest('1.0.0', url), 'community'), /Invalid download URL/, url);
  }
});

test('https required, plain http only for local hosts or KETTE_INSECURE=1', () => {
  assert.equal(isSecureUrl('https://kette.itdone.de/dl'), true);
  assert.equal(isSecureUrl('http://127.0.0.1:8791'), true);
  assert.equal(isSecureUrl('http://localhost/dl'), true);
  assert.equal(isSecureUrl('http://kette.example/dl'), false);
  assert.equal(isSecureUrl('ftp://kette.example/dl'), false);
  assert.equal(isSecureUrl('not a url'), false);
  process.env.KETTE_INSECURE = '1';
  try { assert.equal(isSecureUrl('http://kette.example/dl'), true); } finally { delete process.env.KETTE_INSECURE; }
  process.env.KETTE_MIRROR = 'http://kette.example/dl';
  try { assert.throws(() => mirror(), /KETTE_MIRROR must be an https URL/); } finally { process.env.KETTE_MIRROR = server.url; }
});
