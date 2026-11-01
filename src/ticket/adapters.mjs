// Ticket systems of the bundle's library (KETTE-54); contract 2 keeps the additions optional, so each helper falls back to workload.zero
import { PROJECT_PATTERN, printable } from '../instance/config.mjs';

export const WORKLOAD_ZERO = 'workload-zero';
export const WORKLOAD_ZERO_TOKEN = 'KETTE_TICKETING_WORKBASE_TOKEN';

// The fields kette ticket connect sets; session and intakeModel are set by hand and stay as they are
export const CONNECT_FIELDS = ['adapter', 'project', 'host', 'org', 'subIssues', 'deployment', 'decisionType', 'itemType', 'trustedAuthors'];

export const supportedAdapters = (lib) => (Array.isArray(lib.SUPPORTED_ADAPTERS) && lib.SUPPORTED_ADAPTERS.length ? lib.SUPPORTED_ADAPTERS : [WORKLOAD_ZERO]);

// Name of the board credential in the secret wallet for an adapter; never the value
export const tokenNameOf = (lib, adapter) => (typeof lib.tokenNameFor === 'function' ? lib.tokenNameFor(adapter || WORKLOAD_ZERO) : WORKLOAD_ZERO_TOKEN);

// The connect line of an adapter in the words of this CLI: the board id is --board since 0.12, the library still says --project
export function usageOf(lib, adapter) {
  const line = typeof lib.adapterUsage === 'function' ? lib.adapterUsage(adapter) : `kette ticket connect ${WORKLOAD_ZERO} --project <project id>`;
  return line.replace(/--project\b/g, '--board');
}

export const usageLines = (lib) => supportedAdapters(lib).map((a) => usageOf(lib, a));

// The block kette ticket connect writes, checked per adapter by the library; a bundle without connectSettings knows workload.zero only
export function settingsFor(lib, adapter, fields) {
  if (typeof lib.connectSettings === 'function') return lib.connectSettings(adapter, fields);
  return { adapter, project: lib.assertProjectId(fields.project) };
}

// The connect fields of a block in a fixed order, so two blocks compare by what they say, not by how they were written
const stable = (block) => JSON.stringify(CONNECT_FIELDS.filter((k) => block?.[k] !== undefined).map((k) => [k, block[k]]));
export const sameBoard = (lib, current, next) => lib.adapterId(current.adapter) === next.adapter && stable({ ...current, adapter: next.adapter }) === stable(next);

// The board in one line for plans and messages
export const boardLine = (block) => [block.adapter, block.project, block.host, block.org].filter(Boolean).map(printable).join(' ');

// The board id rule of workload.zero (KETTE-28); other systems have their own forms (owner/repo, KEY, group/project), checked by the library
export const workloadZeroId = (id) => PROJECT_PATTERN.test(id);
