import fs from 'node:fs';
import path from 'node:path';
import { ExitError } from '../errors.mjs';
import { cmd, dim, file, status } from '../out.mjs';
import { apply, describe, print } from '../plan.mjs';
import { readState, updateState } from '../manifest.mjs';
import { confirm } from '../prompt.mjs';
import { SETTINGS_PATH } from '../project-plugins.mjs';
import { loadTicketing } from './module.mjs';
import { contextOf, ticketProject } from './project.mjs';

// The intake hook lives in the project settings only, never in the user settings; this exact command marks the entry as kette's,
// so remove takes this entry and nothing else
export const HOOK_COMMAND = 'kette ticket hook run';
const EVENT = 'UserPromptSubmit';
// Claude Code ignores a hook that runs longer; the intake answers within its own 1.5 s budget
const TIMEOUT_S = 5;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const ours = (h) => isObject(h) && h.type === 'command' && h.command === HOOK_COMMAND;
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

function parse(text) {
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); return isObject(v) ? v : null; } catch { return null; }
}

const entries = (settings) => (isObject(settings.hooks) && Array.isArray(settings.hooks[EVENT]) ? settings.hooks[EVENT] : []);
export const installed = (settings) => entries(settings).some((e) => isObject(e) && Array.isArray(e.hooks) && e.hooks.some(ours));

// Adds kette's entry once; every other setting and hook stays as it is; null for a file that is not a JSON object
export function withHook(current) {
  const settings = parse(current);
  if (!settings) return null;
  if (installed(settings)) return current;
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  return json({ ...settings, hooks: { ...hooks, [EVENT]: [...entries(settings), { hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: TIMEOUT_S }] }] } });
}

// Takes out only kette's hook; a group that held only it goes, empty containers go, everything else stays
export function withoutHook(current) {
  const settings = parse(current);
  if (!settings) return null;
  if (!installed(settings)) return current;
  const kept = entries(settings).map((e) => (isObject(e) && Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h) => !ours(h)) } : e)).filter((e) => !isObject(e) || !Array.isArray(e.hooks) || e.hooks.length);
  const { [EVENT]: _gone, ...otherEvents } = settings.hooks;
  const hooks = kept.length ? { ...otherEvents, [EVENT]: kept } : otherEvents;
  const { hooks: _old, ...rest } = settings;
  return json(Object.keys(hooks).length ? { ...rest, hooks } : rest);
}

function change(root, renew, opts, done) {
  const target = path.join(root, SETTINGS_PATH);
  if (!fs.existsSync(target) && renew === withoutHook) { console.log(`No ${SETTINGS_PATH} in this project, nothing to remove.`); return 0; }
  const described = describe([{ path: SETTINGS_PATH, mode: 'renew', content: renew('') ?? '', renew: (current) => renew(current) ?? current, note: 'intake hook of kette ticketing, this project only' }], root);
  const [d] = described;
  if (fs.existsSync(target) && renew(fs.readFileSync(target, 'utf8')) === null) throw new ExitError(`${SETTINGS_PATH} is not a JSON object. Fix the file first, nothing written.`, 1);
  if (d.action === 'keep') { console.log(done.already); return 0; }
  console.log(`${opts.dryRun ? 'Would change' : 'Plan'}:`);
  print(described);
  if (opts.dryRun) { console.log(dim('--dry-run: nothing written.')); return 0; }
  apply(described, root);
  console.log(`${status('ok', 'OK  ')} ${done.now}`);
  return 0;
}

// The model host an instance names is asked only after this machine confirmed it, again after every change of the host (KETTE-32);
// KETTE_INTAKE_MODEL_URL is the machine's own choice and needs no confirmation
export const modelHost = (project) => { try { return new URL(project.effective.ticketing.intakeModel).origin; } catch { return null; } };
export const modelTrusted = (project) => { const host = modelHost(project); return Boolean(host) && readState().intake_trust?.[project.instance.name] === host; };

function modelLine(project) {
  const host = modelHost(project);
  if (process.env.KETTE_INTAKE_MODEL_URL) return `${status('info', 'INFO')} Unclear prompts go to the model of this machine (KETTE_INTAKE_MODEL_URL)`;
  if (!host) return `${status('info', 'INFO')} No intake model: unclear prompts get a hint, no prompt leaves this machine`;
  if (modelTrusted(project)) return `${status('ok', 'OK  ')} Intake model ${host} of instance ${project.instance.name}, confirmed on this machine`;
  return `${status('warn', 'WARN')} Intake model ${host} of instance ${project.instance.name} is not confirmed on this machine, unclear prompts only get a hint. Confirm with: ${cmd('kette ticket hook trust')}`;
}

async function trustCmd(project) {
  const host = modelHost(project);
  if (!host) { console.log(`Instance ${project.instance.name} names no intake model (ticketing.intakeModel), nothing to confirm.`); return 0; }
  if (modelTrusted(project)) { console.log(`${status('ok', 'OK  ')} ${host} is confirmed on this machine already.`); return 0; }
  if (!process.stdin.isTTY) throw new ExitError(`Confirming the intake model ${host} needs a person at a terminal: run ${cmd('kette ticket hook trust')} yourself.`, 1);
  console.log(`Instance ${project.instance.name} sends unclear prompts of this project to ${host} to decide whether they change the chain.`);
  if (!(await confirm(`Allow prompts of this project to go to ${host} from this machine?`))) throw new ExitError('Not confirmed, nothing changed.', 1);
  updateState((state) => ({ ...state, intake_trust: { ...(state.intake_trust || {}), [project.instance.name]: host } }));
  console.log(`${status('ok', 'OK  ')} ${host} confirmed for instance ${project.instance.name} on this machine.`);
  return 0;
}

function statusCmd(root, project) {
  const f = path.join(root, SETTINGS_PATH);
  const settings = fs.existsSync(f) ? parse(fs.readFileSync(f, 'utf8')) : {};
  if (settings === null) throw new ExitError(`${SETTINGS_PATH} is not a JSON object.`, 1);
  if (installed(settings)) console.log(`${status('ok', 'OK  ')} Intake hook on in ${file(SETTINGS_PATH)} for this project ${dim(`(${HOOK_COMMAND})`)}`);
  else console.log(`${status('info', 'INFO')} Intake hook off for this project. Switch it on with: ${cmd('kette ticket hook install')}`);
  if (project) console.log(modelLine(project));
  return 0;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// Claude Code calls this for every prompt: outside an Enterprise instance, on bad input or any error it prints nothing and exits 0
async function run(deps) {
  if (process.env.KETTE_INTAKE_DISABLE === '1') return 0;
  try {
    const input = JSON.parse(await readStdin());
    const project = ticketProject(deps.root, deps);
    const { lib } = await loadTicketing(project.bundleDir);
    const routing = lib.routingFor({ ...contextOf(project), ticketing: project.effective.ticketing || { adapter: 'workload-zero', project: '' } });
    // A model is only asked when the instance names one this machine confirmed, or the machine names one itself (KETTE-26, KETTE-32)
    const modelUrl = modelTrusted(project) ? project.effective.ticketing.intakeModel : undefined;
    const context = await lib.decide(String(input?.prompt ?? ''), { routing, lastAssistant: lib.lastAssistantText(input?.transcript_path), ...(modelUrl ? { modelUrl } : {}) });
    if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: context } }));
  } catch {
    // A hook must never block or break a prompt
  }
  return 0;
}

export async function hook(action, opts, deps) {
  const root = deps.root;
  if (action === 'run') return run(deps);
  if (action === 'install') {
    const code = change(root, withHook, opts, { already: `The intake hook is on in ${SETTINGS_PATH} already.`, now: `Intake hook on in ${SETTINGS_PATH}. Commit it so the team gets it; it runs only in this project.` });
    if (deps.project) console.log(modelLine(deps.project));
    return code;
  }
  if (action === 'trust') return trustCmd(deps.project);
  if (action === 'remove') return change(root, withoutHook, opts, { already: `No kette intake hook in ${SETTINGS_PATH}.`, now: `Intake hook removed from ${SETTINGS_PATH}, other hooks stay.` });
  if (!action || action === 'status') return statusCmd(root, deps.project);
  throw new ExitError('Usage: kette ticket hook install | status | remove | trust');
}
