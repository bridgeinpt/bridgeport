import { visit, EXIT } from 'unist-util-visit';

/**
 * Remove the first level-1 heading from each document.
 *
 * Our source files in `docs/` use a leading `# Title` as their title (great when
 * read on GitHub). On the Starlight site, the title is rendered from frontmatter
 * (which we derive from that same `# Title` in the content loader), so leaving the
 * heading in the body would render the title twice. Stripping it here lets one set
 * of plain markdown files serve both surfaces with no edits to `docs/`.
 */
export default function remarkStripFirstH1() {
  return (tree) => {
    visit(tree, 'heading', (node, index, parent) => {
      if (node.depth === 1 && parent && typeof index === 'number') {
        parent.children.splice(index, 1);
        return EXIT;
      }
      return undefined;
    });
  };
}
