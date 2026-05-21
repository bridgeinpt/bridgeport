/**
 * Pure parsing/substitution helpers for the config scanner.
 *
 * The scanner detects hardcoded values that should be promoted to secrets/vars
 * and rewrites the source files to reference the new variable. This module
 * isolates the line-level parsing so it can be unit-tested without a database.
 */

/**
 * Extract key=value pairs from config file content.
 * Handles env-style (KEY=value) and UPPER_SNAKE_CASE YAML-style (KEY: value).
 *
 * YAML keys are restricted to UPPER_SNAKE_CASE so docker-compose attribute keys
 * (`restart`, `image`, `command`, ...) aren't mistaken for config variables —
 * those produce noisy false positives like extracting `unless-stopped` as `${RESTART}`.
 */
export function extractKeyValues(content: string): Array<{ key: string; value: string }> {
  const results: Array<{ key: string; value: string }> = [];
  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const envMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
    if (envMatch) {
      let value = envMatch[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) {
        results.push({ key: envMatch[1], value });
      }
      continue;
    }

    const yamlMatch = line.match(/^([A-Z][A-Z0-9_]*):\s+(.+)$/);
    if (yamlMatch) {
      let value = yamlMatch[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) {
        results.push({ key: yamlMatch[1], value });
      }
    }
  }

  return results;
}

/**
 * Parse a single line and, if its RHS exactly equals `value`, return the line
 * rewritten to use `placeholder` instead. Returns `null` when the line
 * shouldn't be touched (different shape or substring-only match). The exact-RHS
 * check is what stops `staging` (from `ENVIRONMENT=staging`) from also rewriting
 * `app-staging.bridgein.com` in another setting.
 */
function rewriteLine(rawLine: string, value: string, placeholder: string): string | null {
  const envMatch = rawLine.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (envMatch) {
    const [, indent, key, rhs] = envMatch;
    const trimmedRhs = rhs.trim();
    const quote =
      trimmedRhs.length >= 2 &&
      ((trimmedRhs.startsWith('"') && trimmedRhs.endsWith('"')) ||
        (trimmedRhs.startsWith("'") && trimmedRhs.endsWith("'")))
        ? trimmedRhs[0]
        : '';
    const inner = quote ? trimmedRhs.slice(1, -1) : trimmedRhs;
    if (inner !== value) return null;
    const newRhs = quote ? `${quote}${placeholder}${quote}` : placeholder;
    return `${indent}${key}=${newRhs}`;
  }

  const yamlMatch = rawLine.match(/^(\s*)([A-Z][A-Z0-9_]*):(\s+)(.*)$/);
  if (yamlMatch) {
    const [, indent, key, sep, rhs] = yamlMatch;
    const trimmedRhs = rhs.trim();
    const quote =
      trimmedRhs.length >= 2 &&
      ((trimmedRhs.startsWith('"') && trimmedRhs.endsWith('"')) ||
        (trimmedRhs.startsWith("'") && trimmedRhs.endsWith("'")))
        ? trimmedRhs[0]
        : '';
    const inner = quote ? trimmedRhs.slice(1, -1) : trimmedRhs;
    if (inner !== value) return null;
    const newRhs = quote ? `${quote}${placeholder}${quote}` : placeholder;
    return `${indent}${key}:${sep}${newRhs}`;
  }

  return null;
}

/**
 * Replace `value` with `placeholder` only on lines where it is the entire RHS
 * of a key=value pair. Substring occurrences inside other values are left alone.
 */
export function substituteFullValue(
  content: string,
  value: string,
  placeholder: string
): { newContent: string; replacements: number } {
  const lines = content.split('\n');
  let replacements = 0;
  const newLines = lines.map((line) => {
    const rewritten = rewriteLine(line, value, placeholder);
    if (rewritten === null) return line;
    replacements++;
    return rewritten;
  });
  return { newContent: newLines.join('\n'), replacements };
}
