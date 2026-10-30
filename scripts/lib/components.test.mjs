// 部品（コールアウト・折りたたみ・用語と説明・キャプション）の HTML の検査。
// 期待値はテストの中の文字で書く（renderer から作らない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { buildNotionHtmlString } from './build-notion.mjs';
import { buildSpecSet } from '../build_spec_set.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const samplePath = path.join(root, 'mockups/fixtures/components-2a/sample.md');

const render = async (md, options) => load(await buildNotionHtmlString(md, '/tmp/components-test.md', options));
const doc = ($) => $('article.mdh-doc');

// ---------------------------------------------------------------------------
// AC1 コールアウト
// ---------------------------------------------------------------------------
const NAMES = [
  ['gray', 'gray'], ['blue', 'blue'], ['green', 'green'], ['yellow', 'yellow'], ['red', 'red'],
  ['NOTE', 'gray'], ['TIP', 'blue'], ['IMPORTANT', 'red'], ['WARNING', 'yellow'], ['CAUTION', 'red']
];
for (const [name, color] of NAMES) {
  test(`AC1 [!${name}] は mdh-callout-${color} になる（見出しなし）`, async () => {
    const $ = await render(`> [!${name}]\n> 本文です。\n`);
    assert.equal(doc($).find('blockquote').length, 0);
    const callout = doc($).find(`div.mdh-callout.mdh-callout-${color}`);
    assert.equal(callout.length, 1);
    assert.equal(callout.attr('class'), `mdh-callout mdh-callout-${color}`);
    assert.equal(callout.find('.mdh-callout-label').length, 0);
    assert.equal(callout.children('div.mdh-callout-body').children('p').text(), '本文です。');
    assert.equal(doc($).text().includes('[!'), false);
  });
}

test('AC1 名前は大文字小文字を区別しない', async () => {
  const $ = await render('> [!YeLLoW] 見出し\n> 本文\n');
  assert.equal(doc($).find('.mdh-callout-yellow').length, 1);
});

test('AC1 見出しは行内の強調とリンクを保って p.mdh-callout-label に入る', async () => {
  const $ = await render('> [!yellow] **注意**と[リンク](https://example.com)\n> 本文\n');
  const label = doc($).find('.mdh-callout-yellow > p.mdh-callout-label');
  assert.equal(label.length, 1);
  assert.equal(label.text(), '注意とリンク');
  assert.equal(label.find('strong').text(), '注意');
  assert.equal(label.find('a').attr('href'), 'https://example.com');
  assert.equal(doc($).find('.mdh-callout-body p').text(), '本文');
});

test('AC1 本文の 2 つ目以降のブロックも本文に入る', async () => {
  const $ = await render('> [!blue] 見出し\n> 1 つ目\n>\n> 2 つ目\n>\n> - 項目\n');
  const body = doc($).find('.mdh-callout-blue > .mdh-callout-body');
  assert.deepEqual(body.children().toArray().map((el) => el.tagName), ['p', 'p', 'ul']);
});

test('AC1 1 行目だけの引用は、本文が空の枠になる', async () => {
  const $ = await render('> [!red] 見出しだけ\n');
  const callout = doc($).find('.mdh-callout-red');
  assert.equal(callout.find('.mdh-callout-label').text(), '見出しだけ');
  assert.equal(callout.find('.mdh-callout-body').length, 1);
  assert.equal(callout.find('.mdh-callout-body').children().length, 0);
});

test('AC1 行末の \\ で区切った見出し', async () => {
  const $ = await render('> [!blue] 見出し\\\n> 本文\n');
  assert.equal(doc($).find('.mdh-callout-blue .mdh-callout-label').text(), '見出し');
  assert.equal(doc($).find('.mdh-callout-blue .mdh-callout-body p').text(), '本文');
});

test('AC1 [!note] の次の行が「: 説明」の引用はコールアウトになり、本文は段落のまま（B1 の順序）', async () => {
  const $ = await render('> [!note]\n> : 説明\n');
  assert.equal(doc($).find('.mdh-callout-gray').length, 1);
  assert.equal(doc($).find('dl').length, 0);
  assert.equal(doc($).find('.mdh-callout-body p').text(), ': 説明');
});

test('AC1 箇条書きの中の引用も変換される', async () => {
  const $ = await render('- 項目\n\n  > [!green] 中の枠\n  > 本文\n');
  assert.equal(doc($).find('li .mdh-callout-green .mdh-callout-label').text(), '中の枠');
});

test('AC1 入れ子の引用も、内側から変換される', async () => {
  const $ = await render('> [!gray] 外\n> 外の本文\n>\n> > [!yellow] 内\n> > 内の本文\n');
  assert.equal(doc($).find('.mdh-callout-gray > .mdh-callout-body > .mdh-callout-yellow').length, 1);
  assert.equal(doc($).find('blockquote').length, 0);
});

test('AC1 普通の引用の中のコールアウト', async () => {
  const $ = await render('> 普通の引用\n>\n> > [!blue]\n> > 本文\n');
  assert.equal(doc($).find('blockquote > .mdh-callout-blue').length, 1);
});

test('AC1 見出しの生の HTML と危険な URL は出さない（N1）', async () => {
  const $ = await render('> [!blue] <img src=x onerror=alert(1)>[x](javascript:alert(1))\n> 本文\n');
  const html = doc($).html();
  assert.equal(html.includes('onerror'), false);
  assert.equal(html.includes('javascript:'), false);
});

const PLAIN_QUOTES = [
  ['知らない名前', '> [!purple] 見出し\n> 本文\n'],
  ['色に開閉の記号', '> [!blue]+ 見出し\n> 本文\n'],
  ['見出しの無い toggle', '> [!toggle]-\n> 本文\n'],
  ['2 行目の目印', '> 本文\n> [!note]\n'],
  ['強調の途中の改行', '> [!note] **見出し\n> 本文**\n'],
  ['参照の定義がある', '> [!note]\n> 本文\n\n[!note]: /ref\n'],
  ['行内コード', '> `[!note]`\n> 本文\n'],
  ['2 つ目の段落の目印', '> 本文\n>\n> [!note]\n']
];
for (const [name, md] of PLAIN_QUOTES) {
  test(`AC1 ${name}は普通の引用のまま`, async () => {
    const $ = await render(md);
    assert.equal(doc($).find('blockquote').length, 1);
    assert.equal(doc($).find('.mdh-callout, .mdh-toggle').length, 0);
  });
}

// ---------------------------------------------------------------------------
// AC2 折りたたみ
// ---------------------------------------------------------------------------
for (const [marker, open] of [['[!toggle]-', false], ['[!toggle]', false], ['[!toggle]+', true], ['[!TOGGLE]+', true]]) {
  test(`AC2 ${marker} は${open ? '開いた' : '閉じた'}折りたたみになる`, async () => {
    const $ = await render(`> ${marker} 集計の対象期間はいつからですか\n> 2025 年 4 月 17 日からです。\n>\n> 2 つ目の段落です。\n`);
    const details = doc($).find('details.mdh-toggle');
    assert.equal(details.length, 1);
    assert.equal(details.attr('open') !== undefined, open);
    const summary = details.children('summary');
    assert.equal(summary.text(), '集計の対象期間はいつからですか');
    const arrow = summary.children('svg.mdh-toggle-arrow');
    assert.equal(arrow.length, 1);
    assert.equal(arrow.attr('aria-hidden'), 'true');
    assert.equal(arrow.attr('viewBox'), '0 0 20 20');
    assert.equal(details.children('div.mdh-toggle-body').children('p').length, 2);
    assert.equal(details.find('.mdh-toggle-body p').first().text(), '2025 年 4 月 17 日からです。');
    assert.equal(doc($).find('blockquote').length, 0);
  });
}

// ---------------------------------------------------------------------------
// AC3 用語と説明・キャプション
// ---------------------------------------------------------------------------
test('AC3 用語と説明の組', async () => {
  const $ = await render('チェックイン率\n: 予約のうち、実際に施設へ到着した割合です。\n');
  const dl = doc($).find('dl.mdh-dl');
  assert.equal(dl.length, 1);
  assert.equal(dl.children('div').length, 1);
  assert.equal(dl.find('div > dt').text(), 'チェックイン率');
  assert.deepEqual(dl.find('div > dd').toArray().map((el) => $(el).text()), ['予約のうち、実際に施設へ到着した割合です。']);
  assert.equal(doc($).children('p').length, 0);
});

test('AC3 説明が 2 つ', async () => {
  const $ = await render('県外比率\n: 県外の住所の利用者の割合です。\n: 住所が未登録の利用者は除きます。\n');
  assert.deepEqual(doc($).find('dl.mdh-dl dd').toArray().map((el) => $(el).text()), ['県外の住所の利用者の割合です。', '住所が未登録の利用者は除きます。']);
});

test('AC3 説明の続きの行は直前の説明につながる（文字の改行と break を保つ）', async () => {
  const $ = await render('対象期間\n: 4 月 17 日からです。\nそれより前は含めません。\\\n改行の後です。\n:\n');
  const dd = doc($).find('dl.mdh-dl dd');
  assert.equal(dd.length, 1);
  assert.equal(dd.html(), '4 月 17 日からです。\nそれより前は含めません。<br>\n改行の後です。\n:');
});

test('AC3 用語と説明の行内の要素を保つ', async () => {
  const $ = await render('**用語**\n: [リンク](https://example.com) と `code`\n');
  assert.equal(doc($).find('dt strong').text(), '用語');
  assert.equal(doc($).find('dd a').attr('href'), 'https://example.com');
  assert.equal(doc($).find('dd code').text(), 'code');
});

test('AC3 空行をはさんで続く組は 1 つの dl にまとめる', async () => {
  const $ = await render('A\n: a\n\nB\n: b\n');
  assert.equal(doc($).find('dl.mdh-dl').length, 1);
  assert.deepEqual(doc($).find('dl.mdh-dl > div > dt').toArray().map((el) => $(el).text()), ['A', 'B']);
});

test('AC3 間に別のブロックがあれば dl を分ける', async () => {
  const $ = await render('A\n: a\n\n段落\n\nB\n: b\n');
  assert.equal(doc($).find('dl.mdh-dl').length, 2);
  assert.deepEqual(doc($).children().toArray().map((el) => el.tagName), ['dl', 'p', 'dl']);
});

const PLAIN_PARAGRAPHS = [
  ['「: 説明だけ」', ': 説明だけ\n'],
  ['2 行目が「: 」で始まらない', '用語\nふつうの行\n'],
  ['1 行だけ', '1 行だけです。\n'],
  ['2 行目が「:」だけ', '用語\n:\n'],
  ['強調の途中の改行', '**用語\n: 説明**\n']
];
for (const [name, md] of PLAIN_PARAGRAPHS) {
  test(`AC3 ${name}の段落は段落のまま`, async () => {
    const $ = await render(md);
    assert.equal(doc($).find('dl').length, 0);
    assert.equal(doc($).children('p').length, 1);
  });
}

for (const [name, md] of [
  ['文字の改行', '![四半期ごとの推移](chart.png)\n*図 1｜推移*\n'],
  ['break', '![四半期ごとの推移](chart.png)\\\n*図 1｜推移*\n'],
  ['_…_ の強調', '![四半期ごとの推移](chart.png)\n_図 1｜推移_\n'],
  ['imageReference', '![四半期ごとの推移][chart]\n*図 1｜推移*\n\n[chart]: chart.png\n']
]) {
  test(`AC3 キャプション付きの図（${name}）`, async () => {
    const $ = await render(md);
    const figure = doc($).find('figure.mdh-figure');
    assert.equal(figure.length, 1);
    assert.deepEqual(figure.children().toArray().map((el) => el.tagName), ['img', 'figcaption']);
    assert.equal(figure.children('img').attr('alt'), '四半期ごとの推移');
    assert.equal(figure.children('img').attr('src'), 'chart.png');
    assert.equal(figure.children('figcaption').text(), '図 1｜推移');
    assert.equal(doc($).find('p').length, 0);
  });
}

for (const [name, md] of [
  ['改行が無い', '![a](chart.png) と *図*\n'],
  ['画像の前に文字', '前の文字 ![a](chart.png)\n*図*\n'],
  ['画像がリンクの中', '[![a](chart.png)](https://example.com)\n*図*\n'],
  ['強調の後ろに文字', '![a](chart.png)\n*図* と文字\n'],
  ['画像だけ', '![a](chart.png)\n']
]) {
  test(`AC3 ${name}の段落はキャプション付きの図にしない`, async () => {
    const $ = await render(md);
    assert.equal(doc($).find('figure').length, 0);
    assert.equal(doc($).children('p').length, 1);
  });
}

// ---------------------------------------------------------------------------
// AC4a 変換のときの警告
// ---------------------------------------------------------------------------
const WARN_CASES = [
  ['知らない名前', '本文\n\n> [!purple] 見出し\n> 本文\n', { line: 3, reason: '知らない名前', marker: '[!purple]' }],
  ['色に開閉の記号', '> [!blue]+ 見出し\n> 本文\n', { line: 1, reason: '色に開閉の記号', marker: '[!blue]+' }],
  ['見出しの無い toggle', '> [!toggle]-\n> 本文\n', { line: 1, reason: '見出しの無い toggle', marker: '[!toggle]-' }],
  ['行に分けられない', '> [!note] **見出し\n> 本文**\n', { line: 1, reason: '行に分けられない', marker: '[!note]' }],
  ['見出しが空になる', '## [#setup]\n', { line: 1, reason: '見出しが空になる', marker: '[#setup]' }],
  ['使えない名前', '## 設定 {#mdhSettingsPanel}\n', { line: 1, reason: '使えない名前', marker: '{#mdhSettingsPanel}' }],
  ['重なった名前', '## A [#case-01]\n\n## B [#case-01]\n', { line: 3, reason: '重なった名前', marker: '[#case-01]' }]
];
for (const [name, md, expected] of WARN_CASES) {
  test(`AC4a ${name}を行番号付きで警告し、HTML は警告の有無で変わらない`, async () => {
    const warnings = [];
    const withWarn = await buildNotionHtmlString(md, '/tmp/w.md', { onWarning: (w) => warnings.push(w) });
    const without = await buildNotionHtmlString(md, '/tmp/w.md');
    assert.deepEqual(warnings, [expected]);
    assert.equal(withWarn, without);
  });
}

test('AC4a 警告の行番号は YAML の前置きを含む元の原稿の行', async () => {
  const warnings = [];
  await buildNotionHtmlString('---\ntitle: T\n---\n\n> [!purple]\n> 本文\n', '/tmp/w.md', { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(warnings.map((w) => w.line), [5]);
});

test('AC4a 正しく書いた原稿では警告が 0 件', async () => {
  const warnings = [];
  await buildNotionHtmlString(await fs.readFile(samplePath, 'utf8'), samplePath, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(warnings, []);
});

test('AC4a build_notion_html.mjs は誤記を標準エラーへ警告し、終了コード 0', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdh-components-'));
  const input = path.join(tmp, 'typo.md');
  await fs.writeFile(input, '# 見出し\n\n> [!purple] 見出し\n> 本文\n');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build_notion_html.mjs'), input, '--out', path.join(tmp, 'typo.html')], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, `警告: ${input}:3 知らない名前: [!purple]\n`);
  await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC11 すべての出力で部品の HTML が同じ（HTML の部分）
// ---------------------------------------------------------------------------
test('AC11 既定・仕様書セットで部品の HTML が同じ', async () => {
  const raw = await fs.readFile(samplePath, 'utf8');
  const parts = ($) => $('.mdh-callout, .mdh-toggle, .mdh-dl').toArray().map((el) => $.html(el));
  const base = parts(load(await buildNotionHtmlString(raw, samplePath)));
  assert.ok(base.length >= 18, `部品の数が少ない: ${base.length}`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdh-components-set-'));
  await fs.writeFile(path.join(tmp, 'sample.md'), raw);
  await buildSpecSet(tmp, { log: () => {}, warn: () => {} });
  assert.deepEqual(parts(load(await fs.readFile(path.join(tmp, 'html/sample.html'), 'utf8'))), base);
  await fs.rm(tmp, { recursive: true, force: true });
});

// ===========================================================================
// 部品（カード・複数カラム・結合セル）の HTML の検査
// ===========================================================================
const sample2bPath = path.join(root, 'mockups/fixtures/components-2b/sample.md');
const warningsOf = async (md) => {
  const warnings = [];
  const withWarn = await buildNotionHtmlString(md, '/tmp/w2b.md', { onWarning: (w) => warnings.push(w) });
  const without = await buildNotionHtmlString(md, '/tmp/w2b.md');
  assert.equal(withWarn, without, 'onWarning の有無で HTML が変わった');
  return warnings;
};

// ---------------------------------------------------------------------------
// AC1 カード
// ---------------------------------------------------------------------------
test('AC1 3 列のカード: タイトル・補助見出し・本文', async () => {
  const $ = await render('<!-- mdh:cards 3 -->\n- チェックイン率\n  *9 月｜+2.1pt*\n  予約のうち到着した割合です。\n- 県外比率\n  県外の利用者の割合です。\n');
  const cards = doc($).find('div.mdh-cards.mdh-cards-3');
  assert.equal(cards.length, 1);
  assert.equal(doc($).find('ul').length, 0);
  const items = cards.children('div.mdh-card');
  assert.equal(items.length, 2);
  assert.deepEqual(items.eq(0).children().toArray().map((el) => `${el.tagName}.${$(el).attr('class')}`), ['p.mdh-card-title', 'p.mdh-card-sub', 'div.mdh-card-body']);
  assert.equal(items.eq(0).children('.mdh-card-title').text(), 'チェックイン率');
  assert.equal(items.eq(0).children('.mdh-card-sub').text(), '9 月｜+2.1pt');
  assert.equal(items.eq(0).children('.mdh-card-body').children('p').text(), '予約のうち到着した割合です。');
  assert.equal(items.eq(1).children('.mdh-card-sub').length, 0);
  assert.equal(items.eq(1).children('.mdh-card-body').text(), '県外の利用者の割合です。');
  assert.equal(doc($).text().includes('mdh:'), false);
});

test('AC1 2 列のカード（順序付きの箇条書き）と空の本文', async () => {
  const $ = await render('<!-- mdh:cards 2 -->\n1. A\n2. B\n3. C\n');
  const cards = doc($).find('div.mdh-cards.mdh-cards-2');
  assert.equal(cards.children('div.mdh-card').length, 3);
  assert.equal(doc($).find('ol').length, 0);
  const body = cards.children().eq(0).children('div.mdh-card-body');
  assert.equal(body.length, 1);
  assert.equal(body.children().length, 0);
});

test('AC1 目印と箇条書きの間に空行があってもカードになる', async () => {
  const $ = await render('<!-- mdh:cards 2 -->\n\n- A\n- B\n');
  assert.equal(doc($).find('div.mdh-cards-2 > div.mdh-card').length, 2);
});

test('AC1 本文の 2 つ目以降のブロックも本文に入る', async () => {
  const $ = await render('<!-- mdh:cards 2 -->\n- タイトル\n  1 行目\n\n  2 つ目の段落\n\n  - 入れ子\n- B\n');
  const body = doc($).find('.mdh-card').eq(0).children('.mdh-card-body');
  assert.deepEqual(body.children().toArray().map((el) => el.tagName), ['p', 'p', 'ul']);
  assert.equal(body.children('p').eq(0).text(), '1 行目');
});

test('AC1 2 行目が強調と文字なら補助見出しにせず本文の 1 行目にする', async () => {
  const $ = await render('<!-- mdh:cards 2 -->\n- タイトル\n  *強調*と文字\n- B\n');
  const card = doc($).find('.mdh-card').eq(0);
  assert.equal(card.children('.mdh-card-sub').length, 0);
  assert.equal(card.children('.mdh-card-body').text(), '強調と文字');
});

test('AC1 行に分けられない最初の段落は、まるごとタイトルにする', async () => {
  const $ = await render('<!-- mdh:cards 2 -->\n- **太字の\n  タイトル**\n- B\n');
  const card = doc($).find('.mdh-card').eq(0);
  assert.equal(card.children('.mdh-card-title').find('strong').length, 1);
  assert.equal(card.children('.mdh-card-sub').length, 0);
  assert.equal(card.children('.mdh-card-body').children().length, 0);
});

test('AC1 リンク付きカード: カード全体が a、href・アイコン・タイトル', async () => {
  const $ = await render('<!-- mdh:cards 2 -->\n- [導入ガイド](https://example.com/guide "ガイド")\n  手順です。\n- B\n');
  const link = doc($).find('div.mdh-cards-2 > a.mdh-card.mdh-card-link');
  assert.equal(link.length, 1);
  assert.equal(link.attr('href'), 'https://example.com/guide');
  assert.equal(link.attr('title'), 'ガイド');
  assert.equal(link.attr('target'), '_blank');
  assert.deepEqual(link.children().toArray().map((el) => el.tagName), ['svg', 'p', 'div']);
  assert.equal(link.children('svg').attr('class'), 'mdh-card-icon');
  assert.equal(link.children('svg').attr('aria-hidden'), 'true');
  assert.equal(link.children('p.mdh-card-title').text(), '導入ガイド');
  assert.equal(link.find('a').length, 0);
  assert.equal(doc($).find('.mdh-card').eq(1).is('div'), true);
});

const CLICKABLE = [
  ['本文のリンク', '- [ガイド](https://example.com)\n  本文の[リンク](https://example.org)です。\n- B\n'],
  ['補助見出しのリンク', '- [ガイド](https://example.com)\n  *[補助](https://example.org)*\n- B\n'],
  ['タイトルの中の注釈の参照', '- [ガイド[^1]](https://example.com)\n- B\n\n[^1]: 注釈\n'],
  ['本文の折りたたみ', '- [ガイド](https://example.com)\n\n  > [!toggle]- 開く\n  > 中身\n- B\n'],
  ['本文のヒートマップの表', '- [ガイド](https://example.com)\n\n  <!-- mdh:heatmap -->\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n  | 3 | 4 |\n- B\n'],
  ['本文のタスクリスト', '- [ガイド](https://example.com)\n\n  - [ ] やること\n- B\n']
];
for (const [name, list] of CLICKABLE) {
  test(`AC1 ${name}があるリンク付きカードは通常のカードに戻り、a.mdh-card-link の中に押せる要素が無い`, async () => {
    const md = `<!-- mdh:cards 2 -->\n${list}`;
    const $ = await render(md);
    assert.equal(doc($).find('a.mdh-card-link').length, 0);
    assert.equal(doc($).find('a.mdh-card-link').find('a, details, input').length, 0);
    const card = doc($).find('div.mdh-card').eq(0);
    assert.equal(card.length, 1);
    assert.equal(card.find('svg.mdh-card-icon').length, 0);
    assert.equal(card.children('.mdh-card-title').children('a').first().attr('href'), 'https://example.com');
    const warnings = await warningsOf(md);
    assert.deepEqual(warnings.map((w) => w.reason), ['リンク付きカードの中に押せる要素']);
  });
}

test('AC1 本文に内側のリンク付きカードがあるリンク付きカードは通常のカードに戻り、内側のカードは保つ', async () => {
  const md = '<!-- mdh:cards 2 -->\n- [Outer](https://outer.example)\n\n  <!-- mdh:cards 2 -->\n  - [Inner](https://inner.example)\n    inner body\n\n- Other\n';
  const html = await buildNotionHtmlString(md, '/tmp/w2b.md');
  // cheerio は入れ子の a を補正して読むので、生成した文字列で a.mdh-card-link の中に a の開始タグが無いことを見る
  const article = html.slice(html.indexOf('<article'));
  assert.equal(/<a [^>]*mdh-card-link[^>]*>(?:(?!<\/a>)[\s\S])*<a /.test(article), false);
  const $ = load(html);
  assert.equal(doc($).find('a.mdh-card-link').length, 1);
  assert.equal(doc($).find('a.mdh-card-link').attr('href'), 'https://inner.example');
  assert.equal(doc($).find('div.mdh-card').first().children('.mdh-card-title').children('a').attr('href'), 'https://outer.example');
  assert.deepEqual((await warningsOf(md)).map((w) => w.reason), ['リンク付きカードの中に押せる要素']);
});

test('AC1 箇条書きの中の目印を取り除くと折りたたみになる引用でも、通常のカードに戻る', async () => {
  const md = '<!-- mdh:cards 2 -->\n- [ガイド](https://example.com)\n\n  > <!-- mdh:cards 3 -->\n  > [!toggle]- 開く\n  > 中身\n- B\n';
  const $ = await render(md);
  assert.equal(doc($).find('a.mdh-card-link').length, 0);
  assert.equal(doc($).find('div.mdh-card details.mdh-toggle').length, 1);
});

for (const [name, md] of [
  ['入れ子の箇条書きだけの項目', '<!-- mdh:cards 2 -->\n- A\n- - 入れ子\n'],
  ['タスクリストの項目', '<!-- mdh:cards 2 -->\n- [ ] A\n- B\n']
]) {
  test(`AC1 ${name}がある箇条書きはカードにせず箇条書きのまま`, async () => {
    const $ = await render(md);
    assert.equal(doc($).find('.mdh-cards, .mdh-card').length, 0);
    assert.equal(doc($).children('ul').length, 1);
    assert.deepEqual((await warningsOf(md)).map((w) => w.reason), ['カードにならない項目']);
  });
}

test('AC1 カードの本文の段落は用語と説明・キャプションの変換の対象になる', async () => {
  const $ = await render('<!-- mdh:cards 2 -->\n- タイトル\n\n  用語\n  : 説明\n- B\n');
  assert.equal(doc($).find('.mdh-card-body dl.mdh-dl').length, 1);
  assert.equal(doc($).find('.mdh-card-title').eq(0).text(), 'タイトル');
});

// ---------------------------------------------------------------------------
// AC2 複数カラム
// ---------------------------------------------------------------------------
test('AC2 2 列のカラム: 列の中の見出し・段落・箇条書き', async () => {
  const $ = await render('<!-- mdh:columns 2 -->\n### 案 A\n\n本文 A\n\n- a\n\n<!-- mdh:column-break -->\n### 案 B\n\n本文 B\n<!-- mdh:columns-end -->\n\n後ろの段落\n');
  const columns = doc($).children('div.mdh-columns.mdh-columns-2');
  assert.equal(columns.length, 1);
  const cols = columns.children('div.mdh-column');
  assert.equal(cols.length, 2);
  // 見出しの段は文書の見出しの段の詰め方で決まるので、ここでは見出しであることだけを見る
  const tags = (col) => col.children().toArray().map((el) => (/^h[1-6]$/.test(el.tagName) ? 'h' : el.tagName));
  assert.deepEqual(tags(cols.eq(0)), ['h', 'p', 'ul']);
  assert.deepEqual(tags(cols.eq(1)), ['h', 'p']);
  assert.equal(doc($).children('p').last().text(), '後ろの段落');
});

test('AC2 3 列のカラム', async () => {
  const $ = await render('<!-- mdh:columns 3 -->\nA\n\n<!-- mdh:column-break -->\nB\n\n<!-- mdh:column-break -->\nC\n<!-- mdh:columns-end -->\n');
  assert.deepEqual(doc($).find('div.mdh-columns-3 > div.mdh-column').toArray().map((el) => $(el).text()), ['A', 'B', 'C']);
});

test('AC2 範囲の数が N と違っても範囲の数だけ列を作り、警告する', async () => {
  const md = '<!-- mdh:columns 2 -->\nA\n\n<!-- mdh:column-break -->\nB\n\n<!-- mdh:column-break -->\nC\n<!-- mdh:columns-end -->\n';
  const $ = await render(md);
  assert.equal(doc($).find('div.mdh-columns-2 > div.mdh-column').length, 3);
  assert.deepEqual(await warningsOf(md), [{ line: 1, reason: '区切りの数が合わない', marker: '<!-- mdh:columns 2 -->' }]);
});

test('AC2 終わりの目印が無いときはカラムにせず、間のブロックは今のまま', async () => {
  const md = '<!-- mdh:columns 2 -->\nA\n\nB\n';
  const $ = await render(md);
  assert.equal(doc($).find('.mdh-columns').length, 0);
  assert.equal(doc($).children('p').length, 2);
  assert.deepEqual(await warningsOf(md), [{ line: 1, reason: '終わりの目印が無い', marker: '<!-- mdh:columns 2 -->' }]);
});

test('AC2 範囲の中の入れ子のカラムは外側の列の本文のまま', async () => {
  const md = '<!-- mdh:columns 2 -->\nA\n\n<!-- mdh:columns 3 -->\nA2\n\n<!-- mdh:column-break -->\nB\n<!-- mdh:columns-end -->\n';
  const $ = await render(md);
  assert.equal(doc($).find('.mdh-columns').length, 1);
  assert.deepEqual(doc($).find('.mdh-column').toArray().map((el) => $(el).children().length), [2, 1]);
  assert.deepEqual(await warningsOf(md), [{ line: 4, reason: '入れ子のカラム', marker: '<!-- mdh:columns 3 -->' }]);
});

for (const marker of ['<!-- mdh:column-break -->', '<!-- mdh:columns-end -->']) {
  test(`AC2 範囲の外の ${marker} は何も変えず警告する`, async () => {
    const md = `A\n\n${marker}\n\nB\n`;
    const $ = await render(md);
    assert.equal(doc($).children('p').length, 2);
    assert.deepEqual(await warningsOf(md), [{ line: 3, reason: '対応する始まりが無い', marker }]);
  });
}

test('AC2 カラムの中のカードは使える', async () => {
  const $ = await render('<!-- mdh:columns 2 -->\n<!-- mdh:cards 2 -->\n- A\n- B\n\n<!-- mdh:column-break -->\nC\n<!-- mdh:columns-end -->\n');
  assert.equal(doc($).find('.mdh-column .mdh-cards-2 > .mdh-card').length, 2);
});

// ---------------------------------------------------------------------------
// AC3 結合セル
// ---------------------------------------------------------------------------
const cellsOf = ($, table) => $(table).find('tr').toArray().map((tr) => $(tr).children().toArray().map((c) => {
  const span = [c.attribs.rowspan && `r${c.attribs.rowspan}`, c.attribs.colspan && `c${c.attribs.colspan}`].filter(Boolean).join('');
  return `${c.tagName}:${$(c).text()}${span ? `(${span})` : ''}`;
}));

test('AC3 縦の結合・横の結合・head=2・数値と見出しの寄せ・見えない取っ手の印', async () => {
  const raw = await fs.readFile(sample2bPath, 'utf8');
  const $ = load(await buildNotionHtmlString(raw, sample2bPath));
  const scroll = doc($).find('div.mdh-merged-scroll');
  assert.equal(scroll.length, 3);
  const table = scroll.eq(0).children('table.mdh-merged-table');
  assert.equal(table.length, 1);
  assert.equal(table.closest('.mdh-table-scroll').length, 0);
  assert.deepEqual(cellsOf($, table), [
    ['th:地域(r2)', 'th:県(r2)', 'th:2025 年度(c2)', 'th:2026 年度(c2)'],
    ['th:上期', 'th:下期', 'th:上期', 'th:下期'],
    ['td:関東(r2)', 'td:群馬', 'td:1,120', 'td:1,340', 'td:1,410', 'td:1,520'],
    ['td:栃木', 'td:860', 'td:910', 'td:980', 'td:1,030'],
    ['td:東北', 'td:宮城', 'td:640', 'td:700', 'td:720', 'td:790'],
    ['td:合計(c2)', 'td:2,620', 'td:2,950', 'td:3,110', 'td:3,340']
  ]);
  assert.equal(table.find('thead > tr').length, 2);
  assert.equal(table.find('tbody > tr').length, 4);
  // 結合した表には取っ手も見えない印も置かない（コメント配信先が結合したセルのある表を自分で飛ばす）
  assert.equal(table.find('.mdh-col-resizer').length, 0);
  assert.deepEqual(table.find('thead tr').eq(1).children().toArray().map((c) => $(c).hasClass('mdh-num')), [true, true, true, true]);
  assert.deepEqual(table.find('thead tr').eq(0).children().toArray().map((c) => $(c).hasClass('mdh-num')), [false, false, false, false]);
  assert.equal(table.find('tbody td.mdh-num').length, 16);
  assert.equal(table.find('tbody td').filter((_, c) => ['関東', '群馬', '合計'].includes($(c).text())).hasClass('mdh-num'), false);
  for (const sel of ['.mdh-stackable-table', '[data-label]', '.mdh-heat', '[data-mdh-merged]', '[data-mdh-merge-head]']) {
    assert.equal(scroll.find(sel).length + scroll.filter(sel).length, 0, sel);
  }
  assert.equal(table.hasClass('mdh-stackable-table'), false);
});

test('AC3 行内コードの ^ は結合しない', async () => {
  const raw = await fs.readFile(sample2bPath, 'utf8');
  const $ = load(await buildNotionHtmlString(raw, sample2bPath));
  assert.deepEqual(cellsOf($, doc($).find('table.mdh-merged-table').eq(1)), [
    ['th:項目', 'th:値'], ['td:A(r2)', 'td:1'], ['td:2'], ['td:記号', 'td:^']
  ]);
  // 縦と横を同時に結合したセル（rowspan と colspan の両方）
  assert.deepEqual(cellsOf($, doc($).find('table.mdh-merged-table').eq(2)), [
    ['th:区分', 'th:項目', 'th:値'], ['td:共通(r2c2)', 'td:10'], ['td:20'], ['td:個別', 'td:A', 'td:30']
  ]);
});

test('AC3 両方の結合（2×2）と足りないセル', async () => {
  const $ = await render('<!-- mdh:merge -->\n| a | b | c |\n| --- | --- | --- |\n| X | < | 1 |\n| ^ | ^ | 2 |\n| Y |\n');
  assert.deepEqual(cellsOf($, doc($).find('table.mdh-merged-table')), [
    ['th:a', 'th:b', 'th:c'], ['td:X(r2c2)', 'td:1'], ['td:2'], ['td:Y', 'td:', 'td:']
  ]);
});

test('AC3 横に結合した文字のセルが覆う列の見出しは右寄せにしない', async () => {
  const $ = await render('<!-- mdh:merge -->\n| A | B | C |\n| --- | --- | --- |\n| label | < | < |\n| 1 | 2 | 3 |\n');
  const table = doc($).find('table.mdh-merged-table');
  assert.deepEqual(table.find('thead th').toArray().map((c) => $(c).hasClass('mdh-num')), [false, false, false]);
  assert.deepEqual(table.find('tbody tr').eq(1).children().toArray().map((c) => $(c).hasClass('mdh-num')), [true, true, true]);
});

const UNMERGED = [
  ['最初の行の ^', '| ^ | b |\n| --- | --- |\n| 1 | 2 |\n', '結合先が無い'],
  ['最初の列の <', '| a | b |\n| --- | --- |\n| < | 2 |\n', '結合先が無い'],
  ['head なしで本文の 1 行目の ^', '| a | b |\n| --- | --- |\n| ^ | 2 |\n', '結合先が無い'],
  ['長方形にならない結合', '| a | b | c |\n| --- | --- | --- |\n| X | < | 1 |\n| ^ | 文字 | 2 |\n', '結合が長方形にならない']
];
for (const [name, table, reason] of UNMERGED) {
  test(`AC3 ${name}がある表は結合をすべてやめ、普通の表になる`, async () => {
    const md = `<!-- mdh:merge -->\n${table}`;
    const $ = await render(md);
    assert.equal(doc($).find('.mdh-merged-scroll, .mdh-merged-table, [rowspan], [colspan]').length, 0);
    assert.equal(doc($).find('.mdh-table-scroll > table').length, 1);
    assert.equal(doc($).find('td, th').filter((_, c) => ['^', '<'].includes($(c).text())).length >= 1, true);
    assert.deepEqual(await warningsOf(md), [{ line: 1, reason, marker: '<!-- mdh:merge -->' }]);
  });
}

test('AC3 head=2 で 3 行目（本文の 1 行目）の ^ は普通の表になる', async () => {
  const md = '<!-- mdh:merge head=2 -->\n| a | b |\n| --- | --- |\n| c | d |\n| ^ | 1 |\n';
  const $ = await render(md);
  assert.equal(doc($).find('.mdh-merged-table').length, 0);
  assert.deepEqual((await warningsOf(md)).map((w) => w.reason), ['結合先が無い']);
});

test('AC3 head=2 の見出しの 2 行の間の ^ は結合する', async () => {
  const $ = await render('<!-- mdh:merge head=2 -->\n| a | b |\n| --- | --- |\n| ^ | d |\n| 1 | 2 |\n');
  assert.deepEqual(cellsOf($, doc($).find('table.mdh-merged-table')), [['th:a(r2)', 'th:b'], ['th:d'], ['td:1', 'td:2']]);
});

for (const [name, md] of [
  ['ヒートマップの目印の後ろに結合の目印', '<!-- mdh:heatmap -->\n<!-- mdh:merge -->\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| ^ | 4 |\n'],
  ['結合の目印の後ろにヒートマップの目印', '<!-- mdh:merge -->\n<!-- mdh:heatmap -->\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| ^ | 4 |\n']
]) {
  test(`AC3 ${name}: 結合した表になり、ヒートマップは付かない`, async () => {
    const $ = await render(md);
    assert.equal(doc($).find('table.mdh-merged-table').length, 1);
    assert.equal(doc($).find('.mdh-heat, .mdh-table-block, .mdh-view-toggle, [data-mdh-heatmap]').length, 0);
    assert.deepEqual(await warningsOf(md), []);
  });
}

// ---------------------------------------------------------------------------
// AC4 目印の警告
// ---------------------------------------------------------------------------
const WARN_2B = [
  ['知らない目印（列の数）', 'A\n\n<!-- mdh:cards 4 -->\n- a\n- b\n', { line: 3, reason: '知らない目印', marker: '<!-- mdh:cards 4 -->' }],
  ['知らない目印（s 抜け）', '<!-- mdh:card 3 -->\n- a\n', { line: 1, reason: '知らない目印', marker: '<!-- mdh:card 3 -->' }],
  ['カードの目印の後ろに対象が無い', '<!-- mdh:cards 3 -->\n\n段落\n', { line: 1, reason: '目印の後ろに対象が無い', marker: '<!-- mdh:cards 3 -->' }],
  ['結合の目印の後ろに対象が無い', '<!-- mdh:merge -->\n\n段落\n', { line: 1, reason: '目印の後ろに対象が無い', marker: '<!-- mdh:merge -->' }]
];
for (const [name, md, expected] of WARN_2B) {
  test(`AC4 ${name}を行番号付きで警告し、HTML は警告の有無で変わらない`, async () => {
    assert.deepEqual(await warningsOf(md), [expected]);
    const $ = await render(md);
    assert.equal(doc($).find('.mdh-cards, .mdh-merged-table').length, 0);
  });
}

for (const marker of ['<!-- mdh:cards 3 -->', '<!-- mdh:button -->', '<!-- mdh:heatmap -->', '<!-- mdh:heatmap primary -->']) {
  test(`AC4 段落の中の ${marker} は何も変えず「段落の中の目印」で警告する`, async () => {
    const md = `前の段落\n\n文 ${marker}\n`;
    assert.deepEqual(await warningsOf(md), [{ line: 3, reason: '段落の中の目印', marker }]);
    const $ = await render(md);
    assert.equal(doc($).children('p').eq(1).text().trim(), '文');
  });
}

test('AC4 警告の行番号は YAML の前置きを含む元の原稿の行', async () => {
  const warnings = await warningsOf('---\ntitle: T\n---\n\n<!-- mdh:cards 4 -->\n- a\n');
  assert.deepEqual(warnings.map((w) => w.line), [5]);
});

test('AC4 正しく書いた 2b の原稿では警告が 0 件', async () => {
  const raw = await fs.readFile(sample2bPath, 'utf8');
  const warnings = [];
  await buildNotionHtmlString(raw, sample2bPath, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// AC6 collectHeadings を通さない renderMarkdown でも同じ構造
// ---------------------------------------------------------------------------
test('AC6 renderMarkdown を直接呼んでも、部品の要素・クラス・rowspan・colspan が同じ', async () => {
  const { parseMarkdownDocument } = await import('./markdown-document.mjs');
  const { renderMarkdown } = await import('./static-renderer.mjs');
  const raw = await fs.readFile(sample2bPath, 'utf8');
  const shape = ($, scope) => $(scope).find('.mdh-cards, .mdh-card, .mdh-columns, .mdh-column, .mdh-merged-scroll, .mdh-merged-table, th, td').toArray()
    .map((el) => `${el.tagName}|${$(el).attr('class') || ''}|${$(el).attr('rowspan') || ''}|${$(el).attr('colspan') || ''}`);
  const full = load(await buildNotionHtmlString(raw, sample2bPath));
  const direct = load(`<main>${await renderMarkdown(parseMarkdownDocument(raw, sample2bPath).tree)}</main>`);
  const base = shape(full, 'article.mdh-doc');
  assert.equal(base.filter((s) => /^(div|a)\|mdh-card/.test(s)).length, 8, 'カードの数が違う');
  assert.deepEqual(shape(direct, 'main'), base);
});

// ---------------------------------------------------------------------------
// AC11 すべての出力で 2b の部品の HTML が同じ（HTML の部分）
// ---------------------------------------------------------------------------
test('AC11 既定・仕様書セットで 2b の部品の HTML が同じ', async () => {
  const raw = await fs.readFile(sample2bPath, 'utf8');
  const parts = ($) => $('.mdh-cards, .mdh-columns, .mdh-merged-scroll').toArray().map((el) => $.html(el));
  const base = parts(load(await buildNotionHtmlString(raw, sample2bPath)));
  assert.equal(base.length, 7);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdh-components-2b-set-'));
  await fs.writeFile(path.join(tmp, 'sample.md'), raw);
  await buildSpecSet(tmp, { log: () => {}, warn: () => {} });
  assert.deepEqual(parts(load(await fs.readFile(path.join(tmp, 'html/sample.html'), 'utf8'))), base);
  await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// タブ。期待値はテストの中の文字で書く。
// ---------------------------------------------------------------------------
const TABS3 = '<!-- mdh:tabs -->\n### 案 A\n本文 A\n\n### 案 B\n本文 B\n\n### 案 C\n本文 C\n<!-- mdh:tabs-end -->\n';
const renderWarn = async (md) => {
  const warnings = [];
  const $ = load(await buildNotionHtmlString(md, '/tmp/tabs-test.md', { onWarning: (w) => warnings.push(w) }));
  return { $, warnings };
};

test('AC1 タブ 3 枚はラベル 3 個とパネル 3 個になり、最初のラベルが選ばれている', async () => {
  const { $, warnings } = await renderWarn(TABS3);
  assert.deepEqual(warnings, []);
  const tabs = doc($).find('div.mdh-tabs');
  assert.equal(tabs.length, 1);
  const list = tabs.children('div.mdh-tab-list');
  assert.equal(list.attr('role'), 'radiogroup');
  const inputs = list.children('input[type="radio"]');
  const labels = list.children('label');
  assert.equal(inputs.length, 3);
  assert.equal(labels.length, 3);
  assert.deepEqual(inputs.map((_, el) => $(el).attr('id')).get(), ['mdh-tabs-1-1', 'mdh-tabs-1-2', 'mdh-tabs-1-3']);
  assert.deepEqual(inputs.map((_, el) => $(el).attr('name')).get(), ['mdh-tabs-1', 'mdh-tabs-1', 'mdh-tabs-1']);
  assert.deepEqual(labels.map((_, el) => $(el).attr('for')).get(), ['mdh-tabs-1-1', 'mdh-tabs-1-2', 'mdh-tabs-1-3']);
  assert.deepEqual(labels.map((_, el) => $(el).text()).get(), ['案 A', '案 B', '案 C']);
  assert.equal(inputs.eq(0).attr('checked'), 'checked');
  assert.equal(inputs.eq(1).attr('checked'), undefined);
  const panels = tabs.children('section.mdh-tab-panel');
  assert.deepEqual(panels.map((_, el) => $(el).attr('data-mdh-tab')).get(), ['1', '2', '3']);
  assert.equal(panels.eq(1).children('.mdh-tab-heading').text(), '案 B');
  assert.equal(panels.eq(1).children('p').text(), '本文 B');
  assert.equal(doc($).text().includes('mdh:tabs'), false);
});

test('AC1 タブの深さより深い見出しはタブを分けない', async () => {
  const { $ } = await renderWarn('<!-- mdh:tabs -->\n## 案 A\n### 詳細\n本文\n\n## 案 B\n本文 B\n<!-- mdh:tabs-end -->\n');
  const panels = doc($).find('section.mdh-tab-panel');
  assert.equal(panels.length, 2);
  assert.equal(panels.eq(0).children('h1, h2, h3, h4, h5, h6').not('.mdh-tab-heading').text(), '詳細');
});

test('AC1 タブの中の段組み・カード・コールアウトと、段組みの 1 列とコールアウトの中のタブ', async () => {
  const inner = '<!-- mdh:tabs -->\n### 案 A\n> [!blue] 注意\n> 本文\n\n<!-- mdh:cards 2 -->\n- カード 1\n- カード 2\n\n### 案 B\n<!-- mdh:columns 2 -->\n左\n\n<!-- mdh:column-break -->\n右\n<!-- mdh:columns-end -->\n<!-- mdh:tabs-end -->\n';
  const a = await renderWarn(inner);
  assert.deepEqual(a.warnings, []);
  assert.equal(doc(a.$).find('section.mdh-tab-panel').eq(0).children('div.mdh-callout').length, 1);
  assert.equal(doc(a.$).find('section.mdh-tab-panel').eq(0).children('div.mdh-cards').length, 1);
  assert.equal(doc(a.$).find('section.mdh-tab-panel').eq(1).children('div.mdh-columns').length, 1);
  const outer = '<!-- mdh:columns 2 -->\n<!-- mdh:tabs -->\n### X\nx\n\n### Y\ny\n<!-- mdh:tabs-end -->\n\n<!-- mdh:column-break -->\n右\n<!-- mdh:columns-end -->\n\n> [!gray] 枠\n> <!-- mdh:tabs -->\n> ### P\n> p\n>\n> ### Q\n> q\n> <!-- mdh:tabs-end -->\n';
  const b = await renderWarn(outer);
  assert.deepEqual(b.warnings, []);
  assert.equal(doc(b.$).find('div.mdh-column').eq(0).children('div.mdh-tabs').length, 1);
  assert.equal(doc(b.$).find('div.mdh-callout div.mdh-tabs').length, 1);
  assert.deepEqual(doc(b.$).find('input[type="radio"]').map((_, el) => b.$(el).attr('name')).get(), ['mdh-tabs-1', 'mdh-tabs-1', 'mdh-tabs-2', 'mdh-tabs-2']);
});

test('AC1 タブの中の段組みの見出しはタブを分けない', async () => {
  const md = '<!-- mdh:tabs -->\n### A\n\n<!-- mdh:columns 2 -->\n### 左\nx\n\n<!-- mdh:column-break -->\n### 右\ny\n<!-- mdh:columns-end -->\n\n### B\nz\n<!-- mdh:tabs-end -->\n';
  const { $, warnings } = await renderWarn(md);
  assert.deepEqual(warnings, []);
  assert.deepEqual(doc($).find('.mdh-tab-list label').map((_, el) => $(el).text()).get(), ['A', 'B']);
  assert.equal(doc($).find('section.mdh-tab-panel').eq(0).children('div.mdh-columns').length, 1);
});

const TAB_FAILS = [
  ['T12 終わりの目印が無い', '<!-- mdh:tabs -->\n### A\na\n\n### B\nb\n', '終わりの目印が無い', ['A', 'B']],
  ['T13 始まりが無い終わり', '本文\n\n<!-- mdh:tabs-end -->\n', '対応する始まりが無い', []],
  ['T14 最初が見出しでない', '<!-- mdh:tabs -->\nまえがき\n\n### A\na\n\n### B\nb\n<!-- mdh:tabs-end -->\n', 'タブの見出しが無い', ['A', 'B']],
  ['T14 浅い見出しがある', '<!-- mdh:tabs -->\n### A\na\n\n## 浅い\nx\n\n### B\nb\n<!-- mdh:tabs-end -->\n', 'タブの見出しより浅い見出し', ['A', '浅い', 'B']],
  ['T15 同じ親の入れ子', '<!-- mdh:tabs -->\n### A\n<!-- mdh:tabs -->\n#### a1\nx\n\n#### a2\ny\n<!-- mdh:tabs-end -->\n\n### B\nb\n<!-- mdh:tabs-end -->\n', '入れ子のタブ', ['A', 'a1', 'a2', 'B']],
  ['T15 引用の中の入れ子', '<!-- mdh:tabs -->\n### A\n> [!gray]\n> <!-- mdh:tabs -->\n> #### a1\n> x\n>\n> #### a2\n> y\n> <!-- mdh:tabs-end -->\n\n### B\nb\n<!-- mdh:tabs-end -->\n', '入れ子のタブ', ['A', 'a1', 'a2', 'B']],
  ['T16 タブが 1 枚', '<!-- mdh:tabs -->\n### A\na\n<!-- mdh:tabs-end -->\n', 'タブの数は 2〜8', ['A']]
];
for (const [name, md, reason, headings] of TAB_FAILS) {
  test(`AC2 ${name}: 警告 1 件「${reason}」、タブにならず本文のまま`, async () => {
    const { $, warnings } = await renderWarn(md);
    assert.deepEqual(warnings.map((w) => w.reason), [reason]);
    assert.equal(doc($).find('.mdh-tabs').length, 0);
    assert.equal(doc($).find('input[type="radio"]').length, 0);
    assert.deepEqual(doc($).find('h1, h2, h3, h4, h5, h6').map((_, el) => $(el).text()).get(), headings);
    assert.equal(doc($).find('.mdh-tab-heading').length, 0);
    assert.equal(doc($).text().includes('mdh:tabs'), false);
  });
}

test('AC2 T16 タブが 9 枚: 警告 1 件、タブにならない', async () => {
  const md = '<!-- mdh:tabs -->\n' + Array.from({ length: 9 }, (_, i) => `### T${i + 1}\nx\n`).join('\n') + '<!-- mdh:tabs-end -->\n';
  const { $, warnings } = await renderWarn(md);
  assert.deepEqual(warnings.map((w) => w.reason), ['タブの数は 2〜8']);
  assert.equal(doc($).find('.mdh-tabs').length, 0);
});

test('AC2 T17 リンク付きカードの中のタブはカードを普通のカードにして警告を出す', async () => {
  const md = '<!-- mdh:cards 2 -->\n- [案内](https://example.com)\n  <!-- mdh:tabs -->\n  #### X\n  x\n\n  #### Y\n  y\n  <!-- mdh:tabs-end -->\n- 2 枚目\n';
  const { $, warnings } = await renderWarn(md);
  assert.deepEqual(warnings.map((w) => w.reason), ['リンク付きカードの中に押せる要素']);
  assert.equal(doc($).find('a.mdh-card-link').length, 0);
  assert.equal(doc($).find('div.mdh-card div.mdh-tabs').length, 1);
});

test('AC2a ラベルの文字に見出しの記号が残らず、見出しの id は今の規則で付く', async () => {
  const md = '## mdh-tabs-1-1\n\n<!-- mdh:tabs -->\n### 案 A [#a]\nx\n\n### 案 B [#a]\ny\n\n### 案 C [#mdh-bad]\nz\n<!-- mdh:tabs-end -->\n';
  const { $, warnings } = await renderWarn(md);
  assert.deepEqual(warnings.map((w) => w.reason).sort(), ['使えない名前', '重なった名前'].sort());
  assert.deepEqual(doc($).find('.mdh-tab-list label').map((_, el) => $(el).text()).get(), ['案 A', '案 B', '案 C']);
  assert.equal(doc($).find('section.mdh-tab-panel').eq(0).children('.mdh-tab-heading').attr('id'), 'a');
  const ids = $('[id]').map((_, el) => $(el).attr('id')).get();
  assert.equal(new Set(ids).size, ids.length, `id が重なっている: ${ids.join(',')}`);
  assert.equal($('#mdh-tabs-1-1').is('h1, h2'), true);
  assert.equal(doc($).find('.mdh-tab-list input').eq(0).attr('id'), 'mdh-tabs-1-1-2');
});

test('AC2 T14 先頭が見出しでなく目印のタブ: 「タブの見出しが無い」でタブにならない', async () => {
  for (const head of ['<!-- mdh:column-break -->', '<!-- mdh:columns-end -->', '<!-- mdh:cards 2 -->', '<!-- mdh:merge -->']) {
    const { $, warnings } = await renderWarn(`<!-- mdh:tabs -->\n${head}\n### A\na\n\n### B\nb\n<!-- mdh:tabs-end -->\n`);
    assert.equal(warnings.map((w) => w.reason).includes('タブの見出しが無い'), true, `${head}: ${JSON.stringify(warnings)}`);
    assert.equal(doc($).find('.mdh-tabs').length, 0, head);
  }
});
