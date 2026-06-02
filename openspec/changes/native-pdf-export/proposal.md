# Native Vector PDF Export

## Why

The editor has no PDF export, and printing is lossy. React's `handleDirectPrint` (`useFileIO.ts:122`) clones the painted `.paged-editor__pages` into a blank popup that carries only `@font-face` rules + a 6-line reset — it drops the `.ep-root` Tailwind scope and the theme-color CSS variables (`var(--…)`), so class-driven or theme-driven styling prints wrong. Vue calls `window.print()` on the live DOM (keeps styles but cannot hide editor chrome). The File menu offers only Save (.docx) and Print.

Users expect a real **Export to PDF** and a **File ▸ Export ▸ (.docx / .pdf)** menu, and expect the printed result to look identical to MS Word. A self-contained PDF also fixes printing: print the generated PDF instead of cloning DOM.

This is feasible at high fidelity because the layout engine already produces absolute geometry **as JS data** (not just rendered DOM): `Layout.pages[].fragments[]` carry exact `x/y/width/height`, runs carry point font sizes and theme-resolved colors, images are base64, and line-wrapping is JS-computed. The same `Layout` the painter draws is exposed on both refs (`pagedEditorRef.getLayout()` `PagedEditor.tsx:217`; Vue `layout` ShallowRef `useDocxEditor.ts:216`), so the exporter consumes it directly and is geometry-identical to the screen.

A Phase 0 spike (`packages/core/scripts/pdf-font-spike/`) resolved the one real unknown — in-browser font embedding — with a **GO**: gstatic serves woff2 with `access-control-allow-origin: *`, and `@pdf-lib/fontkit` decodes and subsets raw woff2 in-browser. No separate woff2 decoder is needed.

## What Changes

- New **core** capability `exportToPdf(input): Promise<Blob>` in `packages/core/src/pdf/` that walks the computed layout and emits a real vector PDF (selectable text, embedded subset fonts, vector tables/borders, embedded images). Exposed via a new `./pdf` export subpath, **dynamically imported** so pdf-lib/fontkit stay out of the editor's hot path and main bundle.
- **Corrected input contract**: `Layout` alone is insufficient — headers/footers, page borders, page background, and titlePg/even-odd resolution are **not on `Layout`**; the adapter resolves them and passes them to the painter's `renderPage` today. `exportToPdf` takes the **same adapter-supplied inputs** (`{ layout, theme?, headerFooter?, pageBorders?, backgroundColor?, options? }`) and reuses the same resolved `HeaderFooterContent` the painter consumes, so output matches the screen. See design.
- **Per-run-x parity refactor**: extract the painter's `renderLine` (`layout-painter/renderParagraph/line.ts`) `currentX` cursor (tabs, indent) into a pure `positionRunsInLine(...)`. The painter keeps all DOM mutation and injects its canvas measurer; **the exporter injects pdf-lib's embedded-font metric** (`widthOfTextAtSize`) after a per-page font warm-up, so the x cursor and the drawn glyphs share one metric source and text cannot drift within a line (the alternative — measuring with the canvas font while drawing the embedded font — mis-aligns right/justify on the common Office-font case). Behavior-preserving for the painter.
- **Adapters** gain an `exportPdf(): Promise<Blob>` ref method and a download handler (reusing the existing anchor-click pattern), wired identically in React and Vue.
- **Menu**: File ▸ Export ▸ (.docx / .pdf) added to React `TitleBar.tsx` (nested `submenuContent` primitive) and Vue `MenuBar.vue` + `useMenuActions.ts`.
- **Print re-route**: both adapters generate the PDF and print it (object URL → hidden iframe → `contentWindow.print()`), replacing the lossy popup-clone path. Fixes the style-loss that motivated #579-era print patches.
- **Dependencies**: `pdf-lib` + `@pdf-lib/fontkit` added to `packages/core` (pure-JS, browser-first, ESM). No woff2 decoder (per spike). A small **bundled Unicode fallback font** (Noto/Liberation woff2) ships for the non-Latin fallback case (standard-14 PDF fonts are WinAnsi and throw on CJK/Cyrillic/etc.).

Scope is phased. Phase 1 targets the "looks identical to Word/the editor" baseline — it must render everything the layout model carries and the painter draws today, or the PDF visibly regresses against the editor:

- **Text runs**: bold/italic (real Google weight/style face), underline incl. style+color (single/double/dotted/dashed/wavy), strike, color, highlight, super/subscript, `w:position` baseline shift, `w:spacing` letter-spacing, `w:w` horizontal scale, caps/smallCaps. Hidden text (`w:vanish`) is **suppressed** (Word print semantics). DATE/TIME/PAGE/NUMPAGES fields resolved; other fields → fallback text.
- **Paragraphs**: alignment incl. justify and the right-tab/TOC anchor; left/right/firstLine/hanging indent; line spacing (from measured line heights); paragraph borders (per-side + between-paragraph grouping + bar) and shading; decimal/center/bar tab stops and leaders (dot/hyphen/underscore).
- **Lists**: marker in its own font/size/color, positioned in a suffix-sized slot, omitted when hidden.
- **Tables**: collapsed borders (matching the painter's rule) with border styles, cell shading, cell vertical alignment, cell margins, merged cells (gridSpan/vMerge), nested tables, header-row repeat, rows split across pages.
- **Images**: JPEG/PNG embedded directly; GIF/BMP/WEBP/SVG canvas-re-encoded to PNG; EMF/WMF drawn as a placeholder (no crash); crop, opacity, rotation/flip; dedup by source.
- **Page/section**: per-page size/orientation/margins (mixed sections), page borders, page background, headers/footers (default/first/even-odd) with page-number fields.
- **Fonts**: per-(family,weight,style) Google subset embedding with a bundled Unicode fallback.

**Phase-1 explicitly omits** (renders as plain text or skipped, tracked for Phase 3): per-run RTL/bidi glyph **ordering** (LTR visual order used; paragraph `bidi` right-default alignment is honored); run effects (emboss/imprint/shadow/outline) and CJK emphasis marks (`w:em`); footnotes/endnotes (reserved area left blank, body geometry unaffected); multi-column text **reflow** (fragments are already column-positioned, so text places correctly; column separators drawn); text boxes and shapes; line numbers (`w:lnNumType`); page content vertical alignment (`w:vAlign`); per-section page-number restart/format (`w:pgNumType`); bullet markers in symbolic fonts (Symbol/Wingdings — not on Google Fonts, see Open Questions); hyperlink link annotations; PDF outline/bookmarks and PDF/UA tagging.

## Impact

- Affected specs: `pdf-export` (new)
- Affected code:
  - `packages/core/src/pdf/*` (new) — `index.ts` (`exportToPdf`), `coords.ts`, `fontProvider.ts`, `pdfPage.ts`, `pdfParagraph.ts`, `pdfTable.ts`, `pdfImage.ts`, `pdfText.ts`, `types.ts`
  - `packages/core/src/layout-painter/renderParagraph/positionRuns.ts` (new) — pure run positioner extracted from `line.ts`; `line.ts` refactored to consume it (behavior-preserving)
  - `packages/core/package.json` — add `pdf-lib`, `@pdf-lib/fontkit`; add `./pdf` export subpath + `typesVersions`
  - `packages/core/src/utils/fontResolver.ts` — reused for family→Google mapping + fallback category; `fontLoader.ts` CSS2 URL builder reused by `GoogleFontProvider` (extended to request a specific `ital,wght` variant)
  - a bundled Unicode fallback font asset (woff2) under `packages/core` for the non-Latin fallback
  - React: `components/DocxEditor/hooks/useFileIO.ts` (export + print re-route), `TitleBar.tsx` (Export submenu), `useDocxEditorRefApi.ts` + `DocxEditor.tsx` (`exportPdf` ref)
  - Vue: `composables/useFileIO.ts`, `useDocxEditor.ts`, `components/MenuBar.vue`, `composables/useMenuActions.ts`, print path
  - `packages/i18n/en.json` — `toolbar.export`/`exportPdf`/`exportDocx`
  - `scripts/parity/parity.contract.json` — `exportPdf` paired ref method
  - `docs/api/*` — regenerated snapshots
- Public API: `exportToPdf` and its option/resource types are `@public` (core); `exportPdf` is `@public` on both refs. `bun run api:extract` mandatory. Changeset: `minor` (additive public API) for the fixed package group.

## Open Questions

- **Justification mechanics**: justify is done by computing inter-word gaps and drawing each word at its computed x (the PDF `Tw` word-spacing operator is ignored for embedded subset/CID fonts, so per-word draw is the primary mechanism, not a fallback). Gaps must land between words including spaces _inside_ a multi-word run. Validate on a justified multi-word-single-run fixture.
- **Unmapped / symbolic fonts**: families with no Google mapping fall back to the bundled Unicode face, then to standard-14 only for WinAnsi-safe text. Positions follow whichever face actually draws (so positions are NOT invariant under fallback — the design accepts this in exchange for zero intra-line drift). **Bullet markers in symbolic fonts (Symbol/Wingdings/Webdings) are not on Google Fonts** — open question whether to map common bullet codepoints to Unicode equivalents or bundle a symbol fallback; otherwise such bullets render as tofu. Advanced nearest-metric substitution is Phase 3.
- **Tracked changes / comments visibility**: the editor always shows markup; Word's PDF export shows it only with "Show Markup." `options.showTrackedChanges`/`showComments` default to matching the editor (show); confirm the desired default.
- **Hidden text**: Phase 1 suppresses `w:vanish` runs (Word print semantics) rather than mirroring the editor's dimmed rendering. Confirm.
- **RTL/bidi**: per-run glyph ordering is deferred (LTR visual order, paragraph `bidi` alignment honored); an Arabic/Hebrew run renders in logical order. Flag if Phase 1 must reorder.
- **Headless/server export** is out of scope: measurement and image canvas-re-encode are browser-bound, so the exporter is in-browser only.
