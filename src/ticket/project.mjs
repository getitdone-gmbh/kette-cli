import fs from 'node:fs';
import { ENTERPRISE } from '../editions.mjs';
import { installedBundle } from '../manifest.mjs';
import { ExitError } from '../errors.mjs';
import { cmd } from '../out.mjs';
import { secureUrl } from '../paths.mjs';
import { inherit } from '../instance/config.mjs';
import { requireEdition } from '../instance/command.mjs';
import { readWallet } from '../wallet/config.mjs';
import { isTrusted } from '../wallet/command.mjs';
import { providerFor, ProviderError } from '../wallet/providers.mjs';
import { WORKLOAD_ZERO, tokenNameOf, usageLines } from './adapters.mjs';
export const ENTERPRISE_ONLY = 'Ticketing is part of Kette Enterprise (Die Kette). Setup: https://kette.itdone.de/einrichten#ticketing';

// The project in a folder, everything from its scope: profile, its instance, the effective settings and the Enterprise bundle;
// every gate fails closed before anything is read from a board or written
export function ticketProject(root, { resolveProject }) {
  let project;
  try { project = resolveProject(root); } catch (err) { throw new ExitError(`.kette/profile.json is not readable (${err.message}).`, 1); }
  if (!project.profile) throw new ExitError(`No kette project in this folder. ${ENTERPRISE_ONLY}`, 1);
  if (project.problem) throw new ExitError(`${project.problem}. Ticketing stays off until the Kette project can be used.`, 1);
  if (project.edition !== ENTERPRISE) throw new ExitError(`${ENTERPRISE_ONLY}${project.instance ? ` Kette project ${project.instance.name} is Community.` : ''}`, 1);
  if (!project.instance) throw new ExitError(`Ticketing is set per Kette project and this repo has none. Join one with ${cmd('kette project use <name>')} (new: ${cmd('kette project create <name>')}).`, 1);
  requireEdition(project.instance);
  const bundle = installedBundle(ENTERPRISE);
  if (!bundle) throw new ExitError(`The Enterprise bundle is not on this machine. Load it with: ${cmd('kette update')}`, 1);
  const effective = inherit(project.profile, project.instance);
  return { root, instance: project.instance, effective, bundleDir: bundle.dir };
}

// What the library gets: the instance's ticketing, stations, members and repos, nothing from a global file
export function contextOf(project) {
  const { instance, effective } = project;
  return { instance: instance.name, ticketing: effective.ticketing, stations: effective.stations, members: instance.members, repos: instance.repos.map((r) => r.name) };
}

export function requireBoard(project, lib) {
  if (project.effective.ticketing) return project.effective.ticketing;
  throw new ExitError(`Kette project ${project.instance.name} has no ticket board yet. Connect one with:\n${usageLines(lib).map((l) => `  ${cmd(l)}`).join('\n')}`, 1);
}

// Another board API for tests, for every adapter; always https (http only locally), the library applies its address rules too; undefined is the default
export const apiUrl = () => (process.env.KETTE_TICKETING_API ? secureUrl(process.env.KETTE_TICKETING_API.replace(/\/+$/, ''), 'KETTE_TICKETING_API') : undefined);

// Wallet environment for the board credential: --env, the instance default, dev, or the first environment of the wallet
const walletEnv = (wallet, instance, opts) => opts.env || (instance.wallet?.env && wallet.environments.includes(instance.wallet.env) ? instance.wallet.env : wallet.environments.includes('dev') ? 'dev' : wallet.environments[0]);

const missing = (name, token, extra = '') => new ExitError(`No access to the ticket board of Kette project ${name}.${extra} Declare the credential with ${cmd(`kette wallet add ${token} --note "ticket board"`)} and store it with ${cmd(`kette wallet set ${token} --env dev`)}. kette never prints it.`, 1);

// The board credential under its adapter's name: the wallet, or the Workbase session file for a workload.zero board that enables it (KETTE-28)
export async function boardToken(project, opts, lib) {
  const { root, instance } = project;
  const board = project.effective.ticketing;
  const tokenName = tokenNameOf(lib, board?.adapter);
  let wallet = null;
  try { wallet = readWallet(root); } catch (err) { throw new ExitError(err.message, 1); }
  if (wallet?.secrets.some((s) => s.name === tokenName)) {
    if (!isTrusted(root, wallet)) throw new ExitError(`This machine has not confirmed the wallet provider yet. Run ${cmd('kette wallet trust')} first.`, 1);
    const env = walletEnv(wallet, instance, opts);
    let values;
    try { values = await providerFor(wallet.provider).read(env, [tokenName]); } catch (err) { throw new ExitError(err instanceof ProviderError ? err.message : String(err.message), 1); }
    const value = values.get(tokenName);
    if (value) return { token: value, refresh: null };
    throw missing(instance.name, tokenName, ` ${tokenName} has no value in ${env}.`);
  }
  // The shared session file holds a Workbase session, so it never stands in for the token of another system
  const config = lib.sessionConfigFromEnv();
  if (board?.session === true && lib.adapterId(board.adapter) === WORKLOAD_ZERO && fs.existsSync(config.file)) {
    const token = await lib.sessionAccessToken(config).catch((err) => { throw new ExitError(err.message, 1); });
    return { token, refresh: () => lib.sessionAccessToken({ ...config, force: true }) };
  }
  throw missing(instance.name, tokenName, wallet ? '' : ` This project has no secret wallet yet, create it with ${cmd('kette wallet init')}.`);
}
