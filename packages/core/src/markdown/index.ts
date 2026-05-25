/**
 * DOCX to Markdown converter.
 *
 * Public entry points:
 *
 * - `toMarkdown` produces a single markdown string.
 * - `toMarkdownPaged` produces one markdown string per Word page plus a
 *   `combined` string with `<!-- page N -->` separators.
 * - `toMarkdownAsync` and `toMarkdownPagedAsync` wrap the above with an
 *   `imageHandler` callback that the converter awaits per image to substitute
 *   the default `![alt](./images/...)` reference with something else (an LLM
 *   description, an uploaded URL, a data URL, an empty string to drop, ...).
 *
 * Each function accepts a parsed `Document` (sync) or raw DOCX bytes
 * (`Buffer` / `Uint8Array` / `ArrayBuffer`, async because parsing is async).
 *
 * See {@link MarkdownOptions} and {@link PagedMarkdownOptions} for the option
 * matrix and {@link MarkdownResult} for the return shape.
 *
 * @example Parse a buffer and print markdown
 * ```ts
 * import { toMarkdown } from '@eigenpal/docx-editor-core/markdown';
 * import { readFile } from 'node:fs/promises';
 *
 * const { markdown, images, warnings } = await toMarkdown(await readFile('doc.docx'));
 * console.log(markdown);
 * ```
 *
 * @packageDocumentation
 */

import type { Document } from '../types/document';
import { parseDocx } from '../docx/parser';
import { renderBlocks } from './renderBlock';
import { appendTrailers, badInputError, isDocument, newContext } from './internals';
import type { MarkdownOptions, MarkdownResult } from './types';

export type {
  ImageMeta,
  ImageRef,
  ImageHandler,
  MarkdownOptions,
  MarkdownResult,
  PagedMarkdownOptions,
  PagedMarkdownResult,
} from './types';

export { toMarkdownPaged } from './paged';
export { toMarkdownAsync, toMarkdownPagedAsync } from './async';

type ByteInput = Uint8Array | ArrayBuffer;

/**
 * Convert a parsed `Document` (or raw DOCX bytes) to markdown.
 *
 * With a `Document`, the call is synchronous. With raw bytes, the function
 * parses the DOCX first and returns a `Promise<MarkdownResult>`.
 *
 * @example From a buffer (Node)
 * ```ts
 * import { toMarkdown } from '@eigenpal/docx-editor-core/markdown';
 * import { readFile } from 'node:fs/promises';
 *
 * const { markdown } = await toMarkdown(await readFile('contract.docx'));
 * ```
 *
 * @example From a pre-parsed Document
 * ```ts
 * import { parseDocx, toMarkdown } from '@eigenpal/docx-editor-core/markdown';
 *
 * const doc = await parseDocx(buffer);
 * const result = toMarkdown(doc, { trackedChanges: 'clean' });
 * ```
 *
 * @public
 */
export function toMarkdown(doc: Document, opts?: MarkdownOptions): MarkdownResult;
export function toMarkdown(buffer: ByteInput, opts?: MarkdownOptions): Promise<MarkdownResult>;
export function toMarkdown(
  input: Document | ByteInput,
  opts?: MarkdownOptions
): MarkdownResult | Promise<MarkdownResult> {
  if (isDocument(input)) return renderDocumentSync(input, opts);
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return parseDocx(input).then((doc) => renderDocumentSync(doc, opts));
  }
  throw badInputError('toMarkdown', input);
}

function renderDocumentSync(doc: Document, opts: MarkdownOptions = {}): MarkdownResult {
  const ctx = newContext(opts);
  const body = renderBlocks(ctx, doc.package, doc.package.document.content);
  const markdown = appendTrailers(ctx, doc, body);
  if (doc.warnings) ctx.warnings.unshift(...doc.warnings);
  if (!markdown.trim()) ctx.warnings.push('document has no content');
  return { markdown, images: ctx.images, warnings: ctx.warnings };
}
