import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadErrorText, errorFor } from '../src/delivery.mjs';

test('jeder Fehlercode aus dem Vertrag hat einen eigenen Text mit nächstem Schritt', () => {
  const cases = [
    [400, { error: 'bad_request' }, /ungültiges Format.*kette login erneut/],
    [401, { error: 'invalid_key' }, /kennen wir nicht/],
    [403, { error: 'revoked' }, /widerrufen/],
    [403, { error: 'wrong_offer' }, /anderen Angebot/],
    [429, { error: 'device_limit', seats: { used: 20, max: 20 } }, /20 von 20 Geräten/],
    [429, { error: 'rate_limited' }, /Eine Minute warten/],
    [503, { error: 'unavailable' }, /gerade nicht bereitstellen.*info@itdone\.de.*Community-Edition bleibt nutzbar/],
  ];
  for (const [status, body, message] of cases) {
    const err = errorFor(status, body);
    assert.equal(err.code, body.error);
    assert.match(err.message, message);
    assert.doesNotMatch(err.message, /Unerwartete Antwort/);
  }
  assert.match(errorFor(500, {}).message, /Unerwartete Antwort vom Lieferdienst \(500\)/);
});

test('Download-Fehler nennen Ursache und nächsten Schritt', () => {
  assert.match(downloadErrorText({ status: 410 }), /abgelaufen.*erneut ausführen/);
  assert.match(downloadErrorText({ status: 404 }), /ungültig.*erneut ausführen/);
  assert.match(downloadErrorText({ checksum: true }), /Prüfsumme/);
});
