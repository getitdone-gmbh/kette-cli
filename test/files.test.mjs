import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, write } from './helpers.mjs';
import { writePrivate } from '../src/files.mjs';
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
