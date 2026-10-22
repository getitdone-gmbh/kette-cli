import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_END, BLOCK_START, authKey, blockToken, foreignScopeLines, hasBlock, projectScope, withBlock, withoutBlock } from '../src/npmrc.mjs';

const REG = 'https://npm.kette.itdone.de/';
const T1 = `kt_${'a'.repeat(43)}`;
const T2 = `kt_${'b'.repeat(43)}`;

test('authKey ordnet den Token der Registry ohne Protokoll und mit Schrägstrich zu', () => {
  assert.equal(authKey('https://npm.kette.itdone.de/'), '//npm.kette.itdone.de/');
  assert.equal(authKey('http://127.0.0.1:8080'), '//127.0.0.1:8080/');
  assert.equal(authKey('https://example.test/npm/'), '//example.test/npm/');
});

test('ohne Datei entsteht nur der Block', () => {
  assert.equal(withBlock('', REG, T1), `${BLOCK_START}\n@getitdone-gmbh:registry=${REG}\n//npm.kette.itdone.de/:_authToken=${T1}\n${BLOCK_END}\n`);
});

test('andere Einstellungen bleiben, der Block wird erneuert statt verdoppelt, logout entfernt nur ihn', () => {
  const user = 'registry=https://registry.npmjs.org/\n@other:registry=https://npm.example.com/\n//npm.example.com/:_authToken=${OTHER}\nsave-exact=true\n';
  const once = withBlock(user, REG, T1);
  const twice = withBlock(once, REG, T2);
  assert.ok(twice.startsWith(user));
  assert.equal(twice.split(BLOCK_START).length, 2, 'genau ein Block');
  assert.equal(blockToken(twice), T2);
  assert.equal(withoutBlock(twice), user);
  assert.equal(hasBlock(withoutBlock(twice)), false);
});

test('CRLF-Dateien behalten CRLF', () => {
  const user = 'save-exact=true\r\nfund=false\r\n';
  const next = withBlock(user, REG, T1);
  assert.ok(!/[^\r]\n/.test(next), 'nur CRLF');
  assert.equal(withoutBlock(next), user);
});

test('eine fremde Scope-Zeile wird erkannt, mit replace auskommentiert und beim Entfernen wiederhergestellt', () => {
  const dev = '@getitdone-gmbh:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN_PUBLISH}\n';
  assert.deepEqual(foreignScopeLines(dev), ['@getitdone-gmbh:registry=https://npm.pkg.github.com']);
  const replaced = withBlock(dev, REG, T1, { replace: true });
  assert.deepEqual(foreignScopeLines(replaced), [], 'nur noch die Zeile im Block');
  assert.match(replaced, /^# kette login hat deaktiviert: @getitdone-gmbh:registry=https:\/\/npm\.pkg\.github\.com$/m);
  assert.equal(withoutBlock(replaced), dev);
  assert.deepEqual(foreignScopeLines(withBlock('', REG, T1)), [], 'die Zeile im Block zählt nicht als fremd');
});

test('ein angefangener Block ohne Ende gilt nicht als Block und wird nicht gelöscht', () => {
  const broken = `${BLOCK_START}\nsave-exact=true\n`;
  assert.equal(hasBlock(broken), false);
  assert.equal(withoutBlock(broken), broken);
});

test('projectScope liest die Scope-Zeile einer Projekt-.npmrc', () => {
  assert.equal(projectScope('@getitdone-gmbh:registry=https://npm.pkg.github.com\n'), 'https://npm.pkg.github.com');
  assert.equal(projectScope('  @getitdone-gmbh:registry = https://npm.kette.itdone.de/  \r\n'), 'https://npm.kette.itdone.de/');
  assert.equal(projectScope('fund=false\n'), null);
});
