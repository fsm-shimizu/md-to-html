import fs from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { HEAT_RGB } from './lib/static-renderer.mjs';

const input = process.argv[2];

if (!input) {
  console.error('Usage: node scripts/validate_notion_html.mjs <output.html>');
  process.exit(1);
}

const html = await fs.readFile(input, 'utf8');
const $ = load(html);
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

assert($('aside.mdh-toc').length === 1, 'expected exactly one aside.mdh-toc');
assert($('article.mdh-doc').length === 1, 'expected exactly one article.mdh-doc');
assert($('header.mdh-title').length === 1, 'expected exactly one header.mdh-title');
// 目次の開閉は設定パネルへ移した。旧「目次を閉じる」ボタンは静的 HTML に出さない。
assert($('details.mdh-settings-menu > summary[data-action="toggle-settings"]').length === 1, 'missing settings menu (details > summary[data-action="toggle-settings"])');
assert($('details.mdh-settings-menu[open]').length === 0, 'settings menu must start closed');
assert($('details.mdh-settings-menu #mdhSettingsPanel').length === 1, 'settings panel must be inside the settings menu');
assert($('input[type="radio"][name="mdh-toc"]').length === 2, 'expected 2 toc radios');
assert($('input[type="radio"][name="mdh-width"]').length === 3, 'expected 3 width radios');
assert($('input[type="checkbox"][name="mdh-toc-drawer"]').length === 1, 'expected 1 toc drawer checkbox');
assert($('input[name="mdh-toc-drawer"][checked]').length === 0, 'toc drawer must start closed');
assert($('[data-action="toggle-toc"]').length === 0, 'legacy toggle-toc button must not be rendered');
assert($('style').toArray().some((el) => $(el).text().trimStart().startsWith('/* mdh:style */')), 'style marker /* mdh:style */ is missing');
assert($('script').toArray().filter((el) => $(el).text().trimStart().startsWith('/* mdh:script */')).length === $('script').length, 'every md-to-html script must start with /* mdh:script */');
// 設定のスクリプトだけが欠けても他のスクリプトの目印で通らないよう、保存のキーを持つスクリプトがあることを確かめる。
assert($('script').toArray().some((el) => $(el).text().includes("'mdh-settings:v1:'")), 'settings script (SETTINGS_SCRIPT) is missing');
assert($('script[src]').length === 0, 'static HTML must not reference external scripts');
assert($('aside.mdh-toc h4, aside.mdh-toc .mdh-toc-h4').length === 0, 'TOC must not contain h4 entries');
assert($('aside.mdh-toc .mdh-toc-h1 > details[open]').length === 0, 'h1 TOC nodes must be closed by default');
assert(
  $('.summary-card, section.summary-card, [class*="summary-card"]').length === 0,
  'MVP must not output summary cards'
);
assert($('aside.mdh-toc summary a').length === 0, 'TOC summary must not contain anchor links');
assert(
  $('aside.mdh-toc .mdh-toc-node > details > .mdh-toc-title').length === 0,
  'TOC heading title links must remain outside details so closed nodes still show text'
);
assert(
  $('aside.mdh-toc .mdh-toc-node > details + .mdh-toc-title, aside.mdh-toc .mdh-toc-node > .mdh-toc-spacer + .mdh-toc-title').length === $('aside.mdh-toc .mdh-toc-node').length,
  'TOC nodes should have visible sibling heading title links aligned after a toggle or spacer'
);
$('aside.mdh-toc .mdh-toc-node').each((_, el) => {
  const node = $(el);
  const details = node.children('details.mdh-toc-disclosure');
  const spacer = node.children('.mdh-toc-spacer');
  if (details.length) {
    assert(
      details.find('> .mdh-toc-children').children().length > 0,
      'TOC disclosure toggles should only render for nodes with children'
    );
  } else {
    assert(spacer.length === 1, 'TOC leaf nodes should reserve the toggle column with a spacer');
  }
});

const ids = new Set();
$('[id]').each((_, el) => {
  const id = $(el).attr('id');
  assert(!ids.has(id), `duplicate id: ${id}`);
  ids.add(id);
});

$('aside.mdh-toc a').each((_, el) => {
  const href = $(el).attr('href');
  const text = $(el).text().trim();
  const label = text || '<empty text>';
  assert(
    href?.startsWith('#') && href.length > 1,
    `TOC link must use a non-empty fragment href: ${label}`
  );
  if (href?.startsWith('#') && href.length > 1) {
    // 目次のリンク先は % を %25 にしている（見出しの記号の名前）ので、1 回復号して id と比べる
    let id = null;
    try { id = decodeURIComponent(href.slice(1)); } catch { /* 不正な符号化は解決しないものとして扱う */ }
    assert(id !== null && ids.has(id), `TOC href does not resolve: ${href} (${label})`);
  }
});

const titleText = $('header.mdh-title h1').first().text().trim();
assert(titleText.length > 0, 'document title must be present in header.mdh-title h1');

const basename = path.basename(input);
const tocText = $('aside.mdh-toc').text();
const styleText = $('style').text();
assert(styleText.includes('#cmt-imported-document pre'), 'imported document code block styling is missing');
assert(styleText.includes('#cmt-imported-document blockquote'), 'imported document quote styling is missing');

// 文書デザインの刷新: 旧デザインの装飾が残っていないこと、新デザインの必須要素があることを確かめる。
// 本文に旧名称や色コードを書いた文書を誤って落とさないよう、装飾はタイトル領域の要素、旧スタイルは <style> の中と style 属性だけを見る。
assert($('header.mdh-title .mdh-title-icon, header.mdh-title .mdh-title-label').length === 0, 'title decoration (◎ / Markdown Document) must not be rendered');
for (const legacy of ['tr:nth-child(even)', 'box-shadow: 0 1px 2px', 'rgba(47,111,115', '#2f6f73', 'tbody tr:hover td { background: var(--accent-soft)']) {
  assert(!styleText.includes(legacy), `legacy style must be removed: ${legacy}`);
  // ヒートマップの色はセルの style 属性に出るため、属性も見る。
  assert(!$('[style]').toArray().some((el) => $(el).attr('style').includes(legacy)), `legacy inline style must be removed: ${legacy}`);
}
assert(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*IBM\+Plex\+Mono/.test(html), 'IBM Plex Mono font link is missing');
assert(styleText.includes('--font-sans: "Noto Sans JP",'), 'Noto Sans JP font stack is missing');
assert(styleText.includes('.sr-only {'), 'visually hidden (.sr-only) rule for footnote heading is missing');
assert(styleText.includes('.mdh-doc em, #cmt-imported-document em { font-style: normal; }'), 'em must not be italic');
// CSS にも同じクラス名があるため、スクリプトと CSS を別々に確かめる。動作は layout:runtime で確かめる。
assert($('script').toArray().some((el) => $(el).text().includes("classList.add('mdh-toc-current')")), 'TOC current-section script is missing');
assert(styleText.includes('a.mdh-toc-current'), 'TOC current-section style is missing');

if (basename.includes('fixture-short')) {
  assert(
    $('article.mdh-doc > h1').first().text().trim() === '概要',
    'fixture-short should promote original h2 概要 to article h1'
  );
  assert(tocText.includes('目的'), 'fixture-short TOC should include promoted h3 text 目的');
  assert(!tocText.includes('補助ラベル'), 'fixture-short TOC must exclude original h4 補助ラベル');
}

if (basename.includes('fixture-long')) {
  assert(
    titleText === 'キャンペーン運用プレイブック',
    'fixture-long title mismatch'
  );
  assert(
    $('article.mdh-doc > h1').first().text().trim() === '配信準備',
    'fixture-long should remove duplicate leading title h1'
  );
  assert($('article.mdh-doc h1').length >= 2, 'fixture-long should keep multiple body h1 nodes');
  assert(!tocText.includes('目次に出さない補助見出し'), 'fixture-long TOC must exclude h4 text');
}

if (basename.includes('fixture-table-stack')) {
  const tables = $('article.mdh-doc table');
  const firstTable = tables.eq(0);
  const secondTable = tables.eq(1);
  assert(tables.length === 2, 'fixture-table-stack should render two tables');
  assert(firstTable.hasClass('mdh-stackable-table'), '3-column table should be stackable');
  assert(
    firstTable.find('tbody td').first().attr('data-label') === 'Channel',
    'stackable table cells should expose header labels'
  );
  assert(!secondTable.hasClass('mdh-stackable-table'), '2-column table should remain a regular table');
  assert(styleText.includes('#cmt-imported-document table'), 'imported document table styling is missing');
  assert(styleText.includes('.mdh-doc td:empty::before'), 'empty table cell styling is missing');
  assert(styleText.includes('.mdh-doc tbody tr:hover td, #cmt-imported-document tbody tr:hover td { background: var(--soft); }'), 'table row hover styling is missing');
  assert(
    tables.toArray().every((table) => $(table).parent().hasClass('mdh-table-scroll')),
    'every table should be wrapped in .mdh-table-scroll'
  );
  assert(firstTable.find('th.mdh-num').length === 2, 'fully numeric columns should mark their header as mdh-num');
  assert(firstTable.find('td.mdh-num').length === 4, 'numeric cells should be marked as mdh-num');
  assert(firstTable.find('td:not(.mdh-num)').length === 6, 'text cells should not be marked as mdh-num');
  assert(secondTable.find('.mdh-num').length === 0, 'text-only table should have no mdh-num cells');
  assert(styleText.includes('td.mdh-num { white-space: nowrap; text-align: right;'), 'numeric cell styling is missing');
  assert(styleText.includes('.mdh-table-scroll { margin: 24px 0; overflow-x: auto;'), 'table scroll wrapper styling is missing');
  assert(html.includes("handle.className = 'mdh-col-resizer'"), 'column resize script is missing');
  assert(styleText.includes('.mdh-col-resizer { position: absolute;'), 'column resize handle styling is missing');
  assert(!/table\.mdh-stackable-table thead[^{]*\{ display: none/.test(styleText) && !styleText.includes('.mdh-table-scroll:has(> table.mdh-stackable-table)'), '3-column tables must stay tables on narrow screens (no card layout)');
}

if (basename === 'fixture-table-heatmap.html') {
  const source = await fs.readFile(new URL('../mockups/fixtures/fixture-table-heatmap.md', import.meta.url), 'utf8');
  const markerCount = (source.match(/^\s*<!-- mdh:heatmap -->\s*$/gm) || []).length;
  const tables = $('article.mdh-doc table');
  const enabledBlocks = $('.mdh-heatmap-enabled');
  const enabledTable = enabledBlocks.find('.mdh-table-scroll > table').first();
  const radios = enabledBlocks.find('input[type="radio"]');
  const checkedTable = enabledBlocks.find('input[type="radio"][value="table"]:checked');
  const checkedHeatmap = enabledBlocks.find('input[type="radio"][value="heatmap"]:checked');

  // 入力マーカー数と出力ブロック数・radioペア数を突き合わせる。マーカー自体は生成HTMLへ残さない。
  assert(tables.length === 2, 'fixture-table-heatmap should render two tables');
  assert(enabledBlocks.length === markerCount, `fixture marker count should equal enabled block count (${markerCount}/${enabledBlocks.length})`);
  assert(radios.length === enabledBlocks.length * 2, 'each enabled table should have one radio pair');
  assert(checkedTable.length === 1 && checkedHeatmap.length === 0, 'table should be the only checked default view');
  assert(enabledBlocks.children('.mdh-view-toggle').length === 1, 'view toggle should be the first child of the enabled block');
  assert(enabledBlocks.children('.mdh-table-scroll').length === 1, 'enabled block should contain the existing table scroll wrapper');
  assert(enabledBlocks.find('.mdh-view-toggle').attr('role') === 'group', 'view toggle should expose group semantics');
  assert(enabledBlocks.find('.mdh-view-toggle').attr('aria-label') === '表の表示方法', 'view toggle should expose its Japanese label');
  assert(enabledBlocks.find('input[name="mdh-view-1"][id="mdh-view-1-table"][value="table"]').length === 1, 'table radio contract is missing');
  assert(enabledBlocks.find('input[name="mdh-view-1"][id="mdh-view-1-heatmap"][value="heatmap"]').length === 1, 'heatmap radio contract is missing');
  assert(enabledBlocks.find('label[for="mdh-view-1-table"]').text().trim() === '表', 'table label text mismatch');
  assert(enabledBlocks.find('label[for="mdh-view-1-heatmap"]').text().trim() === 'ヒートマップ', 'heatmap label text mismatch');
  assert(enabledTable.parent().hasClass('mdh-table-scroll'), 'enabled table should remain a direct child of mdh-table-scroll');
  assert(enabledTable.find('tbody td.mdh-heat').length >= 2, 'heatmap cells should be present');
  assert(enabledTable.find('tbody td[data-label="#"].mdh-heat').length === 0, 'identifier column must not be colored');
  assert(enabledTable.find('tbody td').filter((_, el) => $(el).text().trim() === '30 人未満').hasClass('mdh-heat') === false, '人未満 cells must not be colored');
  assert(enabledTable.find(`tbody td.mdh-heat[style*="rgba(${HEAT_RGB},0.10)"]`).length >= 1, 'minimum heat alpha is missing');
  assert(enabledTable.find(`tbody td.mdh-heat[style*="rgba(${HEAT_RGB},0.55)"]`).length >= 1, 'maximum heat alpha is missing');
  assert(enabledTable.find('tbody td.mdh-heat[style]').toArray().every((el) => $(el).attr('style').startsWith(`--mdh-heat: rgba(${HEAT_RGB},0.`) && /,0\.\d{2}\)$/.test($(el).attr('style'))), 'heat cell styles should use two-decimal alpha values');
  assert(tables.eq(1).find('td.mdh-heat').length === 0, 'unmarked table must not receive heatmap cells');
  assert(!html.includes('mdh:heatmap') && !html.includes('data-mdh-heatmap'), 'heatmap marker metadata must not leak into output');
  assert(styleText.includes('.mdh-doc .mdh-table-block:has(input[value="heatmap"]:checked) td.mdh-heat'), 'static document heatmap selector is missing');
  assert(styleText.includes('#cmt-imported-document .mdh-table-block:has(input[value="heatmap"]:checked) td.mdh-heat'), 'comment overlay heatmap selector is missing');
  assert(styleText.includes('clip: rect(0 0 0 0)'), 'radio controls should be visually hidden without display:none');
}

if (basename === 'fixture-table-heatmap-primary.html') {
  const source = await fs.readFile(new URL('../mockups/fixtures/fixture-table-heatmap-primary.md', import.meta.url), 'utf8');
  const markerCount = (source.match(/^\s*<!-- mdh:heatmap primary -->\s*$/gm) || []).length;
  const tables = $('article.mdh-doc table');
  const enabledBlocks = $('.mdh-heatmap-enabled');
  const enabledTable = enabledBlocks.find('.mdh-table-scroll > table').first();
  const radios = enabledBlocks.find('input[type="radio"]');
  const checkedTable = enabledBlocks.find('input[type="radio"][value="table"]:checked');
  const checkedHeatmap = enabledBlocks.find('input[type="radio"][value="heatmap"]:checked');

  // primary マーカーの表も既定モードと同じ radio/CSS 契約を満たし、かつ主値モード特有の判定
  // （補足つきセルの着色・順位列の非着色・人未満混在列の扱い）が実出力へ反映されることを確認する。
  assert(tables.length === 1, 'fixture-table-heatmap-primary should render one table');
  assert(enabledBlocks.length === markerCount, `fixture marker count should equal enabled block count (${markerCount}/${enabledBlocks.length})`);
  assert(radios.length === enabledBlocks.length * 2, 'each enabled table should have one radio pair');
  assert(checkedTable.length === 1 && checkedHeatmap.length === 0, 'table should be the only checked default view');
  assert(enabledBlocks.find('label[for="mdh-view-1-table"]').text().trim() === '表', 'table label text mismatch');
  assert(enabledBlocks.find('label[for="mdh-view-1-heatmap"]').text().trim() === 'ヒートマップ', 'heatmap label text mismatch');
  assert(enabledTable.parent().hasClass('mdh-table-scroll'), 'enabled table should remain a direct child of mdh-table-scroll');
  assert(enabledTable.find('tbody td[data-label="到達率"].mdh-heat').length >= 2, 'primary-mode composite cells (%（分子 / 分母） 等) should be colored');
  assert(enabledTable.find('tbody td[data-label="到達率の順位"].mdh-heat').length === 0, '順位 を含む見出し列は主値モードでも非着色');
  assert(enabledTable.find('tbody td').filter((_, el) => $(el).text().trim() === '30 人未満').hasClass('mdh-heat') === false, '人未満 cells must not be colored');
  assert(enabledTable.find(`tbody td.mdh-heat[style*="rgba(${HEAT_RGB},0.10)"]`).length >= 1, 'minimum heat alpha is missing');
  assert(enabledTable.find(`tbody td.mdh-heat[style*="rgba(${HEAT_RGB},0.55)"]`).length >= 1, 'maximum heat alpha is missing');
  assert(!html.includes('mdh:heatmap') && !html.includes('data-mdh-heatmap'), 'heatmap marker metadata must not leak into output');
  assert(styleText.includes('.mdh-doc .mdh-table-block:has(input[value="heatmap"]:checked) td.mdh-heat'), 'static document heatmap selector is missing');
}

if (failures.length) {
  console.error(`Validation failed for ${input}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Validated ${input}`);
