import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadErrorText, errorFor } from '../src/delivery.mjs';

test('jeder Fehlercode aus dem Vertrag hat einen eigenen Text mit nächstem Schritt', () => {
  const cases = [
    [400, { error: 'bad_request' }, /invalid format.*run kette login again/],
    [401, { error: 'invalid_key' }, /do not know this license key/],
    [403, { error: 'revoked' }, /revoked or refunded/],
    [403, { error: 'wrong_offer' }, /different offer/],
    [429, { error: 'device_limit', seats: { used: 20, max: 20 } }, /20 of 20 devices/],
    [429, { error: 'rate_limited' }, /Wait a minute/],
    [503, { error: 'unavailable' }, /cannot provide the Enterprise bundle right now.*info@itdone\.de.*Community edition keeps working/],
  ];
  for (const [status, body, message] of cases) {
    const err = errorFor(status, body);
    assert.equal(err.code, body.error);
    assert.match(err.message, message);
    assert.doesNotMatch(err.message, /Unexpected response/);
  }
  assert.match(errorFor(500, {}).message, /Unexpected response from the delivery service \(500\)/);
});

test('Download-Fehler nennen Ursache und nächsten Schritt', () => {
  assert.match(downloadErrorText({ status: 410 }), /expired.*run the command again/);
  assert.match(downloadErrorText({ status: 404 }), /invalid.*Run the command again/);
  assert.match(downloadErrorText({ checksum: true }), /checksum/);
});
