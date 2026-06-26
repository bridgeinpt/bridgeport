import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import starlightLinksValidator from 'starlight-links-validator';
import githubAdmonitionsToDirectives from 'remark-github-admonitions-to-directives';
import remarkStripFirstH1 from './src/plugins/remark-strip-first-h1.mjs';
import remarkRewriteDocLinks from './src/plugins/remark-rewrite-doc-links.mjs';
import remarkInjectDocSlug from './src/plugins/remark-inject-doc-slug.mjs';

const docsDir = fileURLToPath(new URL('../docs', import.meta.url));

// https://astro.build/config
export default defineConfig({
  site: 'https://bridgeport.bridgein.com',
  markdown: {
    // `env` and `caddyfile` aren't bundled Shiki grammars; alias them to close matches
    // so these code blocks get highlighted instead of falling back to plain text.
    shikiConfig: { langAlias: { env: 'ini', caddyfile: 'ini' } },
    remarkPlugins: [
      // Convert GitHub-style `> [!TIP]` alerts to the `:::tip` directives Starlight renders
      // as asides. Runs before Starlight's own remark plugins (Astro applies user plugins
      // first), which then turn the directives into styled asides.
      githubAdmonitionsToDirectives,
      // Derive the page title from the leading `# Heading`, then drop it from the body.
      remarkStripFirstH1,
      // Rewrite repo-relative `.md` links to published site routes.
      [remarkRewriteDocLinks, { docsDir }],
      // Tag each page with its route slug so starlight-links-validator can key it
      // correctly (our docs live outside src/content/docs).
      [remarkInjectDocSlug, { docsDir }],
    ],
  },
  integrations: [
    starlight({
      title: 'BridgePort',
      description:
        'Self-hosted Docker deployment, orchestration, and monitoring — production-grade ops without Kubernetes.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/bridgeinpt/bridgeport' },
      ],
      // Our docs are loaded from the repo's docs/ directory rather than src/content/docs,
      // so tell Starlight to run its Markdown transforms (asides, heading-anchor links) there.
      markdown: { processedDirs: ['../docs'] },
      customCss: ['./src/styles/custom.css'],
      plugins: [
        starlightOpenAPI([
          { base: 'reference/api', schema: '../openapi.json', label: 'API Reference' },
        ]),
        starlightLinksValidator({
          // The generated OpenAPI pages aren't markdown, so the validator has no
          // heading data for them and can't verify links pointing into the reference.
          exclude: ['/reference/api/', '/reference/api/**'],
          // localhost URLs are intentional examples for a self-hosted product.
          errorOnLocalLinks: false,
        }),
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Getting Started', link: '/getting-started/' },
            { label: 'Core Concepts', link: '/concepts/' },
            { label: 'Installation', link: '/installation/' },
            { label: 'Configuration', link: '/configuration/' },
            { label: 'API Stability', link: '/api-stability/' },
          ],
        },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Operations', items: [{ autogenerate: { directory: 'operations' } }] },
        ...openAPISidebarGroups,
      ],
    }),
  ],
});
