import { describe, test, expect } from 'bun:test';
import { parseCssColor } from '../cssColor';

const near = (a: number, b: number) => Math.abs(a - b) < 0.004;

describe('pdf/cssColor', () => {
  test('6-digit hex', () => {
    const c = parseCssColor('#FF0000')!;
    expect(near(c.r, 1) && near(c.g, 0) && near(c.b, 0)).toBe(true);
    expect(c.alpha).toBe(1);
  });

  test('3-digit hex expands', () => {
    const c = parseCssColor('#0f0')!;
    expect(near(c.r, 0) && near(c.g, 1) && near(c.b, 0)).toBe(true);
  });

  test('8-digit hex carries alpha', () => {
    const c = parseCssColor('#00000080')!;
    expect(near(c.alpha, 128 / 255)).toBe(true);
  });

  test('rgb() and rgba()', () => {
    const c = parseCssColor('rgb(255, 128, 0)')!;
    expect(near(c.r, 1) && near(c.g, 128 / 255) && near(c.b, 0)).toBe(true);
    expect(parseCssColor('rgba(0,0,0,0.5)')!.alpha).toBeCloseTo(0.5, 5);
  });

  test('hsl() red', () => {
    const c = parseCssColor('hsl(0, 100%, 50%)')!;
    expect(near(c.r, 1) && near(c.g, 0) && near(c.b, 0)).toBe(true);
  });

  test('named colors incl. OOXML highlight names', () => {
    expect(near(parseCssColor('yellow')!.r, 1)).toBe(true);
    expect(near(parseCssColor('yellow')!.g, 1)).toBe(true);
    expect(near(parseCssColor('yellow')!.b, 0)).toBe(true);
    // darkBlue is an OOXML highlight name (00008B), not a CSS basic.
    expect(near(parseCssColor('darkBlue')!.b, 0x8b / 255)).toBe(true);
  });

  test('transparent / auto / junk → undefined (no fill, not black)', () => {
    expect(parseCssColor('transparent')).toBeUndefined();
    expect(parseCssColor('auto')).toBeUndefined();
    expect(parseCssColor('inherit')).toBeUndefined();
    expect(parseCssColor('')).toBeUndefined();
    expect(parseCssColor(undefined)).toBeUndefined();
    expect(parseCssColor('not-a-color')).toBeUndefined();
  });
});
