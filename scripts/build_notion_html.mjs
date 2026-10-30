import fs from 'node:fs/promises';
import path from 'node:path';
import { buildNotionHtmlString } from './lib/build-notion.mjs';

async function main() {
  const input = process.argv[2];
  const outIndex = process.argv.indexOf('--out');
  const output = outIndex >= 0 ? process.argv[outIndex + 1] : null;

  if (!input) {
    console.error('Usage: node scripts/build_notion_html.mjs <input.md> [--out <output.html>]');
    process.exit(1);
  }

  const inputPath = path.resolve(input);
  const outputPath = output ? path.resolve(output) : inputPath.replace(/\.md$/i, '.html');
  const raw = await fs.readFile(inputPath, 'utf8');
  const html = await buildNotionHtmlString(raw, inputPath, { onWarning: ({ line, reason, marker }) => console.error(`警告: ${inputPath}:${line} ${reason}: ${marker}`) });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html);
  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
