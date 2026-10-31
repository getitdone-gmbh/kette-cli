import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, TICKETING, hasTicketing, interactive, ok, posixOnly, sandbox, start, startBoard, stop, ticketKit } from './sandbox-harness.mjs';

// Fix round 1 of kette ticket against the real library (QA KETTE-14 scenarios S6, S8): approvals only from a person at a terminal
// (KETTE-28), two parallel new never share an id (KETTE-29), a write killed half way is named and repaired (KETTE-31)
const needsBoard = { skip: hasTicketing ? false : `no built kette-ticketing in ${TICKETING} (set KETTE_TICKETING)` };
let board;
let kit;
let killer = null;
before(async () => { await start(); board = await startBoard({ delayMs: 100, onWrite: () => killer?.() }); kit = ticketKit(board); });
after(async () => { await board.close(); await stop('sandbox-ticket-fix'); });

// The CLI as its own process with a pid, so the board can kill it after a write like a crash
function run(box, cwd, argv) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...argv], { cwd, env: { ...box.env, ...kit.env() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (x) => { out += x; });
    c.stderr.on('data', (x) => { out += x; });
    c.on('close', (code, signal) => resolve({ code: code ?? signal, out, pid: c.pid }));
    run.last = c;
  });
}

const decisions = async (box, cwd) => JSON.parse((await kit.step(box, ['ticket', 'list', '--json'], { cwd })).out);

test('KETTE-28: an approval or acting as a person needs that person at a terminal; an agent or a run without terminal is refused', { ...needsBoard, skip: needsBoard.skip || posixOnly }, async () => {
  const box = sandbox();
  const token = 'tok-approve-0123456789';
  await kit.licensed(box);
  const app = await kit.connected(box, 'acme', 'p-acme', token, { stations: [{ id: 'prototype', approve: 'lead@acme.test' }] });
  const t = (argv, code = 0, extra = {}) => kit.step(box, ['ticket', ...argv], { cwd: app, ...extra }).then((r) => ok(r, code));
  await t(['new', 'Pill buttons', '--by', 'lead@acme.test', '--source', 'chat:a1', '--stations', 'prototype', '--yes']);
  const item = 'KD-0001/prototype/acme-app';
  await t(['pick', item, '--as', 'ux-designer', '--yes']);
  await t(['link', item, '--pr', 'https://github.com/acme/proto/pull/1', '--as', 'ux-designer', '--yes']);
  await t(['link', item, '--review', 'https://github.com/acme/proto/pull/1#review', '--as', 'ux-designer', '--yes']);
  const writes = board.writesTo(token);
  assert.match((await t(['check', item, '--as', 'ux-designer', '--approved-by', 'lead@acme.test', '--yes'], 1)).out, /lead@acme\.test approves KD-0001\/prototype\/acme-app needs a person at a terminal/);
  assert.match((await t(['check', item, '--as', 'ux-designer', '--approved-by', 'lead@acme.test', '--yes'], 1, { env: { CLAUDECODE: '1' } })).out, /needs a person at a terminal/);
  assert.match((await t(['pick', item, '--as', 'lead@acme.test', '--yes'], 1)).out, /as lead@acme\.test, a person of instance acme needs a person at a terminal/);
  assert.match((await t(['check', item, '--as', 'ux-designer', '--yes'], 1)).out, /\[approval\] .* needs approval by lead@acme\.test/);
  assert.equal(board.writesTo(token), writes, 'no refused approval sent anything');
  box.env = { ...box.env, ...kit.env() };
  const r = await interactive(box, ['ticket', 'check', item, '--as', 'ux-designer', '--approved-by', 'lead@acme.test'], [['Confirm as that person?', 'y'], ['Write this to the board?', 'y']], { cwd: app, scenario: 'ticket-approval' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /done \(approved by lead@acme\.test \(declared\)\)/);
  const [d] = await decisions(box, app);
  assert.deepEqual(d.items[0].approval?.how, 'declared');
});

test('KETTE-29: two parallel ticket new on one machine end with two distinct ids', needsBoard, async () => {
  const box = sandbox();
  const token = 'tok-parallel-0123456789';
  await kit.licensed(box);
  const app = await kit.connected(box, 'acme', 'p-acme', token);
  const [a, b] = await Promise.all([1, 2].map((i) => run(box, app, ['ticket', 'new', `Parallel ${i}`, '--by', 'lead@acme.test', '--source', `chat:p${i}`, '--stations', 'app', '--yes'])));
  assert.deepEqual([a.code, b.code], [0, 0], `${a.out}\n${b.out}`);
  const ids = (await decisions(box, app)).map((d) => d.decision.id).sort();
  assert.deepEqual(ids, ['KD-0001', 'KD-0002']);
});

test('KETTE-31: a new killed after its first write is named by list and report, a rerun points to repair, repair completes it', needsBoard, async () => {
  const box = sandbox();
  const token = 'tok-killed-0123456789';
  await kit.licensed(box);
  const app = await kit.connected(box, 'acme', 'p-acme', token);
  const argv = ['ticket', 'new', 'Killed half way', '--by', 'lead@acme.test', '--source', 'chat:kill', '--stations', 'prototype,app', '--yes'];
  let left = 1;
  killer = () => { if (left-- === 0) run.last.kill('SIGKILL'); };
  const killed = await run(box, app, argv);
  killer = null;
  assert.notEqual(killed.code, 0, 'the run was killed');
  const list = ok(await kit.step(box, ['ticket', 'list'], { cwd: app }));
  assert.match(list.out, /WARN KD-0001 is incomplete \(missing [^)]*\): kette ticket repair KD-0001/);
  assert.match(ok(await kit.step(box, ['ticket', 'report'], { cwd: app })).out, /KD-0001 is incomplete/);
  // The killed run left its lock; the next new takes the stale lock over and removes it
  const again = ok(await kit.step(box, argv, { cwd: app, allow: [/^\.kette\/locks\/ticket-new-acme\.lck$/] }), 1);
  assert.equal(fs.existsSync(path.join(box.home, '.kette', 'locks', 'ticket-new-acme.lck')), false, 'no lock left behind');
  assert.match(again.out, /KD-0001 is this decision, recorded half by an interrupted run\. Complete it with: kette ticket repair KD-0001/);
  assert.match(ok(await kit.step(box, ['ticket', 'repair', 'KD-0001', '--yes'], { cwd: app })).out, /Repair KD-0001: .*KD-0001\/app\/acme-app/);
  const ds = await decisions(box, app);
  assert.deepEqual(ds.map((d) => [d.decision.id, d.items.length]), [['KD-0001', 2]]);
  assert.doesNotMatch(ok(await kit.step(box, ['ticket', 'list'], { cwd: app })).out, /incomplete/);
  assert.match(ok(await kit.step(box, ['ticket', 'repair', 'KD-0001', '--yes'], { cwd: app })).out, /KD-0001 is complete, nothing to repair/);
});
