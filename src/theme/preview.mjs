import { contrast, parseHex } from './color.mjs';
import { EDITION_NOTE } from './generate.mjs';

export const PREVIEW_MARK = '<meta name="generator" content="kette theme">';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const v = (name) => `rgb(var(${name}))`;

// Component look of the preview, built only from the generated variables; only palette step labels pick black or white
const STYLE = `
* { box-sizing: border-box; }
body { margin: 0; background: ${v('--semantic-surface-canvas')}; color: ${v('--colors-utility-foreground')}; font-family: var(--font-family); font-size: 14px; line-height: 20px; }
.wrap { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font: var(--typo-h3-weight) var(--typo-h3-size)/var(--typo-h3-lh) var(--font-family); margin: 0 0 4px; }
h2 { font: 600 16px/24px var(--font-family); margin: 0 0 16px; }
h3 { font: 600 14px/20px var(--font-family); margin: 0 0 8px; }
p { margin: 0; }
.muted { color: ${v('--colors-utility-muted-foreground')}; }
.modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin: 24px 0; }
.panel { background: ${v('--colors-background')}; color: ${v('--colors-utility-foreground')}; border: 1px solid ${v('--colors-utility-border')}; border-radius: var(--borderRadius-surface); padding: 24px; display: grid; gap: 20px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.btn { font: 500 14px/20px var(--font-family); height: var(--size-control-md); padding: 0 var(--size-control-padding-x-md); border-radius: var(--borderRadius-button); border: 1px solid transparent; cursor: pointer; }
.btn:focus-visible, .is-focus { outline: 2px solid ${v('--colors-utility-ring')}; outline-offset: 2px; }
.btn-primary { background: ${v('--colors-button-background-primary-default')}; color: ${v('--colors-button-foreground-primary-default')}; }
.btn-primary:hover { background: ${v('--colors-button-background-primary-hover')}; }
.btn-secondary { background: ${v('--colors-utility-secondary')}; color: ${v('--colors-utility-secondary-foreground')}; }
.btn-outline { background: ${v('--colors-button-background-outline-default')}; color: ${v('--colors-button-foreground-outline-default')}; border-color: ${v('--colors-button-border-outline-default')}; }
.btn-outline:hover { background: ${v('--colors-button-background-outline-hover')}; }
.btn-ghost { background: transparent; color: ${v('--colors-button-foreground-ghost-default')}; }
.btn-ghost:hover { background: ${v('--colors-button-background-ghost-hover')}; }
.btn-destructive { background: ${v('--colors-button-background-destructive')}; color: ${v('--colors-button-foreground-destructive')}; }
.btn-destructive:hover { background: ${v('--colors-button-background-destructive-hover')}; }
.field { display: grid; gap: var(--size-gap-label); }
label { font-weight: 500; }
.input { font: 400 14px/20px var(--font-family); height: var(--size-control-lg); padding: 0 var(--size-control-padding-x-md); border-radius: var(--borderRadius-input); border: 1px solid ${v('--colors-input-border-default')}; background: ${v('--colors-input-background-default')}; color: ${v('--colors-input-foreground-filled')}; width: 100%; }
.input::placeholder { color: ${v('--colors-input-foreground-placeholder')}; }
.input:focus-visible, .input.is-focus { outline: none; border-color: ${v('--colors-utility-ring')}; box-shadow: 0 0 0 var(--size-ring-width) rgb(var(--colors-utility-ring) / var(--opacity-ring-halo)); }
.hint { color: ${v('--colors-input-foreground-hint')}; font-size: 12px; line-height: 16px; }
.card { background: ${v('--colors-card-background-default')}; color: ${v('--colors-card-foreground-default')}; border: 1px solid ${v('--colors-utility-border')}; border-radius: var(--borderRadius-card); box-shadow: var(--elevation-surface); padding: 16px; display: grid; gap: 8px; }
.card .sub { color: ${v('--colors-card-foreground-muted')}; }
.badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: var(--borderRadius-badge); font-size: 12px; font-weight: 500; }
.b-brand { background: ${v('--colors-general-brand-container')}; color: ${v('--colors-general-brand-on-container')}; }
.b-solid { background: ${v('--colors-general-brand-default')}; color: ${v('--colors-general-brand-on-fill')}; }
.b-subtle { background: ${v('--colors-badge-background-subtle-default')}; color: ${v('--colors-badge-foreground-subtle-default')}; }
.b-success { background: ${v('--colors-general-success-container')}; color: ${v('--colors-general-success-on-container')}; }
.b-warning { background: ${v('--colors-general-warning-container')}; color: ${v('--colors-general-warning-on-container')}; }
.b-error { background: ${v('--colors-general-error-container')}; color: ${v('--colors-general-error-on-container')}; }
.alert { border-radius: var(--borderRadius-surface); padding: 12px 16px; border: 1px solid; display: grid; gap: 2px; }
.a-info { background: ${v('--semantic-background-info-subtle')}; color: ${v('--semantic-text-info-on-subtle')}; border-color: ${v('--semantic-border-info')}; }
.a-error { background: ${v('--semantic-background-destructive-subtle')}; color: ${v('--semantic-text-destructive-on-subtle')}; border-color: ${v('--semantic-border-destructive')}; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-weight: 500; color: ${v('--colors-utility-muted-foreground')}; background: ${v('--colors-utility-muted')}; height: var(--size-table-head); padding: 0 12px; }
td { height: var(--size-row); padding: 0 12px; background: ${v('--colors-table-background-default')}; color: ${v('--colors-table-foreground-default')}; border-bottom: 1px solid ${v('--colors-utility-border')}; }
tr:hover td { background: ${v('--colors-table-background-hover')}; }
tr.selected td { background: ${v('--colors-table-background-selected')}; }
.series { display: flex; gap: 4px; }
.series span { width: 28px; height: 28px; border-radius: var(--borderRadius-item); }
.section { background: ${v('--colors-background')}; border: 1px solid ${v('--colors-utility-border')}; border-radius: var(--borderRadius-surface); padding: 24px; margin-top: 16px; overflow-x: auto; }
.ramp { display: grid; grid-template-columns: 96px repeat(11, minmax(40px, 1fr)); gap: 4px; align-items: center; margin-bottom: 4px; }
.ramp span { height: 36px; border-radius: var(--borderRadius-tight); display: flex; align-items: end; justify-content: center; font-size: 10px; padding-bottom: 2px; }
.sample { display: inline-block; min-width: 44px; text-align: center; border-radius: var(--borderRadius-tight); padding: 2px 6px; font-weight: 600; border: 1px solid ${v('--colors-utility-border')}; }
.contrast td, .contrast th { height: 32px; font-size: 12px; }
.contrast code { font-size: 11px; }
.pass { color: ${v('--semantic-text-success')}; font-weight: 600; }
.note { margin-top: 16px; }
`;

function panel(mode) {
  return `<section class="panel ${mode}" aria-label="${mode} mode">
<h2>${mode === 'light' ? 'Light' : 'Dark'}</h2>
<div class="row"><button class="btn btn-primary">Save changes</button><button class="btn btn-secondary">Secondary</button><button class="btn btn-outline">Outline</button><button class="btn btn-ghost">Ghost</button><button class="btn btn-destructive">Delete</button><button class="btn btn-primary is-focus">Focused</button></div>
<div class="field"><label for="email-${mode}">Work email</label><input id="email-${mode}" class="input" placeholder="name@company.com"><span class="hint">We only use it for sign-in.</span></div>
<div class="field"><label for="project-${mode}">Project</label><input id="project-${mode}" class="input is-focus" value="Rollout Q4"></div>
<div class="card"><h3>Monthly report</h3><p class="sub">Updated 2 hours ago · 14 entries</p><div class="row"><span class="badge b-solid">Brand</span><span class="badge b-brand">In review</span><span class="badge b-subtle">Draft</span><span class="badge b-success">Approved</span><span class="badge b-warning">Due soon</span><span class="badge b-error">Blocked</span></div></div>
<div class="alert a-info" role="status"><strong>Sync finished</strong><span>All 128 records are up to date.</span></div>
<div class="alert a-error" role="alert"><strong>Import failed</strong><span>3 rows have an invalid date.</span></div>
<table><thead><tr><th>Name</th><th>Status</th><th>Hours</th></tr></thead><tbody>
<tr><td>Website relaunch</td><td><span class="badge b-success">Active</span></td><td>42.5</td></tr>
<tr class="selected"><td>Data migration</td><td><span class="badge b-brand">Selected</span></td><td>18.0</td></tr>
<tr><td>Support</td><td><span class="badge b-subtle">Paused</span></td><td>6.25</td></tr>
</tbody></table>
<div class="series" aria-label="Chart series">${[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<span style="background:${v(`--semantic-chart-${i}`)}" title="--semantic-chart-${i}"></span>`).join('')}</div>
</section>`;
}

// Step label on a palette swatch: black or white, whichever reads better
const labelOn = (hex) => (contrast(parseHex(hex), [0, 0, 0]) >= contrast(parseHex(hex), [255, 255, 255]) ? '#000' : '#fff');

function ramps(tokens) {
  const rows = Object.entries(tokens.palettes).map(([name, ramp]) => `<div class="ramp"><strong>${esc(name)}</strong>${Object.entries(ramp).map(([step, hex]) => `<span style="background:${hex};color:${labelOn(hex)}" title="${hex}">${step}</span>`).join('')}</div>`);
  return `<section class="section"><h2>Tonal palettes</h2>${rows.join('')}</section>`;
}

function contrastTable(tokens) {
  const rows = tokens.checks.map((c) => `<tr><td>${c.mode}</td><td>${esc(c.check)}</td><td><span class="sample" style="background:${c.fillHex};color:${c.textHex}">Aa</span></td><td><code>${esc(c.text)}</code> on <code>${esc(c.fill)}</code></td><td>${c.ratio.toFixed(2)}:1</td><td>${c.min}:1</td><td class="pass">${c.pass ? 'PASS' : 'FAIL'}</td></tr>`);
  const adjusted = tokens.adjustments.length
    ? `<h3>Adjusted for contrast</h3><table class="contrast"><thead><tr><th>Mode</th><th>Variable</th><th>From</th><th>To</th><th>Pair</th><th>Before</th><th>After</th></tr></thead><tbody>${tokens.adjustments.map((a) => `<tr><td>${a.mode}</td><td><code>${esc(a.name)}</code></td><td>${a.from}</td><td>${a.to}</td><td>${esc(a.check)}</td><td>${a.before.toFixed(2)}:1</td><td>${a.after.toFixed(2)}:1</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No value needed an adjustment.</p>';
  return `<section class="section"><h2>Contrast (WCAG 2.2 AA)</h2><p class="muted">${tokens.contrast.checked} checks, ${tokens.contrast.failing} failing. Text 4.5:1, focus indicators 3:1.</p>${adjusted}<h3>All pairs</h3><table class="contrast"><thead><tr><th>Mode</th><th>Pair</th><th>Sample</th><th>Variables</th><th>Ratio</th><th>Minimum</th><th>Result</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>`;
}

// Self-contained page: the generated theme.css inline, components in light and dark, palettes and the contrast table
export function previewHtml({ css, tokens }) {
  const inputs = Object.entries(tokens.inputs).filter(([, x]) => x !== null).map(([k, x]) => `${k} ${esc(x)}`).join(' · ');
  return `<!doctype html>
<html lang="en" class="light">
<head>
<meta charset="utf-8">
${PREVIEW_MARK}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Theme ${esc(tokens.name)}</title>
<style>
${css}
</style>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header><h1>Theme ${esc(tokens.name)}</h1><p class="muted">${inputs} · ${esc(tokens.generator)}</p></header>
<div class="modes">${panel('light')}${panel('dark')}</div>
${ramps(tokens)}
${contrastTable(tokens)}
<p class="muted note">${esc(EDITION_NOTE)}</p>
</div>
</body>
</html>
`;
}
