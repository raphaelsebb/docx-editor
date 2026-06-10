/**
 * WMF/EMF (Windows Metafile) display conversion.
 *
 * Browsers can't decode `image/x-wmf` / `image/x-emf`, so an `<img>` pointed at
 * the raw metafile renders a broken/white box (issues #743, #755). At load we
 * render each metafile to a display data URL stored on `Image.displaySrc`,
 * choosing the best of two engines:
 *
 * - `rtf.js` (WMFJS/EMFJS) → scalable **SVG**: crisp at any size, ideal for
 *   text/vector metafiles. Preferred. But its vector renderer silently drops
 *   record types it doesn't support (e.g. the SetPixel point-plotting common in
 *   CAD-exported drawings), which can leave a sparse near-empty result.
 * - `emf-converter` → Canvas **PNG**: rasterizes everything, so it recovers
 *   those drawings (WMF and EMF alike). Used as a fallback only when rtf.js
 *   comes up sparse and the raster draws substantially more.
 *
 * Each image is rendered at *its own* OOXML display extent so the metafile's
 * window maps onto the box the way Word maps a metafile to its frame.
 *
 * The image's `src` and the `word/media` bytes are left untouched, so a save
 * writes the original metafile back — the round-trip is lossless.
 *
 * The decoder bundles are dynamically imported only when needed (rtf.js when a
 * metafile is present; emf-converter only when a WMF renders sparse), and only
 * in a browser (rendering needs the DOM/Canvas). In Node/headless parsing this
 * is a no-op; the painter — browser-only — falls back to a labeled placeholder
 * for any metafile left unconverted.
 */
import type { Document } from '../types/document';
import type { BlockContent, Image } from '../types/content';
import { emuToPixels } from '../utils/units';

const WMF_MIMES = new Set(['image/x-wmf', 'image/wmf']);
const EMF_MIMES = new Set(['image/x-emf', 'image/emf']);

/** True for a WMF content type (`image/x-wmf`, `image/wmf`). */
export function isWmfMime(mime: string | undefined): boolean {
  return mime !== undefined && WMF_MIMES.has(mime.toLowerCase());
}

/** True for an EMF content type (`image/x-emf`, `image/emf`). */
export function isEmfMime(mime: string | undefined): boolean {
  return mime !== undefined && EMF_MIMES.has(mime.toLowerCase());
}

/** True for any Windows-metafile content type (WMF or EMF). */
export function isMetafileMime(mime: string | undefined): boolean {
  return isWmfMime(mime) || isEmfMime(mime);
}

/**
 * True when a `src`/data URL still points at a raw (unconverted) metafile —
 * i.e. something the browser can't render. The painter uses this to draw a
 * placeholder instead of a broken `<img>`, and the serializer uses it to avoid
 * rewriting an imported metafile on save.
 */
export function isUnrenderableMetafileSrc(src: string | undefined): boolean {
  if (!src) return false;
  const lower = src.slice(0, 40).toLowerCase();
  return (
    lower.startsWith('data:image/x-wmf') ||
    lower.startsWith('data:image/wmf') ||
    lower.startsWith('data:image/x-emf') ||
    lower.startsWith('data:image/emf')
  );
}

/** Which metafile family a raw data-URL src belongs to, or null. */
function metafileKindOfSrc(src: string | undefined): 'wmf' | 'emf' | null {
  if (!src) return null;
  const lower = src.slice(0, 40).toLowerCase();
  if (lower.startsWith('data:image/x-wmf') || lower.startsWith('data:image/wmf')) return 'wmf';
  if (lower.startsWith('data:image/x-emf') || lower.startsWith('data:image/emf')) return 'emf';
  return null;
}

interface MetafileRenderer {
  render(info: {
    width: string;
    height: string;
    xExt: number;
    yExt: number;
    mapMode: number;
  }): SVGElement;
}
interface RtfNamespace {
  Renderer: new (data: ArrayBuffer) => MetafileRenderer;
}

/** Dynamically load the standalone WMFJS/EMFJS bundle (UMD; sets a global). */
async function loadRtfNamespace(kind: 'wmf' | 'emf'): Promise<RtfNamespace | null> {
  try {
    if (kind === 'wmf') {
      // @ts-expect-error rtf.js UMD bundle ships no type declarations
      const mod = await import('rtf.js/dist/WMFJS.bundle.min.js');
      return ((globalThis as { WMFJS?: RtfNamespace }).WMFJS ??
        (mod as { default?: RtfNamespace }).default ??
        (mod as unknown as RtfNamespace)) as RtfNamespace;
    }
    // @ts-expect-error rtf.js UMD bundle ships no type declarations
    const mod = await import('rtf.js/dist/EMFJS.bundle.min.js');
    return ((globalThis as { EMFJS?: RtfNamespace }).EMFJS ??
      (mod as { default?: RtfNamespace }).default ??
      (mod as unknown as RtfNamespace)) as RtfNamespace;
  } catch {
    return null;
  }
}

/** Decode a base64 data URL to its raw bytes. */
function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !/;base64/i.test(dataUrl.slice(0, comma))) return null;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

const HAS_DRAWN = /<(path|rect|text|image|polyline|polygon|line|ellipse|circle|g)\b/i;

/**
 * Render a metafile onto a box of the given display aspect, returning a
 * `data:image/svg+xml` URL, or null on failure. `mapMode` 8 (MM_ANISOTROPIC)
 * maps the metafile's window onto `xExt`/`yExt`, matching Word's window→extent
 * mapping. We render at a higher pixel size than the on-screen box (same aspect)
 * for path precision; the SVG is vector so it scales crisply to any size.
 */
function renderMetafileToSvg(
  data: ArrayBuffer,
  ns: RtfNamespace,
  boxW: number,
  boxH: number
): string | null {
  // Scale the box up so the larger side is ~1024 (precision) while preserving
  // the display aspect, which is what controls window→extent distortion.
  const longest = Math.max(boxW, boxH);
  const scale = longest > 0 ? Math.max(1, 1024 / longest) : 1;
  const rw = Math.max(1, Math.round(boxW * scale));
  const rh = Math.max(1, Math.round(boxH * scale));

  let svg: SVGElement;
  try {
    svg = new ns.Renderer(data).render({
      width: `${rw}px`,
      height: `${rh}px`,
      xExt: rw,
      yExt: rh,
      mapMode: 8,
    });
  } catch {
    return null;
  }
  if (!svg || svg.tagName?.toLowerCase() !== 'svg') return null;
  if (!svg.getAttribute('width')) svg.setAttribute('width', String(rw));
  if (!svg.getAttribute('height')) svg.setAttribute('height', String(rh));
  const xml = new XMLSerializer().serializeToString(svg);
  if (!HAS_DRAWN.test(xml)) return null; // nothing drawn → let placeholder show
  return `data:image/svg+xml,${encodeURIComponent(xml)}`;
}

type MetafileRasterizer = (
  buffer: ArrayBuffer,
  maxWidth?: number,
  maxHeight?: number,
  dpiScale?: number
) => Promise<string | null>;

/** Lazily load the Canvas-based WMF/EMF rasterizers (fallback for record types
 * rtf.js's vector renderer drops, e.g. SetPixel-plotted CAD drawings). */
async function loadRasterizers(): Promise<Record<'wmf' | 'emf', MetafileRasterizer> | null> {
  try {
    const mod = await import('emf-converter');
    return {
      wmf: mod.convertWmfToDataUrl as MetafileRasterizer,
      emf: mod.convertEmfToDataUrl as MetafileRasterizer,
    };
  } catch {
    return null;
  }
}

/**
 * Fraction of opaque, non-white pixels in a rendered image (0–100). Used to
 * tell a richly-drawn result from a near-empty one (e.g. an SVG whose record
 * types the renderer mostly dropped). Samples on a small canvas for speed.
 */
async function measureInkPct(dataUrl: string): Promise<number> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return 0;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUrl;
    });
    const w = Math.max(1, Math.min(img.naturalWidth || 300, 400));
    const h = Math.max(1, Math.min(img.naturalHeight || 300, 400));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let nz = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 16 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) nz++;
    }
    return (100 * nz) / (w * h);
  } catch {
    return 0;
  }
}

// rtf.js renders crisp vector but silently drops unsupported records; a result
// with this much ink is treated as "rendered well" and kept (avoids the raster
// fallback for ordinary vector/text metafiles like a logo or labeled box).
const RTF_GOOD_INK_PCT = 1.2;

/**
 * Render a metafile to a display data URL, choosing the best of two engines:
 * rtf.js (crisp vector) is preferred, but when it comes up sparse (record types
 * it doesn't support, common in CAD exports) we rasterize with the Canvas
 * decoder and keep that if it drew substantially more. Applies to both WMF and
 * EMF. Returns null → painter placeholder.
 */
async function renderBest(
  data: ArrayBuffer,
  kind: 'wmf' | 'emf',
  ns: RtfNamespace,
  box: { w: number; h: number },
  loadRasterizers: () => Promise<Record<'wmf' | 'emf', MetafileRasterizer> | null>
): Promise<string | null> {
  const svg = renderMetafileToSvg(data, ns, box.w, box.h);
  const inkSvg = svg ? await measureInkPct(svg) : 0;
  if (svg && inkSvg >= RTF_GOOD_INK_PCT) return svg;

  // rtf.js was sparse (or empty) — try the raster decoder for this format.
  const rasterize = (await loadRasterizers())?.[kind];
  if (!rasterize) return svg;
  let png: string | null = null;
  try {
    // Oversample for crisp detail in the (typically line-art) drawing.
    const maxSide = Math.max(1500, Math.round(Math.max(box.w, box.h) * 3));
    png = await rasterize(data, maxSide, maxSide, 2);
  } catch {
    png = null;
  }
  if (!png) return svg;
  const inkPng = await measureInkPct(png);
  // Keep the raster only when it drew meaningfully more than the vector did.
  return inkPng > Math.max(inkSvg, 0.1) * 1.5 ? png : svg;
}

/** Display box (px) for a metafile image, from its OOXML extent. */
function displayBox(image: Image): { w: number; h: number } {
  const wRaw = image.size?.width ? emuToPixels(image.size.width) : 0;
  const hRaw = image.size?.height ? emuToPixels(image.size.height) : 0;
  // Fall back to a sane default box when the extent is missing/degenerate.
  const clamp = (n: number) => (n >= 1 && n <= 5000 ? n : 0);
  return { w: clamp(wRaw) || 320, h: clamp(hRaw) || 240 };
}

/** Collect every drawing image in a run (matches the serializer's walk). */
function collectFromRun(run: { content: { type: string; image?: Image }[] }, out: Image[]): void {
  for (const c of run.content) {
    if (c.type === 'drawing' && c.image && metafileKindOfSrc(c.image.src)) out.push(c.image);
  }
}

/** Recursively collect every unconverted metafile image under a block list. */
function collectMetafileImages(blocks: BlockContent[], out: Image[]): void {
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      for (const item of block.content) {
        if (item.type === 'run') {
          collectFromRun(item, out);
        } else if (
          item.type === 'insertion' ||
          item.type === 'deletion' ||
          item.type === 'moveFrom' ||
          item.type === 'moveTo'
        ) {
          for (const sub of item.content) if (sub.type === 'run') collectFromRun(sub, out);
        }
      }
    } else if (block.type === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) collectMetafileImages(cell.content, out);
      }
    }
  }
}

/**
 * Render every embedded WMF/EMF image in a parsed document to an SVG
 * `displaySrc`, each fit to its own display extent. Mutates `Image.displaySrc`
 * in place; `src`/`mimeType` and the `word/media` bytes are untouched (lossless
 * save). No-op outside a browser or if rtf.js fails to load; images left
 * unconverted fall back to the painter's placeholder.
 */
export async function rasterizeMetafileImagesForDisplay(doc: Document): Promise<void> {
  if (typeof document === 'undefined') return; // rtf.js builds SVG via the DOM

  const images: Image[] = [];
  collectMetafileImages(doc.package.document.content, images);
  for (const hf of doc.package.headers?.values() ?? []) collectMetafileImages(hf.content, images);
  for (const hf of doc.package.footers?.values() ?? []) collectMetafileImages(hf.content, images);
  if (images.length === 0) return;

  const [wmfNs, emfNs] = await Promise.all([
    images.some((i) => metafileKindOfSrc(i.src) === 'wmf')
      ? loadRtfNamespace('wmf')
      : Promise.resolve(null),
    images.some((i) => metafileKindOfSrc(i.src) === 'emf')
      ? loadRtfNamespace('emf')
      : Promise.resolve(null),
  ]);

  // Load the raster fallback at most once, and only if some metafile needs it.
  let rasterizers: Record<'wmf' | 'emf', MetafileRasterizer> | null | undefined;
  const getRasterizers = async () => {
    if (rasterizers === undefined) rasterizers = await loadRasterizers();
    return rasterizers;
  };

  // The same metafile can appear several times at the same size — render once.
  const cache = new Map<string, string | null>();
  for (const image of images) {
    const kind = metafileKindOfSrc(image.src);
    const ns = kind === 'wmf' ? wmfNs : kind === 'emf' ? emfNs : null;
    if (!ns || !kind || !image.src) continue;
    const box = displayBox(image);
    const key = `${image.src.length}:${image.src.slice(-32)}:${Math.round(box.w)}x${Math.round(box.h)}`;
    let display = cache.get(key);
    if (display === undefined) {
      const data = dataUrlToArrayBuffer(image.src);
      display = data ? await renderBest(data, kind, ns, box, getRasterizers) : null;
      cache.set(key, display);
    }
    if (display) image.displaySrc = display;
  }
}
