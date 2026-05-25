/**
 * Layout-engine fallback for paged markdown. Wires the existing core
 * pagination pipeline (Document → ProseDoc → FlowBlock → measureBlocks →
 * layoutDocument) so paged output works even for DOCX files that don't
 * carry Word's pre-baked pagination cache.
 *
 * Lazy-loads `@napi-rs/canvas` as an optional peer dep — caller installs
 * it only when they need this path. In the browser, `document.createElement`
 * already provides a canvas so no extra install is needed.
 *
 * Returns null when canvas can't be obtained, letting the caller fall back
 * to the heuristic splitter.
 */

import type { BlockContent, Document } from '../types/document';
import type {
  FlowBlock,
  Layout,
  Measure,
  ParagraphBlock,
  TableBlock,
} from '../layout-engine/types';
import { assertExhaustiveFlowBlock } from '../layout-engine/types';
import { layoutDocument } from '../layout-engine';
import { toProseDoc } from '../prosemirror/conversion/toProseDoc';
import { toFlowBlocks } from '../layout-bridge/toFlowBlocks';
import { measureParagraph, setCanvasContext } from '../layout-bridge/measuring';
import { measureTableBlock } from '../layout-bridge/measureTable';
import { registerOfficeSubstitutes } from './officeFonts';

/** US Letter in twips (8.5in × 11in × 1440 twips/in). */
const DEFAULT_PAGE_WIDTH_TWIPS = 12240;
const DEFAULT_PAGE_HEIGHT_TWIPS = 15840;
/** 1 inch margin in twips. Matches Word's default. */
const DEFAULT_MARGIN_TWIPS = 1440;

let canvasReady: Promise<boolean> | undefined;

/**
 * Bring up a Canvas2D context on the current runtime. Memoized.
 *
 * - In a browser DOM the cached `document.createElement('canvas')` path
 *   inside `measureContainer.ts` already works; no action needed.
 * - In Node / Bun, dynamically import `@napi-rs/canvas` and inject its 2D
 *   context. The peer dep is optional; if it fails to import we return
 *   false and the caller falls back.
 */
async function ensureCanvas(): Promise<boolean> {
  if (canvasReady) return canvasReady;
  const attempt = (async () => {
    if (typeof document !== 'undefined') return true;
    try {
      const mod = await import('@napi-rs/canvas');
      // Register Office-font substitutes (Carlito, Caladea, Arimo, ...) so
      // the CSS cascade in `buildFontString` resolves to known metrics.
      // Without these, "Calibri" falls through to whatever Skia picks as
      // default and pagination diverges from what the browser produces.
      await registerOfficeSubstitutes(mod);
      const c = mod.createCanvas(1, 1);
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      setCanvasContext(ctx as unknown as CanvasRenderingContext2D);
      return true;
    } catch {
      return false;
    }
  })();
  canvasReady = attempt;
  const ok = await attempt;
  // Don't poison the memo with a failed result — let the next call retry.
  // (Transient network failures during font download shouldn't permanently
  // disable the feature for the process.)
  if (!ok) canvasReady = undefined;
  return ok;
}

/**
 * `FlowBlock` measurement dispatcher. Floating-image exclusion zones are
 * omitted: we measure for pagination only, not painting. The exhaustiveness
 * guard catches missing variants at typecheck time.
 */
function measureBlockForLayout(block: FlowBlock, contentWidth: number): Measure {
  switch (block.kind) {
    case 'paragraph':
      return measureParagraph(block as ParagraphBlock, contentWidth);
    case 'table':
      return measureTableBlock(block as TableBlock, contentWidth, measureBlockForLayout);
    case 'image':
      return { kind: 'image', width: block.width ?? 100, height: block.height ?? 100 };
    case 'textBox': {
      const innerMeasures = block.content.map((p) => measureParagraph(p, contentWidth));
      const totalHeight = innerMeasures.reduce((sum, m) => sum + m.totalHeight, 0);
      return {
        kind: 'textBox',
        width: block.width,
        height: block.height ?? totalHeight,
        innerMeasures,
      };
    }
    case 'pageBreak':
      return { kind: 'pageBreak' };
    case 'columnBreak':
      return { kind: 'columnBreak' };
    case 'sectionBreak':
      return { kind: 'sectionBreak' };
    default:
      assertExhaustiveFlowBlock(block, 'markdown headlessLayout');
  }
}

/**
 * Run the layout engine on a parsed document and return a mapping of which
 * source body blocks land on which page.
 *
 * Returns null when canvas isn't available or layout fails — the caller
 * falls back to the heuristic.
 */
export async function computePagedGroups(doc: Document): Promise<BlockContent[][] | null> {
  if (!(await ensureCanvas())) return null;

  let layout: Layout;
  let blocks: FlowBlock[];
  let pmDoc: import('prosemirror-model').Node;
  try {
    pmDoc = toProseDoc(doc);
    blocks = toFlowBlocks(pmDoc);
    const sectPr = doc.package.document.finalSectionProperties;
    const twip2px = (twips: number): number => (twips / 1440) * 96;
    const pageSize = {
      w: twip2px(sectPr?.pageWidth ?? DEFAULT_PAGE_WIDTH_TWIPS),
      h: twip2px(sectPr?.pageHeight ?? DEFAULT_PAGE_HEIGHT_TWIPS),
    };
    const margins = {
      top: twip2px(sectPr?.marginTop ?? DEFAULT_MARGIN_TWIPS),
      right: twip2px(sectPr?.marginRight ?? DEFAULT_MARGIN_TWIPS),
      bottom: twip2px(sectPr?.marginBottom ?? DEFAULT_MARGIN_TWIPS),
      left: twip2px(sectPr?.marginLeft ?? DEFAULT_MARGIN_TWIPS),
    };
    const contentWidth = pageSize.w - margins.left - margins.right;
    const measures = blocks.map((b) => measureBlockForLayout(b, contentWidth));
    layout = layoutDocument(blocks, measures, { pageSize, margins });
  } catch {
    return null;
  }

  // Map page → source-block index range. FlowBlocks carry `pmStart`, the
  // ProseMirror position where the block lives. ProseDoc nodes appear in
  // document order matching the source body, so we can derive a source
  // block's pmStart by walking the body in parallel with the ProseDoc.
  // This works even when one source paragraph produces multiple FlowBlocks
  // (anchored textboxes split a paragraph into pre/inner/post nodes).
  const sourceBlocks = doc.package.document.content;
  const sourcePmStarts = computeSourcePmStarts(pmDoc, sourceBlocks.length);
  const flowBlockByBlockId = new Map<string | number, FlowBlock>();
  for (const b of blocks) flowBlockByBlockId.set(b.id, b);

  /** Map a ProseMirror position to a source-block index (highest pmStart ≤ pos). */
  const srcIndexAtPm = (pm: number | undefined): number | undefined => {
    if (pm === undefined) return undefined;
    let lo = 0;
    let hi = sourcePmStarts.length - 1;
    let best: number | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sourcePmStarts[mid] <= pm) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };

  // For each page, find the lowest source-block index whose pmStart is
  // covered by any fragment on that page.
  const pageStarts: number[] = [];
  for (const page of layout.pages) {
    let pageMinSrc = Number.POSITIVE_INFINITY;
    for (const frag of page.fragments) {
      const fb = flowBlockByBlockId.get(frag.blockId);
      // SectionBreak / pageBreak / columnBreak FlowBlocks don't have pmStart
      // typed on them, but the variants used as fragment anchors (paragraph,
      // table, image, textBox) all do. Reach via `in` to keep TS happy.
      const pmStart = fb && 'pmStart' in fb ? fb.pmStart : undefined;
      const srcIdx = srcIndexAtPm(pmStart);
      if (srcIdx !== undefined && srcIdx < pageMinSrc) pageMinSrc = srcIdx;
    }
    if (pageMinSrc !== Number.POSITIVE_INFINITY) pageStarts.push(pageMinSrc);
  }
  if (!pageStarts.length) return null;

  // Slice source blocks into page-aligned groups using the starts.
  const groups: BlockContent[][] = [];
  for (let i = 0; i < pageStarts.length; i++) {
    const from = pageStarts[i];
    const to = i + 1 < pageStarts.length ? pageStarts[i + 1] : sourceBlocks.length;
    groups.push(sourceBlocks.slice(from, to));
  }
  return groups;
}

/**
 * Compute the ProseMirror `pmStart` of each top-level source body block.
 *
 * `toProseDoc` emits one PM node per source body item, in order. The PM
 * position of the i-th top-level node is the cumulative size of every
 * preceding top-level node plus the document's opening token. We snapshot
 * those positions here so the page-mapping can locate each source block
 * even when a single source paragraph produces multiple FlowBlocks (the
 * textbox-split case).
 */
function computeSourcePmStarts(
  pmDoc: import('prosemirror-model').Node,
  expectedCount: number
): number[] {
  const starts: number[] = [];
  let pos = 1; // doc opening token
  pmDoc.forEach((child) => {
    starts.push(pos);
    pos += child.nodeSize;
  });
  // If toProseDoc emitted more or fewer nodes than source body items
  // (e.g. trailing empty paragraph it added for ProseMirror schema
  // requirements), trim to the source count for safety.
  return starts.slice(0, expectedCount);
}
