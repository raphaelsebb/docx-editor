import { test, expect } from '@playwright/test';

/**
 * Vue counterpart of WMF/EMF image support (#743, #755). Conversion (rtf.js →
 * SVG), display, and round-trip preservation all live in core, so Vue must
 * behave exactly like React: WMF and EMF render as crisp SVG, and a save keeps
 * the original metafile bytes.
 */

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

async function loadFixture(page: import('@playwright/test').Page, fixture: string) {
  await page.goto('http://localhost:5174/?e2e=1');
  await page.locator('.docx-editor-vue').waitFor();
  await page.locator('.paged-editor__pages').waitFor();
  await page.waitForSelector('[data-page-number]', { timeout: 15000 });
  await page.locator('input[type="file"][accept=".docx"]').setInputFiles(fixture);
}

test('Vue: renders WMF as crisp SVG, round-tripping the original (#743)', async ({ page }) => {
  await loadFixture(page, 'e2e/fixtures/wmf-test.docx');

  await expect
    .poll(() => firstRunImgSrc(page), { timeout: 20000 })
    .toMatch(/^data:image\/(svg\+xml|png)/);
  await expect.poll(() => nonWhitePct(page, '.layout-run-image')).toBeGreaterThan(0.5);

  const mediaPaths = await page.evaluate(() =>
    (
      window as unknown as {
        __DOCX_EDITOR_E2E__: { savedMediaPaths: () => Promise<string[] | null> };
      }
    ).__DOCX_EDITOR_E2E__.savedMediaPaths()
  );
  expect(mediaPaths!.some((p) => p.toLowerCase().endsWith('.wmf'))).toBe(true);
  expect(mediaPaths!.some((p) => /\.(png|svg)$/.test(p.toLowerCase()))).toBe(false);
});

test('Vue: renders both WMF and EMF (#755)', async ({ page }) => {
  await loadFixture(page, 'e2e/fixtures/wmf-emf-images.docx');

  await expect
    .poll(() => firstRunImgSrc(page), { timeout: 20000 })
    .toMatch(/^data:image\/(svg\+xml|png)/);
  const imgs = page.locator('.layout-run-image');
  await expect.poll(() => imgs.count()).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < (await imgs.count()); i++) {
    await expect(imgs.nth(i)).toHaveAttribute('src', /^data:image\/(svg\+xml|png)/);
  }
  await expect(page.locator('.layout-image-metafile-placeholder')).toHaveCount(0);
});
