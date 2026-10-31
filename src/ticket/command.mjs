import { ExitError } from '../errors.mjs';
import { ask, confirm } from '../prompt.mjs';
import { bold, cmd, dim, file, status } from '../out.mjs';
import { tilde } from '../rules.mjs';
import { withLockAsync } from '../lock.mjs';
import { PROJECT_PATTERN, instanceFile, instanceSource, printable, updateInstance } from '../instance/config.mjs';
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
  kette ticket edit <KD> | extend <KD> --stations a,b | route <KD> | close <KD> | repair <KD>
  kette ticket pick <item> --as <member> | link <item> --pr|--commit|--figma|--review <url> | check <item>
  kette ticket check <KD>
                        Follow-through: per station its definition of done and what is still open (reads only)
  kette ticket hook install | status | remove | trust
                        The intake hook in this project's .claude/settings.json (never the user settings); trust confirms
                        the intake model host of the instance on this machine`;

const USAGE = `Usage: ${TICKET_HELP.split('\n').filter((l) => l.trim().startsWith('kette')).map((l) => l.trim()).join(' | ')}`;
const say = (kind, msg) => console.log(`${status(kind, kind === 'ok' ? 'OK  ' : kind.toUpperCase())} ${msg}`);
const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
const SOURCE_KINDS = ['chat', 'note', 'meeting', 'ticket', 'review'];
const LINK_FLAGS = { pr: 'pr', commit: 'commit', figma: 'figma-node', review: 'review' };
const isAgent = () => process.env.CLAUDECODE === '1';

// Who writes: an agent when Claude Code runs kette, otherwise a person; always marked on the ticket (REQ-24). An approval names the
// person who confirmed it at the terminal, marked as declared
const authorOf = (opts) => (opts['approved-by'] ? { type: 'human', name: `${opts['approved-by']} (declared)`, via: 'cli' } : { type: isAgent() ? 'agent' : 'human', name: opts.as || opts.by || 'kette-cli', via: 'cli' });
const actorOf = (opts) => opts.as || opts.by || 'kette-cli';

// A write goes to the board only after a yes in a terminal or --yes; agents and CI pass --yes on purpose
async function approved(opts, question) {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) throw new ExitError('Writing to the ticket board needs a yes: run it in a terminal or add --yes. Nothing was written.', 1);
  return confirm(question);
}

// An approval, or acting as a person of the instance, is only accepted from that person at a terminal: never from an agent,
// never without a terminal, and --yes does not skip the question (KETTE-28)
async function asPerson(what) {
  if (isAgent() || !process.stdin.isTTY) throw new ExitError(`${what} needs a person at a terminal: run it yourself in a terminal, not through an agent or CI. Nothing was written.`, 1);
  if (!(await confirm(`${what}. Confirm as that person?`))) throw new ExitError('Not confirmed, nothing written.', 1);
}

// Board session of a project: the facade of the library with the project context, its board and the credential from its wallet
async function open(project, opts) {
  const { lib } = await loadTicketing(project.bundleDir);
  requireBoard(project);
  const { token, refresh } = await boardToken(project, opts, lib);
  const p = await refused(lib, async () => lib.openProject({ context: contextOf(project), apiBaseUrl: apiUrl(), token, ...(refresh ? { refreshToken: refresh } : {}), author: authorOf(opts) }));
  return { lib, p };
}

// Refusals of the library (chain rules, routing, board, plan guard) are answers, not crashes
async function refused(lib, run) {
  try { return await run(); } catch (err) {
    if (lib.isRefusal(err)) throw new ExitError(printable(err.message), 1);
    throw err;
  }
}

const describeWrite = (w) => {
  const b = w.body || {};
  return [`${w.method} ${w.path.replace(/[0-9a-f]{24}/g, ':id')}`, b.title && `"${printable(b.title)}"`, b.status && `status ${b.status}`, b.content && `comment "${printable(b.content.split('\n')[0])}"`].filter(Boolean).join(' · ');
};

// Every write runs twice: first on a copy of the board (the plan, also what --dry-run prints), then for real after the yes, planned
// again with a fresh time; each request is compared with that plan before it leaves the process. A refusal by the chain rules stops
// in the first run, before anything is sent. A new decision takes its id only after the yes, under the lock of its instance (KT-N3).
// --dry-run reads the board, and with the shared session file that read may renew the session (docs/ticketing.md)
async function write({ lib, p }, opts, op, args, summary, { lock = null } = {}) {
  const { result: planned, writes } = await refused(lib, () => p.plan(op, args, new Date().toISOString()));
  console.log(summary(planned));
  if (!writes.length) { console.log(dim('Nothing to change on the board.')); return planned; }
  console.log(`${opts.dryRun ? 'Would send' : 'Sends'} ${writes.length} request${writes.length === 1 ? '' : 's'} to project ${printable(p.projectId)}:`);
  for (const w of writes) console.log(`  ${dim(describeWrite(w))}`);
  if (opts.dryRun) { console.log(dim('--dry-run: nothing written.')); return planned; }
  if (!(await approved(opts, 'Write this to the board?'))) throw new ExitError('Not confirmed, nothing written.', 1);
  const commit = () => refused(lib, () => p.write(op, args, new Date().toISOString(), writes));
  const { result, unsent, renumbered, twins } = lock ? await withLockAsync(lock, commit) : await commit();
  if (unsent) throw new ExitError(`${unsent} planned requests were not sent. Check the board with ${cmd('kette ticket list')} before running it again.`, 1);
  for (const r of renumbered ?? []) say('warn', `${r.from} was recorded at the same moment by a parallel run on another machine; this decision is ${r.to} now (revision written)`);
  if (twins?.length) say('warn', `${printable(result.decision.id)} was also recorded at the same moment by a parallel run (${twins.map(printable).join(', ')}); the later one moves itself to the next free id`);
  if (op === 'new' && result.decision.id !== planned.decision.id && !renumbered?.length) say('info', `${planned.decision.id} was taken meanwhile, written as ${result.decision.id}`);
  say('ok', `Written to project ${printable(p.projectId)}${op === 'new' ? ` as ${result.decision.id}` : ''}`);
  return result;
}

const json = (opts, value) => { if (opts.json) { console.log(JSON.stringify(value, null, 2)); return true; } return false; };

function itemLine(i) {
  const extra = [i.awaiting && `waits for ${i.awaiting}`, i.reason, i.drift && 'drift: upstream not done', i.approval && `approved by ${i.approval.by} (${i.approval.how})`].filter(Boolean).map(printable).join(', ');
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

// Decisions an interrupted run left half written, named with their repair
const incompleteLines = (half) => half.map((h) => `${status('warn', 'WARN')} ${printable(h.id)} is incomplete (missing ${h.missing.map(printable).join(', ')}): ${cmd(`kette ticket repair ${h.id}`)}`);

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
const decisionId = (args, usage) => need(args[0], usage);
const isMember = (project, id) => project.instance.members.some((m) => m.id.toLowerCase() === String(id).toLowerCase());

async function newDecision(project, opts, args) {
  const words = need(args.join(' ').trim(), 'kette ticket new "<words>" --by <member> --source <ref> --stations a,b');
  if (!opts.by) throw new ExitError(`--by names who decided, a member of instance ${project.instance.name} (${project.instance.members.map((m) => printable(m.id)).join(', ') || `none yet: ${cmd('kette instance members add <id> --role owner')}`})`);
  const stations = list(opts.stations);
  if (!stations.length) throw new ExitError('--stations names the stations the decision reaches, e.g. --stations prototype,app:<repo>');
  const board = await open(project, opts);
  const op = { words, statement: opts.statement, paraphrase: Boolean(opts.paraphrase), proposedBy: opts['proposed-by'], acceptance: opts.acceptance, by: opts.by, source: parseSource(opts.source), stations, labels: list(opts.label), rationale: opts.rationale, actor: actorOf(opts) };
  // One new decision at a time per instance on this machine, so two parallel runs never take the same id (KETTE-29); the lock is held
  // only for the commit after the yes, never while a person reads the plan
  await write(board, opts, 'new', op, (made) => `New decision ${made.decision.id} with ${made.items.length} station item${made.items.length === 1 ? '' : 's'}:\n${made.items.map(itemLine).join('\n')}`, { lock: `ticket-new-${project.instance.name}` });
  return 0;
}

async function editDecision(project, opts, args) {
  const id = decisionId(args, 'kette ticket edit <KD> [--statement s] [--words w] [--rationale r] [--label a,b]');
  const patch = {
    ...(opts.statement ? { statement: opts.statement } : {}),
    ...(opts.words ? { words: wordsOf(opts.words, opts) } : {}),
    ...(opts.rationale ? { rationale: opts.rationale } : {}),
    ...(opts.label ? { labels: list(opts.label) } : {}),
  };
  if (!Object.keys(patch).length) throw new ExitError('Nothing to edit: --statement, --words, --rationale or --label');
  await write(await open(project, opts), opts, 'edit', { id, patch, actor: actorOf(opts) }, (d) => `Edit ${d.decision.id}: ${Object.keys(patch).join(', ')}`);
  return 0;
}

async function extendDecision(project, opts, args) {
  const id = decisionId(args, 'kette ticket extend <KD> --stations a,b [--comment text]');
  const stations = list(opts.stations);
  if (!stations.length && !opts.comment) throw new ExitError('Nothing to extend: --stations a,b or --comment text');
  await write(await open(project, opts), opts, 'extend', { id, stations, comment: opts.comment, actor: actorOf(opts) }, (d) => `Extend ${d.decision.id}:\n${d.items.map(itemLine).join('\n')}`);
  return 0;
}

async function route(project, opts, args) {
  const id = decisionId(args, 'kette ticket route <KD>');
  await write(await open(project, opts), opts, 'route', { id, actor: actorOf(opts) }, (changed) => (changed.length ? `Owners and builders from the routing of instance ${project.instance.name}:\n${changed.map(itemLine).join('\n')}` : `Every item of ${id} already has the owner and builder the routing names.`));
  return 0;
}

// kette ticket repair <KD>: completes what an interrupted run left out (first revision, planned station items) (KETTE-31)
async function repair(project, opts, args) {
  const id = decisionId(args, 'kette ticket repair <KD>');
  await write(await open(project, opts), opts, 'repair', { id, actor: actorOf(opts) }, (r) => (r.added.length || r.revision ? `Repair ${id}: ${[r.revision && 'first revision', ...r.added].filter(Boolean).map(printable).join(', ')}` : `${id} is complete, nothing to repair.`));
  return 0;
}

async function itemCommand(project, opts, args, action) {
  const key = need(args[0], `kette ticket ${action} <item key, e.g. KD-0001/app/<repo>>`);
  if (action === 'pick' && !opts.as) throw new ExitError('--as names who picks the item (a member, session or agent)');
  if (action !== 'link' && opts.as && isMember(project, opts.as)) await asPerson(`${action} ${key} as ${printable(opts.as)}, a person of instance ${project.instance.name}`);
  if (action === 'check' && opts['approved-by']) await asPerson(`${printable(opts['approved-by'])} approves ${key}`);
  const board = await open(project, opts);
  const actor = actorOf(opts);
  let args2;
  if (action === 'pick') args2 = { key, as: opts.as };
  else if (action === 'check') args2 = { key, actor, ...(opts['approved-by'] ? { approvedBy: opts['approved-by'], approvalHow: 'declared' } : {}) };
  else {
    const kinds = Object.keys(LINK_FLAGS).filter((k) => opts[k]);
    if (kinds.length !== 1) throw new ExitError('kette ticket link <item> needs exactly one of --pr, --commit, --figma, --review with a URL');
    const url = opts[kinds[0]];
    if (!/^https:\/\/[^/\s]+\.[^/\s]+/.test(url)) throw new ExitError(`--${kinds[0]} needs an https URL (a commit as its URL on the git host): ${printable(url)}`);
    args2 = { key, link: { kind: LINK_FLAGS[kinds[0]], url }, actor };
  }
  const doneWhen = (item) => board.p.routing.stations[item.layer]?.definitionOfDone;
  await write(board, opts, action, args2, (item) => `${action} ${item.key}:\n${itemLine(item)}${doneWhen(item) ? `\n      ${dim(`done when: ${printable(doneWhen(item))}`)}` : ''}`);
  return 0;
}

// kette ticket check <KD>: follow-through of the whole decision; checks status, links and chain order, the rest is the owner's to confirm
async function followThrough(project, opts, id) {
  const { lib, p } = await open(project, opts);
  const f = await refused(lib, () => p.followThrough(id));
  if (json(opts, f)) return f.complete ? 0 : 1;
  console.log(p.format.followThrough(f).split('\n').map(printable).join('\n'));
  return f.complete ? 0 : 1;
}

async function close(project, opts, args) {
  const id = decisionId(args, 'kette ticket close <KD>');
  await write(await open(project, opts), opts, 'close', { id, actor: actorOf(opts) }, (d) => `Close ${d.decision.id}: every station is done or not applicable.`);
  return 0;
}

async function listCmd(project, opts) {
  const { lib, p } = await open(project, opts);
  if (opts.member || opts.station || opts.status) {
    const query = { ...(opts.member ? { member: opts.member } : {}), ...(opts.station ? { layer: opts.station } : {}), ...(opts.status ? { status: list(opts.status) } : {}) };
    const items = await refused(lib, () => p.items(query));
    if (json(opts, items)) return 0;
    if (!items.length) console.log('No items match.');
    for (const i of items) console.log(itemLine(i));
    return 0;
  }
  const decisions = await refused(lib, () => p.list());
  if (json(opts, decisions)) return 0;
  if (!decisions.length) console.log(`No decisions on the board of instance ${project.instance.name} yet. Record one with ${cmd('kette ticket new')}.`);
  for (const d of [...decisions].sort((a, b) => a.decision.id.localeCompare(b.decision.id))) console.log(decisionLine(d));
  for (const l of incompleteLines(await refused(lib, () => p.incomplete()))) console.log(l);
  return 0;
}

async function show(project, opts, args) {
  const id = decisionId(args, 'kette ticket show <KD>');
  const { lib, p } = await open(project, opts);
  const found = await refused(lib, () => p.get(id));
  if (!found) throw new ExitError(`${printable(id)} is not on the board of instance ${project.instance.name}.`, 1);
  if (json(opts, found)) return 0;
  showDecision(found);
  return 0;
}

async function inbox(project, opts) {
  const member = opts.member || opts.as;
  if (!member) throw new ExitError('Usage: kette ticket inbox --member <id>');
  const { lib, p } = await open(project, opts);
  const items = await refused(lib, () => p.inbox(member));
  if (json(opts, items)) return 0;
  if (!items.length) console.log(`Nothing open for ${printable(member)}.`);
  for (const i of items) console.log(itemLine(i));
  return 0;
}

async function report(project, opts) {
  const { lib, p } = await open(project, opts);
  const r = await refused(lib, () => p.report());
  if (opts.station) r.openByLayer = Object.fromEntries(Object.entries(r.openByLayer).filter(([layer]) => layer === opts.station));
  const half = await refused(lib, () => p.incomplete());
  if (json(opts, { ...r, incomplete: half })) return 0;
  console.log(p.format.report(r).split('\n').map(printable).join('\n'));
  for (const l of incompleteLines(half)) console.log(l);
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
  const { lib, p } = await open(project, opts);
  const result = await refused(lib, () => p.why(query, gitResolver(project.root, deps.spawnSync)));
  if (json(opts, result)) return 0;
  console.log(p.format.why(result).split('\n').map(printable).join('\n'));
  return 0;
}

// kette ticket connect: the board goes into instance.json (under its lock) after the plan was shown; the credential only as a name
async function connect(project, opts, args) {
  const { lib } = await loadTicketing(project.bundleDir);
  const adapter = await refused(lib, async () => lib.adapterId(args[0] || 'workload-zero'));
  const id = opts.project;
  if (!id) throw new ExitError('Usage: kette ticket connect workload-zero --project <id> (the workload.zero project id)');
  if (!PROJECT_PATTERN.test(id)) throw new ExitError(`--project must be a board project id (letters, digits, dash, underscore, at most 64): ${JSON.stringify(printable(id).slice(0, 80))}. Nothing written.`);
  const next = { adapter, project: id };
  const name = project.instance.name;
  const current = project.instance.ticketing;
  if (current && (lib.adapterId(current.adapter) !== adapter || current.project !== id)) {
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
  return probe({ ...project, effective: { ...project.effective, ticketing: { ...current, ...next } }, instance: { ...project.instance, ticketing: { ...current, ...next } } }, opts);
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
    const count = (await board.p.list()).length;
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

const COMMANDS = { new: newDecision, edit: editDecision, extend: extendDecision, route, close, repair, list: listCmd, show, inbox, report };

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
