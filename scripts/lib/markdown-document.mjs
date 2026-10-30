import path from 'node:path';
import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import { mathFromMarkdown } from 'mdast-util-math';
import { visit } from 'unist-util-visit';
import { titleLines, oneLineTitle } from './title.mjs';

export { oneLineTitle };

export function parseMarkdownDocument(raw, inputPath) {
  const parsed = matter(raw);
  const { title, markdown, titleSource } = extractTitle(parsed.content, parsed.data, inputPath);
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkMathFenceMark)
    .use(remarkFrontmatter, ['yaml'])
    .parse(markdown);
  const normalized = normalizeHeadings(tree);
  return {
    title,
    titleSource,
    frontmatter: parsed.data,
    markdown,
    tree: normalized.tree,
    promoted: normalized.promoted
  };
}

// `$$` の行で始めた式（math）が閉じているかを、解析器が閉じの記号を読んだかで記録する。
// mdast-util-math の mathFlowFence の終わりの処理は、開きの記号で this.data.mathFlowInside を立てるので、
// 立っているときに呼ばれたら閉じの記号。そのとき this.stack の上から最初の math の節点に印を付ける。
const closeMathFlowFence = mathFromMarkdown().exit.mathFlowFence;
function remarkMathFenceMark() {
  const data = this.data();
  (data.fromMarkdownExtensions ||= []).push({
    exit: {
      mathFlowFence(token) {
        if (this.data.mathFlowInside) {
          const node = [...this.stack].reverse().find((n) => n.type === 'math');
          if (node) (node.data ||= {}).mdhClosed = true;
        }
        closeMathFlowFence.call(this, token);
      }
    }
  });
}

export function extractTitle(content, data, inputPath) {
  const fallbackTitle = path.basename(inputPath, path.extname(inputPath)).replace(/[-_]+/g, ' ');
  if (typeof data.title === 'string' && data.title.trim()) {
    const title = titleLines(data.title).join('\n');
    return {
      title,
      titleSource: 'frontmatter',
      markdown: removeDuplicateLeadingH1(content, oneLineTitle(title))
    };
  }

  const match = content.match(/^\s*#\s+(.+?)\s*$/m);
  if (match && content.slice(0, match.index).trim() === '') {
    return {
      title: match[1].trim(),
      titleSource: 'leading-h1',
      markdown: content.slice(match.index + match[0].length).replace(/^\n+/, '')
    };
  }

  return { title: fallbackTitle, titleSource: 'filename', markdown: content };
}

function removeDuplicateLeadingH1(content, title) {
  const match = content.match(/^\s*#\s+(.+?)\s*$/m);
  if (!match || content.slice(0, match.index).trim() !== '') return content;
  return match[1].trim() === title
    ? content.slice(match.index + match[0].length).replace(/^\n+/, '')
    : content;
}

export function normalizeHeadings(tree) {
  let hasH1 = false;
  visit(tree, 'heading', (node) => {
    node.data ||= {};
    node.data.originalDepth = node.depth;
    if (node.depth === 1) hasH1 = true;
  });

  if (!hasH1) {
    visit(tree, 'heading', (node) => {
      node.depth = Math.max(1, node.depth - 1);
    });
  }

  return { tree, promoted: !hasH1 };
}
