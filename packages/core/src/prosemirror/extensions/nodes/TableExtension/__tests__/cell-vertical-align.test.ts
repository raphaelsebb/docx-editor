/**
 * Regression test for the inline-edit half of issue #468.
 *
 * The PM table cell spec's `toDOM` was emitting `vertical-align: <docx value>`
 * directly — but the DOCX value `"center"` is not a legal CSS `vertical-align`
 * keyword. Browsers silently ignored it and fell back to top, so cells with
 * `<w:vAlign w:val="center"/>` were center-aligned by the painter (which uses
 * flexbox) and top-aligned by the inline header/footer editor (which uses
 * native table cell layout). Mapping `center` → `middle` makes the inline
 * editor honor the spec value.
 */

import { describe, test, expect } from 'bun:test';
import { schema } from '../../../../schema';

function cellStyles(verticalAlign: 'top' | 'center' | 'bottom' | null): string {
  const cell = schema.nodes.tableCell.createAndFill(
    { verticalAlign },
    schema.node('paragraph', {}, [])
  );
  if (!cell) throw new Error('failed to build cell');
  const dom = cell.type.spec.toDOM!(cell) as [string, Record<string, string>, ...unknown[]];
  return (dom[1].style as string) ?? '';
}

describe('tableCell toDOM — vertical-align CSS mapping (#468)', () => {
  test('"center" maps to CSS "middle" so browsers honor it', () => {
    expect(cellStyles('center')).toContain('vertical-align: middle');
    expect(cellStyles('center')).not.toContain('vertical-align: center');
  });

  test('"top" and "bottom" pass through unchanged (legal CSS values)', () => {
    expect(cellStyles('top')).toContain('vertical-align: top');
    expect(cellStyles('bottom')).toContain('vertical-align: bottom');
  });

  test('unset verticalAlign emits no vertical-align style', () => {
    expect(cellStyles(null)).not.toContain('vertical-align');
  });
});
