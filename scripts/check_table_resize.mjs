// 表の列幅ドラッグ（Notion 風）が静的 HTML で動くことを実ブラウザで確認する。
// 1280px で見出しセル右端のハンドルを +80px ドラッグし、その列だけ広がり、表全体が同じ分だけ広がり、
// はみ出しが .mdh-table-scroll の横スクロールに収まってページの横スクロールが出ないことを DOM 実測で判定する。
// 併せて、全表にハンドルが付くこと、2 列目の操作、縮小（最小 48px）、幅を変えた後に 390px へ縮めてもページの横スクロールが出ないことを見る。
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['mockups/generated/fixture-table-stack.html'];
const DRAG = 80;
const TOLERANCE = 3;
const browser = await chromium.launch();
const failures = [];

const drag = async (page, handle, dx) => {
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y);
  await page.mouse.move(x + dx, y);
  await page.mouse.up();
};
const widthsOf = (table) => table.evaluate((el) => Array.from(el.querySelector('tr').children).map((cell) => Math.round(cell.getBoundingClientRect().width)));
const tableWidth = (table) => table.evaluate((el) => Math.round(el.getBoundingClientRect().width));
const pageMetrics = (page) => page.evaluate(() => ({ pageScroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));

try {
  for (const file of targets) {
    await fs.access(file);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`file://${process.cwd()}/${file}`);
      const check = (ok, message) => { if (!ok) failures.push(`${file}: ${message}`); };

      // 全表にハンドルが付く（表ごとに見出しセル数と同数）
      const handleCounts = await page.evaluate(() => Array.from(document.querySelectorAll('.mdh-doc .mdh-table-scroll > table')).map((table) => ({
        headers: table.querySelector('tr').children.length,
        handles: table.querySelectorAll('.mdh-col-resizer').length
      })));
      check(handleCounts.length >= 2, `fixture should contain at least 2 tables (found ${handleCounts.length})`);
      check(handleCounts.every((t) => t.headers > 0 && t.handles === t.headers), `every table should have one handle per header cell (${JSON.stringify(handleCounts)})`);

      const tables = page.locator('.mdh-doc .mdh-table-scroll > table');
      const first = tables.nth(0);
      const second = tables.nth(1);

      // 先頭の表: 2 列目を +80px 広げる（他列は不変、表は +80px、ページの横スクロールなし）
      const before = await widthsOf(first);
      const tableBefore = await tableWidth(first);
      await drag(page, first.locator('.mdh-col-resizer').nth(1), DRAG);
      const after = await widthsOf(first);
      const metrics = await first.evaluate((el) => {
        const wrap = el.parentElement;
        return { tableWidth: Math.round(el.getBoundingClientRect().width), resized: el.classList.contains('mdh-table-resized'), resizing: el.classList.contains('mdh-table-resizing'), colCount: el.querySelectorAll('colgroup > col').length, wrapScroll: wrap.scrollWidth };
      });
      const pm = await pageMetrics(page);
      check(Math.abs(after[1] - before[1] - DRAG) <= TOLERANCE, `second column should grow by ${DRAG}px (before ${before[1]}, after ${after[1]})`);
      check(before.every((width, i) => i === 1 || Math.abs(after[i] - width) <= TOLERANCE), `other columns should keep their width (${before} → ${after})`);
      check(Math.abs(metrics.tableWidth - tableBefore - DRAG) <= TOLERANCE, `table should grow by ${DRAG}px (before ${tableBefore}, after ${metrics.tableWidth})`);
      check(metrics.resized && !metrics.resizing && metrics.colCount === before.length, 'table should be in resized mode with one <col> per column');
      check(metrics.wrapScroll >= metrics.tableWidth && pm.pageScroll <= pm.viewport, `overflow should stay inside .mdh-table-scroll (page ${pm.pageScroll}/${pm.viewport})`);
      // 固定化しただけの列（ドラッグしていない列）で nowrap の数値セル（.mdh-num）が省略されない（切り捨て丸めによる 1px 未満のはみ出しを検出）
      const clipped = await first.evaluate((el) => Array.from(el.querySelectorAll('tr')).flatMap((row) => Array.from(row.children).filter((cell, i) => i !== 1 && cell.classList.contains('mdh-num') && cell.scrollWidth > cell.clientWidth).map((cell) => cell.textContent.trim())));
      check(clipped.length === 0, `untouched numeric cells should not clip their content (clipped: ${JSON.stringify(clipped)})`);

      // 縮小: 1 列目を -200px 動かしても最小 48px で止まる
      await drag(page, first.locator('.mdh-col-resizer').nth(0), -200);
      const shrunk = await widthsOf(first);
      check(Math.abs(shrunk[0] - 48) <= TOLERANCE, `column should not shrink below 48px (got ${shrunk[0]})`);

      // ダブルクリックで元に戻る
      await first.locator('.mdh-col-resizer').nth(0).dblclick();
      const reset = await first.evaluate((el) => ({ resized: el.classList.contains('mdh-table-resized'), colgroup: el.querySelectorAll('colgroup').length, width: el.style.width }));
      check(!reset.resized && reset.colgroup === 0 && reset.width === '', 'double-click should reset the table layout');

      // 2 つ目の表（stack 対象外の少列表）を広げてから 390px に縮めても、ページの横スクロールが出ない
      const secondBefore = await tableWidth(second);
      await drag(page, second.locator('.mdh-col-resizer').nth(0), 400);
      const secondAfter = await tableWidth(second);
      check(Math.abs(secondAfter - secondBefore - 400) <= TOLERANCE, `second table should grow by 400px (before ${secondBefore}, after ${secondAfter})`);
      await page.setViewportSize({ width: 390, height: 800 });
      const mobile = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll('.mdh-doc .mdh-table-scroll > table'));
        return {
          pageScroll: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
          stackHandlesHidden: tables.filter((t) => t.classList.contains('mdh-stackable-table')).every((t) => Array.from(t.querySelectorAll('.mdh-col-resizer')).every((h) => getComputedStyle(h).display === 'none')),
          stackCount: tables.filter((t) => t.classList.contains('mdh-stackable-table')).length
        };
      });
      check(mobile.pageScroll <= mobile.viewport, `resized table must not widen the page at 390px (page ${mobile.pageScroll}/${mobile.viewport})`);
      check(mobile.stackCount > 0 && mobile.stackHandlesHidden, 'handles on stacked tables must be hidden at 390px');

      console.log(`${file}: tables ${handleCounts.length}, col2 ${before[1]}→${after[1]}px, table ${tableBefore}→${metrics.tableWidth}px, shrink→${shrunk[0]}px, reset ok=${!reset.resized}, second table ${secondBefore}→${secondAfter}px, 390px page ${mobile.pageScroll}/${mobile.viewport}px`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('Table resize check failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
