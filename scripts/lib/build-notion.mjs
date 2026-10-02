import { parseMarkdownDocument } from './markdown-document.mjs';
import { collectHeadings, buildToc, renderMarkdown, renderPage } from './static-renderer.mjs';

/**
 * @param {string} raw
 * @param {string} inputPath
 * @param {{
 *   hastTransforms?: Array<(tree: import('hast').Root, file: import('vfile').VFile) => void | Promise<void>>,
 *   hubLink?: { href: string, label?: string }
 * }} [options]
 *   options 未指定時は従来と完全に同一の経路・同一バイトの出力になる（SPEC §4.6）。
 *   `hastTransforms` は `rehypeEnhanceTables` の後・`rehypeSanitizeUrls` の前に適用される変換関数の配列。
 *   `hubLink` はオブジェクトのみ（文字列短縮形なし）。`href` は `isSafeUrl()` 検査を通る必要がある。
 */
export async function buildNotionHtmlString(raw, inputPath, options = {}) {
  const { hastTransforms, hubLink } = options;
  const document = parseMarkdownDocument(raw, inputPath);
  const headings = collectHeadings(document.tree);
  const toc = buildToc(headings);
  const bodyHtml = await renderMarkdown(document.tree, { hastTransforms });
  return renderPage(
    {
      title: document.title,
      data: document.frontmatter,
      toc,
      bodyHtml
    },
    { hubLink }
  );
}
