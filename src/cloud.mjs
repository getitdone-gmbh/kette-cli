import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hasClaude, output, runClaude } from './claude.mjs';
import { bold, cmd, num, status } from './out.mjs';
import { ExitError } from './errors.mjs';
import { secureUrl } from './paths.mjs';

// Live deploy to itdone.cloud: the CLI only registers the MCP server, Claude Code signs in with OAuth (PKCE) on its own,
// through the fixed public client kette-cli when itdone.cloud has it, otherwise through dynamic client registration (DCR)
export const MCP_NAME = 'itdone';
export const MCP_URL = 'https://api.itdone.cloud/mcp';
export const REGISTER_URL = 'https://dashboard.itdone.cloud/login?register=1';
export const CLIENT_ID = 'kette-cli';
export const CALLBACK_PORT = 53761;
const PREFLIGHT_TIMEOUT_MS = 5000;
// Any valid S256 challenge works, the preflight never finishes a login
const PREFLIGHT_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const BASE_ARGS = ['mcp', 'add', '--transport', 'http', '-s', 'user'];
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const EMAIL_PATTERN = /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/;
const CLAUDE_MISSING = `Claude Code not found. Install it with ${cmd('npm install -g @anthropic-ai/claude-code')}, then run ${cmd('kette cloud setup')} again.`;

export const authUrl = (env = process.env) => secureUrl((env.KETTE_CLOUD_AUTH_URL || 'https://auth.itdone.cloud/realms/itdone').replace(/\/$/, ''), 'KETTE_CLOUD_AUTH_URL');
export const validEmail = (email) => typeof email === 'string' && email.length <= 254 && EMAIL_PATTERN.test(email);

// Fixed client from KETTE_CLOUD_CLIENT_ID and KETTE_CLOUD_CALLBACK_PORT, null with --dcr; wrong values stop before anything changes
export function fixedClient(env = process.env, { dcr = false } = {}) {
  if (dcr) return null;
  const clientId = env.KETTE_CLOUD_CLIENT_ID || CLIENT_ID;
  const rawPort = env.KETTE_CLOUD_CALLBACK_PORT || String(CALLBACK_PORT);
  const port = Number(rawPort);
  if (!CLIENT_ID_PATTERN.test(clientId)) throw new ExitError(`KETTE_CLOUD_CLIENT_ID must be 1 to 64 letters, digits, dots, dashes or underscores: ${JSON.stringify(clientId)}`);
  if (!/^\d+$/.test(rawPort) || port < 1024 || port > 65535) throw new ExitError(`KETTE_CLOUD_CALLBACK_PORT must be a port from 1024 to 65535: ${JSON.stringify(rawPort)}`);
  return { clientId, port };
}

// Options before name and URL, so they never mix with the positional arguments
export function addArgs(client) {
  const oauth = client ? ['--client-id', client.clientId, '--callback-port', String(client.port)] : [];
  return [...BASE_ARGS, ...oauth, MCP_NAME, MCP_URL];
}

export function preflightUrl(client, env = process.env) {
  const q = new URLSearchParams({
    client_id: client.clientId,
    response_type: 'code',
    redirect_uri: `http://localhost:${client.port}/callback`,
    code_challenge: PREFLIGHT_CHALLENGE,
    code_challenge_method: 'S256',
  });
  return `${authUrl(env)}/protocol/openid-connect/auth?${q}`;
}

// The Keycloak login page means the client exists and takes the loopback redirect; its error page, a redirect or no answer
// means it is not usable (yet), the caller then falls back to DCR. No cookies are sent, so no session can skip the page.
export async function fixedClientReady(client, { env = process.env, fetchFn = fetch, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  let res;
  let body;
  try {
    res = await fetchFn(preflightUrl(client, env), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    body = await res.text();
  } catch (err) {
    return { ready: false, reason: `itdone.cloud sign-in not reachable: ${err.cause?.code || err.name || err.message}` };
  }
  if (res.status === 200 && !/kc-error-message|client not found/i.test(body)) return { ready: true };
  if (/client not found/i.test(body)) return { ready: false, reason: 'client not found' };
  if (/redirect_uri/i.test(body)) return { ready: false, reason: `redirect to port ${client.port} not allowed` };
  return { ready: false, reason: `HTTP ${res.status}` };
}

// The dashboard passes login_hint on to its Keycloak registration and keeps its own login state. @ stays readable (valid in a query),
// so the Windows opener, which refuses percent signs, still takes a plain address; a plus becomes %2B and is printed there instead.
export function registerUrl(email) {
  if (!validEmail(email)) return REGISTER_URL;
  const hint = encodeURIComponent(email).replace(/%40/g, '@');
  return `${REGISTER_URL}&login_hint=${hint}`;
}

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

// Command that opens a local file (kette theme --preview) in the default app; no shell except cmd.exe on Windows, where
// paths with quotes or cmd metacharacters are refused (null) so the caller prints the path instead
export function openerForFile(file, platform = process.platform) {
  if (!(platform === 'win32' ? path.win32 : path.posix).isAbsolute(file) || /[\r\n]/.test(file)) return null;
  if (platform === 'darwin') return { command: 'open', args: [file], options: {} };
  if (platform === 'win32') return /["%!^&|<>]/.test(file) ? null : { command: 'cmd', args: ['/d', '/c', 'start', '""', `"${file}"`], options: { windowsVerbatimArguments: true } };
  return { command: 'xdg-open', args: [file], options: {} };
}

// true when the opener ran successfully; any error leaves it to the caller to print the link
export function openBrowser(url, { env = process.env, isTTY = process.stdout.isTTY, platform = process.platform, spawn = spawnSync, openerOf = openerFor } = {}) {
  if (!canOpenBrowser(env, { isTTY, platform })) return false;
  const opener = openerOf(url, platform);
  if (!opener) return false;
  const r = spawn(opener.command, opener.args, { stdio: 'ignore', timeout: 10000, ...opener.options });
  return !r.error && r.status === 0;
}

// registered true, false or null (not readable); only URL and the OAuth line are taken from claude mcp get, its headers may carry secrets
// client: 'fixed' (client ID configured), 'dcr' (none) or null when only claude mcp list was readable
export function mcpServer() {
  const get = runClaude(['mcp', 'get', MCP_NAME]);
  if (get.status === 0) {
    const url = get.stdout.match(/^\s*URL:\s*(\S+)/m)?.[1] || null;
    const oauth = get.stdout.match(/^\s*OAuth:.*$/m)?.[0] || '';
    const port = oauth.match(/callback_port\s+(\d+)/)?.[1] || null;
    return { registered: true, url, client: /client_id configured/.test(oauth) ? 'fixed' : 'dcr', port };
  }
  if (/no mcp server named/i.test(output(get))) return { registered: false };
  const list = runClaude(['mcp', 'list']);
  if (list.status !== 0) return { registered: null };
  const url = list.stdout.match(new RegExp(`^${MCP_NAME}:\\s+(\\S+)`, 'm'))?.[1];
  return url ? { registered: true, url, client: null } : { registered: false };
}

const SIGN_IN = { fixed: 'fixed client', dcr: 'dynamic client registration (DCR)' };
export function registeredText(server) {
  const via = server.client === 'fixed' && server.port ? `${SIGN_IN.fixed}, callback port ${server.port}` : SIGN_IN[server.client];
  return `itdone MCP registered${server.url ? ` (${server.url})` : ''}${via ? `, sign-in: ${via}` : ''}`;
}

const switchHint = () => `To switch: ${cmd(`claude mcp remove ${MCP_NAME} -s user`)}, then ${cmd('kette cloud setup')}`;

// An existing entry always stays, the user decides whether to switch
async function existingServer(server, opts) {
  const kept = opts.dryRun ? 'Would stay' : 'Left';
  if (server.url && server.url !== MCP_URL) {
    warn(`${registeredText(server)}, not ${MCP_URL}. ${kept} unchanged. ${switchHint()}`);
    return;
  }
  info(`${registeredText(server)} already, ${kept.toLowerCase()} unchanged`);
  if (server.client !== 'dcr' || opts.dcr) return;
  const client = fixedClient(process.env, opts);
  if ((await fixedClientReady(client)).ready) info(`itdone.cloud now offers the fixed sign-in client ${client.clientId}, no new client is registered per login. ${switchHint()}`);
}

function accountStep(opts, email) {
  if (opts.haveAccount) return;
  const url = registerUrl(email);
  const prefilled = url === REGISTER_URL ? '' : ' (email from your licence prefilled)';
  if (opts.dryRun) { info(`Would open ${url} in the browser${prefilled}`); return; }
  if (openBrowser(url)) ok(`Opened ${url} in the browser${prefilled}, create your itdone.cloud account there`);
  else info(`Create your itdone.cloud account${prefilled}: ${url}`);
}

// Fixed client unless --dcr or itdone.cloud does not have it yet; the fallback is announced, never silent
async function chooseClient(opts) {
  const client = fixedClient(process.env, opts);
  if (!client) { info('Sign-in through dynamic client registration (--dcr)'); return null; }
  const check = await fixedClientReady(client);
  if (check.ready) return client;
  info(`Fixed sign-in client ${client.clientId} not available on itdone.cloud (${check.reason}), using dynamic client registration instead`);
  return null;
}

// false when the server is neither registered nor could be added
async function mcpStep(opts) {
  const server = mcpServer();
  if (server.registered === null) { fail(`Could not read the MCP servers of Claude Code (${cmd(`claude mcp get ${MCP_NAME}`)} and ${cmd('claude mcp list')} fail), nothing changed`); return false; }
  if (server.registered) { await existingServer(server, opts); return true; }
  const client = await chooseClient(opts);
  const args = addArgs(client);
  if (opts.dryRun) { info(`Would run: ${cmd(`claude ${args.join(' ')}`)}`); return true; }
  const r = runClaude(args);
  if (r.status !== 0) { fail(`claude mcp add failed: ${output(r) || `exit code ${r.status}`}. By hand: ${cmd(`claude ${args.join(' ')}`)}`); return false; }
  ok(`itdone MCP registered in Claude Code (scope user): ${MCP_URL}, sign-in: ${client ? `${SIGN_IN.fixed} ${client.clientId}, callback port ${client.port}` : SIGN_IN.dcr}`);
  return true;
}

function nextSteps() {
  const steps = [
    `In Claude Code run ${cmd('/mcp')}, choose ${bold(MCP_NAME)}, then ${bold('Authenticate')}. Your itdone.cloud account is created on the first login.`,
    'Ask Claude to deploy, e.g. "Deploy this app to itdone.cloud". The live-deploy skill deploys only after you confirm.',
  ];
  console.log(['', bold('Next steps:'), ...steps.map((s, i) => `  ${num(`${i + 1}.`)} ${s}`), '', 'kette never asks for or stores a password or token, Claude Code signs in through the browser.'].join('\n'));
}

// email: licence email of an active Enterprise licence on this device, null for Community
async function setup(opts, email) {
  if (!hasClaude()) { fail(CLAUDE_MISSING); return 1; }
  // Wrong overrides stop before the browser opens
  fixedClient(process.env, opts);
  if (opts.dryRun) console.log('Dry run, nothing changes:');
  accountStep(opts, email);
  if (!(await mcpStep(opts))) return 1;
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

export async function cloud(action, opts, { email = null } = {}) {
  if (action === 'setup') return setup(opts, email);
  if (action === 'status') return cloudStatus();
  throw new ExitError('Usage: kette cloud setup [--have-account] [--dcr] [--dry-run] | status');
}
