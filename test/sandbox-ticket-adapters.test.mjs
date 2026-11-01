import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TICKETING, hasTicketing, ok, readInstanceFile, sandbox, start, startBoard, stop, ticketKit } from './sandbox-harness.mjs';

// KETTE-54 against the real kette-ticketing with its adapters (KETTE-47 to KETTE-52), offline: connect writes and checks the block of
// every system and declares its token name; without a value in the wallet nothing is ever sent
const lib = hasTicketing ? await import(pathToFileURL(path.join(TICKETING, 'scripts', 'cli-facade.mjs')).href) : null;
const skip = !lib ? `no built kette-ticketing in ${TICKETING} (set KETTE_TICKETING)` : !(lib.SUPPORTED_ADAPTERS?.length > 1) ? 'the built kette-ticketing has no adapters besides workload-zero yet' : false;

let board;
let kit;
before(async () => { await start(); board = await startBoard(); kit = ticketKit(board); });
after(async () => { await board.close(); await stop('sandbox-ticket-adapters'); });

const SYSTEMS = [
  ['github', ['--board', 'acme/web', '--trusted-authors', 'ci-bot']],
  ['jira', ['--board', 'SHOP', '--host', 'acme.atlassian.net', '--decision-type', 'Task', '--item-type', 'Sub-task']],
  ['linear', ['--board', 'ENG']],
  ['gitlab', ['--board', 'acme/platform/web', '--host', 'gitlab.acme.example']],
  ['azure-devops', ['--board', 'Shop', '--org', 'acme']],
];

test('KETTE-54: connect writes the checked block and the token name of every system, nothing leaves the machine without a token', { skip }, async () => {
  const box = sandbox();
  await kit.licensed(box);
  const help = ok(await kit.step(box, ['ticket', 'help'], { cwd: await kit.enterpriseRepo(box, 'helpcheck') }));
  for (const a of lib.SUPPORTED_ADAPTERS) assert.ok(help.out.includes(lib.adapterUsage(a).replace(/--project\b/g, '--board')), `usage of ${a}`);
  for (const [adapter, flags] of SYSTEMS) {
    const app = await kit.enterpriseRepo(box, `k-${adapter}`);
    const before = board.requests.length;
    const r = ok(await kit.step(box, ['ticket', 'connect', adapter, ...flags, '--yes'], { cwd: app }));
    const block = readInstanceFile(box, `k-${adapter}`).ticketing;
    assert.equal(block.adapter, adapter);
    const fields = Object.fromEntries(Object.entries(block).filter(([k]) => k !== 'adapter'));
    assert.deepEqual(block, lib.connectSettings(adapter, fields), `${adapter}: the block is what the library writes`);
    const token = lib.tokenNameFor(adapter);
    assert.ok(JSON.parse(fs.readFileSync(path.join(app, '.kette', 'wallet.json'), 'utf8')).secrets.some((s) => s.name === token), `${adapter} declares ${token}`);
    assert.match(r.out, new RegExp(`Next: .*kette wallet add ${token}`));
    assert.equal(board.requests.length, before, `${adapter}: no request without a token`);
  }
});

test('KETTE-54: Jira outside atlassian.net needs --deployment; datacenter and trusted authors land in instance.json', { skip }, async () => {
  const box = sandbox();
  await kit.licensed(box);
  const app = await kit.enterpriseRepo(box, 'dc');
  const without = ok(await kit.step(box, ['ticket', 'connect', 'jira', '--board', 'SHOP', '--host', 'jira.acme.example', '--yes'], { cwd: app }), 1);
  assert.match(without.out, /ticketing\.host .*not an atlassian\.net site: set "deployment": "datacenter".*Nothing written\./);
  assert.equal(readInstanceFile(box, 'dc').ticketing, undefined);
  const wrong = ok(await kit.step(box, ['ticket', 'connect', 'jira', '--board', 'SHOP', '--host', 'jira.acme.example', '--deployment', 'server', '--yes'], { cwd: app }), 1);
  assert.match(wrong.out, /ticketing\.deployment \(--deployment\) must be cloud or datacenter/);
  ok(await kit.step(box, ['ticket', 'connect', 'jira', '--board', 'SHOP', '--host', 'jira.acme.example', '--deployment', 'datacenter', '--trusted-authors', 'svc-kette,lead', '--yes'], { cwd: app }));
  const block = readInstanceFile(box, 'dc').ticketing;
  assert.equal(block.deployment, 'datacenter');
  assert.deepEqual(block.trustedAuthors, ['svc-kette', 'lead']);
  const bad = ok(await kit.step(box, ['ticket', 'connect', 'github', '--board', 'not a repo', '--yes'], { cwd: await kit.enterpriseRepo(box, 'gh') }), 1);
  assert.match(bad.out, /ticketing\.project \(--board\)/);
});
