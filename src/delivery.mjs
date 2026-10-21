import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { credentialsFile, delivery, deviceIdFile } from './paths.mjs';

export const KEY_PATTERN = /^CDP(-[A-Z0-9]{5}){4}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUPPORT = 'an info@itdone.de schreiben';

const seatsText = (seats) => (seats?.max ? ` (${seats.used} von ${seats.max} Geräten belegt)` : '');

// Fehlertexte je Code aus docs/install-api.md, jeweils mit nächstem Schritt
const MESSAGES = {
  bad_request: () => 'Lizenzschlüssel oder Geräte-ID haben ein ungültiges Format. Den Schlüssel genau wie in der Kaufbestätigung angeben (CDP-XXXXX-XXXXX-XXXXX-XXXXX) und kette login erneut ausführen.',
  invalid_key: () => 'Diesen Lizenzschlüssel kennen wir nicht. Bitte auf Tippfehler prüfen und den Schlüssel aus der Kaufbestätigung kopieren. Passt er trotzdem nicht, ' + SUPPORT + '.',
  revoked: () => `Dieser Lizenzschlüssel wurde widerrufen oder erstattet und schaltet Enterprise nicht mehr frei. Für einen neuen Schlüssel ${SUPPORT}. Die Community-Edition bleibt nutzbar.`,
  wrong_offer: () => 'Dieser Schlüssel gehört zu einem anderen Angebot, nicht zur Kette. Den Schlüssel aus der Kaufbestätigung der Kette (Solo oder Team) verwenden.',
  device_limit: (body) => `Die Gerätegrenze dieser Lizenz ist erreicht${seatsText(body.seats)}. Ein altes Gerät gibt der Support frei, dafür ${SUPPORT}. Für mehr Geräte gibt es die Team-Lizenz.`,
  rate_limited: () => 'Zu viele Anfragen in kurzer Zeit. Eine Minute warten und dann erneut versuchen.',
  unavailable: () => `Der Lieferdienst kann das Enterprise-Paket gerade nicht bereitstellen. In ein paar Minuten erneut versuchen, bleibt es dabei, ${SUPPORT}. Die Community-Edition bleibt nutzbar.`,
  device_unknown: () => 'Dieses Gerät ist bei der Lizenz noch nicht angemeldet. Zuerst kette login <key> ausführen.',
  ci_token_limit: (body) => `Die Lizenz hat schon ${body.used} von ${body.max} CI-Tokens. Ein altes mit kette token ci revoke <id> widerrufen (Liste: kette token ci list).`,
  expired: () => 'Der Download-Link ist abgelaufen (gültig 15 Minuten). Den Befehl einfach erneut ausführen.',
  not_found: () => `Nicht gefunden. Den Befehl erneut ausführen, bleibt es dabei, ${SUPPORT}.`,
};

export class DeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function errorFor(status, body = {}) {
  const code = body.error || `http_${status}`;
  const text = MESSAGES[code]?.(body) || `Unerwartete Antwort vom Lieferdienst (${status}${body.error ? `, ${body.error}` : ''}). Später erneut versuchen, bleibt es dabei, ${SUPPORT}.`;
  return new DeliveryError(code, text);
}

export function downloadErrorText(err) {
  if (err.checksum) return 'Die Prüfsumme des Enterprise-Pakets stimmt nicht, es wurde nichts installiert. Erneut versuchen, tritt es wieder auf, ' + SUPPORT + '.';
  if (err.status === 410) return 'Der Download-Link ist abgelaufen (gültig 15 Minuten). Den Befehl einfach erneut ausführen, dann gibt es einen neuen Link.';
  if (err.status === 404) return 'Der Download-Link ist ungültig. Den Befehl erneut ausführen, bleibt es dabei, ' + SUPPORT + '.';
  return `Das Enterprise-Paket konnte nicht geladen werden (${err.status || err.message}). Internetverbindung prüfen und erneut versuchen.`;
}

async function call(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new DeliveryError('network', `Lieferdienst nicht erreichbar (${delivery()}: ${err.cause?.code || err.cause?.message || err.message}). Internetverbindung prüfen, hinter einem Proxy oder Spiegel KETTE_DELIVERY setzen.`);
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
    if (!UUID_PATTERN.test(id)) throw new Error(`Geräte-ID in ${file} ist beschädigt. Datei löschen und erneut anmelden, das Gerät zählt dann neu.`);
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
  if (!KEY_PATTERN.test(key || '')) throw new Error(`Zugangsdaten in ${file} sind beschädigt. Mit kette logout entfernen und mit kette login <key> neu anmelden.`);
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
