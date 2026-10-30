// 数式の HTML の検査。
// 期待値はテストの中の文字で書く（renderer や節点の value から作らない）。
// math.mjs は T2 まで存在しないので静的に読まず、使うケースの中で動的に読む（PLAN T1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { buildNotionHtmlString } from './build-notion.mjs';
import { parseMarkdownDocument } from './markdown-document.mjs';
import { renderMarkdown } from './static-renderer.mjs';
import { buildSpecSet } from '../build_spec_set.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const samplePath = path.join(root, 'mockups/fixtures/components-2c/sample.md');

const render = async (md, options) => load(await buildNotionHtmlString(md, '/tmp/math-test.md', options));
const doc = ($) => $('article.mdh-doc');
const withWarnings = async (md) => {
  const warnings = [];
  const html = await buildNotionHtmlString(md, '/tmp/math-warn.md', { onWarning: (w) => warnings.push(w) });
  return { $: load(html), html, warnings };
};

// ---------------------------------------------------------------------------
// AC1 解析
// ---------------------------------------------------------------------------
test('AC1 文中の $$…$$ は数式になり、\\% のバックスラッシュが消えない', async () => {
  const $ = await render('率は $$80\\%$$ です。\n');
  const math = doc($).find('p > math.mdh-math');
  assert.equal(math.length, 1);
  assert.equal(math.find('mn').first().text(), '80');
  assert.equal(math.text().includes('%'), true);
  assert.equal(doc($).find('p').text().includes('$$'), false);
  const parsed = parseMarkdownDocument('率は $$80\\%$$ です。\n', '/tmp/p.md');
  const values = [];
  (function walk(n) { if (n.type === 'inlineMath') values.push(n.value); (n.children || []).forEach(walk); })(parsed.tree);
  assert.deepEqual(values, ['80\\%']);
});

for (const [name, md, text] of [
  ['金額の単独の $', '価格は $7.2M と $0.06 です。\n', '価格は $7.2M と $0.06 です。'],
  ['リンク先の ${…}', '[資料](${GENZ_PROJECT_ROOT}/docs/a.md) と ${X}\n', '資料 と ${X}'],
  ['\\$$ の打ち消し', '\\$$x$$ は文字です。\n', '$$x$$ は文字です。']
]) {
  test(`AC1 ${name} は数式にならず、今と同じ文字になる`, async () => {
    const $ = await render(md);
    assert.equal(doc($).find('math').length, 0);
    assert.equal(doc($).find('p').first().text(), text);
  });
}

test('AC1 行内コードとコードブロックの中の $$ は数式にならない', async () => {
  const $ = await render('`$$x$$` です。\n\n```\n$$\ny\n$$\n```\n');
  assert.equal(doc($).find('math').length, 0);
  assert.equal(doc($).find('p > code').text(), '$$x$$');
  assert.equal(doc($).find('pre code').text(), '$$\ny\n$$\n');
});

test('AC1 表のセルの中の $$…$$ は文中の式になる', async () => {
  const $ = await render('| a | b |\n| --- | --- |\n| $$x^2$$ | 1 |\n');
  assert.equal(doc($).find('td math.mdh-math').length, 1);
});

// ---------------------------------------------------------------------------
// AC2 組版
// ---------------------------------------------------------------------------
test('AC2 文中の式は p の中の math.mdh-math だけを出す', async () => {
  const $ = await render('平均は $$\\bar{x}$$ です。\n');
  const math = doc($).find('p > math');
  assert.equal(math.length, 1);
  assert.deepEqual(math.attr('class').split(/\s+/), ['mdh-math']);
  assert.equal(math.attr('display'), undefined);
  assert.equal(doc($).find('.mdh-math-display').length, 0);
});

for (const [name, md] of [
  ['$$ の行で囲んだ式', '前の段落\n\n$$\n\\frac{1}{2}\n$$\n\n後の段落\n'],
  ['$$…$$ だけの 1 行', '前の段落\n\n$$\\frac{1}{2}$$\n\n後の段落\n'],
  ['空白を挟んだ $$…$$ だけの 1 行', '前の段落\n\n  $$ \\frac{1}{2} $$  \n\n後の段落\n']
]) {
  test(`AC2 ${name} は独立した式になる`, async () => {
    const $ = await render(md);
    const display = doc($).find('div.mdh-math-display');
    assert.equal(display.length, 1);
    const math = display.children('math');
    assert.equal(math.length, 1);
    assert.equal(math.attr('display'), 'block');
    assert.deepEqual(math.attr('class').split(/\s+/).sort(), ['mdh-math', 'tml-display']);
    assert.equal(math.find('mfrac').length, 1);
    assert.equal(doc($).find('p div, p math[display=block]').length, 0);
    assert.deepEqual(doc($).find('p').map((_, p) => $(p).text()).get(), ['前の段落', '後の段落']);
  });
}

test('AC2 前文のある段落の式は文中の式のまま', async () => {
  const $ = await render('前文 $$x$$\n');
  assert.equal(doc($).find('.mdh-math-display').length, 0);
  assert.equal(doc($).find('p > math.mdh-math').length, 1);
});

test('AC2 $$x$$ と $$y$$ を空行なしで 2 行に書くと 1 つの段落の 2 つの文中の式', async () => {
  const $ = await render('$$x$$\n$$y$$\n');
  assert.equal(doc($).find('.mdh-math-display').length, 0);
  assert.equal(doc($).find('p').length, 1);
  assert.equal(doc($).find('p > math.mdh-math').length, 2);
});

test('AC2 箇条書き・引用・表のセル・カードの本文の中の式', async () => {
  const md = [
    '- 項目の $$a$$',
    '',
    '> 引用の $$b$$',
    '',
    '| a |',
    '| --- |',
    '| $$c$$ |',
    '',
    '<!-- mdh:cards 2 -->',
    '- タイトル',
    '  本文の $$d$$',
    '- タイトル 2',
    '  本文',
    ''
  ].join('\n');
  const $ = await render(md);
  assert.equal(doc($).find('li math.mdh-math').length, 1);
  assert.equal(doc($).find('blockquote math.mdh-math').length, 1);
  assert.equal(doc($).find('td math.mdh-math').length, 1);
  assert.equal(doc($).find('.mdh-card .mdh-card-body math.mdh-math').length, 1);
});

test('AC2 カードの項目の先頭が独立した式だとカードにならず警告される', async () => {
  const { $, warnings } = await withWarnings('<!-- mdh:cards 2 -->\n- $$x$$\n- 文\n');
  assert.equal(doc($).find('.mdh-card').length, 0);
  assert.equal(doc($).find('ul > li').length, 2);
  assert.equal(warnings.filter((w) => w.reason === 'カードにならない項目').length, 1);
});

test('§5 \\color{red} は赤で組む', async () => {
  const $ = await render('色は $$\\color{red}{x}$$ です。\n');
  const math = doc($).find('p > math.mdh-math');
  assert.equal(math.length, 1);
  assert.match(math.find('[style]').attr('style'), /color:\s*#ff0000/);
});

// ---------------------------------------------------------------------------
// AC3 組めない式・閉じていない式
// ---------------------------------------------------------------------------
const CANNOT = '数式を組めない';
const UNCLOSED = '閉じていない `$$`';
const META = '`$$` の行に式がある';

for (const c of [
  { name: '文中の組めない式', md: '率は $$\\frac{256}{$$ です。\n', reason: CANNOT, line: 1, inline: '率は $$\\frac{256}{$$ です。' },
  { name: '文中の両端に空白 2 つ', md: '式 $$  \\bad  $$ です。\n', reason: CANNOT, line: 1, inline: '式 $$  \\bad  $$ です。' },
  { name: '文中の $$$ の区切り', md: '式 $$$\\bad$$$ です。\n', reason: CANNOT, line: 1, inline: '式 $$$\\bad$$$ です。' },
  { name: '$$ の行で囲んだ組めない式', md: '$$\n\\frac{256}{\n$$\n', reason: CANNOT, line: 1, source: '$$\n\\frac{256}{\n$$' },
  { name: '文書の終わりまで閉じていない', md: '本文\n\n$$\nx\n\n続き\n', reason: UNCLOSED, line: 3, source: '$$\nx\n\n続き' },
  { name: '$$ だけの 1 行', md: '$$\n', reason: UNCLOSED, line: 1, source: '$$' },
  { name: '字下げ 4 つの $$ は閉じにならない', md: '$$\nx\n    $$\n\n', reason: UNCLOSED, line: 1, startsWith: '$$\nx\n    $$' },
  { name: '$$$ で開いて $$ で閉じようとした', md: '$$$\nx\n$$\n', reason: UNCLOSED, line: 1, startsWith: '$$$\nx\n$$' },
  { name: '引用の中の組めない式', md: '> $$\n> \\frac{1}{\n> $$\n', reason: CANNOT, line: 1, source: '$$\n\\frac{1}{\n$$' },
  { name: '入れ子の引用の中の閉じていない式', md: '> > $$\n> > x\n\n後\n', reason: UNCLOSED, line: 1, source: '$$\nx' },
  { name: '箇条書きの項目の中の閉じていない式', md: '- $$\n  x\n- 次\n', reason: UNCLOSED, line: 1, source: '$$\nx' },
  { name: '$$ の行に式がある', md: '$$ E=mc^2\n$$\n', reason: META, line: 1, source: '$$ E=mc^2\n$$' },
  { name: '空の式（2 行）', md: '$$\n$$\n', reason: CANNOT, line: 1, source: '$$\n$$' },
  { name: '空の式（$$ $$）', md: '$$ $$\n', reason: CANNOT, line: 1, inlineSource: '$$ $$' }
]) {
  test(`AC3 ${c.name}`, async () => {
    const { $, warnings } = await withWarnings(c.md);
    assert.equal(doc($).find('math').length, 0, '組めない式から math が出た');
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.equal(warnings[0].reason, c.reason);
    assert.equal(warnings[0].line, c.line);
    if (c.inline) assert.equal(doc($).find('p').first().text(), c.inline);
    if (c.source) assert.equal(doc($).find('div.mdh-math-source').text(), c.source);
    if (c.startsWith) assert.equal(doc($).find('div.mdh-math-source').text().startsWith(c.startsWith), true);
    if (c.inlineSource) assert.equal(doc($).text().includes(c.inlineSource), true);
    const without = await buildNotionHtmlString(c.md, '/tmp/math-warn.md');
    const withWarn = await buildNotionHtmlString(c.md, '/tmp/math-warn.md', { onWarning: () => {} });
    assert.equal(withWarn, without, 'onWarning の有無で HTML が変わった');
  });
}

test('AC3 閉じていない $$ の後ろの本文が数式にならない', async () => {
  const { $ } = await withWarnings('$$\nx\n\n## 見出し\n\n続きの本文\n');
  assert.equal(doc($).find('math').length, 0);
  assert.equal(doc($).find('div.mdh-math-source').length, 1);
});

test('AC3 字下げ 4 つの $$ を挟んで閉じた式は閉じている', async () => {
  const { warnings } = await withWarnings('$$\n    $$\n$$\n');
  assert.equal(warnings.some((w) => w.reason === UNCLOSED), false);
});

test('AC3 行ごとに入れ物の印の幅が違う引用の中の閉じた式は組まれる', async () => {
  const { $, warnings } = await withWarnings('> $$\n  > x\n  > $$\n');
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.equal(doc($).find('blockquote .mdh-math-display math').length, 1);
});

test('AC3 遅延継続の行をまたぐ組めない文中の式は、両端の空白 1 つずつの差を除いて書いたとおり', async () => {
  const md = '> 文 $$\\bad\n  x$$\n';
  const { $, warnings } = await withWarnings(md);
  assert.equal(warnings.length, 1);
  // 組み立てた原文は `$$\\bad\n  x$$`。HTML にする段（mdast-util-to-hast の text）が行頭の空白を取り除くので、出力は次の形になる
  assert.equal(doc($).find('blockquote p').text(), '文 $$\\bad\nx$$');
});

for (const [name, nl] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]) {
  test(`AC3 改行が ${name} の原稿でも、組めない式の原文が重ならない`, async () => {
    const { $, warnings } = await withWarnings(['$$', '\\bad', '$$', ''].join(nl));
    assert.equal(warnings.length, 1);
    assert.equal(doc($).find('div.mdh-math-source').text().replace(/\r\n?/g, '\n'), '$$\n\\bad\n$$');
  });
}

test('AC3 警告の marker は節点の位置からの切り出しで、表示の原文と別', async () => {
  const { $, warnings } = await withWarnings('> $$\n> \\bad\n> $$\n');
  assert.equal(doc($).find('div.mdh-math-source').text(), '$$\n\\bad\n$$');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].marker.startsWith('$$\n> \\bad\n> $$（'), true, warnings[0].marker);
});

test('AC3 行番号は YAML の前置きを含む元の原稿の行', async () => {
  const { warnings } = await withWarnings('---\ntitle: T\n---\n\n本文\n\n率は $$\\frac{1}{$$ です。\n');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 7);
  assert.equal(warnings[0].reason, CANNOT);
});

test('AC3 検査用の原稿では警告が 0 件', async () => {
  const raw = await fs.readFile(samplePath, 'utf8');
  const warnings = [];
  await buildNotionHtmlString(raw, samplePath, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// AC4 安全
// ---------------------------------------------------------------------------
const counts = ($) => ({
  a: doc($).find('a').length,
  href: doc($).find('[href]').length,
  id: doc($).find('[id]').length,
  img: doc($).find('img').length
});

for (const tex of [
  '\\href{https://example.com}{x}',
  '\\htmlId{bar}{x}',
  '\\class{foo}{x}',
  '\\style{color:red}{x}',
  '\\includegraphics{a.png}',
  '\\color{expression(alert(1))}{x}',
  'x+\\ref{a}',
  '\\eqref{a}',
  '\\def\\r{\\ref{a}}x+\\r'
]) {
  test(`AC4 ${tex} は原文のまま出て、リンク・id・画像が増えない`, async () => {
    const base = counts(await render('本文の段落です。\n'));
    const { $, warnings } = await withWarnings(`本文の段落です。\n\n率は $$${tex}$$ です。\n`);
    assert.deepEqual(counts($), base);
    assert.equal(doc($).find('math').length, 0);
    assert.equal(doc($).text().includes(`$$${tex}$$`), true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].reason, CANNOT);
  });
}

test('AC4 equation の中の \\label は原文のまま出て id が増えない', async () => {
  const base = counts(await render('本文の段落です。\n'));
  const { $ } = await withWarnings('本文の段落です。\n\n$$\n\\begin{equation}x\\label{mdhSettingsPanel}\\end{equation}\n$$\n');
  assert.deepEqual(counts($), base);
  assert.equal(doc($).find('#mdhSettingsPanel').length, 0);
  assert.equal(doc($).find('div.mdh-math-source').length, 1);
});

for (const tex of [
  '\\frac{1}{2}', '\\sqrt{x}', '\\begin{aligned}a&=b\\\\c&=d\\end{aligned}', '\\color{red}{x}',
  '\\bar{x}', '\\hat{x}', '\\vec{x}', '\\tilde{x}', '\\mathscr{X}', '\\label{foo}x'
]) {
  test(`AC4 正しく組む式 ${tex} は検査を通り、math.mdh-math が 1 つ出る`, async () => {
    const base = counts(await render('本文の段落です。\n'));
    const { $, warnings } = await withWarnings(`本文の段落です。\n\n$$\n${tex}\n$$\n`);
    assert.deepEqual(warnings, []);
    assert.equal(doc($).find('math.mdh-math').length, 1);
    assert.deepEqual(counts($), base);
    assert.equal(doc($).find('math [class*="mdh-"]').length, 0);
  });
}

// ---------------------------------------------------------------------------
// AC5 見出しの中の式
// ---------------------------------------------------------------------------
test('AC5 見出しの中の式は組まれ、目次と id に TeX の原文が入る', async () => {
  const $ = await render('---\ntitle: T\n---\n\n## 平均 $$\\bar{x}$$\n\n本文\n');
  const h = doc($).find('h1, h2').first();
  assert.equal(h.find('math.mdh-math').length, 1);
  assert.equal(h.attr('id'), '平均-barx');
  assert.equal($('.mdh-toc a[href="#平均-barx"]').first().text(), '平均 \\bar{x}');
});

for (const md of ['## $$x$$ [#foo]\n\n本文\n', '## $$x$$ {#foo}\n\n本文\n']) {
  test(`AC5 ${md.split('\n')[0]} は id が foo になり記号が残らず警告が出ない`, async () => {
    const { $, warnings } = await withWarnings(`---\ntitle: T\n---\n\n${md}`);
    assert.deepEqual(warnings, []);
    const h = doc($).find('h1, h2').first();
    assert.equal(h.attr('id'), 'foo');
    assert.equal(h.text().includes('#foo'), false);
    assert.equal(h.find('math.mdh-math').length, 1);
  });
}

test('AC5 ページの中の id が重ならない', async () => {
  const $ = await render(await fs.readFile(samplePath, 'utf8'));
  const ids = $('[id]').map((_, e) => $(e).attr('id')).get();
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// AC6 木の差し替えと、typesetMath を通らない経路
// ---------------------------------------------------------------------------
test('AC6 typesetMath は数式の節点に hChildren を持たせ、html の節点を足さない', async () => {
  const { typesetMath } = await import('./math.mjs');
  const md = '率は $$x$$ です。\n\n$$\n\\frac{1}{2}\n$$\n';
  const parsed = parseMarkdownDocument(md, '/tmp/t.md');
  await typesetMath(parsed.tree, parsed.markdown);
  const types = [];
  const maths = [];
  (function walk(n) { types.push(n.type); if (n.type === 'math' || n.type === 'inlineMath') maths.push(n); (n.children || []).forEach(walk); })(parsed.tree);
  assert.equal(types.includes('html'), false);
  assert.equal(maths.length, 2);
  for (const n of maths) assert.equal(Array.isArray(n.data?.hChildren) && n.data.hChildren.length > 0, true);
});

test('AC6 typesetMath を通らずに renderMarkdown を呼ぶと code で原文が出る', async () => {
  const parsed = parseMarkdownDocument('率は $$x$$ です。\n\n$$\ny\n$$\n', '/tmp/t.md');
  const $ = load(await renderMarkdown(parsed.tree));
  assert.equal($('code.math-inline').text(), 'x');
  assert.equal($('code.math-display').text(), 'y');
  assert.equal($('math').length, 0);
});

// ---------------------------------------------------------------------------
// AC11 すべての出力で同じ（R12）
// ---------------------------------------------------------------------------
test('AC11 既定・仕様書セットで数式の HTML が同じ', async () => {
  const raw = await fs.readFile(samplePath, 'utf8');
  const parts = ($) => $('article.mdh-doc math.mdh-math, article.mdh-doc .mdh-math-display').map((_, e) => $.html(e)).get();
  const base = parts(load(await buildNotionHtmlString(raw, samplePath)));
  assert.equal(base.length > 0, true);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdh-math-set-'));
  await fs.writeFile(path.join(tmp, 'sample.md'), raw);
  await buildSpecSet(tmp, { log: () => {}, warn: () => {} });
  assert.deepEqual(parts(load(await fs.readFile(path.join(tmp, 'html/sample.html'), 'utf8'))), base);
  await fs.rm(tmp, { recursive: true, force: true });
});
