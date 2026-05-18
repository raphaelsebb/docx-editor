/**
 * ProseMirror NodeSpecs for table / row / cell / header.
 *
 * Each spec is declarative — attr declarations + parseDOM rules + toDOM
 * recipes. The CSS-style builder helpers in this file (cell border, padding,
 * width, text-direction) are used by toDOM for cell and header.
 */

import type { NodeSpec } from 'prosemirror-model';
import type { TableAttrs, TableRowAttrs, TableCellAttrs } from '../../../schema/nodes';
import type { ColorValue } from '../../../../types/colors';
import { resolveColor } from '../../../../utils/colorResolver';
import { parseCellAttrsFromDOM } from './paste';

export const tableSpec: NodeSpec = {
  content: 'tableRow+',
  group: 'block',
  tableRole: 'table',
  isolating: true,
  attrs: {
    styleId: { default: null },
    width: { default: null },
    widthType: { default: null },
    justification: { default: null },
    columnWidths: { default: null },
    floating: { default: null },
    cellMargins: { default: null },
    look: { default: null },
    _originalFormatting: { default: null },
  },
  parseDOM: [
    {
      tag: 'table',
      getAttrs(dom): TableAttrs {
        const element = dom as HTMLTableElement;
        return {
          styleId: element.dataset.styleId || undefined,
          justification: element.dataset.justification as TableAttrs['justification'] | undefined,
        };
      },
    },
  ],
  toDOM(node) {
    const attrs = node.attrs as TableAttrs;
    const domAttrs: Record<string, string> = { class: 'docx-table' };

    if (attrs.styleId) {
      domAttrs['data-style-id'] = attrs.styleId;
    }

    const styles: string[] = ['border-collapse: collapse'];

    if (attrs.width && attrs.widthType === 'pct') {
      styles.push(`width: ${attrs.width / 50}%`);
      styles.push('table-layout: fixed');
    } else if (attrs.width && attrs.widthType === 'dxa') {
      const widthPx = Math.round((attrs.width / 20) * 1.333);
      styles.push(`width: ${widthPx}px`);
      styles.push('table-layout: fixed');
    } else {
      // Default: fill available width so tables aren't collapsed to content
      styles.push('width: 100%');
      styles.push('table-layout: fixed');
    }

    if (attrs.justification === 'center') {
      styles.push('margin-left: auto', 'margin-right: auto');
    } else if (attrs.justification === 'right') {
      styles.push('margin-left: auto');
    }
    domAttrs.style = styles.join('; ');

    return ['table', domAttrs, ['tbody', 0]];
  },
};

export const tableRowSpec: NodeSpec = {
  content: '(tableCell | tableHeader)+',
  tableRole: 'row',
  attrs: {
    height: { default: null },
    heightRule: { default: null },
    isHeader: { default: false },
    _originalFormatting: { default: null },
  },
  parseDOM: [{ tag: 'tr' }],
  toDOM(node) {
    const attrs = node.attrs as TableRowAttrs;
    const domAttrs: Record<string, string> = {};

    if (attrs.height) {
      const heightPx = Math.round((attrs.height / 20) * 1.333);
      domAttrs.style = `height: ${heightPx}px`;
    }

    return ['tr', domAttrs, 0];
  },
};

// OOXML border style → CSS border-style mapping
const BORDER_STYLE_CSS: Record<string, string> = {
  single: 'solid',
  double: 'double',
  dotted: 'dotted',
  dashed: 'dashed',
  thick: 'solid',
  dashSmallGap: 'dashed',
  dotDash: 'dashed',
  dotDotDash: 'dotted',
  triple: 'double',
  thinThickSmallGap: 'double',
  thickThinSmallGap: 'double',
  thinThickThinSmallGap: 'double',
  thinThickMediumGap: 'double',
  thickThinMediumGap: 'double',
  thinThickThinMediumGap: 'double',
  thinThickLargeGap: 'double',
  thickThinLargeGap: 'double',
  thinThickThinLargeGap: 'double',
  wave: 'solid',
  doubleWave: 'double',
  dashDotStroked: 'dashed',
  threeDEmboss: 'ridge',
  threeDEngrave: 'groove',
  outset: 'outset',
  inset: 'inset',
};

// Helper for cell border rendering — works with full BorderSpec objects
function buildCellBorderStyles(attrs: TableCellAttrs): string[] {
  const styles: string[] = [];
  const borders = attrs.borders;

  if (!borders) return styles;

  const borderToCss = (border?: { style?: string; size?: number; color?: ColorValue }): string => {
    if (!border || !border.style || border.style === 'none' || border.style === 'nil') {
      return 'none';
    }
    const widthPx = border.size ? Math.max(1, Math.round((border.size / 8) * 1.333)) : 1;
    const cssStyle = BORDER_STYLE_CSS[border.style] || 'solid';
    const color = resolveColor(border.color, undefined);
    return `${widthPx}px ${cssStyle} ${color}`;
  };

  styles.push(`border-top: ${borderToCss(borders.top)}`);
  styles.push(`border-bottom: ${borderToCss(borders.bottom)}`);
  styles.push(`border-left: ${borderToCss(borders.left)}`);
  styles.push(`border-right: ${borderToCss(borders.right)}`);

  return styles;
}

// Convert cell margins (twips) to CSS padding
function buildCellPaddingStyles(attrs: TableCellAttrs): string[] {
  const margins = attrs.margins;
  // Word default cell margins: 108 twips (top/bottom), 108 twips (left/right)
  if (!margins) {
    const px = Math.round((108 / 20) * 1.333);
    return [`padding: ${px}px ${px}px`];
  }

  const toPixels = (twips?: number) => (twips ? Math.round((twips / 20) * 1.333) : 0);
  const top = toPixels(margins.top);
  const right = toPixels(margins.right);
  const bottom = toPixels(margins.bottom);
  const left = toPixels(margins.left);

  return [`padding: ${top}px ${right}px ${bottom}px ${left}px`];
}

// OOXML text direction → CSS writing-mode + direction
function buildTextDirectionStyles(textDirection?: string): string[] {
  if (!textDirection) return [];
  const styles: string[] = [];

  switch (textDirection) {
    case 'tbRl':
    case 'tbRlV':
      styles.push('writing-mode: vertical-rl');
      break;
    case 'btLr':
      styles.push('writing-mode: vertical-lr', 'transform: rotate(180deg)');
      break;
    case 'rl':
    case 'rlV':
      styles.push('direction: rtl');
      break;
    case 'tb':
    case 'tbV':
      styles.push('writing-mode: vertical-lr');
      break;
    // 'lr', 'lrV' are the default left-to-right, no extra styles needed
  }

  return styles;
}

function buildCellWidthStyles(attrs: TableCellAttrs): string[] {
  const styles: string[] = [];

  if (attrs.colwidth && attrs.colwidth.length > 0) {
    const totalWidth = attrs.colwidth.reduce((sum, w) => sum + w, 0);
    styles.push(`width: ${totalWidth}px`);
  } else if (attrs.width && attrs.widthType === 'pct') {
    styles.push(`width: ${attrs.width}%`);
  } else if (attrs.width) {
    const widthPx = Math.round((attrs.width / 20) * 1.333);
    styles.push(`width: ${widthPx}px`);
  }

  return styles;
}

export const tableCellSpec: NodeSpec = {
  content: '(paragraph | table)+',
  tableRole: 'cell',
  isolating: true,
  attrs: {
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
    width: { default: null },
    widthType: { default: null },
    verticalAlign: { default: null },
    backgroundColor: { default: null },
    borders: { default: null },
    margins: { default: null },
    textDirection: { default: null },
    noWrap: { default: false },
    _originalFormatting: { default: null },
    _originalResolvedFill: { default: null },
  },
  parseDOM: [
    {
      tag: 'td',
      getAttrs: (dom) => parseCellAttrsFromDOM(dom as HTMLTableCellElement),
    },
  ],
  toDOM(node) {
    const attrs = node.attrs as TableCellAttrs;
    const domAttrs: Record<string, string> = { class: 'docx-table-cell' };

    if (attrs.colspan > 1) domAttrs.colspan = String(attrs.colspan);
    if (attrs.rowspan > 1) domAttrs.rowspan = String(attrs.rowspan);

    const styles: string[] = [];
    styles.push(...buildCellPaddingStyles(attrs));

    if (attrs.noWrap) {
      styles.push('white-space: nowrap');
    } else {
      styles.push('word-wrap: break-word', 'overflow-wrap: break-word', 'overflow: hidden');
    }

    styles.push(...buildCellWidthStyles(attrs));
    styles.push(...buildCellBorderStyles(attrs));
    styles.push(...buildTextDirectionStyles(attrs.textDirection));

    if (attrs.verticalAlign) {
      domAttrs['data-valign'] = attrs.verticalAlign;
      styles.push(`vertical-align: ${attrs.verticalAlign}`);
    }
    if (attrs.backgroundColor) {
      domAttrs['data-bgcolor'] = attrs.backgroundColor;
      styles.push(`background-color: #${attrs.backgroundColor}`);
    }
    domAttrs.style = styles.join('; ');

    return ['td', domAttrs, 0];
  },
};

export const tableHeaderSpec: NodeSpec = {
  content: '(paragraph | table)+',
  tableRole: 'header_cell',
  isolating: true,
  attrs: {
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
    width: { default: null },
    widthType: { default: null },
    verticalAlign: { default: null },
    backgroundColor: { default: null },
    borders: { default: null },
    margins: { default: null },
    textDirection: { default: null },
    noWrap: { default: false },
    _originalFormatting: { default: null },
    _originalResolvedFill: { default: null },
  },
  parseDOM: [
    {
      tag: 'th',
      getAttrs: (dom) => parseCellAttrsFromDOM(dom as HTMLTableCellElement),
    },
  ],
  toDOM(node) {
    const attrs = node.attrs as TableCellAttrs;
    const domAttrs: Record<string, string> = { class: 'docx-table-header' };

    if (attrs.colspan > 1) domAttrs.colspan = String(attrs.colspan);
    if (attrs.rowspan > 1) domAttrs.rowspan = String(attrs.rowspan);

    const styles: string[] = ['font-weight: bold'];
    styles.push(...buildCellPaddingStyles(attrs));

    if (attrs.noWrap) {
      styles.push('white-space: nowrap');
    } else {
      styles.push('word-wrap: break-word', 'overflow-wrap: break-word', 'overflow: hidden');
    }

    styles.push(...buildCellWidthStyles(attrs));
    styles.push(...buildCellBorderStyles(attrs));
    styles.push(...buildTextDirectionStyles(attrs.textDirection));

    if (attrs.verticalAlign) {
      domAttrs['data-valign'] = attrs.verticalAlign;
      styles.push(`vertical-align: ${attrs.verticalAlign}`);
    }

    if (attrs.backgroundColor) {
      domAttrs['data-bgcolor'] = attrs.backgroundColor;
      styles.push(`background-color: #${attrs.backgroundColor}`);
    }

    domAttrs.style = styles.join('; ');

    return ['th', domAttrs, 0];
  },
};
