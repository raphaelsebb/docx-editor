/**
 * Phase 0 font-embedding spike (browser leg) — the real go/no-go gate.
 *
 * Runs the exporter's font path inside a REAL Chromium page (CORS enforced):
 *   fetch Google CSS2 -> parse woff2 url -> fetch woff2 (CORS) -> @pdf-lib/fontkit
 *   decode woff2 in-browser -> embedFont({subset:true}) -> reload PDF.
 *
 * Loads pdf-lib + @pdf-lib/fontkit UMD from unpkg so we exercise the actual
 * browser builds, not the Node ones. Run: bun packages/core/scripts/pdf-font-spike/browser-spike.mjs
 */
import { chromium } from '@playwright/test';

const result = await (async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));

  // Real http origin so fetch CORS behaves like the live editor (not file://).
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js' });
  await page.addScriptTag({ url: 'https://unpkg.com/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.js' });

  const res = await page.evaluate(async () => {
    const out = {};
    try {
      const { PDFDocument } = window.PDFLib;
      const fontkit = window.fontkit;

      const css = await (
        await fetch('https://fonts.googleapis.com/css2?family=Roboto&display=swap')
      ).text();
      out.cssOk = /url\(https:\/\/[^)]+\.woff2\)/.test(css);
      const woff2Url = css.match(/url\((https:\/\/[^)]+\.woff2)\)/)[1];

      // The make-or-break: can the PAGE read the font bytes under CORS?
      const fontRes = await fetch(woff2Url);
      const woff2 = new Uint8Array(await fontRes.arrayBuffer());
      out.corsReadBytes = woff2.length;

      const pdf = await PDFDocument.create();
      pdf.registerFontkit(fontkit);
      // Pass raw woff2 straight in — tests in-browser woff2 decode + subset.
      const font = await pdf.embedFont(woff2, { subset: true });
      const pg = pdf.addPage([612, 792]);
      pg.drawText('Browser spike — Roboto 0123456789', { x: 72, y: 700, size: 18, font });
      const bytes = await pdf.save();
      out.pdfBytes = bytes.length;

      const reloaded = await PDFDocument.load(bytes);
      out.reloadPages = reloaded.getPageCount();
      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.error = String(e && e.stack ? e.stack : e);
    }
    return out;
  });

  await browser.close();
  return { res, logs };
})();

console.log('browser result:', JSON.stringify(result.res, null, 2));
if (result.logs.length) console.log('page logs:', result.logs.join('\n'));

const r = result.res;
const pass =
  r.ok && r.cssOk && r.corsReadBytes > 0 && r.pdfBytes > 0 && r.reloadPages === 1;
console.log(
  pass
    ? '\nSPIKE PASS (browser leg): CORS byte-read + in-browser woff2 decode + subset embed + reload — all OK'
    : '\nSPIKE FAIL (browser leg)'
);
process.exit(pass ? 0 : 1);
