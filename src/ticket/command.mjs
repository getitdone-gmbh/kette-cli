import { ExitError } from '../errors.mjs';
import { ask, confirm } from '../prompt.mjs';
import { bold, cmd, dim, file, status } from '../out.mjs';
import { tilde } from '../rules.mjs';
import { instanceFile, instanceSource, printable, updateInstance } from '../instance/config.mjs';
import { WALLET_PATH, readWallet, writeWallet } from '../wallet/config.mjs';
import { loadTicketing, ticketingDir } from './module.mjs';
import { TOKEN_NAME, apiUrl, boardToken, contextOf, requireBoard, ticketProject } from './project.mjs';
import { hook } from './hook.mjs';

export const TICKET_HELP = `kette ticket connect [workload-zero] --project <id>
                        Ticketing (Enterprise): connect the board of this repo's instance; decisions become tickets
  kette ticket new "<words>" --by <member> --source <ref> --stations a,b
                        Record a decision in the words of who decided (--paraphrase, --statement, --rationale, --label,
                        an accepted session proposal: --proposed-by <session> --acceptance "<words>")
  kette ticket list | show <KD> | inbox --member <id> | report | why <subject|file:line|commit|KD>
  kette ticket edit <KD> | extend <KD> --stations a,b | route <KD> | close <KD>
  kette ticket pick <item> --as <member> | link <item> --pr|--commit|--figma|--review <url> | check <item>
  kette ticket check <KD>
                        Follow-through: per station its definition of done and what is still open (reads only)
  kette ticket hook install | status | remove
                        The intake hook in this project's .claude/settings.json (never the user settings)`;

const USAGE = `Usage: ${TICKET_HELP.split('\n').filter((l) => l.trim().startsWith('kette')).map((l) => l.trim()).join(' | ')}`;
const say = (kind, msg) => console.log(`${status(kind, kind === 'ok' ? 'OK  ' : kind.toUpperCase())} ${msg}`);
const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
const SOURCE_KINDS = ['chat', 'note', 'meeting', 'ticket', 'review'];
const LINK_FLAGS = { pr: 'pr', commit: 'commit', figma: 'figma-node', review: 'review' };

// Who writes: an agent when Claude Code runs kette, otherwise a person; always marked on the ticket (REQ-24)
const authorOf = (opts) => ({ type: process.env.CLAUDECODE === '1' ? 'agent' : 'human', name: opts.as || opts.by || 'kette-cli', via: 'cli' });
const actorOf = (opts) => opts.as || opts.by || 'kette-cli';

// A write goes to the board only after a yes in a terminal or --yes; agents and CI pass --yes on purpose
async function approved(opts, question) {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) throw new ExitError('Writing to the ticket board needs a yes: run it in a terminal or add --yes. Nothing was written.', 1);
  return confirm(question);
}

// Rule and routing refusals of the library are answers, not crashes
async function refused(run) {
  try { return await run(); } catch (err) {
    if (['LifecycleError', 'RoutingError', 'HttpError', 'PrivacyError', 'PlanMismatchError', 'AdoptionConflictError', 'ConflictError', 'BlockError', 'NotSupportedError'].includes(err.constructor?.name)) throw new ExitError(printable(err.message), 1);
    throw err;
  }
}

// Board session of a project: routing from the project context, the board of its instance, the credential from its wallet
async function open(project, opts) {
  const t = await loadTicketing(project.bundleDir);
  requireBoard(project);
  const context = contextOf(project);
  const routing = await refused(async () => t.lib.projectRouting(t.routing, context));
  const config = await refused(async () => t.lib.boardConfig(context, apiUrl(t.lib)));
  const { token, refresh } = await boardToken(project, opts, t.session);
  const http = (fetch) => t.lib.createHttpClient({ baseUrl: config.apiBaseUrl, token, ...(refresh ? { refreshToken: refresh } : {}), fetch });
  const on = (h, now) => {
    const adapter = new t.lib.WorkloadZeroAdapter(config, h, Object.keys(routing.members));
    return { adapter, service: new t.lib.TicketService({ adapter, routing, author: authorOf(opts), ...(now ? { now } : {}) }) };
  };
  return { t, routing, config, live: () => on(http(globalThis.fetch)), http, on };
}

const describeWrite = (w) => {
  const b = w.body || {};
  return [`${w.method} ${w.path.replace(/[0-9a-f]{24}/g, ':id')}`, b.title && `"${printable(b.title)}"`, b.status && `status ${b.status}`, b.content && `comment "${printable(b.content.split('\n')[0])}"`].filter(Boolean).join(' · ');
};

// Every write runs twice: first on a copy of the board (the plan, also what --dry-run prints), then for real, where each request is
// compared with the plan before it leaves the process; a refusal by the chain rules stops in the first run, before anything is sent
async function write(board, opts, run, summary) {
  const { t, config } = board;
  const at = new Date().toISOString();
  const seed = await refused(() => t.lib.readBoard(board.http(globalThis.fetch), config.projectId));
  const sim = t.lib.createWorkbaseSimulator({ baseUrl: config.apiBaseUrl, projectId: config.projectId, seed });
  const writes = [];
  const planning = t.lib.createHttpClient({ baseUrl: config.apiBaseUrl, token: 'dry-run', fetch: t.lib.recordingFetch(sim.fetch, config.apiBaseUrl, (w) => writes.push(w)), sleep: async () => {} });
  const planned = await refused(() => run({ ...board.on(planning, () => at), at }));
  console.log(summary(planned));
  if (!writes.length) { console.log(dim('Nothing to change on the board.')); return { planned, written: false }; }
  console.log(`${opts.dryRun ? 'Would send' : 'Sends'} ${writes.length} request${writes.length === 1 ? '' : 's'} to project ${printable(config.projectId)}:`);
  for (const w of writes) console.log(`  ${dim(describeWrite(w))}`);
  if (opts.dryRun) { console.log(dim('--dry-run: nothing written.')); return { planned, written: false }; }
  if (!(await approved(opts, 'Write this to the board?'))) throw new ExitError('Not confirmed, nothing written.', 1);
  const guarded = t.guard.guardFetch(globalThis.fetch, writes, config.apiBaseUrl);
  const result = await refused(() => run({ ...board.on(board.http(guarded), () => at), at }));
  if (guarded.remaining()) throw new ExitError(`${guarded.remaining()} planned requests were not sent. Check the board with ${cmd('kette ticket list')} before running it again.`, 1);
  say('ok', `Written to project ${printable(config.projectId)}`);
  return { planned: result, written: true };
}

const json = (opts, value) => { if (opts.json) { console.log(JSON.stringify(value, null, 2)); return true; } return false; };

function itemLine(i) {
  const extra = [i.awaiting && `waits for ${i.awaiting}`, i.reason, i.drift && 'drift: upstream not done'].filter(Boolean).map(printable).join(', ');
  const links = i.links.map((l) => `${l.kind} ${printable(l.url)}`).join(', ');
  return `  ${printable(i.key)}  ${bold(i.status)}${extra ? ` (${extra})` : ''}  ${dim(`owner ${printable(i.owner)}, builder ${printable(i.builder)}${i.assignee ? `, picked by ${printable(i.assignee)}` : ''}`)}${links ? `\n      ${dim(links)}` : ''}`;
}

function decisionLine({ decision: d, items }) {
  const done = items.filter((i) => ['done', 'not_applicable'].includes(i.status)).length;
  return `${bold(printable(d.id))} ${dim(`${d.status}${d.closedAt ? ', closed' : ''}, ${done}/${items.length} stations`)}  ${printable(d.statement)}`;
}

function showDecision(found) {
  const d = found.decision;
  console.log(decisionLine(found));
  const w = d.words;
  console.log(`  decided by ${printable(d.decidedBy)} on ${d.decidedAt.slice(0, 10)}${w.proposedBy ? `, proposed by ${printable(w.proposedBy)}, accepted "${printable(w.acceptance)}"` : ''}`);
  console.log(`  ${w.quality === 'verbatim' ? `words: "${printable(w.text)}"` : `words (paraphrase): ${printable(w.text)}`}`);
  console.log(`  source: ${d.source.kind} ${printable(d.source.ref)}`);
  if (d.rationale) console.log(`  why: ${printable(d.rationale)}`);
  for (const i of found.items) console.log(itemLine(i));
  console.log(dim(`  ${found.revisions?.length ?? 0} revisions, history with ${cmd(`kette ticket why ${d.id}`)}`));
}

function parseSource(raw) {
  if (!raw) throw new ExitError('--source names where the decision was made, e.g. --source chat:<session> or --source meeting:<date>');
  const m = /^([a-z]+):(.+)$/.exec(raw);
  return m && SOURCE_KINDS.includes(m[1]) ? { kind: m[1], ref: m[2] } : { kind: 'chat', ref: raw };
}

function wordsOf(text, opts) {
  const words = { text, quality: opts.paraphrase ? 'paraphrase' : 'verbatim' };
  if (opts['proposed-by'] || opts.acceptance) Object.assign(words, { ...(opts['proposed-by'] ? { proposedBy: opts['proposed-by'] } : {}), ...(opts.acceptance ? { acceptance: opts.acceptance } : {}) });
  return words;
}

const need = (value, usage) => { if (!value) throw new ExitError(`Usage: ${usage}`); return value; };

async function newDecision(project, opts, args) {
  const words = need(args.join(' ').trim(), 'kette ticket new "<words>" --by <member> --source <ref> --stations a,b');
  if (!opts.by) throw new ExitError(`--by names who decided, a member of instance ${project.instance.name} (${project.instance.members.map((m) => printable(m.id)).join(', ') || `none yet: ${cmd('kette instance members add <id> --role owner')}`})`);
  const stations = list(opts.stations);
  if (!stations.length) throw new ExitError('--stations names the stations the decision reaches, e.g. --stations prototype,app:<repo>');
  const source = parseSource(opts.source);
  const board = await open(project, opts);
  await write(board, opts, async ({ adapter, service, at }) => {
    const ids = (await adapter.listDecisions({})).items.map((d) => d.decision.id);
    const decision = {
      id: board.t.lib.nextDecisionId(ids),
      statement: opts.statement || words,
      words: wordsOf(words, opts),
      decidedBy: opts.by,
      decidedAt: at.slice(0, 10),
      source,
      status: 'decided',
      labels: list(opts.label),
      ...(opts.rationale ? { rationale: opts.rationale } : {}),
    };
    return service.create(decision, stations, { actor: actorOf(opts) });
  }, (made) => `New decision ${made.decision.id} with ${made.items.length} station item${made.items.length === 1 ? '' : 's'}:\n${made.items.map(itemLine).join('\n')}`);
  return 0;
}

const decisionId = (args, usage) => need(args[0], usage);

async function editDecision(project, opts, args) {
  const id = decisionId(args, 'kette ticket edit <KD> [--statement s] [--words w] [--rationale r] [--label a,b]');
  const patch = {
    ...(opts.statement ? { statement: opts.statement } : {}),
    ...(opts.words ? { words: wordsOf(opts.words, opts) } : {}),
    ...(opts.rationale ? { rationale: opts.rationale } : {}),
    ...(opts.label ? { labels: list(opts.label) } : {}),
  };
  if (!Object.keys(patch).length) throw new ExitError('Nothing to edit: --statement, --words, --rationale or --label');
  const board = await open(project, opts);
  await write(board, opts, ({ service }) => service.edit(id, patch, { actor: actorOf(opts) }), (d) => `Edit ${d.decision.id}: ${Object.keys(patch).join(', ')}`);
  return 0;
}

async function extendDecision(project, opts, args) {
  const id = decisionId(args, 'kette ticket extend <KD> --stations a,b [--comment text]');
  const stations = list(opts.stations);
  if (!stations.length && !opts.comment) throw new ExitError('Nothing to extend: --stations a,b or --comment text');
  const board = await open(project, opts);
  await write(board, opts, ({ service }) => service.extend(id, stations, { actor: actorOf(opts), ...(opts.comment ? { comment: opts.comment } : {}) }), (d) => `Extend ${d.decision.id}:\n${d.items.map(itemLine).join('\n')}`);
  return 0;
}

async function route(project, opts, args) {
  const id = decisionId(args, 'kette ticket route <KD>');
  const board = await open(project, opts);
  await write(board, opts, ({ service }) => service.reroute(id, actorOf(opts)), (changed) => (changed.length ? `Owners and builders from the routing of instance ${project.instance.name}:\n${changed.map(itemLine).join('\n')}` : `Every item of ${id} already has the owner and builder the routing names.`));
  return 0;
}

async function itemCommand(project, opts, args, action) {
  const key = need(args[0], `kette ticket ${action} <item key, e.g. KD-0001/app/<repo>>`);
  if (action === 'pick' && !opts.as) throw new ExitError('--as names who picks the item (a member, session or agent)');
  const board = await open(project, opts);
  const meta = { actor: actorOf(opts), ...(opts['approved-by'] ? { approvedBy: opts['approved-by'] } : {}) };
  let run;
  if (action === 'pick') run = ({ service }) => service.pick(key, opts.as);
  else if (action === 'check') run = ({ service }) => service.check(key, meta);
  else {
    const kinds = Object.keys(LINK_FLAGS).filter((k) => opts[k]);
    if (kinds.length !== 1) throw new ExitError('kette ticket link <item> needs exactly one of --pr, --commit, --figma, --review with a URL');
    const url = opts[kinds[0]];
    if (!/^https:\/\/[^/\s]+\.[^/\s]+/.test(url)) throw new ExitError(`--${kinds[0]} needs an https URL (a commit as its URL on the git host): ${printable(url)}`);
    run = ({ service, at }) => service.link(key, { kind: LINK_FLAGS[kinds[0]], url, addedBy: meta.actor, addedAt: at }, meta);
  }
  const doneWhen = (item) => board.routing.stations[item.layer]?.definitionOfDone;
  await write(board, opts, run, (item) => `${action} ${item.key}:\n${itemLine(item)}${doneWhen(item) ? `\n      ${dim(`done when: ${printable(doneWhen(item))}`)}` : ''}`);
  return 0;
}

// kette ticket check <KD>: follow-through of the whole decision; checks status, links and chain order, the rest is the owner's to confirm
async function followThrough(project, opts, id) {
  const { live, t } = await open(project, opts);
  const f = await refused(() => live().service.followThrough(id));
  if (json(opts, f)) return f.complete ? 0 : 1;
  console.log(t.lib.formatFollowThrough(f).split('\n').map(printable).join('\n'));
  return f.complete ? 0 : 1;
}

async function close(project, opts, args) {
  const id = decisionId(args, 'kette ticket close <KD>');
  const board = await open(project, opts);
  await write(board, opts, ({ service }) => service.close(id, actorOf(opts)), (d) => `Close ${d.decision.id}: every station is done or not applicable.`);
  return 0;
}

async function listCmd(project, opts) {
  const { live, routing, t } = await open(project, opts);
  const { adapter } = live();
  if (opts.member || opts.station || opts.status) {
    const query = { ...(opts.member ? { member: opts.member } : {}), ...(opts.station ? { layer: opts.station } : {}), ...(opts.status ? { status: list(opts.status) } : {}) };
    const items = t.lib.sortByChain((await refused(() => adapter.listLayerItems(query))).items, routing);
    if (json(opts, items)) return 0;
    if (!items.length) console.log('No items match.');
    for (const i of items) console.log(itemLine(i));
    return 0;
  }
  const decisions = (await refused(() => adapter.listDecisions({}))).items;
  if (json(opts, decisions)) return 0;
  if (!decisions.length) console.log(`No decisions on the board of instance ${project.instance.name} yet. Record one with ${cmd('kette ticket new')}.`);
  for (const d of decisions.sort((a, b) => a.decision.id.localeCompare(b.decision.id))) console.log(decisionLine(d));
  return 0;
}

async function show(project, opts, args) {
  const id = decisionId(args, 'kette ticket show <KD>');
  const { live } = await open(project, opts);
  const found = await refused(() => live().adapter.getDecision(id));
  if (!found) throw new ExitError(`${printable(id)} is not on the board of instance ${project.instance.name}.`, 1);
  if (json(opts, found)) return 0;
  showDecision(found);
  return 0;
}

async function inbox(project, opts) {
  const member = opts.member || opts.as;
  if (!member) throw new ExitError('Usage: kette ticket inbox --member <id>');
  const { live } = await open(project, opts);
  const items = await refused(() => live().service.inbox(member));
  if (json(opts, items)) return 0;
  if (!items.length) console.log(`Nothing open for ${printable(member)}.`);
  for (const i of items) console.log(itemLine(i));
  return 0;
}

async function report(project, opts) {
  const { live, routing, t } = await open(project, opts);
  const r = await refused(() => live().service.report());
  if (opts.station) r.openByLayer = Object.fromEntries(Object.entries(r.openByLayer).filter(([layer]) => layer === opts.station));
  if (json(opts, r)) return 0;
  console.log(t.lib.formatReport(r, routing).split('\n').map(printable).join('\n'));
  return 0;
}

// git lookups for why file:line and why <sha>, inside the project
const gitResolver = (root, spawnSync) => ({
  blame(f, line) {
    const r = spawnSync('git', ['blame', '-L', `${line},${line}`, '--porcelain', '--', f], { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? this.commit(r.stdout.split(' ')[0]) : null;
  },
  commit(sha) {
    const r = spawnSync('git', ['log', '-1', '--format=%H%n%B', sha, '--'], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) return null;
    const [full, ...message] = r.stdout.split('\n');
    return { sha: full, message: message.join('\n') };
  },
});

async function whyCmd(project, opts, args, deps) {
  const query = need(args.join(' ').trim(), 'kette ticket why <subject | file:line | commit | URL | KD id>');
  const { live, t } = await open(project, opts);
  const result = await refused(() => live().service.why(query, { resolver: gitResolver(project.root, deps.spawnSync) }));
  if (json(opts, result)) return 0;
  console.log(t.lib.formatWhy(result).split('\n').map(printable).join('\n'));
  return 0;
}

// kette ticket connect: the board goes into instance.json (under its lock) after the plan was shown; the credential only as a name
async function connect(project, opts, args) {
  const t = await loadTicketing(project.bundleDir);
  const adapter = await refused(async () => t.lib.adapterId(args[0] || 'workload-zero'));
  const id = opts.project;
  if (!id) throw new ExitError('Usage: kette ticket connect workload-zero --project <id> (the workload.zero project id)');
  const next = { adapter, project: id };
  const name = project.instance.name;
  const current = project.instance.ticketing;
  if (current && (t.lib.adapterId(current.adapter) !== adapter || current.project !== id)) {
    throw new ExitError(`Instance ${name} already uses ${printable(current.adapter)} ${printable(current.project)}. One ticket system per project, no sync between two (Q3). Change ticketing in ${tilde(instanceFile(name))} by hand if the project moves.`, 1);
  }
  const wallet = readWallet(project.root);
  const declare = wallet && !wallet.secrets.some((s) => s.name === TOKEN_NAME);
  const changes = current ? [] : [`  ~ update ${file(tilde(instanceFile(name)))}  ${dim(`ticketing: ${adapter} ${printable(id)}`)}`];
  if (declare) changes.push(`  ~ update ${file(WALLET_PATH)}  ${dim(`declares ${TOKEN_NAME} (the name only, the value stays in your provider)`)}`);
  if (!changes.length) say('ok', `Instance ${name} is connected to ${adapter} ${printable(id)} already.`);
  else {
    console.log(`${opts.dryRun ? 'Would change' : 'Plan'} (instance ${name}):`);
    for (const c of changes) console.log(c);
    if (opts.dryRun) { console.log(dim('--dry-run: nothing written.')); return 0; }
    if (!(await approved(opts, 'Connect the board?'))) throw new ExitError('Not confirmed, nothing written.', 1);
    if (!current) {
      updateInstance(name, (i) => {
        if (i.ticketing && (i.ticketing.adapter !== adapter || i.ticketing.project !== id)) throw new ExitError(`Instance ${name} got another board in the meantime (${printable(i.ticketing.adapter)} ${printable(i.ticketing.project)}). Nothing written.`, 1);
        return i.ticketing ? i : { ...i, ticketing: next };
      });
      say('ok', `Instance ${name} uses ${adapter} ${printable(id)} for decisions`);
      if (instanceSource(name).kind !== 'local') console.log(dim(`instance.json lives in the instance repo ${tilde(instanceSource(name).path)}. Commit and push it so the team sees the board.`));
    }
    if (declare) {
      writeWallet(project.root, { ...wallet, secrets: [...wallet.secrets, { name: TOKEN_NAME, note: 'ticket board access' }] });
      say('ok', `${TOKEN_NAME} declared in ${file(WALLET_PATH)}`);
    }
  }
  return probe({ ...project, effective: { ...project.effective, ticketing: next }, instance: { ...project.instance, ticketing: next } }, opts);
}

// One read of the board after connect; a missing credential is a next step, not a failure
async function probe(project, opts) {
  let board;
  try { board = await open(project, opts); } catch (err) {
    if (!(err instanceof ExitError)) throw err;
    console.log(`Next: ${err.message.replace(/^No access to the ticket board of instance [^.]+\.\s*/, '')}`);
    return 0;
  }
  try {
    const count = (await board.live().adapter.listDecisions({})).items.length;
    say('ok', `Board reachable, ${count} decision${count === 1 ? '' : 's'} on it. Try ${cmd('kette ticket list')}`);
  } catch (err) {
    say('warn', `Board not readable yet: ${printable(err.message)}`);
  }
  return 0;
}

// After the wallet step of kette init and kette add: Enterprise instance, terminal, no board yet; skippable, a failure never fails the setup
export async function offerTicketing(root, opts, { resolveProject }) {
  if (opts.yes || opts.dryRun || !process.stdin.isTTY) return;
  let project;
  try { project = ticketProject(root, { resolveProject }); } catch { return; }
  if (project.effective.ticketing || !ticketingDir(project.bundleDir)) return;
  if (!(await confirm(`\nTrack decisions as tickets on a workload.zero board for instance ${project.instance.name}?`))) return;
  const id = await ask('workload.zero project id (empty skips)');
  if (!id) return;
  try {
    await connect(project, { ...opts, project: id, yes: true }, ['workload-zero']);
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
    console.log(`${status('warn', 'WARN')} ${err.message} Later with: ${cmd(`kette ticket connect workload-zero --project ${id}`)}`);
  }
}

const COMMANDS = { new: newDecision, edit: editDecision, extend: extendDecision, route, close, list: listCmd, show, inbox, report };

export async function ticket(sub, opts, deps) {
  if (!sub || sub === 'help') { console.log(`Ticketing (Enterprise): decisions become tickets on the board of the instance and travel down the chain.\n\n  ${TICKET_HELP}`); return 0; }
  const args = opts._.slice(2);
  // The hook runs on every prompt in Claude Code: it never fails and never asks
  if (sub === 'hook' && args[0] === 'run') return hook('run', opts, { ...deps, root: '.' });
  const project = ticketProject('.', deps);
  if (sub === 'hook') return hook(args[0], opts, { ...deps, root: '.', project });
  if (sub === 'connect') return connect(project, opts, args);
  if (sub === 'check' && args[0] && !args[0].includes('/')) return followThrough(project, opts, args[0]);
  if (['pick', 'link', 'check'].includes(sub)) return itemCommand(project, opts, args, sub);
  if (sub === 'why') return whyCmd(project, opts, args, deps);
  if (COMMANDS[sub]) return COMMANDS[sub](project, opts, args);
  throw new ExitError(`Unknown ticket command: ${printable(sub)}. ${USAGE}`);
}
