import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { buildNotionHtmlString } from './build-notion.mjs';
import * as renderer from './static-renderer.mjs';

const { extractHeatmapValue } = renderer;

test('extractHeatmapValue uses the last numeric token and normalizes its digits', () => {
  assert.equal(typeof extractHeatmapValue, 'function');

  const cases = [
    ['1,234', 1234],
    ['１２％', 12],
    ['579→422', 422],
    ['30 人未満', null],
    ['30 人未満→30 人未満', null]
  ];

  for (const [text, expected] of cases) {
    assert.equal(extractHeatmapValue(text), expected, text);
  }
});

test('extractHeatmapValue treats 件未満 as an unknown value', () => {
  assert.equal(extractHeatmapValue('42 件未満'), null);
  assert.equal(extractHeatmapValue('42 件未満→42 件未満'), null);
});

test('marked tables get a CSS-only view toggle and per-column heat values', async () => {
  const markdown = `# ヒートマップ検査

<!-- mdh:heatmap -->

| # | 自治体 | 人口 | 推移 | 件数 |
|---|---|---:|---:|---:|
| 1 | 千葉市 | １００ | 579→422 | 30 人未満 |
| 2 | 船橋市 | ２００ | 600→500 | 42 |
| 3 | 市川市 | ３００ | 700→650 | 84 |

| # | 自治体 | 人口 |
|---|---|---:|
| 1 | 柏市 | 400 |
`;

  const html = await buildNotionHtmlString(markdown, 'table-heatmap-test.md');
  const $ = load(html);
  const block = $('.mdh-heatmap-enabled');

  assert.equal(block.length, 1);
  assert.equal(block.children().eq(0).attr('class'), 'mdh-view-toggle');
  assert.equal(block.find('input[type="radio"]').length, 2);
  assert.equal(block.find('input[value="table"]').prop('checked'), true);
  assert.equal(block.find('input[value="heatmap"]').prop('checked'), false);
  assert.equal(block.find('label[for="mdh-view-1-table"]').text(), '表');
  assert.equal(block.find('label[for="mdh-view-1-heatmap"]').text(), 'ヒートマップ');
  assert.equal(block.children().eq(1).is('.mdh-table-scroll'), true);

  const table = block.find('table');
  assert.equal(table.find('tbody td.mdh-heat').length, 8);
  assert.equal(table.find('tbody td').filter((_, cell) => $(cell).attr('data-label') === '#').filter('.mdh-heat').length, 0);
  assert.equal(table.find('tbody td').filter((_, cell) => $(cell).attr('data-label') === '件数').filter('.mdh-heat').length, 2);
  assert.equal(table.find('tbody td.mdh-heat').filter((_, cell) => $(cell).attr('style').includes('0.10')).length >= 1, true);
  assert.equal(table.find('tbody td.mdh-heat').filter((_, cell) => $(cell).attr('style').includes('0.55')).length >= 1, true);
  assert.match($('style').text(), /\.mdh-doc \.mdh-table-block:has\(input\[value="heatmap"\]:checked\) td\.mdh-heat/);
  assert.match($('style').text(), /#cmt-imported-document \.mdh-table-block:has\(input\[value="heatmap"\]:checked\) td\.mdh-heat/);
  assert.doesNotMatch(html, /<script[^>]*heatmap|data-view=/);

  assert.equal($('.mdh-doc > .mdh-table-scroll').length, 1);
});

test('a marker separated from a table by another block does not enable that table', async () => {
  const markdown = `# マーカー位置検査

<!-- mdh:heatmap -->

この段落が間にある。

| A | B | C |
|---|---|---|
| 1 | 2 | 3 |
| 4 | 5 | 6 |
`;

  const html = await buildNotionHtmlString(markdown, 'table-heatmap-position-test.md');
  const $ = load(html);
  assert.equal($('.mdh-heatmap-enabled').length, 0);
  assert.equal($('.mdh-view-toggle').length, 0);
  assert.equal($('.mdh-doc .mdh-table-scroll > table').length, 1);
  assert.equal($('.mdh-doc .mdh-table-scroll > table td.mdh-heat').length, 0);
});

test('markerless text that mentions the generated class does not inject heatmap CSS', async () => {
  const markdown = `# CSS注入判定

本文に mdh-heatmap-enabled という識別子を書く。
`;

  const html = await buildNotionHtmlString(markdown, 'table-heatmap-css-test.md');
  assert.doesNotMatch(load(html)('style').text(), /mdh-table-block:has\(input\[value="heatmap"\]:checked\)/);
});

test('intermediate values follow the linear scale and every excluded header stays uncolored', async () => {
  // 手計算: alpha = 0.10 + (v - min) / (max - min) * 0.45。列 A は 0..100 なので 40 → 0.28、60 → 0.37。
  const markdown = `# 中間値と除外見出し

<!-- mdh:heatmap -->

| No | No. | 番号 | A |
|---:|---:|---:|---:|
| 1 | 1 | 1 | 0 |
| 2 | 2 | 2 | 40 |
| 3 | 3 | 3 | 60 |
| 4 | 4 | 4 | 100 |

区切りの段落。

| # | B |
|---|---:|
| 1 | 5 |
| 2 | 7 |

<!-- mdh:heatmap -->

| # | C |
|---|---:|
| 1 | 5 |
| 2 | 7 |
`;

  const html = await buildNotionHtmlString(markdown, 'table-heatmap-scale-test.md');
  const $ = load(html);
  const blocks = $('.mdh-heatmap-enabled');
  assert.equal(blocks.length, 2);
  assert.equal(blocks.eq(0).find('input[name="mdh-view-1"]').length, 2);
  assert.equal(blocks.eq(1).find('input[name="mdh-view-2"]').length, 2, 'marked tables are numbered 1, 2 regardless of the unmarked table in between');

  const first = blocks.eq(0).find('table');
  assert.equal(first.find('tbody td.mdh-heat').length, 4, 'only column A is colored');
  const alphas = first.find('tbody td.mdh-heat').map((_, cell) => $(cell).attr('style')).get();
  assert.deepEqual(alphas, [
    '--mdh-heat: rgba(47,111,115,0.10)',
    '--mdh-heat: rgba(47,111,115,0.28)',
    '--mdh-heat: rgba(47,111,115,0.37)',
    '--mdh-heat: rgba(47,111,115,0.55)'
  ]);
  assert.equal($('.mdh-doc > .mdh-table-scroll td.mdh-heat').length, 0, 'the unmarked table stays uncolored');
});

test('isNumericCellTextPrimary recognizes parenthetical and slash-separated composites (R2)', () => {
  assert.equal(typeof renderer.isNumericCellTextPrimary, 'function');

  const cases = [
    ['2.49%（7 / 281）', true],
    ['281 / 12（26.7%）', true],
    ['62.7%（69 人）', true],
    ['63 件 / 45 人', true],
    ['44（97.8%）', true],
    ['5（上限）', false],
    ['30 人未満', true],
    ['2.49％（7 / 281）', true],
    ['２.４９％（７ / ２８１）', true],
    ['62.7％（69 人）', true],
    ['12％', true]
  ];

  for (const [text, expected] of cases) {
    assert.equal(renderer.isNumericCellTextPrimary(text), expected, text);
  }
});

test('extractHeatmapValuePrimary takes the first percent value, else the first number, and nulls 未満 cells (R3)', () => {
  assert.equal(typeof renderer.extractHeatmapValuePrimary, 'function');

  const cases = [
    ['2.49%（7 / 281）', 2.49],
    ['2.49％（7 / 281）', 2.49],
    ['281 / 12（26.7%）', 26.7],
    ['62.7%（69 人）', 62.7],
    ['63 件 / 45 人', 63],
    ['44（97.8%）', 97.8],
    ['0', 0],
    ['1 位 38.4%（338 / 880）', 38.4],
    ['579→422', 579],
    ['30 人未満', null]
  ];

  for (const [text, expected] of cases) {
    assert.equal(renderer.extractHeatmapValuePrimary(text), expected, text);
  }
});

test('primary marker enables primary-mode coloring for its own table only; the default-marked table matches T004 (R1, R4, R5)', async () => {
  const markdown = `# 主値モード検査

<!-- mdh:heatmap -->

| # | 自治体 | 人口 | 推移 | 件数 |
|---|---|---:|---:|---:|
| 1 | 千葉市 | １００ | 579→422 | 30 人未満 |
| 2 | 船橋市 | ２００ | 600→500 | 42 |
| 3 | 市川市 | ３００ | 700→650 | 84 |

<!-- mdh:heatmap primary -->

| 地域 | 通過率 | 通過率の順位 | 内訳 |
|---|---:|---:|---:|
| A地区 | 2.49%（7 / 281） | 1 | 63 件 / 45 人 |
| B地区 | 44（97.8%） | 2 | 30 人未満 |
`;

  const html = await buildNotionHtmlString(markdown, 'table-heatmap-primary-test.md');
  const $ = load(html);
  const blocks = $('.mdh-heatmap-enabled');

  assert.equal(blocks.length, 2);
  assert.equal(blocks.eq(0).find('input[name="mdh-view-1"]').length, 2);
  assert.equal(blocks.eq(1).find('input[name="mdh-view-2"]').length, 2, 'radio numbering runs across both modes, 1-based');

  // R1: 既定モード側（1番目）は T004 と同一のセル値・alpha
  const defaultTable = blocks.eq(0).find('table');
  assert.equal(defaultTable.find('tbody td.mdh-heat').length, 8);
  assert.equal(defaultTable.find('tbody td').filter((_, cell) => $(cell).attr('data-label') === '#').filter('.mdh-heat').length, 0);
  assert.equal(defaultTable.find('tbody td').filter((_, cell) => $(cell).attr('data-label') === '件数').filter('.mdh-heat').length, 2);
  assert.equal(defaultTable.find('tbody td.mdh-heat').filter((_, cell) => $(cell).attr('style').includes('0.10')).length >= 1, true);
  assert.equal(defaultTable.find('tbody td.mdh-heat').filter((_, cell) => $(cell).attr('style').includes('0.55')).length >= 1, true);

  // R2/R3: 主値モード側（2番目）の着色列
  const primaryTable = blocks.eq(1).find('table');
  const passRateCells = primaryTable.find('tbody td').filter((_, cell) => $(cell).attr('data-label') === '通過率');
  assert.equal(passRateCells.filter('.mdh-heat').length, 2, '2.49 と 97.8 の2値が着色される');

  // R4: 見出しに「順位」を含む列は主値モードで着色しない
  const rankCells = primaryTable.find('tbody td').filter((_, cell) => $(cell).attr('data-label') === '通過率の順位');
  assert.equal(rankCells.filter('.mdh-heat').length, 0, '順位列は主値モードでも非着色');

  // 内訳列: 63（有効値） と 30人未満（null）→ 有効値が1件のみなので着色しない
  const detailCells = primaryTable.find('tbody td').filter((_, cell) => $(cell).attr('data-label') === '内訳');
  assert.equal(detailCells.filter('.mdh-heat').length, 0, '有効値が1件のみの列は着色しない');

  // R1: マーカーはどちらも出力へ残らない
  assert.doesNotMatch(html, /mdh:heatmap/);
});

test('external http(s) links open in a new tab; internal links stay as they are', async () => {
  const md = [
    '# 外部リンク',
    '',
    '[共有版](https://example.com/reviews/abc) と [節](#scope) と [相対](./other.html) と [メール](mailto:a@example.com)',
    ''
  ].join('\n');
  const html = await buildNotionHtmlString(md, 'fixture-external-links.md');
  const $ = load(html);
  const ext = $('article.mdh-doc a[href="https://example.com/reviews/abc"]');
  assert.equal(ext.length, 1);
  assert.equal(ext.attr('target'), '_blank');
  assert.equal(ext.attr('rel'), 'noopener noreferrer');
  for (const href of ['#scope', './other.html', 'mailto:a@example.com']) {
    const a = $(`article.mdh-doc a[href="${href}"]`);
    assert.equal(a.length, 1, href);
    assert.equal(a.attr('target'), undefined, href);
  }
});

test('<!-- mdh:button --> turns the next single-link paragraph into a button link; marker is not emitted', async () => {
  const md = [
    '# ボタン',
    '',
    '<!-- mdh:button -->',
    '[共有版を新しいタブで開く](https://example.com/reviews/abc)',
    '',
    '<!-- mdh:button -->',
    '本文だけの段落は対象外',
    '',
    '[普通のリンク](https://example.com/plain)',
    ''
  ].join('\n');
  const html = await buildNotionHtmlString(md, 'fixture-button.md');
  const $ = load(html);
  const btn = $('article.mdh-doc p.mdh-button-row > a.mdh-button');
  assert.equal(btn.length, 1);
  assert.equal(btn.attr('href'), 'https://example.com/reviews/abc');
  assert.equal(btn.attr('target'), '_blank');
  assert.equal($('article.mdh-doc a.mdh-button').length, 1);
  assert.equal($('article.mdh-doc a[href="https://example.com/plain"]').hasClass('mdh-button'), false);
  assert.equal(html.includes('mdh:button'), false);
  assert.match($('style').text(), /\.mdh-doc a\.mdh-button/);
});
