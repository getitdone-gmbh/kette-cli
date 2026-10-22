import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DeliveryError, FIGMA_PENDING, NPM_PENDING, createCiToken, deviceId, figmaLinks, listCiTokens, readCredentials, registryToken, revokeCiToken, revokeRegistryToken } from './delivery.mjs';
import { readState, writeState } from './manifest.mjs';
import { isSecureUrl, npmUserConfig, registryDefault } from './paths.mjs';
import { cmd, file as fileName, isoDate, status } from './out.mjs';
import { SCOPE, TOKEN_PATTERN, authKey, blockToken, foreignScopeLines, hasBlock, projectScope, readFile, withBlock, withoutBlock } from './npmrc.mjs';
import { othersCanRead, privateHint, writePrivate } from './files.mjs';

const GITHUB_PACKAGES = 'npm.pkg.github.com';
const WARN = status('warn', 'WARN');

// Registry from the last login, otherwise the default
export const registryUrl = () => readState().npm?.registry || registryDefault();
export const scopeLine = (registry = registryUrl()) => `${SCOPE}:registry=${registry}\n`;
// Only after a login with npm access does the project .npmrc point to the Die Kette registry
export const npmGranted = () => Boolean(readState().npm?.registry);

function requireLogin() {
  const creds = readCredentials();
  if (!creds) throw new Error('Not signed in. Run kette login <key> first.');
  return { key: creds.key, device: deviceId() };
}

// Fetch the device token and write it as a marked block into the user npmrc; errors never abort the login
export async function setupNpm(key, opts) {
  if (opts.noNpm) { console.log('npm access skipped (--no-npm).'); return false; }
  const file = npmUserConfig();
  const current = readFile(file);
  const foreign = foreignScopeLines(current);
  if (foreign.length && !opts.npmReplace) {
    console.log(`${WARN} ${fileName(file)} already contains ${foreign.join(', ')}. That line stays unchanged, npm access not set up.`);
    console.log(`     Switch to Die Kette: ${cmd('kette login <key> --npm-replace')} (the old line is commented out, kette logout restores it).`);
    return false;
  }
  let grant;
  try {
    grant = await registryToken({ key, device: deviceId() });
  } catch (err) {
    if (!(err instanceof DeliveryError)) throw err;
    // Registry not set up yet: one line, no npmrc block, kette update catches up later
    if (err.code === 'registry_not_configured') {
      console.log(NPM_PENDING);
      writeState({ npm: { pending: true } });
      return false;
    }
    console.log(`${WARN} npm access not set up: ${err.message}`);
    console.log(`     Set it up later with: ${cmd('kette update')}`);
    return false;
  }
  if (!TOKEN_PATTERN.test(grant.token || '') || !isSecureUrl(grant.registry)) {
    console.log(`${WARN} npm access not set up: incomplete response from the delivery service. Set it up later with: ${cmd('kette update')}`);
    return false;
  }
  writePrivate(file, withBlock(current, grant.registry, grant.token, { replace: opts.npmReplace }));
  writeState({ npm: { registry: grant.registry, file } });
  console.log(`npm access set up: ${SCOPE} via ${new URL(grant.registry).host} (token in ${fileName(file)}).`);
  return true;
}

// Revoke the token (offline is fine) and remove only the kette block
export async function teardownNpm(creds) {
  const file = readState().npm?.file || npmUserConfig();
  if (creds) {
    try { await revokeRegistryToken({ key: creds.key, device: deviceId() }); } catch (err) {
      if (!(err instanceof DeliveryError)) throw err;
      if (err.code !== 'registry_not_configured') console.log(`${WARN} npm token not revoked (${err.message}). The block is removed anyway, the token expires with the license at the latest.`);
    }
  }
  const current = readFile(file);
  if (!hasBlock(current)) return false;
  const next = withoutBlock(current);
  if (next) writePrivate(file, next); else fs.rmSync(file, { force: true });
  console.log(`npm access removed (kette block from ${fileName(file)}).`);
  return true;
}

// 200 ok, 401 invalid, null when the registry is not reachable
export async function whoami(registry, token) {
  try {
    const res = await fetch(`${registry}-/whoami`, { headers: { authorization: `Bearer ${token}` } });
    return res.status;
  } catch {
    return null;
  }
}

// kette update: issue a new token when the block is missing or the registry rejects the token
export async function ensureNpm(key, opts) {
  if (opts.noNpm) return;
  const token = blockToken(readFile(readState().npm?.file || npmUserConfig()));
  if (token && (await whoami(registryUrl(), token)) !== 401) return;
  if (token) console.log('npm token no longer accepted, issuing a new one ...');
  else if (!readState().npm?.pending) console.log('npm access missing, setting it up ...');
  await setupNpm(key, opts);
}

// Lines for kette doctor: block, token valid (not with --ci), project .npmrc, tokens in tracked files
export async function npmChecks(root, { line, warn }, opts) {
  const file = readState().npm?.file || npmUserConfig();
  const token = blockToken(readFile(file));
  if (token) line(true, `npm access in ${fileName(file)}`);
  if (token && othersCanRead(file)) warn(privateHint(file, cmd));
  else if (readState().npm?.pending) warn(NPM_PENDING);
  else warn(`No npm access in ${fileName(file)}. For the design system packages: ${cmd('kette update')} (or ${cmd('kette login <key> --npm-replace')} with your own ${SCOPE} line)`);
  if (token && !opts.ci) {
    const code = await whoami(registryUrl(), token);
    if (code === null) warn(`Registry ${registryUrl()} not reachable, token not checked`);
    else line(code === 200, `npm token valid${code === 200 ? '' : ` (response ${code}, issue a new one with: ${cmd('kette update')})`}`);
  }
  const project = projectScope(readFile(path.join(root, '.npmrc')));
  if (project?.includes(GITHUB_PACKAGES)) warn(`.npmrc in the project points ${SCOPE} to ${GITHUB_PACKAGES}. For Die Kette customers: ${scopeLine().trim()}`);
  const leaked = trackedTokenFiles(root);
  line(leaked.length === 0, leaked.length ? `npm token in files tracked by git: ${leaked.join(', ')}. Revoke the token and clean the file` : 'no npm token in files tracked by git');
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
GitLab and others, in the job before npm ci:
  npm config set ${authKey(registry)}:_authToken "$KETTE_NPM_TOKEN"`;

const dateOf = (iso) => isoDate(iso, 'never');

// kette token ci create <label> | list | revoke <id>
export async function ciToken(action, arg) {
  const auth = requireLogin();
  if (action === 'create') {
    if (!arg) throw new Error('Enter a label, e.g. kette token ci create "GitHub Actions"');
    const t = await createCiToken({ ...auth, label: arg });
    console.log(`CI token "${t.label}" created (ID ${t.id}). It is shown only now:\n\n  ${t.token}\n`);
    console.log(`Store it as the secret KETTE_NPM_TOKEN in the pipeline, never in the repo.\n\n${CI_SNIPPET(t.registry)}`);
    return 0;
  }
  if (action === 'list') {
    const { tokens, max } = await listCiTokens(auth);
    console.log(`CI tokens: ${tokens.length} of ${max}`);
    for (const t of tokens) console.log(`  ${t.id}  ${t.prefix}...  ${t.label}  created ${dateOf(t.created_at)}, last used ${dateOf(t.last_used_at)}`);
    return 0;
  }
  if (action === 'revoke') {
    if (!arg) throw new Error('Enter an ID, kette token ci list shows the IDs');
    const { revoked } = await revokeCiToken({ ...auth, id: arg });
    console.log(revoked ? `CI token ${arg} revoked.` : `No active CI token with ID ${arg} (already revoked or unknown).`);
    return 0;
  }
  throw new Error('Usage: kette token ci create <label> | list | revoke <id>');
}

const IMPORT_ORDER = [
  'Import Design-Tokens.fig and publish it as a library in your own team.',
  'Import GetITDone-Basic.fig, point the missing library to your own Design-Tokens copy with "Swap library", publish.',
  'Import zero.fig, swap both libraries, publish.',
  'Import the product and area files and swap the libraries.',
];

async function downloadChecked(file, target) {
  if (!isSecureUrl(file.url)) throw new DeliveryError('bad_response', `${file.name} has no https download link. Run the command again, if it persists contact support.`);
  const res = await fetch(file.url);
  if (!res.ok) throw new DeliveryError(`http_${res.status}`, `${file.name} could not be downloaded (${res.status}). Run the command again, the links are valid for 15 minutes.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== file.sha256) throw new DeliveryError('checksum', `The checksum of ${file.name} does not match. Run the command again.`);
  fs.writeFileSync(target, buf);
}

// kette figma [--out folder]: download the current Figma release, verify checksums, show the import order
export async function figma(opts) {
  const { key } = requireLogin();
  let release;
  try {
    release = await figmaLinks({ key });
  } catch (err) {
    if (err.code !== 'figma_not_configured') throw err;
    console.log(FIGMA_PENDING);
    return 0;
  }
  const dir = path.resolve(opts.out || `kette-figma-${release.version}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Figma release ${release.version} (updates until ${dateOf(release.updates_until)}), ${release.files.length} files to ${fileName(dir)}`);
  for (const file of release.files) {
    const target = path.join(dir, path.basename(file.name));
    await downloadChecked(file, target);
    console.log(`  ${file.title} (${file.name}, ${(file.size / 1048576).toFixed(1)} MB)`);
  }
  console.log('\nImport in Figma (File > Import, keep this order):');
  IMPORT_ORDER.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log('Linked libraries need a Figma team plan that can publish team libraries (Professional or higher).');
  return 0;
}
