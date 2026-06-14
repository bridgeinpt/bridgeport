import { useMemo, type ReactElement } from 'react';
import CodeMirror, { type Extension } from '@uiw/react-codemirror';
import { slateCodeMirrorTheme } from './codemirror-theme';
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { sql } from '@codemirror/lang-sql';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { properties } from '@codemirror/legacy-modes/mode/properties';

/**
 * Supported syntax-highlighting languages. Keep the literal string values in
 * sync with `src/lib/config-file-language.ts` on the backend — that helper is
 * what decides the default `language` value for new config files.
 */
export const SUPPORTED_LANGUAGES = [
  'plaintext',
  'yaml',
  'json',
  'env',
  'toml',
  'ini',
  'conf',
  'sh',
  'dockerfile',
  'nginx',
  'sql',
] as const;

export type ConfigFileLanguage = (typeof SUPPORTED_LANGUAGES)[number] | string;

function languageExtension(language: string): Extension[] {
  switch (language) {
    case 'yaml':
      return [yaml()];
    case 'json':
      return [json()];
    case 'sql':
      return [sql()];
    case 'sh':
      return [StreamLanguage.define(shell)];
    case 'dockerfile':
      return [StreamLanguage.define(dockerFile)];
    case 'toml':
      return [StreamLanguage.define(toml)];
    case 'nginx':
    case 'conf':
      return [StreamLanguage.define(nginx)];
    case 'env':
    case 'ini':
      return [StreamLanguage.define(properties)];
    default:
      return [];
  }
}

interface ConfigFileEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  /** Read-only renders the value with syntax highlighting but no editing. */
  readOnly?: boolean;
  /** Visible editor height (CSS string, e.g. "60vh"). Default: "20rem". */
  height?: string;
  /** Auto-focus on mount. */
  autoFocus?: boolean;
  /** Optional extra className for the wrapping element. */
  className?: string;
}

/**
 * CodeMirror-based editor for BRIDGEPORT config files. Wraps `@uiw/react-codemirror`
 * with a dark theme matching the rest of the UI and a curated set of language
 * packs (yaml, json, sh, dockerfile, ...). Use in both edit forms and read-only
 * file previews; pass `readOnly` to disable input.
 */
export function ConfigFileEditor({
  value,
  onChange,
  language = 'plaintext',
  readOnly = false,
  height = '20rem',
  autoFocus = false,
  className,
}: ConfigFileEditorProps): ReactElement {
  const extensions = useMemo(() => languageExtension(language), [language]);

  return (
    <div
      className={`overflow-hidden rounded-lg border border-border ${className ?? ''}`}
    >
      <CodeMirror
        value={value}
        height={height}
        theme={slateCodeMirrorTheme}
        extensions={extensions}
        editable={!readOnly}
        readOnly={readOnly}
        autoFocus={autoFocus}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
        }}
        onChange={onChange ? (val) => onChange(val) : undefined}
      />
    </div>
  );
}
