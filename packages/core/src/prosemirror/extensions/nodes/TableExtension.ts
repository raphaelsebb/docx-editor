/**
 * Table Extension — 4 node specs + plugins + commands
 *
 * Uses separate NodeExtension instances for each table node type,
 * plus an Extension for plugins and commands.
 *
 * NodeSpecs (declarative attrs + parseDOM + toDOM), the CSS paste helpers
 * shared by td/th, and the table-context query / cell-navigation helpers
 * live under ./TableExtension/{specs,paste,context}.ts. The plugin
 * extension itself (32 commands, 3 PM plugins) stays inline below — its
 * `onSchemaReady` closure captures the schema reference and would need a
 * larger refactor to split safely.
 */

import {
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
  type EditorState,
  type Command,
} from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import {
  columnResizing,
  tableEditing,
  mergeCells as pmMergeCells,
  splitCell as pmSplitCell,
  CellSelection,
} from 'prosemirror-tables';
import { createNodeExtension, createExtension } from '../create';
import type { ExtensionContext, ExtensionRuntime, AnyExtension } from '../types';
import { tableSpec, tableRowSpec, tableCellSpec, tableHeaderSpec } from './TableExtension/specs';
import {
  getTableContext,
  isInTableCell,
  goToNextCell,
  goToPrevCell,
} from './TableExtension/context';

export type { TableContextInfo } from './TableExtension/context';

// ============================================================================
// NODE EXTENSIONS (4 separate ones for schema contribution)
// ============================================================================

export const TableNodeExtension = createNodeExtension({
  name: 'table',
  schemaNodeName: 'table',
  nodeSpec: tableSpec,
});

export const TableRowExtension = createNodeExtension({
  name: 'tableRow',
  schemaNodeName: 'tableRow',
  nodeSpec: tableRowSpec,
});

export const TableCellExtension = createNodeExtension({
  name: 'tableCell',
  schemaNodeName: 'tableCell',
  nodeSpec: tableCellSpec,
});

export const TableHeaderExtension = createNodeExtension({
  name: 'tableHeader',
  schemaNodeName: 'tableHeader',
  nodeSpec: tableHeaderSpec,
});

// ============================================================================
// TABLE PLUGIN/COMMANDS EXTENSION
// ============================================================================
//
// TODO(file-size-cap): the onSchemaReady closure below is ~1650 LOC of
// commands that all capture `schema` from the closure scope. Splitting it
// requires converting each command to a factory that takes `schema` as a
// parameter — a non-trivial behavior-preserving refactor. Tracked as the
// last over-cap file in packages/core/src.

export type BorderPreset = 'all' | 'outside' | 'inside' | 'none';

export const TablePluginExtension = createExtension({
  name: 'tablePlugin',
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const { schema } = ctx;

    // ---- Commands ----

    function chainCommands(...commands: Command[]): Command {
      return (state, dispatch, view) => {
        for (const cmd of commands) {
          if (cmd(state, dispatch, view)) {
            return true;
          }
        }
        return false;
      };
    }

    function buildCellAttrsFromTemplate(
      templateCell: PMNode | null,
      overrides: Record<string, unknown> = {}
    ): Record<string, unknown> {
      const baseAttrs = templateCell?.attrs ?? {};
      return {
        colspan: baseAttrs.colspan || 1,
        rowspan: 1,
        colwidth: baseAttrs.colwidth,
        width: baseAttrs.width,
        widthType: baseAttrs.widthType,
        verticalAlign: baseAttrs.verticalAlign,
        backgroundColor: baseAttrs.backgroundColor,
        borders: baseAttrs.borders,
        margins: baseAttrs.margins,
        textDirection: baseAttrs.textDirection,
        noWrap: baseAttrs.noWrap,
        ...overrides,
      };
    }

    function createTable(
      rows: number,
      cols: number,
      borderColor: string = '000000',
      contentWidthTwips: number = 9360
    ): PMNode {
      const tableRows: PMNode[] = [];
      const colWidthTwips = Math.floor(contentWidthTwips / cols);
      const defaultRowHeightTwips = 360; // 0.25in ≈ 24px at 96 DPI
      const defaultRowHeightRule = 'atLeast';

      const defaultBorder = { style: 'single', size: 4, color: { rgb: borderColor } };
      const defaultBorders = {
        top: defaultBorder,
        bottom: defaultBorder,
        left: defaultBorder,
        right: defaultBorder,
      };

      for (let r = 0; r < rows; r++) {
        const cells: PMNode[] = [];
        for (let c = 0; c < cols; c++) {
          const paragraph = schema.nodes.paragraph.create();
          const cellAttrs: Record<string, unknown> = {
            colspan: 1,
            rowspan: 1,
            borders: defaultBorders,
            width: colWidthTwips,
            widthType: 'dxa',
          };
          cells.push(schema.nodes.tableCell.create(cellAttrs, paragraph));
        }
        tableRows.push(
          schema.nodes.tableRow.create(
            { height: defaultRowHeightTwips, heightRule: defaultRowHeightRule },
            cells
          )
        );
      }

      const columnWidths = Array(cols).fill(colWidthTwips);
      return schema.nodes.table.create(
        {
          columnWidths,
          width: contentWidthTwips,
          widthType: 'dxa',
        },
        tableRows
      );
    }

    function insertTable(rows: number, cols: number): Command {
      return (state, dispatch) => {
        const { $from } = state.selection;

        let borderColor = '000000';
        const marks = state.storedMarks || $from.marks();
        for (const mark of marks) {
          if (mark.type.name === 'textColor' && mark.attrs.rgb) {
            borderColor = mark.attrs.rgb;
            break;
          }
        }

        let insertPos = $from.pos;

        // Find the right insertion point: after the current block-level node.
        // When inside a table cell, we insert within the cell (enabling nested tables)
        // rather than after the parent table.
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type.name === 'paragraph' || node.type.name === 'table') {
            insertPos = $from.after(d);
            break;
          }
        }

        if (dispatch) {
          // When inserting inside a table cell, size the new table to fit the cell
          let contentWidthTwips = 9360; // default: full page width
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
              const cellWidth = node.attrs.width as number | undefined;
              if (cellWidth && cellWidth > 0) {
                // Subtract cell padding (~216 twips = 108 left + 108 right)
                contentWidthTwips = Math.max(cellWidth - 216, 360);
              }
              break;
            }
          }
          const table = createTable(rows, cols, borderColor, contentWidthTwips);
          const emptyParagraph = schema.nodes.paragraph.create();

          const $insert = state.doc.resolve(insertPos);
          const needsLeadingParagraph = $insert.nodeBefore?.type.name === 'table';
          const insertContent = needsLeadingParagraph
            ? [emptyParagraph, table, emptyParagraph]
            : [table, emptyParagraph];

          const tr = state.tr.insert(insertPos, insertContent);

          let tableStartPos = insertPos + 1;
          if (needsLeadingParagraph) {
            tableStartPos += emptyParagraph.nodeSize;
          }

          const firstCellPos = tableStartPos + 1;
          const firstCellContentPos = firstCellPos + 1;
          tr.setSelection(TextSelection.create(tr.doc, firstCellContentPos));
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function addRowAbove(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (
        !context.isInTable ||
        context.rowIndex === undefined ||
        !context.table ||
        context.tablePos === undefined
      )
        return false;

      if (dispatch) {
        const tr = state.tr;
        const rowNode = context.table.child(context.rowIndex);
        const cells: PMNode[] = [];
        rowNode.forEach((cell) => {
          const paragraph = schema.nodes.paragraph.create();
          const cellAttrs = buildCellAttrsFromTemplate(cell);
          cells.push(schema.nodes.tableCell.create(cellAttrs, paragraph));
        });
        const newRow = schema.nodes.tableRow.create(
          {
            height: rowNode.attrs.height ?? 360,
            heightRule: rowNode.attrs.heightRule ?? 'atLeast',
          },
          cells
        );

        let rowPos = context.tablePos + 1;
        for (let i = 0; i < context.rowIndex; i++) {
          rowPos += context.table.child(i).nodeSize;
        }

        tr.insert(rowPos, newRow);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    function addRowBelow(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (
        !context.isInTable ||
        context.rowIndex === undefined ||
        !context.table ||
        context.tablePos === undefined
      )
        return false;

      if (dispatch) {
        const tr = state.tr;
        const rowNode = context.table.child(context.rowIndex);
        const cells: PMNode[] = [];
        rowNode.forEach((cell) => {
          const paragraph = schema.nodes.paragraph.create();
          const cellAttrs = buildCellAttrsFromTemplate(cell);
          cells.push(schema.nodes.tableCell.create(cellAttrs, paragraph));
        });
        const newRow = schema.nodes.tableRow.create(
          {
            height: rowNode.attrs.height ?? 360,
            heightRule: rowNode.attrs.heightRule ?? 'atLeast',
          },
          cells
        );

        let rowPos = context.tablePos + 1;
        for (let i = 0; i <= context.rowIndex; i++) {
          rowPos += context.table.child(i).nodeSize;
        }

        tr.insert(rowPos, newRow);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    function deleteRow(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (
        !context.isInTable ||
        context.rowIndex === undefined ||
        !context.table ||
        context.tablePos === undefined ||
        (context.rowCount || 0) <= 1
      )
        return false;

      if (dispatch) {
        const tr = state.tr;
        let rowStart = context.tablePos + 1;
        for (let i = 0; i < context.rowIndex; i++) {
          rowStart += context.table.child(i).nodeSize;
        }
        const rowEnd = rowStart + context.table.child(context.rowIndex).nodeSize;
        tr.delete(rowStart, rowEnd);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    function addColumnLeft(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (
        !context.isInTable ||
        context.columnIndex === undefined ||
        !context.table ||
        context.tablePos === undefined
      )
        return false;

      if (dispatch) {
        let tr = state.tr;
        const newColumnCount = (context.columnCount || 1) + 1;
        // Width is stored as 50ths of a percent per ECMA-376 §17.18.111
        // (5000 = 100%) so resolveTableWidthPx can apply it directly.
        const newColWidthPercent = Math.floor(5000 / newColumnCount);
        const rowStarts: number[] = [];
        let rowPos = context.tablePos + 1;

        context.table.forEach((row) => {
          rowStarts.push(rowPos);
          rowPos += row.nodeSize;
        });

        context.table.forEach((row, _offset, rowIndex) => {
          if (row.type.name === 'tableRow') {
            const mappedRowPos = tr.mapping.map(rowStarts[rowIndex]);
            let cellPos = mappedRowPos + 1;
            let colIdx = 0;
            let inserted = false;

            row.forEach((cell) => {
              if (!inserted && colIdx === context.columnIndex) {
                const paragraph = schema.nodes.paragraph.create();
                const cellAttrs: any = buildCellAttrsFromTemplate(cell, {
                  colspan: 1,
                  rowspan: 1,
                });
                cellAttrs.width = newColWidthPercent;
                cellAttrs.widthType = 'pct';
                const newCell = schema.nodes.tableCell.create(cellAttrs, paragraph);
                tr = tr.insert(cellPos, newCell);
                inserted = true;
              }
              cellPos += cell.nodeSize;
              colIdx += cell.attrs.colspan || 1;
            });

            if (!inserted && colIdx <= context.columnIndex!) {
              const paragraph = schema.nodes.paragraph.create();
              const cellAttrs: any = buildCellAttrsFromTemplate(
                row.child(row.childCount - 1) ?? null,
                { colspan: 1, rowspan: 1 }
              );
              cellAttrs.width = newColWidthPercent;
              cellAttrs.widthType = 'pct';
              const newCell = schema.nodes.tableCell.create(cellAttrs, paragraph);
              tr = tr.insert(cellPos, newCell);
            }
          }
        });

        const updatedTable = tr.doc.nodeAt(context.tablePos);
        if (updatedTable && updatedTable.type.name === 'table') {
          const firstRow = updatedTable.child(0);
          if (firstRow && firstRow.type.name === 'tableRow') {
            let cellPos = context.tablePos + 2;
            firstRow.forEach((cell) => {
              if (cell.type.name === 'tableCell' || cell.type.name === 'tableHeader') {
                tr = tr.setNodeMarkup(cellPos, undefined, {
                  ...cell.attrs,
                  width: newColWidthPercent,
                  widthType: 'pct',
                });
              }
              cellPos += cell.nodeSize;
            });
          }

          // Update table columnWidths so full-width tables resize correctly.
          const colCount = firstRow?.childCount ?? newColumnCount;
          const tableWidthTwips = (updatedTable.attrs.width as number) || 9360;
          const colWidthTwips = Math.floor(tableWidthTwips / Math.max(1, colCount));
          tr = tr.setNodeMarkup(context.tablePos, undefined, {
            ...updatedTable.attrs,
            columnWidths: Array(colCount).fill(colWidthTwips),
          });
        }

        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    function addColumnRight(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (
        !context.isInTable ||
        context.columnIndex === undefined ||
        !context.table ||
        context.tablePos === undefined
      )
        return false;

      if (dispatch) {
        let tr = state.tr;
        const newColumnCount = (context.columnCount || 1) + 1;
        // Width is stored as 50ths of a percent per ECMA-376 §17.18.111
        // (5000 = 100%) so resolveTableWidthPx can apply it directly.
        const newColWidthPercent = Math.floor(5000 / newColumnCount);
        const rowStarts: number[] = [];
        let rowPos = context.tablePos + 1;

        context.table.forEach((row) => {
          rowStarts.push(rowPos);
          rowPos += row.nodeSize;
        });

        context.table.forEach((row, _offset, rowIndex) => {
          if (row.type.name === 'tableRow') {
            const mappedRowPos = tr.mapping.map(rowStarts[rowIndex]);
            let cellPos = mappedRowPos + 1;
            let colIdx = 0;
            let inserted = false;

            row.forEach((cell) => {
              cellPos += cell.nodeSize;
              colIdx += cell.attrs.colspan || 1;

              if (!inserted && colIdx > context.columnIndex!) {
                const paragraph = schema.nodes.paragraph.create();
                const cellAttrs: any = buildCellAttrsFromTemplate(cell, {
                  colspan: 1,
                  rowspan: 1,
                });
                cellAttrs.width = newColWidthPercent;
                cellAttrs.widthType = 'pct';
                const newCell = schema.nodes.tableCell.create(cellAttrs, paragraph);
                tr = tr.insert(cellPos, newCell);
                inserted = true;
              }
            });

            if (!inserted) {
              const paragraph = schema.nodes.paragraph.create();
              const cellAttrs: any = buildCellAttrsFromTemplate(
                row.child(row.childCount - 1) ?? null,
                { colspan: 1, rowspan: 1 }
              );
              cellAttrs.width = newColWidthPercent;
              cellAttrs.widthType = 'pct';
              const newCell = schema.nodes.tableCell.create(cellAttrs, paragraph);
              tr = tr.insert(cellPos, newCell);
            }
          }
        });

        const updatedTable = tr.doc.nodeAt(context.tablePos);
        if (updatedTable && updatedTable.type.name === 'table') {
          const firstRow = updatedTable.child(0);
          if (firstRow && firstRow.type.name === 'tableRow') {
            let cellPos = context.tablePos + 2;
            firstRow.forEach((cell) => {
              if (cell.type.name === 'tableCell' || cell.type.name === 'tableHeader') {
                tr = tr.setNodeMarkup(cellPos, undefined, {
                  ...cell.attrs,
                  width: newColWidthPercent,
                  widthType: 'pct',
                });
              }
              cellPos += cell.nodeSize;
            });
          }

          // Update table columnWidths so full-width tables resize correctly.
          const colCount = firstRow?.childCount ?? newColumnCount;
          const tableWidthTwips = (updatedTable.attrs.width as number) || 9360;
          const colWidthTwips = Math.floor(tableWidthTwips / Math.max(1, colCount));
          tr = tr.setNodeMarkup(context.tablePos, undefined, {
            ...updatedTable.attrs,
            columnWidths: Array(colCount).fill(colWidthTwips),
          });
        }

        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    function deleteColumn(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (
        !context.isInTable ||
        context.columnIndex === undefined ||
        !context.table ||
        context.tablePos === undefined ||
        (context.columnCount || 0) <= 1
      )
        return false;

      if (dispatch) {
        let tr = state.tr;
        const newColumnCount = (context.columnCount || 2) - 1;
        // Width is stored as 50ths of a percent per ECMA-376 §17.18.111
        // (5000 = 100%) so resolveTableWidthPx can apply it directly.
        const newColWidthPercent = Math.floor(5000 / newColumnCount);

        const deleteOps: { start: number; end: number }[] = [];
        let rowPos = context.tablePos + 1;

        context.table.forEach((row) => {
          if (row.type.name === 'tableRow') {
            let cellPos = rowPos + 1;
            let colIdx = 0;

            row.forEach((cell) => {
              const cellStart = cellPos;
              const cellEnd = cellPos + cell.nodeSize;
              const cellColspan = cell.attrs.colspan || 1;

              if (colIdx <= context.columnIndex! && context.columnIndex! < colIdx + cellColspan) {
                deleteOps.push({ start: cellStart, end: cellEnd });
              }

              cellPos = cellEnd;
              colIdx += cellColspan;
            });
          }
          rowPos += row.nodeSize;
        });

        deleteOps.reverse().forEach(({ start, end }) => {
          tr = tr.delete(start, end);
        });

        const updatedTable = tr.doc.nodeAt(context.tablePos);
        if (updatedTable && updatedTable.type.name === 'table') {
          const firstRow = updatedTable.child(0);
          if (firstRow && firstRow.type.name === 'tableRow') {
            let cellPos = context.tablePos + 2;
            firstRow.forEach((cell) => {
              if (cell.type.name === 'tableCell' || cell.type.name === 'tableHeader') {
                tr = tr.setNodeMarkup(cellPos, undefined, {
                  ...cell.attrs,
                  width: newColWidthPercent,
                  widthType: 'pct',
                });
              }
              cellPos += cell.nodeSize;
            });
          }

          // Update table columnWidths to match new column count.
          const colCount = firstRow?.childCount ?? newColumnCount;
          const tableWidthTwips = (updatedTable.attrs.width as number) || 9360;
          const colWidthTwips = Math.floor(tableWidthTwips / Math.max(1, colCount));
          tr = tr.setNodeMarkup(context.tablePos, undefined, {
            ...updatedTable.attrs,
            columnWidths: Array(colCount).fill(colWidthTwips),
          });
        }

        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    function deleteTable(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

      if (dispatch) {
        const tr = state.tr;
        tr.delete(context.tablePos, context.tablePos + context.table.nodeSize);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    function selectTable(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

      if (dispatch) {
        const tableStart = context.tablePos + 1;
        // Find first and last cell in the table
        const $first = state.doc.resolve(tableStart);
        const $last = state.doc.resolve(context.tablePos + context.table.nodeSize - 2);
        const cellSel = CellSelection.create(state.doc, $first.pos, $last.pos);
        dispatch(state.tr.setSelection(cellSel));
      }
      return true;
    }

    function selectRow(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (
        !context.isInTable ||
        context.tablePos === undefined ||
        !context.table ||
        context.rowIndex === undefined
      )
        return false;

      if (dispatch) {
        const tableStart = context.tablePos + 1;
        // Navigate to the target row
        let rowPos = tableStart;
        for (let r = 0; r < context.rowIndex; r++) {
          const row = context.table.child(r);
          rowPos += row.nodeSize;
        }
        const row = context.table.child(context.rowIndex);
        const firstCellPos = rowPos + 1; // inside the row
        const lastCellPos = rowPos + row.nodeSize - 2;
        const cellSel = CellSelection.create(state.doc, firstCellPos, lastCellPos);
        dispatch(state.tr.setSelection(cellSel));
      }
      return true;
    }

    function selectColumn(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
      const context = getTableContext(state);
      if (
        !context.isInTable ||
        context.tablePos === undefined ||
        !context.table ||
        context.columnIndex === undefined
      )
        return false;

      if (dispatch) {
        const tableStart = context.tablePos + 1;
        // Find the cell at columnIndex in first and last row
        const firstRow = context.table.child(0);
        const lastRow = context.table.child(context.table.childCount - 1);

        let firstCellPos = tableStart + 1; // inside first row
        for (let c = 0; c < context.columnIndex && c < firstRow.childCount; c++) {
          firstCellPos += firstRow.child(c).nodeSize;
        }

        let lastRowPos = tableStart;
        for (let r = 0; r < context.table.childCount - 1; r++) {
          lastRowPos += context.table.child(r).nodeSize;
        }
        let lastCellPos = lastRowPos + 1; // inside last row
        for (let c = 0; c < context.columnIndex && c < lastRow.childCount; c++) {
          lastCellPos += lastRow.child(c).nodeSize;
        }

        const cellSel = CellSelection.create(state.doc, firstCellPos, lastCellPos);
        dispatch(state.tr.setSelection(cellSel));
      }
      return true;
    }

    /**
     * Get cell positions to operate on: all cells from CellSelection, or
     * all cells in the table if a single cursor is inside a cell.
     */
    function getTargetCellPositions(state: EditorState): { pos: number; node: PMNode }[] {
      const sel = state.selection;
      const cells: { pos: number; node: PMNode }[] = [];

      // If we have a CellSelection, use its cells
      if (sel instanceof CellSelection) {
        sel.forEachCell((node, pos) => {
          cells.push({ pos, node });
        });
        return cells;
      }

      // Otherwise fall back to single cell at cursor
      const { $from } = sel;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
          cells.push({ pos: $from.before(d), node });
          break;
        }
      }
      return cells;
    }

    /**
     * Build a full grid map of all cells in the table: pos → grid info.
     * Also builds a reverse lookup by (rowIdx, colIdx).
     */
    function buildTableGrid(table: PMNode, tableStart: number) {
      const cellByPos = new Map<
        number,
        { rowIdx: number; colIdx: number; colspan: number; pos: number; node: PMNode }
      >();
      const cellByRC = new Map<string, number>(); // "row,col" → pos
      const totalRows = table.childCount;
      let totalCols = 0;

      table.forEach((row, rowOffset, rowIdx) => {
        if (row.type.name !== 'tableRow') return;
        let colIdx = 0;
        row.forEach((cell, cellOffset) => {
          const pos = tableStart + rowOffset + cellOffset + 2;
          const colspan = (cell.attrs.colspan as number) || 1;
          cellByPos.set(pos, { rowIdx, colIdx, colspan, pos, node: cell });
          cellByRC.set(`${rowIdx},${colIdx}`, pos);
          colIdx += colspan;
        });
        totalCols = Math.max(totalCols, colIdx);
      });

      return { cellByPos, cellByRC, totalRows, totalCols };
    }

    function setTableBorders(
      preset: BorderPreset,
      borderSpec?: { style: string; size: number; color: { rgb: string } }
    ): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const table = context.table;
          const tableStart = context.tablePos;

          // Use provided spec or default to thin black border
          const solidBorder = borderSpec ?? { style: 'single', size: 4, color: { rgb: '000000' } };
          const noBorder = { style: 'none' as const };

          const { cellByPos, cellByRC } = buildTableGrid(table, tableStart);

          // Get target cells — selection or cursor cell
          const targetCells = getTargetCellPositions(state);

          // Determine grid bounds of the target cells for outside/inside presets
          let minRow = Infinity,
            maxRow = -1,
            minCol = Infinity,
            maxCol = -1;
          for (const { pos } of targetCells) {
            const info = cellByPos.get(pos);
            if (info) {
              minRow = Math.min(minRow, info.rowIdx);
              maxRow = Math.max(maxRow, info.rowIdx);
              minCol = Math.min(minCol, info.colIdx);
              maxCol = Math.max(maxCol, info.colIdx + info.colspan - 1);
            }
          }

          // Track which cells we've already modified (avoid double-modify)
          const modified = new Map<number, Record<string, unknown>>();
          const getAttrs = (pos: number, node: PMNode) => {
            return modified.get(pos) ?? { ...node.attrs };
          };
          const setAttrs = (pos: number, attrs: Record<string, unknown>) => {
            modified.set(pos, attrs);
          };

          // Apply borders to each target cell + update adjacent cells on shared edges
          for (const { pos } of targetCells) {
            const info = cellByPos.get(pos);
            if (!info) continue;

            const isTopEdge = info.rowIdx === minRow;
            const isBottomEdge = info.rowIdx === maxRow;
            const isLeftEdge = info.colIdx === minCol;
            const isRightEdge = info.colIdx + info.colspan - 1 === maxCol;

            // Determine which borders to set on this cell
            let cellBorders: Record<string, typeof solidBorder | typeof noBorder>;
            switch (preset) {
              case 'all':
                cellBorders = {
                  top: solidBorder,
                  bottom: solidBorder,
                  left: solidBorder,
                  right: solidBorder,
                };
                break;
              case 'outside':
                cellBorders = {
                  top: isTopEdge ? solidBorder : noBorder,
                  bottom: isBottomEdge ? solidBorder : noBorder,
                  left: isLeftEdge ? solidBorder : noBorder,
                  right: isRightEdge ? solidBorder : noBorder,
                };
                break;
              case 'inside':
                cellBorders = {
                  top: isTopEdge ? noBorder : solidBorder,
                  bottom: isBottomEdge ? noBorder : solidBorder,
                  left: isLeftEdge ? noBorder : solidBorder,
                  right: isRightEdge ? noBorder : solidBorder,
                };
                break;
              case 'none':
                cellBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
                break;
            }

            // Update target cell
            const attrs = getAttrs(pos, info.node);
            const existingBorders = (attrs.borders as Record<string, unknown>) || {};
            setAttrs(pos, { ...attrs, borders: { ...existingBorders, ...cellBorders } });

            // Update adjacent cells' matching edges (edge-based borders like Google Docs)
            // Top edge → adjacent cell above needs matching bottom
            if (cellBorders.top) {
              const adjPos = cellByRC.get(`${info.rowIdx - 1},${info.colIdx}`);
              if (adjPos !== undefined) {
                const adj = cellByPos.get(adjPos)!;
                const adjAttrs = getAttrs(adjPos, adj.node);
                const adjBorders = (adjAttrs.borders as Record<string, unknown>) || {};
                setAttrs(adjPos, {
                  ...adjAttrs,
                  borders: { ...adjBorders, bottom: cellBorders.top },
                });
              }
            }
            // Bottom edge → adjacent cell below needs matching top
            if (cellBorders.bottom) {
              const adjPos = cellByRC.get(`${info.rowIdx + 1},${info.colIdx}`);
              if (adjPos !== undefined) {
                const adj = cellByPos.get(adjPos)!;
                const adjAttrs = getAttrs(adjPos, adj.node);
                const adjBorders = (adjAttrs.borders as Record<string, unknown>) || {};
                setAttrs(adjPos, {
                  ...adjAttrs,
                  borders: { ...adjBorders, top: cellBorders.bottom },
                });
              }
            }
            // Left edge → adjacent cell to the left needs matching right
            if (cellBorders.left) {
              const adjPos = cellByRC.get(`${info.rowIdx},${info.colIdx - 1}`);
              if (adjPos !== undefined) {
                const adj = cellByPos.get(adjPos)!;
                const adjAttrs = getAttrs(adjPos, adj.node);
                const adjBorders = (adjAttrs.borders as Record<string, unknown>) || {};
                setAttrs(adjPos, {
                  ...adjAttrs,
                  borders: { ...adjBorders, right: cellBorders.left },
                });
              }
            }
            // Right edge → adjacent cell to the right needs matching left
            if (cellBorders.right) {
              const adjPos = cellByRC.get(`${info.rowIdx},${info.colIdx + info.colspan}`);
              if (adjPos !== undefined) {
                const adj = cellByPos.get(adjPos)!;
                const adjAttrs = getAttrs(adjPos, adj.node);
                const adjBorders = (adjAttrs.borders as Record<string, unknown>) || {};
                setAttrs(adjPos, {
                  ...adjAttrs,
                  borders: { ...adjBorders, left: cellBorders.right },
                });
              }
            }
          }

          // Apply all accumulated changes to the transaction
          for (const [pos, attrs] of modified) {
            tr.setNodeMarkup(tr.mapping.map(pos), undefined, attrs);
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function setCellFillColor(color: string | null): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const cells = getTargetCellPositions(state);
          const bgColor = color ? color.replace(/^#/, '') : null;

          for (const { pos, node } of cells) {
            tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
              ...node.attrs,
              backgroundColor: bgColor,
            });
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function setCellBorder(
      side: 'top' | 'bottom' | 'left' | 'right' | 'all',
      spec: { style: string; size?: number; color?: { rgb: string } } | null,
      clearOthers?: boolean
    ): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const cells = getTargetCellPositions(state);
          const borderValue = spec || { style: 'none' };
          const noBorder = { style: 'none' as const };
          const allSides = ['top', 'bottom', 'left', 'right'] as const;
          const { cellByPos, cellByRC } = buildTableGrid(context.table, context.tablePos);

          const modified = new Map<number, Record<string, unknown>>();
          const getAttrs = (p: number, n: PMNode) => modified.get(p) ?? { ...n.attrs };
          const setAttrs = (p: number, a: Record<string, unknown>) => modified.set(p, a);

          // Map of side → adjacent side + row/col offset
          const adjacentMap: Record<string, { adjSide: string; dRow: number; dCol: number }> = {
            top: { adjSide: 'bottom', dRow: -1, dCol: 0 },
            bottom: { adjSide: 'top', dRow: 1, dCol: 0 },
            left: { adjSide: 'right', dRow: 0, dCol: -1 },
            right: { adjSide: 'left', dRow: 0, dCol: 1 },
          };

          for (const { pos, node } of cells) {
            const info = cellByPos.get(pos);
            const attrs = getAttrs(pos, node);
            const currentBorders = (attrs.borders as Record<string, unknown>) || {};

            const sides = side === 'all' ? allSides : [side];
            // When clearOthers is true, start with all sides cleared (preset behavior)
            const newBorders: Record<string, unknown> = clearOthers
              ? { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder }
              : { ...currentBorders };
            for (const s of sides) {
              newBorders[s] = borderValue;
            }

            // Sync adjacent cells — for all sides that changed
            if (info) {
              const sidesToSync = clearOthers ? allSides : sides;
              for (const s of sidesToSync) {
                const syncValue = (newBorders as Record<string, unknown>)[s];
                const adj = adjacentMap[s];
                const adjColIdx =
                  s === 'right' ? info.colIdx + info.colspan : info.colIdx + adj.dCol;
                const adjPos = cellByRC.get(`${info.rowIdx + adj.dRow},${adjColIdx}`);
                if (adjPos !== undefined) {
                  const adjInfo = cellByPos.get(adjPos)!;
                  const adjAttrs = getAttrs(adjPos, adjInfo.node);
                  const adjBorders = (adjAttrs.borders as Record<string, unknown>) || {};
                  setAttrs(adjPos, {
                    ...adjAttrs,
                    borders: { ...adjBorders, [adj.adjSide]: syncValue },
                  });
                }
              }
            }
            setAttrs(pos, { ...attrs, borders: newBorders });
          }

          for (const [p, a] of modified) {
            tr.setNodeMarkup(tr.mapping.map(p), undefined, a);
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function setCellVerticalAlign(align: 'top' | 'center' | 'bottom'): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const cells = getTargetCellPositions(state);
          for (const { pos, node } of cells) {
            tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
              ...node.attrs,
              verticalAlign: align,
            });
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function setCellMargins(margins: {
      top?: number;
      bottom?: number;
      left?: number;
      right?: number;
    }): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const cells = getTargetCellPositions(state);
          for (const { pos, node } of cells) {
            const currentMargins = node.attrs.margins || {};
            const newMargins = { ...currentMargins, ...margins };
            tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
              ...node.attrs,
              margins: newMargins,
            });
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function setCellTextDirection(direction: string | null): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const cells = getTargetCellPositions(state);
          for (const { pos, node } of cells) {
            tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
              ...node.attrs,
              textDirection: direction,
            });
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function toggleNoWrap(): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const cells = getTargetCellPositions(state);
          for (const { pos, node } of cells) {
            tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
              ...node.attrs,
              noWrap: !node.attrs.noWrap,
            });
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function setRowHeight(height: number | null, rule?: 'auto' | 'atLeast' | 'exact'): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const { $from } = state.selection;

          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'tableRow') {
              const pos = $from.before(d);
              const newAttrs = {
                ...node.attrs,
                height: height,
                heightRule: height ? rule || 'atLeast' : null,
              };
              tr.setNodeMarkup(pos, undefined, newAttrs);
              dispatch(tr.scrollIntoView());
              return true;
            }
          }
        }

        return true;
      };
    }

    function distributeColumns(): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (
          !context.isInTable ||
          context.tablePos === undefined ||
          !context.table ||
          !context.columnCount
        )
          return false;

        if (dispatch) {
          let tr = state.tr;
          const table = context.table;
          const colCount = context.columnCount;

          // Calculate total table width from existing column widths or use default
          const existingWidths = table.attrs.columnWidths as number[] | null;
          const totalWidthTwips = existingWidths
            ? existingWidths.reduce((sum: number, w: number) => sum + w, 0)
            : 9360; // Default content width in twips
          const equalWidth = Math.floor(totalWidthTwips / colCount);

          // Update each cell in every row
          let rowPos = context.tablePos + 1;
          table.forEach((row) => {
            if (row.type.name === 'tableRow') {
              let cellPos = rowPos + 1;
              row.forEach((cell) => {
                if (cell.type.name === 'tableCell' || cell.type.name === 'tableHeader') {
                  tr = tr.setNodeMarkup(cellPos, undefined, {
                    ...cell.attrs,
                    width: equalWidth,
                    widthType: 'dxa',
                    colwidth: null,
                  });
                }
                cellPos += cell.nodeSize;
              });
            }
            rowPos += row.nodeSize;
          });

          // Update table-level column widths
          const newColumnWidths = Array(colCount).fill(equalWidth);
          tr = tr.setNodeMarkup(context.tablePos, undefined, {
            ...table.attrs,
            columnWidths: newColumnWidths,
          });

          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function autoFitContents(): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          let tr = state.tr;
          const table = context.table;

          // Remove explicit widths from all cells
          let rowPos = context.tablePos + 1;
          table.forEach((row) => {
            if (row.type.name === 'tableRow') {
              let cellPos = rowPos + 1;
              row.forEach((cell) => {
                if (cell.type.name === 'tableCell' || cell.type.name === 'tableHeader') {
                  tr = tr.setNodeMarkup(cellPos, undefined, {
                    ...cell.attrs,
                    width: null,
                    widthType: null,
                    colwidth: null,
                  });
                }
                cellPos += cell.nodeSize;
              });
            }
            rowPos += row.nodeSize;
          });

          // Remove table-level column widths and set auto width
          tr = tr.setNodeMarkup(context.tablePos, undefined, {
            ...table.attrs,
            columnWidths: null,
            width: null,
            widthType: 'auto',
          });

          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    /**
     * Apply a table style to the current table.
     * Accepts pre-resolved style data (borders, shading per conditional type).
     */
    function applyTableStyle(styleData: {
      styleId: string;
      tableBorders?: {
        top?: { style: string; size?: number; color?: { rgb: string } };
        bottom?: { style: string; size?: number; color?: { rgb: string } };
        left?: { style: string; size?: number; color?: { rgb: string } };
        right?: { style: string; size?: number; color?: { rgb: string } };
        insideH?: { style: string; size?: number; color?: { rgb: string } };
        insideV?: { style: string; size?: number; color?: { rgb: string } };
      };
      conditionals?: Record<
        string,
        {
          backgroundColor?: string;
          borders?: {
            top?: { style: string; size?: number; color?: { rgb: string } } | null;
            bottom?: { style: string; size?: number; color?: { rgb: string } } | null;
            left?: { style: string; size?: number; color?: { rgb: string } } | null;
            right?: { style: string; size?: number; color?: { rgb: string } } | null;
          };
          bold?: boolean;
          color?: string;
        }
      >;
      look?: {
        firstRow?: boolean;
        lastRow?: boolean;
        firstCol?: boolean;
        lastCol?: boolean;
        noHBand?: boolean;
        noVBand?: boolean;
      };
    }): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          let tr = state.tr;
          const table = context.table;
          const tablePos = context.tablePos;
          const totalRows = table.childCount;
          const look = styleData.look ?? {
            firstRow: true,
            lastRow: false,
            noHBand: false,
            noVBand: true,
          };
          const conditionals = styleData.conditionals ?? {};
          const tableBorders = styleData.tableBorders;

          // Update table node attrs with styleId
          tr = tr.setNodeMarkup(tablePos, undefined, {
            ...table.attrs,
            styleId: styleData.styleId,
          });

          // Walk through all rows and cells to apply conditional formatting
          let dataRowIndex = 0;
          let rowOffset = tablePos + 1; // Skip table open tag

          for (let rowIdx = 0; rowIdx < totalRows; rowIdx++) {
            const row = table.child(rowIdx);
            const isFirstRow = rowIdx === 0 && !!look.firstRow;
            const isLastRow = rowIdx === totalRows - 1 && !!look.lastRow;
            const bandingEnabled = look.noHBand !== true;
            const totalCols = row.childCount;

            // Determine row-level conditional type
            let condType: string | undefined;
            if (isFirstRow) {
              condType = 'firstRow';
            } else if (isLastRow) {
              condType = 'lastRow';
            } else if (bandingEnabled) {
              condType = dataRowIndex % 2 === 0 ? 'band1Horz' : 'band2Horz';
              dataRowIndex++;
            } else {
              dataRowIndex++;
            }

            let cellOffset = rowOffset + 1; // Skip row open tag

            for (let colIdx = 0; colIdx < totalCols; colIdx++) {
              const cell = row.child(colIdx);
              const cellPos = tr.mapping.map(cellOffset);

              // Determine cell-level conditional (column overrides can apply)
              let cellCondType = condType;
              const isFirstCol = colIdx === 0 && !!look.firstCol;
              const isLastCol = colIdx === totalCols - 1 && !!look.lastCol;

              // Corner cells take highest priority
              if (isFirstRow && isFirstCol && conditionals['nwCell']) {
                cellCondType = 'nwCell';
              } else if (isFirstRow && isLastCol && conditionals['neCell']) {
                cellCondType = 'neCell';
              } else if (isLastRow && isFirstCol && conditionals['swCell']) {
                cellCondType = 'swCell';
              } else if (isLastRow && isLastCol && conditionals['seCell']) {
                cellCondType = 'seCell';
              } else if (isFirstCol) {
                cellCondType = 'firstCol';
              } else if (isLastCol) {
                cellCondType = 'lastCol';
              }

              // Resolve conditional style for this cell
              const cond = cellCondType ? conditionals[cellCondType] : undefined;

              // Build new cell attrs
              const newAttrs = { ...cell.attrs };

              // Apply background color
              if (cond?.backgroundColor) {
                newAttrs.backgroundColor = cond.backgroundColor;
              } else {
                newAttrs.backgroundColor = null;
              }

              // Apply borders: conditional borders override table borders
              const cellBorders: Record<string, unknown> = {};
              const sides = ['top', 'bottom', 'left', 'right'] as const;
              for (const side of sides) {
                if (cond?.borders && cond.borders[side] !== undefined) {
                  cellBorders[side] = cond.borders[side];
                } else if (tableBorders) {
                  // Map table-level border to cell: insideH for top/bottom between rows, insideV for left/right between cols
                  if (
                    (side === 'top' && rowIdx > 0) ||
                    (side === 'bottom' && rowIdx < totalRows - 1)
                  ) {
                    cellBorders[side] = tableBorders.insideH ?? tableBorders[side];
                  } else if (
                    (side === 'left' && colIdx > 0) ||
                    (side === 'right' && colIdx < totalCols - 1)
                  ) {
                    cellBorders[side] = tableBorders.insideV ?? tableBorders[side];
                  } else {
                    cellBorders[side] = tableBorders[side];
                  }
                }
              }
              if (Object.keys(cellBorders).length > 0) {
                newAttrs.borders = cellBorders;
              } else {
                newAttrs.borders = null;
              }

              tr = tr.setNodeMarkup(cellPos, undefined, newAttrs);
              cellOffset += cell.nodeSize;
            }

            rowOffset += row.nodeSize;
          }

          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function setTableProperties(props: {
      width?: number | null;
      widthType?: string | null;
      justification?: 'left' | 'center' | 'right' | null;
    }): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const newAttrs = { ...context.table.attrs };
          if ('width' in props) newAttrs.width = props.width;
          if ('widthType' in props) newAttrs.widthType = props.widthType;
          if ('justification' in props) newAttrs.justification = props.justification;
          tr.setNodeMarkup(context.tablePos, undefined, newAttrs);
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function toggleHeaderRow(): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const { $from } = state.selection;

          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'tableRow') {
              const pos = $from.before(d);
              const newAttrs = { ...node.attrs, isHeader: !node.attrs.isHeader };
              tr.setNodeMarkup(pos, undefined, newAttrs);
              dispatch(tr.scrollIntoView());
              return true;
            }
          }
        }

        return true;
      };
    }

    function setTableBorderColor(color: string): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const cells = getTargetCellPositions(state);
          const rgb = color.replace(/^#/, '');
          const defaultBorder = { style: 'single', size: 4 };
          const { cellByPos, cellByRC } = buildTableGrid(context.table, context.tablePos);

          const modified = new Map<number, Record<string, unknown>>();
          const getAttrs = (p: number, n: PMNode) => modified.get(p) ?? { ...n.attrs };
          const setAttrs = (p: number, a: Record<string, unknown>) => modified.set(p, a);

          const adjacentMap: Record<string, { adjSide: string; dRow: number; dCol: number }> = {
            top: { adjSide: 'bottom', dRow: -1, dCol: 0 },
            bottom: { adjSide: 'top', dRow: 1, dCol: 0 },
            left: { adjSide: 'right', dRow: 0, dCol: -1 },
            right: { adjSide: 'left', dRow: 0, dCol: 1 },
          };

          for (const { pos, node } of cells) {
            const info = cellByPos.get(pos);
            const attrs = getAttrs(pos, node);
            const currentBorders = (attrs.borders as Record<string, Record<string, unknown>>) || {};
            const newBorders: Record<string, unknown> = {};

            for (const side of ['top', 'bottom', 'left', 'right'] as const) {
              const borderVal = { ...defaultBorder, ...currentBorders[side], color: { rgb } };
              newBorders[side] = borderVal;

              // Sync adjacent cell's matching edge
              if (info) {
                const adj = adjacentMap[side];
                const adjColIdx =
                  side === 'right' ? info.colIdx + info.colspan : info.colIdx + adj.dCol;
                const adjPos = cellByRC.get(`${info.rowIdx + adj.dRow},${adjColIdx}`);
                if (adjPos !== undefined) {
                  const adjInfo = cellByPos.get(adjPos)!;
                  const adjAttrs = getAttrs(adjPos, adjInfo.node);
                  const adjBorders = (adjAttrs.borders as Record<string, unknown>) || {};
                  setAttrs(adjPos, {
                    ...adjAttrs,
                    borders: { ...adjBorders, [adj.adjSide]: borderVal },
                  });
                }
              }
            }
            setAttrs(pos, { ...attrs, borders: { ...currentBorders, ...newBorders } });
          }

          for (const [p, a] of modified) {
            tr.setNodeMarkup(tr.mapping.map(p), undefined, a);
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function setTableBorderWidth(size: number): Command {
      return (state, dispatch) => {
        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        if (dispatch) {
          const tr = state.tr;
          const cells = getTargetCellPositions(state);
          const defaultBorder = { style: 'single', color: { rgb: '000000' } };
          const { cellByPos, cellByRC } = buildTableGrid(context.table, context.tablePos);

          const modified = new Map<number, Record<string, unknown>>();
          const getAttrs = (p: number, n: PMNode) => modified.get(p) ?? { ...n.attrs };
          const setAttrs = (p: number, a: Record<string, unknown>) => modified.set(p, a);

          const adjacentMap: Record<string, { adjSide: string; dRow: number; dCol: number }> = {
            top: { adjSide: 'bottom', dRow: -1, dCol: 0 },
            bottom: { adjSide: 'top', dRow: 1, dCol: 0 },
            left: { adjSide: 'right', dRow: 0, dCol: -1 },
            right: { adjSide: 'left', dRow: 0, dCol: 1 },
          };

          for (const { pos, node } of cells) {
            const info = cellByPos.get(pos);
            const attrs = getAttrs(pos, node);
            const currentBorders = (attrs.borders as Record<string, Record<string, unknown>>) || {};
            const newBorders: Record<string, unknown> = {};

            for (const side of ['top', 'bottom', 'left', 'right'] as const) {
              const borderVal = { ...defaultBorder, ...currentBorders[side], size };
              newBorders[side] = borderVal;

              // Sync adjacent cell's matching edge
              if (info) {
                const adj = adjacentMap[side];
                const adjColIdx =
                  side === 'right' ? info.colIdx + info.colspan : info.colIdx + adj.dCol;
                const adjPos = cellByRC.get(`${info.rowIdx + adj.dRow},${adjColIdx}`);
                if (adjPos !== undefined) {
                  const adjInfo = cellByPos.get(adjPos)!;
                  const adjAttrs = getAttrs(adjPos, adjInfo.node);
                  const adjBorders = (adjAttrs.borders as Record<string, unknown>) || {};
                  setAttrs(adjPos, {
                    ...adjAttrs,
                    borders: { ...adjBorders, [adj.adjSide]: borderVal },
                  });
                }
              }
            }
            setAttrs(pos, { ...attrs, borders: { ...currentBorders, ...newBorders } });
          }

          for (const [p, a] of modified) {
            tr.setNodeMarkup(tr.mapping.map(p), undefined, a);
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };
    }

    function deleteTableIfSelected(): Command {
      return (state, dispatch) => {
        const selection = state.selection as CellSelection;
        const isCellSel = '$anchorCell' in selection && typeof selection.forEachCell === 'function';
        if (!isCellSel) return false;

        const context = getTableContext(state);
        if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

        let totalCells = 0;
        context.table.descendants((node) => {
          if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
            totalCells += 1;
          }
        });

        let selectedCells = 0;
        selection.forEachCell(() => {
          selectedCells += 1;
        });

        const isFullTable = totalCells > 0 && selectedCells >= totalCells;

        if (!isFullTable) return false;

        if (dispatch) {
          const tr = state.tr.delete(context.tablePos, context.tablePos + context.table.nodeSize);
          dispatch(tr.scrollIntoView());
        }
        return true;
      };
    }

    function preventTableMergeAtGap(): Command {
      return (state) => {
        const { $from, empty } = state.selection;
        if (!empty) return false;

        const parent = $from.parent;
        if (parent.type.name !== 'paragraph') return false;
        if (parent.textContent.length > 0) return false;

        const depth = $from.depth;
        if (depth < 1) return false;
        const container = $from.node(depth - 1);
        const index = $from.index(depth - 1);
        const before = index > 0 ? container.child(index - 1) : null;
        const after = index + 1 < container.childCount ? container.child(index + 1) : null;
        const beforeIsTable = before?.type.name === 'table';
        const afterIsTable = after?.type.name === 'table';
        if (beforeIsTable || afterIsTable) {
          // Keep the spacer paragraph adjacent to tables so they can't visually merge.
          return true;
        }

        return false;
      };
    }

    // Active cell highlight plugin — adds a CSS class to the cell containing the cursor
    const activeCellKey = new PluginKey('activeCell');
    const activeCellPlugin = new Plugin({
      key: activeCellKey,
      props: {
        decorations(state) {
          const { selection } = state;
          // Skip if already a CellSelection (prosemirror-tables handles that)
          if (selection instanceof CellSelection) return DecorationSet.empty;

          const { $from } = selection;
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
              const pos = $from.before(d);
              return DecorationSet.create(state.doc, [
                Decoration.node(pos, pos + node.nodeSize, { class: 'activeCell' }),
              ]);
            }
          }
          return DecorationSet.empty;
        },
      },
    });

    return {
      plugins: [
        columnResizing({
          handleWidth: 5,
          cellMinWidth: 25,
          lastColumnResizable: true,
        }),
        tableEditing(),
        activeCellPlugin,
      ],
      keyboardShortcuts: {
        Backspace: chainCommands(deleteTableIfSelected(), preventTableMergeAtGap()),
        Delete: chainCommands(deleteTableIfSelected(), preventTableMergeAtGap()),
      },
      commands: {
        insertTable: (rows: number, cols: number) => insertTable(rows, cols),
        addRowAbove: () => addRowAbove,
        addRowBelow: () => addRowBelow,
        deleteRow: () => deleteRow,
        addColumnLeft: () => addColumnLeft,
        addColumnRight: () => addColumnRight,
        deleteColumn: () => deleteColumn,
        deleteTable: () => deleteTable,
        selectTable: () => selectTable,
        selectRow: () => selectRow,
        selectColumn: () => selectColumn,
        mergeCells: () => pmMergeCells,
        splitCell: () => pmSplitCell,
        setCellBorder: (
          side: 'top' | 'bottom' | 'left' | 'right' | 'all',
          spec: { style: string; size?: number; color?: { rgb: string } } | null,
          clearOthers?: boolean
        ) => setCellBorder(side, spec, clearOthers),
        setTableBorders: (
          preset: BorderPreset,
          borderSpec?: { style: string; size: number; color: { rgb: string } }
        ) => setTableBorders(preset, borderSpec),
        setCellVerticalAlign: (align: 'top' | 'center' | 'bottom') => setCellVerticalAlign(align),
        setCellMargins: (margins: {
          top?: number;
          bottom?: number;
          left?: number;
          right?: number;
        }) => setCellMargins(margins),
        setCellTextDirection: (direction: string | null) => setCellTextDirection(direction),
        toggleNoWrap: () => toggleNoWrap(),
        setRowHeight: (height: number | null, rule?: 'auto' | 'atLeast' | 'exact') =>
          setRowHeight(height, rule),
        toggleHeaderRow: () => toggleHeaderRow(),
        distributeColumns: () => distributeColumns(),
        autoFitContents: () => autoFitContents(),
        setTableProperties: (props: {
          width?: number | null;
          widthType?: string | null;
          justification?: 'left' | 'center' | 'right' | null;
        }) => setTableProperties(props),
        applyTableStyle: (styleData: Parameters<typeof applyTableStyle>[0]) =>
          applyTableStyle(styleData),
        setCellFillColor: (color: string | null) => setCellFillColor(color),
        setTableBorderColor: (color: string) => setTableBorderColor(color),
        setTableBorderWidth: (size: number) => setTableBorderWidth(size),
        removeTableBorders: () => setTableBorders('none'),
        setAllTableBorders: (borderSpec?: {
          style: string;
          size: number;
          color: { rgb: string };
        }) => setTableBorders('all', borderSpec),
        setOutsideTableBorders: (borderSpec?: {
          style: string;
          size: number;
          color: { rgb: string };
        }) => setTableBorders('outside', borderSpec),
        setInsideTableBorders: (borderSpec?: {
          style: string;
          size: number;
          color: { rgb: string };
        }) => setTableBorders('inside', borderSpec),
      },
    };
  },
});

// ============================================================================
// CONVENIENCE: all table extensions grouped
// ============================================================================

export function createTableExtensions(): AnyExtension[] {
  return [
    TableNodeExtension(),
    TableRowExtension(),
    TableCellExtension(),
    TableHeaderExtension(),
    TablePluginExtension(),
  ];
}

// Re-export for backward compat
export { getTableContext, isInTableCell as isInTable, goToNextCell, goToPrevCell };
