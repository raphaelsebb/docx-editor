/**
 * Office-font substitutes for headless layout measurement.
 *
 * Word documents typically reference proprietary Microsoft fonts (Calibri,
 * Cambria, Aptos) that aren't installed on most Node/Bun machines. The
 * browser editor compensates by loading Google's Croscore substitutes via
 * `<link>` injection (Carlito for Calibri, Caladea for Cambria, etc.).
 * `measureContainer.buildFontString` then emits a CSS cascade
 * `"Calibri", "Carlito", "Arial", "Helvetica", sans-serif` and Chromium's
 * `measureText` resolves to the loaded substitute.
 *
 * `@napi-rs/canvas` honors the same CSS cascade. We just need to register
 * the substitutes under their real Google Font names. This module downloads
 * a fixed set on first use, caches them under the OS temp dir, and feeds
 * them to `GlobalFonts.register`. Subsequent runs hit the cache.
 *
 * Failure modes (no network, restricted FS, etc.) are all silent — the
 * caller's fallback stack still resolves to system defaults, just with
 * slightly different metrics.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface SubstituteFont {
  /**
   * Family names to register the TTF under. We register a single TTF under
   * both its real name (`Carlito`) AND every Word font it substitutes for
   * (`Calibri`, `Calibri Light`). That way:
   *
   *   1. The CSS cascade `"Calibri", "Carlito", "Arial"...` resolves at the
   *      first hit instead of falling through to canvas defaults.
   *   2. Docs that reference fonts with no Croscore equivalent (`Aptos`,
   *      `Aptos Display`) still get sane sans-serif metrics.
   */
  names: string[];
  /** Direct TTF download URL. */
  url: string;
  /** Style variant. */
  style: 'regular' | 'bold' | 'italic' | 'bolditalic';
}

const SUBSTITUTES: SubstituteFont[] = [
  // Carlito (Calibri replacement). Also serves Aptos because Aptos is a
  // Calibri successor with similar metrics.
  {
    names: ['Carlito', 'Calibri', 'Calibri Light', 'Aptos', 'Aptos Display', 'Aptos Narrow'],
    style: 'regular',
    url: 'https://github.com/googlefonts/carlito/raw/main/fonts/ttf/Carlito-Regular.ttf',
  },
  {
    names: ['Carlito', 'Calibri', 'Calibri Light', 'Aptos', 'Aptos Display', 'Aptos Narrow'],
    style: 'bold',
    url: 'https://github.com/googlefonts/carlito/raw/main/fonts/ttf/Carlito-Bold.ttf',
  },
  {
    names: ['Carlito', 'Calibri', 'Calibri Light', 'Aptos', 'Aptos Display', 'Aptos Narrow'],
    style: 'italic',
    url: 'https://github.com/googlefonts/carlito/raw/main/fonts/ttf/Carlito-Italic.ttf',
  },
  {
    names: ['Carlito', 'Calibri', 'Calibri Light', 'Aptos', 'Aptos Display', 'Aptos Narrow'],
    style: 'bolditalic',
    url: 'https://github.com/googlefonts/carlito/raw/main/fonts/ttf/Carlito-BoldItalic.ttf',
  },
  // Caladea (Cambria replacement).
  {
    names: ['Caladea', 'Cambria'],
    style: 'regular',
    url: 'https://github.com/huertatipografica/Caladea/raw/master/fonts/ttf/Caladea-Regular.ttf',
  },
  {
    names: ['Caladea', 'Cambria'],
    style: 'bold',
    url: 'https://github.com/huertatipografica/Caladea/raw/master/fonts/ttf/Caladea-Bold.ttf',
  },
  // Arimo (Arial replacement). Also catches the CSS cascade for Aptos/Helvetica.
  {
    names: ['Arimo', 'Arial', 'Helvetica'],
    style: 'regular',
    url: 'https://github.com/googlefonts/Arimo/raw/main/fonts/ttf/Arimo-Regular.ttf',
  },
  {
    names: ['Arimo', 'Arial', 'Helvetica'],
    style: 'bold',
    url: 'https://github.com/googlefonts/Arimo/raw/main/fonts/ttf/Arimo-Bold.ttf',
  },
  // Tinos (Times New Roman replacement).
  {
    names: ['Tinos', 'Times New Roman', 'Times', 'Georgia'],
    style: 'regular',
    url: 'https://github.com/googlefonts/tinos/raw/main/fonts/ttf/Tinos-Regular.ttf',
  },
  {
    names: ['Tinos', 'Times New Roman', 'Times', 'Georgia'],
    style: 'bold',
    url: 'https://github.com/googlefonts/tinos/raw/main/fonts/ttf/Tinos-Bold.ttf',
  },
  // Cousine (Courier New replacement).
  {
    names: ['Cousine', 'Courier New', 'Courier', 'Consolas', 'Monaco', 'monospace'],
    style: 'regular',
    url: 'https://github.com/googlefonts/cousine/raw/main/fonts/ttf/Cousine-Regular.ttf',
  },
];

let registerOnce: Promise<boolean> | undefined;

/**
 * Ensure the Office-font substitutes are registered with `GlobalFonts`.
 * Memoized per process. Safe to call multiple times.
 *
 * Accepts the lazy-loaded `@napi-rs/canvas` module so the caller controls
 * when the native binary is loaded.
 *
 * On failure (no network, no writable temp dir, etc.) the memo is cleared
 * so the next call gets a fresh attempt rather than being permanently
 * stuck with partially-registered fonts.
 */
export async function registerOfficeSubstitutes(
  canvasMod: typeof import('@napi-rs/canvas')
): Promise<void> {
  if (registerOnce) {
    await registerOnce;
    return;
  }
  const attempt = (async (): Promise<boolean> => {
    const cacheDir = join(tmpdir(), 'eigenpal-docx-fonts');
    try {
      await mkdir(cacheDir, { recursive: true });
    } catch {
      return false;
    }
    let registered = 0;
    await Promise.all(
      SUBSTITUTES.map(async (font) => {
        // Cache file keyed by primary (real) family name + style.
        const filename = `${font.names[0]}-${font.style}.ttf`;
        const path = join(cacheDir, filename);
        let bytes: Buffer | undefined;
        try {
          await stat(path);
          bytes = await readFile(path);
        } catch {
          try {
            const res = await fetch(font.url);
            if (!res.ok) return;
            bytes = Buffer.from(await res.arrayBuffer());
            await writeFile(path, bytes);
          } catch {
            return;
          }
        }
        if (!bytes) return;
        for (const name of font.names) {
          try {
            canvasMod.GlobalFonts.register(bytes, name);
            registered += 1;
          } catch {
            // Already registered or font format unsupported by this build.
          }
        }
      })
    );
    return registered > 0;
  })();
  registerOnce = attempt;
  const ok = await attempt;
  if (!ok) registerOnce = undefined;
}
