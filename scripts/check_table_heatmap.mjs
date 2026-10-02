// 表のヒートマップ切り替えが、デスクトップとモバイルの実描画で動くことを確認する。
// 既定の表表示では対象セルの背景が透明、ヒートマップ表示では値の大小が alpha に反映され、
// 表表示へ戻すと透明へ戻ること、識別子列には色が付かないことを DOM 実測で判定する。
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TARGETS = [
  'mockups/generated/fixture-table-heatmap.html',
  'mockups/generated/fixture-table-heatmap-primary.html'
];
// ファイルごとに検査対象の列（着色される数値列／着色されない識別列）のヘッダー文字列を切り替える。
// 既定fixtureは T004 のまま「人口」「#」。主値fixture（T005）は「到達率」「到達率の順位」。
const TARGET_CONFIGS = {
  'fixture-table-heatmap.html': { numericLabel: '人口', identifierLabel: '#' },
  'fixture-table-heatmap-primary.html': { numericLabel: '到達率', identifierLabel: '到達率の順位' }
};
const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
const browser = await chromium.launch();
const failures = [];

const alphaOf = (color) => {
  const match = color.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return NaN;
  const channels = match[1].split(',').map((channel) => channel.trim());
  return channels.length === 4 ? Number(channels[3]) : 1;
};

const check = (ok, file, message) => {
  if (!ok) failures.push(`${file}: ${message}`);
};

try {
  for (const file of targets) {
    await fs.access(file);
    const config = TARGET_CONFIGS[path.basename(file)] ?? { numericLabel: '人口', identifierLabel: '#' };
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(pathToFileURL(path.resolve(file)).href);
      const block = page.locator('.mdh-doc .mdh-heatmap-enabled');
      check(await block.count() === 1, file, 'expected exactly one enabled heatmap table');
      if (await block.count() !== 1) continue;

      const tableInput = block.locator('input[value="table"]');
      const heatmapInput = block.locator('input[value="heatmap"]');
      const tableLabel = block.locator('label[for="mdh-view-1-table"]');
      const heatmapLabel = block.locator('label[for="mdh-view-1-heatmap"]');
      check(await tableInput.isChecked(), file, 'table radio should be checked by default');
      check(!(await heatmapInput.isChecked()), file, 'heatmap radio should be unchecked by default');
      check(await tableLabel.count() === 1 && await heatmapLabel.count() === 1, file, 'view labels should be present');

      const firstHeatCell = block.locator('tbody td.mdh-heat').first();
      const defaultColor = await firstHeatCell.evaluate((cell) => getComputedStyle(cell).backgroundColor);
      check(alphaOf(defaultColor) === 0, file, `default heat cell should be transparent (got ${defaultColor})`);

      await heatmapLabel.click();
      check(await heatmapInput.isChecked(), file, 'heatmap radio should be checked after label click');
      const populationCells = await block.locator(`tbody td[data-label="${config.numericLabel}"].mdh-heat`).evaluateAll((cells) => cells.map((cell) => {
        // 主値fixtureのセルは「2.49%（7 / 281）」のように補足を伴うため、% があれば最初の%値、
        // 無ければ最初の数値を読む（scripts/lib/static-renderer.mjs の extractHeatmapValuePrimary と同じ優先順）。
        const text = cell.textContent.trim();
        const match = text.match(/([+-]?\d+(?:[.,]\d+)*)\s*[%％]/) || text.match(/([+-]?\d+(?:[.,]\d+)*)/);
        return { value: match ? Number(match[1].replaceAll(',', '')) : NaN, color: getComputedStyle(cell).backgroundColor };
      }));
      const populationAlphas = populationCells.map(({ color }) => alphaOf(color));
      const populationMax = populationCells.reduce((max, cell) => cell.value > max.value ? cell : max, populationCells[0]);
      const populationMin = populationCells.reduce((min, cell) => cell.value < min.value ? cell : min, populationCells[0]);
      check(populationAlphas.length >= 2 && alphaOf(populationMax.color) > alphaOf(populationMin.color), file, `heatmap alpha should increase from min to max (got ${JSON.stringify(populationCells)})`);

      const identifierColor = await block.locator(`tbody td[data-label="${config.identifierLabel}"]`).first().evaluate((cell) => getComputedStyle(cell).backgroundColor);
      check(alphaOf(identifierColor) === 0, file, `identifier column should remain transparent (got ${identifierColor})`);

      await tableLabel.click();
      const resetColor = await firstHeatCell.evaluate((cell) => getComputedStyle(cell).backgroundColor);
      check(await tableInput.isChecked(), file, 'table radio should be checked after returning to table view');
      check(alphaOf(resetColor) === 0, file, `table view should restore transparent heat cell (got ${resetColor})`);

      await page.setViewportSize({ width: 390, height: 800 });
      await heatmapLabel.click();
      const mobileCells = await block.locator(`tbody td[data-label="${config.numericLabel}"].mdh-heat`).evaluateAll((cells) => cells.map((cell) => {
        const text = cell.textContent.trim();
        const match = text.match(/([+-]?\d+(?:[.,]\d+)*)\s*[%％]/) || text.match(/([+-]?\d+(?:[.,]\d+)*)/);
        return { value: match ? Number(match[1].replaceAll(',', '')) : NaN, color: getComputedStyle(cell).backgroundColor };
      }));
      const mobileAlphas = mobileCells.map(({ color }) => alphaOf(color));
      const mobileMax = mobileCells.reduce((max, cell) => cell.value > max.value ? cell : max, mobileCells[0]);
      const mobileMin = mobileCells.reduce((min, cell) => cell.value < min.value ? cell : min, mobileCells[0]);
      check(mobileAlphas.length >= 2 && alphaOf(mobileMax.color) > alphaOf(mobileMin.color), file, `mobile heatmap alpha should increase from min to max (got ${JSON.stringify(mobileCells)})`);

      console.log(`${file}: default alpha ${alphaOf(defaultColor)}, desktop population alpha ${populationAlphas.join('→')}, mobile population alpha ${mobileAlphas.join('→')}, reset alpha ${alphaOf(resetColor)}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('Table heatmap check failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
