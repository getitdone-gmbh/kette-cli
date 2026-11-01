import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// KETTE-54 against the public test double, which knows workload-zero and github: the CLI picks the adapter, its token name and its
// connect settings from the library and never assumes workload.zero; runs everywhere, also in public CI
process.env.KETTE_TICKETING_DOUBLE = '1';
const { noSecret, ok, readInstanceFile, sandbox, start, startBoard, stop, ticketKit } = await import('./sandbox-harness.mjs');

let board;
let kit;
before(async () => { await start(); board = await startBoard(); kit = ticketKit(board); });
after(async () => { await board.close(); await stop('sandbox-ticket-adapters-double'); });

const wallet = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.kette', 'wallet.json'), 'utf8'));

test('KETTE-54: help and a connect without adapter list every system of the bundle with --board', async () => {
  const box = sandbox();
  await kit.licensed(box);
  const app = await kit.enterpriseRepo(box, 'acme');
  const help = ok(await kit.step(box, ['ticket', 'help'], { cwd: app }));
  assert.match(help.out, /Ticket systems of the installed bundle:\n  kette ticket connect workload-zero --board <project id>\n  kette ticket connect github --board <owner\/repo>/);
  const none = ok(await kit.step(box, ['ticket', 'connect', '--board', 'acme/web', '--yes'], { cwd: app }), 2);
  assert.match(none.out, /Name the ticket system\. Usage:\n  kette ticket connect workload-zero --board <project id>\n  kette ticket connect github --board <owner\/repo>/);
  assert.deepEqual(none.all, []);
  const unknown = ok(await kit.step(box, ['ticket', 'connect', 'trello', '--board', 'x', '--yes'], { cwd: app }), 1);
  assert.match(unknown.out, /Ticket adapter "trello" is not supported yet; supported: workload-zero, github/);
});

test('KETTE-54: connect github writes its own block and token name; a re-run is quiet, another block is refused', async () => {
  const box = sandbox();
  await kit.licensed(box);
  const app = await kit.enterpriseRepo(box, 'acme');
  const bad = ok(await kit.step(box, ['ticket', 'connect', 'github', '--board', 'no-slash', '--yes'], { cwd: app }), 1);
  assert.match(bad.out, /ticketing\.project \(--board\) "no-slash" is not valid: owner\/repo\. Nothing written\./);
  assert.equal(ok(await kit.step(box, ['ticket', 'connect', 'github', '--board', 'acme/web', '--sub-issues', 'maybe'], { cwd: app }), 2).out.includes('--sub-issues must be true or false'), true);
  const dry = ok(await kit.step(box, ['ticket', 'connect', 'github', '--board', 'acme/web', '--sub-issues', 'false', '--trusted-authors', 'ci-bot,lead@acme.test', '--dry-run'], { cwd: app }));
  assert.match(dry.out, /ticketing: github acme\/web[\s\S]*declares KETTE_TICKETING_GITHUB_TOKEN[\s\S]*--dry-run: nothing written/);
  assert.deepEqual(dry.all, []);
  const con = ok(await kit.step(box, ['ticket', 'connect', 'github', '--board', 'acme/web', '--sub-issues', 'false', '--trusted-authors', 'ci-bot,lead@acme.test', '--yes'], { cwd: app }));
  assert.deepEqual(readInstanceFile(box, 'acme').ticketing, { project: 'acme/web', subIssues: false, trustedAuthors: ['ci-bot', 'lead@acme.test'], adapter: 'github' });
  assert.ok(wallet(app).secrets.some((s) => s.name === 'KETTE_TICKETING_GITHUB_TOKEN'));
  assert.equal(wallet(app).secrets.some((s) => s.name === 'KETTE_TICKETING_WORKBASE_TOKEN'), false, 'no workload.zero name for a GitHub board');
  assert.match(con.out, /Next: .*kette wallet add KETTE_TICKETING_GITHUB_TOKEN/);
  const again = ok(await kit.step(box, ['ticket', 'connect', '--board', 'acme/web', '--sub-issues', 'false', '--trusted-authors', 'ci-bot,lead@acme.test', '--yes'], { cwd: app }));
  assert.match(again.out, /Kette project acme is connected to github acme\/web already/, 'without an adapter the current one');
  const other = ok(await kit.step(box, ['ticket', 'connect', 'github', '--board', 'acme/web', '--yes'], { cwd: app }), 1);
  assert.match(other.out, /Kette project acme already uses github acme\/web\. One ticket system per Kette project/, 'other trusted authors are another block');
  const list = ok(await kit.step(box, ['ticket', 'list'], { cwd: app }), 1);
  assert.match(list.out, /No access to the ticket board of Kette project acme\. KETTE_TICKETING_GITHUB_TOKEN has no value in dev/);
});

test('KETTE-54 item 7: the shared Workbase session file never stands in for the token of another system', async () => {
  const box = sandbox();
  await kit.licensed(box);
  const app = await kit.enterpriseRepo(box, 'acme');
  const f = path.join(box.home, '.kette', 'instances', 'acme', 'instance.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ticketing: { adapter: 'github', project: 'acme/web', session: true } }, null, 2));
  const r = ok(await kit.step(box, ['ticket', 'list'], { cwd: app, env: { WORKBASE_SESSION_FILE: path.join(box.root, 'session.json') } }), 1);
  assert.match(r.out, /ticketing\.session is for workload-zero boards only/);
  noSecret(box, r, []);
});
