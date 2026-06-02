import { describe, test, expect } from 'bun:test';
import { StandardFonts } from 'pdf-lib';
import { selectStandard14, variantCss2Url, pickWoff2ForVariant } from '../fontProvider';

describe('pdf/fontProvider selection (pure)', () => {
  test('standard-14 by category + style', () => {
    expect(selectStandard14('sans-serif', {})).toBe(StandardFonts.Helvetica);
    expect(selectStandard14('sans-serif', { bold: true })).toBe(StandardFonts.HelveticaBold);
    expect(selectStandard14('serif', { italic: true })).toBe(StandardFonts.TimesRomanItalic);
    expect(selectStandard14('serif', { bold: true, italic: true })).toBe(
      StandardFonts.TimesRomanBoldItalic
    );
    expect(selectStandard14('monospace', { bold: true })).toBe(StandardFonts.CourierBold);
  });

  test('CSS2 url requests the matching ital,wght variant', () => {
    expect(variantCss2Url('Roboto', {})).toContain(':ital,wght@0,400');
    expect(variantCss2Url('Roboto', { bold: true })).toContain(':ital,wght@0,700');
    expect(variantCss2Url('Roboto', { italic: true })).toContain(':ital,wght@1,400');
    expect(variantCss2Url('Roboto', { bold: true, italic: true })).toContain(':ital,wght@1,700');
  });

  test('picks the woff2 from the matching @font-face block', () => {
    const css = `
      @font-face { font-style: normal; font-weight: 400; src: url(https://x/normal400.woff2) format('woff2'); }
      @font-face { font-style: italic; font-weight: 700; src: url(https://x/italic700.woff2) format('woff2'); }
    `;
    expect(pickWoff2ForVariant(css, {})).toBe('https://x/normal400.woff2');
    expect(pickWoff2ForVariant(css, { bold: true, italic: true })).toBe(
      'https://x/italic700.woff2'
    );
  });

  test('falls back to the first woff2 when no block matches', () => {
    const css = `@font-face { font-style: normal; font-weight: 400; src: url(https://x/only.woff2) format('woff2'); }`;
    expect(pickWoff2ForVariant(css, { bold: true })).toBe('https://x/only.woff2');
  });
});
