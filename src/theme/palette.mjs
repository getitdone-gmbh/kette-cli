import { maxChroma, oklchToRgb, rgbToOklch, sameRgb } from './color.mjs';

// Neutral families: cool keeps the slate of the Community theme unchanged, warm takes the hue and chroma of stone, neutral is pure grey
const NEUTRALS = { warm: { h: 58, k: 0.35 }, neutral: { h: 0, k: 0 } };
// Accent fills (accent, sidebar accent) are tinted containers: 30 % of the accent chroma at the lightness of the base value
const ACCENT_TINT = 0.3;
// Below this chroma a primary has no meaningful hue, chart series then keep their own hues
const MIN_HUE_CHROMA = 0.03;
const MAX_NEUTRAL_TINT = 1.5;

function neutralSpec(neutral, anchors) {
  if (neutral === 'cool') return null;
  if (typeof neutral === 'string') return NEUTRALS[neutral];
  const ref = rgbToOklch(anchors.neutralRamp[5]).c;
  const { c, h } = rgbToOklch(neutral);
  return { h, k: Math.min(MAX_NEUTRAL_TINT, c / ref) };
}

// Chroma as a share of what sRGB can show at that lightness and hue, so a tint keeps its saturation in every hue
const relativeChroma = ({ l, c, h }) => {
  const max = maxChroma(l, h);
  return max > 0 ? Math.min(1, c / max) : 0;
};

// Moves a colour of the base brand ramp onto the ramp of target: lightness piecewise linear through the anchor, hue offset kept,
// chroma the geometric mean of absolute scaling (too grey where the target hue has a wide gamut) and gamut-relative scaling (too loud there)
function rampMapper(anchor, target) {
  const a = rgbToOklch(anchor);
  const t = rgbToOklch(target);
  const strength = relativeChroma(a) > 0 ? relativeChroma(t) / relativeChroma(a) : 0;
  const mapL = (l) => (l <= a.l ? (l * t.l) / a.l : t.l + ((l - a.l) * (1 - t.l)) / (1 - a.l));
  return (rgb) => {
    if (sameRgb(rgb, anchor)) return [...target];
    const o = rgbToOklch(rgb);
    const l = mapL(o.l);
    const h = t.h + (o.h - a.h);
    const absolute = a.c > 0 ? (o.c * t.c) / a.c : 0;
    const relative = Math.min(1, relativeChroma(o) * strength) * maxChroma(l, h);
    return oklchToRgb({ l, c: Math.sqrt(absolute * relative), h });
  };
}

// Colour transforms by role for one set of inputs; every function takes and returns [r, g, b]
export function makeTransforms({ primary, accent = null, neutral = 'cool' }, anchors) {
  const spec = neutralSpec(neutral, anchors);
  const toNeutral = (rgb) => {
    if (!spec) return [...rgb];
    const o = rgbToOklch(rgb);
    return oklchToRgb({ l: o.l, c: o.c * spec.k, h: spec.h });
  };
  const toBrand = rampMapper(anchors.brand, primary);
  const accentLch = accent ? rgbToOklch(accent) : null;
  const toAccent = (rgb) => (accentLch ? oklchToRgb({ l: rgbToOklch(rgb).l, c: accentLch.c * ACCENT_TINT, h: accentLch.h }) : toNeutral(rgb));
  const p = rgbToOklch(primary);
  const rotation = p.c >= MIN_HUE_CHROMA ? p.h - rgbToOklch(anchors.brand).h : 0;
  const toChart = (rgb) => {
    const o = rgbToOklch(rgb);
    return oklchToRgb({ l: o.l, c: o.c, h: o.h + rotation });
  };
  const byRole = { neutral: toNeutral, accent: toAccent, brand: toBrand, chart: toChart, fixed: (rgb) => [...rgb] };
  const apply = (role, rgb) => {
    if (!byRole[role]) throw new Error(`Unknown colour role in the theme manifest: ${role}`);
    return byRole[role](rgb);
  };
  // Shadow colours are near-neutral (black, slate, navy) and follow the neutral family; alpha and geometry stay
  const shadow = (value) => value.replace(/(rgba?\(\s*)(\d+)(\s*,\s*|\s+)(\d+)(\s*,\s*|\s+)(\d+)/g, (_, open, r, s1, g, s2, b) => {
    const [nr, ng, nb] = toNeutral([+r, +g, +b]);
    return `${open}${nr}${s1}${ng}${s2}${nb}`;
  });
  const palettes = {
    primary: anchors.brandRamp.map(toBrand),
    neutral: anchors.neutralRamp.map(toNeutral),
    ...(accent ? { accent: anchors.brandRamp.map(rampMapper(anchors.brand, accent)) } : {}),
  };
  return { apply, shadow, toNeutral, palettes };
}

// Radius in px for one manifest entry: a factor of the base radius, or full (pill controls, doubled surfaces, details unchanged)
export function radiusPx(entry, radius, basePx) {
  if (radius === 'full') return entry.group === 'control' ? 9999 : entry.group === 'surface' ? entry.px * 2 : entry.px;
  return Math.round(entry.px * (radius / basePx));
}
