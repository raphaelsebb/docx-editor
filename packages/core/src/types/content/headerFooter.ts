/**
 * Page furniture — headers (`w:hdr`), footers (`w:ftr`), footnotes
 * (`w:footnote`), and endnotes (`w:endnote`), plus the section-level
 * properties (`w:footnotePr`/`w:endnotePr`) that configure note layout.
 */

import type { NumberFormat } from '../lists';
import type { BlockContent } from './section';

/**
 * Header/footer type
 */
export type HeaderFooterType = 'default' | 'first' | 'even';

/**
 * Header or footer reference
 */
export interface HeaderReference {
  type: HeaderFooterType;
  rId: string;
}

export interface FooterReference {
  type: HeaderFooterType;
  rId: string;
}

/**
 * Header or footer content
 */
export interface HeaderFooter {
  type: 'header' | 'footer';
  /** Header/footer type */
  hdrFtrType: HeaderFooterType;
  /** Content (paragraphs, tables, etc.) */
  content: BlockContent[];
}

/**
 * Footnote position
 */
export type FootnotePosition = 'pageBottom' | 'beneathText' | 'sectEnd' | 'docEnd';

/**
 * Endnote position
 */
export type EndnotePosition = 'sectEnd' | 'docEnd';

/**
 * Number restart type
 */
export type NoteNumberRestart = 'continuous' | 'eachSect' | 'eachPage';

/**
 * Footnote properties
 */
export interface FootnoteProperties {
  position?: FootnotePosition;
  numFmt?: NumberFormat;
  numStart?: number;
  numRestart?: NoteNumberRestart;
}

/**
 * Endnote properties
 */
export interface EndnoteProperties {
  position?: EndnotePosition;
  numFmt?: NumberFormat;
  numStart?: number;
  numRestart?: NoteNumberRestart;
}

/**
 * Footnote (w:footnote)
 */
export interface Footnote {
  type: 'footnote';
  /** Footnote ID */
  id: number;
  /** Special footnote type */
  noteType?: 'normal' | 'separator' | 'continuationSeparator' | 'continuationNotice';
  /**
   * Content. Per ECMA-376 §17.11.10 footnotes can hold the same blocks as
   * the body — paragraphs and tables. The parser previously only collected
   * <w:p> children which silently dropped any <w:tbl> inside a footnote;
   * widened to match HeaderFooter / TableCell shape so the body pipeline
   * (toProseDoc → toFlowBlocks) can render them uniformly.
   */
  content: BlockContent[];
  /**
   * Verbatim original XML of the entire `<w:footnote>` element, captured at
   * parse time ONLY when the note body carries a block-level construct the
   * note parser doesn't model (block-level `w:sdt`, bookmarks, `w:customXml`).
   * When present the serializer re-emits these bytes instead of rebuilding
   * from `content`, restoring pre-#646 fidelity for unmodeled constructs.
   * See `parseNoteBlockContent` / `serializeNote` for the gate (#646 F3).
   */
  verbatimXml?: string;
}

/**
 * Endnote (w:endnote)
 */
export interface Endnote {
  type: 'endnote';
  /** Endnote ID */
  id: number;
  /** Special endnote type */
  noteType?: 'normal' | 'separator' | 'continuationSeparator' | 'continuationNotice';
  /**
   * Content. Per ECMA-376 §17.11.4 endnotes can hold the same blocks as
   * the body — paragraphs and tables. See note on `Footnote.content`.
   */
  content: BlockContent[];
  /** Verbatim original XML — see `Footnote.verbatimXml` (#646 F3). */
  verbatimXml?: string;
}
