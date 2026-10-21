import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DeliveryError, createCiToken, deviceId, figmaLinks, listCiTokens, readCredentials, registryToken, revokeCiToken, revokeRegistryToken } from './delivery.mjs';
import { readState, writeState } from './manifest.mjs';
import { npmUserConfig, registryDefault } from './paths.mjs';
import { SCOPE, TOKEN_PATTERN, authKey, blockToken, foreignScopeLines, hasBlock, projectScope, readFile, withBlock, withoutBlock, writePrivate } from './npmrc.mjs';

const GITHUB_PACKAGES = 'npm.pkg.github.com';

// Registry aus dem letzten Login, sonst der Standard
export const registryUrl = () => readState().npm?.registry || registryDefault();
export const scopeLine = (registry = registryUrl()) => `${SCOPE}:registry=${registry}\n`;

function requireLogin() {
  const creds = readCredentials();
  if (!creds) throw new Error('Nicht angemeldet. Zuerst kette login <key> ausführen.');
  return { key: creds.key, device: deviceId() };
}

// Gerätetoken holen und als markierten Block in die Benutzer-npmrc schreiben; Fehler brechen den Login nicht ab
export async function setupNpm(key, opts) {
  if (opts.noNpm) { console.log('npm-Zugang übersprungen (--no-npm).'); return false; }
  const file = npmUserConfig();
  const current = readFile(file);
  const foreign = foreignScopeLines(current);
  if (foreign.length && !opts.npmReplace) {
    console.log(`HINW  ${file} enthält schon ${foreign.join(', ')}. Diese Zeile bleibt unverändert, npm-Zugang nicht eingerichtet.`);
    console.log('      Auf die Kette umstellen: kette login <key> --npm-replace (die alte Zeile wird auskommentiert, kette logout stellt sie wieder her).');
    return false;
  }
  let grant;
  try {
    grant = await registryToken({ key, device: deviceId() });
  } catch (err) {
    if (!(err instanceof DeliveryError)) throw err;
    console.log(`HINW  npm-Zugang nicht eingerichtet: ${err.message}`);
    console.log('      Später nachholen mit: kette update');
    return false;
  }
  if (!TOKEN_PATTERN.test(grant.token || '') || !/^https?:\/\//.test(grant.registry || '')) {
    console.log('HINW  npm-Zugang nicht eingerichtet: unvollständige Antwort vom Lieferdienst. Später nachholen mit: kette update');
    return false;
  }
  writePrivate(file, withBlock(current, grant.registry, grant.token, { replace: opts.npmReplace }));
  writeState({ npm: { registry: grant.registry, file } });
  console.log(`npm-Zugang eingerichtet: ${SCOPE} über ${new URL(grant.registry).host} (Token in ${file}).`);
  return true;
}

// Token widerrufen (offline egal) und nur den Kette-Block entfernen
export async function teardownNpm(creds) {
  const file = readState().npm?.file || npmUserConfig();
  if (creds) {
    try { await revokeRegistryToken({ key: creds.key, device: deviceId() }); } catch (err) {
      if (!(err instanceof DeliveryError)) throw err;
      console.log(`HINW  npm-Token nicht widerrufen (${err.message}). Der Block wird trotzdem entfernt, das Token verfällt spätestens mit der Lizenz.`);
    }
  }
  const current = readFile(file);
  if (!hasBlock(current)) return false;
  const next = withoutBlock(current);
  if (next) writePrivate(file, next); else fs.rmSync(file, { force: true });
  console.log(`npm-Zugang entfernt (Kette-Block aus ${file}).`);
  return true;
}

// 200 ok, 401 ungültig, null wenn die Registry nicht erreichbar ist
export async function whoami(registry, token) {
  try {
    const res = await fetch(`${registry}-/whoami`, { headers: { authorization: `Bearer ${token}` } });
    return res.status;
  } catch {
    return null;
  }
}

// kette update: fehlt der Block oder lehnt die Registry das Token ab, wird neu ausgestellt
export async function ensureNpm(key, opts) {
  if (opts.noNpm) return;
  const token = blockToken(readFile(readState().npm?.file || npmUserConfig()));
  if (token && (await whoami(registryUrl(), token)) !== 401) return;
  console.log(token ? 'npm-Token wird nicht mehr angenommen, stelle ein neues aus ...' : 'npm-Zugang fehlt, richte ihn ein ...');
  await setupNpm(key, opts);
}

// Zeilen für kette doctor: Block, Token gültig (nicht mit --ci), Projekt-.npmrc, Token in Git-Dateien
export async function npmChecks(root, { line, warn }, opts) {
  const file = readState().npm?.file || npmUserConfig();
  const token = blockToken(readFile(file));
  if (token) line(true, `npm-Zugang in ${file}`);
  else warn(`Kein npm-Zugang in ${file}. Für die Design-System-Pakete: kette update (oder kette login <key> --npm-replace bei eigener ${SCOPE}-Zeile)`);
  if (token && !opts.ci) {
    const status = await whoami(registryUrl(), token);
    if (status === null) warn(`Registry ${registryUrl()} nicht erreichbar, Token nicht geprüft`);
    else line(status === 200, `npm-Token gültig${status === 200 ? '' : ` (Antwort ${status}, neu ausstellen mit: kette update)`}`);
  }
  const project = projectScope(readFile(path.join(root, '.npmrc')));
  if (project?.includes(GITHUB_PACKAGES)) warn(`.npmrc im Projekt zeigt ${SCOPE} auf ${GITHUB_PACKAGES}. Für Käufer der Kette: ${scopeLine().trim()}`);
  const leaked = trackedTokenFiles(root);
  line(leaked.length === 0, leaked.length ? `npm-Token in Dateien im Git: ${leaked.join(', ')}. Token widerrufen und Datei bereinigen` : 'kein npm-Token in Dateien im Git');
}

function trackedTokenFiles(root) {
  const r = spawnSync('git', ['-C', root, 'grep', '-l', '-I', '-E', TOKEN_PATTERN.source], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
}

const CI_SNIPPET = (registry) => `GitHub Actions:
  - uses: actions/setup-node@v4
    with: { node-version: 22, registry-url: ${registry}, scope: '${SCOPE}' }
  - run: npm ci
    env: { NODE_AUTH_TOKEN: \${{ secrets.KETTE_NPM_TOKEN }} }
GitLab und andere, im Job vor npm ci:
  npm config set ${authKey(registry)}:_authToken "$KETTE_NPM_TOKEN"`;

const dateOf = (iso) => (iso ? new Date(iso).toLocaleDateString('de-DE', { timeZone: 'UTC' }) : 'nie');

// kette token ci create <label> | list | revoke <id>
export async function ciToken(action, arg) {
  const auth = requireLogin();
  if (action === 'create') {
    if (!arg) throw new Error('Bezeichnung angeben, z. B. kette token ci create "GitHub Actions"');
    const t = await createCiToken({ ...auth, label: arg });
    console.log(`CI-Token "${t.label}" erstellt (ID ${t.id}). Es wird nur jetzt angezeigt:\n\n  ${t.token}\n`);
    console.log(`Als Secret KETTE_NPM_TOKEN in der Pipeline hinterlegen, nie ins Repo schreiben.\n\n${CI_SNIPPET(t.registry)}`);
    return 0;
  }
  if (action === 'list') {
    const { tokens, max } = await listCiTokens(auth);
    console.log(`CI-Tokens: ${tokens.length} von ${max}`);
    for (const t of tokens) console.log(`  ${t.id}  ${t.prefix}...  ${t.label}  erstellt ${dateOf(t.created_at)}, zuletzt genutzt ${dateOf(t.last_used_at)}`);
    return 0;
  }
  if (action === 'revoke') {
    if (!arg) throw new Error('ID angeben, die IDs zeigt kette token ci list');
    const { revoked } = await revokeCiToken({ ...auth, id: arg });
    console.log(revoked ? `CI-Token ${arg} widerrufen.` : `Kein aktives CI-Token mit der ID ${arg} (schon widerrufen oder unbekannt).`);
    return 0;
  }
  throw new Error('Aufruf: kette token ci create <bezeichnung> | list | revoke <id>');
}

const IMPORT_ORDER = [
  'Design-Tokens.fig importieren und im eigenen Team als Bibliothek veröffentlichen.',
  'GetITDone-Basic.fig importieren, die fehlende Bibliothek per "Swap library" auf die eigene Design-Tokens-Kopie umstellen, veröffentlichen.',
  'zero.fig importieren, beide Bibliotheken umstellen, veröffentlichen.',
  'Produkt- und Bereichsdateien importieren und die Bibliotheken umstellen.',
];

async function downloadChecked(file, target) {
  const res = await fetch(file.url);
  if (!res.ok) throw new DeliveryError(`http_${res.status}`, `${file.name} konnte nicht geladen werden (${res.status}). Den Befehl erneut ausführen, die Links gelten 15 Minuten.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== file.sha256) throw new DeliveryError('checksum', `Die Prüfsumme von ${file.name} stimmt nicht. Den Befehl erneut ausführen.`);
  fs.writeFileSync(target, buf);
}

// kette figma [--out ordner]: aktuelles Figma-Release laden, Prüfsummen prüfen, Import-Reihenfolge zeigen
export async function figma(opts) {
  const { key } = requireLogin();
  const release = await figmaLinks({ key });
  const dir = path.resolve(opts.out || `kette-figma-${release.version}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Figma-Release ${release.version} (Updates bis ${dateOf(release.updates_until)}), ${release.files.length} Dateien nach ${dir}`);
  for (const file of release.files) {
    const target = path.join(dir, path.basename(file.name));
    await downloadChecked(file, target);
    console.log(`  ${file.title} (${file.name}, ${(file.size / 1048576).toFixed(1)} MB)`);
  }
  console.log('\nImport in Figma (Datei > Import, Reihenfolge einhalten):');
  IMPORT_ORDER.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log('Verknüpfte Bibliotheken brauchen im Figma-Team einen Plan, der Team-Bibliotheken veröffentlichen kann (Professional oder höher).');
  return 0;
}
