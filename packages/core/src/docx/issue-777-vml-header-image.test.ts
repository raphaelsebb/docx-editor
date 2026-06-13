/**
 * Issue #777 — VML header images (e.g. logos) were dropped / mis-handled.
 *
 * A `<w:pict><v:shape><v:imagedata r:id/></v:shape></w:pict>` picture is now
 * parsed into an inline image instead of being skipped by the run parser, and
 * the watermark extractor no longer greedily claims a non-watermark VML
 * picture as a picture watermark.
 *
 * Background: https://github.com/eigenpal/docx-editor/issues/777
 */

import { describe, expect, test } from 'bun:test';
import { parseXml, findAllDeep, type XmlElement } from './xmlParser';
import { parseVmlImageContent } from './vmlImageParser';
import { extractWatermark } from './vmlWatermarkParser';
import type { RelationshipMap, MediaFile } from '../types/document';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const LOGO_PICT = `<w:r ${NS}><w:pict>
  <v:shape id="Picture 1" type="#_x0000_t75" style="width:120pt;height:40pt">
    <v:imagedata r:id="rId7" o:title="logo"/>
  </v:shape>
</w:pict></w:r>`;

const WATERMARK_PICT = `<w:r ${NS}><w:pict>
  <v:shape id="WordPictureWatermark123" type="#_x0000_t75" style="width:200pt;height:100pt">
    <v:imagedata r:id="rId9" gain="19661f" blacklevel="22938f"/>
  </v:shape>
</w:pict></w:r>`;

const HDR_WITH_LOGO = `<w:hdr ${NS}>
  <w:p><w:r><w:pict>
    <v:shape id="Picture 1" type="#_x0000_t75" style="width:120pt;height:40pt">
      <v:imagedata r:id="rId7"/>
    </v:shape>
  </w:pict></w:r></w:p>
  <w:p><w:r><w:t>Header text</w:t></w:r></w:p>
</w:hdr>`;

function pictEl(xml: string): XmlElement {
  const root = parseXml(xml)!;
  return findAllDeep(root, 'w', 'pict')[0];
}
function hdrRoot(xml: string): XmlElement {
  const doc = parseXml(xml)!;
  // parseXml returns the first element node (the w:r/w:hdr wrapper).
  return doc;
}

const rels: RelationshipMap = new Map([
  ['rId7', { id: 'rId7', type: 'image', target: 'media/logo.png', targetMode: 'Internal' }],
  ['rId9', { id: 'rId9', type: 'image', target: 'media/wm.png', targetMode: 'Internal' }],
] as unknown as [string, never][]);
const media: Map<string, MediaFile> = new Map([
  [
    'media/logo.png',
    { path: 'word/media/logo.png', dataUrl: 'data:image/png;base64,AAA', mimeType: 'image/png' },
  ],
] as unknown as [string, never][]);

describe('issue #777 — VML header images', () => {
  test('parses a VML <v:shape><v:imagedata> logo into an inline image', () => {
    const result = parseVmlImageContent(pictEl(LOGO_PICT), rels, media);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('drawing');
    expect(result!.image.rId).toBe('rId7');
    expect(result!.image.src).toBe('data:image/png;base64,AAA');
    expect(result!.image.wrap.type).toBe('inline');
    // 120pt × 40pt → px → EMU. 120pt = 160px, 40pt ≈ 53.33px.
    expect(result!.image.size.width).toBeGreaterThan(0);
    expect(result!.image.size.height).toBeGreaterThan(0);
    // width should be 3× height (120pt vs 40pt).
    expect(Math.round(result!.image.size.width / result!.image.size.height)).toBe(3);
  });

  test('does NOT parse a watermark shape as an inline image', () => {
    expect(parseVmlImageContent(pictEl(WATERMARK_PICT), rels, media)).toBeNull();
  });

  test('watermark extractor no longer claims a non-watermark VML picture', () => {
    expect(extractWatermark(hdrRoot(HDR_WITH_LOGO), rels, media)).toBeUndefined();
  });
});
