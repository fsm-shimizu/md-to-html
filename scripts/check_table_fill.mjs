// 表の自動幅拡張（TABLE_AUTOFILL_SCRIPT）が仕様どおりに動くことを実ブラウザで確認する。
// 1280px で全表について (a) 横スクロールしない表は幅が親幅の 99% 以上、(b) 見出しセルの折り返し 0、
// (c) 折り返し列より先に上限に達した列へ幅が配られていない（折り返しが残る列があるのに、他の列が
// 自分の折り返さない幅を超えて広がっている状態が無い）、(d) ページ全体の横スクロール 0、を DOM 実測で判定する。
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const toFileUrl = (file) => `file://${path.isAbsolute(file) ? file : path.join(process.cwd(), file)}`;

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['mockups/generated/fixture-table-stack.html', 'mockups/generated/fixture-table-heatmap.html'];
const TOLERANCE = 2;
const browser = await chromium.launch();
const failures = [];

try {
  for (const file of targets) {
    try {
      await fs.access(file);
    } catch {
      continue;
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(toFileUrl(file));
      // TABLE_AUTOFILL_SCRIPT は同期実行だが、実ブラウザのレイアウト確定を待つため小休止する。
      await page.waitForTimeout(150);
      const check = (ok, message) => {
        if (!ok) failures.push(`${file}: ${message}`);
      };

      const pageMetrics = await page.evaluate(() => ({
        pageScroll: document.documentElement.scrollWidth,
        viewport: window.innerWidth
      }));
      check(
        pageMetrics.pageScroll <= pageMetrics.viewport,
        `page should not scroll horizontally (page ${pageMetrics.pageScroll}/${pageMetrics.viewport})`
      );

      const results = await page.evaluate(() => {
        const measureUnwrapped = (cellsByColumn) => {
          const allCells = cellsByColumn.flat();
          const saved = allCells.map((cell) => [cell.style.whiteSpace, cell.style.maxWidth]);
          allCells.forEach((cell) => {
            cell.style.whiteSpace = 'nowrap';
            cell.style.maxWidth = 'none';
          });
          const widths = cellsByColumn.map((cells) => cells.reduce((max, cell) => Math.max(max, cell.getBoundingClientRect().width), 0));
          allCells.forEach((cell, i) => {
            cell.style.whiteSpace = saved[i][0];
            cell.style.maxWidth = saved[i][1];
          });
          return widths;
        };

        return Array.from(document.querySelectorAll('.mdh-doc .mdh-table-scroll > table')).map((table, tableIndex) => {
          const wrap = table.closest('.mdh-table-scroll');
          const wrapRect = wrap.getBoundingClientRect();
          const tableRect = table.getBoundingClientRect();
          const headerRow = table.querySelector('tr');
          const colCount = headerRow ? headerRow.children.length : 0;
          const cellsByColumn = Array.from({ length: colCount }, () => []);
          table.querySelectorAll('tr').forEach((row) => {
            Array.from(row.children).forEach((cell, i) => {
              if (i < colCount) cellsByColumn[i].push(cell);
            });
          });
          const currentWidths = cellsByColumn.map((cells) => cells.reduce((max, cell) => Math.max(max, cell.getBoundingClientRect().width), 0));
          const unwrappedWidths = measureUnwrapped(cellsByColumn);

          // 見出しセルには COLUMN_RESIZE_SCRIPT が追加する .mdh-col-resizer ハンドルが子要素として入っており、
          // Range 測定にそのまま含めると絶対配置の矩形が余分な行として数えられ誤検出するため、一時的に外して測る。
          const headerWraps = Array.from(headerRow ? headerRow.children : []).map((cell) => {
            const resizer = cell.querySelector(':scope > .mdh-col-resizer');
            const nextSibling = resizer ? resizer.nextSibling : null;
            if (resizer) resizer.remove();
            const range = document.createRange();
            range.selectNodeContents(cell);
            const wrapped = range.getClientRects().length > 1;
            if (resizer) cell.insertBefore(resizer, nextSibling);
            return wrapped;
          });

          const noScroll = wrap.scrollWidth <= wrap.clientWidth + 2;

          return {
            tableIndex,
            wrapWidth: wrapRect.width,
            tableWidth: tableRect.width,
            noScroll,
            headerWrapCount: headerWraps.filter(Boolean).length,
            currentWidths,
            unwrappedWidths
          };
        });
      });

      results.forEach((result) => {
        const label = `${file} table#${result.tableIndex}`;
        if (result.noScroll) {
          check(
            result.tableWidth >= result.wrapWidth * 0.99,
            `${label}: non-scrolling table should fill >=99% of parent width (table ${result.tableWidth.toFixed(1)} / wrap ${result.wrapWidth.toFixed(1)})`
          );
        }
        check(result.headerWrapCount === 0, `${label}: header cells should not wrap (${result.headerWrapCount} wrapped)`);
        const wrappedCols = result.currentWidths.map((width, i) => width < result.unwrappedWidths[i] - TOLERANCE);
        if (wrappedCols.some(Boolean)) {
          const overAllocated = result.currentWidths.some((width, i) => !wrappedCols[i] && width > result.unwrappedWidths[i] + TOLERANCE);
          check(!overAllocated, `${label}: a column exceeds its own unwrap width while another column still wraps`);
        }
      });

      if (results.length) {
        console.log(
          `${file}: tables ${results.length}, page ${pageMetrics.pageScroll}/${pageMetrics.viewport}px, ` +
            results
              .map((r) => `#${r.tableIndex} ${r.tableWidth.toFixed(0)}/${r.wrapWidth.toFixed(0)}px noScroll=${r.noScroll} headerWrap=${r.headerWrapCount}`)
              .join(', ')
        );
      } else {
        console.log(`${file}: no tables found`);
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('Table fill check failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
