import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

export async function withPage(htmlPath, fn) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(60000);
  await page.goto(pathToFileURL(path.resolve(htmlPath)).href);
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}
