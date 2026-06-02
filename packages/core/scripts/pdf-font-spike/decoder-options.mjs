/**
 * Which woff2-decode path do we actually need in the BROWSER exporter?
 * Tests, in order of preference (simplest wins):
 *   A. Does @pdf-lib/fontkit ingest raw woff2 directly? (zero extra dep)
 *   B. Does full `fontkit` decode woff2 (pure-JS brotli)? (browser-friendly)
 *   C. wawoff2 decompress (known-good in Node, emscripten in browser).
 */
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function getWoff2() {
  const css = await (
    await fetch('https://fonts.googleapis.com/css2?family=Roboto&display=swap', {
      headers: { 'User-Agent': UA },
    })
  ).text();
  const url = css.match(/url\((https:\/\/[^)]+\.woff2)\)/)[1];
  return new Uint8Array(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
}

const woff2 = await getWoff2();
console.log('woff2 bytes:', woff2.length);

// A. raw woff2 -> pdf-lib embedFont
try {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  await pdf.embedFont(woff2, { subset: true });
  console.log('A. @pdf-lib/fontkit ingests raw woff2: YES  <-- simplest, no decoder dep');
} catch (e) {
  console.log('A. @pdf-lib/fontkit raw woff2: NO  (' + (e?.message?.split('\n')[0] || e) + ')');
}

// B. full fontkit decode woff2 -> sfnt
try {
  const fk = (await import('fontkit')).default ?? (await import('fontkit'));
  const font = fk.create(Buffer.from(woff2));
  // fontkit exposes a stream/_decompress path; if it parsed, glyphs are reachable.
  const hasGlyphs = typeof font.glyphForCodePoint === 'function';
  console.log('B. full fontkit parses woff2:', hasGlyphs ? 'YES' : 'partial');
} catch (e) {
  console.log('B. full fontkit woff2: NO/absent  (' + (e?.message?.split('\n')[0] || e) + ')');
}
