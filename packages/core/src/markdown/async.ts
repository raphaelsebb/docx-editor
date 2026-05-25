/**
 * Async variants of `toMarkdown` / `toMarkdownPaged`.
 *
 * Two reasons to reach for an async variant:
 *
 * 1. **Image handler** — pass `opts.imageHandler` and the converter awaits
 *    your callback per image to substitute the default reference. Use this
 *    to upload to blob storage, replace with vision-model descriptions, or
 *    drop images entirely.
 *
 * 2. **Layout-engine pagination** — paged-only. Pass
 *    `opts.useLayoutEngine: true` (or `'fallback'`) to run the full layout
 *    engine instead of the heuristic page splitter. Required when the doc
 *    has no pagination cache (programmatically generated, never opened in
 *    Word). Lazy-loads `@napi-rs/canvas` as an optional peer dep.
 *
 * Per-image handler errors are caught and recorded in `warnings`. The
 * overall call only rejects when parsing fails.
 */

import type { BlockContent, Document } from '../types/document';
import { toMarkdown } from './index';
import { toMarkdownPaged, renderFromGroups } from './paged';
import { computePagedGroups } from './headlessLayout';
import { isDocument, newContext } from './internals';
import { parseDocx } from '../docx/parser';
import type {
  ImageHandler,
  ImageRef,
  MarkdownOptions,
  MarkdownResult,
  PagedMarkdownOptions,
  PagedMarkdownResult,
} from './types';

type ByteInput = Uint8Array | ArrayBuffer;

/**
 * Same as {@link toMarkdown} but applies `opts.imageHandler` (if provided)
 * to each image. The handler's return value replaces the default
 * `![alt](virtualPath)` reference.
 *
 * @example Describe each image with a vision model
 * ```ts
 * import { toMarkdownAsync } from '@eigenpal/docx-editor-core/markdown';
 *
 * const { markdown } = await toMarkdownAsync(buffer, {
 *   imageHandler: async (ref) => {
 *     const text = await describe(ref.base64, ref.mimeType);
 *     return `![${text}]()`;
 *   },
 * });
 * ```
 *
 * @public
 */
export async function toMarkdownAsync(
  input: Document | ByteInput,
  opts: MarkdownOptions & { imageHandler?: ImageHandler } = {}
): Promise<MarkdownResult> {
  const base =
    input instanceof Uint8Array || input instanceof ArrayBuffer
      ? await toMarkdown(input, opts)
      : toMarkdown(input, opts);
  if (!opts.imageHandler) return base;
  const markdown = await substituteImages(
    base.markdown,
    base.images,
    opts.imageHandler,
    base.warnings
  );
  return { ...base, markdown };
}

/**
 * Same as {@link toMarkdownPaged} but with two added capabilities:
 *
 * - `opts.imageHandler`: substitute each image through your callback.
 * - `opts.useLayoutEngine`: run the layout engine for line-accurate page
 *   boundaries instead of the heuristic. Required for DOCX files with no
 *   pagination cache. `'fallback'` runs the heuristic first and only
 *   re-paginates when the heuristic produced a single page on a
 *   substantial doc — the recommended production setting.
 *
 * The layout engine path needs a Canvas2D context. In the browser the
 * DOM provides it; in Node we lazy-import `@napi-rs/canvas`. Install it
 * yourself to opt in:
 *
 * ```bash
 * npm install --save-optional @napi-rs/canvas
 * ```
 *
 * @public
 */
export async function toMarkdownPagedAsync(
  input: Document | ByteInput,
  opts: PagedMarkdownOptions & { imageHandler?: ImageHandler } = {}
): Promise<PagedMarkdownResult> {
  // Materialize Document so both code paths can poke at it.
  const doc =
    input instanceof Uint8Array || input instanceof ArrayBuffer
      ? await parseDocx(input)
      : isDocument(input)
        ? input
        : (() => {
            throw new Error(
              'toMarkdownPagedAsync expected Buffer, Uint8Array, ArrayBuffer, or Document.'
            );
          })();

  const base = await runPaged(doc, opts);
  if (!opts.imageHandler) return base;

  const pages = await Promise.all(
    base.pages.map(async (p) => ({
      pageNumber: p.pageNumber,
      markdown: await substituteImages(
        p.markdown,
        base.images,
        opts.imageHandler!,
        base.warnings,
        p.pageNumber
      ),
    }))
  );
  const combined = pages
    .map((p, i) => (i === 0 ? p.markdown : `<!-- page ${p.pageNumber} -->\n\n${p.markdown}`))
    .join('\n\n');
  return { ...base, pages, combined };
}

/**
 * Pick the paged pipeline. Try the layout engine when opted in; fall back
 * to the heuristic on any failure (canvas unavailable, layout error, etc.).
 */
async function runPaged(doc: Document, opts: PagedMarkdownOptions): Promise<PagedMarkdownResult> {
  const heuristic = toMarkdownPaged(doc, opts);
  if (!opts.useLayoutEngine) return heuristic;
  // 'fallback' only triggers when heuristic produced a single page on a
  // substantial doc (the case where no pagination cache exists).
  if (opts.useLayoutEngine === 'fallback' && heuristic.pages.length > 1) return heuristic;

  let groups: BlockContent[][] | null;
  try {
    groups = await computePagedGroups(doc);
  } catch {
    groups = null;
  }
  if (!groups || groups.length <= 1) {
    heuristic.warnings.push(
      `layout engine pagination unavailable (install @napi-rs/canvas as a peer dep, or run in a browser with DOM canvas access). Falling back to heuristic.`
    );
    return heuristic;
  }

  // Re-render via the layout-engine groups. Reuse the same ctx-builder so
  // options resolve identically to the sync paged path.
  const ctx = newContext(opts);
  if (doc.warnings) ctx.warnings.unshift(...doc.warnings);
  return renderFromGroups(doc, groups, ctx);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function substituteImages(
  markdown: string,
  images: Map<string, ImageRef>,
  handler: ImageHandler,
  warnings: string[],
  pageNumber?: number
): Promise<string> {
  if (!images.size || !markdown) return markdown;

  const entries = [...images.entries()].filter(([virtualPath]) => markdown.includes(virtualPath));
  if (!entries.length) return markdown;

  const replacements = await Promise.all(
    entries.map(async ([virtualPath, ref]) => {
      try {
        const result = await handler(ref, {
          virtualPath,
          pageNumber: ref.pageNumber ?? pageNumber,
        });
        return [virtualPath, ref, result] as const;
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        const msg = `imageHandler failed for ${virtualPath}: ${cause}`;
        if (!warnings.includes(msg)) warnings.push(msg);
        return [virtualPath, ref, null] as const;
      }
    })
  );

  let out = markdown;
  for (const [virtualPath, , result] of replacements) {
    if (result === null) continue;
    const escaped = escapeRegExp(virtualPath);
    out = out.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), () => result);
    out = out.replace(new RegExp(`<img\\b[^>]*\\bsrc="${escaped}"[^>]*>`, 'g'), () => result);
  }
  return out;
}
