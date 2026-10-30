import { parseMarkdownDocument } from './markdown-document.mjs';
import { collectHeadings, buildToc, renderMarkdown, renderPage, DOC_TYPES, formatMetaValue } from './static-renderer.mjs';
import { findCalloutWarnings } from './components.mjs';
import { typesetMath } from './math.mjs';
import { renderDiagrams } from './diagrams.mjs';

/**
 * @param {string} raw
 * @param {string} inputPath
 * @param {{
 *   hastTransforms?: Array<(tree: import('hast').Root, file: import('vfile').VFile) => void | Promise<void>>,
 *   hubLink?: { href: string, label?: string },
 *   fonts?: 'google',
 *   onWarning?: (warning: { line: number, reason: string, marker: string }) => void
 * }} [options]
 *   options 未指定時は options を渡さない呼び出しと同一の経路・同一バイトの出力になる。
 *   `hastTransforms` は `rehypeEnhanceTables` の後・`rehypeSanitizeUrls` の前に適用される変換関数の配列。
 *   `hubLink` はオブジェクトのみ（文字列短縮形なし）。`href` は `isSafeUrl()` 検査を通る必要がある。
 *   `onWarning` は部品や見出しの記号にならなかった目印を 1 件ずつ受け取る。line は元の原稿（YAML の前置きを含む）の行。変換の結果は変えない。
 *   `fonts` は書体の読み込み方。既定 'google' は Google Fonts の 2 書体（Noto Sans JP・IBM Plex Mono）を読む。
 */
export async function buildNotionHtmlString(raw, inputPath, options = {}) {
  const { hastTransforms, hubLink, fonts, onWarning } = options;
  const document = parseMarkdownDocument(raw, inputPath);
  // mdast の行は、YAML の前置きと先頭の見出しを取り除いた本文からの行なので、取り除いた行数を足して元の原稿の行へ戻す
  const offset = raw.split('\n').length - document.markdown.split('\n').length;
  const warn = onWarning ? (w) => onWarning({ ...w, line: typeof w.line === 'number' ? w.line + offset : w.line }) : undefined;
  // 知らない文書の種類。行は元の原稿で数えるので、本文の行に前置きの行数を足す warn には通さない
  const type = document.frontmatter.type;
  if (onWarning && type !== undefined && !(typeof type === 'string' && Object.hasOwn(DOC_TYPES, type))) {
    // 前置き（1 行目の --- で始まる行から次の --- まで）の中で、最上位のキー（最初のキーと同じ字下げ）の type の行を探す。
    // 入れ子のキーと複数行の文字列の中（字下げが深い）は見ない。流れの形・エスケープで書いた type は見つけず、1 行目を指す
    // 先頭の BOM は除き、終わりの --- は字下げの無い行だけを見る（複数行の文字列の中の --- で止まらない。後ろの注釈は許す）。
    // 終わりの --- が無ければ、原稿の最後までを前置きとして探す（gray-matter もそう読む）
    const lines = raw.replace(/^\uFEFF/, '').split('\n');
    const close = lines.findIndex((l, i) => i > 0 && /^---(\s|$)/.test(l));
    const fm = /^---/.test(lines[0] || '') ? lines.slice(1, close > 0 ? close : lines.length) : [];
    const first = fm.find((l) => l.trim() && !l.trim().startsWith('#'));
    const base = first ? first.match(/^\s*/)[0].length : 0;
    const at = fm.findIndex((l) => l.match(/^\s*/)[0].length === base && /^(["']?)type\1\s*:/.test(l.slice(base)));
    onWarning({ line: at >= 0 ? at + 2 : 1, reason: '知らない文書の種類', marker: `type: ${formatMetaValue(type)}` });
  }
  // 数式は目次・部品の判定より前に組む。warn の定義の後に置く
  await typesetMath(document.tree, document.markdown, { onWarning: warn });
  // 警告の判定は remarkComponents が木を組み替える前に行う（組み替えた後では目印が残らない）
  const headings = collectHeadings(document.tree, { onWarning: warn });
  // 図は見出しの id が決まった後に描く（図の id を見出しの id と重ねないため）
  renderDiagrams(document.tree, { usedIds: new Set(headings.map((h) => h.id)), onWarning: warn });
  if (warn) for (const w of findCalloutWarnings(document.tree)) warn(w);
  const toc = buildToc(headings);
  const bodyHtml = await renderMarkdown(document.tree, { hastTransforms });
  return renderPage(
    {
      title: document.title,
      data: document.frontmatter,
      toc,
      bodyHtml
    },
    { hubLink, fonts }
  );
}
