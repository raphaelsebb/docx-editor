/**
 * Font resolution + embedding for the PDF exporter.
 *
 * pdf-lib needs raw glyph bytes per face, and bold/italic are SEPARATE faces
 * (there is no faux-bold). So for each `(family, bold, italic)` a run uses we:
 *   1. map the DOCX family → Google family via {@link resolveFontFamily}
 *   2. request the matching `ital,wght` variant from Google Fonts CSS2
 *   3. fetch the woff2 from the matching `@font-face` block and `embedFont(subset)`
 *
 * Fonts are fetched concurrently but EMBEDDED sequentially (embedFont mutates the
 * shared PDFDocument), cached per face, and warmed up per page so the line
 * positioner can call a synchronous metric (`getFontSync(...).widthOfTextAtSize`)
 * — the same face the glyphs draw with, so run-x cannot drift from the glyphs.
 *
 * Fallback chain: embedded Google subset → bundled Unicode face (if provided) →
 * standard-14 base font by category. Standard-14 is WinAnsi-only, so callers must
 * guard non-Latin text via {@link canEncode} and swap to the Unicode fallback.
 */

import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { resolveFontFamily } from '../utils/fontResolver';

export interface FontStyle {
  bold?: boolean;
  italic?: boolean;
}

export interface FontProvider {
  /** Resolve + embed every face a page references, so getFontSync is ready. */
  warmUp(faces: Array<{ family: string } & FontStyle>): Promise<void>;
  /** Synchronous face lookup (valid after warmUp); never null. */
  getFontSync(family: string, style: FontStyle): PDFFont;
  /** A Unicode-capable face for runs the chosen face cannot encode. */
  getUnicodeFallbackSync(): PDFFont;
}

const faceKey = (family: string, s: FontStyle) =>
  `${family.toLowerCase()}|${s.bold ? 1 : 0}|${s.italic ? 1 : 0}`;

/** Detect the generic family at the tail of a CSS fallback stack. */
function categoryOf(cssFallback: string): 'serif' | 'monospace' | 'sans-serif' {
  const s = cssFallback.toLowerCase();
  if (s.includes('monospace')) return 'monospace';
  if (s.includes('serif') && !s.includes('sans-serif')) return 'serif';
  return 'sans-serif';
}

/** Pick the standard-14 base font matching a category + style (pure). */
export function selectStandard14(
  category: 'serif' | 'monospace' | 'sans-serif',
  s: FontStyle
): StandardFonts {
  if (category === 'monospace') {
    if (s.bold && s.italic) return StandardFonts.CourierBoldOblique;
    if (s.bold) return StandardFonts.CourierBold;
    if (s.italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (category === 'serif') {
    if (s.bold && s.italic) return StandardFonts.TimesRomanBoldItalic;
    if (s.bold) return StandardFonts.TimesRomanBold;
    if (s.italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (s.bold && s.italic) return StandardFonts.HelveticaBoldOblique;
  if (s.bold) return StandardFonts.HelveticaBold;
  if (s.italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

/** Build a CSS2 URL requesting exactly one `ital,wght` variant (pure). */
export function variantCss2Url(googleFont: string, s: FontStyle): string {
  const ital = s.italic ? 1 : 0;
  const wght = s.bold ? 700 : 400;
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(googleFont)}:ital,wght@${ital},${wght}&display=swap`;
}

/**
 * Pick the woff2 URL whose `@font-face` block matches the requested style (pure).
 * Falls back to the first woff2 in the stylesheet if no block matches the exact
 * weight/style (e.g. Google served a variable face or a single static variant).
 */
export function pickWoff2ForVariant(css: string, s: FontStyle): string | undefined {
  const wantWeight = s.bold ? '700' : '400';
  const wantStyle = s.italic ? 'italic' : 'normal';
  const blocks = css.split('@font-face');
  for (const block of blocks) {
    const weight = block.match(/font-weight:\s*([^;]+);/)?.[1]?.trim();
    const style = block.match(/font-style:\s*([^;]+);/)?.[1]?.trim();
    const url = block.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
    if (url && weight === wantWeight && style === wantStyle) return url;
  }
  return css.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
}

/** True if `font` can encode every character in `text` (standard-14 = WinAnsi). */
export function canEncode(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

// Google Fonts CSS2 serves woff2 only to modern browsers; a recent Chrome UA
// gets the small woff2 faces. In a real browser `fetch` already sends this (the
// header is ignored/forbidden there); setting it makes Node/SSR fetch work too.
const MODERN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': MODERN_UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchBytes(url: string, timeoutMs: number): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': MODERN_UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

export interface GoogleFontProviderOptions {
  /** Per-font fetch timeout (ms). */
  timeoutMs?: number;
  /** Optional bundled Unicode fallback face bytes (woff2/ttf). */
  unicodeFallbackBytes?: Uint8Array;
  /** Surface non-fatal issues (font fetch failures, etc.). */
  onWarning?: (message: string) => void;
}

/**
 * Default {@link FontProvider}: embeds Google subsets per face with graceful
 * fallback. Requires the host `PDFDocument` (already `registerFontkit`-ed).
 */
export class GoogleFontProvider implements FontProvider {
  private readonly cache = new Map<string, PDFFont>();
  private readonly std14 = new Map<string, PDFFont>();
  private unicodeFallback?: PDFFont;
  private readonly timeoutMs: number;

  constructor(
    private readonly doc: PDFDocument,
    private readonly opts: GoogleFontProviderOptions = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async warmUp(faces: Array<{ family: string } & FontStyle>): Promise<void> {
    // De-dupe to one entry per face, then fetch concurrently / embed sequentially.
    const unique = new Map<string, { family: string } & FontStyle>();
    for (const f of faces) unique.set(faceKey(f.family, f), f);

    // Ensure the terminal Unicode fallback is available first.
    if (!this.unicodeFallback && this.opts.unicodeFallbackBytes) {
      this.unicodeFallback = await this.doc.embedFont(this.opts.unicodeFallbackBytes, {
        subset: true,
      });
    }

    const fetched = await Promise.all(
      [...unique.values()].map(async (f) => {
        if (this.cache.has(faceKey(f.family, f))) return null;
        const resolved = resolveFontFamily(f.family);
        if (!resolved.googleFont) return { f, bytes: null as Uint8Array | null, resolved };
        try {
          const css = await fetchText(variantCss2Url(resolved.googleFont, f), this.timeoutMs);
          const url = pickWoff2ForVariant(css, f);
          if (!url) {
            this.opts.onWarning?.(`no woff2 variant for ${resolved.googleFont}; using fallback`);
            return { f, bytes: null, resolved };
          }
          return { f, bytes: await fetchBytes(url, this.timeoutMs), resolved };
        } catch (e) {
          this.opts.onWarning?.(`font fetch failed for ${resolved.googleFont}: ${String(e)}`);
          return { f, bytes: null, resolved };
        }
      })
    );

    // embedFont mutates the shared doc — must be sequential.
    for (const item of fetched) {
      if (!item) continue;
      const { f, bytes, resolved } = item;
      const key = faceKey(f.family, f);
      if (bytes) {
        try {
          this.cache.set(key, await this.doc.embedFont(bytes, { subset: true }));
          continue;
        } catch (e) {
          this.opts.onWarning?.(`font embed failed for ${resolved.googleFont}: ${String(e)}`);
        }
      }
      this.cache.set(key, this.standard14(categoryOf(resolved.cssFallback), f));
    }
  }

  private standard14(category: 'serif' | 'monospace' | 'sans-serif', s: FontStyle): PDFFont {
    const name = selectStandard14(category, s);
    let f = this.std14.get(name);
    if (!f) {
      f = this.doc.embedStandardFont(name);
      this.std14.set(name, f);
    }
    return f;
  }

  getFontSync(family: string, style: FontStyle): PDFFont {
    const hit = this.cache.get(faceKey(family, style));
    if (hit) return hit;
    // Not warmed up for this face — synchronous standard-14 by category.
    const resolved = resolveFontFamily(family);
    return this.standard14(categoryOf(resolved.cssFallback), style);
  }

  getUnicodeFallbackSync(): PDFFont {
    return this.unicodeFallback ?? this.standard14('sans-serif', {});
  }
}
