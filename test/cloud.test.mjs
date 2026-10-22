import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { capture, fakeClaude, tmp } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { MCP_URL, REGISTER_URL, canOpenBrowser, openBrowser, openerFor } from '../src/cloud.mjs';

const ADD = `mcp add --transport http -s user itdone ${MCP_URL}`;
const run = (...argv) => capture(() => main(argv));
let claude;
const ci = process.env.CI;

// Never a real browser from the tests: CI makes every run headless
before(() => { process.env.CI = '1'; process.env.KETTE_HOME = tmp(); });
after(() => { if (ci === undefined) delete process.env.CI; else process.env.CI = ci; });
beforeEach(() => { claude = null; });
afterEach(() => claude?.restore());

test('cloud setup registers the itdone MCP server without any header and prints the next steps', async () => {
  claude = fakeClaude();
  const { result, out } = await run('cloud', 'setup');
  assert.equal(result, 0);
  assert.ok(claude.calls().includes(ADD), claude.calls().join('\n'));
  assert.ok(!claude.calls().some((c) => /header|-H |token|auth/i.test(c)), 'no auth header or token on any call');
  assert.deepEqual(claude.mcp(), { itdone: MCP_URL });
  assert.match(out, /OK {3}itdone MCP registered in Claude Code \(scope user\): https:\/\/api\.itdone\.cloud\/mcp/);
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
  assert.match(out, /INFO itdone MCP registered \(https:\/\/api\.itdone\.cloud\/mcp\) already, left unchanged/);
  assert.doesNotMatch(out, /fake-secret-value|Authorization/);
  assert.match(out, /Next steps:/);
});

test('cloud setup warns when itdone points elsewhere and leaves it unchanged', async () => {
  claude = fakeClaude([], '', {}, { itdone: 'https://example.test/mcp' });
  const { result, out } = await run('cloud', 'setup', '--have-account');
  assert.equal(result, 0);
  assert.deepEqual(claude.mcp(), { itdone: 'https://example.test/mcp' });
  assert.match(out, /WARN itdone MCP registered \(https:\/\/example\.test\/mcp\), not https:\/\/api\.itdone\.cloud\/mcp\. Left unchanged\. To switch: claude mcp remove itdone -s user && kette cloud setup/);
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
  assert.equal(r.out, `OK   itdone MCP registered (${MCP_URL})`);
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
  assert.ok(r.out.includes(`OK   itdone MCP registered (${MCP_URL})`));
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
