import { spawnSync } from 'node:child_process';
import { hasClaude, output, runClaude } from './claude.mjs';
import { bold, cmd, num, status } from './out.mjs';
import { ExitError } from './errors.mjs';

// Live deploy to itdone.cloud: the CLI only registers the MCP server, Claude Code signs in with OAuth (DCR + PKCE) on its own
export const MCP_NAME = 'itdone';
export const MCP_URL = 'https://api.itdone.cloud/mcp';
export const REGISTER_URL = 'https://dashboard.itdone.cloud/login?register=1';
const ADD_ARGS = ['mcp', 'add', '--transport', 'http', '-s', 'user', MCP_NAME, MCP_URL];
const CLAUDE_MISSING = `Claude Code not found. Install it with ${cmd('npm install -g @anthropic-ai/claude-code')}, then run ${cmd('kette cloud setup')} again.`;

const ok = (msg) => console.log(`${status('ok', 'OK  ')} ${msg}`);
const info = (msg) => console.log(`${status('info', 'INFO')} ${msg}`);
const warn = (msg) => console.log(`${status('warn', 'WARN')} ${msg}`);
const fail = (msg) => console.log(`${status('fail', 'FAIL')} ${msg}`);

// Without a terminal, in CI, over SSH or on Linux without a display there is no browser to open, the link is printed instead
export function canOpenBrowser(env = process.env, { isTTY = process.stdout.isTTY, platform = process.platform } = {}) {
  if (!isTTY || env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  return platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// Command that opens an https link; on Windows start runs through cmd.exe, so the link is quoted and quotes, percent signs,
// exclamation marks, whitespace and line breaks are refused (null) instead of escaped
export function openerFor(url, platform = process.platform) {
  if (!/^https:\/\/[^\s"%!]+$/.test(url)) return null;
  if (platform === 'darwin') return { command: 'open', args: [url], options: {} };
  if (platform === 'win32') return { command: 'cmd', args: ['/d', '/c', 'start', '""', `"${url}"`], options: { windowsVerbatimArguments: true } };
  return { command: 'xdg-open', args: [url], options: {} };
}

// true when the opener ran successfully; any error leaves it to the caller to print the link
export function openBrowser(url, { env = process.env, isTTY = process.stdout.isTTY, platform = process.platform, spawn = spawnSync } = {}) {
  if (!canOpenBrowser(env, { isTTY, platform })) return false;
  const opener = openerFor(url, platform);
  if (!opener) return false;
  const r = spawn(opener.command, opener.args, { stdio: 'ignore', timeout: 10000, ...opener.options });
  return !r.error && r.status === 0;
}

// registered true, false or null (not readable); only the URL is taken from claude mcp get, its headers may carry secrets
export function mcpServer() {
  const get = runClaude(['mcp', 'get', MCP_NAME]);
  if (get.status === 0) return { registered: true, url: get.stdout.match(/^\s*URL:\s*(\S+)/m)?.[1] || null };
  if (/no mcp server named/i.test(output(get))) return { registered: false };
  const list = runClaude(['mcp', 'list']);
  if (list.status !== 0) return { registered: null };
  const url = list.stdout.match(new RegExp(`^${MCP_NAME}:\\s+(\\S+)`, 'm'))?.[1];
  return url ? { registered: true, url } : { registered: false };
}

const registeredText = (server) => `itdone MCP registered${server.url ? ` (${server.url})` : ''}`;

// Another URL under the same name stays, the user decides whether to switch
function existingServer(server, dryRun) {
  if (server.url && server.url !== MCP_URL) {
    warn(`${registeredText(server)}, not ${MCP_URL}. ${dryRun ? 'Would stay' : 'Left'} unchanged. To switch: ${cmd(`claude mcp remove ${MCP_NAME} -s user && kette cloud setup`)}`);
    return;
  }
  info(`${registeredText(server)} already, ${dryRun ? 'would stay' : 'left'} unchanged`);
}

function accountStep(opts) {
  if (opts.haveAccount) return;
  if (opts.dryRun) { info(`Would open ${REGISTER_URL} in the browser`); return; }
  if (openBrowser(REGISTER_URL)) ok(`Opened ${REGISTER_URL} in the browser, create your itdone.cloud account there`);
  else info(`Create your itdone.cloud account: ${REGISTER_URL}`);
}

// false when the server is neither registered nor could be added
function mcpStep(opts) {
  const server = mcpServer();
  if (server.registered === null) { fail(`Could not read the MCP servers of Claude Code (${cmd(`claude mcp get ${MCP_NAME}`)} and ${cmd('claude mcp list')} fail), nothing changed`); return false; }
  if (server.registered) { existingServer(server, opts.dryRun); return true; }
  if (opts.dryRun) { info(`Would run: ${cmd(`claude ${ADD_ARGS.join(' ')}`)}`); return true; }
  const r = runClaude(ADD_ARGS);
  if (r.status !== 0) { fail(`claude mcp add failed: ${output(r) || `exit code ${r.status}`}. By hand: ${cmd(`claude ${ADD_ARGS.join(' ')}`)}`); return false; }
  ok(`itdone MCP registered in Claude Code (scope user): ${MCP_URL}`);
  return true;
}

function nextSteps() {
  const steps = [
    `In Claude Code run ${cmd('/mcp')}, choose ${bold(MCP_NAME)}, then ${bold('Authenticate')}. Your itdone.cloud account is created on the first login.`,
    'Ask Claude to deploy, e.g. "Deploy this app to itdone.cloud". The live-deploy skill deploys only after you confirm.',
  ];
  console.log(['', bold('Next steps:'), ...steps.map((s, i) => `  ${num(`${i + 1}.`)} ${s}`), '', 'kette never asks for or stores a password or token, Claude Code signs in through the browser.'].join('\n'));
}

async function setup(opts) {
  if (!hasClaude()) { fail(CLAUDE_MISSING); return 1; }
  if (opts.dryRun) console.log('Dry run, nothing changes:');
  accountStep(opts);
  if (!mcpStep(opts)) return 1;
  nextSteps();
  return 0;
}

// Informational: exit 0 whether or not the server is registered
function cloudStatus() {
  if (!hasClaude()) { info(CLAUDE_MISSING); return 0; }
  const server = mcpServer();
  if (server.registered) ok(registeredText(server));
  else if (server.registered === null) info(`Could not read the MCP servers of Claude Code (${cmd(`claude mcp get ${MCP_NAME}`)} fails)`);
  else info(`itdone MCP not registered. Live deploy: ${cmd('kette cloud setup')}`);
  return 0;
}

// One line for kette doctor, never a failure
export function doctorLine(line, infoLine) {
  const server = mcpServer();
  if (server.registered) line(true, registeredText(server));
  else infoLine(`Live deploy: ${cmd('kette cloud setup')}`);
}

export async function cloud(action, opts) {
  if (action === 'setup') return setup(opts);
  if (action === 'status') return cloudStatus();
  throw new ExitError('Usage: kette cloud setup [--have-account] [--dry-run] | status');
}
