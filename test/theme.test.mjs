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
// The pair side 0.4.1 does not define anywhere; 0.4.2 adds it, until then kette theme derives it as the on-colour of its fill
const DERIVED = ['--colors-button-foreground-destructive'];

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
  // What 0.4.1 lacks against the 5.22.1 pair contract, derived and reported instead of guessed silently
  assert.deepEqual(warnings.sort(), [
    '--colors-background-accent has no light value, its dark value is pinned in :root and paper',
    '--colors-background-destructive has no light value, its dark value is pinned in :root and paper',
    '--colors-button-foreground-destructive (button destructive) is not defined in the theme, it is derived as the on-colour of --colors-button-background-destructive',
    '--colors-foreground-accent has no light value, its dark value is pinned in :root and paper',
    '--colors-foreground-destructive has no light value, its dark value is pinned in :root and paper',
  ]);
});

test('manifest pairs are exactly color-pairs.js of the tokens, and every pair is checked at 4.5:1', () => {
  assert.equal(PAIRS.length, 27);
  assert.deepEqual(manifest.pairs, PAIRS);
  for (const [label, fill, text] of PAIRS) assert.ok(manifest.checks.some((c) => c.label === label && c.fill === fill && c.text === text && c.min === 4.5), label);
});

test('the generated theme declares every variable of the Community theme.css, plus only the derived pair side', () => {
  const { css } = generateTheme(parseThemeOptions({ primary: '#0f766e' }));
  const want = declared(fixtureCss);
  const got = declared(css);
  assert.equal(want.size, 1334);
  assert.deepEqual([...want].filter((v) => !got.has(v)), []);
  assert.deepEqual([...got].filter((v) => !want.has(v)), DERIVED);
});

test('every mode block keeps its Community variables, pins both sides of every pair and every dark contrast fix', () => {
  const { css, tokens } = generateTheme(parseThemeOptions({ primary: '#c2410c' }));
  const want = blocks(fixtureCss);
  const got = blocks(css);
  // Besides the pairs, the dark blocks may only gain variables whose dark value contrast enforcement moved
  const darkFixes = tokens.adjustments.filter((a) => a.mode === 'dark').map((a) => a.name);
  assert.ok(darkFixes.length > 0);
  for (const key of Object.keys(HEADERS)) {
    const allowed = ['dark', 'media'].includes(key) ? [...PAIR_VARS, ...darkFixes] : PAIR_VARS;
    const extra = Object.keys(got[key]).filter((v) => !(v in want[key]));
    assert.deepEqual(Object.keys(want[key]).filter((v) => !(v in got[key])), [], `${key} lost variables`);
    assert.deepEqual(extra.filter((v) => !allowed.includes(v)), [], `${key} added other variables`);
    for (const [label, fill, text] of PAIRS) assert.ok(fill in got[key] && text in got[key], `${key}: ${label}`);
  }
});

test('paper resolves to the light values and the dark media block to the .dark values (5.22.1 scope rule)', () => {
  const { css } = generateTheme(parseThemeOptions({ primary: '#4f46e5', accent: '#db2777', neutral: 'warm' }));
  const b = blocks(css);
  for (const [name, value] of Object.entries(b.paper)) if (name in b.root) assert.equal(value, b.root[name], `paper ${name}`);
  assert.deepEqual(b.media, b.dark);
});

test('random inputs never emit a pair below its minimum, read back from the CSS in light, paper, dark and OS dark', () => {
  const rand = prng(42);
  const hex = () => toHex([0, 0, 0].map(() => Math.floor(rand() * 256)));
  const neutrals = ['cool', 'warm', 'neutral'];
  const radii = ['none', 'sm', 'md', 'lg', 'full', '6'];
  for (let i = 0; i < 120; i++) {
    const raw = { primary: hex(), accent: rand() < 0.5 ? hex() : undefined, neutral: rand() < 0.75 ? neutrals[i % 3] : hex(), radius: radii[i % radii.length] };
    const { css, tokens } = generateTheme(parseThemeOptions(raw));
    assert.equal(tokens.contrast.failing, 0, JSON.stringify(raw));
    const b = blocks(css);
    const scopes = { light: b.root, paper: { ...b.root, ...b.paper }, dark: { ...b.root, ...b.dark }, media: { ...b.root, ...b.media } };
    for (const [scope, vars] of Object.entries(scopes)) {
      for (const c of manifest.checks) {
        const ratio = contrast(rgb(vars[c.fill]), rgb(vars[c.text]));
        assert.ok(ratio >= c.min, `${JSON.stringify(raw)} ${scope} ${c.label}: ${ratio.toFixed(2)}`);
      }
    }
  }
});

test('the base brand colour with cool neutrals reproduces the Community values, apart from reported contrast fixes', () => {
  const { css, tokens } = generateTheme(parseThemeOptions({ primary: '#2563eb' }));
  const want = blocks(fixtureCss);
  const got = blocks(css);
  const adjusted = new Set(tokens.adjustments.map((a) => `${a.mode}:${a.name}`));
  for (const [key, mode] of [['root', 'light'], ['dark', 'dark']]) {
    for (const [name, value] of Object.entries(want[key])) {
      if (/^\d+ \d+ \d+$/.test(value) && !adjusted.has(`${mode}:${name}`)) assert.equal(got[key][name], value, `${key} ${name}`);
    }
  }
  // Exactly the checks 0.4.1 itself fails (white on emerald, orange and red fills) are fixed, each once and reported
  const base = { light: want.root, dark: { ...want.root, ...want.dark } };
  const failingInBase = manifest.checks.flatMap((c) => ['light', 'dark'].filter((m) => base[m][c.fill] && base[m][c.text] && contrast(rgb(base[m][c.fill]), rgb(base[m][c.text])) < c.min).map((m) => `${m}:${c.text}`));
  assert.deepEqual([...new Set(failingInBase)].sort(), [...adjusted].sort());
  assert.ok(tokens.adjustments.every((a) => a.before < 4.5 && a.after >= 4.5));
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
  assert.equal(data.checks.length, manifest.checks.length * 2);
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
  assert.match(r.stdout, /Adjusted \d+ values? to reach the minimum contrast/);

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
