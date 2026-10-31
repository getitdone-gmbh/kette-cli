import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, write } from './helpers.mjs';
import { HOOK_COMMAND, installed, withHook, withoutHook } from '../src/ticket/hook.mjs';
import { CONTRACT, loadTicketing, ticketingDir } from '../src/ticket/module.mjs';

const PART = ['scripts/cli-facade.mjs', 'routing.default.json', 'package.json'];

// A bundle folder below a bundles root of its own, the way ~/.kette/bundles holds them
let ROOT;
function bundleWith(files) {
  ROOT = tmp();
  const dir = path.join(ROOT, 'enterprise', '1');
  for (const [f, c] of Object.entries(files)) write(dir, `ticketing/${f}`, c);
  return dir;
}

test('hook: install adds kette\'s entry once and keeps every other setting and hook', () => {
  const own = { enabledPlugins: { 'a@b': true }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [] }] } };
  const once = withHook(JSON.stringify(own));
  const on = JSON.parse(once);
  assert.equal(installed(on), true);
  assert.deepEqual(on.enabledPlugins, own.enabledPlugins);
  assert.deepEqual(on.hooks.Stop, own.hooks.Stop);
  assert.deepEqual(on.hooks.UserPromptSubmit.at(-1), { hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] });
  assert.equal(withHook(once), once, 'a second install changes nothing');
  assert.deepEqual(JSON.parse(withHook('')), { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] }] } });
});

test('hook: remove takes only kette\'s hook, also out of a group shared with another hook, and drops empty containers', () => {
  const shared = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: HOOK_COMMAND }] }] } };
  assert.deepEqual(JSON.parse(withoutHook(JSON.stringify(shared))), { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } });
  assert.deepEqual(JSON.parse(withoutHook(withHook('{"model":"x"}'))), { model: 'x' });
  const foreign = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'kette ticket hook run --other' }] }] } });
  assert.equal(withoutHook(foreign), foreign, 'a similar command of someone else stays');
});

test('hook: a settings file that is not a JSON object is never rewritten', () => {
  assert.equal(withHook('[1]'), null);
  assert.equal(withoutHook('{broken'), null);
});

test('bundle part: missing or incomplete ticketing means an older bundle, with kette update as the next step', async () => {
  assert.equal(ticketingDir(null), null);
  assert.equal(ticketingDir(bundleWith({ 'scripts/cli-facade.mjs': '' }), { root: ROOT }), null);
  await assert.rejects(loadTicketing(tmp()), (err) => err.exitCode === 1 && /The Enterprise bundle on this machine has no ticketing yet\. Load the current one with: kette update/.test(err.message));
});

const files = (contract) => ({ 'package.json': '{"type":"module"}', 'routing.default.json': '{}', 'scripts/cli-facade.mjs': `export const CLI_CONTRACT = ${contract};\n` });

test('bundle part: a library with another contract is refused, never driven blindly', async () => {
  await assert.rejects(loadTicketing(bundleWith(files(CONTRACT + 1)), { root: ROOT }), /speaks contract 3, this kette speaks 2\. Update the kette CLI/);
  await assert.rejects(loadTicketing(bundleWith(files(1)), { root: ROOT }), /Load the current bundle with: kette update/);
  const t = await loadTicketing(bundleWith(files(CONTRACT)), { root: ROOT });
  assert.equal(t.lib.CLI_CONTRACT, CONTRACT);
});

test('KETTE-28 (KT-M3): code is only loaded from inside the bundles folder, a link out of it is refused', { skip: process.platform === 'win32' }, async () => {
  const dir = bundleWith(files(CONTRACT));
  assert.equal(ticketingDir(dir, { root: tmp() }), null, 'a bundle outside the bundles root');
  const outside = tmp();
  write(outside, 'evil.mjs', 'export const CLI_CONTRACT = 2;\n');
  fs.rmSync(path.join(dir, 'ticketing', 'scripts', 'cli-facade.mjs'));
  fs.symlinkSync(path.join(outside, 'evil.mjs'), path.join(dir, 'ticketing', 'scripts', 'cli-facade.mjs'));
  assert.equal(ticketingDir(dir, { root: ROOT }), null, 'an entry that links out of the bundle');
  const linked = bundleWith({});
  fs.rmSync(path.join(linked, 'ticketing'), { recursive: true, force: true });
  const away = tmp();
  for (const [f, c] of Object.entries(files(CONTRACT))) write(away, f, c);
  fs.mkdirSync(linked, { recursive: true });
  fs.symlinkSync(away, path.join(linked, 'ticketing'));
  assert.equal(ticketingDir(linked, { root: ROOT }), null, 'a ticketing folder that links out of the bundles root');
});
