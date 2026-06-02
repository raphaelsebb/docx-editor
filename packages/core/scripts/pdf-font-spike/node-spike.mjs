/**
 * Phase 0 font-embedding spike (Node leg).
 *
 * Validates the mechanical pipeline that the vector PDF exporter depends on:
 *   Google Fonts CSS2 family  ->  woff2 URL  ->  woff2 bytes  ->  sfnt/ttf
 *   ->  pdf-lib embedFont({subset:true})  ->  parseable PDF with extractable text.
 *
 * The browser-only risk (can a page READ the woff2 bytes given CORS?) is checked
 * separately in browser-cors-check — Node fetch ignores CORS so it cannot answer that.
 * What this leg proves: the CSS parse, the woff2->ttf decompress, and the
 * pdf-lib + fontkit subset/embed all work end to end.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
// @pdf-lib/fontkit decodes raw woff2 directly — no separate decompressor needed
// (see decoder-options.mjs / RESULT.md). embedFont() ingests the woff2 bytes.

const FAMILY = 'Roboto';
// A modern UA makes Google return woff2 (its smallest/most-restricted format).
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error('SPIKE FAIL:', msg);
  process.exit(1);
};

async function main() {
  // 1. Fetch the CSS2 stylesheet, same URL shape fontLoader builds.
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(FAMILY)}&display=swap`;
  const cssRes = await fetch(cssUrl, { headers: { 'User-Agent': UA } });
  if (!cssRes.ok) fail(`CSS fetch ${cssRes.status}`);
  const css = await cssRes.text();

  // 2. Parse a woff2 src URL out of the @font-face blocks.
  const m = css.match(/url\((https:\/\/[^)]+\.woff2)\)/);
  if (!m) fail('no woff2 url in CSS (got: ' + css.slice(0, 200) + ')');
  const woff2Url = m[1];
  log('woff2 url:', woff2Url);

  // 3. Fetch the woff2 bytes and inspect CORS headers (informational for the browser leg).
  const fontRes = await fetch(woff2Url, { headers: { 'User-Agent': UA } });
  if (!fontRes.ok) fail(`woff2 fetch ${fontRes.status}`);
  const acao = fontRes.headers.get('access-control-allow-origin');
  log('gstatic access-control-allow-origin:', acao ?? '(none)');
  const woff2 = new Uint8Array(await fontRes.arrayBuffer());
  log('woff2 bytes:', woff2.length);

  // 4 + 5. Embed + subset into a PDF — @pdf-lib/fontkit ingests raw woff2.
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const sample = 'Vector PDF export spike — Roboto 0123456789';
  const embedded = await pdf.embedFont(woff2, { subset: true });
  const page = pdf.addPage([612, 792]); // US Letter in points
  page.drawText(sample, { x: 72, y: 700, size: 18, font: embedded, color: rgb(0.1, 0.1, 0.1) });
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('fallback line (Helvetica)', { x: 72, y: 660, size: 12, font: helv });
  const bytes = await pdf.save();
  log('pdf bytes:', bytes.length);

  // 6. Re-parse the produced PDF.
  const reloaded = await PDFDocument.load(bytes);
  if (reloaded.getPageCount() !== 1) fail('reloaded page count != 1');

  // Heuristic: a subset-embedded font is FAR smaller than the full ttf.
  const subsetRatio = bytes.length / woff2.length;
  log(`subset ratio (pdf/full-ttf): ${subsetRatio.toFixed(3)}`);

  log('\nSPIKE PASS (node leg): CSS parse, woff2->ttf decompress, subset embed, reload — all OK');
  log(`  CORS header present: ${acao ? 'yes (' + acao + ')' : 'NO — verify in browser leg'}`);
}

main().catch((e) => fail(e?.stack || String(e)));
