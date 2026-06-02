/**
 * Coordinate + baseline math for the PDF exporter.
 *
 * The layout engine works in CSS px @96dpi with a top-left origin; PDF works in
 * points @72dpi with a BOTTOM-left origin, and `drawText` positions glyphs by
 * their baseline (not the line top). These helpers do the two conversions the
 * exporter needs everywhere: px→pt, and px-top-left-Y → pt-bottom-left-Y.
 *
 * Kept dependency-free (no canvas, no `measureContainer`) so the lazily-imported
 * `./pdf` chunk stays small. `pxToPt` here is identical to
 * `measureContainer.ptToPx`'s inverse (`px * 72 / 96`).
 */

import type { MeasuredLine } from '../layout-engine/types';

/** Points per CSS pixel: 72pt/in ÷ 96px/in. */
export const PT_PER_PX = 72 / 96;

/** Convert a CSS-pixel length to PDF points. */
export function pxToPt(px: number): number {
  return px * PT_PER_PX;
}

/**
 * Vertical distance from a line's top to its text baseline, in px.
 *
 * The painter never computes a baseline in JS — CSS centers the inline box from
 * the line height. We reproduce that: the leading (extra space beyond
 * ascent+descent, which is how `lineRule` auto/atLeast/exact surface as a taller
 * box) is split evenly above and below, and the baseline sits one ascent below
 * the box top. Mixed-size runs share the line's ascent (driven by the tallest
 * run during measurement), so small runs sit on the same baseline as on screen.
 */
export function baselineFromTop(
  line: Pick<MeasuredLine, 'ascent' | 'descent' | 'lineHeight'>
): number {
  const leading = line.lineHeight - (line.ascent + line.descent);
  return leading / 2 + line.ascent;
}

/**
 * Map a top-left px point on a page to a bottom-left pt point for pdf-lib.
 *
 * @param yTopPx   distance from the page top, in px
 * @param pageHpx  page height in px (use the page's own `size.h`, not a doc default)
 */
export function pageYToPt(yTopPx: number, pageHpx: number): number {
  return pxToPt(pageHpx) - pxToPt(yTopPx);
}

/**
 * Baseline Y in PDF points for a glyph drawn on `line`, whose box top is at
 * `lineTopPx` from the page top. `extraShiftPx` is an additive baseline raise
 * (positive = up), used for super/subscript and `w:position`.
 */
export function textBaselinePt(
  lineTopPx: number,
  line: Pick<MeasuredLine, 'ascent' | 'descent' | 'lineHeight'>,
  pageHpx: number,
  extraShiftPx = 0
): number {
  const baselinePx = lineTopPx + baselineFromTop(line) - extraShiftPx;
  return pageYToPt(baselinePx, pageHpx);
}
