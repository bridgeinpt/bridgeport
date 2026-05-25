/**
 * Config-file template engine: server-iteration syntax.
 *
 * Supports a Go-style `{{range servers ...}}<body>{{end}}` block that iterates
 * over a set of servers matching the given filters (tag, name glob, environment).
 * Inside the body, `{{.field}}` interpolates per-server attributes.
 *
 * Available filters:
 *   - tag="web"             matches servers whose `tags` array contains "web"
 *   - name="api-*"          glob match on server name (supports `*` and `?`)
 *   - environment="staging" defaults to the caller's environment when omitted
 *
 * Available fields (inside a range body):
 *   - name, hostname, publicIp, privateIp (alias of hostname), id, tags
 *
 * Notes:
 *   - This engine intentionally does NOT interpret `${KEY}` placeholders; that
 *     stage runs separately. All other `{{...}}` content passes through
 *     unchanged so existing usage-tracking semantics are preserved.
 *   - Nested `{{range}}` blocks are rejected with a templateError.
 *   - Unclosed `{{range}}` blocks are reported as a templateError and the
 *     unterminated content is left in place (no exception thrown).
 *   - Ordering is deterministic: servers are emitted alphabetically by name.
 */

import { safeJsonParse } from '../lib/helpers.js';

export interface TemplateServer {
  id: string;
  name: string;
  hostname: string;
  publicIp: string | null;
  tags: string[];
  environmentId: string;
}

export interface TemplateServerFilters {
  tag?: string;
  name?: string;
  environment?: string;
}

export interface TemplateContext {
  currentEnvironmentId: string;
  /** Resolve a list of servers matching the given filters. Must return
   *  servers sorted alphabetically by name for deterministic output. */
  listServers: (filters: TemplateServerFilters) => Promise<TemplateServer[]>;
}

export interface TemplateResult {
  content: string;
  errors: string[];
}

const VALID_FIELDS = new Set([
  'name',
  'hostname',
  'publicIp',
  'privateIp',
  'id',
  'tags',
]);

const VALID_FILTER_KEYS = new Set(['tag', 'name', 'environment']);

/** Compile a glob pattern (supports `*` and `?`) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Parse a server attribute into its rendered string form. */
function renderField(server: TemplateServer, field: string): string {
  switch (field) {
    case 'name':
      return server.name;
    case 'hostname':
      return server.hostname;
    case 'privateIp':
      return server.hostname;
    case 'publicIp':
      return server.publicIp ?? '';
    case 'id':
      return server.id;
    case 'tags':
      return server.tags.join(',');
    default:
      return '';
  }
}

/**
 * Parse the head of a range directive, e.g.
 *   `range servers tag="web" name="api-*"`
 * Returns the parsed filters, or an error string.
 */
function parseRangeHead(
  head: string
): { filters: TemplateServerFilters } | { error: string } {
  const trimmed = head.trim();

  // Must start with `range servers` (allow extra whitespace).
  const rangeMatch = /^range\s+servers\b\s*(.*)$/.exec(trimmed);
  if (!rangeMatch) {
    return { error: `Invalid range directive: "${head.trim()}"` };
  }

  const argsPart = rangeMatch[1].trim();
  const filters: TemplateServerFilters = {};
  if (argsPart.length === 0) {
    return { filters };
  }

  // Tokenize key="value" pairs with a *sticky* regex so any unparsable token
  // between pairs (leading or middle garbage) causes the loop to bail out
  // instead of being silently skipped. The trailing-content check below then
  // catches both leading and trailing garbage.
  const filterRe = /(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*/y;
  filterRe.lastIndex = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = filterRe.exec(argsPart)) !== null) {
    const [whole, key, rawValue] = match;
    if (!VALID_FILTER_KEYS.has(key)) {
      return { error: `Unknown filter "${key}" in range directive` };
    }
    const value = rawValue.replace(/\\(.)/g, '$1');
    (filters as Record<string, string>)[key] = value;
    consumed = match.index + whole.length;
  }

  // If anything other than whitespace is left over, the head is malformed.
  if (argsPart.slice(consumed).trim().length > 0) {
    return { error: `Malformed filters in range directive: "${argsPart}"` };
  }

  return { filters };
}

/**
 * Render a single range body for one server. Replaces `{{.field}}` references.
 * Unknown fields produce an empty string and an entry in `errors`.
 */
function renderBody(
  body: string,
  server: TemplateServer,
  errors: string[]
): string {
  return body.replace(/\{\{\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, field: string) => {
    if (!VALID_FIELDS.has(field)) {
      errors.push(`Unknown field ".${field}" in range body`);
      return '';
    }
    return renderField(server, field);
  });
}

/**
 * Render the template against the given context.
 *
 * Two-pass parser: scan for `{{range ...}}` / `{{end}}` pairs, replace each
 * pair with the concatenated rendered body for matching servers. All other
 * content (including bare `{{KEY}}` and `${KEY}` placeholders) is passed
 * through verbatim.
 */
export async function renderTemplate(
  content: string,
  ctx: TemplateContext
): Promise<TemplateResult> {
  const errors: string[] = [];
  const directiveRe = /\{\{\s*([^}]+?)\s*\}\}/g;

  type Piece = { type: 'literal'; text: string } | { type: 'range'; head: string; body: string };
  const pieces: Piece[] = [];

  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = directiveRe.exec(content)) !== null) {
    const inner = match[1].trim();

    // Only handle `range` and `end` here. Anything else (including `.field`
    // references outside a range, `{{KEY}}` usage placeholders, etc.) passes
    // through untouched.
    if (!/^range\b/.test(inner) && inner !== 'end') {
      continue;
    }

    if (inner === 'end') {
      // Stray `{{end}}` outside any range: leave it as literal, record error.
      errors.push('Unexpected {{end}} with no matching {{range}}');
      continue;
    }

    // Found a `{{range ...}}`. Find its matching `{{end}}` while detecting nesting.
    const rangeStart = match.index;
    const headEnd = directiveRe.lastIndex;

    // Scan forward from headEnd for `{{end}}`, rejecting any nested `{{range}}`.
    const innerScanRe = /\{\{\s*([^}]+?)\s*\}\}/g;
    innerScanRe.lastIndex = headEnd;
    let endMatch: RegExpExecArray | null = null;
    let nested = false;
    let scan: RegExpExecArray | null;
    while ((scan = innerScanRe.exec(content)) !== null) {
      const scanInner = scan[1].trim();
      if (/^range\b/.test(scanInner)) {
        nested = true;
        break;
      }
      if (scanInner === 'end') {
        endMatch = scan;
        break;
      }
    }

    if (nested) {
      errors.push('Nested {{range}} blocks are not supported');
      // Behavior: emit nothing for the whole outer block, then resume parsing
      // *after* its matching {{end}}. Without this, the inner {{range}} would
      // be re-parsed as a new outer range and the outer {{range}}/{{end}}
      // directives would leak into the rendered output as literal text.
      const skipRe = /\{\{\s*([^}]+?)\s*\}\}/g;
      skipRe.lastIndex = headEnd;
      let depth = 1;
      let outerEnd: RegExpExecArray | null = null;
      let skip: RegExpExecArray | null;
      while ((skip = skipRe.exec(content)) !== null) {
        const t = skip[1].trim();
        if (/^range\b/.test(t)) depth++;
        else if (t === 'end') {
          depth--;
          if (depth === 0) {
            outerEnd = skip;
            break;
          }
        }
      }
      // Drop literal between cursor and rangeStart too — the outer block is
      // discarded as a unit so partial fragments don't leak through.
      pieces.push({ type: 'literal', text: content.slice(cursor, rangeStart) });
      if (outerEnd) {
        cursor = outerEnd.index + outerEnd[0].length;
        directiveRe.lastIndex = cursor;
      } else {
        // Unclosed outer block — swallow the rest of the content.
        cursor = content.length;
        directiveRe.lastIndex = cursor;
      }
      continue;
    }

    if (!endMatch) {
      errors.push('Unclosed {{range}} block');
      // Leave the unterminated range head and following content in place; stop scanning.
      break;
    }

    // Emit literal up to the range start.
    pieces.push({ type: 'literal', text: content.slice(cursor, rangeStart) });
    pieces.push({
      type: 'range',
      head: inner,
      body: content.slice(headEnd, endMatch.index),
    });

    // Advance both cursors past the `{{end}}`.
    cursor = endMatch.index + endMatch[0].length;
    directiveRe.lastIndex = cursor;
  }

  // Trailing literal.
  pieces.push({ type: 'literal', text: content.slice(cursor) });

  // Render each piece. Range pieces may need to await listServers.
  const rendered: string[] = [];
  for (const piece of pieces) {
    if (piece.type === 'literal') {
      rendered.push(piece.text);
      continue;
    }

    const parsed = parseRangeHead(piece.head);
    if ('error' in parsed) {
      errors.push(parsed.error);
      rendered.push('');
      continue;
    }

    let servers: TemplateServer[];
    try {
      servers = await ctx.listServers(parsed.filters);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to list servers';
      errors.push(`Server iteration failed: ${msg}`);
      rendered.push('');
      continue;
    }

    // Empty set renders to empty string with no error.
    const parts: string[] = [];
    for (const server of servers) {
      parts.push(renderBody(piece.body, server, errors));
    }
    rendered.push(parts.join(''));
  }

  return { content: rendered.join(''), errors };
}

/** Apply tag/name/environment filters to an already-loaded server list.
 *  Exposed for the DB-backed `listServersForTemplate` and the tests. */
export function filterServers(
  servers: TemplateServer[],
  filters: TemplateServerFilters,
  currentEnvironmentId: string
): TemplateServer[] {
  const envId = filters.environment ?? currentEnvironmentId;
  const nameRe = filters.name ? globToRegExp(filters.name) : null;

  const filtered = servers.filter((s) => {
    if (s.environmentId !== envId) return false;
    if (filters.tag && !s.tags.includes(filters.tag)) return false;
    if (nameRe && !nameRe.test(s.name)) return false;
    return true;
  });

  // Deterministic alphabetical order by name. Locale-independent compare.
  filtered.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return filtered;
}

/** Parse a Server row's stored `tags` JSON string into an array. */
export function parseServerTags(raw: string | null | undefined): string[] {
  const parsed = safeJsonParse<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((t): t is string => typeof t === 'string');
}
