import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import yaml from 'js-yaml';
import { editableDocumentToMdast } from './blocks-to-mdast.mjs';

export function editableDocumentToMarkdown(document) {
  const tree = editableDocumentToMdast(document);
  const body = unified()
    .use(remarkGfm)
    .use(remarkStringify, {
      bullet: '-',
      fences: true,
      incrementListMarker: true
    })
    .stringify(tree);
  const frontmatter = { ...document.frontmatter };
  if (document.titleSource === 'frontmatter') frontmatter.title = document.title;
  const yamlText = Object.keys(frontmatter).length
    ? `---\n${yaml.dump(frontmatter)}---\n\n`
    : '';
  const titleText = document.titleSource === 'frontmatter' ? '' : `# ${document.title}\n\n`;
  return `${yamlText}${titleText}${body}`;
}
