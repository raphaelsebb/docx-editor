/**
 * Text + decoration drawing for the PDF exporter.
 *
 * Draws one positioned run (color, super/subscript, underline/strike) using the
 * embedded face, guarding WinAnsi-only fallback faces against non-Latin text by
 * swapping to the Unicode fallback. Line/baseline math lives in `coords`; run x
 * comes from `positionRunsInLine` (measured with this same face).
 */

import { rgb, type PDFFont, type RGB } from 'pdf-lib';
import type { PageSink } from './pageSink';
import type { Run } from '../layout-engine/types';
import { parseCssColor } from './cssColor';
import { canEncode, type FontProvider, type FontStyle } from './fontProvider';
import { pxToPt } from './coords';

const BLACK = rgb(0, 0, 0);

/** CSS color string → pdf-lib RGB, defaulting to black. */
export function colorToPdf(css: string | undefined, fallback: RGB = BLACK): RGB {
  const p = parseCssColor(css);
  return p ? rgb(p.r, p.g, p.b) : fallback;
}

/** Alpha (0–1) of a CSS color, or 1 if opaque/unparsed. */
export function alphaOf(css: string | undefined): number {
  return parseCssColor(css)?.alpha ?? 1;
}

const styleOf = (run: Run): FontStyle => ({
  bold: 'bold' in run && run.bold,
  italic: 'italic' in run && run.italic,
});

/** Drop characters `font` cannot encode (last resort so the export never throws). */
function stripUnencodable(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      /* skip un-encodable glyph */
    }
  }
  return out;
}

/** Resolve the face to draw a run with, swapping to Unicode fallback if it can't encode. */
export function faceFor(run: Run, text: string, fonts: FontProvider): PDFFont {
  const family = ('fontFamily' in run && run.fontFamily) || 'Calibri';
  const face = fonts.getFontSync(family, styleOf(run));
  if (text && !canEncode(face, text)) return fonts.getUnicodeFallbackSync();
  return face;
}

/**
 * Advance width that never throws on un-encodable glyphs. `widthOfTextAtSize`
 * encodes internally, so a WinAnsi-only fallback would throw on non-Latin; we
 * measure the encodable subset (an estimate for the dropped glyphs).
 */
export function safeWidth(font: PDFFont, text: string, sizePt: number): number {
  try {
    return font.widthOfTextAtSize(text, sizePt);
  } catch {
    let w = 0;
    for (const ch of text) {
      try {
        w += font.widthOfTextAtSize(ch, sizePt);
      } catch {
        w += sizePt * 0.5; // rough advance for a dropped glyph
      }
    }
    return w;
  }
}

export interface DrawRunArgs {
  page: PageSink;
  text: string;
  /** Absolute page x (pt). */
  xPt: number;
  /** Glyph baseline y (pt). */
  baselinePt: number;
  /** Advance width of the run in px (for underline/strike/highlight extents). */
  widthPx: number;
  /** Line ascent in px (for the highlight band); falls back to a size estimate. */
  ascentPx?: number;
  /** Line descent in px (for the highlight band); falls back to a size estimate. */
  descentPx?: number;
  /** Extra pt added to each inter-word space when justifying (0 = none). */
  wordSpacingPt?: number;
  run: Run;
  fonts: FontProvider;
}

/**
 * Draw text, optionally widening each inter-word space by `wordSpacingPt` (for
 * justify — pdf-lib's single `drawText` can't, so we draw word-by-word). Returns
 * nothing; throws bubble to the caller's fallback.
 */
function drawTextJustified(
  page: PageSink,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  color: RGB,
  opacity: number,
  wordSpacingPt: number
): void {
  if (wordSpacingPt <= 0 || !text.includes(' ')) {
    page.drawText(text, { x, y, size, font, color, opacity });
    return;
  }
  const spaceW = font.widthOfTextAtSize(' ', size);
  const parts = text.split(' ');
  let cx = x;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) {
      page.drawText(parts[i], { x: cx, y, size, font, color, opacity });
      cx += font.widthOfTextAtSize(parts[i], size);
    }
    if (i < parts.length - 1) cx += spaceW + wordSpacingPt;
  }
}

/**
 * Draw a single text/field run with its decorations: highlight background,
 * glyphs, underline, strike. Super/subscript shrink the size (~0.75em, matching
 * the painter) and shift the baseline. Hidden runs never reach here.
 */
export function drawTextRun(args: DrawRunArgs): void {
  const { page, text, xPt, baselinePt, widthPx, run, fonts } = args;
  if (!text) return;
  const face = faceFor(run, text, fonts);

  const basePt = ('fontSize' in run && run.fontSize) || 11;
  const isSuper = 'superscript' in run && run.superscript;
  const isSub = 'subscript' in run && run.subscript;
  // Match the painter's `font-size: 0.75em` for super/subscript.
  const sizePt = isSuper || isSub ? basePt * 0.75 : basePt;
  const shiftPt = isSuper ? basePt * 0.33 : isSub ? -basePt * 0.18 : 0;

  const color = colorToPdf('color' in run ? run.color : undefined);
  const opacity = alphaOf('color' in run ? run.color : undefined);
  const widthPt = pxToPt(widthPx);

  // Highlight background (w:highlight) — drawn behind the glyphs, spanning the
  // line band (ascent above baseline, descent below).
  const highlight = 'highlight' in run ? run.highlight : undefined;
  const hlParsed = highlight ? parseCssColor(highlight) : undefined;
  if (hlParsed) {
    const ascentPt = pxToPt(args.ascentPx ?? basePt * 1.2);
    const descentPt = pxToPt(args.descentPx ?? basePt * 0.35);
    page.drawRectangle({
      x: xPt,
      y: baselinePt - descentPt,
      width: widthPt,
      height: ascentPt + descentPt,
      color: rgb(hlParsed.r, hlParsed.g, hlParsed.b),
    });
  }

  const y = baselinePt + shiftPt;
  try {
    drawTextJustified(page, text, xPt, y, sizePt, face, color, opacity, args.wordSpacingPt ?? 0);
  } catch {
    // The chosen face can't encode some glyph. Try the Unicode fallback; if even
    // that can't (no Unicode face was bundled), drop the un-encodable glyphs so
    // the export never throws.
    const fb = fonts.getUnicodeFallbackSync();
    const safe = canEncode(fb, text) ? text : stripUnencodable(fb, text);
    if (safe) page.drawText(safe, { x: xPt, y, size: sizePt, font: fb, color, opacity });
  }

  // Underline.
  const underline = 'underline' in run ? run.underline : undefined;
  if (underline) {
    const uColor =
      typeof underline === 'object' && underline.color ? colorToPdf(underline.color) : color;
    const thickness = Math.max(0.5, sizePt * 0.06);
    const y = baselinePt + shiftPt - sizePt * 0.12;
    page.drawLine({ start: { x: xPt, y }, end: { x: xPt + widthPt, y }, thickness, color: uColor });
    if (typeof underline === 'object' && underline.style === 'double') {
      page.drawLine({
        start: { x: xPt, y: y - thickness * 1.5 },
        end: { x: xPt + widthPt, y: y - thickness * 1.5 },
        thickness,
        color: uColor,
      });
    }
  }
  // Strikethrough.
  if ('strike' in run && run.strike) {
    const y = baselinePt + shiftPt + sizePt * 0.28;
    page.drawLine({
      start: { x: xPt, y },
      end: { x: xPt + widthPt, y },
      thickness: Math.max(0.5, sizePt * 0.06),
      color,
    });
  }
}
