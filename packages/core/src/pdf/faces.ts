/**
 * Single recursive font-face collector for warm-up. Replaces the per-renderer
 * copies (paragraph/table/header-footer) so the Calibri default and bold/italic
 * extraction live in one place — and header/footer tables no longer drop
 * bold/italic the way the hand-rolled walker did.
 */

import type { FlowBlock } from '../layout-engine/types';

export interface FaceRef {
  family: string;
  bold?: boolean;
  italic?: boolean;
}

/** Every `(family, bold, italic)` face referenced by a block tree (recurses tables). */
export function collectFaces(blocks: FlowBlock[]): FaceRef[] {
  const out: FaceRef[] = [];
  const walk = (bs: FlowBlock[]): void => {
    for (const b of bs) {
      if (b.kind === 'paragraph') {
        for (const r of b.runs) {
          out.push({
            family: ('fontFamily' in r && r.fontFamily) || 'Calibri',
            bold: 'bold' in r ? r.bold : false,
            italic: 'italic' in r ? r.italic : false,
          });
        }
        if (b.attrs?.listMarker) out.push({ family: b.attrs.listMarkerFontFamily || 'Calibri' });
      } else if (b.kind === 'table') {
        for (const row of b.rows) for (const cell of row.cells) walk(cell.blocks);
      }
    }
  };
  walk(blocks);
  return out;
}
