import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, luminance, maxChroma, oklchToRgb, parseHex, rgbToOklch, toHex } from '../src/theme/color.mjs';
import { enforceContrast } from '../src/theme/contrast.mjs';
import { prng } from './helpers.mjs';

const randomRgb = (rand) => [0, 0, 0].map(() => Math.floor(rand() * 256));

test('parseHex reads #rrggbb, #rgb, without # and in any case, and refuses everything else', () => {
  assert.deepEqual(parseHex('#0f766e'), [15, 118, 110]);
  assert.deepEqual(parseHex('0F766E'), [15, 118, 110]);
  assert.deepEqual(parseHex('#abc'), [170, 187, 204]);
  assert.deepEqual(parseHex(' #FFF '), [255, 255, 255]);
  for (const bad of ['', '#12', '#12345', '#gggggg', 'red', 'rgb(1,2,3)', '#1234567']) assert.throws(() => parseHex(bad), /Not a hex colour/, bad);
  assert.equal(toHex([15, 118, 110]), '#0f766e');
});

test('OKLCH matches reference values and round-trips every sampled sRGB colour exactly', () => {
  const white = rgbToOklch([255, 255, 255]);
  assert.ok(Math.abs(white.l - 1) < 1e-4 && white.c < 1e-4);
  assert.ok(rgbToOklch([0, 0, 0]).l < 1e-6);
  // #2563eb (Tailwind blue-600) is oklch(0.546 0.215 262.9) in the Tailwind 4 palette
  const blue = rgbToOklch([37, 99, 235]);
  assert.ok(Math.abs(blue.l - 0.546) < 0.002 && Math.abs(blue.c - 0.215) < 0.002 && Math.abs(blue.h - 262.9) < 0.3, JSON.stringify(blue));
  const rand = prng(7);
  for (let i = 0; i < 2000; i++) {
    const rgb = randomRgb(rand);
    assert.deepEqual(oklchToRgb(rgbToOklch(rgb)), rgb);
  }
});

test('out-of-gamut OKLCH keeps lightness and hue, loses chroma and always lands on valid sRGB integers', () => {
  const rand = prng(11);
  for (let i = 0; i < 500; i++) {
    const rgb = oklchToRgb({ l: rand() * 1.2 - 0.1, c: rand() * 0.6, h: rand() * 720 - 180 });
    assert.ok(rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), JSON.stringify(rgb));
  }
  const loud = rgbToOklch(oklchToRgb({ l: 0.7, c: 0.5, h: 150 }));
  assert.ok(Math.abs(loud.l - 0.7) < 0.01 && Math.abs(loud.h - 150) < 2, JSON.stringify(loud));
  assert.ok(maxChroma(0.7, 150) > 0.15 && maxChroma(0.7, 150) < 0.3);
  assert.equal(maxChroma(0, 150), 0);
});

test('contrast follows WCAG 2.x', () => {
  assert.equal(contrast([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrast([10, 20, 30], [10, 20, 30]), 1);
  assert.equal(contrast([255, 255, 255], [0, 0, 0]), contrast([0, 0, 0], [255, 255, 255]));
  // #767676 on white is the classic 4.54:1 grey, #777777 is just below 4.5
  assert.equal(Math.floor(contrast(parseHex('#767676'), [255, 255, 255]) * 100), 454);
  assert.ok(contrast(parseHex('#777777'), [255, 255, 255]) < 4.5);
  assert.ok(Math.abs(luminance([255, 255, 255]) - 1) < 1e-12);
});

test('enforceContrast moves the text side, reports every change and leaves passing pairs alone', () => {
  const values = { bg: [255, 255, 255], ok: [15, 23, 42], weak: [160, 170, 180] };
  const checks = [{ label: 'ok text', fill: 'bg', text: 'ok', min: 4.5 }, { label: 'weak text', fill: 'bg', text: 'weak', min: 4.5 }];
  const adjustments = enforceContrast(values, checks, 'light');
  assert.deepEqual(values.bg, [255, 255, 255]);
  assert.deepEqual(values.ok, [15, 23, 42]);
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].name, 'weak');
  assert.ok(adjustments[0].before < 4.5 && adjustments[0].after >= 4.5);
  assert.ok(contrast(values.bg, values.weak) >= 4.5);
  // Smallest change: only just above the minimum
  assert.ok(contrast(values.bg, values.weak) < 4.8);
});

test('a text shared by fills it cannot satisfy together moves the fill instead', () => {
  const values = { light: [250, 250, 250], dark: [20, 20, 20], text: [128, 128, 128] };
  const checks = [{ label: 'a', fill: 'light', text: 'text', min: 7 }, { label: 'b', fill: 'dark', text: 'text', min: 7 }];
  const adjustments = enforceContrast(values, checks, 'light');
  for (const c of checks) assert.ok(contrast(values[c.fill], values[c.text]) >= 7, c.label);
  assert.ok(adjustments.some((a) => a.name === 'light' || a.name === 'dark'));
});

test('random fills and texts always end at or above their minimum', () => {
  const rand = prng(2026);
  for (let i = 0; i < 2000; i++) {
    const values = { f1: randomRgb(rand), f2: randomRgb(rand), t1: randomRgb(rand), t2: randomRgb(rand) };
    const checks = [
      { label: 'p1', fill: 'f1', text: 't1', min: 4.5 },
      { label: 'p2', fill: 'f2', text: 't1', min: 4.5 },
      { label: 'p3', fill: 'f1', text: 't2', min: 3 },
    ];
    enforceContrast(values, checks, 'light');
    for (const c of checks) assert.ok(contrast(values[c.fill], values[c.text]) >= c.min, `seed 2026 case ${i} ${c.label}`);
  }
});
