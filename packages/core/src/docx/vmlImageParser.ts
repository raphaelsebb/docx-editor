/**
 * VML Image Parser
 *
 * Legacy Word documents embed pictures (e.g. header logos) as VML rather than
 * DrawingML:
 *
 *   <w:r><w:pict>
 *     <v:shape id="Picture 1" type="#_x0000_t75" style="width:120pt;height:40pt">
 *       <v:imagedata r:id="rId7" o:title="logo"/>
 *     </v:shape>
 *   </w:pict></w:r>
 *
 * The run parser used to drop `w:pict` entirely, so these images never
 * rendered. This parser turns a non-watermark VML picture into the same
 * `DrawingContent` an inline DrawingML image produces, so the rest of the
 * pipeline (conversion, layout, painter) treats it identically.
 *
 * Watermark shapes (`isWatermarkShape`) are left to {@link extractWatermark};
 * returning them here too would render them twice.
 */

import type { DrawingContent } from '../types/content/run';
import type { Image } from '../types/content/image';
import type { RelationshipMap, MediaFile } from '../types/document';
import { getAttribute, getChildElements, findAllDeep, type XmlElement } from './xmlParser';
import { resolveImageData } from './imageParser';
import { isWatermarkShape } from './vmlWatermarkParser';

const EMU_PER_PX = 914400 / 96;

/** Parse a VML/CSS `style` attribute ("k:v;k:v") into a lookup. */
function parseStyleAttr(style: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const key = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** Convert a CSS length (pt/in/px/cm/mm/pc, default px) to pixels. */
function cssLengthToPx(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^(-?[\d.]+)\s*(pt|in|px|cm|mm|pc)?$/.exec(raw.trim());
  if (!m) return undefined;
  const value = parseFloat(m[1]);
  if (isNaN(value)) return undefined;
  switch (m[2]) {
    case 'pt':
      return (value / 72) * 96;
    case 'in':
      return value * 96;
    case 'cm':
      return (value / 2.54) * 96;
    case 'mm':
      return (value / 25.4) * 96;
    case 'pc':
      return (value / 6) * 96;
    case 'px':
    case undefined:
      return value;
    default:
      return undefined;
  }
}

/** Read the `r:id` (or fallbacks) off a `v:imagedata` element. */
function readImageDataRId(imagedata: XmlElement): string {
  return (
    getAttribute(imagedata, 'r', 'id') ??
    getAttribute(imagedata, 'r', 'embed') ??
    getAttribute(imagedata, null, 'id') ??
    ''
  );
}

/**
 * Parse a `w:pict` (or `w:object`) element into an inline image, or null when
 * it carries no ordinary VML picture (e.g. it's a watermark or has no image).
 */
export function parseVmlImageContent(
  pictElement: XmlElement,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null
): DrawingContent | null {
  // A VML picture's image lives in <v:imagedata r:id="..."> inside a shape
  // (v:shape / v:rect / v:roundrect / v:oval). xml-js elements have no parent
  // link, so walk shapes and look for an imagedata child within each.
  const shapes = [
    ...findAllDeep(pictElement, 'v', 'shape'),
    ...findAllDeep(pictElement, 'v', 'rect'),
    ...findAllDeep(pictElement, 'v', 'roundrect'),
    ...findAllDeep(pictElement, 'v', 'oval'),
  ];
  for (const shape of shapes) {
    const imagedata = getChildElements(shape).find(
      (c) => c.name === 'v:imagedata' || c.name?.endsWith(':imagedata')
    );
    if (!imagedata) continue;

    const rId = readImageDataRId(imagedata);
    if (!rId) continue;

    // Skip watermark shapes — extractWatermark owns those.
    const idLower = (getAttribute(shape, null, 'id') ?? '').toLowerCase();
    if (isWatermarkShape(shape, idLower)) continue;

    const { src, mimeType, filename } = resolveImageData(
      rId,
      rels ?? undefined,
      media ?? undefined
    );

    const shapeStyle = parseStyleAttr(getAttribute(shape, null, 'style'));
    const widthPx = cssLengthToPx(shapeStyle['width']);
    const heightPx = cssLengthToPx(shapeStyle['height']);

    const image: Image = {
      type: 'image',
      rId,
      size: {
        width: widthPx != null ? Math.round(widthPx * EMU_PER_PX) : 0,
        height: heightPx != null ? Math.round(heightPx * EMU_PER_PX) : 0,
      },
      // VML pictures in a run are inline-flow by default. Absolute-positioned
      // VML (position:absolute) is treated as inline here too — rendering the
      // logo in flow is far better than dropping it; exact anchoring is a
      // follow-up.
      wrap: { type: 'inline' },
    };
    if (src) image.src = src;
    if (mimeType) image.mimeType = mimeType;
    if (filename) image.filename = filename;
    const title = getAttribute(imagedata, 'o', 'title') ?? undefined;
    if (title) image.title = title;

    return { type: 'drawing', image };
  }

  return null;
}
