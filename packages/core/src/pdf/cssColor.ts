/**
 * CSS color string → pdf-lib color, for the PDF exporter.
 *
 * Runs/borders/shading/highlight carry CSS strings by the time they reach the
 * `Layout` (theme colors are already resolved upstream by the layout-bridge).
 * pdf-lib wants three 0–1 channels plus a separate opacity, so we parse the full
 * surface the model can emit: `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`, `rgb()/rgba()`,
 * `hsl()/hsla()`, and the named colors the painter uses (notably the OOXML
 * highlight names like `yellow`/`darkBlue` from {@link HIGHLIGHT_HEX_TO_NAME}).
 */

import { HIGHLIGHT_HEX_TO_NAME } from '../utils/highlightColors';

/** A parsed color: channels and alpha in the 0–1 range pdf-lib expects. */
export interface ParsedColor {
  r: number;
  g: number;
  b: number;
  /** 0 (transparent) – 1 (opaque). */
  alpha: number;
}

/** Name → hex, inverted from the OOXML highlight table, plus a few CSS basics. */
const NAMED: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [hex, name] of Object.entries(HIGHLIGHT_HEX_TO_NAME)) {
    m[name.toLowerCase()] = hex;
  }
  // CSS basics the highlight table doesn't cover.
  Object.assign(m, {
    gray: '808080',
    grey: '808080',
    silver: 'C0C0C0',
    maroon: '800000',
    olive: '808000',
    lime: '00FF00',
    aqua: '00FFFF',
    teal: '008080',
    navy: '000080',
    fuchsia: 'FF00FF',
    purple: '800080',
    orange: 'FFA500',
  });
  return m;
})();

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const hexPair = (s: string) => parseInt(s, 16) / 255;

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  s = clamp01(s);
  l = clamp01(l);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: r + m, g: g + m, b: b + m };
}

/**
 * Parse a CSS color string. Returns `undefined` for `transparent`, `auto`,
 * `inherit`, `none`, empty, or anything unrecognized — callers treat that as
 * "no fill / use default" rather than drawing black.
 */
export function parseCssColor(input: string | undefined): ParsedColor | undefined {
  if (!input) return undefined;
  const s = input.trim().toLowerCase();
  if (s === '' || s === 'transparent' || s === 'none' || s === 'auto' || s === 'inherit') {
    return undefined;
  }

  // Named (incl. OOXML highlight names).
  const named = NAMED[s];
  if (named) {
    return {
      r: hexPair(named.slice(0, 2)),
      g: hexPair(named.slice(2, 4)),
      b: hexPair(named.slice(4, 6)),
      alpha: 1,
    };
  }

  // Hex: #rgb, #rgba, #rrggbb, #rrggbbaa (with or without #).
  if (/^#?[0-9a-f]{3,8}$/.test(s)) {
    let hex = s.replace(/^#/, '');
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: hexPair(hex.slice(0, 2)),
        g: hexPair(hex.slice(2, 4)),
        b: hexPair(hex.slice(4, 6)),
        alpha: hex.length === 8 ? hexPair(hex.slice(6, 8)) : 1,
      };
    }
  }

  // rgb()/rgba() — channels 0–255 (or %), alpha 0–1.
  const rgb = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length >= 3) {
      const chan = (p: string) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255);
      const a =
        parts[3] !== undefined
          ? parts[3].endsWith('%')
            ? parseFloat(parts[3]) / 100
            : parseFloat(parts[3])
          : 1;
      return {
        r: clamp01(chan(parts[0])),
        g: clamp01(chan(parts[1])),
        b: clamp01(chan(parts[2])),
        alpha: clamp01(a),
      };
    }
  }

  // hsl()/hsla().
  const hsl = s.match(/^hsla?\(([^)]+)\)$/);
  if (hsl) {
    const parts = hsl[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length >= 3) {
      const { r, g, b } = hslToRgb(
        parseFloat(parts[0]),
        parseFloat(parts[1]) / 100,
        parseFloat(parts[2]) / 100
      );
      const a =
        parts[3] !== undefined
          ? parts[3].endsWith('%')
            ? parseFloat(parts[3]) / 100
            : parseFloat(parts[3])
          : 1;
      return { r: clamp01(r), g: clamp01(g), b: clamp01(b), alpha: clamp01(a) };
    }
  }

  return undefined;
}
