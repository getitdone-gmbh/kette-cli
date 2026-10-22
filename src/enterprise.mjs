import fs from 'node:fs';
import path from 'node:path';
import { COMMUNITY, ENTERPRISE, editionLabel, retiredPlugins, isNewer } from './editions.mjs';
import { DeliveryError, KEY_PATTERN, deviceId, downloadErrorText, latest, readCredentials, removeCredentials, requestToken, writeCredentials } from './delivery.mjs';
import { DownloadError, fetchManifest, installEntry, installedBundle, readState, removeState, setActiveBundle, validVersion, writeState } from './manifest.mjs';
import { editionHints, hasClaude, installEdition, pluginId, uninstallPlugin } from './claude.mjs';
import { bundlesDir, credentialsFile, delivery } from './paths.mjs';
import { ensureNpm, setupNpm, teardownNpm } from './npm-access.mjs';
import { cmd, isoDate, status } from './out.mjs';

export const formatDate = (iso) => isoDate(iso, 'unknown');
export const installCommand = () => `${cmd('curl -fsSL https://kette.itdone.de/install | sh')} (Windows: ${cmd('irm https://kette.itdone.de/install.ps1 | iex')})`;
export const newCliHint = (version) => `New CLI ${version} available: ${installCommand()}`;

// none, valid or broken; a damaged file unlocks nothing, doctor reports it
export function credentialsStatus() {
  if (!fs.existsSync(credentialsFile())) return 'none';
  try { readCredentials(); return 'valid'; } catch { return 'broken'; }
}

export const tierOf = () => (credentialsStatus() === 'valid' && installedBundle(ENTERPRISE) ? ENTERPRISE : COMMUNITY);
export const loginState = () => readState().login || null;

async function grant(key, cli) {
  const g = await requestToken({ key, device: deviceId(), cli });
  if (!g.url || !g.sha256 || !validVersion(g.version)) {
    throw new DeliveryError('bad_response', 'The delivery service sent an incomplete response. Try again later, if it persists contact support.');
  }
  return g;
}

async function install(g) {
  let dir;
  try {
    dir = await installEntry(ENTERPRISE, g.version, { url: g.url, sha256: g.sha256 }, { anyHost: true });
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
  if (r.ok) console.log(`Claude Code plugins installed: ${r.present.join(', ')}`);
  for (const l of editionHints(r, link)) console.log(l);
}

export async function login(rawKey, opts, cli) {
  const key = (rawKey || '').trim().toUpperCase();
  if (!KEY_PATTERN.test(key)) throw new Error('Enter the license key in the format CDP-XXXXX-XXXXX-XXXXX-XXXXX, e.g. kette login CDP-AB12C-...');
  console.log(`Checking license with ${delivery()} ...`);
  const g = await grant(key, cli);
  // Save only after a successful check; if the download fails, kette update fetches the bundle later
  writeCredentials(key);
  console.log(`Loading ${editionLabel(ENTERPRISE)} ${g.version} ...`);
  const dir = await install(g);
  plugins(dir, opts);
  // After /install/token, because that is where the device gets registered
  await setupNpm(key, opts);
  const seats = g.seats?.max ? `, devices ${g.seats.used} of ${g.seats.max}` : '';
  console.log(`\nSigned in: ${editionLabel(ENTERPRISE)}, version ${g.version}, updates until ${formatDate(g.updates_until)}${seats}.`);
  console.log(`Existing projects get the Enterprise templates and the flow with agents and gates with: ${cmd('kette add')}`);
  return 0;
}

export async function logout(opts) {
  if (credentialsStatus() === 'none' && !installedBundle(ENTERPRISE)) {
    if (!(await teardownNpm(null))) console.log('Not signed in, nothing to do.');
    return 0;
  }
  // While the key is still there: revoke the npm token, then remove only the kette block
  await teardownNpm(credentialsStatus() === 'valid' ? readCredentials() : null);
  const claude = !opts.noPlugins && hasClaude();
  // Remove the Enterprise plugins first, while the marketplace still points to the Enterprise bundle
  if (claude) {
    for (const name of retiredPlugins(ENTERPRISE, COMMUNITY)) {
      const r = uninstallPlugin(name);
      if (!r.ok) console.log(`Plugin ${name} not removed (${r.reason}). By hand: ${cmd(`claude plugin uninstall ${pluginId(name)}`)}`);
    }
  }
  removeCredentials();
  fs.rmSync(path.join(bundlesDir(), ENTERPRISE), { recursive: true, force: true });
  removeState([`bundle_${ENTERPRISE}`, 'login']);
  const community = installedBundle(COMMUNITY);
  const link = setActiveBundle(community?.dir || null);
  if (claude && link) for (const l of editionHints(installEdition(link, COMMUNITY), link)) console.log(l);
  console.log('Signed out. License key and Enterprise bundle are removed from this machine.');
  console.log('The device stays registered with the license, support can release it. Signing in again on this machine does not take another device seat.');
  if (!community) console.log(`Load the Community edition with: ${cmd('kette update')}`);
  return 0;
}

async function cliHint(cli) {
  try {
    const m = await fetchManifest();
    if (m.cli && isNewer(m.cli.version, cli)) console.log(newCliHint(m.cli.version));
  } catch (err) {
    console.log(`${status('warn', 'WARN')} CLI version not checked (${err.message})`);
  }
}

export async function updateEnterprise(opts, cli) {
  const { key } = readCredentials();
  const info = await latest({ key, device: deviceId() });
  const have = installedBundle(ENTERPRISE);
  const state = loginState() || { edition: ENTERPRISE };
  writeState({ login: { ...state, updates_until: info.updates_until || state.updates_until || null, checked_at: new Date().toISOString() } });
  if (info.version && info.available && info.version !== info.available) {
    console.log(`Version ${info.version} is out, the update period of this license ended on ${formatDate(info.updates_until)}. ${info.available} stays installable, renew the license for newer versions.`);
  }
  if (have && have.version === info.available) {
    console.log(`Up to date (${editionLabel(ENTERPRISE)} ${have.version}).`);
    if (!opts.dryRun) await ensureNpm(key, opts);
    await cliHint(cli);
    return 0;
  }
  console.log(`New ${editionLabel(ENTERPRISE)} version ${info.available}${have ? ` (installed: ${have.version})` : ''}.`);
  if (info.changelog) console.log(info.changelog);
  if (opts.dryRun) return 0;
  const dir = await install(await grant(key, cli));
  plugins(dir, opts);
  await ensureNpm(key, opts);
  await cliHint(cli);
  console.log(`${editionLabel(ENTERPRISE)} ${readState().login.version} installed.`);
  return 0;
}
