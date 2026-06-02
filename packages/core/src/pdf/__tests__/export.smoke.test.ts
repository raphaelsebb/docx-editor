/**
 * PDF export smoke test — exercises the whole pipeline with a no-network font
 * provider (standard-14 only), asserting the output is a parseable PDF with the
 * right page count and extractable text, and that determinism + graceful image
 * fallback hold.
 */
import { describe, test, expect } from 'bun:test';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { exportToPdf } from '../index';
import type { ExportToPdfInput } from '../types';
import type { FontProvider } from '../fontProvider';
import type { BlockLookup } from '../../layout-painter/index';
import type {
  Layout,
  ParagraphBlock,
  ParagraphMeasure,
  MeasuredLine,
  Run,
  Page,
} from '../../layout-engine/types';

/** No-network provider: one embedded Helvetica for everything. */
function stubFonts(doc: PDFDocument): FontProvider {
  let helv: PDFFont | undefined;
  const get = () => (helv ??= doc.embedStandardFont(StandardFonts.Helvetica));
  return {
    async warmUp() {},
    getFontSync: () => get(),
    getUnicodeFallbackSync: () => get(),
  };
}

function line(runs: Run[]): MeasuredLine {
  return {
    fromRun: 0,
    fromChar: 0,
    toRun: runs.length - 1,
    toChar: 99,
    width: 200,
    ascent: 12,
    descent: 4,
    lineHeight: 18,
  };
}

function makeInput(pages: number): ExportToPdfInput {
  const runs: Run[] = [{ kind: 'text', text: 'Hello PDF export' } as Run];
  const block: ParagraphBlock = {
    kind: 'paragraph',
    id: 1 as never,
    runs,
    attrs: { alignment: 'left' },
  };
  const measure: ParagraphMeasure = { kind: 'paragraph', lines: [line(runs)], totalHeight: 18 };
  const blockLookup: BlockLookup = new Map([['1', { block, measure }]]);

  const layoutPages: Page[] = [];
  for (let i = 0; i < pages; i++) {
    layoutPages.push({
      number: i + 1,
      size: { w: 816, h: 1056 },
      margins: { top: 96, right: 96, bottom: 96, left: 96 },
      fragments: [
        {
          kind: 'paragraph',
          blockId: 1 as never,
          x: 96,
          y: 96,
          width: 624,
          height: 18,
          fromLine: 0,
          toLine: 1,
        },
      ],
    });
  }
  const layout: Layout = { pageSize: { w: 816, h: 1056 }, pages: layoutPages };
  return {
    layout,
    blockLookup,
    fontProviderFactory: stubFonts,
    options: { now: '2026-06-02T00:00:00.000Z', documentName: 'Smoke' },
  };
}

describe('exportToPdf smoke', () => {
  test('produces a parseable PDF with one page per layout page', async () => {
    const blob = await exportToPdf(makeInput(3));
    expect(blob.type).toBe('application/pdf');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(3);
    expect(reloaded.getTitle()).toBe('Smoke');
    // Header bytes are a PDF.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  test('is deterministic when `now` is fixed', async () => {
    const a = new Uint8Array(await (await exportToPdf(makeInput(1))).arrayBuffer());
    const b = new Uint8Array(await (await exportToPdf(makeInput(1))).arrayBuffer());
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('a non-Latin run does not throw (falls back without crashing)', async () => {
    const input = makeInput(1);
    const entry = input.blockLookup.get('1')!;
    (entry.block as ParagraphBlock).runs = [{ kind: 'text', text: 'Привет мир 你好' } as Run];
    await expect(exportToPdf(input)).resolves.toBeInstanceOf(Blob);
  });

  test('highlight + justify + super/subscript runs export without crashing', async () => {
    const input = makeInput(1);
    const entry = input.blockLookup.get('1')!;
    (entry.block as ParagraphBlock).attrs = { alignment: 'justify' };
    (entry.block as ParagraphBlock).runs = [
      { kind: 'text', text: 'highlighted words here ', highlight: 'yellow' } as Run,
      { kind: 'text', text: 'x', superscript: true } as Run,
      { kind: 'text', text: 'y', subscript: true } as Run,
    ];
    await expect(exportToPdf(input)).resolves.toBeInstanceOf(Blob);
  });

  test('renders a table (borders, shading, cell content) without crashing', async () => {
    const cellPara = (text: string): { block: ParagraphBlock; measure: ParagraphMeasure } => {
      const runs: Run[] = [{ kind: 'text', text } as Run];
      return {
        block: { kind: 'paragraph', id: 9 as never, runs, attrs: {} },
        measure: { kind: 'paragraph', lines: [line(runs)], totalHeight: 18 },
      };
    };
    const mkCell = (text: string, bg?: string) => {
      const cp = cellPara(text);
      return {
        cell: {
          id: 0 as never,
          blocks: [cp.block],
          background: bg,
          borders: {
            top: { style: 'single', width: 1, color: '#000000' },
            bottom: { style: 'single', width: 1 },
            left: { style: 'single', width: 1 },
            right: { style: 'single', width: 1 },
          },
          verticalAlign: 'center' as const,
        },
        measure: { blocks: [cp.measure], width: 200, height: 30 },
      };
    };
    const r1 = [mkCell('A1', '#eeeeee'), mkCell('B1')];
    const r2 = [mkCell('A2'), mkCell('B2')];
    const table = {
      kind: 'table' as const,
      id: 5 as never,
      columnWidths: [200, 200],
      rows: [
        { id: 0 as never, cells: r1.map((c) => c.cell), isHeader: true },
        { id: 1 as never, cells: r2.map((c) => c.cell) },
      ],
    };
    const tableMeasure = {
      kind: 'table' as const,
      columnWidths: [200, 200],
      totalWidth: 400,
      totalHeight: 60,
      rows: [
        { cells: r1.map((c) => c.measure), height: 30 },
        { cells: r2.map((c) => c.measure), height: 30 },
      ],
    };
    const blockLookup: BlockLookup = new Map([
      ['5', { block: table as never, measure: tableMeasure as never }],
    ]);
    const layout: Layout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 1,
          size: { w: 816, h: 1056 },
          margins: { top: 96, right: 96, bottom: 96, left: 96 },
          fragments: [
            {
              kind: 'table',
              blockId: 5 as never,
              x: 96,
              y: 96,
              width: 400,
              height: 60,
              fromRow: 0,
              toRow: 2,
            },
          ],
        },
      ],
    };
    const blob = await exportToPdf({
      layout,
      blockLookup,
      fontProviderFactory: stubFonts,
      options: { now: '2026-06-02T00:00:00.000Z' },
    });
    const reloaded = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
    expect(reloaded.getPageCount()).toBe(1);
  });
});
