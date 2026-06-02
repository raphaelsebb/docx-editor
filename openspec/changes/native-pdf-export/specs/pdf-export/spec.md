# pdf-export Spec

## ADDED Requirements

### Requirement: Export the document to a vector PDF

The core SHALL provide `exportToPdf(input): Promise<Blob>` where `input` carries the computed `Layout` plus the adapter-resolved resources the painter's `renderPage` also consumes (`headerFooter`, `pageBorders`, `backgroundColor`, `theme`, `options`) — because headers/footers, page borders, and page background are not on `Layout`. The PDF SHALL contain one PDF page per `Layout` page, sized and oriented from that page's own `page.size`/`orientation`, with real (selectable) vector text — not a rasterized image of the DOM. The exporter SHALL consume the same `Layout` and resolved content the painter renders so output geometry matches the screen.

#### Scenario: Page count and per-page size match the layout

- **Given** a document whose computed `Layout` has N pages
- **When** `exportToPdf(input)` is called
- **Then** the produced PDF has N pages
- **And** each PDF page's width/height equal that page's `page.size` converted px→pt (px\*72/96), so a document with a landscape section produces correctly-oriented pages

#### Scenario: Text is selectable, not rasterized

- **Given** a document with a paragraph of text
- **When** exported and re-parsed
- **Then** the paragraph's text is extractable from the PDF content (the page is not a single embedded image)

#### Scenario: Text baseline aligns to the measured line

- **Given** a line with a known top y, ascent, descent, and line height
- **When** exported
- **Then** glyphs are drawn at baseline `top + leading/2 + ascent` (leading = lineHeight − ascent − descent), so text registers vertically as on screen, including `exact`/`atLeast` line rules
- **And** runs of different font sizes on one line share the line's baseline

#### Scenario: Run formatting is carried into the PDF

- **Given** runs that are bold, italic, underlined (with style and color), struck-through, colored, highlighted, super/subscript, baseline-shifted (`w:position`), letter-spaced (`w:spacing`), horizontally scaled (`w:w`), and caps/smallCaps
- **When** exported
- **Then** each attribute is reflected: weight/style via the real embedded face, underline honoring style (double/dotted/dashed/wavy) and color, strike, the run's theme-resolved color (rgba alpha as opacity), highlight as a filled rectangle behind the run, super/subscript via shift + size reduction, letter-spacing and horizontal-scale affecting advance, caps via uppercased text

#### Scenario: Hidden text is suppressed

- **Given** a run marked hidden (`w:vanish`)
- **When** exported
- **Then** the run is omitted from the PDF (Word print semantics) and contributes no width

### Requirement: Run x-positions are internally consistent with the drawn glyphs

The exporter SHALL compute each run's x with the metrics of the **same font the glyphs are drawn with** (the embedded/fallback face via pdf-lib `widthOfTextAtSize`), not the browser canvas font, so text cannot drift within a line and right/justify alignment reaches the correct margin. Positions therefore follow whichever face actually draws (embedded or fallback); they are NOT required to be identical across faces. For justify, centered, and right-tab-anchor lines the exporter computes x itself (the painter delegates those to CSS), validated by unit tests within a visual-diff tolerance rather than byte-identity to the screen.

#### Scenario: A font the browser lacks still positions correctly

- **Given** a paragraph in an Office font not installed in the browser but embeddable via Google Fonts
- **When** exported
- **Then** run x-positions come from the embedded face's advance widths (not the browser's substitute), so glyphs do not drift and the right margin is exact

#### Scenario: Justified line reaches the right margin

- **Given** a justified paragraph whose line is a single multi-word run
- **When** exported
- **Then** inter-word spacing is distributed so the last glyph reaches the content right edge (per-word draw, since the PDF word-spacing operator is ignored for embedded subset fonts)

#### Scenario: Right-tab / TOC anchor matches the painter decision

- **Given** a line that the painter flex-anchors to the right edge (TOC page-number pattern with a leader)
- **When** exported
- **Then** the exporter's anchor trigger predicate agrees with the painter's, the trailing content is placed at `lineRightEdge − followingWidth`, and the leader glyphs fill the gap

### Requirement: Fonts are embedded as subsets with a non-failing Unicode fallback

The exporter SHALL embed the correct Google **weight/style variant** per run (bold/italic are separate faces; there is no faux-bold), subsetted, cached per (family,weight,style), embedded sequentially into the document. When a face cannot be resolved or fetched, the exporter SHALL fall back to a bundled Unicode face, and only to a standard-14 base font when the run's text is WinAnsi-encodable. The export SHALL NOT throw or drop characters for non-Latin text.

#### Scenario: Bold-italic selects the matching variant

- **Given** a bold-italic run in a Google-mapped family
- **When** exported
- **Then** the PDF embeds the family's bold-italic face (not the regular face)

#### Scenario: A mapped font is embedded and subset

- **Given** a paragraph in a Google-mapped font
- **When** exported
- **Then** the PDF embeds a subset of that font (subset far smaller than the full face)

#### Scenario: Non-Latin text in an unmapped font does not crash

- **Given** a run of Cyrillic or CJK text in a family with no Google mapping
- **When** exported
- **Then** the run renders its glyphs via the bundled Unicode fallback and the export resolves successfully (no `WinAnsi cannot encode` throw, no dropped characters)

#### Scenario: A font fetch timeout does not block the export

- **Given** a font whose CDN fetch exceeds the per-font timeout
- **When** exported
- **Then** that run uses the fallback face and the overall export still resolves

### Requirement: Paragraph decoration, tabs, and lists render

The exporter SHALL render paragraph borders (per-side, the painter's between-paragraph grouping, and bar borders) and paragraph shading; tab stops of every alignment (left/center/decimal/end, plus bar tabs as vertical rules) with leaders (dot/hyphen/underscore); and list markers in their own font/size/color positioned in a suffix-sized slot, omitted when hidden.

#### Scenario: A boxed, shaded paragraph renders

- **Given** a paragraph with per-side borders and shading
- **When** exported
- **Then** the border lines and shading rectangle are drawn around/behind the paragraph, with adjacent identical-bordered paragraphs grouped as the painter groups them

#### Scenario: Decimal and bar tabs render

- **Given** a line with a decimal tab (aligning a number on its `.`) and a bar tab
- **When** exported
- **Then** the decimal-aligned content lands at the stop and the bar tab draws a vertical rule

#### Scenario: A list marker renders in its own style

- **Given** a list paragraph whose marker has its own font, size, and suffix
- **When** exported
- **Then** the marker is drawn in that font/size and body text aligns at the suffix stop
- **And** a hidden marker is omitted

### Requirement: Tables, images, headers/footers, and page chrome render

The exporter SHALL render tables (collapsed borders matching the painter's rule with border styles, cell shading, cell vertical alignment, cell margins, merged cells via gridSpan/vMerge, nested tables, header-row repetition, rows split across pages), images (JPEG/PNG embedded; GIF/BMP/WEBP/SVG re-encoded; EMF/WMF as placeholders without failing; crop/opacity/rotation/flip; deduped by source), headers/footers (default/first-page/even-odd as resolved by the adapter) with page-number and date/time field substitution, page borders, and page background.

#### Scenario: A table renders with collapsed borders and merges

- **Given** a table with cell borders, a shaded header row, a vertically-merged cell, and a horizontally-merged cell
- **When** exported
- **Then** shared edges draw a single (not double-thick) border, the header shading is drawn, and merged cells render as one spanning rectangle with content once

#### Scenario: A cell honors vertical alignment and a nested table

- **Given** a bottom-aligned cell and a cell containing a nested table
- **When** exported
- **Then** the cell content is offset to the bottom and the nested table renders inside the cell

#### Scenario: An unsupported image format does not crash the export

- **Given** a document containing an EMF (or WMF) image
- **When** exported
- **Then** a placeholder is drawn, a warning is surfaced, and the export still resolves; a GIF/BMP/WEBP/SVG image is re-encoded to PNG and embedded

#### Scenario: Header/footer variants and page numbers resolve

- **Given** a section with a different first-page header and even/odd headers, and a footer with a PAGE field across multiple pages
- **When** exported
- **Then** page 1, even pages, and odd pages each show the correct header variant
- **And** each footer shows that page's number (PAGE = page.number + pageNumberStart − 1; NUMPAGES = total page count)

#### Scenario: A date/time field resolves

- **Given** a header containing a DATE field
- **When** exported
- **Then** the field is substituted with the current date (matching the painter), and unmodeled fields fall back to their stored text

#### Scenario: Page borders and background render

- **Given** a section with page borders and a page background color
- **When** exported
- **Then** the page border is drawn (honoring offset-from and first-page/all-pages display) and the background fills the page

#### Scenario: An unsupported fragment kind fails the type check, not silently

- **Given** a new `FlowBlock`/fragment variant added without an exporter branch
- **When** the project type-checks
- **Then** the exporter's exhaustiveness guard makes `bun run typecheck` fail until the variant is handled

### Requirement: Export and print are available in both adapters

Both the React and Vue adapters SHALL expose an `exportPdf(): Promise<Blob>` ref method and a File ▸ Export ▸ (.docx / .pdf) menu entry, supplying the same resolved header/footer and page-chrome resources they pass to the painter. Printing SHALL generate the PDF and print it (rather than cloning painted DOM), so printed output matches the editor including theme colors and fonts. Behavior SHALL be equivalent across React and Vue and recorded as paired in the parity contract.

#### Scenario: Export to PDF from the menu downloads a PDF

- **Given** an open document in either adapter
- **When** the user chooses File ▸ Export ▸ PDF
- **Then** a `.pdf` file is downloaded whose pages match the document

#### Scenario: Export to Word from the menu downloads a DOCX

- **Given** an open document
- **When** the user chooses File ▸ Export ▸ Word Document
- **Then** the existing `.docx` save path runs and a `.docx` is downloaded

#### Scenario: Printing uses the generated PDF

- **Given** a document using theme colors and a non-system font
- **When** the user prints
- **Then** the print preview shows the generated PDF with the correct colors and font (no style loss from DOM cloning)

#### Scenario: React and Vue behave equivalently

- **Given** the same document loaded in React and in Vue
- **When** exported to PDF in each
- **Then** both produce equivalent PDFs and the `exportPdf` ref method exists in both, recorded as paired in the parity contract

### Requirement: Out-of-scope features degrade gracefully

Phase 1 SHALL NOT crash on documents using deferred features. Per-run RTL/bidi text renders in logical (LTR) order with paragraph-level `bidi` alignment honored; footnote/endnote reserved areas are left blank without disturbing body geometry; multi-column bodies place their already-column-positioned fragments and draw separators without re-flow; text boxes, shapes, run effects, and symbolic-font bullets render as plain content or are skipped.

#### Scenario: An RTL run does not crash and uses logical order

- **Given** a paragraph containing an Arabic or Hebrew run
- **When** exported
- **Then** the export succeeds, the run's glyphs are placed in logical order (visual reordering deferred), and a `bidi` paragraph uses right-default alignment

#### Scenario: A document with footnotes exports with body intact

- **Given** a page that reserves a footnote area
- **When** exported
- **Then** body text occupies the same region as on screen and the reserved footnote area is left blank
