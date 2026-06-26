import { visit } from 'unist-util-visit';
import path from 'node:path';

/**
 * Rewrite repo-relative Markdown links (e.g. `servers.md`, `../reference/cli.md#foo`)
 * to Starlight site routes (`/guides/servers/`, `/reference/cli/#foo`).
 *
 * The source files in `docs/` use relative `.md` links so they resolve correctly when
 * browsed on GitHub. At build time we translate those to the published routes, keeping
 * a single set of files valid on both surfaces. Links with a scheme (http:, mailto:),
 * absolute links, bare anchors, and links that escape the docs root are left untouched.
 *
 * @param {{ docsDir: string }} options Absolute path to the repo's `docs/` directory.
 */
export default function remarkRewriteDocLinks(options = {}) {
  const docsDir = options.docsDir;

  return (tree, file) => {
    const filePath = file?.path || file?.history?.[0];
    if (!docsDir || !filePath) return;

    const relFromDocs = path.relative(docsDir, filePath);
    // File lives outside docs/ (e.g. a local site page) — nothing to rewrite.
    if (relFromDocs.startsWith('..')) return;
    const currentDir = path.dirname(relFromDocs).split(path.sep).join('/');

    const GITHUB_BLOB = 'https://github.com/bridgeinpt/bridgeport/blob/master/';

    // Docs that live in the repo but are NOT published to the site. Links to these are
    // redirected to GitHub so they keep resolving. Kept in sync with the loader excludes
    // in src/content.config.ts.
    const isRepoOnly = (docPath) =>
      docPath.startsWith('development/') ||
      ['README.md', 'BRANDING.md', 'SECURITY.md', 'TESTING_STRATEGY.md'].includes(docPath);

    const rewrite = (url) => {
      if (typeof url !== 'string' || url.length === 0) return url;
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url; // has a scheme
      if (url.startsWith('/') || url.startsWith('#')) return url;

      const hashIndex = url.indexOf('#');
      const target = hashIndex === -1 ? url : url.slice(0, hashIndex);
      const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
      if (!/\.mdx?$/i.test(target)) return url;

      const base = currentDir === '.' ? '' : currentDir;
      const normalized = path.posix.normalize(path.posix.join(base, target));

      // Link escapes docs/ (e.g. ../CONTRIBUTING.md) → point at the file on GitHub.
      if (normalized.startsWith('..')) {
        const repoRel = path.posix.normalize(path.posix.join('docs', base, target));
        if (repoRel.startsWith('..')) return url; // escapes the repo too — leave alone
        return GITHUB_BLOB + repoRel + hash;
      }

      // The hand-written API page is replaced by the generated reference at this route.
      if (normalized === 'reference/api.md') return '/reference/api/' + hash;

      // Repo-only doc → GitHub; published doc → site route.
      if (isRepoOnly(normalized)) return GITHUB_BLOB + 'docs/' + normalized + hash;

      const route = '/' + normalized.replace(/\.mdx?$/i, '').replace(/\/index$/i, '') + '/';
      return route.replace(/\/{2,}/g, '/') + hash;
    };

    visit(tree, (node) => {
      if ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string') {
        node.url = rewrite(node.url);
      }
    });
  };
}
