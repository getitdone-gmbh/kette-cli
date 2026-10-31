import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KEY, SETUP, TICKETING, TICKET_TOKEN, hasTicketing, interactive, noSecret, ok, posixOnly, readInstanceFile, sandbox, start, startBoard, stop, ticketKit } from './sandbox-harness.mjs';

// kette ticket in a fresh sandbox per scenario (KETTE-12): the board is the workload.zero simulator of kette-ticketing behind a local
// server, one simulated board per token; after each command a diff of the whole sandbox and a search for every token value
const TOKEN = TICKET_TOKEN;
let board;
let boards;
let requests;
const needsBoard = { skip: hasTicketing ? false : `no built kette-ticketing in ${TICKETING} (set KETTE_TICKETING)` };

before(async () => {
  await start();
  board = await startBoard();
  ({ boards, requests } = board);
  kit = ticketKit(board);
});
after(async () => { await board?.close(); await stop('sandbox-ticket'); });

const writesTo = (token) => board.writesTo(token);
let kit;
const step = (...a) => kit.step(...a);
const licensed = (...a) => kit.licensed(...a);
const enterpriseRepo = (...a) => kit.enterpriseRepo(...a);
const connected = (...a) => kit.connected(...a);
const rel = (...a) => kit.rel(...a);
const env = () => kit.env();

test('Enterprise instance: connect writes only the ticketing block, then every command runs on its board', needsBoard, async () => {
  const box = sandbox();
  const token = 'tok-acme-0123456789abcdef';
  await licensed(box);
  const app = await enterpriseRepo(box, 'acme', { stations: ['prototype', { id: 'app', definitionOfDone: 'Live on shop.acme.test, deploy run checked' }] });
  const wallet = path.join(app, '.kette', 'wallet.json');

  const dry = ok(await step(box, ['ticket', 'connect', 'workload-zero', '--project', 'p-acme', '--dry-run'], { cwd: app }));
  assert.match(dry.out, /Would change \(instance acme\):[\s\S]*instance\.json\s+ticketing: workload-zero p-acme[\s\S]*wallet\.json\s+declares KETTE_TICKETING_WORKBASE_TOKEN/);
  assert.deepEqual(dry.all, [], 'dry run changes nothing');
  const refused = ok(await step(box, ['ticket', 'connect', 'workload-zero', '--project', 'p-acme'], { cwd: app }), 1);
  assert.match(refused.out, /needs a yes: run it in a terminal or add --yes\. Nothing was written/);
  assert.deepEqual(refused.all, []);

  const con = ok(await step(box, ['ticket', 'connect', 'workload-zero', '--project', 'p-acme', '--yes'], { cwd: app }));
  assert.deepEqual(con.all.filter((p) => !p.startsWith('home/.kette/locks')).sort(), ['home/.kette/instances/acme/instance.json', rel(box, app, '.kette/wallet.json')].sort());
  assert.deepEqual(readInstanceFile(box, 'acme').ticketing, { adapter: 'workload-zero', project: 'p-acme' });
  assert.ok(JSON.parse(fs.readFileSync(wallet, 'utf8')).secrets.some((s) => s.name === TOKEN));
  assert.match(con.out, /kette wallet set KETTE_TICKETING_WORKBASE_TOKEN --env dev/);
  ok(await step(box, ['wallet', 'set', TOKEN, '--env', 'dev', '--stdin'], { cwd: app, input: `${token}\n` }));
  boards.set(token, { project: 'p-acme' });

  const run = async (argv, code = 0) => noSecret(box, ok(await step(box, ['ticket', ...argv], { cwd: app }), code), [token]);
  const words = 'Der Speichern Button kommt nach rechts';
  const newArgs = ['new', words, '--by', 'lead@acme.test', '--source', 'chat:session-test', '--stations', 'prototype:acme-app,app:acme-app'];
  const before = writesTo(token);
  const planned = await run([...newArgs, '--dry-run']);
  assert.match(planned.out, /New decision KD-0001 with 2 station items/);
  assert.match(planned.out, /--dry-run: nothing written/);
  assert.deepEqual(planned.all, []);
  assert.equal(writesTo(token), before, 'dry run sends no write to the board');

  const made = await run([...newArgs, '--yes']);
  assert.match(made.out, /KD-0001\/prototype\/acme-app[\s\S]*KD-0001\/app\/acme-app/);
  assert.deepEqual(made.all, [], 'a board write changes no file');
  assert.ok(writesTo(token) > before);

  assert.match((await run(['list'])).out, /KD-0001 decided, 0\/2 stations\s+Der Speichern Button kommt nach rechts/);
  const shown = await run(['show', 'KD-0001']);
  assert.match(shown.out, /decided by lead@acme\.test/);
  assert.match(shown.out, /words: "Der Speichern Button kommt nach rechts"/);
  await run(['edit', 'KD-0001', '--rationale', 'Primary action on the right', '--yes']);
  await run(['extend', 'KD-0001', '--comment', 'also on mobile', '--yes']);
  assert.match((await run(['route', 'KD-0001', '--yes'])).out, /already has the owner and builder/);
  assert.match((await run(['inbox', '--member', 'fullstack-developer'])).out, /KD-0001\/app\/acme-app/);
  assert.match((await run(['report'])).out, /Decided but not yet in prototype\/Figma: 1/);
  assert.match((await run(['why', 'KD-0001'])).out, /KD-0001 .* decided \(in force\)[\s\S]*why: Primary action on the right/);

  // Q2: in progress ahead of upstream is allowed, checking off is refused while prototype is open
  const appItem = 'KD-0001/app/acme-app';
  await run(['pick', appItem, '--as', 'fullstack-developer', '--yes']);
  await run(['link', appItem, '--pr', 'https://github.com/acme/acme-app/pull/1', '--as', 'fullstack-developer', '--yes']);
  const writes = writesTo(token);
  const early = await run(['check', appItem, '--as', 'fullstack-developer', '--yes'], 1);
  assert.match(early.out, /\[chain-order\] KD-0001\/app\/acme-app cannot be checked off before upstream is done: KD-0001\/prototype\/acme-app/);
  assert.equal(writesTo(token), writes, 'a refused check sends nothing');
  assert.match((await run(['report'])).out, /In progress ahead of upstream: 1/);

  // KETTE-24: follow-through per station with its definition of done, reads only, exit 1 while a station is open
  const follow = await run(['check', 'KD-0001'], 1);
  assert.match(follow.out, /KD-0001 follow-through: 2 of 2 stations open/);
  assert.match(follow.out, /prototype:acme-app open[\s\S]*done when: Screens, spec and docs changed and deployed where the team reviews the prototype/);
  assert.match(follow.out, /app:acme-app in_progress[\s\S]*done when: Live on shop\.acme\.test, deploy run checked[\s\S]*open: upstream open: KD-0001\/prototype\/acme-app/);
  assert.match(follow.out, /review: One batch review .* never a review per station/);
  assert.deepEqual(follow.all, []);
  assert.equal(writesTo(token), writes, 'the follow-through writes nothing');

  const proto = 'KD-0001/prototype/acme-app';
  await run(['pick', proto, '--as', 'ux-designer', '--yes']);
  await run(['link', proto, '--pr', 'https://github.com/acme/proto/pull/2', '--as', 'ux-designer', '--yes']);
  await run(['link', proto, '--review', 'https://github.com/acme/proto/pull/2#review', '--as', 'ux-designer', '--yes']);
  await run(['check', proto, '--as', 'ux-designer', '--yes']);
  assert.match((await run(['close', 'KD-0001', '--yes'], 1)).out, /\[close-open-items\] KD-0001 cannot close: KD-0001\/app\/acme-app/);
  await run(['link', appItem, '--review', 'https://github.com/acme/acme-app/pull/1#review', '--as', 'fullstack-developer', '--yes']);
  assert.match((await run(['check', appItem, '--as', 'fullstack-developer', '--yes'])).out, /check KD-0001\/app\/acme-app:[\s\S]*done when: Live on shop\.acme\.test, deploy run checked/);
  assert.match((await run(['list'])).out, /KD-0001 decided, closed, 2\/2 stations/);
  assert.match((await run(['check', 'KD-0001'])).out, /KD-0001 follow-through: every station done/);
});

test('a Community instance is refused for every ticket command and nothing is written', async () => {
  const box = sandbox();
  await licensed(box);
  const com = path.join(box.work, 'com');
  ok(await step(box, ['instance', 'create', 'oss', '--edition', 'community']));
  ok(await step(box, ['init', com, '--instance', 'oss', '--no-plugins', ...SETUP], { projects: [com] }));
  for (const argv of [['list'], ['connect', 'workload-zero', '--project', 'p', '--yes'], ['new', 'x', '--by', 'a', '--source', 's', '--stations', 'app', '--yes'], ['hook', 'install'], ['check', 'KD-0001/app/x', '--yes']]) {
    const r = ok(await step(box, ['ticket', ...argv], { cwd: com }), 1);
    assert.match(r.out, /Ticketing is part of Kette Enterprise \(Die Kette\)\. Setup: https:\/\/kette\.itdone\.de\/einrichten#ticketing Instance oss is Community/);
    assert.deepEqual(r.all, [], `kette ticket ${argv[0]} wrote nothing`);
  }
  assert.equal(readInstanceFile(box, 'oss').ticketing, undefined);
  const hook = ok(await step(box, ['ticket', 'hook', 'run'], { cwd: com, input: JSON.stringify({ prompt: 'bau den Button in der App um' }) }));
  assert.equal(hook.out, '', 'the hook stays silent outside Enterprise');
});

test('two instances with different boards on one machine: each repo reaches only its own board with its own token', needsBoard, async () => {
  const box = sandbox();
  await licensed(box);
  const [ta, tb] = ['tok-alpha-1111111111111111', 'tok-beta-2222222222222222'];
  const a = await connected(box, 'alpha', 'p-alpha', ta);
  const b = await connected(box, 'beta', 'p-beta', tb);
  noSecret(box, ok(await step(box, ['ticket', 'new', 'Alpha only', '--by', 'lead@alpha.test', '--source', 'chat:s', '--stations', 'app:alpha-app', '--yes'], { cwd: a })), [ta, tb]);
  const listB = noSecret(box, ok(await step(box, ['ticket', 'list'], { cwd: b })), [ta, tb]);
  assert.match(listB.out, /No decisions on the board of instance beta yet/);
  assert.match(noSecret(box, ok(await step(box, ['ticket', 'list'], { cwd: a })), [ta, tb]).out, /KD-0001 .*Alpha only/);
  // Only the member of beta may decide in beta, the station targets are beta's repos
  const cross = ok(await step(box, ['ticket', 'new', 'x', '--by', 'lead@alpha.test', '--source', 'chat:s', '--stations', 'app:alpha-app', '--yes'], { cwd: b }), 1);
  assert.match(cross.out, /Unknown target "alpha-app" for station app|\[decided-by-human\]/);
  for (const [token, project] of [[ta, 'p-alpha'], [tb, 'p-beta']]) {
    const foreign = requests.filter((r) => r.token === token && /\/tasks\/project\//.test(r.path) && !r.path.endsWith(`/${project}`));
    assert.deepEqual(foreign, [], `${project} token never reads another project`);
  }
  assert.equal(boards.get(tb).sim.tasks.size, 0, 'nothing landed on the beta board');
  assert.deepEqual(readInstanceFile(box, 'alpha').ticketing.project, 'p-alpha');
  assert.deepEqual(readInstanceFile(box, 'beta').ticketing.project, 'p-beta');
});

test('a repo without instance and a folder without project get a clear message and nothing is written', async () => {
  const box = sandbox();
  await licensed(box);
  const solo = path.join(box.work, 'solo');
  ok(await step(box, ['init', solo, '--no-plugins', ...SETUP], { projects: [solo] }));
  const r = ok(await step(box, ['ticket', 'list'], { cwd: solo }), 1);
  assert.match(r.out, /Ticketing is set per Kette instance and this repo has none\. Join one with kette instance use <name>/);
  assert.deepEqual(r.all, []);
  const none = ok(await step(box, ['ticket', 'connect', '--project', 'p', '--yes']), 1);
  assert.match(none.out, /No kette project in this folder/);
  assert.deepEqual(none.all, []);
});

test('missing board credential: a clear next step, no value asked for or printed', needsBoard, async () => {
  const box = sandbox();
  await licensed(box);
  const app = await enterpriseRepo(box, 'acme', { walletProject: 'wallet-empty' });
  const con = ok(await step(box, ['ticket', 'connect', 'workload-zero', '--project', 'p-acme', '--yes'], { cwd: app }));
  assert.match(con.out, /Next: KETTE_TICKETING_WORKBASE_TOKEN has no value in dev\. Declare the credential/);
  const list = ok(await step(box, ['ticket', 'list'], { cwd: app }), 1);
  assert.match(list.out, /No access to the ticket board of instance acme\. KETTE_TICKETING_WORKBASE_TOKEN has no value in dev\. .*kette wallet set KETTE_TICKETING_WORKBASE_TOKEN --env dev/);
  assert.deepEqual(list.all, []);
  fs.rmSync(path.join(app, '.kette', 'wallet.json'));
  assert.match(ok(await step(box, ['ticket', 'list'], { cwd: app }), 1).out, /This project has no secret wallet yet, create it with kette wallet init/);
  assert.deepEqual(requests.filter((r) => r.token === ''), [], 'no request without a token');
});

test('hook install and remove touch only the project settings and only kette\'s entry', async () => {
  const box = sandbox();
  await licensed(box);
  const app = await enterpriseRepo(box, 'acme', { stations: ['prototype', 'app'] });
  const settingsFile = path.join(app, '.claude', 'settings.json');
  const own = { enabledPlugins: { 'other@market': true }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] } };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(own, null, 2));
  const rec = { cwd: app, record: 'ticket-hook' };

  const dry = ok(await step(box, ['ticket', 'hook', 'install', '--dry-run'], rec));
  assert.deepEqual(dry.all, []);
  const inst = ok(await step(box, ['ticket', 'hook', 'install'], rec));
  assert.deepEqual(inst.all, [rel(box, app, '.claude/settings.json')], 'only the project settings change');
  const on = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(on.hooks.UserPromptSubmit.map((e) => e.hooks[0].command), ['echo mine', 'kette ticket hook run']);
  assert.deepEqual(on.hooks.PreToolUse, own.hooks.PreToolUse);
  assert.match(ok(await step(box, ['ticket', 'hook', 'status'], rec)).out, /Intake hook on in \.claude\/settings\.json/);
  assert.deepEqual(ok(await step(box, ['ticket', 'hook', 'install'], rec)).all, [], 'a second install changes nothing');

  // The hook answer needs the library; without it the hook stays silent and still exits 0
  const hit = ok(await step(box, ['ticket', 'hook', 'run'], { ...rec, input: JSON.stringify({ prompt: 'Skillmap und Skill radar zusammenlegen in acme-app' }) }));
  assert.deepEqual(hit.all, []);
  if (hasTicketing) assert.match(JSON.parse(hit.out).hookSpecificOutput.additionalContext, /Kette intake: this prompt asks for a change to the chain\. Stations touched \(first guess\): [^.]*\bapp\./);
  else assert.equal(hit.out, '');
  assert.equal(ok(await step(box, ['ticket', 'hook', 'run'], { ...rec, input: 'not json' })).out, '', 'bad input: silent, exit 0');

  const rm = ok(await step(box, ['ticket', 'hook', 'remove'], rec));
  assert.deepEqual(rm.all, [rel(box, app, '.claude/settings.json')]);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), own, 'remove gives back exactly the settings from before');
  assert.equal(fs.existsSync(path.join(box.home, '.claude', 'settings.json')), false, 'the user settings of Claude Code were never written');
});

test('setup offers to connect a board in a terminal after the wallet step, a run without terminal never asks', { skip: posixOnly || needsBoard.skip }, async () => {
  const box = sandbox();
  await licensed(box);
  ok(await step(box, ['instance', 'create', 'acme', '--edition', 'enterprise']));
  const quiet = path.join(box.work, 'quiet');
  ok(await step(box, ['init', quiet, '--instance', 'acme', '--no-plugins', ...SETUP], { projects: [quiet] }));
  assert.equal(readInstanceFile(box, 'acme').ticketing, undefined, 'no question, no board without a terminal');
  box.env = { ...box.env, ...env() };
  const r = await interactive(box, ['init', 'asked', '--instance', 'acme', '--no-plugins', '--stack', 'nestjs-prisma', '--platform', 'github-docker', '--patterns', 'layered'], [
    ['Create these files?', 'y'],
    ['Set up the secret wallet', 'n'],
    ['Track decisions as tickets', 'y'],
    ['workload.zero project id', 'p-setup'],
  ], { scenario: 'ticket-setup' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.outside, []);
  assert.deepEqual(readInstanceFile(box, 'acme').ticketing, { adapter: 'workload-zero', project: 'p-setup' });
  assert.match(r.out, /Instance acme uses workload-zero p-setup for decisions/);
});
