import { contrast, oklchToRgb, rgbToOklch, toHex } from './color.mjs';

const STEP = 0.005;
const STEPS = Math.ceil(1 / STEP);
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

const holds = (values, check) => contrast(values[check.fill], values[check.text]) >= check.min;
const constraintsOf = (active, name) => active.filter((c) => c.fill === name || c.text === name);

// Smallest lightness change of one variable (OKLCH, hue and chroma kept) that satisfies every check it takes part in; null if none does
function fit(values, name, constraints) {
  const o = rgbToOklch(values[name]);
  const pick = (n, rgb) => (n === name ? rgb : values[n]);
  const passes = (rgb) => constraints.every((c) => contrast(pick(c.fill, rgb), pick(c.text, rgb)) >= c.min);
  for (let i = 1; i <= STEPS; i++) {
    const found = [-1, 1]
      .map((dir) => o.l + dir * i * STEP)
      .filter((l) => l >= -STEP && l <= 1 + STEP)
      .map((l) => oklchToRgb({ l: Math.min(1, Math.max(0, l)), c: o.c, h: o.h }))
      .filter(passes);
    if (found.length) return found[0];
  }
  return null;
}

// Fills and texts that block each other (a text shared by a light and a dark fill, whose fill also carries another text):
// the text goes to black or white, whichever contrasts more with its fill, every touched partner is refitted, and partners
// that still cannot fit go to the same extreme. Against a pure extreme every colour can move far enough, so this ends.
function rescue(values, active, failing, set) {
  const extreme = contrast(values[failing.fill], WHITE) >= contrast(values[failing.fill], BLACK) ? WHITE : BLACK;
  const pushed = new Set();
  const touched = new Set();
  const push = (name) => {
    pushed.add(name);
    touched.add(name);
    set(name, [...extreme], failing);
  };
  push(failing.text);
  for (let guard = 0; guard < active.length * 4; guard++) {
    const bad = active.find((c) => !holds(values, c) && (touched.has(c.fill) || touched.has(c.text)));
    if (!bad) return true;
    const free = [bad.fill, bad.text].find((n) => !pushed.has(n));
    if (!free) return false;
    const next = fit(values, free, constraintsOf(active, free));
    if (next) {
      touched.add(free);
      set(free, next, bad);
      continue;
    }
    const partners = constraintsOf(active, free).map((c) => (c.fill === free ? c.text : c.fill)).filter((n) => !pushed.has(n));
    if (!partners.length) return false;
    partners.forEach(push);
  }
  return false;
}

// Raises every failing check to its minimum (4.5:1 text, 3:1 UI) with the smallest lightness change: the text side first, the
// fill side when the text is shared with fills it cannot satisfy together, the rescue above when neither fits alone.
// values is changed in place; the result lists every adjustment. Throws when a check cannot be met, so a failing pair is never emitted.
export function enforceContrast(values, checks, mode) {
  const active = checks.filter((c) => c.fill in values && c.text in values);
  const adjustments = [];
  const set = (name, rgb, check) => {
    const before = contrast(values[check.fill], values[check.text]);
    adjustments.push({ mode, name, from: toHex(values[name]), to: toHex(rgb), check: check.label, before, after: 0 });
    values[name] = rgb;
    adjustments[adjustments.length - 1].after = contrast(values[check.fill], values[check.text]);
  };
  for (let guard = 0; guard <= active.length * 2; guard++) {
    const failing = active.find((c) => !holds(values, c));
    if (!failing) break;
    const moved = [failing.text, failing.fill].some((name) => {
      const next = fit(values, name, constraintsOf(active, name));
      if (next) set(name, next, failing);
      return Boolean(next);
    });
    if (!moved && !rescue(values, active, failing, set)) break;
  }
  const left = active.filter((c) => !holds(values, c)).map((c) => `${c.label} (${mode})`);
  if (left.length) throw new Error(`Contrast cannot be met for ${left.join(', ')}`);
  return adjustments;
}

// Every check with its final ratio, floored to two decimals so a shown 4.50 really is 4.5:1 or more
export function contrastReport(values, checks, mode) {
  return checks.filter((c) => c.fill in values && c.text in values).map((c) => {
    const ratio = contrast(values[c.fill], values[c.text]);
    return { mode, check: c.label, fill: c.fill, text: c.text, fillHex: toHex(values[c.fill]), textHex: toHex(values[c.text]), ratio: Math.floor(ratio * 100) / 100, min: c.min, pass: ratio >= c.min };
  });
}
