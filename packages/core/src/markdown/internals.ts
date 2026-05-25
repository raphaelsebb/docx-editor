/**
 * Internal helpers shared between the markdown converter's entry points.
 *
 * Kept in one file rather than scattered across `input.ts` / `context.ts` /
 * `trailers.ts` because each was sub-50 lines and only consumed by
 * `index.ts` and `paged.ts`. None of the exports below are part of the
 * public surface — `index.ts` doesn't re-export them.
 */

import type { Comment, Document, Footnote } from '../types/document';
import { renderBlocks } from './renderBlock';
import type { MarkdownOptionsBase, RenderContext } from './types';

// ---------------------------------------------------------------------------
// Input narrowing
// ---------------------------------------------------------------------------

/**
 * Narrow an `unknown` input to a parsed `Document`. Checks that the input is
 * a non-null object with `package.document` populated, the minimum shape
 * the renderer reads from.
 */
export function isDocument(input: unknown): input is Document {
  if (typeof input !== 'object' || input === null) return false;
  const pkg = (input as { package?: unknown }).package;
  if (typeof pkg !== 'object' || pkg === null) return false;
  const body = (pkg as { document?: unknown }).document;
  return typeof body === 'object' && body !== null;
}

/**
 * Build a descriptive `Error` for inputs that aren't a `Document` or a
 * known byte type. Names the function and hints at common mistakes
 * (passing a `File` or `Blob` without awaiting `.arrayBuffer()`, or a
 * filename string when only bytes are accepted).
 */
export function badInputError(fnName: string, input: unknown): Error {
  let got: string;
  if (input === null) got = 'null';
  else if (typeof input === 'string')
    got = `string ("${input.slice(0, 40)}${input.length > 40 ? '…' : ''}")`;
  else if (typeof input === 'object') got = Object.prototype.toString.call(input);
  else got = typeof input;

  let hint = '';
  if (got === '[object File]' || got === '[object Blob]') {
    hint = ' (await file.arrayBuffer() first)';
  } else if (typeof input === 'string') {
    hint =
      ' (this function takes bytes or a parsed Document, not a path — use fs.readFile() first)';
  }
  return new Error(
    `${fnName} expected Buffer, Uint8Array, ArrayBuffer, or Document. Received: ${got}${hint}.`
  );
}

// ---------------------------------------------------------------------------
// Context factory + warning dedupe
// ---------------------------------------------------------------------------

/**
 * Build a fresh `RenderContext` from caller options. Both paged and
 * non-paged entry points share this so default resolution lives in one
 * place.
 */
export function newContext(
  opts: MarkdownOptionsBase & { headerFooter?: 'strip' | 'first-page' | 'all' } = {}
): RenderContext {
  return {
    opts: {
      annotations: opts.annotations ?? 'html',
      trackedChanges: opts.trackedChanges ?? 'annotate',
      comments: opts.comments ?? 'inline',
      hyperlinks: opts.hyperlinks ?? 'inline',
      headerFooter: opts.headerFooter ?? 'strip',
      imagePath: opts.imagePath,
    },
    images: new Map(),
    imagesByPath: new Map(),
    warnings: [],
    footnoteRefs: [],
    commentRefs: [],
    hyperlinkRefs: [],
    imageCounter: 0,
  };
}

/**
 * Push a warning into the context, deduplicating against existing entries.
 * Recurring messages (e.g. merged-cell warnings on a 200-cell table)
 * appear at most once, matching the contract in `MarkdownResult.warnings`.
 */
export function pushWarning(ctx: RenderContext, message: string): void {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message);
}

// ---------------------------------------------------------------------------
// Trailer sections (footnotes / hyperlink refs / comments sidecar)
// ---------------------------------------------------------------------------

/**
 * Append footnote definitions, the hyperlink reference list (for
 * `hyperlinks: 'reference'`), and the comments sidecar block (for
 * `comments: 'sidecar'`) to the rendered body. Each section is emitted
 * only when its corresponding refs accumulator has entries.
 */
export function appendTrailers(ctx: RenderContext, doc: Document, body: string): string {
  const sections: string[] = body.trim() ? [body] : [];

  if (ctx.footnoteRefs.length) {
    const refs = ctx.footnoteRefs.map(({ refId, markerNumber }) => {
      const note = doc.package.footnotes?.find((f) => f.id === refId);
      return `[^${markerNumber}]: ${note ? footnoteText(ctx, doc, note) : ''}`;
    });
    sections.push(refs.join('\n'));
  }

  if (ctx.opts.hyperlinks === 'reference' && ctx.hyperlinkRefs.length) {
    sections.push(
      ctx.hyperlinkRefs.map(({ href, refNumber }) => `[${refNumber}]: ${href}`).join('\n')
    );
  }

  if (ctx.opts.comments === 'sidecar' && ctx.commentRefs.length) {
    const lines: string[] = ['## Comments'];
    for (const { commentId, markerNumber } of ctx.commentRefs) {
      const c = doc.package.document.comments?.find((cm) => cm.id === commentId);
      const author = c?.author ? `${c.author}: ` : '';
      const text = c ? commentText(c) : '';
      lines.push(`[^c${markerNumber}]: ${author}${text}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

function footnoteText(ctx: RenderContext, doc: Document, note: Footnote): string {
  return renderBlocks(ctx, doc.package, note.content).replace(/\n+/g, ' ').trim();
}

function commentText(comment: Comment): string {
  return comment.content
    .map((p) =>
      p.content
        .map((c) =>
          c.type === 'run' ? c.content.map((x) => (x.type === 'text' ? x.text : '')).join('') : ''
        )
        .join('')
    )
    .join(' ')
    .trim();
}
