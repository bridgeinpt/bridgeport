import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import mermaid from 'astro-mermaid';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightImageZoom from 'starlight-image-zoom';
import githubAdmonitionsToDirectives from 'remark-github-admonitions-to-directives';
import remarkStripFirstH1 from './src/plugins/remark-strip-first-h1.mjs';
import remarkRewriteDocLinks from './src/plugins/remark-rewrite-doc-links.mjs';
import remarkInjectDocSlug from './src/plugins/remark-inject-doc-slug.mjs';

const SITE = 'https://bridgeport.bridgein.com';
const docsDir = fileURLToPath(new URL('../docs', import.meta.url));

// https://astro.build/config
export default defineConfig({
  site: SITE,
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
    // Render ```mermaid code blocks as diagrams (client-side). Must precede starlight.
    mermaid({ theme: 'default', autoTheme: true }),
    starlight({
      title: 'BridgePort',
      description:
        'Self-hosted Docker deployment, orchestration, and monitoring — production-grade ops without Kubernetes.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/bridgeinpt/bridgeport' },
      ],
      // The port-gantry-crane mark (burgundy), shown alongside the title and as the favicon.
      logo: { src: './src/assets/logo.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      // Social/link-unfurl preview image (reuses the repo's social card).
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `${SITE}/social-preview.png` } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'BridgePort' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE}/social-preview.png` } },
      ],
      // "Edit this page" → the source file on GitHub.
      editLink: { baseUrl: 'https://github.com/bridgeinpt/bridgeport/edit/master/docs/' },
      // Our docs are loaded from the repo's docs/ directory rather than src/content/docs,
      // so tell Starlight to run its Markdown transforms (asides, heading-anchor links) there.
      markdown: { processedDirs: ['../docs'] },
      customCss: ['./src/styles/custom.css'],
      plugins: [
        starlightOpenAPI([
          { base: 'reference/api', schema: '../openapi.json', label: 'API Reference' },
        ]),
        // Generate llms.txt / llms-full.txt so AI agents can consume the docs.
        starlightLlmsTxt({
          projectName: 'BridgePort',
          description:
            'Self-hosted tool to deploy, orchestrate, and monitor Docker services across servers — production-grade ops without Kubernetes.',
        }),
        // Click-to-zoom on images (activates once docs include screenshots).
        starlightImageZoom(),
        starlightLinksValidator({
          // The generated OpenAPI pages aren't markdown, so the validator has no
          // heading data for them and can't verify links pointing into the reference.
          exclude: ['/reference/api/', '/reference/api/**'],
          // localhost URLs are intentional examples for a self-hosted product.
          errorOnLocalLinks: false,
        }),
      ],
      // Explicit, curated sidebar mirroring docs/README.md. (Starlight's `autogenerate`
      // resolves directories relative to src/content/docs, so it finds nothing for our
      // docs loaded from ../docs — hence the manual listing, which also gives a nicer
      // curated order than alphabetical autogeneration.)
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
        {
          label: 'Guides',
          items: [
            { label: 'Users & Roles', link: '/guides/users/' },
            {
              label: 'Infrastructure',
              items: [
                { label: 'Environments', link: '/guides/environments/' },
                { label: 'Servers', link: '/guides/servers/' },
                { label: 'Server Bootstrap', link: '/guides/server-bootstrap/' },
                { label: 'Services', link: '/guides/services/' },
                { label: 'Container Images', link: '/guides/container-images/' },
                { label: 'Registries', link: '/guides/registries/' },
              ],
            },
            {
              label: 'Configuration & Secrets',
              items: [
                { label: 'Secrets & Variables', link: '/guides/secrets/' },
                { label: 'Config Files', link: '/guides/config-files/' },
              ],
            },
            {
              label: 'Data',
              items: [
                { label: 'Databases', link: '/guides/databases/' },
                { label: 'S3 / Spaces Storage', link: '/guides/storage/' },
              ],
            },
            {
              label: 'Monitoring',
              items: [
                { label: 'Monitoring Quick Start', link: '/guides/monitoring/' },
                { label: 'Server Monitoring', link: '/guides/monitoring-servers/' },
                { label: 'Service Monitoring', link: '/guides/monitoring-services/' },
                { label: 'Database Monitoring', link: '/guides/monitoring-databases/' },
                { label: 'Health Checks', link: '/guides/health-checks/' },
              ],
            },
            {
              label: 'Automation & Visualization',
              items: [
                { label: 'Notifications', link: '/guides/notifications/' },
                { label: 'Service Topology', link: '/guides/topology/' },
                { label: 'Deployment Plans', link: '/guides/deployment-plans/' },
                { label: 'Webhooks', link: '/guides/webhooks/' },
                { label: 'Terraform Provider', link: '/guides/terraform/' },
              ],
            },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', link: '/reference/cli/' },
            { label: 'Agent', link: '/reference/agent/' },
            { label: 'MCP Server', link: '/reference/mcp/' },
            { label: 'Real-Time Events (SSE)', link: '/reference/events/' },
            { label: 'Plugin Authoring', link: '/reference/plugins/' },
            { label: 'Environment Settings', link: '/reference/environment-settings/' },
            { label: 'System Settings', link: '/reference/system-settings/' },
          ],
        },
        ...openAPISidebarGroups,
        {
          label: 'Operations',
          items: [
            { label: 'Upgrades', link: '/operations/upgrades/' },
            { label: 'Security & Hardening', link: '/operations/security/' },
            { label: 'Backup & Restore', link: '/operations/backup-restore/' },
            { label: 'Troubleshooting', link: '/operations/troubleshooting/' },
            { label: 'Architecture Patterns', link: '/operations/patterns/' },
          ],
        },
      ],
    }),
    sitemap(),
  ],
});
