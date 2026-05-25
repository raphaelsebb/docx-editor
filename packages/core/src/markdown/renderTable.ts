/**
 * Render a Word table as markdown.
 *
 * Two output modes, picked automatically per table:
 *
 *   - **GFM** for simple tables (no merged cells, no nested tables). Compact,
 *     pipe-delimited, supported everywhere.
 *   - **Inline HTML** when the table has `gridSpan`, `vMerge`, or a nested
 *     table. GitHub, GitLab, Notion, and most modern viewers render
 *     `<table>` with `colspan`/`rowspan` correctly, so the structure
 *     survives. Inline marks inside HTML cells use HTML tags (`<strong>`,
 *     `<em>`, `<code>`, `<a>`) because markdown is not parsed inside HTML
 *     blocks.
 *
 * Multi-paragraph cells join their paragraphs with `<br>` in both modes so a
 * row stays on a single line.
 */

import type {
  DocxPackage,
  Hyperlink,
  Run,
  Table,
  TableCell,
  TableRow,
  ParagraphContent,
} from '../types/document';
import { renderParagraph } from './renderParagraph';
import { escapeTableCell } from './escape';
import { registerImage } from './images';
import { pushWarning } from './internals';
import type { RenderContext } from './types';

/** Render a `Table` as markdown. Picks GFM vs HTML based on cell features. */
export function renderTable(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  table: Table
): string {
  const { rows } = table;
  if (!rows.length) return '';
  if (needsHtmlFallback(rows)) return renderHtmlTable(ctx, pkg, rows, true);
  return renderGfmTable(ctx, pkg, rows, true);
}

function needsHtmlFallback(rows: TableRow[]): boolean {
  for (const row of rows) {
    for (const cell of row.cells) {
      if ((cell.formatting?.gridSpan ?? 1) > 1) return true;
      if (cell.formatting?.vMerge) return true;
      if (cell.content.some((b) => b.type === 'table')) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// GFM path
// ---------------------------------------------------------------------------

function renderGfmTable(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  rows: TableRow[],
  firstRowIsHeader: boolean
): string {
  const cellTexts = rows.map((row) => renderGfmRow(ctx, pkg, row));
  const maxCols = cellTexts.reduce((m, c) => Math.max(m, c.length), 0);
  if (!maxCols) return '';

  const padded = cellTexts.map((row) => {
    const out = row.slice();
    while (out.length < maxCols) out.push('');
    return out;
  });

  const lines: string[] = [];
  if (firstRowIsHeader) {
    lines.push(toRowLine(padded[0]));
    lines.push(`| ${new Array(maxCols).fill('---').join(' | ')} |`);
    for (let i = 1; i < padded.length; i++) lines.push(toRowLine(padded[i]));
  } else {
    lines.push(`| ${new Array(maxCols).fill('').join(' | ')} |`);
    lines.push(`| ${new Array(maxCols).fill('---').join(' | ')} |`);
    for (const row of padded) lines.push(toRowLine(row));
  }
  return lines.join('\n');
}

function toRowLine(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function renderGfmRow(ctx: RenderContext, pkg: DocxPackage | undefined, row: TableRow): string[] {
  const out: string[] = [];
  for (const cell of row.cells) {
    out.push(renderGfmCell(ctx, pkg, cell));
  }
  return out;
}

function renderGfmCell(ctx: RenderContext, pkg: DocxPackage | undefined, cell: TableCell): string {
  const blocks: string[] = [];
  for (const item of cell.content) {
    if (item.type === 'paragraph') {
      const md = renderParagraph(ctx, pkg, item);
      if (md.trim()) blocks.push(md);
    }
  }
  return escapeTableCell(blocks.join('\n'));
}

// ---------------------------------------------------------------------------
// HTML path
// ---------------------------------------------------------------------------

function renderHtmlTable(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  rows: TableRow[],
  firstRowIsHeader: boolean
): string {
  const out: string[] = ['<table>'];
  rows.forEach((row, rowIdx) => {
    const tag = firstRowIsHeader && rowIdx === 0 ? 'th' : 'td';
    out.push('  <tr>');
    let gridCol = 0;
    for (const cell of row.cells) {
      const colspan = cell.formatting?.gridSpan ?? 1;
      if (cell.formatting?.vMerge !== 'continue') {
        const rowspan = countRowSpan(rows, rowIdx, gridCol, colspan);
        const attrs: string[] = [];
        if (colspan > 1) attrs.push(`colspan="${colspan}"`);
        if (rowspan > 1) attrs.push(`rowspan="${rowspan}"`);
        const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
        out.push(`    <${tag}${attrStr}>${renderHtmlCell(ctx, pkg, cell)}</${tag}>`);
      }
      gridCol += colspan;
    }
    out.push('  </tr>');
  });
  out.push('</table>');
  return out.join('\n');
}

/**
 * Count how many rows beyond `rowIdx` have a `vMerge: 'continue'` cell
 * aligned to the same grid column as the anchor.
 *
 * Cells are indexed by array position, but vertical merges align on the
 * visual grid column. If a row above has a horizontal merge (`gridSpan > 1`)
 * the array indices shift, so we walk each subsequent row by cumulative
 * gridSpan to find the column-aligned target.
 */
function countRowSpan(rows: TableRow[], rowIdx: number, gridCol: number, colspan: number): number {
  let span = 1;
  for (let r = rowIdx + 1; r < rows.length; r++) {
    const target = cellAtGridColumn(rows[r], gridCol);
    if (
      target &&
      target.formatting?.vMerge === 'continue' &&
      (target.formatting?.gridSpan ?? 1) === colspan
    ) {
      span += 1;
    } else {
      break;
    }
  }
  return span;
}

function cellAtGridColumn(row: TableRow, gridCol: number): TableCell | undefined {
  let col = 0;
  for (const cell of row.cells) {
    if (col === gridCol) return cell;
    col += cell.formatting?.gridSpan ?? 1;
    if (col > gridCol) return undefined;
  }
  return undefined;
}

function renderHtmlCell(ctx: RenderContext, pkg: DocxPackage | undefined, cell: TableCell): string {
  const parts: string[] = [];
  for (const item of cell.content) {
    if (item.type === 'paragraph') {
      const inner = renderHtmlInline(ctx, pkg, item.content, item.paraId);
      if (inner) parts.push(inner);
    } else if (item.type === 'table') {
      // Nested tables inside an HTML cell stay HTML: GFM is not parsed
      // inside HTML blocks, so a pipe-table here would render as literal text.
      const nested = renderHtmlTable(ctx, pkg, item.rows, true);
      if (nested) parts.push(nested);
    }
  }
  return parts.join('<br>');
}

// ---------------------------------------------------------------------------
// HTML inline rendering for table cells
//
// Markdown is not parsed inside HTML blocks, so when a cell lives inside an
// HTML `<table>` we emit HTML tags for marks and links. This keeps formatting
// visible in any viewer that renders HTML (GitHub, GitLab, Notion, ...).
// Tracked-change and comment wrappers are skipped: their `<ins>`/`<del>`/
// `<comment>` output is already HTML and lives at the annotations layer
// (covered when annotations is 'html'); for 'pandoc'/'strip' modes we degrade
// to the bare inner text inside HTML cells.
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtmlInline(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  content: ParagraphContent[],
  paraId: string | undefined
): string {
  let out = '';
  for (const item of content) {
    switch (item.type) {
      case 'run':
        out += renderHtmlRun(ctx, pkg, item, paraId);
        break;
      case 'hyperlink':
        out += renderHtmlHyperlink(ctx, pkg, item, paraId);
        break;
      case 'insertion':
      case 'moveTo':
        out += renderHtmlChildren(ctx, pkg, item.content, paraId);
        break;
      case 'deletion':
      case 'moveFrom':
        if (ctx.opts.trackedChanges === 'annotate') {
          out += `<del>${renderHtmlChildren(ctx, pkg, item.content, paraId)}</del>`;
        }
        break;
      case 'simpleField':
      case 'complexField': {
        const runs = item.type === 'simpleField' ? item.content : item.fieldResult;
        out += renderHtmlChildren(ctx, pkg, runs, paraId);
        break;
      }
      case 'inlineSdt':
        if (item.content) {
          out += renderHtmlInline(ctx, pkg, item.content as ParagraphContent[], paraId);
        }
        break;
      case 'bookmarkStart':
      case 'bookmarkEnd':
      case 'commentRangeStart':
      case 'commentRangeEnd':
      case 'moveFromRangeStart':
      case 'moveFromRangeEnd':
      case 'moveToRangeStart':
      case 'moveToRangeEnd':
        // Range markers carry no visible payload inside table cells.
        break;
      default:
        break;
    }
  }
  return out;
}

function renderHtmlChildren(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  children: Array<Run | Hyperlink>,
  paraId: string | undefined
): string {
  return children
    .map((c) =>
      c.type === 'run'
        ? renderHtmlRun(ctx, pkg, c, paraId)
        : renderHtmlHyperlink(ctx, pkg, c, paraId)
    )
    .join('');
}

function renderHtmlRun(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  run: Run,
  paraId: string | undefined
): string {
  let text = '';
  for (const item of run.content) {
    switch (item.type) {
      case 'text':
        text += escapeHtml(item.text);
        break;
      case 'tab':
        text += '&emsp;';
        break;
      case 'break':
        text += '<br>';
        break;
      case 'symbol':
        text += escapeHtml(item.char);
        break;
      case 'noBreakHyphen':
        text += '&#8209;';
        break;
      case 'softHyphen':
        break;
      case 'drawing': {
        const ref = pkg?.relationships?.get(item.image.rId);
        const media = ref ? pkg?.media?.get(ref.target) : undefined;
        if (media) {
          const reg = registerImage(ctx, media, item.image, paraId);
          const alt = reg.alt ? escapeHtml(reg.alt) : '';
          text += `<img src="${escapeHtml(reg.virtualPath)}" alt="${alt}">`;
          break;
        }
        if (item.image.src) {
          const alt = escapeHtml(item.image.alt ?? item.image.title ?? item.image.filename ?? '');
          text += `<img src="${escapeHtml(item.image.src)}" alt="${alt}">`;
          break;
        }
        pushWarning(ctx, `image rId=${item.image.rId} not resolvable`);
        break;
      }
      case 'footnoteRef':
      case 'endnoteRef': {
        const markerNumber = ctx.footnoteRefs.length + 1;
        ctx.footnoteRefs.push({ refId: item.id, markerNumber });
        text += `<sup>[${markerNumber}]</sup>`;
        break;
      }
      default:
        break;
    }
  }
  if (!text) return '';
  const f = run.formatting;
  if (!f) return text;
  if (f.bold) text = `<strong>${text}</strong>`;
  if (f.italic) text = `<em>${text}</em>`;
  if (f.strike) text = `<s>${text}</s>`;
  if (f.underline?.style && f.underline.style !== 'none') text = `<u>${text}</u>`;
  return text;
}

function renderHtmlHyperlink(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  link: Hyperlink,
  paraId: string | undefined
): string {
  // Hyperlink.children may include BookmarkStart/End markers; only runs
  // contribute visible content.
  const runs = link.children.filter((c): c is Run => c.type === 'run');
  const inner = runs.map((r) => renderHtmlRun(ctx, pkg, r, paraId)).join('');
  if (!inner) return '';
  const href = link.href ?? (link.anchor ? `#${link.anchor}` : '');
  if (!href) return inner;
  return `<a href="${escapeHtml(href)}">${inner}</a>`;
}
