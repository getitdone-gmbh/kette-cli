import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLAUDE_REGISTRY, KEY, MCP_USER, SETUP, TICKETING, hasTicketing, kette, ok, sandbox, start, stop } from './sandbox-harness.mjs';

// KETTE-30 with the real Claude Code (opt-in: KETTE_REAL_CLAUDE=1, needs claude on PATH and a built kette-ticketing): an Enterprise repo
// lists the agent kette-intake and the command /intake from the plugin kette-ticketing in its init message, a Community repo does not.
// The API points to a closed local port, so no prompt leaves the machine.
const real = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = process.env.KETTE_REAL_CLAUDE !== '1' ? 'set KETTE_REAL_CLAUDE=1 to run against the real Claude Code' : !real ? 'claude not on PATH' : !hasTicketing ? `no built kette-ticketing in ${TICKETING}` : false;

before(start);
after(() => stop('real-claude-ticket'));

// The init message Claude Code prints first in stream-json, with the agents and slash commands of the folder
function init(box, cwd) {
  const r = spawnSync('claude', ['-p', 'list', '--output-format', 'stream-json', '--verbose', '--max-turns', '1'], { cwd, env: { ...box.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, encoding: 'utf8', timeout: 90000 });
  const line = `${r.stdout}`.split('\n').find((l) => l.includes('"subtype":"init"'));
  assert.ok(line, `no init message (${r.error?.message || r.status}):\n${r.stdout}\n${r.stderr}`.slice(0, 2000));
  return JSON.parse(line);
}

test('KETTE-30: the real Claude Code lists kette-intake and /intake in an Enterprise repo, not in a Community repo', { skip }, async () => {
  const box = sandbox();
  // The real claude instead of the fake one of the harness
  box.env.PATH = box.env.PATH.split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, 'claude.cmd'))).join(path.delimiter);
  const allow = [...CLAUDE_REGISTRY, ...MCP_USER, /^\.claude\/(backups|projects|shell-snapshots|statsig|todos|plugins)(\/|$)/, /^\.config(\/|$)/, /^Library\/Caches(\/|$)/, /^\.cache(\/|$)/];
  const [ent, com] = [path.join(box.work, 'ent'), path.join(box.work, 'com')];
  ok(await kette(box, ['login', KEY, '--no-npm'], { allow }));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise'], { allow }));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], { allow }));
  ok(await kette(box, ['init', ent, '--instance', 'acme', ...SETUP], { projects: [ent], allow }));
  ok(await kette(box, ['init', com, '--instance', 'oss', ...SETUP], { projects: [com], allow }));
  const e = init(box, ent);
  const c = init(box, com);
  assert.ok(e.agents.includes('kette-ticketing:kette-intake'), `Enterprise agents: ${e.agents.join(', ')}`);
  assert.ok(e.slash_commands.some((x) => x === 'kette-ticketing:intake'), `Enterprise commands: ${e.slash_commands.join(', ')}`);
  assert.ok(!c.agents.some((a) => a.includes('kette-intake')), `Community agents: ${c.agents.join(', ')}`);
  assert.ok(!c.slash_commands.some((x) => x.includes('kette-ticketing')), `Community commands: ${c.slash_commands.join(', ')}`);
  console.log(`enterprise init: agents ${e.agents.filter((a) => a.startsWith('kette-')).join(', ')}; commands ${e.slash_commands.filter((x) => x.startsWith('kette-')).join(', ')}\ncommunity init: agents ${c.agents.filter((a) => a.startsWith('kette-')).join(', ') || 'none from kette-ticketing'}`);
});
