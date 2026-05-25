/**
 * Paged DOCX-to-Markdown.
 *
 * Page boundaries are inferred from Word's pre-baked pagination hints:
 * `paragraph.renderedPageBreakBefore` flags, explicit `<w:br w:type="page"/>`
 * inside runs, and section breaks of type `nextPage`/`evenPage`/`oddPage`.
 * No canvas or measurement is required. Documents that Word has rendered at
 * least once carry these hints; programmatically generated DOCX files often
 * do not, in which case the whole document renders as a single page.
 *
 * Each page's blocks are rendered by the same `renderBlock` pipeline used by
 * `toMarkdown`, so a paragraph that fits on one page is byte-identical
 * between the paged and continuous outputs.
 *
 * @packageDocumentation
 */

import type {
  BlockContent,
  DocxPackage,
  Document,
  HeaderFooter,
  Paragraph,
} from '../types/document';
import { renderBlocks } from './renderBlock';
import { wrapHeaderFooter } from './annotations';
import { appendTrailers, badInputError, isDocument, newContext } from './internals';
import type { PagedMarkdownOptions, PagedMarkdownResult, RenderContext } from './types';
import { parseDocx } from '../docx/parser';

type ByteInput = Uint8Array | ArrayBuffer;

/**
 * Convert a parsed `Document` (or raw DOCX bytes) to markdown, one entry per
 * page plus a `combined` string with `<!-- page N -->` separators.
 *
 * With a `Document`, the call is synchronous. With raw bytes, parsing runs
 * first and the result is wrapped in a `Promise`.
 *
 * @example Parse and split a buffer into pages
 * ```ts
 * import { toMarkdownPaged } from '@eigenpal/docx-editor-core/markdown';
 * import { readFile } from 'node:fs/promises';
 *
 * const buf = await readFile('contract.docx');
 * const { pages, combined } = await toMarkdownPaged(buf);
 * for (const p of pages) {
 *   console.log(`--- page ${p.pageNumber} ---\n${p.markdown}`);
 * }
 * ```
 *
 * @public
 */
export function toMarkdownPaged(doc: Document, opts?: PagedMarkdownOptions): PagedMarkdownResult;
export function toMarkdownPaged(
  buffer: ByteInput,
  opts?: PagedMarkdownOptions
): Promise<PagedMarkdownResult>;
export function toMarkdownPaged(
  input: Document | ByteInput,
  opts?: PagedMarkdownOptions
): PagedMarkdownResult | Promise<PagedMarkdownResult> {
  if (isDocument(input)) return renderPagedSync(input, opts);
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return parseDocx(input).then((doc) => renderPagedSync(doc, opts));
  }
  throw badInputError('toMarkdownPaged', input);
}

function renderPagedSync(
  doc: Document,
  opts: PagedMarkdownOptions | undefined
): PagedMarkdownResult {
  const ctx = newContext(opts ?? {});
  const blocks = doc.package.document.content;
  if (!blocks.length) {
    if (doc.warnings) ctx.warnings.unshift(...doc.warnings);
    ctx.warnings.push('document has no content');
    return { pages: [], combined: '', images: ctx.images, warnings: ctx.warnings };
  }
  const groups = splitIntoPages(blocks);
  if (groups.length === 1 && hasSubstantialBody(blocks) && !hasAnyBreakSignal(blocks)) {
    ctx.warnings.push(
      'no pagination signals found (renderedPageBreakBefore, explicit page breaks, or section breaks). Document renders as a single page. Open the .docx in Word once and resave to bake in pagination, or use toMarkdown for continuous output.'
    );
  }
  return renderFromGroups(doc, groups, ctx);
}

/**
 * Render a pre-computed grouping of source blocks into a paged result.
 * Used by both the heuristic path (groups from `splitIntoPages`) and the
 * async layout-engine fallback (groups from `headlessLayout.computePagedGroups`).
 */
export function renderFromGroups(
  doc: Document,
  groups: BlockContent[][],
  ctx: RenderContext
): PagedMarkdownResult {
  const renderedPages: Array<{ pageNumber: number; markdown: string }> = [];

  groups.forEach((pageBlocks, idx) => {
    const pageNumber = idx + 1;
    ctx.pageNumber = pageNumber;
    const sections: string[] = [];

    if (ctx.opts.headerFooter !== 'strip') {
      const hf = resolveHeaderFooter(doc.package, pageNumber);
      if (hf.header && shouldEmitHeaderFooter(ctx, pageNumber)) {
        const inner = renderBlocks(ctx, doc.package, hf.header.content);
        if (inner) sections.push(wrapHeaderFooter(ctx, 'header', inner));
      }
    }

    sections.push(renderBlocks(ctx, doc.package, pageBlocks));

    if (ctx.opts.headerFooter !== 'strip') {
      const hf = resolveHeaderFooter(doc.package, pageNumber);
      if (hf.footer && shouldEmitHeaderFooter(ctx, pageNumber)) {
        const inner = renderBlocks(ctx, doc.package, hf.footer.content);
        if (inner) sections.push(wrapHeaderFooter(ctx, 'footer', inner));
      }
    }

    renderedPages.push({
      pageNumber,
      markdown: sections.filter((s) => s.trim()).join('\n\n'),
    });
  });

  if (renderedPages.length) {
    const last = renderedPages[renderedPages.length - 1];
    const withTrailers = appendTrailers(ctx, doc, last.markdown);
    if (withTrailers !== last.markdown) last.markdown = withTrailers;
  }

  const combined = renderedPages
    .map((p, i) => (i === 0 ? p.markdown : `<!-- page ${p.pageNumber} -->\n\n${p.markdown}`))
    .join('\n\n');

  return { pages: renderedPages, combined, images: ctx.images, warnings: ctx.warnings };
}

/**
 * Heuristic page splitter. Walks blocks once, starting a new page on each
 * break signal:
 *
 * - `Paragraph.renderedPageBreakBefore`: Word's cached "this paragraph
 *   starts on a new page" flag (the most reliable signal on docs Word has
 *   rendered at least once).
 * - `Paragraph.formatting.pageBreakBefore`: the authored `w:pageBreakBefore`
 *   property.
 * - `Paragraph.sectionProperties.sectionStart` of `nextPage` / `evenPage` /
 *   `oddPage`.
 * - An explicit `<w:br w:type="page"/>` inside a run.
 *
 * Word's common idiom for an authored page break is an empty paragraph
 * whose only content is the page break run. That paragraph also carries
 * `renderedPageBreakBefore=true`, and the *next* paragraph carries
 * `renderedPageBreakBefore=true` too. Naively the splitter would count
 * three signals for one logical break. We detect "pure break paragraphs"
 * (no visible text, just a page break) and consume them as transitions
 * rather than rendering them as their own (empty) page.
 */
function splitIntoPages(blocks: BlockContent[]): BlockContent[][] {
  if (!blocks.length) return [[]];
  const pages: BlockContent[][] = [[]];
  let pendingBreakAfter = false;

  const startNewPage = () => {
    if (pages[pages.length - 1].length) pages.push([]);
  };

  for (const block of blocks) {
    if (pendingBreakAfter) {
      startNewPage();
      pendingBreakAfter = false;
    }
    if (block.type === 'paragraph') {
      // Empty marker paragraphs (only a page break, no visible text) are the
      // transition itself: queue the break and drop the paragraph. They
      // would otherwise become a blank "page" of their own.
      if (isPureBreakParagraph(block)) {
        pendingBreakAfter = true;
        continue;
      }
      if (startsNewPage(block)) startNewPage();
      pages[pages.length - 1].push(block);
      if (containsExplicitPageBreak(block)) pendingBreakAfter = true;
    } else {
      pages[pages.length - 1].push(block);
    }
  }
  return pages;
}

function startsNewPage(para: Paragraph): boolean {
  if (para.renderedPageBreakBefore) return true;
  if (para.formatting?.pageBreakBefore) return true;
  const sectionStart = para.sectionProperties?.sectionStart;
  return sectionStart === 'nextPage' || sectionStart === 'evenPage' || sectionStart === 'oddPage';
}

function containsExplicitPageBreak(para: Paragraph): boolean {
  return para.content.some(
    (c) => c.type === 'run' && c.content.some((r) => r.type === 'break' && r.breakType === 'page')
  );
}

function paragraphVisibleText(para: Paragraph): string {
  let out = '';
  for (const item of para.content) {
    if (item.type !== 'run') continue;
    for (const r of item.content) {
      if (r.type === 'text') out += r.text;
      else if (r.type === 'symbol') out += r.char;
    }
  }
  return out;
}

function isPureBreakParagraph(para: Paragraph): boolean {
  if (!containsExplicitPageBreak(para)) return false;
  return paragraphVisibleText(para).trim() === '';
}

/** Did the body carry any pagination signal the heuristic could act on? */
function hasAnyBreakSignal(blocks: BlockContent[]): boolean {
  for (const b of blocks) {
    if (b.type !== 'paragraph') continue;
    if (startsNewPage(b) || containsExplicitPageBreak(b)) return true;
  }
  return false;
}

/**
 * Pick a threshold below which a single-page result is unremarkable: a 3-line
 * memo really is one page. The 25-paragraph floor approximates "more than a
 * page of body content" without needing actual layout measurement.
 */
function hasSubstantialBody(blocks: BlockContent[]): boolean {
  let paraCount = 0;
  for (const b of blocks) {
    if (b.type === 'paragraph') paraCount += 1;
    if (paraCount >= 25) return true;
  }
  return false;
}

function resolveHeaderFooter(
  pkg: DocxPackage,
  pageNumber: number
): { header?: HeaderFooter; footer?: HeaderFooter } {
  const isFirstPage = pageNumber === 1;

  // Headers/footers live in two places depending on how the doc was parsed:
  //   1. `Section.headers` / `Section.footers` — keyed by HeaderFooterType
  //      ('default' | 'first' | 'even'). Often empty in practice.
  //   2. `DocxPackage.headers` / `DocxPackage.footers` — keyed by relationship
  //      id (`rId7`, ...). The section's `headerReferences` / `footerReferences`
  //      map a HeaderFooterType to an rId. This is what every Word-authored
  //      file populates.
  //
  // We try the section-level map first (cheaper, no rId resolution), then
  // fall back to the package-level map via the section's references.
  const section = pkg.document.sections?.[0];
  const sectionProps = section?.properties ?? pkg.document.finalSectionProperties;

  const pickViaRefs = (
    refs: { type: 'default' | 'first' | 'even'; rId: string }[] | undefined,
    pool: Map<string, HeaderFooter> | undefined,
    wantFirst: boolean
  ): HeaderFooter | undefined => {
    if (!refs || !pool) return undefined;
    if (wantFirst) {
      const first = refs.find((r) => r.type === 'first');
      const hit = first && pool.get(first.rId);
      if (hit) return hit;
    }
    const def = refs.find((r) => r.type === 'default');
    return def ? pool.get(def.rId) : undefined;
  };

  const sectionHeader =
    (isFirstPage && section?.headers?.get('first')) || section?.headers?.get('default');
  const sectionFooter =
    (isFirstPage && section?.footers?.get('first')) || section?.footers?.get('default');

  return {
    // The package-map fallback only fires when there is exactly one header
    // in the document. Multi-section docs without proper references would
    // otherwise surface a wrong section's header on every page.
    header:
      sectionHeader ??
      pickViaRefs(sectionProps?.headerReferences, pkg.headers, isFirstPage) ??
      (pkg.headers && pkg.headers.size === 1 ? pkg.headers.values().next().value : undefined),
    footer:
      sectionFooter ??
      pickViaRefs(sectionProps?.footerReferences, pkg.footers, isFirstPage) ??
      (pkg.footers && pkg.footers.size === 1 ? pkg.footers.values().next().value : undefined),
  };
}

function shouldEmitHeaderFooter(ctx: RenderContext, pageNumber: number): boolean {
  if (ctx.opts.headerFooter === 'first-page') return pageNumber === 1;
  return ctx.opts.headerFooter === 'all';
}
