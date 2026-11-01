import { ExitError } from '../errors.mjs';
import { readState, updateState } from '../manifest.mjs';
import { confirm } from '../prompt.mjs';
import { cmd, status } from '../out.mjs';
import { printable } from '../instance/config.mjs';
import { contextOf } from './project.mjs';

// A host in the shared instance.json would get every member's token: each machine sends it only to a host a person here confirmed (CR-HOST-1)

// The host to confirm as ticketingHost names it (URL.host) when it asks for confirm; a bundle from before kette-ticketing PR #12: every ticketing.host
export function boardHost(lib, project) {
  const block = project.effective.ticketing;
  if (!block) return null;
  const adapter = lib.adapterId(block.adapter);
  if (typeof lib.ticketingHost === 'function') {
    const info = lib.ticketingHost(contextOf(project));
    return info.confirm ? { adapter, host: info.host } : null;
  }
  if (!block.host) return null;
  const raw = String(block.host).trim();
  return { adapter, host: new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).host.toLowerCase() };
}

// The confirmation holds for this host with this credential: another host, port or credential asks again
const record = (h, tokenName) => `${h.adapter} ${tokenName} ${h.host}`;
const shown = (h) => printable(`${h.adapter} ${h.host}`);
export function hostTrusted(lib, project, tokenName) {
  const h = boardHost(lib, project);
  return !h || readState().board_trust?.[project.instance.name] === record(h, tokenName);
}
// For openProject, exactly as ticketingHost named it; undefined when nothing was confirmed or nothing needs it
export const confirmedHost = (lib, project, tokenName) => { const h = boardHost(lib, project); return h && hostTrusted(lib, project, tokenName) ? h.host : undefined; };

const agentOrNoTerminal = () => process.env.CLAUDECODE === '1' || !process.stdin.isTTY;

// Before any token is read: a host this machine has not confirmed stops the command
export function requireTrustedHost(lib, project, tokenName) {
  if (hostTrusted(lib, project, tokenName)) return;
  throw new ExitError(`Kette project ${project.instance.name} sends ${tokenName} to ${shown(boardHost(lib, project))}, which this machine has not confirmed (new or changed in instance.json). Check it, then confirm it yourself in a terminal with: ${cmd('kette ticket host trust')}. Nothing was sent.`, 1);
}

// The confirmation of a person at a terminal, never of an agent or CI, and --yes never skips it
export async function trustHost(lib, project, tokenName) {
  const h = boardHost(lib, project);
  if (!h) { console.log(`Kette project ${project.instance.name} uses the public API of its ticket system, nothing to confirm.`); return 0; }
  if (hostTrusted(lib, project, tokenName)) { console.log(`${status('ok', 'OK  ')} ${shown(h)} is confirmed on this machine already.`); return 0; }
  if (agentOrNoTerminal()) throw new ExitError(`Confirming the board host ${shown(h)} needs a person at a terminal: run ${cmd('kette ticket host trust')} yourself, not through an agent or CI. Nothing changed.`, 1);
  if (!(await confirm(`Send ${tokenName} of this machine to ${shown(h)} for Kette project ${project.instance.name}?`))) throw new ExitError('Not confirmed, nothing changed.', 1);
  updateState((state) => ({ ...state, board_trust: { ...(state.board_trust || {}), [project.instance.name]: record(h, tokenName) } }));
  console.log(`${status('ok', 'OK  ')} ${shown(h)} confirmed for Kette project ${project.instance.name} on this machine.`);
  return 0;
}

// After connect: a person at a terminal confirms the host at once, everyone else gets the command
export async function offerHostTrust(lib, project, tokenName) {
  if (hostTrusted(lib, project, tokenName)) return;
  if (agentOrNoTerminal()) { console.log(`${status('warn', 'WARN')} ${shown(boardHost(lib, project))} is not confirmed on this machine yet, nothing is sent there until a person runs: ${cmd('kette ticket host trust')}`); return; }
  await trustHost(lib, project, tokenName);
}
