import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { capture, fakeClaude, serve, tmp } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { MCP_URL, REGISTER_URL, addArgs, canOpenBrowser, fixedClient, fixedClientReady, openBrowser, openerFor, preflightUrl, registerUrl } from '../src/cloud.mjs';

const ADD = `mcp add --transport http -s user itdone ${MCP_URL}`;
const ADD_FIXED = `mcp add --transport http -s user --client-id kette-cli --callback-port 53761 itdone ${MCP_URL}`;
const run = (...argv) => capture(() => main(argv));
let claude;
const ci = process.env.CI;
const saved = { ...process.env };
const CLOUD_ENV = ['KETTE_CLOUD_AUTH_URL', 'KETTE_CLOUD_CLIENT_ID', 'KETTE_CLOUD_CALLBACK_PORT'];

// Stand-in for the itdone.cloud Keycloak: the login page for a known client, the error page Keycloak shows otherwise
const KEYCLOAK_LOGIN = '<html><title>Sign in to itdone</title><form id="kc-form-login"></form></html>';
const KEYCLOAK_ERROR = (text) => `<html><title>Sign in to itdone</title><div id="kc-error-message"><p class="instruction">${text}</p></div></html>`;
let keycloak;
let knownClients = [];
const preflights = [];

// Never a real browser or network from the tests: CI makes every run headless, the preflight goes to the stand-in
before(async () => {
  process.env.CI = '1';
  process.env.KETTE_HOME = tmp();
  keycloak = await serve((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    preflights.push(Object.fromEntries(q));
    const known = knownClients.includes(q.get('client_id'));
    // connection: close, so fetch never reuses a socket the server is about to drop (flaky under load)
    res.writeHead(known ? 200 : 400, { 'content-type': 'text/html', connection: 'close' });
    res.end(known ? KEYCLOAK_LOGIN : KEYCLOAK_ERROR('Client not found.'));
  });
});
after(async () => {
  await keycloak.close();
  if (ci === undefined) delete process.env.CI; else process.env.CI = ci;
});
beforeEach(() => {
  claude = null;
  knownClients = [];
  preflights.length = 0;
  for (const k of CLOUD_ENV) delete process.env[k];
  process.env.KETTE_CLOUD_AUTH_URL = `${keycloak.url}/realms/itdone`;
});
afterEach(() => {
  claude?.restore();
  for (const k of CLOUD_ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

test('cloud setup falls back to DCR with an info line while itdone.cloud has no fixed client, and prints the next steps', async () => {
  claude = fakeClaude();
  const { result, out } = await run('cloud', 'setup');
  assert.match(out, /INFO Fixed sign-in client kette-cli not available on itdone\.cloud \(client not found\), using dynamic client registration instead/);
  assert.equal(result, 0);
  assert.ok(claude.calls().includes(ADD), claude.calls().join('\n'));
  assert.ok(!claude.calls().some((c) => /header|-H |token|auth/i.test(c)), 'no auth header or token on any call');
  assert.deepEqual(claude.mcp(), { itdone: MCP_URL });
  assert.match(out, /OK {3}itdone MCP registered in Claude Code \(scope user\): https:\/\/api\.itdone\.cloud\/mcp, sign-in: dynamic client registration \(DCR\)/);
  assert.match(out, /Next steps:\n {2}1\. In Claude Code run \/mcp, choose itdone, then Authenticate\. Your itdone\.cloud account is created on the first login\.\n {2}2\. Ask Claude to deploy.*live-deploy skill deploys only after you confirm/);
});

test('cloud setup headless prints the registration link instead of opening a browser', async () => {
  claude = fakeClaude();
  const { out } = await run('cloud', 'setup');
  assert.ok(out.includes(`INFO Create your itdone.cloud account: ${REGISTER_URL}`));
  assert.doesNotMatch(out, /Opened/);
});

test('cloud setup keeps an existing itdone entry, shows its URL and never prints its headers', async () => {
  claude = fakeClaude([], '', {}, { itdone: MCP_URL });
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.ok(!claude.calls().some((c) => c.startsWith('mcp add')), 'never overwrites');
  assert.match(out, /INFO itdone MCP registered \(https:\/\/api\.itdone\.cloud\/mcp\), sign-in: dynamic client registration \(DCR\) already, left unchanged/);
  assert.doesNotMatch(out, /fake-secret-value|Authorization/);
  assert.doesNotMatch(out, /To switch/, 'no switch hint while the fixed client is missing');
  assert.match(out, /Next steps:/);
});

test('cloud setup keeps a DCR entry and says how to switch once the fixed client is live', async () => {
  knownClients = ['kette-cli'];
  claude = fakeClaude([], '', {}, { itdone: MCP_URL });
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.ok(!claude.calls().some((c) => c.startsWith('mcp add') || c.startsWith('mcp remove')), 'never overwrites or removes');
  assert.match(out, /INFO itdone\.cloud now offers the fixed sign-in client kette-cli, no new client is registered per login\. To switch: claude mcp remove itdone -s user, then kette cloud setup/);
});

test('cloud setup keeps a fixed-client entry without a preflight or switch hint', async () => {
  knownClients = ['kette-cli'];
  claude = fakeClaude([], '', {}, { itdone: { url: MCP_URL, port: 53761 } });
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.match(out, /INFO itdone MCP registered \(https:\/\/api\.itdone\.cloud\/mcp\), sign-in: fixed client, callback port 53761 already, left unchanged/);
  assert.doesNotMatch(out, /To switch/);
  assert.equal(preflights.length, 0);
});

test('cloud setup registers the fixed client kette-cli on port 53761 when itdone.cloud has it', async () => {
  knownClients = ['kette-cli'];
  claude = fakeClaude();
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.ok(claude.calls().includes(ADD_FIXED), claude.calls().join('\n'));
  assert.deepEqual(claude.mcp(), { itdone: { url: MCP_URL, clientId: 'kette-cli', port: 53761 } });
  assert.match(out, /OK {3}itdone MCP registered in Claude Code \(scope user\): https:\/\/api\.itdone\.cloud\/mcp, sign-in: fixed client kette-cli, callback port 53761/);
  assert.doesNotMatch(out, /dynamic client registration/);
  assert.equal(preflights[0].redirect_uri, 'http://localhost:53761/callback');
  assert.equal(preflights[0].code_challenge_method, 'S256');
});

test('cloud setup takes client ID and port from KETTE_CLOUD_CLIENT_ID and KETTE_CLOUD_CALLBACK_PORT', async () => {
  knownClients = ['acme-cli'];
  process.env.KETTE_CLOUD_CLIENT_ID = 'acme-cli';
  process.env.KETTE_CLOUD_CALLBACK_PORT = '54000';
  claude = fakeClaude();
  const { result } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.deepEqual(claude.mcp(), { itdone: { url: MCP_URL, clientId: 'acme-cli', port: 54000 } });
  assert.equal(preflights[0].client_id, 'acme-cli');
  assert.equal(preflights[0].redirect_uri, 'http://localhost:54000/callback');
});

test('cloud setup --dcr registers without a client ID and skips the preflight', async () => {
  knownClients = ['kette-cli'];
  claude = fakeClaude();
  const { result, out } = await run('cloud', 'setup', '--have-account', '--dcr');
  assert.equal(result, 0);
  assert.ok(claude.calls().includes(ADD), claude.calls().join('\n'));
  assert.deepEqual(claude.mcp(), { itdone: MCP_URL });
  assert.match(out, /INFO Sign-in through dynamic client registration \(--dcr\)/);
  assert.equal(preflights.length, 0);
});

test('cloud setup stops on a wrong client override before anything changes', async () => {
  claude = fakeClaude();
  process.env.KETTE_CLOUD_CALLBACK_PORT = '80';
  await assert.rejects(() => run('cloud', 'setup'), (err) => err.exitCode === 2 && /KETTE_CLOUD_CALLBACK_PORT must be a port from 1024 to 65535: "80"/.test(err.message));
  process.env.KETTE_CLOUD_CALLBACK_PORT = '53761';
  process.env.KETTE_CLOUD_CLIENT_ID = 'a b';
  await assert.rejects(() => run('cloud', 'setup'), (err) => err.exitCode === 2 && /KETTE_CLOUD_CLIENT_ID/.test(err.message));
  assert.ok(!claude.calls().some((c) => c.startsWith('mcp')));
});

test('cloud setup warns when itdone points elsewhere and leaves it unchanged', async () => {
  claude = fakeClaude([], '', {}, { itdone: 'https://example.test/mcp' });
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.deepEqual(claude.mcp(), { itdone: 'https://example.test/mcp' });
  assert.match(out, /WARN itdone MCP registered \(https:\/\/example\.test\/mcp\), sign-in: dynamic client registration \(DCR\), not https:\/\/api\.itdone\.cloud\/mcp\. Left unchanged\. To switch: claude mcp remove itdone -s user, then kette cloud setup/);
});

test('cloud setup --have-account skips the registration link', async () => {
  claude = fakeClaude();
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.ok(!out.includes(REGISTER_URL));
  assert.deepEqual(claude.mcp(), { itdone: MCP_URL });
});

test('cloud setup --dry-run neither opens the link nor adds the server', async () => {
  claude = fakeClaude();
  const { result, out } = await run('cloud', 'setup', '--dry-run');
  assert.equal(result, 0);
  assert.ok(!claude.calls().some((c) => c.startsWith('mcp add')));
  assert.deepEqual(claude.mcp(), {});
  assert.ok(out.includes(`INFO Would open ${REGISTER_URL} in the browser`));
  assert.ok(out.includes(`INFO Would run: claude ${ADD}`));
});

test('cloud setup without Claude Code stops with a clear message and exit 1', async () => {
  claude = fakeClaude([], '', { '--version': { code: 1 } });
  const { result, out } = await run('cloud', 'setup');
  assert.equal(result, 1);
  assert.match(out, /FAIL Claude Code not found\. Install it with npm install -g @anthropic-ai\/claude-code, then run kette cloud setup again\./);
  assert.ok(!claude.calls().some((c) => c.startsWith('mcp')));
});

test('cloud setup fails when claude mcp add fails and names the command', async () => {
  claude = fakeClaude([], '', { [ADD]: { code: 1, out: 'boom' } });
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 1);
  assert.ok(out.includes(`FAIL claude mcp add failed: boom. By hand: claude ${ADD}`));
  assert.doesNotMatch(out, /Next steps/);
});

test('cloud setup changes nothing when the MCP servers are not readable', async () => {
  claude = fakeClaude([], '', { 'mcp get itdone': { code: 1, out: 'crash' }, 'mcp list': { code: 1 } });
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 1);
  assert.match(out, /FAIL Could not read the MCP servers of Claude Code/);
  assert.ok(!claude.calls().some((c) => c.startsWith('mcp add')));
});

test('cloud setup falls back to claude mcp list when mcp get fails', async () => {
  claude = fakeClaude([], '', { 'mcp get itdone': { code: 1, out: 'crash' } }, { itdone: MCP_URL });
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.match(out, /INFO itdone MCP registered \(https:\/\/api\.itdone\.cloud\/mcp\) already/);
  assert.equal(preflights.length, 0, 'sign-in method unknown from mcp list, no switch hint');
});

test('cloud status reports both states with exit 0', async () => {
  claude = fakeClaude();
  let r = await run('cloud', 'status');
  assert.equal(r.result, 0);
  assert.match(r.out, /^INFO itdone MCP not registered\. Live deploy: kette cloud setup$/);
  claude.restore();
  claude = fakeClaude([], '', {}, { itdone: MCP_URL });
  r = await run('cloud', 'status');
  assert.equal(r.result, 0);
  assert.equal(r.out, `OK   itdone MCP registered (${MCP_URL}), sign-in: dynamic client registration (DCR)`);
  claude.restore();
  claude = fakeClaude([], '', {}, { itdone: { url: MCP_URL, port: 53761 } });
  r = await run('cloud', 'status');
  assert.equal(r.out, `OK   itdone MCP registered (${MCP_URL}), sign-in: fixed client, callback port 53761`);
});

test('cloud with an unknown action stops with usage and exit 2', async () => {
  await assert.rejects(() => main(['cloud', 'deploy']), (err) => err.exitCode === 2 && /Usage: kette cloud setup/.test(err.message));
});

test('doctor names the itdone MCP as OK or INFO and never counts it as a problem', async () => {
  claude = fakeClaude();
  let r = await run('doctor');
  assert.match(r.out, /\nINFO Live deploy: kette cloud setup\n/);
  assert.doesNotMatch(r.out, /FAIL.*(itdone|cloud)/);
  claude.restore();
  claude = fakeClaude([], '', {}, { itdone: MCP_URL });
  r = await run('doctor');
  assert.ok(r.out.includes(`OK   itdone MCP registered (${MCP_URL}), sign-in: dynamic client registration (DCR)`));
  claude.restore();
  claude = fakeClaude([], '', {}, { itdone: { url: MCP_URL, port: 53761 } });
  assert.ok((await run('doctor')).out.includes(`OK   itdone MCP registered (${MCP_URL}), sign-in: fixed client, callback port 53761`));
  assert.doesNotMatch((await run('doctor', '--ci')).out, /itdone/);
});

test('opener per platform; Windows quotes the link for cmd and refuses unsafe characters', () => {
  assert.deepEqual(openerFor(REGISTER_URL, 'darwin'), { command: 'open', args: [REGISTER_URL], options: {} });
  assert.deepEqual(openerFor(REGISTER_URL, 'linux'), { command: 'xdg-open', args: [REGISTER_URL], options: {} });
  const win = openerFor('https://a.test/x?register=1&b=2', 'win32');
  assert.deepEqual(win, { command: 'cmd', args: ['/d', '/c', 'start', '""', '"https://a.test/x?register=1&b=2"'], options: { windowsVerbatimArguments: true } });
  for (const bad of ['https://a.test/"&calc', 'https://a.test/%PATH%', 'https://a.test/!x!', 'https://a.test/a b', 'https://a.test/\r\nx', 'http://a.test/', 'file:///etc/passwd']) {
    assert.equal(openerFor(bad, 'win32'), null, bad);
  }
});

test('browser only with a terminal and a display, failure falls back to the link', () => {
  const tty = { isTTY: true, platform: 'darwin' };
  assert.equal(canOpenBrowser({}, tty), true);
  assert.equal(canOpenBrowser({}, { ...tty, isTTY: false }), false);
  assert.equal(canOpenBrowser({ CI: '1' }, tty), false);
  assert.equal(canOpenBrowser({ SSH_CONNECTION: '1 2 3 4' }, tty), false);
  assert.equal(canOpenBrowser({}, { isTTY: true, platform: 'linux' }), false);
  assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, { isTTY: true, platform: 'linux' }), true);
  const spawned = [];
  const spawn = (command, args, options) => { spawned.push({ command, args, options }); return { status: 0 }; };
  assert.equal(openBrowser(REGISTER_URL, { env: {}, ...tty, spawn }), true);
  assert.deepEqual(spawned[0].args, [REGISTER_URL]);
  assert.equal(openBrowser(REGISTER_URL, { env: {}, ...tty, spawn: () => ({ status: 1 }) }), false);
  assert.equal(openBrowser(REGISTER_URL, { env: {}, ...tty, spawn: () => ({ error: new Error('ENOENT') }) }), false);
  assert.equal(openBrowser(REGISTER_URL, { env: { CI: '1' }, ...tty, spawn: () => assert.fail('no spawn when headless') }), false);
});

test('add arguments put the OAuth options before name and URL', () => {
  assert.deepEqual(addArgs(null), ['mcp', 'add', '--transport', 'http', '-s', 'user', 'itdone', MCP_URL]);
  assert.deepEqual(addArgs({ clientId: 'kette-cli', port: 53761 }), ['mcp', 'add', '--transport', 'http', '-s', 'user', '--client-id', 'kette-cli', '--callback-port', '53761', 'itdone', MCP_URL]);
  assert.deepEqual(fixedClient({}), { clientId: 'kette-cli', port: 53761 });
  assert.equal(fixedClient({}, { dcr: true }), null);
  assert.deepEqual(fixedClient({ KETTE_CLOUD_CLIENT_ID: 'x.y_z-1', KETTE_CLOUD_CALLBACK_PORT: '65535' }), { clientId: 'x.y_z-1', port: 65535 });
  for (const port of ['0', '1023', '65536', '5376a', '-1', '']) {
    if (port === '') continue;
    assert.throws(() => fixedClient({ KETTE_CLOUD_CALLBACK_PORT: port }), /KETTE_CLOUD_CALLBACK_PORT/, port);
  }
  for (const id of ['a b', 'a"b', 'x'.repeat(65), 'a&b']) assert.throws(() => fixedClient({ KETTE_CLOUD_CLIENT_ID: id }), /KETTE_CLOUD_CLIENT_ID/, id);
});

test('preflight asks the realm for the client with a loopback redirect and PKCE', () => {
  const url = new URL(preflightUrl({ clientId: 'kette-cli', port: 53761 }, {}));
  assert.equal(url.origin + url.pathname, 'https://auth.itdone.cloud/realms/itdone/protocol/openid-connect/auth');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: 'kette-cli', response_type: 'code', redirect_uri: 'http://localhost:53761/callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
  });
  assert.throws(() => preflightUrl({ clientId: 'kette-cli', port: 53761 }, { KETTE_CLOUD_AUTH_URL: 'http://auth.example.test/realms/x' }), /must be an https URL/);
});

test('preflight: login page is ready, error page, redirect and network errors fall back', async () => {
  const client = { clientId: 'kette-cli', port: 53761 };
  const reply = (status, body) => async () => ({ status, text: async () => body });
  assert.deepEqual(await fixedClientReady(client, { env: {}, fetchFn: reply(200, KEYCLOAK_LOGIN) }), { ready: true });
  assert.deepEqual(await fixedClientReady(client, { env: {}, fetchFn: reply(400, KEYCLOAK_ERROR('Client not found.')) }), { ready: false, reason: 'client not found' });
  assert.deepEqual(await fixedClientReady(client, { env: {}, fetchFn: reply(400, KEYCLOAK_ERROR('Invalid parameter: redirect_uri')) }), { ready: false, reason: 'redirect to port 53761 not allowed' });
  assert.deepEqual(await fixedClientReady(client, { env: {}, fetchFn: reply(302, '') }), { ready: false, reason: 'HTTP 302' });
  assert.deepEqual(await fixedClientReady(client, { env: {}, fetchFn: reply(200, KEYCLOAK_ERROR('Something else')) }), { ready: false, reason: 'HTTP 200' });
  const offline = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  assert.deepEqual(await fixedClientReady(client, { env: {}, fetchFn: offline }), { ready: false, reason: 'itdone.cloud sign-in not reachable: ENOTFOUND' });
  let init;
  await fixedClientReady(client, { env: {}, fetchFn: async (u, i) => { init = i; return { status: 200, text: async () => KEYCLOAK_LOGIN }; } });
  assert.equal(init.redirect, 'manual', 'a redirect is never followed');
  assert.ok(init.signal, 'the preflight has a timeout');
});

test('cloud setup falls back to DCR when the sign-in server is not reachable', async () => {
  process.env.KETTE_CLOUD_AUTH_URL = 'http://127.0.0.1:9/realms/itdone';
  claude = fakeClaude();
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.deepEqual(claude.mcp(), { itdone: MCP_URL });
  assert.match(out, /INFO Fixed sign-in client kette-cli not available on itdone\.cloud \(itdone\.cloud sign-in not reachable: \w+\), using dynamic client registration instead/);
});

test('signup link prefills a valid licence email through the dashboard login, otherwise the plain dashboard link', () => {
  assert.equal(registerUrl(null), REGISTER_URL);
  assert.equal(registerUrl(''), REGISTER_URL);
  assert.equal(registerUrl('not-an-email'), REGISTER_URL);
  assert.equal(registerUrl('a b@example.com'), REGISTER_URL);
  assert.equal(registerUrl('kunde@example.com'), 'https://dashboard.itdone.cloud/login?register=1&login_hint=kunde@example.com');
  const plus = new URL(registerUrl('a.b+team@example.com'));
  assert.equal(plus.origin + plus.pathname, 'https://dashboard.itdone.cloud/login');
  assert.equal(plus.searchParams.get('register'), '1');
  assert.equal(plus.searchParams.get('login_hint'), 'a.b+team@example.com', 'a plus is encoded, so it does not turn into a space');
  assert.equal(openerFor(registerUrl('kunde@example.com'), 'win32').command, 'cmd', 'a plain address still opens on Windows');
  assert.equal(openerFor(registerUrl('a.b+team@example.com'), 'win32'), null, 'the encoded plus is refused on Windows, the link is printed');
});

test('cloud setup for Community opens the signup without a prefilled email', async () => {
  claude = fakeClaude();
  const { out } = await run('cloud', 'setup', '--dry-run');
  assert.ok(out.includes(`INFO Would open ${REGISTER_URL} in the browser\n`), out);
  assert.doesNotMatch(out, /login_hint|prefilled/);
});
