# Phase 0 font-embedding spike — VERDICT: **GO**

Date: 2026-06-02

## Question

Can we turn a Google Fonts family name into subset glyph bytes embedded in a
pdf-lib PDF, in-browser, with CORS enforced? (The make-or-break for vector PDF export.)

## Result: yes, all exit criteria pass

| Check                              | Node leg       | Browser leg (Chromium) |
| ---------------------------------- | -------------- | ---------------------- |
| Fetch Google CSS2, parse woff2 url | ✅             | ✅                     |
| Fetch woff2 bytes (CORS readable)  | ✅ ACAO `*`    | ✅ 12228 bytes read    |
| woff2 → glyphs decode              | ✅             | ✅ (in-browser)        |
| `embedFont(woff2, {subset:true})`  | ✅ ratio 0.077 | ✅                     |
| Re-parse produced PDF              | ✅ 1 page      | ✅ 1 page              |

## Key simplification vs the plan

`@pdf-lib/fontkit` **ingests raw woff2 directly** — it decodes woff2 internally.
We do **not** need a separate woff2 decompressor (`wawoff2`/brotli-wasm) in the
browser bundle. Dependencies for the exporter are just:

- `pdf-lib`
- `@pdf-lib/fontkit`

Both are pure-JS, browser-first, ESM-friendly. They must be **dynamically imported**
(only on export/print) to keep them out of the editor's hot path / main bundle.

## Caveat — what the spike did NOT prove

It validated only the single **400-normal** face (`?family=Roboto&display=swap`, first woff2 url).
It did NOT exercise:

- **Per-(weight,style) variant selection** — bold/italic are separate faces; the real provider must
  request `ital,wght@…` and embed the matching `@font-face` block. pdf-lib has no faux-bold.
- **Non-Latin fallback** — standard-14 fonts are WinAnsi and `drawText` throws on CJK/Cyrillic; the
  terminal fallback must be a **bundled Unicode face**, not standard-14.
  These are tracked as Phase-1 font tasks (3.3/3.4), not open feasibility risks.

## Fallback chain

Embedded Google woff2 subset → standard-14 PDF base font by `fontResolver` category
(Helvetica/Times/Courier) → Helvetica. Layout stays correct regardless because the
exporter positions every run explicitly via `positionRunsInLine`; only glyph shapes
change under fallback.

## Repro

- `bun packages/core/scripts/pdf-font-spike/node-spike.mjs`
- `bun packages/core/scripts/pdf-font-spike/browser-spike.mjs`
- `bun packages/core/scripts/pdf-font-spike/decoder-options.mjs` (shows path A wins)

Spike scripts are throwaway (not shipped in the package build).
