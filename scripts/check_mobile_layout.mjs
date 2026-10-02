import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const DEFAULT_TARGETS = [
  'mockups/generated/fixture-long.html',
  'mockups/generated/fixture-table-stack.html',
  'mockups/generated/fixture-table-stack.editable.html',
  'mockups/generated/fixture-long.editable.html'
];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
const browser = await chromium.launch();
const failures = [];

try {
  for (const file of targets) {
    try {
      await fs.access(file);
    } catch {
      continue;
    }

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`file://${process.cwd()}/${file}`);
      await page.waitForSelector('.mdh-toc', { state: 'attached' });
      const metrics = await page.evaluate(async () => {
        const waitForDrawer = () => new Promise((resolve) => setTimeout(resolve, 220));
        const toc = document.querySelector('.mdh-toc');
        const toggle = document.querySelector('[data-action="toggle-toc"]');
        const shell = document.querySelector('.mdh-shell');
        const pageNode = document.querySelector('.mdh-page');
        const initialPageRect = pageNode.getBoundingClientRect();
        const initialTocRect = toc.getBoundingClientRect();
        const initialCollapsed = shell?.classList.contains('mdh-toc-collapsed') || false;
        const initialScrollWidth = document.documentElement.scrollWidth;
        const initialTocPosition = getComputedStyle(toc).position;
        toggle?.click();
        await waitForDrawer();
        const openTocRect = toc.getBoundingClientRect();
        const openPageRect = pageNode.getBoundingClientRect();
        const openCollapsed = shell?.classList.contains('mdh-toc-collapsed') || false;
        const openScrollWidth = document.documentElement.scrollWidth;
        toggle?.click();
        await waitForDrawer();
        const closedAgain = shell?.classList.contains('mdh-toc-collapsed') || false;
        const stackableTable = document.querySelector('table.mdh-stackable-table');
        const regularTable = document.querySelector('table:not(.mdh-stackable-table)');
        const stackableCell = stackableTable?.querySelector('tbody td');
        return {
          width: window.innerWidth,
          initialScrollWidth,
          openScrollWidth,
          initialCollapsed,
          openCollapsed,
          closedAgain,
          initialPageTop: Math.round(initialPageRect.top),
          openPageTop: Math.round(openPageRect.top),
          initialTocPosition,
          initialTocLeft: Math.round(initialTocRect.left),
          openTocLeft: Math.round(openTocRect.left),
          openTocRight: Math.round(openTocRect.right),
          openTocWidth: Math.round(openTocRect.width),
          stackableTableDisplay: stackableTable ? getComputedStyle(stackableTable).display : null,
          stackableCellLabel: stackableCell?.getAttribute('data-label') || null,
          regularTableDisplay: regularTable ? getComputedStyle(regularTable).display : null
        };
      });

      const label = `${file}: drawer ${metrics.openTocWidth}px, page ${metrics.initialScrollWidth}/${metrics.width}px`;
      if (metrics.initialScrollWidth > metrics.width) failures.push(`${label} has horizontal overflow while drawer is closed`);
      if (metrics.openScrollWidth > metrics.width) failures.push(`${label} has horizontal overflow while drawer is open`);
      if (!metrics.initialCollapsed) failures.push(`${label} did not start with mobile TOC collapsed`);
      if (metrics.openCollapsed) failures.push(`${label} did not open mobile TOC drawer after toggle`);
      if (!metrics.closedAgain) failures.push(`${label} did not close mobile TOC drawer after second toggle`);
      if (metrics.initialTocPosition !== 'fixed') failures.push(`${label} TOC is not fixed-position drawer`);
      if (metrics.initialPageTop > 96) failures.push(`${label} pushes page down before drawer opens`);
      if (Math.abs(metrics.openPageTop - metrics.initialPageTop) > 2) failures.push(`${label} shifts page vertically when drawer opens`);
      if (metrics.openTocLeft < 0 || metrics.openTocRight > metrics.width) failures.push(`${label} drawer is outside viewport`);
      if (file.includes('fixture-table-stack')) {
        if (metrics.stackableTableDisplay !== 'block') failures.push(`${label} does not stack 3-column table`);
        if (metrics.stackableCellLabel !== 'Channel') failures.push(`${label} missing stacked cell label`);
        if (metrics.regularTableDisplay !== 'table') failures.push(`${label} stacked 2-column table unexpectedly`);
      }
      if (metrics.initialScrollWidth <= metrics.width && metrics.openScrollWidth <= metrics.width) console.log(label);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('Mobile layout check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
