import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from './helpers.mjs';
import { KEY, SETUP, TICKETING, changed, hasTicketing, interactive, kette, ok, posixOnly, readInstanceFile, sandbox, snapshot, start, stop } from './sandbox-harness.mjs';

// kette ticket in a fresh sandbox per scenario (KETTE-12): the board is the workload.zero simulator of kette-ticketing behind a local
// server, one simulated board per token; after each command a diff of the whole sandbox and a search for every token value
const TOKEN = 'KETTE_TICKETING_WORKBASE_TOKEN';
const boards = new Map();
const requests = [];
let server;
const needsBoard = { skip: hasTicketing ? false : `no built kette-ticketing in ${TICKETING} (set KETTE_TICKETING)` };

before(async () => {
  await start();
  if (!hasTicketing) return;
  const { createWorkbaseSimulator } = await import(pathToFileURL(path.join(TICKETING, 'dist', 'index.js')).href);
  server = await serve(async (req, res, body) => {
    const token = (req.headers.authorization || '').slice('Bearer '.length);
    requests.push({ token, method: req.method, path: req.url });
    const board = boards.get(token);
    if (!board) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"statusCode":401,"message":"Unauthorized"}'); }
    board.sim ??= createWorkbaseSimulator({ baseUrl: `${server.url}/api`, projectId: board.project });
    const answer = await board.sim.fetch(`${server.url}${req.url}`, { method: req.method, headers: { Authorization: req.headers.authorization }, ...(body ? { body } : {}) });
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(await answer.text());
  });
});
after(async () => { await server?.close(); await stop('sandbox-ticket'); });

const env = () => ({ KETTE_TICKETING_API: `${server.url}/api`, KETTE_INTAKE_OLLAMA_URL: 'http://127.0.0.1:9/v1/chat/completions' });
const writesTo = (token) => requests.filter((r) => r.token === token && r.method !== 'GET').length;

// No token value in any file of the sandbox (the provider store lives outside it, like a real vault) nor in the output
function noSecret(box, r, secrets) {
  const files = [...snapshot(box.root).entries()].filter(([, v]) => v !== 'dir' && v !== 'git' && !v.startsWith('link:')).map(([f]) => f);
  for (const s of secrets) {
    assert.ok(!r.out.includes(s), `token in the output of ${r.out.slice(0, 200)}`);
    for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(s), `token written to ${path.relative(box.root, f)}`);
  }
  return r;
}

// Runs one step and returns everything that changed anywhere in the sandbox
async function step(box, argv, opts = {}) {
  const before = snapshot(box.root);
  const r = await kette(box, argv, { record: opts.record || 'ticket', ...opts, env: { ...(server ? env() : {}), ...opts.env } });
  return { ...r, all: changed(before, snapshot(box.root)).map((p) => path.relative(box.root, p).split(path.sep).join('/')) };
}

const rel = (box, dir, f) => path.relative(box.root, path.join(dir, f)).split(path.sep).join('/');

// An Enterprise repo of instance name with a wallet; board and token only when given
async function enterpriseRepo(box, name, { stations = ['prototype', 'app'], walletProject = `wallet-${name}` } = {}) {
  const dir = path.join(box.work, `${name}-app`);
  ok(await step(box, ['instance', 'create', name, '--edition', 'enterprise']));
  ok(await step(box, ['instance', 'members', 'add', `lead@${name}.test`, '--role', 'owner', '--instance', name]));
  const f = path.join(box.home, '.kette', 'instances', name, 'instance.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), stations }, null, 2));
  ok(await step(box, ['init', dir, '--instance', name, '--no-plugins', ...SETUP], { projects: [dir] }));
  ok(await step(box, ['wallet', 'init', '--yes'], { cwd: dir, env: { KETTE_WALLET_PROJECT: walletProject } }));
  return dir;
}

async function connected(box, name, project, token) {
  const dir = await enterpriseRepo(box, name);
  noSecret(box, ok(await step(box, ['ticket', 'connect', 'workload-zero', '--project', project, '--yes'], { cwd: dir })), [token]);
  noSecret(box, ok(await step(box, ['wallet', 'set', TOKEN, '--env', 'dev', '--stdin'], { cwd: dir, input: `${token}\n` })), [token]);
  boards.set(token, { project });
  return dir;
}

const licensed = async (box) => ok(await step(box, ['login', KEY, '--no-plugins', '--no-npm']));

test('Enterprise instance: connect writes only the ticketing block, then every command runs on its board', needsBoard, async () => {
  const box = sandbox();
  const token = 'tok-acme-0123456789abcdef';
  await licensed(box);
  const app = await enterpriseRepo(box, 'acme');
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
  const newArgs = ['new', words, '--by', 'lead@acme.test', '--source', 'chat:session-test', '--stations', 'prototype:workload-zero-dashboard,app:acme-app'];
  const before = writesTo(token);
  const planned = await run([...newArgs, '--dry-run']);
  assert.match(planned.out, /New decision KD-0001 with 2 station items/);
  assert.match(planned.out, /--dry-run: nothing written/);
  assert.deepEqual(planned.all, []);
  assert.equal(writesTo(token), before, 'dry run sends no write to the board');

  const made = await run([...newArgs, '--yes']);
  assert.match(made.out, /KD-0001\/prototype\/workload-zero-dashboard[\s\S]*KD-0001\/app\/acme-app/);
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
  assert.match(early.out, /\[chain-order\] KD-0001\/app\/acme-app cannot be checked off before upstream is done: KD-0001\/prototype\/workload-zero-dashboard/);
  assert.equal(writesTo(token), writes, 'a refused check sends nothing');
  assert.match((await run(['report'])).out, /In progress ahead of upstream: 1/);

  const proto = 'KD-0001/prototype/workload-zero-dashboard';
  await run(['pick', proto, '--as', 'ux-designer', '--yes']);
  await run(['link', proto, '--pr', 'https://github.com/acme/proto/pull/2', '--as', 'ux-designer', '--yes']);
  await run(['link', proto, '--review', 'https://github.com/acme/proto/pull/2#review', '--as', 'ux-designer', '--yes']);
  assert.match((await run(['check', proto, '--as', 'ux-designer', '--yes'], 1)).out, /\[approval\] .* needs approval by lead@acme\.test/);
  await run(['check', proto, '--as', 'ux-designer', '--approved-by', 'lead@acme.test', '--yes']);
  assert.match((await run(['close', 'KD-0001', '--yes'], 1)).out, /\[close-open-items\] KD-0001 cannot close: KD-0001\/app\/acme-app/);
  await run(['link', appItem, '--review', 'https://github.com/acme/acme-app/pull/1#review', '--as', 'fullstack-developer', '--yes']);
  await run(['check', appItem, '--as', 'fullstack-developer', '--yes']);
  assert.match((await run(['list'])).out, /KD-0001 decided, closed, 2\/2 stations/);
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

test('hook install and remove touch only the project settings and only kette\'s entry', needsBoard, async () => {
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

  const hit = ok(await step(box, ['ticket', 'hook', 'run'], { ...rec, input: JSON.stringify({ prompt: 'Skillmap und Skill radar zusammenlegen in acme-app' }) }));
  assert.deepEqual(hit.all, []);
  assert.match(JSON.parse(hit.out).hookSpecificOutput.additionalContext, /Kette intake: this prompt asks for a change to the chain\. Stations touched \(first guess\): [^.]*\bapp\./);
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
