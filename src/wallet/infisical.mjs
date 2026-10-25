import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ask, choose, confirm } from '../prompt.mjs';
import { cmd, dim, status } from '../out.mjs';
import { ExitError } from '../errors.mjs';
import { isSecureUrl } from '../paths.mjs';
import { providerVersion, spawnTool } from './providers.mjs';

// Guided setup for the default provider: CLI present, region, signed in, project picked through infisical init (.infisical.json)
export const REGIONS = [
  { value: 'https://eu.infisical.com', label: 'Infisical Cloud EU (eu.infisical.com)' },
  { value: '', label: 'Infisical Cloud US (app.infisical.com)' },
  { value: 'own', label: 'Your own Infisical instance' },
];
export const INSTALL_LINES = [
  'macOS: brew install infisical/get-cli/infisical',
  'Linux, Windows: https://infisical.com/docs/cli/overview',
];

const line = (kind, text) => console.log(`${status(kind, { ok: 'OK  ', warn: 'WARN', info: 'INFO' }[kind])} ${text}`);
const domainArgs = (domain) => (domain ? ['--domain', domain] : []);

// workspaceId from .infisical.json, the file infisical init writes; null when missing or unreadable
export function linkedProject(root) {
  try {
    const id = JSON.parse(fs.readFileSync(path.join(root, '.infisical.json'), 'utf8')).workspaceId;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

// A machine identity token counts as signed in; otherwise the user session of the CLI for this domain
export function signedIn(domain, env = process.env) {
  if (env.INFISICAL_TOKEN) return true;
  return spawnTool('infisical', ['user', 'get', 'token', '--plain', '--silent', ...domainArgs(domain)]).status === 0;
}

// Interactive Infisical steps run with the terminal of the person, kette only starts them
const interactive = (args, cwd) => spawnSync('infisical', args, { stdio: 'inherit', cwd }).status === 0;

async function chooseDomain() {
  const [value = REGIONS[0].value] = await choose('Which Infisical?', REGIONS, '1');
  if (value !== 'own') return value;
  for (let i = 0; i < 3; i++) {
    const url = (await ask('Address of your instance, e.g. https://secrets.example.com')).replace(/\/$/, '');
    if (isSecureUrl(url)) return url;
    console.log('  An https address is needed.');
  }
  throw new ExitError('No valid address for the Infisical instance.', 1);
}

export async function setupInfisical(root) {
  if (!providerVersion({ id: 'infisical' })) {
    console.log(`The Infisical CLI is not installed. Install it, then run ${cmd('kette wallet init')} again:`);
    for (const l of INSTALL_LINES) console.log(`  ${l}`);
    console.log(dim(`Another wallet instead: ${cmd('kette wallet init --provider vault|aws-secrets-manager|azure-key-vault|command')}`));
    throw new ExitError('Infisical CLI missing.', 1);
  }
  const domain = await chooseDomain();
  if (!signedIn(domain)) {
    if (!(await confirm('Not signed in to Infisical yet. Sign in now? (infisical login opens the browser)'))) throw new ExitError(`Sign in with ${cmd(`infisical login${domain ? ` --domain ${domain}` : ''}`)}, then run ${cmd('kette wallet init')} again.`, 1);
    if (!interactive(['login', ...domainArgs(domain)], root) || !signedIn(domain)) throw new ExitError('Infisical sign-in did not finish.', 1);
  }
  line('ok', 'Signed in to Infisical');
  let project = linkedProject(root);
  if (project) line('ok', `Infisical project from .infisical.json: ${project}`);
  else if (await confirm('Choose the Infisical project now? (infisical init lists your organisations and projects)')) {
    interactive(['init', ...domainArgs(domain)], root);
    project = linkedProject(root);
    if (project) line('ok', `Infisical project chosen: ${project} ${dim('(.infisical.json, commit it with the wallet)')}`);
  }
  if (!project) project = await ask('Infisical project ID (Project settings, copy the ID)');
  if (!project) throw new ExitError('The Infisical project is needed.', 1);
  return { id: 'infisical', project, ...(domain ? { domain } : {}) };
}
