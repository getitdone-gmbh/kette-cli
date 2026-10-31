import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, write } from './helpers.mjs';
import { HOOK_COMMAND, installed, withHook, withoutHook } from '../src/ticket/hook.mjs';
import { CONTRACT, loadTicketing, ticketingDir } from '../src/ticket/module.mjs';

const PART = ['dist/index.js', 'routing.json', 'scripts/plan-guard.mjs', 'scripts/workbase-session.mjs', 'scripts/intake-hook.mjs'];

function bundleWith(files) {
  const dir = tmp();
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
  assert.equal(ticketingDir(bundleWith({ 'dist/index.js': '' })), null);
  await assert.rejects(loadTicketing(tmp()), (err) => err.exitCode === 1 && /The Enterprise bundle on this machine has no ticketing yet\. Load the current one with: kette update/.test(err.message));
});

test('bundle part: a library with another contract is refused, never driven blindly', async () => {
  const files = (contract) => ({ ...Object.fromEntries(PART.map((f) => [f, 'export {};\n'])), 'package.json': '{"type":"module"}', 'routing.json': '{}', 'dist/index.js': `export const CLI_CONTRACT = ${contract};\n` });
  await assert.rejects(loadTicketing(bundleWith(files(CONTRACT + 1))), /speaks contract 2, this kette speaks 1\. Update the kette CLI/);
  await assert.rejects(loadTicketing(bundleWith(files(0))), /Load the current bundle with: kette update/);
  const t = await loadTicketing(bundleWith(files(CONTRACT)));
  assert.equal(t.lib.CLI_CONTRACT, CONTRACT);
});
