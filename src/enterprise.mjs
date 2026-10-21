import fs from 'node:fs';
import path from 'node:path';
import { COMMUNITY, ENTERPRISE, editionLabel, retiredPlugins, isNewer } from './editions.mjs';
import { DeliveryError, KEY_PATTERN, deviceId, downloadErrorText, latest, readCredentials, removeCredentials, requestToken, writeCredentials } from './delivery.mjs';
import { DownloadError, fetchManifest, installEntry, installedBundle, readState, removeState, setActiveBundle, writeState } from './manifest.mjs';
import { editionHints, hasClaude, installEdition, pluginId, uninstallPlugin } from './claude.mjs';
import { bundlesDir, credentialsFile, delivery } from './paths.mjs';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

export const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('de-DE', { timeZone: 'UTC' }) : 'unbekannt');

// none, valid oder broken; eine beschädigte Datei schaltet nichts frei, doctor meldet sie
export function credentialsStatus() {
  if (!fs.existsSync(credentialsFile())) return 'none';
  try { readCredentials(); return 'valid'; } catch { return 'broken'; }
}

export const tierOf = () => (credentialsStatus() === 'valid' && installedBundle(ENTERPRISE) ? ENTERPRISE : COMMUNITY);
export const loginState = () => readState().login || null;

async function grant(key, cli) {
  const g = await requestToken({ key, device: deviceId(), cli });
  if (!g.url || !g.sha256 || !VERSION_PATTERN.test(g.version || '')) {
    throw new DeliveryError('bad_response', 'Der Lieferdienst hat eine unvollständige Antwort geschickt. Später erneut versuchen, bleibt es dabei, den Support kontaktieren.');
  }
  return g;
}

async function install(g) {
  let dir;
  try {
    dir = await installEntry(ENTERPRISE, g.version, { url: g.url, sha256: g.sha256 });
  } catch (err) {
    if (err instanceof DownloadError) throw new DeliveryError(err.checksum ? 'checksum' : 'download', downloadErrorText(err));
    throw err;
  }
  writeState({ login: { edition: ENTERPRISE, version: g.version, updates_until: g.updates_until || null, seats: g.seats || null, checked_at: new Date().toISOString() } });
  return dir;
}

function plugins(dir, opts) {
  if (opts.noPlugins) return;
  const link = setActiveBundle(dir);
  const r = installEdition(link, ENTERPRISE, retiredPlugins(COMMUNITY, ENTERPRISE));
  if (r.ok) console.log(`Claude-Code-Plugins installiert: ${r.present.join(', ')}`);
  for (const l of editionHints(r, link)) console.log(l);
}

export async function login(rawKey, opts, cli) {
  const key = (rawKey || '').trim().toUpperCase();
  if (!KEY_PATTERN.test(key)) throw new Error('Lizenzschlüssel im Format CDP-XXXXX-XXXXX-XXXXX-XXXXX angeben, z. B. kette login CDP-AB12C-...');
  console.log(`Prüfe Lizenz bei ${delivery()} ...`);
  const g = await grant(key, cli);
  // Erst nach erfolgreicher Prüfung speichern; scheitert der Download, holt kette update das Paket nach
  writeCredentials(key);
  console.log(`Lade ${editionLabel(ENTERPRISE)} ${g.version} ...`);
  const dir = await install(g);
  plugins(dir, opts);
  const seats = g.seats?.max ? `, Geräte ${g.seats.used} von ${g.seats.max}` : '';
  console.log(`\nAngemeldet: ${editionLabel(ENTERPRISE)}, Version ${g.version}, Updates bis ${formatDate(g.updates_until)}${seats}.`);
  console.log('Bestehende Projekte bekommen die Enterprise-Vorlagen und den Ablauf mit Agenten und Gates mit: kette add');
  return 0;
}

export function logout(opts) {
  if (credentialsStatus() === 'none' && !installedBundle(ENTERPRISE)) { console.log('Nicht angemeldet, nichts zu tun.'); return 0; }
  const claude = !opts.noPlugins && hasClaude();
  // Erst die Enterprise-Plugins entfernen, solange der Marketplace noch auf das Enterprise-Paket zeigt
  if (claude) {
    for (const name of retiredPlugins(ENTERPRISE, COMMUNITY)) {
      const r = uninstallPlugin(name);
      if (!r.ok) console.log(`Plugin ${name} nicht entfernt (${r.reason}). Von Hand: claude plugin uninstall ${pluginId(name)}`);
    }
  }
  removeCredentials();
  fs.rmSync(path.join(bundlesDir(), ENTERPRISE), { recursive: true, force: true });
  removeState([`bundle_${ENTERPRISE}`, 'login']);
  const community = installedBundle(COMMUNITY);
  const link = setActiveBundle(community?.dir || null);
  if (claude && link) for (const l of editionHints(installEdition(link, COMMUNITY), link)) console.log(l);
  console.log('Abgemeldet. Lizenzschlüssel und Enterprise-Paket sind von diesem Rechner entfernt.');
  console.log('Das Gerät bleibt bei der Lizenz registriert, freigeben kann es der Support. Ein erneuter kette login auf diesem Rechner belegt kein weiteres Gerät.');
  if (!community) console.log('Die Community-Edition lädt: kette update');
  return 0;
}

async function cliHint(cli) {
  try {
    const m = await fetchManifest();
    if (m.cli && isNewer(m.cli.version, cli)) console.log(`Neue CLI ${m.cli.version} verfügbar: curl -fsSL https://kette.itdone.de/install | sh`);
  } catch (err) {
    console.log(`HINW  CLI-Version nicht geprüft (${err.message})`);
  }
}

export async function updateEnterprise(opts, cli) {
  const { key } = readCredentials();
  const info = await latest({ key, device: deviceId() });
  const have = installedBundle(ENTERPRISE);
  const state = loginState() || { edition: ENTERPRISE };
  writeState({ login: { ...state, updates_until: info.updates_until || state.updates_until || null, checked_at: new Date().toISOString() } });
  if (info.version && info.available && info.version !== info.available) {
    console.log(`Version ${info.version} ist erschienen, der Update-Zeitraum dieser Lizenz endete am ${formatDate(info.updates_until)}. Installierbar bleibt ${info.available}, für neuere Versionen die Lizenz verlängern.`);
  }
  if (have && have.version === info.available) { console.log(`Aktuell (${editionLabel(ENTERPRISE)} ${have.version}).`); await cliHint(cli); return 0; }
  console.log(`Neue ${editionLabel(ENTERPRISE)}-Version ${info.available}${have ? ` (installiert: ${have.version})` : ''}.`);
  if (info.changelog) console.log(info.changelog);
  if (opts.dryRun) return 0;
  const dir = await install(await grant(key, cli));
  plugins(dir, opts);
  await cliHint(cli);
  console.log(`${editionLabel(ENTERPRISE)} ${readState().login.version} installiert.`);
  return 0;
}
