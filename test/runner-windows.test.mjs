import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { machine, sandboxHome } from './runner-helpers.mjs';
import { runner } from '../src/runner/index.mjs';

test('Windows: every runner action ends with exit 2 and the message, before anything is checked or written', async () => {
  for (const action of ['install', 'update', 'status', 'uninstall']) {
    const { homeDir, ketteHome } = sandboxHome({ signedIn: false });
    const m = machine(homeDir, { platform: 'win32' });
    await assert.rejects(runner(action, { repos: ['acme/app'] }, m.io), (err) => {
      assert.equal(err.message, 'Runners are not supported on Windows in this version. Use macOS or Linux.');
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.deepEqual(m.calls, []);
    assert.ok(!fs.existsSync(path.join(ketteHome, 'runner')));
  }
});
