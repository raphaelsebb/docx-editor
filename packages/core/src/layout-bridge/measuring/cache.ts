/**
 * Measurement Cache
 *
 * LRU cache for text width measurements and paragraph layout results.
 * Improves performance by avoiding repeated measurements of identical content.
 */

import type { ParagraphBlock, ParagraphMeasure } from '../../layout-engine/types';
import type { FloatingImageZone } from './floatingZones';

// =============================================================================
// TEXT WIDTH CACHE
// =============================================================================

/**
 * Cache entry for text width measurements
 */
interface TextWidthEntry {
  width: number;
}

/**
 * Default max entries for text width cache
 * Large documents (30+ pages) can generate 20,000+ unique text measurements.
 * A generous default avoids cache thrashing on big docs.
 */
const DEFAULT_TEXT_CACHE_SIZE = 20000;

/**
 * Current max size for text width cache
 */
let textCacheMaxSize = DEFAULT_TEXT_CACHE_SIZE;

/**
 * LRU cache for text width measurements
 * Key format: "text|font|letterSpacing"
 */
const textWidthCache = new Map<string, TextWidthEntry>();

/**
 * Create a cache key for text width lookup
 */
function makeTextKey(text: string, font: string, letterSpacing: number): string {
  return `${text}|${font}|${letterSpacing || 0}`;
}

/**
 * Evict oldest entries if cache exceeds max size
 */
function evictTextEntries(): void {
  while (textWidthCache.size > textCacheMaxSize) {
    const oldestKey = textWidthCache.keys().next().value;
    if (oldestKey === undefined) break;
    textWidthCache.delete(oldestKey);
  }
}

/**
 * Get cached text width or return undefined
 */
export function getCachedTextWidth(
  text: string,
  font: string,
  letterSpacing: number = 0
): number | undefined {
  const key = makeTextKey(text, font, letterSpacing);
  const entry = textWidthCache.get(key);

  if (entry !== undefined) {
    // Refresh LRU - move to end by re-inserting
    textWidthCache.delete(key);
    textWidthCache.set(key, entry);
    return entry.width;
  }

  return undefined;
}

/**
 * Store text width in cache
 */
export function setCachedTextWidth(
  text: string,
  font: string,
  letterSpacing: number,
  width: number
): void {
  const key = makeTextKey(text, font, letterSpacing);
  textWidthCache.set(key, { width });
  evictTextEntries();
}

/**
 * Clear the text width cache
 */
export function clearTextWidthCache(): void {
  textWidthCache.clear();
}

/**
 * Set the maximum size of the text width cache
 */
export function setTextCacheSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    return;
  }
  textCacheMaxSize = size;
  evictTextEntries();
}

/**
 * Get current text width cache size
 */
export function getTextCacheSize(): number {
  return textWidthCache.size;
}

// =============================================================================
// FONT METRICS CACHE
// =============================================================================

/**
 * Cached font metrics entry
 */
interface FontMetricsEntry {
  ascent: number;
  descent: number;
  lineHeight: number;
}

/**
 * Default max entries for font metrics cache
 */
const DEFAULT_FONT_CACHE_SIZE = 1000;

/**
 * Current max size for font metrics cache
 */
let fontCacheMaxSize = DEFAULT_FONT_CACHE_SIZE;

/**
 * LRU cache for font metrics
 * Key format: "fontFamily|fontSize|bold|italic"
 */
const fontMetricsCache = new Map<string, FontMetricsEntry>();

/**
 * Create a cache key for font metrics lookup
 */
function makeFontKey(
  fontFamily: string,
  fontSize: number,
  bold: boolean = false,
  italic: boolean = false
): string {
  return `${fontFamily}|${fontSize}|${bold}|${italic}`;
}

/**
 * Evict oldest entries if font cache exceeds max size
 */
function evictFontEntries(): void {
  while (fontMetricsCache.size > fontCacheMaxSize) {
    const oldestKey = fontMetricsCache.keys().next().value;
    if (oldestKey === undefined) break;
    fontMetricsCache.delete(oldestKey);
  }
}

/**
 * Get cached font metrics or return undefined
 */
export function getCachedFontMetrics(
  fontFamily: string,
  fontSize: number,
  bold: boolean = false,
  italic: boolean = false
): FontMetricsEntry | undefined {
  const key = makeFontKey(fontFamily, fontSize, bold, italic);
  const entry = fontMetricsCache.get(key);

  if (entry !== undefined) {
    // Refresh LRU
    fontMetricsCache.delete(key);
    fontMetricsCache.set(key, entry);
    return entry;
  }

  return undefined;
}

/**
 * Store font metrics in cache
 */
export function setCachedFontMetrics(
  fontFamily: string,
  fontSize: number,
  bold: boolean,
  italic: boolean,
  metrics: FontMetricsEntry
): void {
  const key = makeFontKey(fontFamily, fontSize, bold, italic);
  fontMetricsCache.set(key, metrics);
  evictFontEntries();
}

/**
 * Clear the font metrics cache
 */
export function clearFontMetricsCache(): void {
  fontMetricsCache.clear();
}

/**
 * Set the maximum size of the font metrics cache
 */
export function setFontCacheSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    return;
  }
  fontCacheMaxSize = size;
  evictFontEntries();
}

/**
 * Get current font metrics cache size
 */
export function getFontCacheSize(): number {
  return fontMetricsCache.size;
}

// =============================================================================
// PARAGRAPH MEASURE CACHE
// =============================================================================

/**
 * Cached paragraph measurement entry
 */
interface ParagraphMeasureEntry {
  measure: ParagraphMeasure;
  maxWidth: number;
}

/**
 * Default max entries for paragraph measure cache
 * Large documents can have 500+ unique paragraphs.
 */
const DEFAULT_PARAGRAPH_CACHE_SIZE = 5000;

/**
 * Current max size for paragraph measure cache
 */
let paragraphCacheMaxSize = DEFAULT_PARAGRAPH_CACHE_SIZE;

/**
 * LRU cache for paragraph measurements
 * Key format: block content hash
 */
const paragraphMeasureCache = new Map<string, ParagraphMeasureEntry>();

/**
 * Generate a simple hash for a paragraph block
 * Used as cache key to identify identical content
 */
export function hashParagraphBlock(block: ParagraphBlock): string {
  // Simple hash based on runs content
  const parts: string[] = [];

  for (const run of block.runs) {
    if (run.kind === 'text') {
      parts.push(`t:${run.text}|${run.fontFamily}|${run.fontSize}|${run.bold}|${run.italic}`);
    } else if (run.kind === 'tab') {
      parts.push(`tab:${run.width}`);
    } else if (run.kind === 'image') {
      parts.push(`img:${run.width}x${run.height}`);
    } else if (run.kind === 'lineBreak') {
      parts.push('br');
    }
  }

  // Include relevant attrs in hash
  const attrs = block.attrs;
  if (attrs) {
    if (attrs.alignment) parts.push(`align:${attrs.alignment}`);
    if (attrs.indent) {
      parts.push(
        `indent:${attrs.indent.left}|${attrs.indent.right}|${attrs.indent.firstLine}|${attrs.indent.hanging}`
      );
    }
    if (attrs.spacing) {
      parts.push(
        `spacing:${attrs.spacing.before}|${attrs.spacing.after}|${attrs.spacing.line}|${attrs.spacing.lineRule}`
      );
    }
    // Default font drives line height for empty paragraphs (no runs to hash).
    // Without this, empty paragraphs collide regardless of font choice and the
    // caret renders at the previously cached size until typing forces a re-key.
    if (attrs.defaultFontSize != null) parts.push(`dfs:${attrs.defaultFontSize}`);
    if (attrs.defaultFontFamily != null) parts.push(`dff:${attrs.defaultFontFamily}`);
    // Borders affect measurement only via box-sizing in the renderer, but their
    // presence on otherwise-identical empty paragraphs (e.g. one with a
    // `<w:pBdr>` horizontal rule, one without) is a real authorial difference
    // — fold them into the key so the two don't share a cache entry.
    const b = attrs.borders;
    if (b) {
      const sig = (s?: { width?: number; style?: string; color?: string }) =>
        s ? `${s.width ?? ''},${s.style ?? ''},${s.color ?? ''}` : '';
      parts.push(`bdr:${sig(b.top)}|${sig(b.bottom)}|${sig(b.left)}|${sig(b.right)}`);
    }
    // Same for the trailing-empty-paragraph-after-table zero-height flag.
    if (attrs.suppressEmptyParagraphHeight) parts.push('sup');
    // Paragraph-mark revision presence affects painted output (pilcrow ::after
    // glyph, margin change bar via box-shadow). Two paragraphs with identical
    // text and runs but different revision state must NOT share a measurement
    // cache entry, or the second-painted doc inherits the first's pilcrow.
    if (attrs.pPrIns) parts.push(`pins:${attrs.pPrIns.revisionId}`);
    if (attrs.pPrDel) parts.push(`pdel:${attrs.pPrDel.revisionId}`);
  }

  return parts.join('||');
}

/**
 * Evict oldest entries if paragraph cache exceeds max size
 */
function evictParagraphEntries(): void {
  while (paragraphMeasureCache.size > paragraphCacheMaxSize) {
    const oldestKey = paragraphMeasureCache.keys().next().value;
    if (oldestKey === undefined) break;
    paragraphMeasureCache.delete(oldestKey);
  }
}

/**
 * Get cached paragraph measurement or return undefined
 */
export function getCachedParagraphMeasure(
  block: ParagraphBlock,
  maxWidth: number
): ParagraphMeasure | undefined {
  const key = hashParagraphBlock(block);
  const entry = paragraphMeasureCache.get(key);

  if (entry !== undefined && entry.maxWidth === maxWidth) {
    // Refresh LRU
    paragraphMeasureCache.delete(key);
    paragraphMeasureCache.set(key, entry);
    return entry.measure;
  }

  return undefined;
}

/**
 * Store paragraph measurement in cache
 */
export function setCachedParagraphMeasure(
  block: ParagraphBlock,
  maxWidth: number,
  measure: ParagraphMeasure
): void {
  const key = hashParagraphBlock(block);
  paragraphMeasureCache.set(key, { measure, maxWidth });
  evictParagraphEntries();
}

/**
 * Clear the paragraph measure cache
 */
export function clearParagraphMeasureCache(): void {
  paragraphMeasureCache.clear();
}

/**
 * Set the maximum size of the paragraph measure cache
 */
export function setParagraphCacheSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    return;
  }
  paragraphCacheMaxSize = size;
  evictParagraphEntries();
}

/**
 * Get current paragraph measure cache size
 */
export function getParagraphCacheSize(): number {
  return paragraphMeasureCache.size;
}

// =============================================================================
// PARAGRAPH MEASURE CACHE — FLOATING-ZONE-AWARE
// =============================================================================
//
// When floating zones are active the plain paragraph cache cannot be used
// because measurement also depends on the zone geometry and the paragraph's
// cumulative Y (which controls which zone lines overlap). This cache extends
// the key to include a hash of the active zones and the exact cumulativeY,
// making it safe to cache even float-affected paragraphs.
//
// Cache-hit conditions across consecutive keystrokes:
//   • Paragraph content unchanged (same paragraphHash)
//   • Content width unchanged
//   • Active floating zones unchanged (image not moved/resized)
//   • cumulativeY unchanged (no upstream paragraph changed its line count)
//
// In practice the zones are stable for all text-only edits, and cumulativeY is
// stable for all paragraphs upstream of the edit + downstream paragraphs when
// the edited paragraph stays on the same number of lines. This eliminates the
// dominant ~300–400 ms re-measure cost for image-heavy documents.

/**
 * Produce a stable string key from the active floating zones.
 * Includes zone geometry (topY, bottomY, leftMargin, rightMargin, segments).
 * Does NOT include the anchor block index — that's a document-position detail
 * already captured by cumulativeY and not needed for measurement correctness.
 */
// WeakMap so the hash is computed once per unique zones array reference.
const floatZonesHashCache = new WeakMap<FloatingImageZone[], string>();

/** @internal */
export function hashFloatingZones(zones: FloatingImageZone[] | undefined): string {
  if (!zones || zones.length === 0) return '';
  const cached = floatZonesHashCache.get(zones);
  if (cached !== undefined) return cached;
  // djb2 hash over key geometry fields
  let h = 5381;
  for (const z of zones) {
    h = (((h << 5) + h) ^ Math.round(z.leftMargin)) >>> 0;
    h = (((h << 5) + h) ^ Math.round(z.rightMargin)) >>> 0;
    h = (((h << 5) + h) ^ Math.round(z.topY)) >>> 0;
    h = (((h << 5) + h) ^ Math.round(z.bottomY)) >>> 0;
    if (z.segments) {
      for (const s of z.segments) {
        h = (((h << 5) + h) ^ Math.round(s.availableWidth)) >>> 0;
      }
    }
  }
  const hash = h.toString(36);
  floatZonesHashCache.set(zones, hash);
  return hash;
}

// Single-level LRU cache keyed on:
//   "paragraphHash@@maxWidth@@zonesId@@cumulativeY"
// where zonesId is a SHORT numeric hash of the zone geometry (not the full
// 1500-char serialization). The full zone geometry string was the performance
// bottleneck: Map operations on 1630-char keys are ~15x slower than on the
// ~100-char plain-paragraph cache keys. A 7-char djb2 hash keeps the key short
// while uniquely identifying each distinct zone configuration in practice.

const DEFAULT_PARAGRAPH_FLOAT_CACHE_SIZE = 10000;
let paragraphFloatCacheMaxSize = DEFAULT_PARAGRAPH_FLOAT_CACHE_SIZE;

const paragraphFloatMeasureCache = new Map<string, ParagraphMeasure>();

function evictParagraphFloatEntries(): void {
  while (paragraphFloatMeasureCache.size > paragraphFloatCacheMaxSize) {
    const oldestKey = paragraphFloatMeasureCache.keys().next().value;
    if (oldestKey === undefined) break;
    paragraphFloatMeasureCache.delete(oldestKey);
  }
}

function makeFloatKey(
  paragraphHash: string,
  maxWidth: number,
  zonesId: string,
  cumulativeY: number
): string {
  return `${paragraphHash}@@${maxWidth}@@${zonesId}@@${cumulativeY}`;
}

/** @internal */
export function getCachedParagraphMeasureFloat(
  block: ParagraphBlock,
  maxWidth: number,
  zones: FloatingImageZone[],
  cumulativeY: number
): ParagraphMeasure | undefined {
  const key = makeFloatKey(
    hashParagraphBlock(block),
    maxWidth,
    hashFloatingZones(zones),
    cumulativeY
  );
  const entry = paragraphFloatMeasureCache.get(key);
  if (entry !== undefined) {
    paragraphFloatMeasureCache.delete(key);
    paragraphFloatMeasureCache.set(key, entry);
    return entry;
  }
  return undefined;
}

/** @internal */
export function setCachedParagraphMeasureFloat(
  block: ParagraphBlock,
  maxWidth: number,
  zones: FloatingImageZone[],
  cumulativeY: number,
  measure: ParagraphMeasure
): void {
  const key = makeFloatKey(
    hashParagraphBlock(block),
    maxWidth,
    hashFloatingZones(zones),
    cumulativeY
  );
  paragraphFloatMeasureCache.set(key, measure);
  evictParagraphFloatEntries();
}

/** @internal */
export function clearParagraphFloatMeasureCache(): void {
  paragraphFloatMeasureCache.clear();
}

/** @internal */
export function setParagraphFloatCacheSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) return;
  paragraphFloatCacheMaxSize = size;
  evictParagraphFloatEntries();
}

/** @internal */
export function getParagraphFloatCacheSize(): number {
  return paragraphFloatMeasureCache.size;
}

// =============================================================================
// GLOBAL CACHE MANAGEMENT
// =============================================================================

/**
 * Clear all measurement caches
 * Call when fonts change, page width changes, or for testing
 */
export function clearAllCaches(): void {
  clearTextWidthCache();
  clearFontMetricsCache();
  clearParagraphMeasureCache();
  clearParagraphFloatMeasureCache();
}

/**
 * Get total size of all caches
 */
export function getTotalCacheSize(): number {
  return (
    getTextCacheSize() + getFontCacheSize() + getParagraphCacheSize() + getParagraphFloatCacheSize()
  );
}
