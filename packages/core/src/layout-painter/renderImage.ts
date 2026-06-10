/**
 * Image Renderer
 *
 * Renders image fragments to DOM. Handles:
 * - Inline images
 * - Anchored/floating images with z-index layering
 * - Basic image sizing
 */

import type { ImageFragment, ImageBlock, ImageMeasure } from '../layout-engine/types';
import type { RenderContext } from './renderPage';

/**
 * CSS class names for image elements
 */
export const IMAGE_CLASS_NAMES = {
  image: 'layout-image',
  imageAnchored: 'layout-image-anchored',
};

/**
 * Structural shape required to apply Word's per-image visual attributes:
 * `wp:srcRect` crop fractions, `a:alphaModFix` opacity, and `wp:effectExtent`
 * reservation. `ImageRun`, `FloatingImagePaintRecord`, and `PageFloatingImage`
 * all satisfy this — no adapter needed at the call sites.
 *
 * effectExtent is intentionally NOT applied to CSS: per ECMA-376 §20.4.2.5
 * it's a hint to the wrap engine about the visual bounding box, not a request
 * to shift the picture. Applying it as `margin` would push the image (or its
 * siblings) instead of reserving space for a shadow that we don't draw. We
 * keep the values on the model so they round-trip cleanly; if a real shadow
 * effect ships later, the reservation becomes meaningful.
 */
export interface ImageVisualAttrs {
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
  opacity?: number;
}

/**
 * True when any visual attribute is set. Cheap call-site guard so the no-op
 * common case skips the function call and template-literal allocations.
 *
 * IMPORTANT: ProseMirror schema attrs default to `null`, not `undefined`,
 * and that `null` survives the `as number | undefined` cast in the layout
 * bridge. Use `!= null` rather than `!== undefined` so a default-null
 * opacity isn't read as `0` (`null < 1` is `true`, `Math.max(0, null)` is
 * `0`) — that bug hid every image behind `opacity: 0`.
 */
export function hasImageVisualAttrs(v: ImageVisualAttrs): boolean {
  return Boolean(
    v.cropTop || v.cropRight || v.cropBottom || v.cropLeft || (v.opacity != null && v.opacity < 1)
  );
}

/**
 * Apply crop and opacity to an `<img>` element. Caller should gate with
 * `hasImageVisualAttrs(v)` to avoid the function call for plain images.
 */
export function applyImageVisualAttrs(img: HTMLImageElement, v: ImageVisualAttrs): void {
  const top = v.cropTop ?? 0;
  const right = v.cropRight ?? 0;
  const bottom = v.cropBottom ?? 0;
  const left = v.cropLeft ?? 0;
  if (top || right || bottom || left) {
    img.style.clipPath = `inset(${top * 100}% ${right * 100}% ${bottom * 100}% ${left * 100}%)`;
  }
  if (v.opacity != null && v.opacity < 1) {
    img.style.opacity = String(Math.max(0, v.opacity));
  }
}

/**
 * Options for rendering an image fragment
 */
export interface RenderImageFragmentOptions {
  document?: Document;
}

/**
 * Render an image fragment to DOM
 *
 * @param fragment - The image fragment to render
 * @param block - The full image block
 * @param measure - The image measure
 * @param context - Rendering context
 * @param options - Rendering options
 * @returns The image DOM element
 */
export function renderImageFragment(
  fragment: ImageFragment,
  block: ImageBlock,
  _measure: ImageMeasure,
  _context: RenderContext,
  options: RenderImageFragmentOptions = {}
): HTMLElement {
  const doc = options.document ?? document;

  // Create container div
  const containerEl = doc.createElement('div');
  containerEl.className = IMAGE_CLASS_NAMES.image;

  if (fragment.isAnchored) {
    containerEl.classList.add(IMAGE_CLASS_NAMES.imageAnchored);
  }

  // Basic styling
  containerEl.style.position = 'absolute';
  containerEl.style.width = `${fragment.width}px`;
  containerEl.style.height = `${fragment.height}px`;
  containerEl.style.overflow = 'hidden';

  // Z-index for layering
  if (fragment.zIndex !== undefined) {
    containerEl.style.zIndex = String(fragment.zIndex);
  }

  // Behind document flag
  if (block.anchor?.behindDoc) {
    containerEl.style.zIndex = '-1';
  }

  // Store metadata
  containerEl.dataset.blockId = String(fragment.blockId);

  if (fragment.pmStart !== undefined) {
    containerEl.dataset.pmStart = String(fragment.pmStart);
  }
  if (fragment.pmEnd !== undefined) {
    containerEl.dataset.pmEnd = String(fragment.pmEnd);
  }

  // Windows metafile (WMF/EMF) the browser can't decode: show a labeled
  // placeholder instead of a broken/white <img> (#743, #755). Metafiles are
  // normally rendered to SVG at load; this catches any left unconverted
  // (headless parse with no DOM, or a render failure).
  const metafileKind = metafilePlaceholderKind(block.src);
  if (metafileKind) {
    containerEl.appendChild(buildMetafilePlaceholder(doc, metafileKind));
    return containerEl;
  }

  // Create the actual image element
  const imgEl = doc.createElement('img');
  imgEl.src = block.src;
  imgEl.alt = block.alt ?? '';

  // Image sizing
  imgEl.style.width = '100%';
  imgEl.style.height = '100%';
  imgEl.style.objectFit = 'contain';
  imgEl.style.display = 'block';

  // Apply transform if present (rotation, flip)
  if (block.transform) {
    imgEl.style.transform = block.transform;
  }

  // Prevent dragging
  imgEl.draggable = false;

  // Wrap in hyperlink if image has a link
  if (block.hlinkHref) {
    const linkEl = doc.createElement('a');
    linkEl.href = block.hlinkHref;
    linkEl.target = '_blank';
    linkEl.rel = 'noopener noreferrer';
    linkEl.style.display = 'block';
    linkEl.style.width = '100%';
    linkEl.style.height = '100%';
    linkEl.appendChild(imgEl);
    containerEl.appendChild(linkEl);
  } else {
    containerEl.appendChild(imgEl);
  }

  return containerEl;
}

/**
 * Identify a `src` that still points at a Windows metafile the browser can't
 * render — `data:image/x-wmf` / `image/x-emf` (and their non-`x-` variants).
 * Returns `'WMF'` / `'EMF'` for the placeholder label, else `null`. Shared by
 * the block (this file) and inline (`renderParagraph/runs`) image paths.
 */
export function metafilePlaceholderKind(src: string | undefined): 'WMF' | 'EMF' | null {
  if (!src) return null;
  const head = src.slice(0, 32).toLowerCase();
  if (head.startsWith('data:image/x-wmf') || head.startsWith('data:image/wmf')) return 'WMF';
  if (head.startsWith('data:image/x-emf') || head.startsWith('data:image/emf')) return 'EMF';
  return null;
}

/**
 * A placeholder for a metafile that can't be displayed — a dashed frame
 * labeled with the format identifier (`WMF`/`EMF`) so users see that content
 * exists rather than a blank/broken box (#743, #755). The label is the format
 * acronym only (a universal identifier like `PNG`/`PDF`, not translatable
 * prose), so the painter — which has no i18n — stays locale-neutral; the
 * acronym is hidden on boxes too small to fit it. Pass `width`/`height` (px)
 * for an inline run; omit them to fill a sized block container. Inline styles
 * because painter output isn't covered by the editor's scoped Tailwind.
 */
export function buildMetafilePlaceholder(
  doc: Document,
  kind: 'WMF' | 'EMF',
  opts: { width?: number; height?: number } = {}
): HTMLElement {
  const el = doc.createElement('div');
  el.className = `${IMAGE_CLASS_NAMES.image}-metafile-placeholder`;
  el.dataset.metafileKind = kind;
  el.title = kind;
  const sized = opts.width !== undefined && opts.height !== undefined;
  // Only show the acronym when the box is large enough to fit it; otherwise the
  // dashed frame alone marks the spot (tiny inline icons would just clip text).
  const fitsLabel = !sized || ((opts.width ?? 0) >= 44 && (opts.height ?? 0) >= 16);
  if (fitsLabel) el.textContent = kind;
  Object.assign(el.style, {
    width: sized ? `${opts.width}px` : '100%',
    height: sized ? `${opts.height}px` : '100%',
    boxSizing: 'border-box',
    display: sized ? 'inline-flex' : 'flex',
    verticalAlign: sized ? 'middle' : '',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px dashed #9ca3af',
    background: '#f3f4f6',
    color: '#6b7280',
    font: '11px system-ui, sans-serif',
    letterSpacing: '0.05em',
    textAlign: 'center',
    overflow: 'hidden',
    userSelect: 'none',
  } as Partial<CSSStyleDeclaration>);
  return el;
}
