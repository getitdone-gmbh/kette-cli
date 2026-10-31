// Public test double of the ticketing contract 2 (KETTE-28): the same exports as kette-ticketing's scripts/cli-facade.mjs, with
// decisions as JSON in task descriptions on a tiny board API, so the CLI's project scope, credentials, plan, confirmation and
// guarded write run in public CI. It knows no chain rules; those are tested against the real library.
import { readFileSync } from 'node:fs';

export const CLI_CONTRACT = 2;
export const DEFAULT_ROUTING = JSON.parse(readFileSync(new URL('../routing.default.json', import.meta.url), 'utf8'));
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

class DoubleRefusal extends Error {}
export const isRefusal = (err) => err instanceof DoubleRefusal;
export function adapterId(raw) {
  if (raw !== 'workload-zero' && raw !== 'workbase') throw new DoubleRefusal(`Ticket adapter ${JSON.stringify(raw)} is not supported yet; supported: workload-zero`);
  return 'workload-zero';
}
export function assertProjectId(id) {
  if (!PROJECT_ID.test(id)) throw new DoubleRefusal(`Project id ${JSON.stringify(String(id))} is not valid`);
  return id;
}
export const sessionConfigFromEnv = (env = process.env) => ({ file: env.WORKBASE_SESSION_FILE || '/nonexistent/kette-test-double-session.json', refreshUrl: 'https://example.invalid/refresh' });
export const sessionAccessToken = async ({ file }) => JSON.parse(readFileSync(file, 'utf8')).accessToken;
export const lastAssistantText = () => '';
export const modelEndpoint = () => null;
export const decide = async (prompt) => (/\b(bau|change|make)\b/i.test(prompt) ? 'Kette intake (test double): chain change' : null);
export const routingFor = (context) => ({ ...DEFAULT_ROUTING, stations: Object.fromEntries((context.stations?.length ? context.stations.map((s) => (typeof s === 'string' ? s : s.id)) : Object.keys(DEFAULT_ROUTING.stations)).map((s) => [s, { ...DEFAULT_ROUTING.stations[s], repos: context.repos ?? [] }])) });

export function openProject({ context, apiBaseUrl = 'https://board.invalid/api', token, author, fetch = globalThis.fetch }) {
  adapterId(context.ticketing.adapter);
  const projectId = assertProjectId(context.ticketing.project);
  const base = apiBaseUrl.replace(/\/+$/, '');
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new DoubleRefusal(`${method} ${path} failed (${res.status})`);
    return res.json();
  };
  const list = async () => (await call('GET', `/tasks/project/${encodeURIComponent(projectId)}`)).map((t) => ({ ...JSON.parse(t.description), ref: t._id }));
  const build = async (op, a, at) => {
    if (op !== 'new') throw new DoubleRefusal(`kette ticket ${op} is not part of the test double`);
    const ids = (await list()).map((d) => Number(d.decision.id.slice(3)));
    const id = `KD-${String(Math.max(0, ...ids) + 1).padStart(4, '0')}`;
    const decision = { id, statement: a.statement || a.words, words: { text: a.words, quality: a.paraphrase ? 'paraphrase' : 'verbatim' }, decidedBy: a.by, decidedAt: at.slice(0, 10), source: a.source, status: 'decided', labels: [], createdBy: author };
    const items = a.stations.map((s) => ({ key: `${id}/${s.split(':')[0]}/${s.split(':')[1] || 'default'}`, layer: s.split(':')[0], status: 'open', owner: 'owner', builder: 'builder', links: [] }));
    return { result: { decision, items }, writes: [{ method: 'POST', path: '/tasks', body: { projectId, title: `${id} · ${decision.statement}`, description: JSON.stringify({ decision, items }) } }] };
  };
  const empty = { notInPrototypeOrFigma: [], inProgressAhead: [], doneAhead: [], openByLayer: {}, unreadable: [] };
  return {
    routing: routingFor(context),
    projectId,
    list,
    get: async (id) => (await list()).find((d) => d.decision.id === id) ?? null,
    items: async () => (await list()).flatMap((d) => d.items),
    inbox: async () => [],
    report: async () => empty,
    why: async (query) => ({ query, matches: [], current: [], lineage: [] }),
    followThrough: async (id) => ({ id, complete: false, stations: [], tickets: null, review: null }),
    incomplete: async () => [],
    plan: (op, a, at) => build(op, a, at),
    async write(op, a, at, writes) {
      const { result, writes: again } = await build(op, a, at);
      if (JSON.stringify(again) !== JSON.stringify(writes)) throw new DoubleRefusal('Write 1 differs from the plan; stopped before sending it');
      for (const w of writes) await call(w.method, w.path, w.body);
      const same = (await list()).filter((d) => d.decision.id === result.decision.id);
      return { result, unsent: 0, duplicates: same.length > 1 ? same.map((d) => d.ref) : [] };
    },
    format: { report: () => 'Decided but not yet in prototype/Figma: 0', why: (r) => `No decision found for "${r.query}".`, followThrough: (f) => `${f.id} follow-through: test double` },
  };
}
