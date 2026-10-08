import type { Paragraph, RunStyle, TextBody, Theme } from '../deck.ts'
import { cssColor, fontStack, resolveFont } from '../themes.ts'
import { effectiveStyle, paragraphIndent } from '../text.ts'

/*
 * How text looks in CSS, worked out once for the slide and the text editor alike, so text does not
 * move when editing starts. Sizes are points as CSS pixels times `--hs-shrink`, the factor a box
 * that shrinks its text to fit sets on its text.
 */

/** Single spacing as a multiple of the font size, close to PowerPoint's for most fonts. */
export const SINGLE_SPACING = 1.2

export const shrunk = (points: number): string => `calc(${Math.round(points * 100) / 100}px * var(--hs-shrink, 1))`

export type Css = Record<string, string | number>

/** A run's CSS from its full style. */
export function runCss(style: RunStyle & { font: string; size: number; color: string }, theme: Theme): Css {
  const decorations = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean).join(' ')
  const css: Css = {
    fontFamily: fontStack(resolveFont(style.font, theme)),
    fontSize: shrunk(style.size),
    color: cssColor(style.color, theme),
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    textDecoration: decorations || 'none'
  }

  if (style.highlight) {
    css.backgroundColor = cssColor(style.highlight, theme)
  }

  return css
}

/** The body's own CSS, for the box that holds its paragraphs (and what typing into it starts with). */
export function flowCss(body: TextBody, theme: Theme): Css {
  return runCss({ ...body.style, font: body.style.font, size: body.style.size, color: body.style.color }, theme)
}

/**
 * A paragraph's CSS: alignment, indents, spacing and line height, and the font of its first run,
 * which sizes an empty line and the list marker as PowerPoint sizes them.
 */
export function paragraphCss(paragraph: Paragraph, body: TextBody, theme: Theme, marker: string | null): Css {
  const first = effectiveStyle(paragraph.runs[0] ?? {}, body)
  const { margin, indent } = paragraphIndent(paragraph)
  const css: Css = {
    textAlign: paragraph.align ?? 'left',
    lineHeight: SINGLE_SPACING * (paragraph.lineSpacing ?? 1),
    fontSize: shrunk(first.size),
    fontFamily: fontStack(resolveFont(first.font, theme)),
    color: cssColor(first.color, theme)
  }

  if (margin) css.paddingLeft = `${margin}px`
  if (indent) css.textIndent = `${indent}px`
  if (paragraph.spaceBefore) css.marginTop = shrunk(paragraph.spaceBefore)
  if (paragraph.spaceAfter) css.marginBottom = shrunk(paragraph.spaceAfter)

  if (marker) {
    css['--hs-hang'] = indent < 0 ? `${-indent}px` : 'auto'
    css['--hs-gap'] = indent < 0 ? '0' : '0.4em'
  }

  return css
}

const kebab = (key: string): string => (key.startsWith('--') ? key : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`))

/** CSS as a style attribute's text (for the editor's nodes and marks). */
export const styleText = (css: Css): string =>
  Object.entries(css)
    .map(([key, value]) => `${kebab(key)}: ${value}`)
    .join('; ')
