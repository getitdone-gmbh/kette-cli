// Ticket systems of the bundle's library (KETTE-54); contract 2 keeps the additions optional, so each helper falls back to workload.zero
import { PROJECT_PATTERN, printable } from '../instance/config.mjs';

export const WORKLOAD_ZERO = 'workload-zero';
export const WORKLOAD_ZERO_TOKEN = 'KETTE_TICKETING_WORKBASE_TOKEN';

// The fields kette ticket connect sets; session and intakeModel are set by hand and stay as they are, minCli is written by connect
export const CONNECT_FIELDS = ['adapter', 'project', 'host', 'org', 'subIssues', 'deployment', 'decisionType', 'itemType', 'trustedAuthors'];

// The first kette that reads a block of another system than workload.zero; 0.11 and 0.12 refuse the whole instance.json for it (CR-COMPAT-1)
export const MIN_CLI = '0.13.0';

// The settings each system reads, from the usage lines of kette-ticketing; a system this CLI does not know yet is left to the library
const FIELDS = {
  'workload-zero': [],
  github: ['host', 'subIssues', 'trustedAuthors'],
  jira: ['host', 'deployment', 'decisionType', 'itemType', 'trustedAuthors'],
  linear: ['trustedAuthors'],
  gitlab: ['host', 'trustedAuthors'],
  'azure-devops': ['host', 'org', 'decisionType', 'itemType', 'trustedAuthors'],
};
export const OPTION_OF = { host: '--host', org: '--org', subIssues: '--sub-issues', deployment: '--deployment', decisionType: '--decision-type', itemType: '--item-type', trustedAuthors: '--trusted-authors' };

// Options the system does not read are refused, never dropped silently (CR-FLD-1); a bundle from before the adapters reads none
export function unusedOptions(lib, adapter, fields) {
  const known = typeof lib.connectSettings === 'function' ? FIELDS[adapter] : [];
  if (!known) return [];
  return Object.keys(OPTION_OF).filter((k) => fields[k] !== undefined && !known.includes(k)).map((k) => OPTION_OF[k]);
}

export const supportedAdapters = (lib) => (Array.isArray(lib.SUPPORTED_ADAPTERS) && lib.SUPPORTED_ADAPTERS.length ? lib.SUPPORTED_ADAPTERS : [WORKLOAD_ZERO]);

// Name of the board credential in the secret wallet for an adapter; never the value
export const tokenNameOf = (lib, adapter) => (typeof lib.tokenNameFor === 'function' ? lib.tokenNameFor(adapter || WORKLOAD_ZERO) : WORKLOAD_ZERO_TOKEN);

// The connect line of an adapter: the board id is --board since 0.12; a bundle from before kette-ticketing PR #11 still says --project
export function usageOf(lib, adapter) {
  const line = typeof lib.adapterUsage === 'function' ? lib.adapterUsage(adapter) : `kette ticket connect ${WORKLOAD_ZERO} --board <project id>`;
  return line.replace(/--project\b/g, '--board');
}

export const usageLines = (lib) => supportedAdapters(lib).map((a) => usageOf(lib, a));

// The block kette ticket connect writes, checked per adapter by the library; a bundle without connectSettings knows workload.zero only
// Another system than workload.zero carries minCli, so a kette that knows it reads the block and an older one says why it does not
export function settingsFor(lib, adapter, fields) {
  if (typeof lib.connectSettings !== 'function') return { adapter, project: lib.assertProjectId(fields.project) };
  const block = lib.connectSettings(adapter, fields);
  return block.adapter === WORKLOAD_ZERO ? block : { ...block, minCli: MIN_CLI };
}

// The connect fields of a block in a fixed order, so two blocks compare by what they say, not by how they were written
const stable = (block) => JSON.stringify(CONNECT_FIELDS.filter((k) => block?.[k] !== undefined).map((k) => [k, block[k]]));
export const sameBoard = (lib, current, next) => lib.adapterId(current.adapter) === next.adapter && stable({ ...current, adapter: next.adapter }) === stable(next);

// The board in one line for plans and messages
export const boardLine = (block) => [block.adapter, block.project, block.host, block.org].filter(Boolean).map(printable).join(' ');

// The board id rule of workload.zero (KETTE-28); other systems have their own forms (owner/repo, KEY, group/project), checked by the library
export const workloadZeroId = (id) => PROJECT_PATTERN.test(id);
