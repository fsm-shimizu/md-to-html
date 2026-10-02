import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseMarkdownDocument } from './lib/markdown-document.mjs';
import { markdownDocumentToEditableDocument } from './lib/markdown-to-blocks.mjs';
import { editableDocumentToMarkdown } from './lib/blocks-to-markdown.mjs';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/roundtrip_test.mjs <input.md>');
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
assert(editable.blocks.some((block) => block.type === 'table'));
assert(editable.blocks.some((block) => block.type === 'unsupported'));

console.log(`Roundtrip validated ${input}`);
