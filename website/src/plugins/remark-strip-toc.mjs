/**
 * Remove a manual "## Table of Contents" section (the heading, its list, and a trailing
 * `---`) from the site render.
 *
 * Starlight already shows an "On this page" table of contents in the right sidebar, so the
 * in-page one is redundant on the site (it even shows up *as an entry* in the auto TOC).
 * We strip it here at build time but leave it in the source files, where it's still useful
 * when the docs are read on GitHub.
 */
export default function remarkStripTableOfContents() {
  return (tree) => {
    const children = tree.children;
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.type !== 'heading' || node.depth > 3) continue;

      const text = (node.children || [])
        .map((child) => child.value || '')
        .join('')
        .trim()
        .toLowerCase();
      if (text !== 'table of contents') continue;

      let count = 1; // the heading itself
      if (children[i + count]?.type === 'list') count++; // the list of anchor links
      if (children[i + count]?.type === 'thematicBreak') count++; // a trailing "---"
      children.splice(i, count);
      return; // only the first occurrence
    }
  };
}
