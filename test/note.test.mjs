import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { agentNote, renewNote } from '../src/note.mjs';

const note = agentNote('community');
const BEGIN = '<!-- kette:begin alt -->';
const END = '<!-- kette:end -->';

test('the Community flow names the fixed core topics, comments included', () => {
  assert.match(note, /follow it \(readability, structure, errors, tests, security, dependencies, logging-operations, changes, comments\)\./);
});

test('genau ein Block wird ersetzt, Text davor und danach bleibt', () => {
  const next = renewNote(`Kopf\n${BEGIN}\nalt\n${END}\nNotiz\n`, note);
  assert.equal(next, `Kopf\n${note}Notiz\n`);
});

test('fehlende, doppelte oder vertauschte Markierungen ändern nichts', () => {
  const cases = [
    `${BEGIN}\nalt\n`,
    `alt\n${END}\n`,
    `${BEGIN}\n${BEGIN}\nalt\n${END}\n`,
    `${BEGIN}\nalt\n${END}\n${END}\n`,
    `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`,
    `${END}\nalt\n${BEGIN}\n`,
    '# eigene Datei ohne Block\n',
  ];
  for (const c of cases) assert.equal(renewNote(c, note), null, JSON.stringify(c));
});

test('CRLF-Datei: nur der neue Block bekommt CRLF, Zeilen außerhalb bleiben unverändert', () => {
  const next = renewNote(`Kopf\n${BEGIN}\r\nalt\r\n${END}\r\nNotiz LF\nNotiz CRLF\r\n`, note);
  assert.equal(next, `Kopf\n${note.replace(/\n/g, '\r\n')}Notiz LF\nNotiz CRLF\r\n`);
});

test('CRLF bleibt CRLF, auch beim Erkennen der alten Fassung', () => {
  const next = renewNote(`Kopf\r\n${BEGIN}\r\nalt\r\n${END}\r\nNotiz\r\n`, note);
  assert.equal(next, `Kopf\r\n${note.replace(/\n/g, '\r\n')}Notiz\r\n`);
  assert.doesNotMatch(next.replace(/\r\n/g, ''), /\n/);
  const legacy = fs.readFileSync(new URL('./fixtures/kette-readme-0.3.1.md', import.meta.url), 'utf8');
  assert.equal(renewNote(legacy.replace(/\n/g, '\r\n'), note), note.replace(/\n/g, '\r\n'));
  assert.equal(renewNote(legacy, note), note);
});

test('without flow the text names both modes; flow.mode batch makes the batch review the project default', () => {
  const plain = agentNote('enterprise');
  assert.match(plain, /Several branches in the same round \(batch review\): describe the round to `\/feature-loop`/);
  assert.doesNotMatch(plain + agentNote('community') + agentNote('enterprise', { mode: 'batch' }) + agentNote('community', { mode: 'batch' }), /release train/i);
  const train = agentNote('enterprise', { mode: 'batch', maxParallel: 3, fixRounds: 2, review: { ui: ['design', 'ux'], code: ['code-reviewer', 'qa'] } });
  assert.match(train, /Default for this project \(`flow\.mode: batch`\).*never with gates per branch, pull request or fix\./);
  assert.match(train, /At most 3 heavy agents/);
  assert.match(train, /up to 2 fix rounds/);
  assert.match(train, /   - Every change: `kette-engineering:code-reviewer`, `design-system-agents:qa-engineer` \(`flow\.review\.code` in the profile\)\./);
  assert.match(train, /   - UI changes also: `design-review-pack:design-reviewer`, `design-review-pack:ux-reviewer` \(`flow\.review\.ui`\)\./);
  assert.doesNotMatch(train, /Several branches in the same round \(batch review\)/);
  assert.equal(agentNote('enterprise', { mode: 'train' }), agentNote('enterprise', { mode: 'batch' }), 'train is the old name of batch');
});

test('flow.mode per-change keeps the gates per change; unknown values fall back to the text without flow', () => {
  assert.match(agentNote('enterprise', { mode: 'per-change' }), /the gates from step 4 run on every change and branch\. A batch review .* runs only when asked for\./);
  assert.match(agentNote('community', { mode: 'per-change' }), /^4\. Default for this project \(`flow\.mode: per-change`\): `kette-check` runs on every change and branch\./m);
  assert.match(agentNote('community', { mode: 'batch' }), /^4\. Default for this project \(`flow\.mode: batch`\).*No `kette-check` per branch or pull request\./m);
  assert.equal(agentNote('enterprise', { mode: 'sometimes', maxParallel: 99, review: { ui: 'design' } }), agentNote('enterprise'));
  assert.match(agentNote('enterprise', { mode: 'train', fixRounds: 0 }), /then open findings go to a person\./);
});
