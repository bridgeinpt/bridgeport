import path from 'node:path';

/**
 * Inject each page's route `slug` into its render-time frontmatter.
 *
 * Our docs are loaded from the repo's `docs/` directory (outside the usual
 * `src/content/docs`), which trips up `starlight-links-validator`: it derives a
 * page's identity from the file path *relative to `src/content/docs`*, producing
 * a key full of `../` segments that never matches a link. The validator prefers a
 * frontmatter `slug` when present (`getValidationDataId`), so supplying the correct
 * slug here keys its data by the real route. Starlight still routes by the content
 * collection id, so this does not change any URL.
 *
 * @param {{ docsDir: string }} options Absolute path to the repo's `docs/` directory.
 */
export default function remarkInjectDocSlug(options = {}) {
  const docsDir = options.docsDir;

  return (tree, file) => {
    const filePath = file?.path || file?.history?.[0];
    if (!docsDir || !filePath) return;

    const rel = path.relative(docsDir, filePath);
    if (rel.startsWith('..')) return; // not a repo doc (e.g. a local site page)

    const slug = rel
      .replace(/\.mdx?$/i, '')
      .split(path.sep)
      .join('/')
      .replace(/(^|\/)index$/i, '');

    file.data ??= {};
    file.data.astro ??= {};
    file.data.astro.frontmatter ??= {};
    if (file.data.astro.frontmatter.slug == null) {
      file.data.astro.frontmatter.slug = slug;
    }
  };
}
