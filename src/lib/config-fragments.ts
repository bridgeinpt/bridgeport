import type { PrismaClient } from '@prisma/client';

/**
 * Helpers for composing ConfigFile content with included ConfigFragments.
 *
 * A ConfigFile's effective content is the concatenation of its fragments'
 * `content` (in ascending `position` order) followed by the ConfigFile's own
 * `content`. Placeholder substitution (`${KEY}`) runs once over the combined
 * result, so fragments and inline content share the same resolution semantics.
 *
 * Duplicate keys naturally follow "last-definition-wins" because the
 * service-specific content is appended last — no parser-level dedupe needed.
 */

/**
 * Languages whose comment syntax uses `#` — safe to inject the
 * `# === fragment: <name> ===` header before each section. For everything else
 * (json, xml, html, …) we skip headers and just concatenate the content.
 *
 * The default if the language is unknown is to inject — most config formats
 * use `#` comments (yaml, toml, ini, sh, dockerfile, env, conf, properties, …)
 * and a stray `#` line is harmless in the few that don't (it will just look
 * like content). The explicit deny-list keeps strict formats (JSON, XML) clean.
 */
const NON_HASH_COMMENT_LANGUAGES = new Set([
  'json',
  'xml',
  'html',
]);

export function languageSupportsHashHeaders(language: string | null | undefined): boolean {
  if (!language) return true;
  return !NON_HASH_COMMENT_LANGUAGES.has(language.toLowerCase());
}

export interface FragmentInput {
  name: string;
  content: string;
}

/**
 * Concatenate fragment contents + the ConfigFile's own content, inserting
 * `#`-style header comments between sections when the language supports them.
 *
 * Contract:
 * - Empty `fragments` array → returns `ownContent` byte-for-byte (purely
 *   additive: a ConfigFile without fragments renders identically to today).
 * - Sections are joined with a blank line so headers visually separate them.
 * - Trailing whitespace on each section is preserved as-is; the caller's
 *   downstream `.trimEnd()` (in compose / sync paths) handles final-line
 *   trimming consistently with the no-fragment case.
 */
export function composeFragmentedContent(
  fragments: ReadonlyArray<FragmentInput>,
  ownContent: string,
  language: string | null | undefined,
): string {
  // Purely-additive contract: with no fragments, return the own content
  // unchanged so existing ConfigFiles render byte-for-byte identically.
  if (fragments.length === 0) return ownContent;

  const useHeaders = languageSupportsHashHeaders(language);
  const sections: string[] = [];

  for (const fragment of fragments) {
    const header = useHeaders ? `# === fragment: ${fragment.name} ===\n` : '';
    sections.push(header + fragment.content);
  }

  // Header for the service-specific (own) content. Without headers (e.g. JSON),
  // we just append the own content directly.
  const ownHeader = useHeaders ? `# === service-specific ===\n` : '';
  sections.push(ownHeader + ownContent);

  // Join with a blank line so headers visibly separate sections.
  return sections.join('\n\n');
}

/**
 * Load the ordered list of fragments included by a ConfigFile and return the
 * composed effective content (fragments concatenated + ownContent + headers).
 *
 * Binary ConfigFiles never include fragments (the include list is empty by
 * construction — the UI hides the fragment selector for binary files), so the
 * caller can keep using `configFile.content` directly for those.
 *
 * `prismaClient` is typed against `PrismaClient` so callers can also pass a
 * `Prisma.TransactionClient` (Prisma's transaction client extends the same
 * `configFileFragment` accessor surface).
 */
export async function loadAndComposeConfigFileContent(
  prismaClient: Pick<PrismaClient, 'configFileFragment'>,
  configFile: { id: string; content: string; language: string | null },
): Promise<string> {
  const rows = await prismaClient.configFileFragment.findMany({
    where: { configFileId: configFile.id },
    orderBy: { position: 'asc' },
    include: { fragment: { select: { name: true, content: true } } },
  });

  if (rows.length === 0) return configFile.content;

  const fragments: FragmentInput[] = rows.map((r) => ({
    name: r.fragment.name,
    content: r.fragment.content,
  }));

  return composeFragmentedContent(fragments, configFile.content, configFile.language);
}

