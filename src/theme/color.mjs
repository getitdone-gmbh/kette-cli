// Colour math for kette theme, zero dependencies: sRGB, OKLab/OKLCH (Björn Ottosson), gamut mapping and WCAG 2.x contrast
// Colours travel as [r, g, b] with integers 0 to 255, the format of the theme CSS variables ("r g b")

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHex(input) {
  const m = HEX.exec(String(input).trim());
  if (!m) throw new Error(`Not a hex colour: ${JSON.stringify(input)} (expected #rrggbb or #rgb)`);
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

export const toHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
export const toTriplet = (rgb) => rgb.join(' ');
export const sameRgb = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const toLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

// Linear sRGB (0..1, may leave the gamut) from OKLab
function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function rgbToOklch(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-7 ? 0 : (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c, h: h < 0 ? h + 360 : h };
}

const linearFromLch = (l, c, h) => {
  const rad = (h * Math.PI) / 180;
  return oklabToLinear(l, c * Math.cos(rad), c * Math.sin(rad));
};
const EPS = 1e-6;
const inGamut = (lin) => lin.every((v) => v >= -EPS && v <= 1 + EPS);

// Largest chroma sRGB can show at a lightness and hue (bisection), the scale for gamut-relative chroma
export function maxChroma(l, h) {
  if (l <= 0 || l >= 1) return 0;
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(linearFromLch(l, mid, h))) lo = mid;
    else hi = mid;
  }
  return lo;
}

// OKLCH to sRGB integers; out-of-gamut colours keep lightness and hue and lose chroma (bisection), which keeps the result deterministic
export function oklchToRgb({ l, c, h }) {
  const L = Math.min(1, Math.max(0, l));
  let chroma = Math.max(0, c);
  let lin = linearFromLch(L, chroma, h);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = chroma;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(linearFromLch(L, mid, h))) lo = mid;
      else hi = mid;
    }
    chroma = lo;
    lin = linearFromLch(L, chroma, h);
  }
  return lin.map((v) => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))) * 255));
}

// WCAG 2.x relative luminance and contrast ratio, as the token gates compute them
export function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export const hueDistance = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
