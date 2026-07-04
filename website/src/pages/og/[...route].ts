import { OGImageRoute } from 'astro-og-canvas';
import { getOgPages } from '../../og-pages';

/**
 * Generated Open Graph images: /og/<route>.png for every docs page and
 * marketing page (see src/og-pages.ts). Deep Slate card with a burgundy
 * spine — matches the site theme. The Head override points og:image here.
 *
 * (astro-og-canvas ≥0.13: OGImageRoute is async and the default slug adds
 * the .png extension, so this file is [...route].ts, not [...route].png.ts.)
 */

const pages = await getOgPages();

export const prerender = true;

const route = await OGImageRoute({
  pages,
  getImageOptions: (_path, page: (typeof pages)[string]) => ({
    title: page.title,
    description: page.description ?? 'Self-hosted Docker deployment, orchestration & monitoring.',
    bgGradient: [
      [15, 23, 42], // slate-900
      [8, 13, 26],
    ],
    border: { color: [204, 0, 0], width: 14, side: 'inline-start' },
    padding: 72,
    // Vendored TTFs (src/assets/fonts/) — keeps the build hermetic; without a
    // fonts list astro-og-canvas downloads its default font at build time.
    fonts: [
      './src/assets/fonts/IBMPlexSans-SemiBold.ttf',
      './src/assets/fonts/IBMPlexSans-Regular.ttf',
    ],
    font: {
      title: {
        size: 60,
        lineHeight: 1.15,
        weight: 'SemiBold',
        families: ['IBM Plex Sans'],
        color: [248, 250, 252],
      },
      description: {
        size: 30,
        lineHeight: 1.4,
        families: ['IBM Plex Sans'],
        color: [148, 163, 184],
      },
    },
  }),
});

export const getStaticPaths = route.getStaticPaths;
export const GET = route.GET;
