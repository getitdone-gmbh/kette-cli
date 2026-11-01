import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// KETTE-54 against the public test double, which knows workload-zero and github: the CLI picks the adapter, its token name and its
// connect settings from the library and never assumes workload.zero; runs everywhere, also in public CI
process.env.KETTE_TICKETING_DOUBLE = '1';
const { TICKET_TOKEN, interactive, noSecret, ok, posixOnly, readInstanceFile, sandbox, start, startBoard, stop, ticketKit } = await import('./sandbox-harness.mjs');
const { spawnSync } = await import('node:child_process');

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
  assert.deepEqual(readInstanceFile(box, 'acme').ticketing, { project: 'acme/web', subIssues: false, trustedAuthors: ['ci-bot', 'lead@acme.test'], adapter: 'github', minCli: '0.13.0' });
  assert.match(con.out, /WARN Everyone who uses Kette project acme needs kette 0\.13\.0 or newer: older versions refuse its instance\.json/, 'CR-COMPAT-1');
  // The repo was set up with --no-plugins, so doctor fails on the plugins; the warning is what counts here
  assert.match((await kit.step(box, ['doctor'], { cwd: app })).out, /WARN Kette project acme tracks decisions in github: everyone who uses it needs kette 0\.13\.0 or newer/);
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

const setInstance = (box, name, change) => {
  const f = path.join(box.home, '.kette', 'instances', name, 'instance.json');
  fs.writeFileSync(f, JSON.stringify(change(JSON.parse(fs.readFileSync(f, 'utf8'))), null, 2));
};

test('CR-FLD-1: an option the system does not read is refused, never dropped', async () => {
  const box = sandbox();
  await kit.licensed(box);
  const app = await kit.enterpriseRepo(box, 'acme');
  const r = ok(await kit.step(box, ['ticket', 'connect', 'github', '--board', 'acme/web', '--org', 'acme', '--deployment', 'cloud', '--yes'], { cwd: app }), 2);
  assert.match(r.out, /--org, --deployment are not a setting of github\. Usage: kette ticket connect github --board <owner\/repo>.*Nothing written\./);
  const wz = ok(await kit.step(box, ['ticket', 'connect', 'workload-zero', '--board', 'p-acme', '--trusted-authors', 'ci', '--yes'], { cwd: app }), 2);
  assert.match(wz.out, /--trusted-authors is not a setting of workload-zero/);
  assert.deepEqual([...r.all, ...wz.all], []);
});

test('CR-TOK-1: a github board reads its own token and passes its name, the workload.zero token never stands in', async () => {
  const box = sandbox();
  await kit.licensed(box);
  const app = await kit.enterpriseRepo(box, 'acme');
  ok(await kit.step(box, ['ticket', 'connect', 'github', '--board', 'acme/web', '--yes'], { cwd: app }));
  const wz = 'tok-workbase-must-stay-home';
  ok(await kit.step(box, ['wallet', 'add', TICKET_TOKEN, '--env', 'dev'], { cwd: app }));
  ok(await kit.step(box, ['wallet', 'set', TICKET_TOKEN, '--env', 'dev', '--stdin'], { cwd: app, input: `${wz}\n` }));
  const before = board.requests.length;
  const r = noSecret(box, ok(await kit.step(box, ['ticket', 'list'], { cwd: app }), 1), [wz]);
  assert.match(r.out, /KETTE_TICKETING_GITHUB_TOKEN has no value in dev/, 'the workload.zero token is never taken for GitHub');
  assert.equal(board.requests.length, before);
  const gh = 'tok-github-acme-0001';
  ok(await kit.step(box, ['wallet', 'set', 'KETTE_TICKETING_GITHUB_TOKEN', '--env', 'dev', '--stdin'], { cwd: app, input: `${gh}\n` }));
  board.boards.set(gh, { project: 'acme/web' });
  const listed = noSecret(box, ok(await kit.step(box, ['ticket', 'list'], { cwd: app })), [gh, wz]);
  assert.doesNotMatch(listed.out, /needs its own token/, 'the double accepts only the matching token name');
  assert.equal(board.writesTo(wz), 0);
});

test('CR-HOST-1: a host in instance.json gets no token until a person on this machine confirms it, again after a change', { skip: (posixOnly || spawnSync('python3', ['--version']).status !== 0) && 'needs python3 for a pseudo terminal' }, async () => {
  const box = sandbox();
  await kit.licensed(box);
  const app = await kit.enterpriseRepo(box, 'acme');
  ok(await kit.step(box, ['ticket', 'connect', 'github', '--board', 'acme/web', '--host', 'ghe.acme.example', '--yes'], { cwd: app }));
  const gh = 'tok-github-host-0002';
  ok(await kit.step(box, ['wallet', 'set', 'KETTE_TICKETING_GITHUB_TOKEN', '--env', 'dev', '--stdin'], { cwd: app, input: `${gh}\n` }));
  board.boards.set(gh, { project: 'acme/web' });
  const before = board.requests.length;
  const refused = noSecret(box, ok(await kit.step(box, ['ticket', 'list'], { cwd: app }), 1), [gh]);
  assert.match(refused.out, /sends KETTE_TICKETING_GITHUB_TOKEN to github ghe\.acme\.example, which this machine has not confirmed .*kette ticket host trust\. Nothing was sent\./);
  const agent = ok(await kit.step(box, ['ticket', 'host', 'trust'], { cwd: app, env: { CLAUDECODE: '1' } }), 1);
  assert.match(agent.out, /needs a person at a terminal/);
  assert.equal(board.requests.length, before, 'refused before any token was read or sent');
  ok(await interactive(box, ['ticket', 'host', 'trust'], [['Send KETTE_TICKETING_GITHUB_TOKEN of this machine to github ghe.acme.example', 'y']], { cwd: app, root: app, scenario: 'cr-host-1' }));
  ok(await kit.step(box, ['ticket', 'list'], { cwd: app }));
  assert.ok(board.requests.length > before, 'after the confirmation the board is read');
  setInstance(box, 'acme', (i) => ({ ...i, ticketing: { ...i.ticketing, host: 'evil.example' } }));
  const sent = board.requests.length;
  const changed = noSecret(box, ok(await kit.step(box, ['ticket', 'list'], { cwd: app }), 1), [gh]);
  assert.match(changed.out, /to github evil\.example, which this machine has not confirmed/);
  assert.equal(board.requests.length, sent, 'a changed host gets nothing');
  setInstance(box, 'acme', (i) => ({ ...i, ticketing: { ...i.ticketing, host: 'ghe.acme.example:8443' } }));
  const port = ok(await kit.step(box, ['ticket', 'list'], { cwd: app }), 1);
  assert.match(port.out, /to github ghe\.acme\.example:8443, which this machine has not confirmed/, 'another port is another host');
  assert.equal(board.requests.length, sent);
});
