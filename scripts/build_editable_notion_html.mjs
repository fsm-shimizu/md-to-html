import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { parseMarkdownDocument } from './lib/markdown-document.mjs';
import { markdownDocumentToEditableDocument } from './lib/markdown-to-blocks.mjs';
import { renderEditablePage } from './lib/render-editable-page.mjs';

async function bundleRuntime() {
  const result = await esbuild.build({
    entryPoints: [new URL('../runtime/editable-runtime.js', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none'
  });
  return result.outputFiles[0].text;
}

async function main() {
  const input = process.argv[2];
  const outIndex = process.argv.indexOf('--out');
  const output = outIndex >= 0 ? process.argv[outIndex + 1] : null;
  if (!input) {
    console.error('Usage: node scripts/build_editable_notion_html.mjs <input.md> [--out <output.html>]');
    process.exit(1);
  }

  const inputPath = path.resolve(input);
  const outputPath = output ? path.resolve(output) : inputPath.replace(/\.md$/i, '.editable.html');
  const raw = await fs.readFile(inputPath, 'utf8');
  const parsed = parseMarkdownDocument(raw, inputPath);
  const editableDocument = markdownDocumentToEditableDocument(parsed, parsed.markdown);
  editableDocument.documentId = crypto.randomUUID().slice(0, 8);

  const runtimeJs = await bundleRuntime();
  const editableCss = await fs.readFile(new URL('../runtime/editable.css', import.meta.url), 'utf8');
  const html = renderEditablePage({
    title: editableDocument.title,
    data: editableDocument.frontmatter,
    editableDocument,
    runtimeJs,
    editableCss
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html);
  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
