import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { changelogsLoader } from 'starlight-changelogs/loader';
import { glob } from 'astro/loaders';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the Starlight `docs` collection directly from the repo's `docs/` markdown —
 * the single source of truth. Nothing is copied, so there is no drift between what
 * renders on GitHub and what ships on the site.
 *
 * Two things are handled here so the source files stay plain GitHub-flavored markdown:
 *   1. Only user-facing docs are published (development/contributor docs and repo-meta
 *      files are excluded).
 *   2. Each page's `title` is derived from its leading `# Heading` (the files carry no
 *      frontmatter). Starlight requires `title`, and its schema can't be loosened, so we
 *      inject it before validation by wrapping the loader's `parseData`. The heading is
 *      then stripped from the body at render time by `remark-strip-first-h1` so the title
 *      isn't duplicated.
 */
const DOCS_GLOB = {
  base: '../docs',
  pattern: [
    '**/*.{md,mdx}',
    '!development/**',
    '!README.md',
    '!BRANDING.md',
    '!SECURITY.md',
    '!TESTING_STRATEGY.md',
    // Owned by the generated OpenAPI reference at the same route (/reference/api/).
    '!reference/api.md',
  ],
};

const TITLE_RE = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m;

function resolveAbsolute(filePath: string, rootDir: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  for (const base of [rootDir, process.cwd()]) {
    const candidate = path.resolve(base, filePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(rootDir, filePath);
}

function repoDocsLoader() {
  const inner = glob(DOCS_GLOB);
  return {
    name: 'repo-docs-loader',
    load: async (context: Parameters<typeof inner.load>[0]) => {
      const rootDir = fileURLToPath(context.config.root);
      const originalParseData = context.parseData.bind(context);
      context.parseData = async (props: Parameters<typeof originalParseData>[0]) => {
        const data = props?.data as Record<string, unknown> | undefined;
        if (data && data.title == null && props.filePath) {
          try {
            const raw = fs.readFileSync(resolveAbsolute(props.filePath, rootDir), 'utf8');
            const match = raw.match(TITLE_RE);
            if (match) data.title = match[1].replace(/[`*_]/g, '').trim();
          } catch {
            // fall through to schema validation, which will surface a clear error
          }
        }
        return originalParseData(props);
      };
      await inner.load(context);
    },
  };
}

export const collections = {
  docs: defineCollection({
    loader: repoDocsLoader(),
    schema: docsSchema(),
  }),
  // Changelog generated from the repo's GitHub Releases (single source — published by
  // the /release workflow; nothing duplicated). Fetched at build; set GH_API_TOKEN to
  // raise the GitHub API rate limit if builds ever get frequent.
  changelogs: defineCollection({
    loader: changelogsLoader([
      {
        provider: 'github',
        base: 'changelog',
        owner: 'bridgeinpt',
        repo: 'bridgeport',
        title: 'Changelog',
        pageSize: 20,
        token: process.env.GH_API_TOKEN,
      },
    ]),
  }),
};

