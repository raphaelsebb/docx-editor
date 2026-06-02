import { describe, test, expect } from 'bun:test';
import { pxToPt, PT_PER_PX, baselineFromTop, pageYToPt, textBaselinePt } from '../coords';

describe('pdf/coords', () => {
  test('px→pt uses 72/96', () => {
    expect(PT_PER_PX).toBeCloseTo(0.75, 10);
    expect(pxToPt(96)).toBeCloseTo(72, 10); // 1 inch
    expect(pxToPt(0)).toBe(0);
  });

  test('baseline sits one ascent below the box top for a tight line', () => {
    // No leading: lineHeight == ascent+descent → baseline == ascent.
    expect(baselineFromTop({ ascent: 12, descent: 4, lineHeight: 16 })).toBeCloseTo(12, 10);
  });

  test('extra leading is split above and below (atLeast/exact line rule)', () => {
    // lineHeight 24, ascent 12, descent 4 → leading 8 → baseline 4+12 = 16.
    expect(baselineFromTop({ ascent: 12, descent: 4, lineHeight: 24 })).toBeCloseTo(16, 10);
  });

  test('page Y flips to bottom-left origin', () => {
    // 100px from top on a 1000px page → 900px from bottom → pt.
    expect(pageYToPt(100, 1000)).toBeCloseTo(pxToPt(900), 10);
    expect(pageYToPt(0, 1000)).toBeCloseTo(pxToPt(1000), 10);
  });

  test('text baseline combines line top, baseline offset, and shift', () => {
    const line = { ascent: 12, descent: 4, lineHeight: 16 };
    // lineTop 100, baselineFromTop 12 → baselinePx 112 → flipped on 1000px page.
    expect(textBaselinePt(100, line, 1000)).toBeCloseTo(pxToPt(1000 - 112), 10);
    // a +5px superscript shift raises the baseline (smaller px-from-top → larger pt).
    expect(textBaselinePt(100, line, 1000, 5)).toBeCloseTo(pxToPt(1000 - 107), 10);
  });
});
