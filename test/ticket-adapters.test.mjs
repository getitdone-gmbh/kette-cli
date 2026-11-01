import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeWrite } from '../src/ticket/command.mjs';
import { sameBoard, settingsFor, supportedAdapters, tokenNameOf, usageLines } from '../src/ticket/adapters.mjs';
import { newInstance, validateInstance } from '../src/instance/config.mjs';

// KETTE-54: the CLI side of the ticket adapters, without a bundle
const withTicketing = (ticketing) => validateInstance({ ...newInstance('acme', 'enterprise'), ticketing });

test('KETTE-54 item 5: planned writes show ids of other systems as they are, workload.zero ids as :id, Linear by its mutation', () => {
  assert.equal(describeWrite({ method: 'PATCH', path: '/tasks/6ae510fc15371242272a4278', body: { status: 'done' } }), 'PATCH /tasks/:id · status done');
  assert.equal(describeWrite({ method: 'POST', path: '/repos/acme/web/issues/42/comments', body: { body: 'kette:revision\nmore' } }), 'POST /repos/acme/web/issues/42/comments · comment "kette:revision"');
  assert.equal(describeWrite({ method: 'POST', path: '/rest/api/3/issue', body: { fields: { summary: 'KD-0001 · Save goes right' } } }), 'POST /rest/api/3/issue · "KD-0001 · Save goes right"');
  assert.equal(describeWrite({ method: 'POST', path: '/graphql', body: { query: 'mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success } }' } }), 'POST /graphql · mutation IssueCreate');
  assert.equal(describeWrite({ method: 'POST', path: '/x\u001b[31m', body: {} }), 'POST /x', 'no escape sequence from a path reaches the screen');
});

test('KETTE-54 items 3 and 7: instance.json takes the block of every adapter, keeps the workload.zero id rule, session only for workload.zero', () => {
  assert.deepEqual(withTicketing({ adapter: 'github', project: 'acme/web', subIssues: false, trustedAuthors: ['ci-bot', 'lead@acme.test'] }), []);
  assert.deepEqual(withTicketing({ adapter: 'jira', project: 'SHOP', host: 'jira.acme.example', deployment: 'datacenter', decisionType: 'Task', itemType: 'Sub-task' }), []);
  assert.deepEqual(withTicketing({ adapter: 'azure-devops', project: 'My Project', org: 'acme' }), []);
  assert.deepEqual(withTicketing({ adapter: 'workload-zero', project: 'p-acme', session: true }), []);
  assert.match(withTicketing({ adapter: 'workload-zero', project: 'a/b' }).join(), /ticketing\.project must be a board project id/);
  assert.match(withTicketing({ adapter: 'github', project: 'acme/web', session: true }).join(), /ticketing\.session is for workload-zero boards only/);
  assert.match(withTicketing({ adapter: 'jira', project: 'SHOP', deployment: 'server' }).join(), /ticketing\.deployment must be cloud or datacenter/);
  assert.match(withTicketing({ adapter: 'github', project: 'acme/web', trustedAuthors: ['bad name'] }).join(), /ticketing\.trustedAuthors must be a list of account names/);
  assert.match(withTicketing({ adapter: 'github', project: 'acme/web', subIssues: 'no' }).join(), /ticketing\.subIssues must be true or false/);
  assert.match(withTicketing({ adapter: 'github', project: 'acme/web', colour: 'red' }).join(), /unknown field ticketing\.colour/);
});

test('KETTE-54: a bundle from before the adapters still works as workload.zero only', () => {
  const old = { adapterId: (a) => (a === 'workbase' ? 'workload-zero' : a), assertProjectId: (id) => id };
  assert.deepEqual(supportedAdapters(old), ['workload-zero']);
  assert.equal(tokenNameOf(old, 'workload-zero'), 'KETTE_TICKETING_WORKBASE_TOKEN');
  assert.deepEqual(usageLines(old), ['kette ticket connect workload-zero --board <project id>']);
  assert.deepEqual(settingsFor(old, 'workload-zero', { project: 'p-acme', host: undefined }), { adapter: 'workload-zero', project: 'p-acme' });
});

test('KETTE-54 item 2: "already uses" compares the whole block, not only adapter and project; hand-set session and intakeModel do not count', () => {
  const lib = { adapterId: (a) => (a === 'workbase' ? 'workload-zero' : a) };
  const next = { adapter: 'github', project: 'acme/web', trustedAuthors: ['ci'] };
  assert.equal(sameBoard(lib, { project: 'acme/web', trustedAuthors: ['ci'], adapter: 'github' }, next), true, 'key order does not matter');
  assert.equal(sameBoard(lib, { adapter: 'github', project: 'acme/web' }, next), false);
  assert.equal(sameBoard(lib, { adapter: 'github', project: 'acme/web', host: 'ghe.acme.example', trustedAuthors: ['ci'] }, next), false);
  assert.equal(sameBoard(lib, { adapter: 'workbase', project: 'p', session: true, intakeModel: 'https://m.example' }, { adapter: 'workload-zero', project: 'p' }), true);
});
