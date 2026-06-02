# Design — Native Vector PDF Export

## Library

**pdf-lib + @pdf-lib/fontkit.** Pure-ESM, browser-first, real glyph subsetting, draw API (`drawText`/`drawLine`/`drawRectangle`/`drawImage`, `font.widthOfTextAtSize`, text-state operators `setCharacterSpacing`/`setWordSpacing`). Added as core `dependencies` but **dynamically imported** (`await import('@eigenpal/docx-editor-core/pdf')`) only on export/print — never in the editor's hot path. Bundle cost is paid only when a user exports.

Spike outcome (`scripts/pdf-font-spike/RESULT.md`): `@pdf-lib/fontkit` ingests **raw woff2 directly** (no woff2 decoder dep); gstatic CORS is `*`. **Spike caveat:** it validated only the single 400-normal face; per-(weight,style) variant selection (below) is the remaining font risk.

## Input contract — `exportToPdf(input)` (signature corrected)

`Layout` alone is **insufficient**: the layout engine never populates `Layout.headers`/`footers`, and page borders / page background / footnote content / titlePg+even-odd resolution all live in the **adapter** (`useLayoutPipeline.ts` → `renderPage` options via `convertHeaderFooterPmDocToContent`), not on `Layout`. The exporter therefore takes the **same inputs the painter's `renderPage` takes**, supplied by the adapter:

```ts
exportToPdf(input: {
  layout: Layout;
  theme?: DocumentTheme;                       // for any residual color resolution
  headerFooter?: {                             // resolved HF content, mirrors renderPage options
    byPage(pageNumber): { header?: HeaderFooterContent; footer?: HeaderFooterContent };
  };
  pageBorders?: PageBordersSpec;               // w:pgBorders (renderPage option today)
  backgroundColor?: string;                    // w:background (renderPage option today)
  options?: { documentName?; author?; pageNumberStart?; showTrackedChanges?; showComments?; onProgress?; warnings?: (w) => void };
}): Promise<Blob>
```

The adapter already computes per-page HF selection (default/first/even-odd via `hasTitlePg`/`evenAndOddHeaders`) for the painter; it passes the resolved result here. The exporter reuses the **same** `HeaderFooterContent` the painter consumes, so HF geometry matches the screen.

## Coordinate transform & baseline (`coords.ts`)

Engine units are CSS px @96dpi; PDF is points @72dpi, origin bottom-left. `pxToPt` exists (`measureContainer.ts:390`, `= px*72/96`). pdf-lib `drawText` `y` is the **glyph baseline**, not the line top — the painter never computes a baseline in JS (CSS does it), so the exporter must derive it from `MeasuredLine`:

```
leading        = line.lineHeight - (line.ascent + line.descent)   // box leading; handles lineRule auto/atLeast/exact
baselineFromTop = leading / 2 + line.ascent
baselineYpx    = lineTopYpx + baselineFromTop
xPt  = pxToPt(fragmentX + run.x)
yPt  = pxToPt(pageHeightPx) - pxToPt(baselineYpx)        // sized from page.size (per-page, not layout default)
```

`MeasuredLine.ascent`/`descent`/`lineHeight` (`types.ts:658-663`) are authoritative (ascent is the ink-bound `Hg` ascent the measurer produced). Mixed-size runs share the **line's** ascent (driven by the tallest run), so small runs sit on the same baseline as on screen. Super/subscript and `run.positionPx` shift the baseline additively (positive = up = larger `yPt`). Each PDF page is sized from its own `page.size`/`orientation` so mixed-section/landscape docs are correct.

## Metric source — the parity-critical decision (export uses pdf-lib metrics)

The x cursor MUST be measured with the **same font the glyphs are drawn with**, or text drifts. The painter measures with canvas `measureText` over the CSS fallback stack (`createTextMeasurer` `line.ts:232`); on a machine lacking the Office font, canvas measures a _system_ fallback while the PDF embeds the _Google_ face → cumulative intra-line drift and off-margin right/justify (worst on the common Office-font case).

Fix: `positionRunsInLine` takes an **injected** `measureText`. The painter injects its canvas measurer (screen). The **exporter injects pdf-lib's embedded-face metric**:

```ts
measureText = (text, sizePt, family, bold, italic) =>
  fontProvider.getFontSync(family, { bold, italic }).widthOfTextAtSize(text, sizePt);
```

`widthOfTextAtSize` is synchronous but font fetch is async, so the exporter runs a **warm-up pass per page**: collect every `(family, bold, italic)` the page's runs reference, `await` all face resolutions (with fallback), then position+draw with the synchronous `getFontSync`. This makes run-x exactly the advance pdf-lib draws with — zero intra-line drift, exact margins/justify. Accepted cost: screen↔PDF may differ by a hair (same tolerance class as Option A justify); internal PDF consistency matters more. Font size stays in **points end-to-end** in the export path (no `*96/72`).

Consequence: the spec must NOT claim "positions identical under fallback" — positions follow whichever face actually draws (embedded or fallback).

## Per-run positioning — `positionRunsInLine` (the shared seam)

Extract a pure function (no DOM) from `renderLine` (`renderParagraph/line.ts`):

```ts
interface PositionedRun {
  run: Run;
  x: number;
  width: number;
  kind: 'text' | 'tab' | 'image' | 'field' | 'lineBreak';
  resolvedText?: string;
  tabLeader?: TabLeader;
}
interface PositionedLine {
  runs: PositionedRun[];
  baselineFromTop: number;
  lineHeight: number;
  isFlexAnchored: boolean;
}
function positionRunsInLine(
  block,
  line,
  alignment,
  opts: {
    availableWidth;
    isFirstLine;
    isLastLine;
    paragraphEndsWithLineBreak;
    tabStops;
    leftIndentPx;
    rightIndentPx;
    firstLineIndentPx;
    lineRightEdgePx;
    measureText;
    context;
  }
): PositionedLine;
```

Moves the `currentX` cursor, tab math (`calculateTabWidth`/`getTextAfterTab`/`measureFollowingContentWidth`), first-line/hanging indent, right-indent, and the right-tab anchor **trigger predicate** out of `line.ts`. `renderLine` is refactored to call it and build DOM from the result, keeping ALL existing DOM mutation. Behavior-preserving; gated by playwright.

### What actually shares vs what the exporter computes alone (Option A)

For **plain text lines** the painter computes an explicit JS `currentX` — shared cleanly. For **justify** (`line.ts:340`), **centered/baseline image lines** (`:306`), and the **right-tab/TOC anchor** (`:451-514`) the painter delegates final positioning to CSS flex / `text-align: justify` and computes no JS x today. Decision **Option A**: the painter stays as-is for those cases; `positionRunsInLine` computes their x **for the exporter** (justify gaps, centered/right offsets, right-anchor `lineRightEdge - followingWidth`). Lowest regression risk (fragile painter code untouched). Therefore the exporter's justify/center/right-anchor x is exercised ONLY by unit tests (4.x) and the exporter, NOT by the playwright painter gate — those tests are the sole guard there. The right-anchor **trigger predicate** (incl. `RIGHT_EDGE_EPSILON_PX`) is replicated so the exporter agrees with the painter on _whether_ a line anchored; once anchored it positions with exact floats (no integer rounding, no epsilon nudge — wrap decisions are already baked into the consumed `MeasuredLine`s). **Option B** (absolutely position every run in the painter too) is deferred unless A shows visible drift.

### Justify mechanics

pdf-lib will not justify one `drawText`, and the `Tw` word-spacing operator is **ignored for embedded subset/CID fonts** — so justify is done by computing the inter-word gap `(availableWidth - naturalWidth)/spaceCount` and **drawing each word at its computed x** (gaps must land between words, including spaces _inside_ a multi-word run, not only at run boundaries). This is the primary mechanism, not a fallback.

## Exporter module (`packages/core/src/pdf/`)

`exportToPdf(input)`: create `PDFDocument`, `registerFontkit(fontkit)`, set deterministic metadata (`setProducer`/`setCreator`/fixed `setCreationDate`/`setModificationDate`; Title/Author from options). For each `layout.pages[]`: warm-up fonts, size the page from `page.size`, draw background, page borders, header/footer layers, then `fragment.kind`:

- `paragraph` → `pdfParagraph`: per line call `positionRunsInLine`; draw highlight/shading/paragraph-border rectangles first, then per run `drawText`. Honors: bold/italic (real face), underline (style+color, thickness/position from font metrics; double/dotted/dashed/wavy), strike, color, highlight, super/subscript (shift + ~0.6 size), `positionPx` baseline shift, `letterSpacing` (via `setCharacterSpacing` Tc), `horizontalScale` (text-matrix Tz / `scaleX`), `allCaps`/`smallCaps` (uppercase the string before measure+draw; small-caps shrinks lowercase source), `hidden` (**omit** — Word print suppresses `w:vanish`). Paragraph borders include the between-paragraph **grouping** the painter does (`prevBorders`/`nextBorders` from neighbor fragments) and bar border. List marker drawn in its own `listMarkerFontFamily`/`Size`/color in a slot sized via the painter's `getListMarkerInlineWidth` (suffix tab/space), omitted when `listMarkerHidden`.
- `table` → `pdfTable`: replicate the painter's **collapsed-border rule** (first row draws top, first column draws left, every cell draws right+bottom — NOT CSS collapse, NOT independent conflict resolution); cell shading; **merged cells** (gridSpan/vMerge via the painter's span tracking — occupied columns, rowSpan height summation); **cell vertical alignment** (offset content y for center/bottom); **cell padding** defaults `{top:1,right:7,bottom:1,left:7}`; inter-paragraph **spacing collapse** inside cells (`max(prevAfter, before)`, mirror `renderCellContent`); border **style** → dash arrays, double = two lines; header-row repeat; **nested tables** (cell recursion dispatches on `block.kind`, paragraph AND table); table justification/indent for nested tables.
- `image` → `pdfImage`: `png`/`jpeg` embed directly; `gif`/`bmp`/`webp`/`svg` → **canvas re-encode to PNG** then embed (browser-only is fine); `emf`/`wmf` (canvas can't decode) → draw a placeholder box + emit a warning, **never throw**. Parse the CSS-string `transform` (`rotate(Ndeg) scaleX(-1)`) → degrees + flip; rotate around the image **center** (painter uses `transform-origin:center`, reserves the rotated bbox); crop via canvas sub-rect; opacity. **Dedup by `src`** (embed once, draw many) for memory.
- `textBox` → deferred (Phase 3), guarded.
- **Exhaustiveness**: `fragment.kind`/`block.kind` switches end with `assertExhaustive…` so a new variant fails `bun run typecheck` until handled. The exporter never touches the painter DOM dataset contract. Unknown run formatting is ignored, never asserted.

### FontProvider (`fontProvider.ts`)

```ts
interface FontProvider {
  warmUp(faces: Array<{ family; bold; italic }>): Promise<void>; // resolve+embed all faces for a page
  getFontSync(family, { bold, italic }): PDFFont; // sync after warmUp; never null
}
```

- `GoogleFontProvider`: map family via `fontResolver`; request the **specific** `ital,wght` from CSS2 (`:ital,wght@1,700` for bold-italic), parse the woff2 url from the matching `@font-face` block, `embedFont(woff2, { subset:true })`. Cache **per (family,weight,style)**. Embed **sequentially** into the one `PDFDocument` (concurrent `embedFont` races shared doc state); woff2 _fetches_ may be concurrent. Per-font timeout. If the requested variant is absent, embed the nearest available weight (pdf-lib has no faux-bold; note the degradation).
- **Fallback chain**: embedded Google subset → **bundled Unicode fallback face** (a small Noto/Liberation woff2 shipped with the package) → standard-14 _only_ when the run text is provably WinAnsi-encodable (try `font.encode`/cp1252 test). Standard-14 is WinAnsi and `drawText` **throws** on non-Latin (CJK/Cyrillic/emoji/smart quotes), so it must never be the terminal fallback for arbitrary text. Per run, guard encodability and swap to the embedded Unicode face on failure.

### Color (`pdfText.ts`)

Runs/borders/shading/highlight carry **CSS strings** (theme already resolved upstream — `toFlowBlocks/runs.ts` `resolveColor(theme)`). Parser handles `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`, `rgb()/rgba()`, `hsl()/hsla()`, and CSS **named** colors (highlight emits names like `yellow`); alpha → pdf-lib `opacity`; `transparent`/empty → no fill (skip). Reuse any existing color util in `types/colors.ts` rather than hand-rolling. Missing `run.color` defaults to black (Word default).

## Adapter wiring & parity

- Both adapters: gather `layout` + the HF/page-border/theme resources they already pass to `renderPage`, dynamic-import `exportToPdf`, then the existing anchor-click download (`useFileIO.ts:196-209` React; `downloadCurrentDocument` Vue) with `.pdf`.
- Ref method `exportPdf(): Promise<Blob>` on both refs; added to `parity.contract.json` `paired`. `bun run api:extract` both.
- Menu: React Export entry via `submenuContent` (copy Insert▸Table; submenu buttons need `onMouseDown preventDefault`). Vue `fileItems` `submenu:true` + `#submenu` + `useMenuActions` cases.
- Print re-route: generate PDF → `URL.createObjectURL` → hidden `<iframe>` → `onload` → `contentWindow.print()`; fallback `window.open`; revoke after. Remove the popup-clone + `@font-face` scraping + `renderAllPagesNow` print call. Keep `onPrint?.()`.

## Testing

- bun unit: `coords` px→pt + Y-flip + **baseline** (`leading/2 + ascent`, incl. `exact`/`atLeast` lineRule); `positionRunsInLine` (left/center/right/**justify multi-word-single-run**, **decimal/center/bar** tabs + leader, hanging/first-line/right indent, **right-anchor trigger parity**, image-only/baseline-image line, letterSpacing, caps width) with an injected deterministic metric fn; `FontProvider` variant selection (bold-italic → `1,700` block) + fallback chain incl. **non-Latin doesn't throw**; CSS-color parser (hex3/4/6/8, rgb/rgba, hsl, named, alpha).
- PDF smoke: export a fixture → `pageCount === layout.pages.length`, pdf-lib re-parses, sentinel text extractable; **deterministic metadata** so bytes are stable; an EMF image and a non-Latin run both export without throwing.
- playwright (scoped): renderLine non-regression (`alignment`/`lists`/`line-spacing`/`tab-leader-fidelity`/`formatting`/`fonts`) before & after extraction; File▸Export▸PDF download; print re-route opens the PDF.

## Phasing

- **Phase 0** — font spike (done, GO).
- **Phase 1** — `positionRunsInLine` extraction + `packages/core/src/pdf/*` + deps + bundled fallback font + tests. Core only. `minor` changeset.
- **Phase 2** — adapter wiring + menu + print re-route + parity + i18n + api:extract. Both adapters, one PR. `minor`.
- **Phase 3** — see proposal "Phase-1 omits".

## Top risks

1. **Metric mismatch (headline)** — retired by injecting pdf-lib `widthOfTextAtSize` into the export measurer with a per-page font warm-up.
2. **Font variant + non-Latin fallback** — per-(weight,style) fetch + bundled Unicode fallback + encodability guard; standard-14 only for WinAnsi-safe text.
3. **renderLine extraction regressing screen** — pure geometry-only extraction; painter keeps DOM; gated by the layout playwright set.
4. **HF/page-border input** — exporter takes adapter-supplied resources (not `Layout`), mirroring `renderPage`.
5. **Image formats / async/perf** — canvas re-encode for non-PNG/JPEG, placeholder for EMF/WMF; dedup by `src`; reuse the loaded `Layout`; per-font timeout.
