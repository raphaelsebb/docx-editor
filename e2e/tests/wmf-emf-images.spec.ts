import { test, expect } from '@playwright/test';
import { EditorPage } from '../helpers/editor-page';

/**
 * WMF/EMF image support (#743, #755). Embedded WMF/EMF metafiles are rendered
 * to scalable SVG at load (via rtf.js), so they display crisply instead of a
 * broken/white box. The original metafile bytes are preserved for a lossless
 * save. A labeled placeholder is the fallback only when conversion isn't
 * possible (no DOM / decoder unavailable / render failure).
 */

// Percentage of non-white, opaque pixels in a rendered <img> — proves it
// actually drew content, not a blank box.
function nonWhitePct(page: import('@playwright/test').Page, selector: string) {
  return page.evaluate((sel) => {
    const img = document.querySelector(sel) as HTMLImageElement | null;
    if (!img || !img.naturalWidth) return -1;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nz = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 10 && (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240)) nz++;
    }
    return (100 * nz) / (c.width * c.height);
  }, selector);
}

const firstRunImgSrc = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      (document.querySelector('.layout-run-image') as HTMLImageElement | null)?.getAttribute(
        'src'
      ) ?? ''
  );

test('renders an embedded WMF image as crisp SVG, round-tripping the original (#743)', async ({
  page,
}) => {
  const editor = new EditorPage(page);
  await editor.goto();
  await editor.waitForReady();

  await page
    .locator('input[type="file"][accept=".docx"]')
    .setInputFiles('e2e/fixtures/wmf-test.docx');
  await page.waitForSelector('.layout-run-image', { timeout: 15000 });

  // WMF rendered to a scalable SVG for display (browsers can't decode WMF).
  await expect
    .poll(() => firstRunImgSrc(page), { timeout: 10000 })
    .toMatch(/^data:image\/(svg\+xml|png)/);
  // ...and real content was drawn (the "TEST WMF" artwork), not a blank box.
  await expect.poll(() => nonWhitePct(page, '.layout-run-image')).toBeGreaterThan(0.5);

  // Round-trip: saving keeps the ORIGINAL .wmf in word/media; the display SVG
  // is render-only and must not leak into the document.
  const mediaPaths = await page.evaluate(() =>
    (
      window as unknown as {
        __DOCX_EDITOR_E2E__: { savedMediaPaths: () => Promise<string[] | null> };
      }
    ).__DOCX_EDITOR_E2E__.savedMediaPaths()
  );
  expect(mediaPaths, 'saved media list').toBeTruthy();
  expect(mediaPaths!.some((p) => p.toLowerCase().endsWith('.wmf'))).toBe(true);
  expect(mediaPaths!.some((p) => /\.(png|svg)$/.test(p.toLowerCase()))).toBe(false);
});

test('renders both WMF and EMF, round-tripping the originals (#755)', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.goto();
  await editor.waitForReady();

  await page
    .locator('input[type="file"][accept=".docx"]')
    .setInputFiles('e2e/fixtures/wmf-emf-images.docx');
  await page.waitForSelector('[data-page-number]', { timeout: 15000 });
  await page.waitForTimeout(800);

  // Both the WMF and the EMF render as SVG images (rtf.js handles both); no
  // metafile placeholder is left behind.
  const imgs = page.locator('.layout-run-image');
  await expect.poll(() => imgs.count()).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < (await imgs.count()); i++) {
    await expect(imgs.nth(i)).toHaveAttribute('src', /^data:image\/(svg\+xml|png)/);
  }
  await expect(page.locator('.layout-image-metafile-placeholder')).toHaveCount(0);

  // Round-trip: both the original .wmf and .emf survive a save unchanged.
  const mediaPaths = await page.evaluate(() =>
    (
      window as unknown as {
        __DOCX_EDITOR_E2E__: { savedMediaPaths: () => Promise<string[] | null> };
      }
    ).__DOCX_EDITOR_E2E__.savedMediaPaths()
  );
  expect(mediaPaths!.some((p) => p.toLowerCase().endsWith('.wmf'))).toBe(true);
  expect(mediaPaths!.some((p) => p.toLowerCase().endsWith('.emf'))).toBe(true);
  expect(mediaPaths!.some((p) => /\.(png|svg)$/.test(p.toLowerCase()))).toBe(false);
});
