import { describe, test, expect } from 'bun:test';
import type { ParagraphBlock, MeasuredLine, Run } from '../../../layout-engine/types';
import { positionRunsInLine, effectiveRunText } from '../positionRuns';

// Deterministic measurer: every char is 10px wide at any size/font.
const measure = (_run: Run, text: string) => text.length * 10;

function para(runs: Run[]): ParagraphBlock {
  return { kind: 'paragraph', id: 0 as never, runs };
}
function line(runs: Run[]): MeasuredLine {
  return {
    fromRun: 0,
    fromChar: 0,
    toRun: runs.length - 1,
    toChar: lastLen(runs),
    width: 0,
    ascent: 12,
    descent: 4,
    lineHeight: 16,
  };
}
function lastLen(runs: Run[]): number {
  const last = runs[runs.length - 1];
  return last && last.kind === 'text' ? last.text.length : 0;
}
const text = (t: string, extra: Partial<Run> = {}): Run =>
  ({ kind: 'text', text: t, ...extra }) as Run;

const baseOpts = {
  availableWidth: 500,
  isFirstLine: true,
  isLastLine: true,
  paragraphEndsWithLineBreak: false,
  measureText: measure,
};

describe('positionRunsInLine', () => {
  test('left-aligned runs flow from the left indent', () => {
    const runs = [text('ab'), text('cd')];
    const { runs: pos } = positionRunsInLine(para(runs), line(runs), 'left', {
      ...baseOpts,
      leftIndentPx: 20,
    });
    expect(pos[0].x).toBe(20);
    expect(pos[0].width).toBe(20);
    expect(pos[1].x).toBe(40);
  });

  test('first-line indent offsets the first line', () => {
    const runs = [text('ab')];
    const { runs: pos } = positionRunsInLine(para(runs), line(runs), 'left', {
      ...baseOpts,
      leftIndentPx: 10,
      firstLineIndentPx: 15,
    });
    expect(pos[0].x).toBe(25);
  });

  test('right alignment pushes content to the right edge', () => {
    const runs = [text('abcd')]; // width 40
    const { runs: pos } = positionRunsInLine(para(runs), line(runs), 'right', {
      ...baseOpts,
      availableWidth: 100,
    });
    expect(pos[0].x).toBeCloseTo(60, 6); // 100 - 40
  });

  test('center alignment splits the slack', () => {
    const runs = [text('abcd')]; // width 40
    const { runs: pos } = positionRunsInLine(para(runs), line(runs), 'center', {
      ...baseOpts,
      availableWidth: 100,
    });
    expect(pos[0].x).toBeCloseTo(30, 6); // (100 - 40)/2
  });

  test('allCaps transforms the drawn text and its width', () => {
    const runs = [text('ab', { allCaps: true })];
    expect(effectiveRunText(runs[0])).toBe('AB');
    const { runs: pos } = positionRunsInLine(para(runs), line(runs), 'left', baseOpts);
    expect(pos[0].text).toBe('AB');
  });

  test('letterSpacing widens the run advance', () => {
    const runs = [text('abc', { letterSpacing: 2 })]; // 30 + 3*2
    const { runs: pos } = positionRunsInLine(para(runs), line(runs), 'left', baseOpts);
    expect(pos[0].width).toBeCloseTo(36, 6);
  });

  test('horizontalScale scales the advance', () => {
    const runs = [text('ab', { horizontalScale: 50 })]; // 20 * 0.5
    const { runs: pos } = positionRunsInLine(para(runs), line(runs), 'left', baseOpts);
    expect(pos[0].width).toBeCloseTo(10, 6);
  });

  test('hidden runs are skipped', () => {
    const runs = [text('vis'), text('secret', { hidden: true } as Partial<Run>)];
    const { runs: pos } = positionRunsInLine(para(runs), line(runs), 'left', baseOpts);
    expect(pos).toHaveLength(1);
    expect(pos[0].text).toBe('vis');
  });

  test('justify distributes slack across inter-word gaps (incl. intra-run spaces)', () => {
    // One run with two internal spaces; availableWidth gives slack.
    const runs = [text('a b c')]; // width 50, 2 spaces
    const result = positionRunsInLine(para(runs), line(runs), 'justify', {
      ...baseOpts,
      isLastLine: false,
      availableWidth: 70,
    });
    // slack 20 over 2 gaps → run widened by 20, per-gap = 10px.
    expect(result.runs[0].width).toBeCloseTo(70, 6);
    expect(result.wordSpacingPx).toBeCloseTo(10, 6);
  });

  test('last justified line is not stretched (no word spacing)', () => {
    const runs = [text('a b')];
    const result = positionRunsInLine(para(runs), line(runs), 'justify', {
      ...baseOpts,
      isLastLine: true,
      availableWidth: 70,
    });
    expect(result.runs[0].width).toBeCloseTo(30, 6); // unchanged
    expect(result.wordSpacingPx).toBe(0);
  });
});
