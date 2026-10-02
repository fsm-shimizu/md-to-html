import { editableDocumentToMdast } from './blocks-to-mdast.mjs';
import { collectHeadings, buildToc, renderMarkdown, renderPage } from './static-renderer.mjs';

export async function editableDocumentToStaticHtml(document) {
  const tree = editableDocumentToMdast(document);
  const headings = collectHeadings(tree);
  const toc = buildToc(headings);
  const bodyHtml = await renderMarkdown(tree);
  return renderPage({
    title: document.title,
    data: document.frontmatter,
    toc,
    bodyHtml
  });
}
