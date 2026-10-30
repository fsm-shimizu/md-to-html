import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TARGETS = [
  'mockups/generated/fixture-long.html',
  'mockups/generated/fixture-table-stack.html',
  'mockups/generated/fixture-table-stack.editable.html',
  'mockups/generated/fixture-long.editable.html'
];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
// 入口の負例: 設定の部品を取り除いた静的版の写しは、入口が無いとして落ちなければならない。
const NEGATIVE = path.join(os.tmpdir(), `mdh-mobile-negative-${process.pid}.html`);
await fs.writeFile(NEGATIVE, (await fs.readFile('mockups/generated/fixture-long.html', 'utf8')).replace(/<details class="mdh-settings-menu">[\s\S]*?<\/details>/, ''));
targets.push(NEGATIVE);
const browser = await chromium.launch();
const failures = [];

try {
  for (const file of targets) {
    try {
      await fs.access(file);
    } catch {
      // 対象のファイルが無いのを黙って飛ばすと、何も確かめずに通ってしまう。
      failures.push(`${file}: file not found`);
      continue;
    }

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(pathToFileURL(path.resolve(file)).href);
      await page.waitForSelector('.mdh-toc', { state: 'attached' });
      const metrics = await page.evaluate(async () => {
        const waitForDrawer = () => new Promise((resolve) => setTimeout(resolve, 220));
        const toc = document.querySelector('.mdh-toc');
        // 静的 HTML（書き出した HTML を含む）は設定パネルの引き出しのスイッチ（details と checkbox）、
        // 編集版は旧「目次を閉じる」ボタンで開閉する。入口が無ければ失敗にする。
        const menu = document.querySelector('details.mdh-settings-menu');
        const drawer = menu && menu.querySelector('input[name="mdh-toc-drawer"]');
        const legacy = document.querySelector('[data-action="toggle-toc"]');
        if (!drawer && !legacy) return { missingEntry: true };
        const setToc = async (show) => {
          if (legacy) { legacy.click(); return; }
          if (!menu.open) menu.querySelector('summary').click();
          if (drawer.checked !== show) drawer.closest('label').click();
        };
        // 畳んだかどうかは、どの入口でも同じ CSS の結果（目次の visibility）で見る。
        const collapsed = () => getComputedStyle(toc).visibility === 'hidden';
        const shell = document.querySelector('.mdh-shell');
        const pageNode = document.querySelector('.mdh-page');
        const initialPageRect = pageNode.getBoundingClientRect();
        const initialTocRect = toc.getBoundingClientRect();
        const initialCollapsed = collapsed();
        const initialScrollWidth = document.documentElement.scrollWidth;
        const initialTocPosition = getComputedStyle(toc).position;
        await setToc(true);
        await waitForDrawer();
        const openTocRect = toc.getBoundingClientRect();
        const openPageRect = pageNode.getBoundingClientRect();
        const openCollapsed = collapsed();
        const openScrollWidth = document.documentElement.scrollWidth;
        await setToc(false);
        await waitForDrawer();
        const closedAgain = collapsed();
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
          // 3 列以上の表も、狭い画面でカードに組み替えず表のまま、包みの中で横にスクロールする
          stackableTableDisplay: stackableTable ? getComputedStyle(stackableTable).display : null,
          stackableHeadDisplay: stackableTable?.querySelector('thead') ? getComputedStyle(stackableTable.querySelector('thead')).display : null,
          stackableCellBefore: stackableCell ? getComputedStyle(stackableCell, '::before').content : null,
          stackableScrollOverflow: stackableTable?.parentElement ? getComputedStyle(stackableTable.parentElement).overflowX : null,
          // 文字のセルは 8 文字ぶん（14px の本文で 112px）より細くしない。収まらない表は包みの中で横にスクロールする
          narrowTextCells: stackableTable ? [...stackableTable.querySelectorAll('td:not(.mdh-num), th:not(.mdh-num)')].filter((c) => c.textContent.trim().length > 8 && c.getBoundingClientRect().width < 100).length : null,
          regularTableDisplay: regularTable ? getComputedStyle(regularTable).display : null
        };
      });

      if (metrics.missingEntry) {
        failures.push(`${file}: no TOC toggle entry (neither [data-action="toggle-settings"] nor [data-action="toggle-toc"])`);
        continue;
      }
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
        if (metrics.stackableTableDisplay !== 'table') failures.push(`${label} 3-column table is not a table (${metrics.stackableTableDisplay})`);
        if (metrics.stackableHeadDisplay !== 'table-header-group') failures.push(`${label} 3-column table header is hidden (${metrics.stackableHeadDisplay})`);
        if (metrics.stackableCellBefore !== 'none' && metrics.stackableCellBefore !== 'normal') failures.push(`${label} 3-column cell shows a card label (${metrics.stackableCellBefore})`);
        if (metrics.narrowTextCells !== 0) failures.push(`${label} 3-column table has ${metrics.narrowTextCells} text cells narrower than 100px`);
        if (!['auto', 'scroll'].includes(metrics.stackableScrollOverflow)) failures.push(`${label} 3-column table wrapper does not scroll horizontally (${metrics.stackableScrollOverflow})`);
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

const negativeIndex = failures.findIndex((f) => f.startsWith(`${NEGATIVE}: no TOC toggle entry`));
if (negativeIndex === -1) failures.push(`negative: the check passed without the settings menu (${NEGATIVE})`); else failures.splice(negativeIndex, 1);
await fs.rm(NEGATIVE, { force: true });
if (failures.length) {
  console.error('Mobile layout check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
