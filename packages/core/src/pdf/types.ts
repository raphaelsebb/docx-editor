/**
 * Public input/option types for the PDF exporter.
 *
 * The exporter mirrors the painter's `renderPage` inputs: the computed `Layout`,
 * the `BlockLookup` that resolves a fragment's `blockId` to its `FlowBlock`, plus
 * the adapter-resolved chrome (headers/footers, page borders, background) that is
 * NOT on `Layout`. Supplied by the adapter, which already builds these for the painter.
 */

import type { PDFDocument } from 'pdf-lib';
import type { Layout } from '../layout-engine/types';
import type { BlockLookup } from '../layout-painter/index';
import type { HeaderFooterContent } from '../layout-painter/renderPage';
import type { FontProvider } from './fontProvider';

/**
 * One page-border side. Permissive so the adapter can pass the section's
 * `BorderSpec` directly: `width` is px, `size` is OOXML eighths-of-a-point, and
 * `color` is either a CSS string or a structured `{ rgb }` value.
 */
export interface PageBorderSide {
  style?: string;
  /** Width in px. */
  width?: number;
  /** Width in eighths of a point (OOXML w:sz). */
  size?: number;
  color?: string | { rgb?: string } | null;
}

/** Page border spec (w:pgBorders), mirroring the painter's renderPage option. */
export interface PageBordersInput {
  top?: PageBorderSide;
  bottom?: PageBorderSide;
  left?: PageBorderSide;
  right?: PageBorderSide;
  /** Which pages show the border. */
  display?: 'allPages' | 'firstPage' | 'notFirstPage';
  /** Inset reference: from the page edge or from the text margin. */
  offsetFrom?: 'page' | 'text';
}

export interface ExportToPdfOptions {
  /** PDF Title / first page metadata. */
  documentName?: string;
  /** PDF Author metadata. */
  author?: string;
  /** Value added to each page's PAGE field (page.number + pageNumberStart - 1). */
  pageNumberStart?: number;
  /** ISO date string for DATE/TIME field resolution (injected for determinism). */
  now?: string;
  /** Progress 0..1 callback as pages render. */
  onProgress?: (fraction: number) => void;
  /** Non-fatal issues (unsupported image format, font fetch failure, ...). */
  onWarning?: (message: string) => void;
  /** Bundled Unicode fallback font bytes for non-Latin runs in unmapped families. */
  unicodeFallbackBytes?: Uint8Array;
}

export interface ExportToPdfInput {
  layout: Layout;
  /** Resolves `fragment.blockId` → `FlowBlock` (same map the painter consumes). */
  blockLookup: BlockLookup;
  /** Per-page resolved header content (default, or first/even as the adapter resolved it). */
  headerByPage?: (pageNumber: number) => HeaderFooterContent | undefined;
  /** Per-page resolved footer content. */
  footerByPage?: (pageNumber: number) => HeaderFooterContent | undefined;
  /** Page background color (w:background); painter takes this as a renderPage option. */
  backgroundColor?: string;
  /** Page borders (w:pgBorders) resolved by the adapter. */
  pageBorders?: PageBordersInput;
  /**
   * Override the font provider over the exporter's PDFDocument (tests inject a
   * no-network one). Defaults to {@link GoogleFontProvider}.
   */
  fontProviderFactory?: (doc: PDFDocument) => FontProvider;
  options?: ExportToPdfOptions;
}
