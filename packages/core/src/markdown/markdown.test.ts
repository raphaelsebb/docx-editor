/**
 * Unit tests for the DOCX-to-Markdown converter.
 *
 * These tests build `Document` literals directly instead of round-tripping
 * real `.docx` files, so each test pins one renderer decision without
 * depending on the parser, the layout engine, or any disk fixture.
 */

import { describe, expect, test } from 'bun:test';
import type {
  Document,
  DocxPackage,
  HeaderFooter,
  Paragraph,
  Run,
  Table,
  TableCell,
  TableRow,
  TextContent,
} from '../types/document';
import type { MediaFile } from '../types/styles';
import { toMarkdown } from './index';
import { toMarkdownPaged } from './paged';
import { toMarkdownAsync } from './async';

// ---------------------------------------------------------------------------
// Tiny builders. Keep these noise-free so the actual test reads like a spec.
// ---------------------------------------------------------------------------

function doc(
  content: DocxPackage['document']['content'],
  extras: Partial<DocxPackage> = {}
): Document {
  return {
    package: {
      document: { content },
      ...extras,
    },
  };
}

function p(text: string, opts: Partial<Paragraph> = {}): Paragraph {
  return {
    type: 'paragraph',
    content: [run(text)],
    ...opts,
  };
}

function run(text: string, formatting: Run['formatting'] = undefined): Run {
  const content: TextContent = { type: 'text', text };
  return { type: 'run', formatting, content: [content] };
}

function tcell(text: string, formatting: TableCell['formatting'] = undefined): TableCell {
  return { type: 'tableCell', formatting, content: [p(text)] };
}

function trow(cells: TableCell[]): TableRow {
  return { type: 'tableRow', cells };
}

function table(rows: TableRow[]): Table {
  return { type: 'table', rows };
}

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

describe('toMarkdown — Document input', () => {
  test('returns a sync MarkdownResult for a parsed Document', () => {
    const result = toMarkdown(doc([p('hello world')]));
    expect(result.markdown).toBe('hello world');
    expect(result.images.size).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  test('joins consecutive paragraphs with a blank line', () => {
    const result = toMarkdown(doc([p('first'), p('second')]));
    expect(result.markdown).toBe('first\n\nsecond');
  });

  test('warns when the document is empty', () => {
    const result = toMarkdown(doc([]));
    expect(result.markdown).toBe('');
    expect(result.warnings).toContain('document has no content');
  });

  test('throws a descriptive Error for unsupported input', () => {
    expect(() => toMarkdown('not a buffer' as unknown as Document)).toThrow(/toMarkdown expected/);
  });
});

// ---------------------------------------------------------------------------
// Inline marks
// ---------------------------------------------------------------------------

describe('inline marks', () => {
  test('wraps bold/italic/strike with the right delimiters', () => {
    const para: Paragraph = {
      type: 'paragraph',
      content: [
        run('bold ', { bold: true }),
        run('italic ', { italic: true }),
        run('strike', { strike: true }),
      ],
    };
    const { markdown } = toMarkdown(doc([para]));
    expect(markdown).toBe('**bold** *italic* ~~strike~~');
  });

  test('nests marks outer-to-inner so they read cleanly', () => {
    const para: Paragraph = {
      type: 'paragraph',
      content: [run('bi', { bold: true, italic: true })],
    };
    const { markdown } = toMarkdown(doc([para]));
    expect(markdown).toBe('***bi***');
  });

  test('only known monospace fonts trigger inline code', () => {
    const code: Paragraph = {
      type: 'paragraph',
      content: [run('snippet', { fontFamily: { ascii: 'Consolas' } })],
    };
    const prose: Paragraph = {
      type: 'paragraph',
      content: [run('not code', { fontFamily: { ascii: 'Monotype Corsiva' } })],
    };
    expect(toMarkdown(doc([code])).markdown).toBe('`snippet`');
    expect(toMarkdown(doc([prose])).markdown).toBe('not code');
  });
});

// ---------------------------------------------------------------------------
// Headings + lists
// ---------------------------------------------------------------------------

describe('block structure', () => {
  test('emits `#` heading levels from Word style ids', () => {
    const h1: Paragraph = { ...p('Title'), formatting: { styleId: 'Heading1' } };
    const h3: Paragraph = { ...p('Subhead'), formatting: { styleId: 'Heading3' } };
    const { markdown } = toMarkdown(doc([h1, h3]));
    expect(markdown).toBe('# Title\n\n### Subhead');
  });

  test('renders bullet lists with `-`', () => {
    const items: Paragraph[] = [
      { ...p('first'), listRendering: { marker: '•', level: 0, numId: 1, isBullet: true } },
      { ...p('second'), listRendering: { marker: '•', level: 0, numId: 1, isBullet: true } },
    ];
    const { markdown } = toMarkdown(doc(items));
    expect(markdown).toBe('- first\n- second');
  });

  test("preserves Word's exact ordered-list marker (no renumbering)", () => {
    const items: Paragraph[] = [
      { ...p('alpha'), listRendering: { marker: 'A.', level: 0, numId: 1, isBullet: false } },
      { ...p('beta'), listRendering: { marker: 'B.', level: 0, numId: 1, isBullet: false } },
    ];
    const { markdown } = toMarkdown(doc(items));
    expect(markdown).toBe('A. alpha\nB. beta');
  });
});

// ---------------------------------------------------------------------------
// Hyperlinks
// ---------------------------------------------------------------------------

describe('hyperlinks', () => {
  function linkParagraph(): Paragraph {
    return {
      type: 'paragraph',
      content: [
        {
          type: 'hyperlink',
          href: 'https://example.com',
          children: [run('click')],
        },
      ],
    };
  }

  test('inline mode emits [text](url)', () => {
    const { markdown } = toMarkdown(doc([linkParagraph()]));
    expect(markdown).toBe('[click](https://example.com)');
  });

  test('reference mode emits [text][N] plus a numbered list', () => {
    const { markdown } = toMarkdown(doc([linkParagraph()]), { hyperlinks: 'reference' });
    expect(markdown).toContain('[click][1]');
    expect(markdown).toContain('[1]: https://example.com');
  });

  test('hyperlink with no href emits a warning and falls back to plain text', () => {
    const para: Paragraph = {
      type: 'paragraph',
      content: [{ type: 'hyperlink', children: [run('orphan')] }],
    };
    const result = toMarkdown(doc([para]));
    expect(result.markdown).toBe('orphan');
    expect(result.warnings).toContain('hyperlink missing href and anchor; rendered as plain text');
  });
});

// ---------------------------------------------------------------------------
// Tracked changes & comments
// ---------------------------------------------------------------------------

describe('tracked changes', () => {
  const tracked = () =>
    doc([
      {
        type: 'paragraph',
        content: [
          { type: 'deletion', info: { id: 1, author: 'Jed' }, content: [run('Hello')] },
          { type: 'insertion', info: { id: 2, author: 'Jed' }, content: [run('Hi')] },
          run(' world'),
        ],
      },
    ]);

  test("default 'annotate' keeps both insertions and deletions visible", () => {
    const { markdown } = toMarkdown(tracked());
    expect(markdown).toContain('<del');
    expect(markdown).toContain('Hello');
    expect(markdown).toContain('<ins');
    expect(markdown).toContain('Hi');
  });

  test("'clean' strips deletions and keeps insertion text", () => {
    const { markdown } = toMarkdown(tracked(), { trackedChanges: 'clean' });
    expect(markdown).toBe('Hi world');
  });

  test('pandoc annotations use bracketed spans instead of HTML', () => {
    const { markdown } = toMarkdown(tracked(), { annotations: 'pandoc' });
    expect(markdown).toContain('[Hi]{.ins');
    expect(markdown).not.toContain('<ins');
  });
});

describe('comments', () => {
  function commented(): Document {
    return {
      package: {
        document: {
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'commentRangeStart', id: 7 },
                run('hello'),
                { type: 'commentRangeEnd', id: 7 },
              ],
            },
          ],
          comments: [
            {
              id: 7,
              author: 'Jed',
              content: [{ type: 'paragraph', content: [run('fix greeting')] }],
            },
          ],
        },
      },
    };
  }

  test("default 'inline' wraps the commented span", () => {
    const { markdown } = toMarkdown(commented());
    expect(markdown).toBe('<comment id="7" author="Jed">hello</comment>');
  });

  test("'strip' drops the wrapper", () => {
    const { markdown } = toMarkdown(commented(), { comments: 'strip' });
    expect(markdown).toBe('hello');
  });

  test("'sidecar' references a numbered footnote at the end", () => {
    const { markdown } = toMarkdown(commented(), { comments: 'sidecar' });
    expect(markdown).toContain('hello[^c1]');
    expect(markdown).toContain('## Comments');
    expect(markdown).toContain('[^c1]: Jed: fix greeting');
  });
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

describe('tables', () => {
  test('renders a simple table as GFM', () => {
    const t = table([trow([tcell('Col A'), tcell('Col B')]), trow([tcell('1'), tcell('2')])]);
    const { markdown, warnings } = toMarkdown(doc([t]));
    expect(markdown).toContain('| Col A | Col B |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| 1 | 2 |');
    expect(warnings).toEqual([]);
  });

  test('falls back to inline HTML when a cell has gridSpan', () => {
    const t = table([
      trow([tcell('Wide', { gridSpan: 2 }), tcell('Right')]),
      trow([tcell('a'), tcell('b'), tcell('c')]),
    ]);
    const { markdown, warnings } = toMarkdown(doc([t]));
    expect(markdown).toContain('<table>');
    expect(markdown).toContain('colspan="2"');
    expect(warnings).toEqual([]);
  });

  test('emits rowspan for vMerge runs', () => {
    const t = table([
      trow([tcell('Tall', { vMerge: 'restart' }), tcell('row1')]),
      trow([tcell('', { vMerge: 'continue' }), tcell('row2')]),
      trow([tcell('', { vMerge: 'continue' }), tcell('row3')]),
    ]);
    const { markdown } = toMarkdown(doc([t]));
    expect(markdown).toContain('rowspan="3"');
    // The continue cells must NOT appear as their own <td>.
    const tdCount = (markdown.match(/<td/g) ?? []).length;
    const thCount = (markdown.match(/<th/g) ?? []).length;
    expect(tdCount + thCount).toBe(4); // 1 spanning + 3 right-column cells
  });

  test('nested tables trigger HTML mode and recurse', () => {
    const inner = table([trow([tcell('inner')])]);
    const cell: TableCell = { type: 'tableCell', content: [inner] };
    const outer = table([trow([cell, tcell('right')])]);
    const { markdown, warnings } = toMarkdown(doc([outer]));
    expect(markdown).toContain('<table>');
    // Two `<table>` tags: outer + nested.
    expect((markdown.match(/<table>/g) ?? []).length).toBe(2);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Paged
// ---------------------------------------------------------------------------

describe('toMarkdownPaged', () => {
  test('splits on renderedPageBreakBefore', () => {
    const result = toMarkdownPaged(
      doc([p('one'), { ...p('two'), renderedPageBreakBefore: true }, p('three')])
    );
    expect(result.pages.length).toBe(2);
    expect(result.pages[0].markdown).toBe('one');
    expect(result.pages[1].markdown).toBe('two\n\nthree');
  });

  test("splits on sectionStart: 'nextPage'", () => {
    const result = toMarkdownPaged(
      doc([
        {
          ...p('section 1'),
          sectionProperties: { sectionStart: 'nextPage' },
        },
        {
          ...p('section 2'),
          sectionProperties: { sectionStart: 'nextPage' },
        },
      ])
    );
    expect(result.pages.length).toBe(2);
  });

  test('combined output joins pages with `<!-- page N -->`', () => {
    const result = toMarkdownPaged(doc([p('a'), { ...p('b'), renderedPageBreakBefore: true }]));
    expect(result.combined).toBe('a\n\n<!-- page 2 -->\n\nb');
  });

  test('empty document yields zero pages, not one empty page', () => {
    const result = toMarkdownPaged(doc([]));
    expect(result.pages).toEqual([]);
    expect(result.warnings).toContain('document has no content');
  });

  test('emits header/footer when opts.headerFooter !== strip', () => {
    const header: HeaderFooter = {
      type: 'header',
      hdrFtrType: 'default',
      content: [p('header text')],
    };
    const result = toMarkdownPaged(
      {
        package: {
          document: {
            content: [p('body')],
            sections: [
              {
                properties: { sectionStart: 'continuous' },
                content: [p('body')],
                headers: new Map([['default', header]]),
              },
            ],
          },
        },
      },
      { headerFooter: 'all' }
    );
    expect(result.pages[0].markdown).toContain('<header>');
    expect(result.pages[0].markdown).toContain('header text');
  });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

describe('images', () => {
  function imageDoc(): Document {
    const media: MediaFile = {
      path: 'word/media/image1.png',
      mimeType: 'image/png',
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer as ArrayBuffer,
    };
    const drawing: Paragraph = {
      type: 'paragraph',
      paraId: 'P1',
      content: [
        {
          type: 'run',
          content: [
            {
              type: 'drawing',
              image: {
                type: 'image',
                rId: 'rId1',
                size: { width: 100, height: 100 },
                wrap: { type: 'inline' },
              },
            },
          ],
        },
      ],
    };
    return {
      package: {
        document: { content: [drawing, drawing] },
        relationships: new Map([
          [
            'rId1',
            {
              id: 'rId1',
              type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
              target: 'word/media/image1.png',
            },
          ],
        ]),
        media: new Map([['word/media/image1.png', media]]),
      },
    };
  }

  test('registers each media file once even when referenced multiple times', () => {
    const { images, markdown } = toMarkdown(imageDoc());
    expect(images.size).toBe(1);
    // The same virtual path appears in both paragraphs.
    const matches = markdown.match(/\.\/images\//g) ?? [];
    expect(matches.length).toBe(2);
  });

  test('async image handler substitutes the markdown reference', async () => {
    const result = await toMarkdownAsync(imageDoc(), {
      imageHandler: async () => '![described](cdn://foo)',
    });
    expect(result.markdown).toContain('![described](cdn://foo)');
    expect(result.markdown).not.toContain('./images/');
  });

  test('custom imagePath callback drives the virtual path', () => {
    const { images } = toMarkdown(imageDoc(), {
      imagePath: (info) => `assets/${info.index}.png`,
    });
    const paths = [...images.keys()];
    expect(paths).toEqual(['assets/1.png']);
  });

  test('handler errors push a warning and leave the default reference in place', async () => {
    const result = await toMarkdownAsync(imageDoc(), {
      imageHandler: async () => {
        throw new Error('upload failed');
      },
    });
    expect(result.markdown).toContain('./images/');
    expect(result.warnings.some((w) => w.includes('imageHandler failed'))).toBe(true);
  });
});
