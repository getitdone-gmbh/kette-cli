import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { agentNote, renewNote } from '../src/note.mjs';

const note = agentNote('community');
const BEGIN = '<!-- kette:begin alt -->';
const END = '<!-- kette:end -->';

test('the Community flow names the core topics, from the bundle when given', () => {
  assert.match(note, /follow it \(readability, structure, errors, tests, security, dependencies, logging-operations, changes, comments\)\./);
  assert.match(agentNote('community', ['readability', 'naming']), /follow it \(readability, naming\)\./);
  assert.match(agentNote('community', []), /changes, comments\)\./);
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
