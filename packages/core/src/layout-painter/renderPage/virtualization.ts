/**
 * Multi-page rendering with virtualization.
 *
 * For documents under VIRTUALIZATION_THRESHOLD pages, all pages render
 * eagerly. Larger documents render only pages near the viewport — off-screen
 * pages are lightweight shells (correct dimensions, no fragment content) so
 * scroll position is preserved. An IntersectionObserver populates and clears
 * page content as the user scrolls. Incremental updates (re-rendering only
 * fingerprint-changed pages) avoid blink when the document model shifts.
 */

import type { Page, BlockId } from '../../layout-engine/types';
import {
  PAGE_CLASS_NAMES,
  renderPage,
  applyPageStyles,
  type RenderContext,
  type RenderPageOptions,
} from '../renderPage';
import type { FootnoteRenderItem } from './footnotes';

type FullPageOptions = RenderPageOptions & {
  footnotesByPage?: Map<number, FootnoteRenderItem[]>;
};

/**
 * Build a RenderContext and resolved page options (with footnotes) for a page.
 * Centralises logic shared by populatePageShell, repopulatePageContent, and the eager render path.
 */
function buildPageRenderArgs(
  page: Page,
  totalPages: number,
  options: FullPageOptions
): { context: RenderContext; pageOptions: RenderPageOptions } {
  const context: RenderContext = {
    pageNumber: page.number,
    totalPages,
    section: 'body',
    resolvedCommentIds: options.resolvedCommentIds,
  };
  const pageOptions: RenderPageOptions = { ...options };
  // Per-page header/footer selection when titlePg is enabled
  if (options.titlePg && page.number === 1) {
    pageOptions.headerContent = options.firstPageHeaderContent;
    pageOptions.footerContent = options.firstPageFooterContent;
  }
  if (options.footnotesByPage) {
    const fns = options.footnotesByPage.get(page.number);
    if (fns && fns.length > 0) {
      (pageOptions as RenderPageOptions & { footnoteArea?: FootnoteRenderItem[] }).footnoteArea =
        fns;
    }
  }
  return { context, pageOptions };
}

interface PageShellState {
  element: HTMLElement;
  fingerprint: string;
}

interface PageContainerState {
  pageStates: PageShellState[];
  totalPages: number;
  optionsHash: string;
  pageDataMap: Map<HTMLElement, { page: Page; index: number; rendered: boolean }>;
  currentOptions: FullPageOptions;
}

interface PageContainer extends HTMLElement {
  __pageObserver?: IntersectionObserver;
  __pageRenderState?: PageContainerState;
}

/**
 * Compute a fingerprint string for a page that changes when its content changes.
 * Used to detect which pages need re-rendering on incremental updates.
 */
function computePageFingerprint(page: Page): string {
  const parts: string[] = [];

  // Page-level properties
  parts.push(`s:${page.size.w},${page.size.h}`);
  parts.push(
    `m:${page.margins.top},${page.margins.right},${page.margins.bottom},${page.margins.left}`
  );
  parts.push(`n:${page.number}`);
  if (page.footnoteReservedHeight) parts.push(`fn:${page.footnoteReservedHeight}`);

  // Each fragment's stable properties
  for (const frag of page.fragments) {
    let fp = `${frag.kind}:${frag.blockId},${frag.x},${frag.y},${frag.width},${frag.height}`;
    if (frag.pmStart !== undefined) fp += `,ps:${frag.pmStart}`;
    if (frag.pmEnd !== undefined) fp += `,pe:${frag.pmEnd}`;

    if (frag.kind === 'paragraph') {
      fp += `,fl:${frag.fromLine},tl:${frag.toLine}`;
    } else if (frag.kind === 'table') {
      fp += `,fr:${frag.fromRow},tr:${frag.toRow}`;
    }

    parts.push(fp);
  }

  return parts.join('|');
}

/**
 * Compute a hash for render options that affect all pages globally.
 * When this changes, all pages need a full re-render.
 */
function computeOptionsHash(options: RenderPageOptions): string {
  const parts: string[] = [];

  // Header/footer content changes affect all pages
  if (options.headerContent) {
    parts.push(
      `hdr:${options.headerContent.blocks.length},${options.headerContent.height},${
        options.headerContent.visualTop ?? 0
      },${options.headerContent.visualBottom ?? options.headerContent.height}`
    );
  }
  if (options.footerContent) {
    parts.push(
      `ftr:${options.footerContent.blocks.length},${options.footerContent.height},${
        options.footerContent.visualTop ?? 0
      },${options.footerContent.visualBottom ?? options.footerContent.height}`
    );
  }
  if (options.firstPageHeaderContent) {
    parts.push(
      `fp-hdr:${options.firstPageHeaderContent.blocks.length},${options.firstPageHeaderContent.height}`
    );
  }
  if (options.firstPageFooterContent) {
    parts.push(
      `fp-ftr:${options.firstPageFooterContent.blocks.length},${options.firstPageFooterContent.height}`
    );
  }
  if (options.titlePg) parts.push('titlePg');

  // Theme changes
  if (options.theme) {
    parts.push(`thm:${options.theme.name ?? 'default'}`);
  }

  // Page border changes
  if (options.pageBorders) {
    parts.push(`pb:${JSON.stringify(options.pageBorders)}`);
  }

  // Header/footer distances
  if (options.headerDistance !== undefined) parts.push(`hd:${options.headerDistance}`);
  if (options.footerDistance !== undefined) parts.push(`fd:${options.footerDistance}`);

  return parts.join('|');
}

/**
 * Apply standard container styles for the pages wrapper.
 */
function applyContainerStyles(container: HTMLElement, pageGap: number): void {
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.alignItems = 'center';
  container.style.gap = `${pageGap}px`;
  container.style.padding = `${pageGap}px`;
  container.style.backgroundColor = 'var(--doc-bg, #f8f9fa)';
}

/** Pages to keep rendered above and below the visible area for smooth scrolling. */
const VIRTUALIZATION_BUFFER = 2;

/** Minimum page count before virtualization kicks in. */
const VIRTUALIZATION_THRESHOLD = 8;

export type RenderPagesUpdateKind = 'incremental' | 'full';

/**
 * Render multiple pages to a container with virtualization for large documents.
 *
 * For documents with fewer than VIRTUALIZATION_THRESHOLD pages, all pages
 * are rendered eagerly. For larger documents, only pages near the visible
 * viewport are fully rendered — off-screen pages are lightweight shells
 * with correct dimensions to preserve scroll position.
 *
 * An IntersectionObserver watches page elements and populates/clears
 * content as pages scroll into and out of view.
 */
export function renderPages(
  pages: Page[],
  container: HTMLElement,
  options: RenderPageOptions & {
    pageGap?: number;
    footnotesByPage?: Map<number, FootnoteRenderItem[]>;
  } = {}
): RenderPagesUpdateKind {
  const totalPages = pages.length;
  const pageGap = options.pageGap ?? 24;
  const pc = container as PageContainer;
  const prevState = pc.__pageRenderState;
  const currentOptionsHash = computeOptionsHash(options);
  const useVirtualization = totalPages >= VIRTUALIZATION_THRESHOLD;

  // Determine if we can do an incremental update
  const canIncremental =
    prevState && prevState.optionsHash === currentOptionsHash && useVirtualization;

  if (canIncremental) {
    // --- INCREMENTAL UPDATE PATH ---
    const prevShells = prevState.pageStates;
    const prevDataMap = prevState.pageDataMap;
    const observer = pc.__pageObserver;

    // Compute new fingerprints
    const newFingerprints: string[] = [];
    for (const page of pages) {
      newFingerprints.push(computePageFingerprint(page));
    }

    // If total page count changed, NUMPAGES fields in headers/footers are stale.
    // Force re-render of all currently-rendered pages.
    const totalPagesChanged = prevState.totalPages !== totalPages;

    // Update existing pages
    const commonCount = Math.min(prevShells.length, pages.length);
    for (let i = 0; i < commonCount; i++) {
      const prev = prevShells[i];
      const newFp = newFingerprints[i];

      if (prev.fingerprint === newFp && !totalPagesChanged) {
        // Page unchanged — update data map with new page data (references may differ)
        const data = prevDataMap.get(prev.element);
        if (data) {
          data.page = pages[i];
        }
        continue;
      }

      // Page changed — update the shell
      const shell = prev.element;
      const data = prevDataMap.get(shell);

      // Update data map entry
      if (data) {
        const prevPage = data.page;
        data.page = pages[i];

        if (data.rendered) {
          if (isPositionsOnlyChange(prevPage, pages[i])) {
            // Only PM positions shifted (edit was before this page). The visual
            // layout is identical — skip the expensive re-render and update
            // only the data-pm-start/data-pm-end attributes in-place.
            updateDomPmPositions(shell, prevPage, pages[i]);
          } else {
            // Surgically replace only the content area, preserving header/footer
            repopulatePageContent(shell, prevDataMap, totalPages, options);
          }
        }
        // If not rendered, it will be populated when it scrolls into view
      }

      // Update fingerprint
      prev.fingerprint = newFp;

      // Update page styles in case size changed
      applyPageStyles(shell, pages[i].size.w, pages[i].size.h, options);
      shell.dataset.pageNumber = String(pages[i].number);
    }

    // Handle new pages (document grew)
    if (pages.length > prevShells.length) {
      const doc = options.document ?? document;
      for (let i = prevShells.length; i < pages.length; i++) {
        const page = pages[i];
        const pageEl = doc.createElement('div');
        pageEl.className = options.pageClassName ?? PAGE_CLASS_NAMES.page;
        pageEl.dataset.pageNumber = String(page.number);
        pageEl.dataset.pageIndex = String(i);
        applyPageStyles(pageEl, page.size.w, page.size.h, options);
        container.appendChild(pageEl);

        prevShells.push({ element: pageEl, fingerprint: newFingerprints[i] });
        prevDataMap.set(pageEl, { page, index: i, rendered: false });

        if (observer) {
          observer.observe(pageEl);
        }
      }
    }

    // Handle removed pages (document shrank)
    if (pages.length < prevShells.length) {
      for (let i = prevShells.length - 1; i >= pages.length; i--) {
        const shell = prevShells[i].element;
        if (observer) {
          observer.unobserve(shell);
        }
        prevDataMap.delete(shell);
        container.removeChild(shell);
      }
      prevShells.length = pages.length;
    }

    // Update indices in data map (they may have shifted)
    for (let i = 0; i < prevShells.length; i++) {
      const data = prevDataMap.get(prevShells[i].element);
      if (data) {
        data.index = i;
      }
    }

    // Update stored state with fresh options (blockLookup, footnotes, etc.)
    prevState.totalPages = totalPages;
    prevState.currentOptions = options;

    return 'incremental';
  }

  // --- FULL REBUILD PATH ---

  // Disconnect any previous observer
  const prevObserver = pc.__pageObserver;
  if (prevObserver) {
    prevObserver.disconnect();
    pc.__pageObserver = undefined;
  }

  // Clear existing content
  container.innerHTML = '';
  pc.__pageRenderState = undefined;

  applyContainerStyles(container, pageGap);

  // Build all page shells
  const pageShells: HTMLElement[] = [];
  const fingerprints: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    fingerprints.push(computePageFingerprint(page));

    if (!useVirtualization) {
      // Small document: render all pages eagerly
      const { context, pageOptions } = buildPageRenderArgs(page, totalPages, options);
      const pageEl = renderPage(page, context, pageOptions);
      container.appendChild(pageEl);
      pageShells.push(pageEl);
    } else {
      // Large document: create lightweight shell with correct dimensions
      const doc = options.document ?? document;
      const pageEl = doc.createElement('div');
      pageEl.className = options.pageClassName ?? PAGE_CLASS_NAMES.page;
      pageEl.dataset.pageNumber = String(page.number);
      pageEl.dataset.pageIndex = String(i);
      applyPageStyles(pageEl, page.size.w, page.size.h, options);
      container.appendChild(pageEl);
      pageShells.push(pageEl);
    }
  }

  if (!useVirtualization) {
    // Store state for potential future incremental updates (won't be used
    // since small docs skip the incremental path, but keeps data consistent)
    return 'full';
  }

  // --- Virtualization via IntersectionObserver ---

  // Store page data for lazy rendering
  const pageDataMap = new Map<HTMLElement, { page: Page; index: number; rendered: boolean }>();
  for (let i = 0; i < pages.length; i++) {
    pageDataMap.set(pageShells[i], { page: pages[i], index: i, rendered: false });
  }

  // Use the browser viewport as intersection root.
  // The observer reads from pc.__pageRenderState so it always uses
  // the latest options/totalPages (updated by the incremental path).
  const observer = new IntersectionObserver(
    (entries) => {
      const renderState = pc.__pageRenderState;
      if (!renderState) return;
      const {
        currentOptions: liveOptions,
        totalPages: liveTotalPages,
        pageDataMap: liveDataMap,
      } = renderState;

      for (const entry of entries) {
        const shell = entry.target as HTMLElement;
        const data = liveDataMap.get(shell);
        if (!data) continue;

        if (entry.isIntersecting) {
          // Page is near viewport — render it and neighbors
          populatePageShell(shell, liveDataMap, liveTotalPages, liveOptions);

          // Also render buffer pages above and below
          for (let offset = -VIRTUALIZATION_BUFFER; offset <= VIRTUALIZATION_BUFFER; offset++) {
            const neighborIdx = data.index + offset;
            if (
              neighborIdx >= 0 &&
              neighborIdx < renderState.pageStates.length &&
              neighborIdx !== data.index
            ) {
              populatePageShell(
                renderState.pageStates[neighborIdx].element,
                liveDataMap,
                liveTotalPages,
                liveOptions
              );
            }
          }
        }
      }

      // Sweep: depopulate pages far from any currently-visible page.
      const viewportHeight = window.innerHeight;
      const nearThreshold = viewportHeight * 3;
      const nearIndices = new Set<number>();

      for (const [el, data] of liveDataMap) {
        if (!data.rendered) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom > -nearThreshold && rect.top < viewportHeight + nearThreshold) {
          nearIndices.add(data.index);
        }
      }

      for (const [el, data] of liveDataMap) {
        if (!data.rendered) continue;
        let keepRendered = false;
        for (const nearIdx of nearIndices) {
          if (Math.abs(data.index - nearIdx) <= VIRTUALIZATION_BUFFER + 1) {
            keepRendered = true;
            break;
          }
        }
        if (!keepRendered && nearIndices.size > 0) {
          depopulatePageShell(el, liveDataMap);
        }
      }
    },
    {
      root: null,
      rootMargin: '1500px 0px 1500px 0px',
    }
  );

  // Observe all page shells
  for (const shell of pageShells) {
    observer.observe(shell);
  }

  // Store observer and render state on the container BEFORE eager rendering,
  // so the populatePageShell calls below can find state if needed.
  pc.__pageObserver = observer;
  pc.__pageRenderState = {
    pageStates: pageShells.map((el, i) => ({ element: el, fingerprint: fingerprints[i] })),
    totalPages,
    optionsHash: currentOptionsHash,
    pageDataMap,
    currentOptions: options,
  };

  // Eagerly render the first few pages so the initial view isn't blank
  const initialRenderCount = Math.min(pages.length, VIRTUALIZATION_BUFFER + 3);
  for (let i = 0; i < initialRenderCount; i++) {
    populatePageShell(pageShells[i], pageDataMap, totalPages, options);
  }

  return 'full';
}

/**
 * Populate a page shell with full rendered content.
 */
function populatePageShell(
  shell: HTMLElement,
  pageDataMap: Map<HTMLElement, { page: Page; index: number; rendered: boolean }>,
  totalPages: number,
  options: FullPageOptions
): void {
  const data = pageDataMap.get(shell);
  if (!data || data.rendered) return;

  const { context, pageOptions } = buildPageRenderArgs(data.page, totalPages, options);
  const fullPageEl = renderPage(data.page, context, pageOptions);

  while (fullPageEl.firstChild) {
    shell.appendChild(fullPageEl.firstChild);
  }

  data.rendered = true;
}

/**
 * Returns true when the only difference between two page versions is that PM
 * positions shifted uniformly (edit was entirely before this page). The visual
 * layout is identical; only absolute PM offsets changed.
 */
function isPositionsOnlyChange(prevPage: Page, newPage: Page): boolean {
  if (prevPage.fragments.length !== newPage.fragments.length) return false;
  for (let i = 0; i < prevPage.fragments.length; i++) {
    const prev = prevPage.fragments[i];
    const next = newPage.fragments[i];
    if ((prev.pmEnd ?? 0) - (prev.pmStart ?? 0) !== (next.pmEnd ?? 0) - (next.pmStart ?? 0)) {
      return false;
    }
  }
  return true;
}

/** Shift data-pm-start / data-pm-end on `el` and all its PM-annotated descendants. */
function shiftPmAttributes(el: HTMLElement, delta: number): void {
  if (el.dataset.pmStart !== undefined)
    el.dataset.pmStart = String(Number(el.dataset.pmStart) + delta);
  if (el.dataset.pmEnd !== undefined) el.dataset.pmEnd = String(Number(el.dataset.pmEnd) + delta);
  el.querySelectorAll('[data-pm-start],[data-pm-end]').forEach((child) =>
    shiftPmAttributes(child as HTMLElement, delta)
  );
}

/**
 * Update data-pm-start / data-pm-end attributes on all rendered DOM elements
 * within a page shell, without re-rendering any content. Used when only PM
 * positions shifted (isPositionsOnlyChange returned true).
 */
function updateDomPmPositions(shell: HTMLElement, prevPage: Page, newPage: Page): void {
  const contentEl = shell.querySelector(`.${PAGE_CLASS_NAMES.content}`) as HTMLElement | null;
  if (!contentEl) return;

  const deltaByBlockId = new Map<BlockId, number>();
  for (let i = 0; i < prevPage.fragments.length && i < newPage.fragments.length; i++) {
    const prevFrag = prevPage.fragments[i];
    const newFrag = newPage.fragments[i];
    const delta = (newFrag.pmStart ?? 0) - (prevFrag.pmStart ?? 0);
    if (delta !== 0) deltaByBlockId.set(prevFrag.blockId, delta);
  }
  if (deltaByBlockId.size === 0) return;

  for (let i = 0; i < contentEl.children.length; i++) {
    const fragEl = contentEl.children[i] as HTMLElement;
    const blockIdStr = fragEl.dataset.blockId;
    if (blockIdStr === undefined) continue;
    // dataset values are strings; BlockId is string|number so try both
    const numId = Number(blockIdStr);
    const delta =
      deltaByBlockId.get(isNaN(numId) ? blockIdStr : numId) ?? deltaByBlockId.get(blockIdStr);
    if (!delta) continue;
    shiftPmAttributes(fragEl, delta);
  }
}

/**
 * Surgically update the content area of a rendered page shell without
 * replacing the container element. The live contentEl stays in the DOM; only
 * specific changed fragments are replaced in-place. Unchanged fragments keep
 * their DOM identity (browser reuses GPU textures) and get only a lightweight
 * PM-position attribute fixup when positions shifted.
 *
 * Falls back to a full container replacement when fragment count changes or
 * the content element is missing.
 */
function repopulatePageContent(
  shell: HTMLElement,
  pageDataMap: Map<HTMLElement, { page: Page; index: number; rendered: boolean }>,
  totalPages: number,
  options: FullPageOptions
): void {
  const data = pageDataMap.get(shell);
  if (!data) return;

  const { context, pageOptions } = buildPageRenderArgs(data.page, totalPages, options);

  // Render a full page off-screen to obtain the new fragment elements.
  const fullPageEl = renderPage(data.page, context, pageOptions);
  const newContentEl = fullPageEl.querySelector(
    `.${PAGE_CLASS_NAMES.content}`
  ) as HTMLElement | null;
  const oldContentEl = shell.querySelector(`.${PAGE_CLASS_NAMES.content}`) as HTMLElement | null;

  if (!newContentEl || !oldContentEl) {
    shell.innerHTML = '';
    data.rendered = false;
    populatePageShell(shell, pageDataMap, totalPages, options);
    return;
  }

  const oldChildren = Array.from(oldContentEl.children) as HTMLElement[];
  const newChildren = Array.from(newContentEl.children) as HTMLElement[];

  if (oldChildren.length !== newChildren.length) {
    // Fragment count changed (page reflow, split/merge) — full container swap.
    shell.replaceChild(newContentEl, oldContentEl);
    return;
  }

  // The container (oldContentEl) is never replaced — the browser reuses its
  // paint layer and only marks individual changed children dirty.
  for (let i = 0; i < newChildren.length; i++) {
    const oldEl = oldChildren[i];
    const newEl = newChildren[i];
    const oldFp = oldEl.dataset.fragFp;
    const newFp = newEl.dataset.fragFp;

    if (oldFp && newFp && oldFp === newFp) {
      // Fragment visually unchanged — only PM positions may have shifted.
      const oldStart = oldEl.dataset.pmStart;
      const newStart = newEl.dataset.pmStart;
      if (oldStart !== newStart && oldStart !== undefined && newStart !== undefined) {
        shiftPmAttributes(oldEl, Number(newStart) - Number(oldStart));
      }
    } else {
      oldContentEl.replaceChild(newEl, oldEl);
    }
  }
}

/**
 * Clear a page shell's content (keep shell dimensions for scroll).
 */
function depopulatePageShell(
  shell: HTMLElement,
  pageDataMap: Map<HTMLElement, { page: Page; index: number; rendered: boolean }>
): void {
  const data = pageDataMap.get(shell);
  if (!data || !data.rendered) return;

  shell.innerHTML = '';
  data.rendered = false;
}

/**
 * Force every virtualized page shell in `container` to be fully rendered.
 *
 * Virtualization keeps off-screen pages as empty shells so cloning the
 * pages container for print (or any DOM snapshot) yields blank pages past
 * the visible band. Callers that need every page populated — print,
 * export-to-HTML, pdf snapshot — should call this first.
 *
 * No-op for small documents (rendered eagerly) or containers that were
 * never managed by `renderPages`. Returns the number of shells populated
 * by this call (useful for tests).
 */
export function renderAllPagesNow(container: HTMLElement): number {
  const pc = container as PageContainer;
  const state = pc.__pageRenderState;
  if (!state) return 0;

  const { pageStates, totalPages, currentOptions, pageDataMap } = state;
  let populated = 0;
  for (const { element } of pageStates) {
    const data = pageDataMap.get(element);
    if (!data || data.rendered) continue;
    populatePageShell(element, pageDataMap, totalPages, currentOptions);
    populated++;
  }
  return populated;
}
