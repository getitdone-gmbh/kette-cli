import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, write } from './helpers.mjs';
import { createAtomic, writePrivate } from '../src/files.mjs';
import { TEMP_PATTERN } from '../src/project-plugins.mjs';
import { readState, writeState } from '../src/manifest.mjs';

test('writePrivate: mode 600 from the start, no temp file left, existing file replaced', { skip: process.platform === 'win32' }, () => {
  const d = tmp();
  const f = path.join(d, '.npmrc');
  write(d, '.npmrc', 'old\n');
  fs.chmodSync(f, 0o644);
  writePrivate(f, 'new\n');
  assert.equal(fs.readFileSync(f, 'utf8'), 'new\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(d), ['.npmrc']);
});

test('writePrivate keeps a symlinked dotfile a link and writes its target', { skip: process.platform === 'win32' }, () => {
  const d = tmp();
  write(d, 'dotfiles/npmrc', 'old\n');
  const link = path.join(d, '.npmrc');
  fs.symlinkSync(path.join(d, 'dotfiles', 'npmrc'), link);
  writePrivate(link, 'new\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(d, 'dotfiles', 'npmrc'), 'utf8'), 'new\n');
  assert.equal(fs.statSync(path.join(d, 'dotfiles', 'npmrc')).mode & 0o777, 0o600);
});

test('damaged state.json: warning, moved to state.json.bak, then written fresh', () => {
  const kh = tmp();
  process.env.KETTE_HOME = kh;
  write(kh, 'state.json', '{"bundle_community": {');
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.deepEqual(readState(), {});
  } finally { console.error = orig; }
  assert.match(errors.join('\n'), /WARN .*state\.json is not readable .*Moved to .*state\.json\.bak/);
  assert.equal(fs.readFileSync(path.join(kh, 'state.json.bak'), 'utf8'), '{"bundle_community": {');
  writeState({ a: 1 });
  assert.deepEqual(readState(), { a: 1 });
});

test('missing state.json is an empty state without a warning', () => {
  process.env.KETTE_HOME = tmp();
  const orig = console.error;
  let warned = false;
  console.error = () => { warned = true; };
  try { assert.deepEqual(readState(), {}); } finally { console.error = orig; }
  assert.equal(warned, false);
});

// The ignore pattern is a gitignore glob: * is anything but a slash, [..] a class, the rest literal
const ignored = (name) => new RegExp(`^${TEMP_PATTERN.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`).test(name);

test('AT-R1: the probe link of createAtomic is named like its temp files, so sweepTemps and the ignore pattern catch it', () => {
  const d = tmp();
  const file = path.join(d, 'profile.json');
  const link = fs.linkSync;
  const names = [];
  // EPERM on the first link: busy file or a drive without hard links, the probe link tells them apart
  fs.linkSync = function (from, to) {
    names.push(path.basename(String(to)));
    if (to === file && names.length === 1) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return link.call(this, from, to);
  };
  try {
    createAtomic(file, '{}\n');
  } finally {
    fs.linkSync = link;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  const probes = names.filter((n) => n !== 'profile.json');
  assert.equal(probes.length, 1, names.join(', '));
  for (const n of probes) {
    assert.match(n, /^\.profile\.json\.\d+\.[0-9a-f]+\.tmp$/, 'the name sweepTemps looks for');
    assert.ok(ignored(n), `${n} matches ${TEMP_PATTERN}`);
  }
  assert.deepEqual(fs.readdirSync(d), ['profile.json']);
});
