/**
 * Note body block-level fidelity (PR #646 F3 regression)
 *
 * When #646 made footnote/endnote bodies editable, the parse→model→reserialize
 * path dropped block-level constructs the old verbatim copy preserved:
 *   - block-level w:sdt
 *   - block-level bookmarks (w:bookmarkStart / w:bookmarkEnd)
 *   - w:customXml
 *
 * The fix gates the model rewrite: a note carrying any unmodeled child falls
 * back to a verbatim copy of its original XML, restoring pre-#646 fidelity
 * while keeping #646's editability for ordinary notes.
 */

import { describe, test, expect } from 'bun:test';
import { parseEndnotes, parseFootnotes } from './footnoteParser';
import { serializeEndnotes, serializeFootnotes } from './serializer/noteSerializer';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/**
 * An endnote body that interleaves an ordinary paragraph with three
 * unmodeled block-level constructs: a bookmark pair, an sdt-wrapped
 * paragraph, and a customXml wrapper.
 */
function endnotesXmlWithUnmodeledBlocks(): string {
  return (
    `${XML_DECL}<w:endnotes ${NS}>` +
    `<w:endnote w:id="1">` +
    `<w:p><w:r><w:t>Plain text before.</w:t></w:r></w:p>` +
    `<w:bookmarkStart w:id="10" w:name="NoteBookmark"/>` +
    `<w:bookmarkEnd w:id="10"/>` +
    `<w:sdt><w:sdtPr><w:tag w:val="noteTag"/></w:sdtPr>` +
    `<w:sdtContent><w:p><w:r><w:t>Inside SDT.</w:t></w:r></w:p></w:sdtContent>` +
    `</w:sdt>` +
    `<w:customXml w:element="MyElement">` +
    `<w:p><w:r><w:t>Inside customXml.</w:t></w:r></w:p>` +
    `</w:customXml>` +
    `</w:endnote>` +
    `</w:endnotes>`
  );
}

function footnotesXmlWithUnmodeledBlocks(): string {
  return endnotesXmlWithUnmodeledBlocks()
    .replace(/w:endnotes/g, 'w:footnotes')
    .replace(/w:endnote /g, 'w:footnote ')
    .replace(/<\/w:endnote>/g, '</w:footnote>');
}

describe('note body block-level fidelity (#646 F3)', () => {
  test('endnote with bookmark + sdt + customXml round-trips losslessly', () => {
    const parsed = parseEndnotes(endnotesXmlWithUnmodeledBlocks());
    const note = parsed.getEndnote(1)!;
    expect(note).toBeDefined();

    const xml = serializeEndnotes([note]);

    // All three unmodeled constructs must survive the parse→serialize cycle.
    expect(xml).toContain('<w:bookmarkStart');
    expect(xml).toContain('w:name="NoteBookmark"');
    expect(xml).toContain('<w:bookmarkEnd');
    expect(xml).toContain('<w:sdt');
    expect(xml).toContain('w:val="noteTag"');
    expect(xml).toContain('Inside SDT.');
    expect(xml).toContain('<w:customXml');
    expect(xml).toContain('Inside customXml.');

    // And the ordinary paragraph survives too.
    expect(xml).toContain('Plain text before.');

    // Re-parse the serialized XML: the note is still recognized.
    const reparsed = parseEndnotes(xml);
    expect(reparsed.getEndnote(1)).toBeDefined();
  });

  test('footnote with bookmark + sdt + customXml round-trips losslessly', () => {
    const parsed = parseFootnotes(footnotesXmlWithUnmodeledBlocks());
    const note = parsed.getFootnote(1)!;
    expect(note).toBeDefined();

    const xml = serializeFootnotes([note]);

    expect(xml).toContain('<w:bookmarkStart');
    expect(xml).toContain('<w:bookmarkEnd');
    expect(xml).toContain('<w:sdt');
    expect(xml).toContain('Inside SDT.');
    expect(xml).toContain('<w:customXml');
    expect(xml).toContain('Inside customXml.');
  });

  test('an ordinary endnote (no unmodeled blocks) still serializes from the model', () => {
    const xml =
      `${XML_DECL}<w:endnotes ${NS}>` +
      `<w:endnote w:id="2"><w:p><w:r><w:t>Just text.</w:t></w:r></w:p></w:endnote>` +
      `</w:endnotes>`;
    const parsed = parseEndnotes(xml);
    const note = parsed.getEndnote(2)!;
    // No verbatim fallback should be engaged for a plain note.
    expect(note.verbatimXml).toBeUndefined();
    const out = serializeEndnotes([note]);
    expect(out).toContain('Just text.');
  });
});
