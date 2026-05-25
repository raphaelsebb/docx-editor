/**
 * Public types for the DOCX-to-Markdown converter.
 *
 * Most callers only need `MarkdownOptions` (or `PagedMarkdownOptions`) and
 * `MarkdownResult`. The other types describe the image surface area: every
 * image referenced in the markdown is registered in `result.images` so
 * callers can post-process bytes themselves (write to disk, upload, describe
 * with a vision model, drop, ...).
 *
 * @packageDocumentation
 */

/**
 * Metadata describing a single image registration. Passed to a custom
 * `MarkdownOptionsBase.imagePath` callback. The same fields are present on
 * the full `ImageRef`.
 *
 * @public
 */
export interface ImageMeta {
  /** `paraId` of the containing paragraph, when the source paragraph has one. */
  paraId?: string;
  /** 1-based ordinal in registration order. Unique per render call. */
  index: number;
  /** Path inside the DOCX zip (e.g. `word/media/image1.png`). */
  originalPath: string;
  /** MIME type (`image/png`, `image/jpeg`, ...). */
  mimeType: string;
  /** Alt text from the drawing's `docPr.title`/`docPr.descr`, when present. */
  alt?: string;
  /**
   * 1-based page number this image lives on. Only set in paged renders;
   * always `undefined` from `toMarkdown` / `toMarkdownAsync`.
   */
  pageNumber?: number;
}

/**
 * Full registration record for an image. Returned in `MarkdownResult.images`
 * keyed by `virtualPath`, and passed to `ImageHandler` callbacks.
 *
 * @public
 */
export interface ImageRef extends ImageMeta {
  /** Raw bytes as exposed by the DOCX parser. */
  data: Uint8Array;
  /** Base64-encoded contents, without the `data:` prefix. */
  base64: string;
  /** `data:<mime>;base64,<base64>` URL, ready for `<img src>` or markdown. */
  dataUrl: string;
  /** The path that appears inside the markdown's `![alt](...)` reference. */
  virtualPath: string;
}

/**
 * Result of a non-paged render.
 *
 * @public
 */
export interface MarkdownResult {
  /** The full rendered markdown string. */
  markdown: string;
  /** Every image referenced in `markdown`, keyed by its virtual path. */
  images: Map<string, ImageRef>;
  /**
   * Non-fatal diagnostics emitted during rendering. Recurring messages
   * (e.g. merged-cell warnings on a 200-cell table) are deduped: each
   * distinct text appears at most once.
   */
  warnings: string[];
}

/**
 * Result of a paged render. `pages` is one entry per Word page, in document
 * order. `combined` is the same content concatenated with `<!-- page N -->`
 * separators so callers can feed an LLM a single string and recover page
 * boundaries later.
 *
 * @public
 */
export interface PagedMarkdownResult {
  /** Per-page rendered markdown. Empty when the source document has no content. */
  pages: Array<{ pageNumber: number; markdown: string }>;
  /** Pages joined with `<!-- page N -->` between them. */
  combined: string;
  /** Every image referenced in any page, keyed by its virtual path. */
  images: Map<string, ImageRef>;
  /** Non-fatal diagnostics. Recurring messages deduped. */
  warnings: string[];
}

/**
 * Options shared between paged and non-paged renders.
 *
 * @public
 */
export interface MarkdownOptionsBase {
  /**
   * How to encode constructs markdown can't express natively (comments,
   * tracked changes, headers/footers).
   *
   * - `'html'` (default): emit `<ins>`, `<del>`, `<comment>`, `<header>`, `<footer>`.
   *   These render as inert HTML on GitHub, GitLab, Notion, and most viewers,
   *   and are easy for LLMs to parse.
   * - `'pandoc'`: emit Pandoc-flavored bracketed spans (`[text]{.ins}`) and
   *   fenced divs (`:::header`). Only renders correctly under Pandoc.
   * - `'strip'`: drop the wrapper, keep only the visible text.
   */
  annotations?: 'html' | 'pandoc' | 'strip';
  /**
   * What to do with Word tracked changes (`w:ins`, `w:del`, `w:moveFrom`,
   * `w:moveTo`).
   *
   * - `'annotate'` (default): preserve insertions and deletions via the
   *   wrapper chosen by `annotations`, so the reader sees what changed.
   * - `'clean'`: strip the markup. Insertions become real text, deletions
   *   vanish (same effect as accepting every tracked change).
   *
   * Use `DocxReviewer` if you need a true accept/reject operation on the
   * document itself rather than on the rendered markdown.
   */
  trackedChanges?: 'clean' | 'annotate';
  /**
   * What to do with Word margin comments.
   *
   * - `'inline'` (default): wrap the commented text in place with the
   *   wrapper chosen by `annotations`.
   * - `'strip'`: ignore comments entirely.
   * - `'sidecar'`: leave a footnote-style reference inline and list the
   *   comments in a `## Comments` section at the end of the output.
   */
  comments?: 'strip' | 'inline' | 'sidecar';
  /**
   * Hyperlink rendering style.
   *
   * - `'inline'` (default): `[text](https://url)`.
   * - `'reference'`: `[text][N]` with a `[N]: https://url` list at the end.
   *   Cleaner for link-heavy prose.
   */
  hyperlinks?: 'inline' | 'reference';
  /**
   * Receives the `ImageMeta` for each image and returns the virtual path
   * placed inside the markdown's `![alt](virtualPath)` reference. The same
   * path is the key in `MarkdownResult.images`.
   *
   * Defaults to `./images/{paraId}-img{n}.{ext}` when the source paragraph
   * has a `paraId`, otherwise `./images/img{n}.{ext}`.
   */
  imagePath?: (info: ImageMeta) => string;
}

/**
 * Options for {@link toMarkdown} and {@link toMarkdownAsync}.
 *
 * @public
 */
export interface MarkdownOptions extends MarkdownOptionsBase {}

/**
 * Options for {@link toMarkdownPaged} and {@link toMarkdownPagedAsync}.
 * Adds page-level concerns on top of {@link MarkdownOptionsBase}.
 *
 * @public
 */
export interface PagedMarkdownOptions extends MarkdownOptionsBase {
  /**
   * Whether to emit Word's page headers and footers around each page's
   * content (rendered with the wrapper chosen by `annotations`).
   *
   * - `'strip'` (default): suppress headers and footers entirely.
   * - `'first-page'`: emit the section's first-page or default header/footer
   *   on page 1 only. Pages 2+ render bare.
   * - `'all'`: emit them around each page's content.
   */
  headerFooter?: 'strip' | 'first-page' | 'all';
  /**
   * Run the full layout engine to produce pages instead of the default
   * heuristic page splitter. Only honored by the async paged variant
   * ({@link toMarkdownPagedAsync}) because the layout engine needs a
   * Canvas2D context — in Node / Bun the implementation lazy-loads
   * `@napi-rs/canvas` (optional peer dep) and auto-downloads Google's
   * Croscore Office-font substitutes (Carlito for Calibri, Caladea for
   * Cambria, Arimo for Arial/Aptos, ...) into a temp-dir cache so the
   * CSS cascade in `buildFontString` resolves to known metrics.
   *
   * - `true`: always use the layout engine.
   * - `'fallback'`: use the heuristic first; only run the layout engine
   *   if the heuristic produced a single page on a substantial doc (the
   *   case where no pagination cache exists). Recommended for production.
   * - Falsy / unset (default): heuristic only.
   *
   * Caveat: layout-engine output won't always byte-match Word's
   * pagination, even with substitute fonts. Word's text shaper applies
   * kerning, ligatures, and line-break rules that don't fully map onto
   * vanilla Skia (what `@napi-rs/canvas` provides). Small per-line width
   * differences accumulate across long docs and can tip content across
   * page boundaries, giving occasional ±1 page divergence on cache-less
   * docs. For cache-bearing docs the heuristic is byte-exact — that's
   * why `'fallback'` is the recommended setting (heuristic first,
   * layout engine only when the cache is genuinely absent).
   *
   * If pixel-perfect Word matching is required for cache-less docs, the
   * only known options are (1) opening in Word and resaving, or
   * (2) running headless Chrome and using the live editor's
   * `pagedEditorRef.getLayout()`.
   */
  useLayoutEngine?: boolean | 'fallback';
}

/**
 * Callback invoked by {@link toMarkdownAsync} and {@link toMarkdownPagedAsync}
 * for every image registered during the render. The return string replaces
 * the default `![alt](virtualPath)` reference.
 *
 * Return `""` to drop the image. Throwing pushes a warning into
 * `result.warnings` and leaves the default reference in place. The function
 * may safely run network requests.
 *
 * @param ref - the full image record, including bytes, base64, and metadata
 * @param ctx - `virtualPath` is the path currently in the markdown;
 *   `pageNumber` is the page being substituted (matches `ref.pageNumber`
 *   when available).
 *
 * @public
 */
export type ImageHandler = (
  ref: ImageRef,
  ctx: { virtualPath: string; pageNumber?: number }
) => Promise<string>;

/** Resolved option values with defaults applied. Used internally. */
export interface ResolvedOptions {
  annotations: 'html' | 'pandoc' | 'strip';
  trackedChanges: 'clean' | 'annotate';
  comments: 'strip' | 'inline' | 'sidecar';
  hyperlinks: 'inline' | 'reference';
  /** Defaults to `'strip'` in non-paged mode. */
  headerFooter: 'strip' | 'first-page' | 'all';
  imagePath?: (info: ImageMeta) => string;
}

/**
 * Internal rendering context threaded through every `renderBlock` call.
 * Aggregates side-channel output: image map, warnings, footnote/comment/
 * hyperlink reference lists, image counter, and (in paged renders) the
 * current page number.
 *
 * Not part of the public surface; exported only so split renderer files
 * share the same shape.
 */
export interface RenderContext {
  opts: ResolvedOptions;
  /** Accumulated images keyed by virtual path. Returned to the caller. */
  images: Map<string, ImageRef>;
  /** Same images keyed by source `MediaFile.path` for dedupe on re-reference. */
  imagesByPath: Map<string, ImageRef>;
  /** Diagnostics accumulator. */
  warnings: string[];
  /** Footnote refs collected during this render, in document order. */
  footnoteRefs: Array<{ refId: number; markerNumber: number }>;
  /** Comment refs collected during this render (sidecar mode only). */
  commentRefs: Array<{ commentId: number; markerNumber: number }>;
  /** Hyperlink refs collected during this render (reference mode only). */
  hyperlinkRefs: Array<{ href: string; refNumber: number }>;
  /** 1-based counter for default virtual paths. */
  imageCounter: number;
  /** Current page number during paged renders, else `undefined`. */
  pageNumber?: number;
}
