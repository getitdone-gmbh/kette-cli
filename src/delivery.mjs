import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { credentialsFile, delivery, deviceIdFile } from './paths.mjs';

export const KEY_PATTERN = /^CDP(-[A-Z0-9]{5}){4}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUPPORT = 'write to info@itdone.de';
// Reply of the delivery service while the registry or the Figma delivery is not set up yet
export const NPM_PENDING = 'npm access is not available right now. Try again later with kette update.';
export const FIGMA_PENDING = 'Figma files are not available right now. Try again later with kette figma.';

const seatsText = (seats) => (seats?.max ? ` (${seats.used} of ${seats.max} devices in use)` : '');

// Message per error code from docs/install-api.md, each with the next step
const MESSAGES = {
  bad_request: () => 'License key or device ID has an invalid format. Enter the key exactly as in the purchase confirmation (CDP-XXXXX-XXXXX-XXXXX-XXXXX) and run kette login again.',
  invalid_key: () => `We do not know this license key. Check for typos and copy the key from the purchase confirmation. If it still does not work, ${SUPPORT}.`,
  revoked: () => `This license key was revoked or refunded and no longer unlocks Enterprise. For a new key, ${SUPPORT}. The Community edition keeps working.`,
  wrong_offer: () => 'This key belongs to a different offer, not to Die Kette. Use the key from the Die Kette purchase confirmation (Solo or Team).',
  device_limit: (body) => `The device limit of this license is reached${seatsText(body.seats)}. Support can release an old device, ${SUPPORT}. The Team license allows more devices.`,
  rate_limited: () => 'Too many requests in a short time. Wait a minute and try again.',
  unavailable: () => `The delivery service cannot provide the Enterprise bundle right now. Try again in a few minutes, if it persists ${SUPPORT}. The Community edition keeps working.`,
  device_unknown: () => 'This device is not registered with the license yet. Run kette login <key> first.',
  ci_token_limit: (body) => `The license already has ${body.used} of ${body.max} CI tokens. Revoke an old one with kette token ci revoke <id> (list: kette token ci list).`,
  expired: () => 'The download link expired (valid for 15 minutes). Just run the command again.',
  not_found: () => `Not found. Run the command again, if it persists ${SUPPORT}.`,
  registry_not_configured: () => NPM_PENDING,
  figma_not_configured: () => FIGMA_PENDING,
};

export class DeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function errorFor(status, body = {}) {
  const code = body.error || `http_${status}`;
  const text = MESSAGES[code]?.(body) || `Unexpected response from the delivery service (${status}${body.error ? `, ${body.error}` : ''}). Try again later, if it persists ${SUPPORT}.`;
  return new DeliveryError(code, text);
}

export function downloadErrorText(err) {
  if (err.checksum) return `The checksum of the Enterprise bundle does not match, nothing was installed. Try again, if it happens again ${SUPPORT}.`;
  if (err.status === 410) return 'The download link expired (valid for 15 minutes). Just run the command again to get a new link.';
  if (err.status === 404) return `The download link is invalid. Run the command again, if it persists ${SUPPORT}.`;
  return `The Enterprise bundle could not be downloaded (${err.status || err.message}). Check your internet connection and try again.`;
}

async function call(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new DeliveryError('network', `Delivery service not reachable (${delivery()}: ${err.cause?.code || err.cause?.message || err.message}). Check your internet connection, behind a proxy or mirror set KETTE_DELIVERY.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw errorFor(res.status, body);
  return body;
}

export function requestToken({ key, device, cli }) {
  return call(`${delivery()}/install/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, device, cli }),
  });
}

// POST statt Query-String, damit der Schlüssel nicht in Zugriffslogs landet
export function latest({ key, device }) {
  return call(`${delivery()}/install/latest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, device }),
  });
}

const postJson = (path, body) => call(`${delivery()}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// npm-Zugang (docs/install-api.md, Abschnitt npm-Registry): Gerätetoken, CI-Tokens, Figma-Links
export const registryToken = ({ key, device }) => postJson('/registry/token', { key, device });
export const revokeRegistryToken = ({ key, device }) => postJson('/registry/token/revoke', { key, device });
export const createCiToken = ({ key, device, label }) => postJson('/registry/ci-tokens/create', { key, device, label });
export const listCiTokens = ({ key, device }) => postJson('/registry/ci-tokens/list', { key, device });
export const revokeCiToken = ({ key, device, id }) => postJson('/registry/ci-tokens/revoke', { key, device, id });
export const figmaLinks = ({ key }) => postJson('/figma/links', { key });

// Geräte-ID wird einmal erzeugt und bleibt, damit ein erneuter Login kein neues Gerät belegt
export function deviceId() {
  const file = deviceIdFile();
  if (fs.existsSync(file)) {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (!UUID_PATTERN.test(id)) throw new Error(`Device ID in ${file} is damaged. Delete the file and sign in again, the device then counts as new.`);
    return id;
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, id + '\n', { mode: 0o600 });
  return id;
}

export function readCredentials() {
  const file = credentialsFile();
  if (!fs.existsSync(file)) return null;
  let key = null;
  try { ({ key } = JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { key = null; }
  if (!KEY_PATTERN.test(key || '')) throw new Error(`Credentials in ${file} are damaged. Remove them with kette logout and sign in again with kette login <key>.`);
  return { key };
}

export function writeCredentials(key) {
  const file = credentialsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ key }) + '\n', { mode: 0o600 });
  // mode gilt nur beim Anlegen, eine vorhandene Datei wird nachgezogen
  fs.chmodSync(file, 0o600);
}

export function removeCredentials() {
  fs.rmSync(credentialsFile(), { force: true });
}
