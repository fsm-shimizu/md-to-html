import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildNotionHtmlString } from './lib/build-notion.mjs';

const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length
  ? requestedTargets.map((file) => ({ label: file, file }))
  : [
      {
        label: 'mockups/fixtures/fixture-long.md (current renderer)',
        html: await buildFixtureHtml('mockups/fixtures/fixture-long.md')
      }
    ];
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
const browser = await chromium.launch({ executablePath });

try {
  for (const target of targets) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

    try {
      if (target.html) {
        await page.setContent(target.html, { waitUntil: 'load' });
      } else {
        await fs.access(target.file);
        await page.goto(pathToFileURL(path.resolve(target.file)).href);
      }
      await page.waitForSelector('.mdh-toc-node');
      const expandableNodes = page.locator(
        '.mdh-toc-node:has(> details.mdh-toc-disclosure > .mdh-toc-children > *)'
      );
      const count = await expandableNodes.count();
      assert(count > 0, `${target.label} has no expandable TOC nodes`);

      for (let index = 0; index < count; index += 1) {
        const node = expandableNodes.nth(index);
        const details = node.locator(':scope > details.mdh-toc-disclosure');
        if (!(await details.evaluate((element) => element.open))) {
          await details.locator(':scope > summary').click();
        }

        const metrics = await node.evaluate((element) => {
          const title = element.querySelector(':scope > .mdh-toc-title')?.getBoundingClientRect();
          const firstChild = element
            .querySelector(':scope > details > .mdh-toc-children > :first-child')
            ?.getBoundingClientRect();
          return {
            title: title
              ? { top: title.top, bottom: title.bottom, width: title.width, height: title.height }
              : null,
            firstChild: firstChild
              ? {
                  top: firstChild.top,
                  bottom: firstChild.bottom,
                  width: firstChild.width,
                  height: firstChild.height
                }
              : null
          };
        });

        assert(metrics.title, `${target.label} expandable TOC node ${index + 1} has no title`);
        assert(metrics.firstChild, `${target.label} expandable TOC node ${index + 1} has no first child`);
        assert(
          metrics.title.width > 0 && metrics.title.height > 0,
          `${target.label} expandable TOC node ${index + 1} has a hidden or zero-sized title`
        );
        assert(
          metrics.firstChild.width > 0 && metrics.firstChild.height > 0,
          `${target.label} expandable TOC node ${index + 1} has a hidden or zero-sized first child`
        );
        assert(
          metrics.firstChild.top >= metrics.title.bottom,
          `${target.label} expandable TOC node ${index + 1} overlaps its first child: ` +
            `title bottom=${metrics.title.bottom}, child top=${metrics.firstChild.top}`
        );
      }

      console.log(`${target.label}: ${count} expandable TOC nodes have non-overlapping titles and children`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

async function buildFixtureHtml(file) {
  const inputPath = path.resolve(file);
  const raw = await fs.readFile(inputPath, 'utf8');
  return buildNotionHtmlString(raw, inputPath);
}
