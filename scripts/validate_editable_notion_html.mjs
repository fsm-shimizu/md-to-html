import fs from 'node:fs/promises';
import { load } from 'cheerio';
import { isSafeUrl } from './lib/url-safety.mjs';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/validate_editable_notion_html.mjs <output.html>');
  process.exit(1);
}

const html = await fs.readFile(input, 'utf8');
const $ = load(html);
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

assert($('[data-editable="true"]').length === 1, 'expected data-editable=true shell');
assert($('article[data-editor-root]').length === 1, 'expected editor root');
assert($('#mdh-document-data[type="application/json"]').length === 1, 'expected embedded JSON document');
assert($('[data-action="export-markdown"]').length === 1, 'missing export-markdown action');
assert($('[data-action="export-html"]').length === 1, 'missing export-html action');
assert($('[data-action="reset-edits"]').length === 1, 'missing reset-edits action');
assert($('[data-action="toggle-toc"]').length === 1, 'missing toggle-toc action');
assert($('aside.mdh-toc strong').first().text().trim() === '目次', 'editable TOC must render a heading');
assert($('#mdh-editable-toc').length === 1, 'editable TOC tree root required');
assert(html.includes('draggable=!0') || html.includes('draggable = true'), 'editable runtime must make block handles draggable');
assert(html.includes('aria-label'), 'editable runtime must set block handle aria-label');
assert(html.includes('aria-haspopup'), 'editable runtime must set block handle aria-haspopup');
assert($('script').length >= 2, 'expected JSON script and runtime script');
assert($('script[src]').length === 0, 'editable HTML must not reference external scripts');

let documentData;
try {
  documentData = JSON.parse($('#mdh-document-data').text());
} catch (error) {
  failures.push(`embedded JSON parse failed: ${error.message}`);
}

if (documentData) {
  assert(documentData.version === 1, 'document version must be 1');
  assert(typeof documentData.documentId === 'string' && documentData.documentId.length === 8, 'documentId must be 8 chars');
  assert(typeof documentData.title === 'string' && documentData.title.length > 0, 'title required');
  assert(documentData.frontmatter && typeof documentData.frontmatter === 'object', 'frontmatter object required');
  assert(Array.isArray(documentData.blocks), 'blocks array required');
  const ids = new Set();
  for (const block of documentData.blocks || []) {
    validateBlock(block, ids);
  }
}

function validateBlock(block, ids) {
  assert(typeof block.id === 'string' && block.id.length > 0, 'block id required');
  assert(!ids.has(block.id), `duplicate block id: ${block.id}`);
  ids.add(block.id);
  validateBlockContentUrls(block);
  if (Array.isArray(block.blocks)) {
    for (const child of block.blocks) validateBlock(child, ids);
  }
}

function validateBlockContentUrls(block) {
  validateContentUrls(block.content || []);
  if (Array.isArray(block.items)) {
    for (const item of block.items) validateContentUrls(item.content || []);
  }
  if (Array.isArray(block.headers)) block.headers.forEach(validateContentUrls);
  if (Array.isArray(block.rows)) block.rows.flat().forEach(validateContentUrls);
}

function validateContentUrls(content) {
  for (const node of content || []) {
    if (node.type === 'link') assert(isSafeUrl(node.url), `unsafe link url: ${node.url}`);
    if (Array.isArray(node.children)) validateContentUrls(node.children);
  }
}

if (failures.length) {
  console.error(`Validation failed for ${input}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Validated editable ${input}`);
