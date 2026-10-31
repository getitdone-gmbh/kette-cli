import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// kette ticket against the public test double of the ticketing contract (KETTE-28, KT-TEST-1): runs everywhere, also in public CI
// without the private library. It proves what the CLI owns: project scope, credential from the wallet, plan, --dry-run, the yes,
// the guarded write and no token in any file or output. Chain rules are tested with the real library in sandbox-ticket.test.mjs.
process.env.KETTE_TICKETING_DOUBLE = '1';
const { TICKET_TOKEN, noSecret, ok, readInstanceFile, sandbox, start, startBoard, stop, ticketKit } = await import('./sandbox-harness.mjs');

let board;
let kit;
before(async () => { await start(); board = await startBoard(); kit = ticketKit(board); });
after(async () => { await board.close(); await stop('sandbox-ticket-double'); });

const NEW = (by, stations) => ['ticket', 'new', 'Save goes right', '--by', by, '--source', 'chat:s1', '--stations', stations];

test('double: --dry-run plans on the board and writes nothing, --yes writes once with the token of the project', async () => {
  const box = sandbox();
  const token = 'tok-dbl-acme-0123456789';
  await kit.licensed(box);
  const app = await kit.connected(box, 'acme', 'p-acme', token);
  const dry = noSecret(box, ok(await kit.step(box, [...NEW('lead@acme.test', 'app:acme-app'), '--dry-run'], { cwd: app })), [token]);
  assert.match(dry.out, /New decision KD-0001 with 1 station item[\s\S]*Would send 1 request to project p-acme[\s\S]*--dry-run: nothing written/);
  assert.deepEqual(dry.all, []);
  assert.equal(board.writesTo(token), 0, 'no write reached the board');
  const refused = ok(await kit.step(box, NEW('lead@acme.test', 'app:acme-app'), { cwd: app }), 1);
  assert.match(refused.out, /needs a yes/);
  assert.equal(board.writesTo(token), 0);
  const made = noSecret(box, ok(await kit.step(box, [...NEW('lead@acme.test', 'app:acme-app'), '--yes'], { cwd: app })), [token]);
  assert.match(made.out, /Written to project p-acme/);
  assert.deepEqual(made.all, []);
  assert.equal(board.writesTo(token), 1);
  assert.match(noSecret(box, ok(await kit.step(box, ['ticket', 'list'], { cwd: app })), [token]).out, /KD-0001 decided, 0\/1 stations\s+Save goes right/);
});

test('double: two instances on one machine reach only their own board with their own token', async () => {
  const box = sandbox();
  const [ta, tb] = ['tok-dbl-alpha-111111', 'tok-dbl-beta-222222'];
  await kit.licensed(box);
  const a = await kit.connected(box, 'alpha', 'p-alpha', ta);
  const b = await kit.connected(box, 'beta', 'p-beta', tb);
  noSecret(box, ok(await kit.step(box, [...NEW('lead@alpha.test', 'app:alpha-app'), '--yes'], { cwd: a })), [ta, tb]);
  assert.match(noSecret(box, ok(await kit.step(box, ['ticket', 'list'], { cwd: b })), [ta, tb]).out, /No decisions on the board of instance beta yet/);
  for (const [token, project] of [[ta, 'p-alpha'], [tb, 'p-beta']]) {
    assert.deepEqual(board.requests.filter((r) => r.token === token && /\/tasks\/project\//.test(r.path) && !r.path.endsWith(`/${project}`)), [], `${project} token never reads another project`);
  }
  assert.equal(board.writesTo(tb), 0);
});

test('double: a missing credential is a clear next step, nothing is sent', async () => {
  const box = sandbox();
  await kit.licensed(box);
  const app = await kit.enterpriseRepo(box, 'acme', { walletProject: 'wallet-dbl-empty' });
  ok(await kit.step(box, ['ticket', 'connect', 'workload-zero', '--project', 'p-acme', '--yes'], { cwd: app }));
  const r = ok(await kit.step(box, ['ticket', 'list'], { cwd: app }), 1);
  assert.match(r.out, /No access to the ticket board of instance acme\. KETTE_TICKETING_WORKBASE_TOKEN has no value in dev/);
  assert.deepEqual(r.all, []);
  assert.deepEqual(board.requests.filter((q) => q.token === ''), []);
});

test('double: project ids with path or query characters are refused at connect and in instance.json, no request leaves', async () => {
  const box = sandbox();
  const token = 'tok-dbl-ids-333333';
  await kit.licensed(box);
  const app = await kit.connected(box, 'acme', 'p-acme', token);
  for (const id of ['../../tasks/deleted', 'a/b', 'x?y=1#z', '..', 'proj-acme/../../tasks/deleted']) {
    const r = ok(await kit.step(box, ['ticket', 'connect', 'workload-zero', '--project', id, '--yes'], { cwd: app }), 2);
    assert.match(r.out, /--project must be a board project id/);
    assert.deepEqual(r.all, []);
  }
  const f = path.join(box.home, '.kette', 'instances', 'acme', 'instance.json');
  const good = fs.readFileSync(f, 'utf8');
  for (const id of ['../../tasks/deleted', 'a/b', '..']) {
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(good), ticketing: { adapter: 'workload-zero', project: id } }));
    const n = board.requests.length;
    const r = ok(await kit.step(box, ['ticket', 'list'], { cwd: app }), 1);
    assert.match(r.out, /ticketing\.project must be a board project id/);
    assert.equal(board.requests.length, n, 'no request for a bad project id');
  }
  fs.writeFileSync(f, good);
  assert.equal(readInstanceFile(box, 'acme').ticketing.project, 'p-acme');
});

test('double: the shared session file is only used when the instance enables it (ticketing.session)', async () => {
  const box = sandbox();
  const token = 'tok-dbl-session-444444';
  await kit.licensed(box);
  // The session file lives outside the sandbox, like the shared session of agents on a machine
  const session = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kette-session-')), 'session.json');
  fs.writeFileSync(session, JSON.stringify({ accessToken: token, refreshToken: 'unused' }));
  const app = await kit.enterpriseRepo(box, 'acme', { walletProject: 'wallet-dbl-session' });
  fs.rmSync(path.join(app, '.kette', 'wallet.json'));
  ok(await kit.step(box, ['ticket', 'connect', 'workload-zero', '--project', 'p-acme', '--yes'], { cwd: app, env: { WORKBASE_SESSION_FILE: session } }));
  board.boards.set(token, { project: 'p-acme' });
  const off = ok(await kit.step(box, ['ticket', 'list'], { cwd: app, env: { WORKBASE_SESSION_FILE: session } }), 1);
  assert.match(off.out, /No access to the ticket board of instance acme\. This project has no secret wallet yet/);
  assert.equal(board.requests.filter((r) => r.token === token).length, 0, 'the session token is not used without the switch');
  const f = path.join(box.home, '.kette', 'instances', 'acme', 'instance.json');
  const inst = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...inst, ticketing: { ...inst.ticketing, session: true } }));
  const on = noSecret(box, ok(await kit.step(box, ['ticket', 'list'], { cwd: app, env: { WORKBASE_SESSION_FILE: session } })), [token]);
  assert.match(on.out, /No decisions on the board of instance acme yet/);
  assert.equal(TICKET_TOKEN, 'KETTE_TICKETING_WORKBASE_TOKEN');
});
