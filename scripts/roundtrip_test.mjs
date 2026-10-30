import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { parseMarkdownDocument } from './lib/markdown-document.mjs';
import { markdownDocumentToEditableDocument } from './lib/markdown-to-blocks.mjs';
import { editableDocumentToMarkdown } from './lib/blocks-to-markdown.mjs';
import { buildNotionHtmlString } from './lib/build-notion.mjs';

const input = process.argv[2];
const compareRender = process.argv.includes('--compare-render');
if (!input) {
  console.error('Usage: node scripts/roundtrip_test.mjs <input.md> [--compare-render]');
  process.exit(1);
}

const inputPath = path.resolve(input);
const raw = await fs.readFile(inputPath, 'utf8');
const parsed = parseMarkdownDocument(raw, inputPath);
const editable = markdownDocumentToEditableDocument(parsed, parsed.markdown);
const markdown = editableDocumentToMarkdown(editable);
const reparsed = parseMarkdownDocument(markdown, inputPath);
const editableAgain = markdownDocumentToEditableDocument(reparsed, reparsed.markdown);

assert.equal(editable.title, editableAgain.title);
assert.deepEqual(editable.frontmatter, editableAgain.frontmatter);
assert.deepEqual(editable.blocks.map((block) => block.type), editableAgain.blocks.map((block) => block.type));
if (compareRender) {
  // 書き出した Markdown を変換し直すと、元の原稿を変換したものと本文（<article>）が同じ。
  // 目次は書き出しで見出しの段が変わりうるので比べない。
  const article = async (md) => load(await buildNotionHtmlString(md, inputPath))('article.mdh-doc').html();
  const original = await article(raw);
  assert.ok(original.length > 0);
  assert.equal(await article(markdown), original);
} else {
  assert(editable.blocks.some((block) => block.type === 'table'));
  assert(editable.blocks.some((block) => block.type === 'unsupported'));
}

console.log(`Roundtrip validated ${input}${compareRender ? ' (rendered article compared)' : ''}`);
