# Tasks

> **Implementation status (Phase 1 + 2 landed):** the core exporter
> (`packages/core/src/pdf/`) renders paragraphs (text + run formatting, shading,
> borders, lists, tabs/leaders, justify), tables (collapsed borders, shading,
> vAlign, padding, colSpan, nested, header-repeat), images (PNG/JPEG + canvas
> re-encode + EMF placeholder), headers/footers, page borders, and page
> background, with per-(weight,style) Google subset embedding + Unicode/standard-14
> fallback. Both adapters are wired: `exportPdf()` ref method (paired in the parity
> contract), File ▸ Export ▸ (.docx / .pdf) menu, and print re-routed through the
> generated PDF (DOM-clone fallback). 30 unit tests pass; full typecheck clean;
> i18n in sync; api snapshots regenerated; real Calibri→Carlito subset embedding
>
> - a formatting playwright smoke confirmed. A second review pass (correctness +
>   OOXML/Word fidelity + simplification) fixed: run highlight background, super/sub
>   size (0.75em), image rotation pivot (center), justify-within-run (word-by-word),
>   in-cell paragraph spacing collapse, **table vMerge/rowSpan** (occupied-column
>   tracking), and a real fragment-exhaustiveness guard; plus consolidations (shared
>   face-collector, `buildExportInput`, `printPdfBlob`, `eighthsToPixels` reuse).
>   **Drift tripwire added:** the exporter now draws through a `PageSink` interface;
>   a `RecordingSink` + golden-snapshot tests (`drawOps.golden.test.ts`) capture the
>   exact draw ops so any painter/exporter drift fails CI as a readable diff. The
>   tripwire already caught a rowSpan off-by-one on its first run.
>
> **Remaining (follow-ups):** rewire the painter's `renderLine` onto
> `positionRunsInLine` (gated by the full layout playwright set — deferred, no
> longer urgent now that the tripwire catches positioning drift); inline images
> inside paragraphs; paragraph-border between-grouping/bar; the in-app PDF
> visual-diff pass; the deferred Phase-3 list below.

## 0. Font spike (GO/NO-GO) — DONE

- [x] 0.1 Node leg: CSS2 parse → woff2 fetch → decode → `embedFont({subset:true})` → reload (`scripts/pdf-font-spike/node-spike.mjs`)
- [x] 0.2 Browser leg (Chromium, CORS enforced): page reads woff2 bytes + `@pdf-lib/fontkit` decodes raw woff2 + subset embed + reload (`scripts/pdf-font-spike/browser-spike.mjs`)
- [x] 0.3 Verdict recorded (`scripts/pdf-font-spike/RESULT.md`): GO; deps = `pdf-lib` + `@pdf-lib/fontkit` only (no woff2 decoder). NOTE: spike validated only the 400-normal face — per-variant selection (1.x) is the remaining font risk

## 1. Per-run-x parity refactor

- [ ] 1.1 Create `layout-painter/renderParagraph/positionRuns.ts` with pure `positionRunsInLine(block, line, alignment, opts)` → `PositionedLine { runs, baselineFromTop, lineHeight, isFlexAnchored }`. `measureText` and `rightIndentPx` are injected params (no module-level canvas)
- [ ] 1.2 Move from `line.ts`: `currentX` cursor, tab math (`calculateTabWidth`/`getTextAfterTab`/`measureFollowingContentWidth`), first-line/hanging/right indent, right-tab anchor **trigger predicate** (incl. `RIGHT_EDGE_EPSILON_PX`). For justify/centered/right-anchor lines compute the exporter's x (gaps/offsets/`lineRightEdge - followingWidth`) — these paths are exporter-only (painter keeps CSS flex). Justify gap distributes between words incl. intra-run spaces
- [ ] 1.3 Refactor `renderLine` to call `positionRunsInLine` and build DOM from the result; keep ALL existing DOM mutation (flex promotion, highlight padding, indent margins, right-anchor re-render). Painter injects its canvas measurer
- [ ] 1.4 Baseline: `positionRunsInLine`/coords compute `baselineFromTop = leading/2 + ascent` from `MeasuredLine.ascent/descent/lineHeight` (handles `auto`/`atLeast`/`exact` lineRule); `positionPx` + super/subscript shift additively
- [ ] 1.5 Non-regression gate (before & after): `bun run typecheck` + playwright `alignment`/`lists`/`line-spacing`/`tab-leader-fidelity`/`formatting`/`fonts`

## 2. Dependencies & packaging

- [ ] 2.1 Add `pdf-lib` + `@pdf-lib/fontkit` to `packages/core/package.json` `dependencies`
- [ ] 2.2 Add `./pdf` export subpath (mirror `./layout-painter`) + `typesVersions`; confirm tsup builds the new entry
- [ ] 2.3 Ensure the editor never statically imports `./pdf` (dynamic-import only) — grep to confirm no eager import path
- [ ] 2.4 Bundle a small Unicode fallback font (Noto/Liberation woff2) as a core asset; confirm it is loadable in the browser build (license: OFL/permissive)

## 3. Core exporter module (`packages/core/src/pdf/`)

- [ ] 3.1 `types.ts` — `ExportToPdfInput` (`{ layout, theme?, headerFooter?, pageBorders?, backgroundColor?, options? }`), `FontProvider` interface (`warmUp` + sync `getFontSync`)
- [ ] 3.2 `coords.ts` — `pxToPt` reuse + per-page Y-flip + **baseline** (`leading/2 + ascent`); page sized from `page.size` (per-page). Unit-tested incl. `exact`/`atLeast` lineRule
- [ ] 3.3 `fontProvider.ts` — `GoogleFontProvider`: per-(family,weight,style) variant fetch from multi-variant CSS2 (select the matching `ital,wght` `@font-face` block), `embedFont({subset:true})`, cache per face, **embed sequentially** (fetch may be concurrent), per-font timeout. `warmUp(faces)` resolves every face a page uses; `getFontSync` non-null
- [ ] 3.4 Fallback chain: embedded Google → bundled Unicode face → standard-14 only when text is WinAnsi-encodable (per-run `font.encode` guard; swap to Unicode face on failure). Never let standard-14 throw on non-Latin
- [ ] 3.5 `pdfText.ts` — robust CSS color parser (`#rgb/#rgba/#rrggbb/#rrggbbaa`, `rgb()/rgba()`, `hsl()/hsla()`, named; alpha→opacity; `transparent`→skip; default black); face selection; super/subscript (shift + ~0.6 size); `positionPx` baseline shift; `letterSpacing` via `setCharacterSpacing` (Tc); `horizontalScale` via text-matrix (Tz); `allCaps`/`smallCaps` (uppercase the string before measure+draw); skip `hidden`; underline/strike thickness+position from font metrics, underline style (double/dotted/dashed/wavy) + color
- [ ] 3.6 `pdfParagraph.ts` — consume `positionRunsInLine` with the **pdf-lib metric** `measureText`; draw highlight/shading/paragraph-border rects first (incl. between-paragraph border grouping from neighbor fragments + bar border), then `drawText` per run; justify by per-word draw; tab leaders drawn as repeated glyphs; list marker in its own font/size/color in a `getListMarkerInlineWidth` slot, omit when hidden
- [ ] 3.7 `pdfTable.ts` — painter collapse rule (first-row-top/first-col-left/right+bottom), border style→dash/double, cell shading, merged cells (gridSpan/vMerge span tracking + rowSpan height sum), cell vAlign offset, cell padding defaults `{1,7,1,7}`, in-cell inter-paragraph spacing collapse (`max(prevAfter,before)`), header-row repeat, nested tables (recurse on `block.kind`), nested-table justification/indent
- [ ] 3.8 `pdfImage.ts` — png/jpeg direct; gif/bmp/webp/svg → canvas→PNG; emf/wmf → placeholder + warning (no throw); parse CSS `transform` (degrees+flip), center-pivot rotation + rotated-bbox placement, crop via canvas sub-rect, opacity; **dedup by `src`** (embed once)
- [ ] 3.9 `pdfPage.ts` — page size/orientation/margins from `page.size`; background; page borders (offsetFrom page/text, display all/first/notFirst, double min-width); header/footer layers from `input.headerFooter.byPage` (default/first/even-odd already resolved by adapter); footnote reserved area left blank; column separators; field substitution PAGE (`page.number + pageNumberStart-1`)/NUMPAGES (total)/DATE/TIME/other→fallback; `fragment.kind` switch ends with `assertExhaustive…`
- [ ] 3.10 `index.ts` — `exportToPdf(input): Promise<Blob>`; deterministic metadata (`setProducer`/`setCreator`/fixed `setCreationDate`/`setModificationDate`; Title/Author from options); per-page font warm-up → draw; `onProgress`/`warnings`; tracked-change/comment visibility per options (default = show, matching editor)

## 4. Tests (Phase 1)

- [ ] 4.1 bun unit: `coords` px→pt + Y-flip + baseline (incl. `exact`/`atLeast`)
- [ ] 4.2 bun unit: `positionRunsInLine` — left/center/right/**justify (multi-word single run)**, **decimal/center/bar** tabs + leader, hanging/first-line/**right** indent, **right-anchor trigger parity**, image-only + baseline-image line, letterSpacing, caps width — with injected deterministic metric fn
- [ ] 4.3 bun unit: `FontProvider` variant selection (bold-italic → `1,700` block) + fallback chain; **non-Latin run does not throw**; CSS-color parser (hex3/4/6/8, rgb/rgba, hsl, named, alpha)
- [ ] 4.4 PDF smoke: export a fixture → `pageCount === layout.pages.length`, pdf-lib re-parses, sentinel text extractable; deterministic metadata (stable bytes); an EMF image + a non-Latin run both export without throwing

## 5. Adapter wiring, menu, print re-route (Phase 2 — both adapters, one PR)

- [ ] 5.1 React `useFileIO`: `handleExportPdf` (gather layout + HF/page-border/theme resources already passed to `renderPage` → dynamic import → anchor download `.pdf`); re-route `handleDirectPrint` to PDF→objectURL→hidden iframe→`contentWindow.print()` (fallback `window.open`); remove popup-clone + `@font-face` scrape + `renderAllPagesNow` print call
- [ ] 5.2 React ref: add `exportPdf()` in `useDocxEditorRefApi.ts` + `DocxEditorRef` type (`DocxEditor.tsx`)
- [ ] 5.3 React menu: File ▸ Export ▸ (.docx/.pdf) in `TitleBar.tsx` via `submenuContent`; submenu buttons `onMouseDown preventDefault`
- [ ] 5.4 Vue: mirror export + print re-route in `useFileIO`/`useDocxEditor` (supply the same HF/page-border resources); ref `exportPdf` via typed `Use…Return`; `MenuBar.vue` `fileItems` + `#submenu` + `useMenuActions.ts` cases
- [ ] 5.5 i18n: add `toolbar.export`/`exportPdf`/`exportDocx` to `packages/i18n/en.json`; `bun run i18n:fix`; `bun run i18n:validate`
- [ ] 5.6 Parity: add `exportPdf` to `scripts/parity/parity.contract.json` (paired); `bun run api:extract` (both adapters); `bun run check:parity-contract`
- [ ] 5.7 playwright: File▸Export▸PDF triggers download; print re-route opens the PDF (both adapters); titlePg/even-odd header variant + landscape-section page sizing in the PDF

## 6. Release & docs

- [ ] 6.1 `bun run typecheck` + `bun run format`
- [ ] 6.2 `bun changeset` — `minor`, fixed package group, consumer-facing summary
- [ ] 6.3 Remove throwaway spike scripts before final (or exclude `scripts/` from the published build — confirm `files`/build globs)

## Deferred (Phase 3, separate changes)

- [ ] Per-run RTL/bidi glyph ordering
- [ ] Multi-column text reflow (separators + column-positioned fragments already work)
- [ ] Footnotes/endnotes content
- [ ] Text boxes, shapes/geometry, run effects (shadow/emboss/imprint/outline), CJK emphasis marks (`w:em`)
- [ ] Bullet markers in symbolic fonts (Symbol/Wingdings) — codepoint mapping or bundled symbol face
- [ ] Hyperlinks as live PDF link annotations (`run.hyperlink.href`, `ImageBlock.hlinkHref`)
- [ ] Page content vertical alignment (`w:vAlign`); line numbers (`w:lnNumType`); per-section page-number restart/format (`w:pgNumType`)
- [ ] Page background `w:background` beyond solid color; watermarks beyond HF drawings
- [ ] Advanced font fallback (nearest-metric / system-font embedding); faux-bold/oblique synthesis
- [ ] PDF outline/bookmarks from headings; PDF/UA tagging
- [ ] Option B (absolutely position runs in the painter) if Option A shows visible justify/anchor drift
