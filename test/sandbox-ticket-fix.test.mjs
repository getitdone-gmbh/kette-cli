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
  // The closing revision names the person who approved, marked as declared, not the CLI
  const why = ok(await kit.step(box, ['ticket', 'why', 'KD-0001'], { cwd: app })).out;
  assert.match(why, /rev \d+ \S+ close by human lead@acme\.test \(declared\) via cli/);
  assert.doesNotMatch(why, /close by human kette-cli/);
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
  const again = ok(await kit.step(box, argv, { cwd: app }), 1);
  assert.match(again.out, /KD-0001 is this decision, recorded half by an interrupted run\. Complete it with: kette ticket repair KD-0001/);
  assert.match(ok(await kit.step(box, ['ticket', 'repair', 'KD-0001', '--yes'], { cwd: app })).out, /Repair KD-0001: .*KD-0001\/app\/acme-app/);
  const ds = await decisions(box, app);
  assert.deepEqual(ds.map((d) => [d.decision.id, d.items.length]), [['KD-0001', 2]]);
  assert.doesNotMatch(ok(await kit.step(box, ['ticket', 'list'], { cwd: app })).out, /incomplete/);
  assert.match(ok(await kit.step(box, ['ticket', 'repair', 'KD-0001', '--yes'], { cwd: app })).out, /KD-0001 is complete, nothing to repair/);
  // The killed run left its lock; the next new takes the stale lock over and removes it
  const lock = path.join(box.home, '.kette', 'locks', 'ticket-new-acme.lck');
  assert.equal(fs.existsSync(lock), true, 'the kill left the lock');
  ok(await kit.step(box, ['ticket', 'new', 'After the kill', '--by', 'lead@acme.test', '--source', 'chat:after', '--stations', 'app', '--yes'], { cwd: app, allow: [/^\.kette\/locks\/ticket-new-acme\.lck$/] }));
  assert.equal(fs.existsSync(lock), false, 'no lock left behind');
});

// QA T14-02 and S8M: several homes (machines) record decisions on one empty board at the same moment, round after round; 8 x 4 is the QA scenario S8M of KETTE-40
for (const [homes, rounds] of [[2, 1], [4, 4], [7, 1], [8, 4]]) {
  test(`KETTE-29 (T14-02): ${homes} homes x ${rounds} rounds of parallel ticket new on one empty board end with distinct ids, without a manual step`, needsBoard, async () => {
    const token = `tok-homes-${homes}x${rounds}-0123456789`;
    const project = `p-homes-${homes}x${rounds}`;
    const boxes = Array.from({ length: homes }, () => sandbox());
    const apps = [];
    for (const box of boxes) {
      await kit.licensed(box);
      apps.push(await kit.connected(box, 'acme', project, token));
    }
    const statements = [];
    for (let round = 1; round <= rounds; round++) {
      const runs = await Promise.all(boxes.map((box, i) => {
        const words = `Round ${round} home ${i + 1}`;
        statements.push(words);
        return run(box, apps[i], ['ticket', 'new', words, '--by', 'lead@acme.test', '--source', `chat:r${round}h${i + 1}`, '--stations', 'app', '--yes']);
      }));
      assert.deepEqual(runs.map((r) => r.code), runs.map(() => 0), runs.map((r) => r.out).join('\n'));
      // KT-N7: a run only reports a twin when it moved itself
      for (const r of runs) for (const l of r.out.split('\n').filter((x) => /WARN/.test(x))) assert.match(l, /this decision is KD-\d{4} now \(revision written\)/);
    }
    const board = await decisions(boxes[0], apps[0]);
    const ids = board.map((d) => d.decision.id);
    assert.equal(new Set(ids).size, ids.length, `ids on the board: ${ids.join(', ')}`);
    assert.deepEqual(board.map((d) => d.decision.statement).sort(), statements.sort(), 'every statement on the board once');
    assert.ok(board.every((d) => d.items.length === 1 && d.items[0].key === `${d.decision.id}/app/acme-app`), 'each decision has its own station');
    assert.doesNotMatch(ok(await kit.step(boxes[0], ['ticket', 'list'], { cwd: apps[0] })).out, /WARN/);
  });
}

test('KETTE-32 (KT-N2): the intake model of the instance is asked only after this machine confirmed its host, again after a change', { ...needsBoard, skip: needsBoard.skip || posixOnly }, async () => {
  const { serve } = await import('./helpers.mjs');
  const asked = [];
  const model = await serve((req, res, body) => { asked.push(body); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '{"change":true,"stations":["app"]}' } }] })); });
  try {
    const box = sandbox();
    await kit.licensed(box);
    const app = await kit.connected(box, 'acme', 'p-acme', 'tok-model-0123456789');
    const f = path.join(box.home, '.kette', 'instances', 'acme', 'instance.json');
    const setModel = (url) => { const i = JSON.parse(fs.readFileSync(f, 'utf8')); fs.writeFileSync(f, JSON.stringify({ ...i, ticketing: { ...i.ticketing, intakeModel: url } })); };
    setModel(`${model.url}/v1/chat/completions`);
    const prompt = JSON.stringify({ prompt: 'das sollte anders funktionieren als bisher, finde ich, schon seit einer ganzen Weile eigentlich' });
    const hook = (env = {}) => kit.step(box, ['ticket', 'hook', 'run'], { cwd: app, input: prompt, env }).then((r) => ok(r));
    assert.match(ok(await kit.step(box, ['ticket', 'hook', 'status'], { cwd: app })).out, new RegExp(`Intake model ${model.url.replace(/[.]/g, '\\.')} of instance acme is not confirmed on this machine.*kette ticket hook trust`));
    assert.match(ok(await kit.step(box, ['ticket', 'hook', 'install'], { cwd: app })).out, /is not confirmed on this machine/);
    assert.match(JSON.parse((await hook()).out).hookSpecificOutput.additionalContext, /^Kette intake: if this prompt asks to change/);
    assert.equal(asked.length, 0, 'no prompt reached the model before the confirmation');
    assert.match(ok(await kit.step(box, ['ticket', 'hook', 'trust'], { cwd: app }), 1).out, /needs a person at a terminal/);
    box.env = { ...box.env, ...kit.env() };
    // KT-N2a: an agent in a terminal is no person, the confirmation is refused and nothing is stored
    const agent = await interactive({ ...box, env: { ...box.env, CLAUDECODE: '1' } }, ['ticket', 'hook', 'trust'], [['Allow prompts of this project to go to', 'y']], { cwd: app, scenario: 'ticket-model-trust-agent' });
    assert.notEqual(agent.code, 0, agent.out);
    assert.match(agent.out, /needs a person at a terminal: run kette ticket hook trust yourself, not through an agent or CI/);
    assert.match(ok(await kit.step(box, ['ticket', 'hook', 'status'], { cwd: app })).out, /is not confirmed on this machine/);
    const t = await interactive(box, ['ticket', 'hook', 'trust'], [['Allow prompts of this project to go to', 'y']], { cwd: app, scenario: 'ticket-model-trust' });
    assert.equal(t.code, 0, t.out);
    assert.match(ok(await kit.step(box, ['ticket', 'hook', 'status'], { cwd: app })).out, /confirmed on this machine/);
    assert.match(JSON.parse((await hook()).out).hookSpecificOutput.additionalContext, /this prompt asks for a change to the chain\. Stations touched \(first guess\): app/);
    assert.equal(asked.length, 1, 'the confirmed model was asked');
    setModel(`http://localhost:${new URL(model.url).port}/v1/chat/completions`);
    assert.match(JSON.parse((await hook()).out).hookSpecificOutput.additionalContext, /^Kette intake: if this prompt asks to change/);
    assert.equal(asked.length, 1, 'a changed host is not asked before a new confirmation');
    // The model of this machine itself (environment) needs no confirmation
    assert.match(JSON.parse((await hook({ KETTE_INTAKE_MODEL_URL: `${model.url}/v1/chat/completions` })).out).hookSpecificOutput.additionalContext, /Stations touched \(first guess\): app/);
    assert.equal(asked.length, 2);
  } finally {
    await model.close();
  }
});
