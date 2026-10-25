// Builds src/theme/manifest.json, the one data file behind kette theme, from the Community theme.css and color-pairs.js of the tokens
// Usage: node scripts/theme-manifest.mjs <theme.css> <color-pairs.js> "<theme source label>" "<pairs source label>"
// Without arguments it rebuilds from the fixtures in test/fixtures, which are the copies the tests check against
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hueDistance, rgbToOklch, sameRgb } from '../src/theme/color.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = {
  css: path.join(root, 'test', 'fixtures', 'community-theme-0.4.3.css'),
  pairs: path.join(root, 'test', 'fixtures', 'color-pairs.cjs'),
  themeSource: '@getitdone-gmbh/kette-design-community@0.4.3 styles/theme.css (getitdone-gmbh/kette-design-community@639d509)',
  pairsSource: 'getitdone-gmbh/kette-tokens@v5.23.2 scripts/color-pairs.js',
};
export const MANIFEST_PATH = path.join(root, 'src', 'theme', 'manifest.json');

// Tailwind slate and blue, the neutral and brand ramps of the base theme; kette theme maps them onto the generated ramps
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const SLATE = [[248, 250, 252], [241, 245, 249], [226, 232, 240], [203, 213, 225], [148, 163, 184], [100, 116, 139], [71, 85, 105], [51, 65, 85], [30, 41, 59], [15, 23, 42], [2, 6, 23]];
const BLUE = [[239, 246, 255], [219, 234, 254], [191, 219, 254], [147, 197, 253], [96, 165, 250], [59, 130, 246], [37, 99, 235], [29, 78, 216], [30, 64, 175], [30, 58, 138], [23, 37, 84]];

// Pairs the tokens gate does not list but every theme must hold too (4.5:1, focus indicators 3:1): the status and badge pairs that
// kette-design-community checks in src/lib/theme-pairs.test.ts (scripts/theme-pairs.mjs), text on the paper surface, page, card, canvas
// and input, and the component pairs the preview shows. The paper surface stays light in a dark page, so its checks run in light only. Duplicates of the color-pairs.js pairs are dropped when the manifest is built.
const STATUS_FAMILIES = ['success', 'warning', 'error', 'info', 'destructive', 'brand'];
const COMMUNITY_STATUS = [
  ...[...STATUS_FAMILIES, 'secondary'].map((s) => [`${s} on fill`, `--colors-general-${s}-default`, `--colors-general-${s}-on`]),
  ...STATUS_FAMILIES.map((s) => [`${s} container`, `--colors-general-${s}-container`, `--colors-general-${s}-on-container`]),
  ...['error', 'destructive'].map((s) => [`${s} on-fill`, `--colors-general-${s}-default`, `--colors-general-${s}-on-fill`]),
  ...['success', 'warning', 'info', 'destructive', 'brand'].flatMap((s) => ['default', 'hover', 'active'].map((state) => [`${s} bold ${state}`, `--semantic-background-${s}-bold-${state}`, `--semantic-text-on-${s}`])),
  ...['brand', 'destructive', 'info'].map((s) => [`${s} subtle`, `--semantic-background-${s}-subtle`, `--semantic-text-${s}-on-subtle`]),
];
const COMMUNITY_BADGES = [
  ['badge subtle', '--colors-badge-background-subtle-default', '--colors-badge-foreground-subtle-default'],
  ['semantic info subtle', '--semantic-background-info-subtle', '--semantic-text-info-on-subtle'],
];
const EXTRA_CHECKS = [
  ...[...COMMUNITY_STATUS, ...COMMUNITY_BADGES].map(([label, fill, text]) => [label, fill, text, 4.5]),
  ['paper text', '--semantic-surface-paper', '--semantic-text-default', 4.5, 'light'],
  ['paper foreground', '--semantic-surface-paper', '--colors-utility-foreground', 4.5, 'light'],
  ['text on paper', '--semantic-surface-paper', '--semantic-text-on-paper', 4.5, 'light'],
  ['page text', '--colors-background', '--colors-utility-foreground', 4.5],
  ['muted text on page', '--colors-background', '--colors-utility-muted-foreground', 4.5],
  ['muted text on card', '--colors-utility-card', '--colors-utility-muted-foreground', 4.5],
  ['brand text', '--semantic-surface-raised', '--semantic-text-brand', 4.5],
  ['selected text', '--semantic-surface-raised', '--semantic-text-selected', 4.5],
  ['subtle text', '--semantic-surface-raised', '--semantic-text-subtle', 4.5],
  ['muted text on canvas', '--semantic-surface-canvas', '--semantic-text-muted', 4.5],
  ['subtle text on canvas', '--semantic-surface-canvas', '--semantic-text-subtle-on-canvas', 4.5],
  ['input text', '--colors-input-background-default', '--colors-input-foreground-filled', 4.5],
  ['input hint', '--colors-input-background-default', '--colors-input-foreground-hint', 4.5],
  ['input placeholder', '--colors-input-background-default', '--colors-input-foreground-placeholder', 4.5],
  ['destructive text', '--colors-background', '--semantic-text-destructive', 4.5],
  ['success text', '--colors-background', '--semantic-text-success', 4.5],
  ['warning text', '--colors-background', '--semantic-text-warning', 4.5],
  ['info text', '--colors-background', '--semantic-text-info', 4.5],
  ['card text', '--colors-card-background-default', '--colors-card-foreground-default', 4.5],
  ['card muted text', '--colors-card-background-default', '--colors-card-foreground-muted', 4.5],
  ['table text', '--colors-table-background-default', '--colors-table-foreground-default', 4.5],
  ['table selected text', '--colors-table-background-selected', '--colors-table-foreground-default', 4.5],
  ['selected row text', '--semantic-background-selected-row', '--semantic-text-default', 4.5],
  ['outline button', '--colors-button-background-outline-default', '--colors-button-foreground-outline-default', 4.5],
  ['subtle button', '--colors-button-background-subtle-default', '--colors-button-foreground-subtle-default', 4.5],
  ['chip selected', '--colors-chip-background-selected', '--colors-chip-foreground-selected', 4.5],
  ['search hit', '--colors-highlight-hit-default', '--colors-highlight-hit-on', 4.5],
  ['focus ring', '--colors-background', '--colors-utility-ring', 3],
  ['focus ring default', '--colors-background', '--colors-general-ring-default', 3],
  ['focus border', '--colors-background', '--semantic-border-focus', 3],
];

// Radius groups: controls follow --radius fully (pill with full), surfaces double with full, details keep their shape with full
const RADIUS_CONTROL = /^--borderRadius(-(default|button|input|badge|control|item))?$/;
const RADIUS_SURFACE = /^--borderRadius-(card|surface|dialog|popover)$/;
const STATUS = /(info|success|warning|error|destructive|negative|positive|danger)/;
// Variables named after a colour family are categorical colours, not the brand
const FAMILY = /-(indigo|violet|purple|pink|rose|fuchsia|teal|cyan|sky|emerald|green|lime|amber|yellow|orange|red)(-|$)/;
const TRIPLET = /^(\d{1,3}) (\d{1,3}) (\d{1,3})$/;
const PAPER = '.light, [data-document-surface], [data-surface="paper"]';
const DARK_MEDIA = '@media (prefers-color-scheme: dark)';

// light, dark or null for the selector stack of a block; only these four blocks form the colour layer of the mode cascade
function modeOf(stack) {
  const key = stack.join(' >> ');
  if (key === ':root') return { mode: 'light', block: 'root' };
  if (key === '.dark') return { mode: 'dark', block: 'dark' };
  if (key === `${DARK_MEDIA} >> :root:not(.light)`) return { mode: 'dark', block: 'media' };
  if (key === PAPER) return { mode: 'light', block: 'paper' };
  return null;
}

// Slate chroma at a lightness (OKLCH), the line between a tinted neutral and a real hue
function slateChroma(l) {
  const pts = SLATE.map((rgb) => rgbToOklch(rgb)).sort((a, b) => a.l - b.l);
  if (l <= pts[0].l) return pts[0].c;
  for (let i = 1; i < pts.length; i++) {
    if (l <= pts[i].l) return pts[i - 1].c + ((l - pts[i - 1].l) / (pts[i].l - pts[i - 1].l)) * (pts[i].c - pts[i - 1].c);
  }
  return pts[pts.length - 1].c;
}

// Role of one colour value: neutral (slate family), accent (neutral with accent in the name), brand (the primary hue),
// chart (categorical series, rotate with the primary), fixed (status, data and product colours keep their meaning)
export function classify(name, rgb, brand) {
  if (/^--colors-(data|product)-/.test(name) || STATUS.test(name) || FAMILY.test(name)) return 'fixed';
  const { l, c, h } = rgbToOklch(rgb);
  if (c <= slateChroma(l) * 1.4 + 0.004) return /accent/.test(name) ? 'accent' : 'neutral';
  if (/^--semantic-chart-(\d|subtle-\d)/.test(name)) return 'chart';
  if (hueDistance(h, rgbToOklch(brand).h) <= 12) return 'brand';
  return 'fixed';
}

const triplet = (v) => {
  const m = TRIPLET.exec(v);
  return m ? [+m[1], +m[2], +m[3]] : null;
};

// Walks the CSS line by line; the Community theme.css is generated with one declaration per line and one selector per line
function parseBlocks(css) {
  const lines = css.replace(/\r\n/g, '\n').split('\n');
  const stack = [];
  let pending = [];
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.endsWith('{')) {
      stack.push([...pending, t.slice(0, -1).trim()].join(' '));
      pending = [];
      out.push({ kind: 'open', line, ctx: modeOf(stack) });
    } else if (t.endsWith(',') && !t.startsWith('--')) {
      pending.push(t);
      out.push({ kind: 'text', line });
    } else if (t === '}') {
      out.push({ kind: 'close', line, ctx: modeOf(stack) });
      stack.pop();
    } else {
      const m = /^(\s*)(--[\w-]+):\s*(.+);$/.exec(line);
      out.push(m ? { kind: 'decl', line, indent: m[1], name: m[2], value: m[3], ctx: modeOf(stack) } : { kind: 'text', line });
    }
  }
  return out;
}

export function buildManifest({ css, pairs, themeSource, pairsSource }) {
  // Leading comments (the generator line of the source) are replaced by the header of kette theme
  const items = parseBlocks(css.replace(/^(\s*\/\*[^]*?\*\/\s*\n)+/, ''));
  const warnings = [];
  const base = { light: {}, dark: {} };
  const blockVars = { root: new Set(), dark: new Set(), media: new Set(), paper: new Set() };
  const byBlock = { root: {}, dark: {}, media: {}, paper: {} };
  for (const it of items) {
    if (it.kind !== 'decl' || !it.ctx) continue;
    blockVars[it.ctx.block].add(it.name);
    const rgb = triplet(it.value);
    if (rgb) byBlock[it.ctx.block][it.name] = rgb;
  }
  for (const [name, rgb] of Object.entries(byBlock.root)) base.light[name] = rgb;
  for (const [name, rgb] of Object.entries(byBlock.dark)) base.dark[name] = rgb;
  // Scope rule (kette-tokens 5.22.1, Community tests): paper resolves to the light value, the dark media block to the .dark value; differences are reported, not kept
  for (const [block, mode] of [['paper', 'light'], ['media', 'dark']]) {
    for (const [name, rgb] of Object.entries(byBlock[block])) {
      if (!(name in base[mode])) base[mode][name] = rgb;
      else if (!sameRgb(base[mode][name], rgb)) warnings.push(`${block}: ${name} is ${rgb.join(' ')}, the ${mode} value ${base[mode][name].join(' ')} is used`);
    }
  }
  const pairVars = [...new Set(pairs.flatMap(([, fill, text]) => [fill, text]))];
  const brand = base.light['--colors-primary'];
  if (!brand) throw new Error('The theme has no --colors-primary in :root, the brand anchor of kette theme');

  // Pins per block, as kette-design-community 0.4.3 tests them: the dark blocks and paper carry every pair variable :root defines, and
  // no block sets one side of a pair without the other. A pair absent from a block on both sides stays absent (exact variable parity).
  const pinsByBlock = {};
  for (const block of Object.keys(blockVars)) {
    const has = (v) => blockVars[block].has(v) || pinned.has(v);
    const pinned = new Set(block === 'root' ? [] : pairVars.filter((v) => blockVars.root.has(v) && !blockVars[block].has(v)));
    for (let changed = true; changed;) {
      changed = false;
      for (const [, fill, text, shared] of pairs) {
        for (const [v, partner, needed] of [[text, fill, true], [fill, text, !shared]]) {
          if (needed && has(partner) && !has(v) && (base.light[v] || base.dark[v] || v === text)) {
            pinned.add(v);
            changed = true;
          }
        }
      }
    }
    pinsByBlock[block] = pinned;
  }

  // Every colour variable with its value per mode as the cascade resolves it: dark falls back to the light value (inherit: the dark
  // blocks do not declare it, kette theme pins it there only when contrast moved its dark value)
  const colors = {};
  const names = new Set([...Object.keys(base.light), ...Object.keys(base.dark)]);
  for (const name of names) {
    const light = base.light[name] || (pinsByBlock.root.has(name) ? base.dark[name] : null);
    const dark = base.dark[name] || base.light[name];
    colors[name] = {
      ...(light ? { light: [...light, classify(name, light, brand)] } : {}),
      dark: [...dark, classify(name, dark, brand)],
      ...(!base.dark[name] && !pinsByBlock.dark.has(name) ? { inherit: true } : {}),
    };
    if (!base.light[name] && light) warnings.push(`${name} has no light value, its dark value is pinned in :root`);
  }
  // Pair sides the theme does not define anywhere: derived as the best on-colour of their fill
  const pairOn = {};
  for (const [label, fill, text] of pairs) {
    if (!(text in colors) && !(text in pairOn) && fill in colors) {
      pairOn[text] = fill;
      warnings.push(`${text} (${label}) is not defined in the theme, it is derived as the on-colour of ${fill}`);
    }
    if (!(fill in colors)) warnings.push(`${fill} (${label}) is not defined in the theme, the pair is skipped`);
  }

  const radius = {};
  const shadows = {};
  let font = null;
  const pins = (block) => [...pinsByBlock[block]].filter((v) => v in colors || v in pairOn);
  const template = [];
  for (const it of items) {
    if (it.kind === 'close' && it.ctx) {
      const indent = it.line.match(/^\s*/)[0] + '  ';
      for (const v of pins(it.ctx.block)) template.push(`${indent}${v}: {{c:${it.ctx.mode}:${v}}};`);
      // Dark contrast fixes are pinned in both dark blocks, and with their light value in paper, so paper inside a dark page stays light
      if (it.ctx.mode === 'dark' || it.ctx.block === 'paper') template.push(`${indent}{{pins:${it.ctx.block === 'paper' ? 'paper' : 'dark'}}}`);
    }
    if (it.kind !== 'decl' || !it.ctx) {
      template.push(it.line);
      continue;
    }
    const { name, indent, value, ctx } = it;
    let placeholder = null;
    if (triplet(value)) placeholder = `c:${ctx.mode}:${name}`;
    else if (ctx.block === 'root' && name === '--font-sans') {
      font = value;
      placeholder = 'font';
    } else if (ctx.block === 'root' && name.startsWith('--borderRadius') && /^\d+px$/.test(value)) {
      radius[name] = { px: parseInt(value, 10), group: RADIUS_CONTROL.test(name) ? 'control' : RADIUS_SURFACE.test(name) ? 'surface' : 'detail' };
      placeholder = `radius:${name}`;
    } else if (ctx.block === 'root' && /^--(shadow|elevation)-/.test(name) && /rgba?\(/.test(value)) {
      shadows[name] = value;
      placeholder = `shadow:${name}`;
    }
    template.push(placeholder ? `${indent}${name}: {{${placeholder}}};` : it.line);
  }

  const missing = EXTRA_CHECKS.filter(([, fill, text]) => !(fill in colors) || !(text in colors));
  for (const [label] of missing) warnings.push(`check "${label}" skipped, a variable is not in the theme`);
  const seen = new Set();
  const checks = [
    ...pairs.filter(([, fill, text]) => fill in colors && (text in colors || text in pairOn)).map(([label, fill, text]) => ({ label, fill, text, min: 4.5 })),
    ...EXTRA_CHECKS.filter((c) => !missing.includes(c)).map(([label, fill, text, min, mode]) => ({ label, fill, text, min, ...(mode ? { mode } : {}) })),
  ].filter((c) => !seen.has(`${c.fill} ${c.text}`) && seen.add(`${c.fill} ${c.text}`));
  return {
    manifest: {
      comment: 'Generated by scripts/theme-manifest.mjs, do not edit. Rebuild after a Community or tokens update, see README "Theming".',
      source: { theme: themeSource, pairs: pairsSource },
      anchors: { brand, steps: STEPS, brandRamp: BLUE, neutralRamp: SLATE },
      pairs,
      checks,
      colors,
      pairOn,
      font,
      radius,
      shadows,
      template: template.join('\n'),
    },
    warnings,
  };
}

// One key per line and one colour variable per line, so a Community update shows up as a readable diff
export function formatManifest(manifest) {
  const body = Object.entries(manifest).map(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && key !== 'source') {
      const rows = Object.entries(value).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
      return `${JSON.stringify(key)}: {\n${rows.join(',\n')}\n}`;
    }
    if (Array.isArray(value) && key !== 'template') return `${JSON.stringify(key)}: [\n${value.map((v) => `  ${JSON.stringify(v)}`).join(',\n')}\n]`;
    return `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  });
  return `{\n${body.join(',\n')}\n}\n`;
}

export function loadPairs(file) {
  return createRequire(import.meta.url)(path.resolve(file)).PAIRS;
}

export function buildFrom({ css = FIXTURES.css, pairs = FIXTURES.pairs, themeSource = FIXTURES.themeSource, pairsSource = FIXTURES.pairsSource } = {}) {
  return buildManifest({ css: fs.readFileSync(css, 'utf8'), pairs: loadPairs(pairs), themeSource, pairsSource });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [css, pairs, themeSource, pairsSource] = process.argv.slice(2);
  const { manifest, warnings } = buildFrom({ css, pairs, themeSource, pairsSource });
  fs.writeFileSync(MANIFEST_PATH, formatManifest(manifest));
  for (const w of warnings) console.log(`note: ${w}`);
  console.log(`${path.relative(root, MANIFEST_PATH)}: ${Object.keys(manifest.colors).length} colour variables, ${manifest.checks.length} contrast checks`);
}
