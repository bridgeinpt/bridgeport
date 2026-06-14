import { EditorView, type Extension } from '@uiw/react-codemirror';
import {
  HighlightStyle,
  defaultHighlightStyle,
  syntaxHighlighting,
  type TagStyle,
} from '@codemirror/language';

/**
 * Deep Slate CodeMirror theme.
 *
 * Replaces the off-brand Dracula theme (purple/pink) with a palette that
 * matches the BRIDGEPORT "Deep Slate" app tokens. Built from two pieces:
 *
 *  1. `slateEditorChrome` — an `EditorView.theme(...)` covering the editor
 *     surface, gutter, caret, selection, active line and line numbers.
 *  2. `slateHighlightStyle` — a syntax `HighlightStyle` derived from
 *     CodeMirror's `defaultHighlightStyle`. We reuse the default specs (which
 *     carry the lezer `Tag` objects) and only swap their colors into the slate
 *     family. This avoids importing `tags` from `@lezer/highlight`, which is
 *     not a direct dependency of the `ui` package and therefore does not
 *     resolve here.
 *
 * Deep Slate palette (hex):
 *   bg `#0a0e14`, gutter `#11161f`, fg `#f1f5f9`, caret/sky `#0284c7`,
 *   selection `#1f2733`, comment `#8b97a8`, line-number `#64748b`,
 *   keyword sky `#38bdf8`, string green `#34d399`, number amber `#fbbf24`.
 */

const palette = {
  background: '#0a0e14',
  gutterBackground: '#11161f',
  foreground: '#f1f5f9',
  caret: '#0284c7',
  selection: '#1f2733',
  comment: '#8b97a8',
  lineNumber: '#64748b',
  lineNumberActive: '#cbd5e1',
  activeLine: '#11161f',
  border: '#334155',
  // Syntax family (slate / sky / green / amber — no purple/pink).
  keyword: '#38bdf8',
  string: '#34d399',
  number: '#fbbf24',
  literal: '#34d399',
  variable: '#cbd5e1',
  type: '#22d3ee',
  className: '#22d3ee',
  property: '#7dd3fc',
  atom: '#7dd3fc',
  macro: '#5eead4',
  meta: '#64748b',
  invalid: '#f87171',
} as const;

const slateEditorChrome: Extension = EditorView.theme(
  {
    '&': {
      color: palette.foreground,
      backgroundColor: palette.background,
    },
    '.cm-content': {
      caretColor: palette.caret,
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: palette.caret,
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: palette.caret,
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      {
        backgroundColor: palette.selection,
      },
    '.cm-activeLine': {
      backgroundColor: palette.activeLine,
    },
    '.cm-activeLineGutter': {
      backgroundColor: palette.activeLine,
      color: palette.lineNumberActive,
    },
    '.cm-gutters': {
      backgroundColor: palette.gutterBackground,
      color: palette.lineNumber,
      border: 'none',
      borderRight: `1px solid ${palette.border}`,
    },
    '.cm-lineNumbers .cm-gutterElement': {
      color: palette.lineNumber,
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'transparent',
      border: 'none',
      color: palette.comment,
    },
    '.cm-selectionMatch': {
      backgroundColor: palette.selection,
    },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'transparent',
      outline: `1px solid ${palette.caret}`,
    },
    '.cm-panels': {
      backgroundColor: palette.gutterBackground,
      color: palette.foreground,
    },
  },
  { dark: true },
);

/**
 * Remap a default-highlight color (CodeMirror's built-in light palette) to the
 * Deep Slate equivalent. Anything not explicitly mapped falls back to the
 * editor foreground so no off-brand color survives.
 */
const colorRemap: Record<string, string> = {
  '#708': palette.keyword, // keyword
  '#219': palette.atom, // atom, bool, url, contentSeparator, labelName
  '#164': palette.literal, // literal, inserted
  '#a11': palette.string, // string, deleted
  '#e40': palette.number, // regexp, escape, special string
  '#00f': palette.variable, // variable definition
  '#30a': palette.variable, // local variable
  '#085': palette.type, // typeName, namespace
  '#167': palette.className, // className
  '#256': palette.macro, // special variable, macroName
  '#00c': palette.property, // property definition
  '#940': palette.comment, // comment
  '#f00': palette.invalid, // invalid
  '#404740': palette.meta, // meta
};

const slateSpecs: TagStyle[] = defaultHighlightStyle.specs.map((spec) => {
  // Preserve the tag(s) from the default spec; only override styling so we
  // never need to import `tags` from `@lezer/highlight` (not resolvable here).
  const next: TagStyle = { tag: spec.tag };
  if (typeof spec.color === 'string') {
    next.color = colorRemap[spec.color] ?? palette.foreground;
  }
  if (typeof spec.fontStyle === 'string') next.fontStyle = spec.fontStyle;
  if (typeof spec.fontWeight === 'string') next.fontWeight = spec.fontWeight;
  if (typeof spec.textDecoration === 'string') {
    next.textDecoration = spec.textDecoration;
  }
  return next;
});

const slateHighlightStyle = HighlightStyle.define(slateSpecs);

/**
 * Deep Slate theme for the BRIDGEPORT config-file editor. Pass directly to
 * `@uiw/react-codemirror`'s `theme` prop.
 */
export const slateCodeMirrorTheme: Extension = [
  slateEditorChrome,
  syntaxHighlighting(slateHighlightStyle),
];
