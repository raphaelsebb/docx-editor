/**
 * Image-fragment drawing for the PDF exporter.
 *
 * pdf-lib embeds only PNG and JPEG. GIF/BMP/WEBP/SVG are re-encoded to PNG via
 * canvas (browser only); EMF/WMF (which canvas cannot decode) draw a placeholder
 * box and emit a warning — the export never throws on an image. Identical `src`
 * data URLs embed once and draw many (a cache keyed by src).
 */

import { degrees, rgb, type PDFDocument, type PDFImage } from 'pdf-lib';
import type { PageSink } from './pageSink';
import type { ImageBlock, ImageFragment } from '../layout-engine/types';
import { pageYToPt, pxToPt } from './coords';

const dataUrlMime = (src: string): string => src.match(/^data:([^;,]+)/)?.[1]?.toLowerCase() ?? '';
const dataUrlBytes = (src: string): Uint8Array => {
  const b64 = src.slice(src.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Re-encode arbitrary image bytes to PNG via canvas (browser only). */
async function reencodeToPng(src: string): Promise<Uint8Array | null> {
  if (typeof document === 'undefined') return null;
  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return resolve(null);
        blob
          .arrayBuffer()
          .then((b) => resolve(new Uint8Array(b)))
          .catch(() => resolve(null));
      }, 'image/png');
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export interface ImageEmbedder {
  /** Embed (or fetch from cache) the image for a src; null if unembeddable. */
  embed(src: string): Promise<PDFImage | null>;
}

/** Build a src-keyed embedder over one PDFDocument. */
export function createImageEmbedder(
  doc: PDFDocument,
  onWarning?: (m: string) => void
): ImageEmbedder {
  const cache = new Map<string, PDFImage | null>();
  return {
    async embed(src: string): Promise<PDFImage | null> {
      if (cache.has(src)) return cache.get(src) ?? null;
      let result: PDFImage | null = null;
      try {
        const mime = dataUrlMime(src);
        if (mime === 'image/png') result = await doc.embedPng(dataUrlBytes(src));
        else if (mime === 'image/jpeg' || mime === 'image/jpg')
          result = await doc.embedJpg(dataUrlBytes(src));
        else if (mime === 'image/x-emf' || mime === 'image/x-wmf') {
          onWarning?.(`image format ${mime} is not embeddable; drew placeholder`);
          result = null;
        } else {
          const png = await reencodeToPng(src);
          result = png ? await doc.embedPng(png) : null;
          if (!png)
            onWarning?.(`could not re-encode image (${mime || 'unknown'}); drew placeholder`);
        }
      } catch (e) {
        onWarning?.(`image embed failed: ${String(e)}`);
        result = null;
      }
      cache.set(src, result);
      return result;
    },
  };
}

/** Parse rotation (deg) and horizontal flip out of a CSS transform string. */
function parseTransform(t?: string): { rotateDeg: number; flipX: boolean } {
  if (!t) return { rotateDeg: 0, flipX: false };
  const rot = t.match(/rotate\((-?[\d.]+)deg\)/);
  return { rotateDeg: rot ? parseFloat(rot[1]) : 0, flipX: /scaleX\(\s*-1/.test(t) };
}

export async function drawImageFragment(
  page: PageSink,
  block: ImageBlock,
  fragment: ImageFragment,
  pageHpx: number,
  embedder: ImageEmbedder
): Promise<void> {
  const xPt = pxToPt(fragment.x);
  const yPt = pageYToPt(fragment.y + fragment.height, pageHpx);
  const wPt = pxToPt(fragment.width);
  const hPt = pxToPt(fragment.height);
  const img = await embedder.embed(block.src);
  if (!img) {
    // Placeholder box so the layout still shows where the image is.
    page.drawRectangle({
      x: xPt,
      y: yPt,
      width: wPt,
      height: hPt,
      borderColor: rgb(0.7, 0.7, 0.7),
      borderWidth: 0.5,
      color: rgb(0.96, 0.96, 0.96),
    });
    return;
  }
  const { rotateDeg } = parseTransform(block.transform);
  if (!rotateDeg) {
    page.drawImage(img, { x: xPt, y: yPt, width: wPt, height: hPt });
    return;
  }
  // The painter rotates about the image CENTER (transform-origin: center); CSS
  // `rotate(Ndeg)` is clockwise while pdf-lib `degrees` is counter-clockwise, so
  // negate. pdf-lib rotates about the (x,y) bottom-left anchor — offset the
  // anchor so the center stays fixed.
  const phi = (-rotateDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const cx = xPt + wPt / 2;
  const cy = yPt + hPt / 2;
  const ax = cx - ((wPt / 2) * cos - (hPt / 2) * sin);
  const ay = cy - ((wPt / 2) * sin + (hPt / 2) * cos);
  page.drawImage(img, { x: ax, y: ay, width: wPt, height: hPt, rotate: degrees(-rotateDeg) });
}
