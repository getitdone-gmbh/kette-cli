import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prng, tmp, write } from './helpers.mjs';
import { FIXTURES, MANIFEST_PATH, buildFrom, formatManifest, loadPairs } from '../scripts/theme-manifest.mjs';
import { contrast, rgbToOklch, toHex } from '../src/theme/color.mjs';
import { HEADER_MARK, fontStack, generateTheme, loadManifest, parseThemeOptions } from '../src/theme/generate.mjs';
import { PREVIEW_MARK, previewHtml } from '../src/theme/preview.mjs';
import { outputPaths } from '../src/theme/command.mjs';
import { openerForFile } from '../src/cloud.mjs';
import { parse } from '../src/cli.mjs';

const bin = fileURLToPath(new URL('../bin/kette.mjs', import.meta.url));
const manifest = loadManifest();
const fixtureCss = fs.readFileSync(FIXTURES.css, 'utf8');
const PAIRS = loadPairs(FIXTURES.pairs);
const PAIR_VARS = [...new Set(PAIRS.flatMap(([, fill, text]) => [fill, text]))];
// Mode blocks found the way the tokens gates (check-pairs.js, check-scopes.js) find them, independent of the manifest builder
const HEADERS = {
  root: '\n:root {',
  dark: '\n.dark {',
  media: '@media (prefers-color-scheme: dark) {\n  :root:not(.light) {',
  paper: '\n.light,\n[data-document-surface],\n[data-surface="paper"] {',
};
function blocks(css) {
  const text = `\n${css.replace(/\r\n/g, '\n')}`;
  return Object.fromEntries(Object.entries(HEADERS).map(([key, header]) => {
    const i = text.indexOf(header);
    assert.ok(i !== -1, `block ${key} missing`);
    const vars = {};
    for (const m of text.slice(i, text.indexOf('}', i)).matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2];
    return [key, vars];
  }));
}
const declared = (css) => new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
const rgb = (v) => v.split(' ').map(Number);
const run = (args, opts = {}) => spawnSync(process.execPath, [bin, 'theme', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KETTE_HOME: tmp(), NO_COLOR: '1' }, ...opts });

test('manifest.json is the current build of the fixtures (rebuild: node scripts/theme-manifest.mjs)', () => {
  const { manifest: fresh, warnings } = buildFrom();
  assert.equal(formatManifest(fresh), fs.readFileSync(MANIFEST_PATH, 'utf8').replace(/\r\n/g, '\n'));
  // 0.4.2 defines every pair side kette theme needs, nothing is derived or skipped
  assert.deepEqual(warnings, []);
  assert.deepEqual(fresh.pairOn, {});
});

test('manifest pairs are exactly color-pairs.js of the tokens (51 with the status pairs), and every pair is checked at 4.5:1', () => {
  assert.equal(PAIRS.length, 51);
  assert.deepEqual(manifest.pairs, PAIRS);
  for (const [label, fill, text] of PAIRS) assert.ok(manifest.checks.some((c) => c.label === label && c.fill === fill && c.text === text && c.min === 4.5 && !c.mode), label);
  assert.equal(new Set(manifest.checks.map((c) => `${c.fill} ${c.text}`)).size, manifest.checks.length);
});

test('the generated theme declares exactly the variables of the Community 0.4.2 theme.css', () => {
  const { css } = generateTheme(parseThemeOptions({ primary: '#0f766e' }));
  const want = declared(fixtureCss);
  const got = declared(css);
  assert.equal(want.size, 1343);
  assert.deepEqual([...got].sort(), [...want].sort());
});

test('every mode block has exactly the Community 0.4.2 variables', () => {
  const want = blocks(fixtureCss);
  for (const primary of ['#0f766e', '#c2410c', '#4f46e5', '#facc15']) {
    const got = blocks(generateTheme(parseThemeOptions({ primary })).css);
    for (const key of Object.keys(HEADERS)) assert.deepEqual(Object.keys(got[key]).sort(), Object.keys(want[key]).sort(), `${primary} ${key}`);
  }
});

test('a dark contrast fix on a variable the dark blocks inherit is pinned in both dark blocks, and with its light value in paper', () => {
  // 0.4.2 declares every dark-checked variable in .dark, so a synthetic dark check on an inherited variable exercises the pin path
  const base = loadManifest();
  const synthetic = { ...base, checks: [...base.checks, { label: 'synthetic', fill: '--colors-background', text: '--semantic-text-on-paper', min: 4.5, mode: 'dark' }] };
  assert.ok(base.colors['--semantic-text-on-paper'].inherit);
  const { css, tokens } = generateTheme(parseThemeOptions({ primary: '#0f766e' }), { manifest: synthetic });
  const fix = tokens.adjustments.find((a) => a.name === '--semantic-text-on-paper');
  assert.equal(fix.mode, 'dark');
  const b = blocks(css);
  const darkValue = b.dark['--semantic-text-on-paper'];
  assert.ok(darkValue && darkValue === b.media['--semantic-text-on-paper']);
  assert.equal(b.paper['--semantic-text-on-paper'], b.root['--semantic-text-on-paper']);
  assert.ok(contrast(rgb(b.dark['--colors-background']), rgb(darkValue)) >= 4.5);
});

// Mirrors kette-design-community src/lib/theme-pairs.test.ts (0.4.2): pairs travel together, the dark blocks pin the pair variables
// of :root, the destructive button text is defined everywhere, paper is light, OS dark equals .dark
test('pairs and scopes hold the kette-design-community 0.4.2 rules', () => {
  for (const primary of ['#0f766e', '#c2410c', '#4f46e5', '#facc15']) {
    const b = blocks(generateTheme(parseThemeOptions({ primary, neutral: 'warm', accent: '#db2777' })).css);
    for (const [key, vars] of Object.entries(b)) {
      for (const [label, fill, text, shared] of PAIRS) {
        assert.ok(!(fill in vars) || text in vars, `${primary} ${key} ${label}: fill without text`);
        assert.ok(!(text in vars) || fill in vars || shared, `${primary} ${key} ${label}: text without fill`);
      }
      assert.ok('--colors-button-foreground-destructive' in vars, `${primary} ${key} destructive button text`);
    }
    for (const v of PAIR_VARS.filter((x) => x in b.root)) assert.ok(v in b.dark && v in b.media, `${primary} pins ${v}`);
    for (const [name, value] of Object.entries(b.paper)) if (name in b.root) assert.equal(value, b.root[name], `${primary} paper ${name}`);
    assert.deepEqual(b.media, b.dark);
  }
});

test('random inputs never emit a pair below its minimum, read back from the CSS in light, .dark, OS dark and paper inside .dark', () => {
  const rand = prng(42);
  const hex = () => toHex([0, 0, 0].map(() => Math.floor(rand() * 256)));
  const neutrals = ['cool', 'warm', 'neutral'];
  const radii = ['none', 'sm', 'md', 'lg', 'full', '6'];
  for (let i = 0; i < 120; i++) {
    const raw = { primary: hex(), accent: rand() < 0.5 ? hex() : undefined, neutral: rand() < 0.75 ? neutrals[i % 3] : hex(), radius: radii[i % radii.length] };
    const { css, tokens } = generateTheme(parseThemeOptions(raw));
    assert.equal(tokens.contrast.failing, 0, JSON.stringify(raw));
    const b = blocks(css);
    const contexts = [
      ['light', 'light', b.root],
      ['.dark', 'dark', { ...b.root, ...b.dark }],
      ['OS dark', 'dark', { ...b.root, ...b.media }],
      ['paper in .dark', 'light', { ...b.root, ...b.dark, ...b.paper }],
    ];
    for (const [scope, mode, vars] of contexts) {
      for (const c of manifest.checks.filter((k) => !k.mode || k.mode === mode)) {
        if (!(c.fill in vars) || !(c.text in vars)) continue;
        const ratio = contrast(rgb(vars[c.fill]), rgb(vars[c.text]));
        assert.ok(ratio >= c.min, `${JSON.stringify(raw)} ${scope} ${c.label}: ${ratio.toFixed(2)}`);
      }
    }
  }
});

test('the base brand colour with cool neutrals reproduces the Community 0.4.2 values exactly, with no adjustment', () => {
  const { css, tokens } = generateTheme(parseThemeOptions({ primary: '#2563eb' }));
  assert.deepEqual(tokens.adjustments, []);
  const want = blocks(fixtureCss);
  const got = blocks(css);
  for (const key of Object.keys(HEADERS)) {
    for (const [name, value] of Object.entries(want[key])) if (/^\d+ \d+ \d+$/.test(value)) assert.equal(got[key][name], value, `${key} ${name}`);
  }
});

test('same inputs give the same output, and the primary colour itself is kept exactly', () => {
  const opts = { primary: '#0f766e', accent: '#f59e0b', neutral: 'warm', radius: 'lg', font: 'IBM Plex Sans', name: 'acme' };
  const a = generateTheme(parseThemeOptions(opts), { version: '9.9.9' });
  const b = generateTheme(parseThemeOptions(opts), { version: '9.9.9' });
  assert.equal(a.css, b.css);
  assert.deepEqual(a.tokens, b.tokens);
  assert.equal(a.tokens.light['--colors-primary'], '#0f766e');
  assert.equal(a.tokens.palettes.primary[600], '#0f766e');
  assert.ok(a.css.startsWith(`${HEADER_MARK}"acme", generated by kette-cli 9.9.9`));
  assert.match(a.css, /kette-tokens/);
  assert.notEqual(generateTheme(parseThemeOptions({ ...opts, neutral: 'cool' })).css, a.css);
});

test('neutral, accent, radius and font reach the CSS', () => {
  const grey = generateTheme(parseThemeOptions({ primary: '#0f766e', neutral: 'neutral' })).tokens;
  for (const name of ['--colors-utility-muted', '--colors-utility-border', '--semantic-text-subtle']) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(grey.light[name].slice(i, i + 2), 16));
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 1, `${name} ${grey.light[name]} is grey`);
  }
  const warm = generateTheme(parseThemeOptions({ primary: '#0f766e', neutral: 'warm' })).tokens;
  const hue = rgbToOklch([1, 3, 5].map((i) => parseInt(warm.light['--colors-utility-border'].slice(i, i + 2), 16))).h;
  assert.ok(hue > 30 && hue < 90, `warm border hue ${hue}`);
  const accent = generateTheme(parseThemeOptions({ primary: '#0f766e', accent: '#db2777' })).tokens;
  assert.notEqual(accent.light['--colors-utility-accent'], grey.light['--colors-utility-accent']);
  assert.ok(accent.palettes.accent);

  const radius = (r) => generateTheme(parseThemeOptions({ primary: '#0f766e', radius: r })).tokens.radius;
  assert.ok(Object.values(radius('none')).every((v) => v === '0px'));
  assert.equal(radius('md')['--borderRadius-card'], '12px');
  assert.equal(radius('lg')['--borderRadius-button'], '12px');
  assert.equal(radius('16px')['--borderRadius-card'], '24px');
  const full = radius('full');
  assert.equal(full['--borderRadius-button'], '9999px');
  assert.equal(full['--borderRadius-card'], '24px');
  assert.equal(full['--borderRadius-checkbox'], '4px');

  const { css } = generateTheme(parseThemeOptions({ primary: '#0f766e', font: 'IBM Plex Sans' }));
  assert.match(css, /--font-sans: "IBM Plex Sans", system-ui, sans-serif;/);
});

test('option parsing accepts the documented values and refuses the rest with a usage error', () => {
  const o = parseThemeOptions({ primary: '0f766e', neutral: 'WARM', radius: '12px' });
  assert.deepEqual(o, { primary: [15, 118, 110], accent: null, neutral: 'warm', radius: 12, font: null, name: 'custom-0f766e' });
  assert.equal(parseThemeOptions({ primary: '#0f766e', radius: 'full' }).radius, 'full');
  assert.deepEqual(parseThemeOptions({ primary: '#0f766e', neutral: '#78716c' }).neutral, [120, 113, 108]);
  const bad = [
    [{}, /--primary is required/],
    [{ primary: 'teal' }, /--primary needs a hex colour/],
    [{ primary: '#0f766e', accent: '#12' }, /--accent needs a hex colour/],
    [{ primary: '#0f766e', neutral: 'blue' }, /--neutral/],
    [{ primary: '#0f766e', radius: '65' }, /--radius needs/],
    [{ primary: '#0f766e', radius: 'round' }, /--radius needs/],
    [{ primary: '#0f766e', name: 'Acme Corp' }, /--name needs/],
    [{ primary: '#0f766e', font: 'Inter; } body { color: red' }, /--font needs/],
    [{ primary: '#0f766e', font: '</style><script>' }, /--font needs/],
  ];
  for (const [raw, msg] of bad) assert.throws(() => parseThemeOptions(raw), (err) => err.usage === true && msg.test(err.message), JSON.stringify(raw));
  assert.equal(fontStack('Inter'), 'Inter, system-ui, sans-serif');
  assert.equal(fontStack('Source Sans 3, serif'), '"Source Sans 3", serif');
});

test('kette theme flags are parsed as values and switches', () => {
  const opts = parse(['theme', '--primary', '#0f766e', '--accent', '#f59e0b', '--neutral', 'warm', '--radius', 'lg', '--font', 'IBM Plex Sans', '--name', 'acme', '--out', 'x/theme.css', '--preview', '--json', '--dry-run']);
  assert.deepEqual(opts, { _: ['theme'], primary: '#0f766e', accent: '#f59e0b', neutral: 'warm', radius: 'lg', font: 'IBM Plex Sans', name: 'acme', out: 'x/theme.css', preview: true, json: true, dryRun: true });
  assert.throws(() => parse(['theme', '--primary']), /--primary needs a value/);
});

test('without a terminal kette theme needs --primary and stops with exit code 2', () => {
  const r = run([], { cwd: tmp() });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--primary is required without a terminal/);
});

test('--dry-run writes nothing and --json prints the tokens with the contrast report', () => {
  const dir = tmp();
  const dry = run(['--primary', '#0f766e', '--dry-run', '--preview'], { cwd: dir });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would write .*theme\.css/);
  assert.match(dry.stdout, /Dry run, nothing written/);
  assert.match(dry.stdout, /kette-tokens/);
  assert.deepEqual(fs.readdirSync(dir), []);

  const json = run(['--primary', '#c2410c', '--json', '--dry-run'], { cwd: dir });
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.equal(data.inputs.primary, '#c2410c');
  assert.equal(data.written, false);
  assert.equal(data.contrast.failing, 0);
  assert.equal(data.checks.length, data.contrast.checked);
  assert.ok(data.checks.length > manifest.checks.length);
  assert.equal(data.light['--colors-primary'], '#c2410c');
  assert.ok(data.dark['--colors-background']);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('kette theme writes theme.css and the preview into a folder with spaces, keeps foreign files unless --yes', () => {
  const dir = path.join(tmp(), 'my brand', 'styles');
  const r = run(['--primary', '#4f46e5', '--out', `${dir}${path.sep}`, '--preview', '--name', 'indigo'], { cwd: tmp() });
  assert.equal(r.status, 0, r.stderr);
  const css = fs.readFileSync(path.join(dir, 'theme.css'), 'utf8');
  assert.ok(css.startsWith(`${HEADER_MARK}"indigo"`));
  assert.ok(fs.readFileSync(path.join(dir, 'theme-preview.html'), 'utf8').includes(PREVIEW_MARK));

  // Rewriting its own file is fine, a file it did not write needs --yes
  assert.equal(run(['--primary', '#0f766e', '--out', path.join(dir, 'theme.css')]).status, 0);
  const foreign = path.join(tmp(), 'theme.css');
  write(path.dirname(foreign), 'theme.css', ':root { --mine: 1; }');
  const refused = run(['--primary', '#0f766e', '--out', foreign]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not generated by kette theme/);
  assert.equal(fs.readFileSync(foreign, 'utf8'), ':root { --mine: 1; }');
  assert.equal(run(['--primary', '#0f766e', '--out', foreign, '--yes']).status, 0);
  assert.ok(fs.readFileSync(foreign, 'utf8').startsWith(HEADER_MARK));
});

test('output paths: a file, an existing folder, a trailing separator; the preview sits next to the CSS', () => {
  const dir = tmp();
  assert.deepEqual(outputPaths(undefined, dir), { css: path.join(dir, 'theme.css'), preview: path.join(dir, 'theme-preview.html') });
  assert.equal(outputPaths('brand.css', dir).css, path.join(dir, 'brand.css'));
  fs.mkdirSync(path.join(dir, 'styles'));
  assert.equal(outputPaths('styles', dir).css, path.join(dir, 'styles', 'theme.css'));
  assert.equal(outputPaths(`new${path.sep}`, dir).preview, path.join(dir, 'new', 'theme-preview.html'));
});

test('the preview is self-contained and shows both modes, palettes and every contrast check', () => {
  const result = generateTheme(parseThemeOptions({ primary: '#0f766e', accent: '#f59e0b' }));
  const html = previewHtml(result);
  assert.doesNotMatch(html, /<(script|link)\b/i);
  assert.doesNotMatch(html, /(src|href)=["']?https?:/i);
  assert.ok(html.includes(result.css));
  assert.match(html, /class="panel light"/);
  assert.match(html, /class="panel dark"/);
  for (const p of ['primary', 'neutral', 'accent']) assert.match(html, new RegExp(`<strong>${p}</strong>`));
  assert.equal((html.match(/<td class="pass">PASS<\/td>/g) || []).length, result.tokens.checks.length);
  assert.doesNotMatch(html, /FAIL/);
  assert.match(html, /kette-tokens/);
});

test('local files open without a shell, and on Windows only paths cmd.exe cannot misread', () => {
  assert.deepEqual(openerForFile('/tmp/a b/theme-preview.html', 'darwin'), { command: 'open', args: ['/tmp/a b/theme-preview.html'], options: {} });
  assert.deepEqual(openerForFile('/tmp/theme-preview.html', 'linux'), { command: 'xdg-open', args: ['/tmp/theme-preview.html'], options: {} });
  assert.equal(openerForFile('C:\\Users\\Max Muster\\theme-preview.html', 'win32').args.at(-1), '"C:\\Users\\Max Muster\\theme-preview.html"');
  assert.equal(openerForFile('C:\\a&b\\theme-preview.html', 'win32'), null);
  assert.equal(openerForFile('relative/theme-preview.html', 'darwin'), null);
});
