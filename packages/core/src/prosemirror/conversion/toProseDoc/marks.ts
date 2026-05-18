/**
 * TextFormatting → PM marks projection (Document → ProseMirror direction).
 *
 * The inverse of `fromProseDoc/marks.ts`. Maps every OOXML-shaped
 * `TextFormatting` field (bold/italic/underline/color/font/effect/etc.)
 * onto the matching `schema.mark(...)` call. Also owns `resolveTextFormatting`
 * which threads the character-style cascade so runs without an explicit
 * `<w:rStyle>` still inherit from the default character style (§17.7.4.18).
 */

import { schema } from '../../schema';
import type { TextFormatting } from '../../../types/document';
import { mergeTextFormatting } from '../../../utils/textFormattingMerge';
import type { StyleResolver } from '../../styles';

/**
 * Convert TextFormatting to ProseMirror marks
 */
export function textFormattingToMarks(
  formatting: TextFormatting | undefined
): ReturnType<typeof schema.mark>[] {
  if (!formatting) return [];

  const marks: ReturnType<typeof schema.mark>[] = [];

  // Bold
  if (formatting.bold) {
    marks.push(schema.mark('bold'));
  }

  // Italic
  if (formatting.italic) {
    marks.push(schema.mark('italic'));
  }

  // Underline
  if (formatting.underline && formatting.underline.style !== 'none') {
    marks.push(
      schema.mark('underline', {
        style: formatting.underline.style,
        color: formatting.underline.color,
      })
    );
  }

  // Strikethrough
  if (formatting.strike || formatting.doubleStrike) {
    marks.push(
      schema.mark('strike', {
        double: formatting.doubleStrike || false,
      })
    );
  }

  // Text color
  if (formatting.color && !formatting.color.auto) {
    marks.push(
      schema.mark('textColor', {
        rgb: formatting.color.rgb,
        themeColor: formatting.color.themeColor,
        themeTint: formatting.color.themeTint,
        themeShade: formatting.color.themeShade,
      })
    );
  }

  // Highlight
  if (formatting.highlight && formatting.highlight !== 'none') {
    marks.push(
      schema.mark('highlight', {
        color: formatting.highlight,
      })
    );
  }

  // Font size
  if (formatting.fontSize) {
    marks.push(
      schema.mark('fontSize', {
        size: formatting.fontSize,
      })
    );
  }

  // Font family
  if (formatting.fontFamily) {
    marks.push(
      schema.mark('fontFamily', {
        ascii: formatting.fontFamily.ascii,
        hAnsi: formatting.fontFamily.hAnsi,
        eastAsia: formatting.fontFamily.eastAsia,
        cs: formatting.fontFamily.cs,
        asciiTheme: formatting.fontFamily.asciiTheme,
        hAnsiTheme: formatting.fontFamily.hAnsiTheme,
        eastAsiaTheme: formatting.fontFamily.eastAsiaTheme,
        csTheme: formatting.fontFamily.csTheme,
      })
    );
  }

  // Superscript/Subscript
  if (formatting.vertAlign === 'superscript') {
    marks.push(schema.mark('superscript'));
  } else if (formatting.vertAlign === 'subscript') {
    marks.push(schema.mark('subscript'));
  }

  // All caps (w:caps)
  if (formatting.allCaps) {
    marks.push(schema.mark('allCaps'));
  }

  // Small caps (w:smallCaps)
  if (formatting.smallCaps) {
    marks.push(schema.mark('smallCaps'));
  }

  // Character spacing (spacing, position, scale, kerning)
  if (
    formatting.spacing != null ||
    formatting.position != null ||
    formatting.scale != null ||
    formatting.kerning != null
  ) {
    marks.push(
      schema.mark('characterSpacing', {
        spacing: formatting.spacing ?? null,
        position: formatting.position ?? null,
        scale: formatting.scale ?? null,
        kerning: formatting.kerning ?? null,
      })
    );
  }

  // Emboss (w:emboss)
  if (formatting.emboss) {
    marks.push(schema.mark('emboss'));
  }

  // Imprint/Engrave (w:imprint)
  if (formatting.imprint) {
    marks.push(schema.mark('imprint'));
  }

  // Text shadow (w:shadow)
  if (formatting.shadow) {
    marks.push(schema.mark('textShadow'));
  }

  // Emphasis mark (w:em)
  if (formatting.emphasisMark && formatting.emphasisMark !== 'none') {
    marks.push(schema.mark('emphasisMark', { type: formatting.emphasisMark }));
  }

  // Text outline (w:outline)
  if (formatting.outline) {
    marks.push(schema.mark('textOutline'));
  }

  // Hidden text (w:vanish)
  if (formatting.hidden) {
    marks.push(schema.mark('hidden'));
  }

  // Per-run RTL (w:rtl) — independent of paragraph direction
  if (formatting.rtl) {
    marks.push(schema.mark('rtl'));
  }

  // Text effect animations (w:effect)
  if (formatting.effect && formatting.effect !== 'none') {
    marks.push(schema.mark('textEffect', { effect: formatting.effect }));
  }

  return marks;
}

/**
 * Resolve a run's TextFormatting against the character-style cascade.
 *
 * Even when the run has no explicit <w:rStyle>, OOXML §17.7.4.18 says it
 * still inherits from the default character style. resolveRunStyle(undef)
 * returns docDefaults.rPr merged with the default character style's rPr —
 * without this path, runs without a styleId lose any property the default
 * character style sets.
 */
export function resolveTextFormatting(
  formatting: TextFormatting | undefined,
  styleResolver: StyleResolver | null
): TextFormatting | undefined {
  if (!formatting) return undefined;
  if (!styleResolver) return formatting;

  const styleFormatting = styleResolver.resolveRunStyle(formatting.styleId);
  if (!styleFormatting) return formatting;
  return mergeTextFormatting(styleFormatting, formatting);
}
