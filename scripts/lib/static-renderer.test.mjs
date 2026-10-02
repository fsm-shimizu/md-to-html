import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { renderToc, isNumericCellText } from './static-renderer.mjs';

test('leaf h1 and h2 TOC nodes reserve the toggle column with spacers', () => {
  const html = renderToc([
    { level: 1, text: '対象範囲', id: 'scope', children: [] },
    { level: 2, text: '詳細', id: 'detail', children: [] }
  ]);
  const $ = load(`<aside class="mdh-toc">${html}</aside>`);

  assert.equal($('.mdh-toc-node').length, 2);
  assert.equal($('.mdh-toc-node > details.mdh-toc-disclosure').length, 0);
  assert.equal($('.mdh-toc-node > .mdh-toc-spacer').length, 2);
  assert.equal($('.mdh-toc-node > .mdh-toc-spacer + .mdh-toc-title').length, 2);
});

test('expandable TOC nodes keep a disclosure toggle and visible sibling title', () => {
  const html = renderToc([
    {
      level: 1,
      text: '再利用しやすい企画パターン',
      id: 'patterns',
      children: [
        { level: 2, text: '信頼先出しの実演レビュー', id: 'review', children: [] }
      ]
    }
  ]);
  const $ = load(`<aside class="mdh-toc">${html}</aside>`);

  assert.equal($('.mdh-toc-h1 > details.mdh-toc-disclosure').length, 1);
  assert.equal($('.mdh-toc-h1 > details.mdh-toc-disclosure + .mdh-toc-title').length, 1);
  assert.equal($('.mdh-toc-h1 > details.mdh-toc-disclosure .mdh-toc-children').children().length, 1);
  assert.equal($('.mdh-toc-h2 > .mdh-toc-spacer + .mdh-toc-title').length, 1);
});

test('isNumericCellText accepts numbers, ranges, percentages and unit suffixes', () => {
  for (const text of ['1,119', '48%', '579→422', '30 人未満', '2025-08-18', '0→108', '1.5 倍', '12 件', '−', '100']) {
    if (text === '−') continue;
    assert.equal(isNumericCellText(text), true, text);
  }
});

test('isNumericCellText rejects text cells and cells without digits', () => {
  for (const text of ['千葉県 八街市', '近郊・来訪が立つ', '東京 450・神奈川 203', '第 3 回', '', '—', 'v12']) {
    assert.equal(isNumericCellText(text), false, text);
  }
});
