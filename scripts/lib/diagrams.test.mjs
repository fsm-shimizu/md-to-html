// 図の検査。期待値はテストの中の文字で書く（renderer から作らない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { buildNotionHtmlString } from './build-notion.mjs';
import { checkSvg, DIAGRAM_REASONS } from './diagrams.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const samplePath = path.join(root, 'mockups/fixtures/components-extra/diagrams.md');
const render = async (md) => {
  const warnings = [];
  const html = await buildNotionHtmlString(md, '/tmp/diagrams-test.md', { onWarning: (w) => warnings.push(w) });
  return { $: load(html), html, warnings };
};
const fence = (code, lang = 'mermaid') => `\`\`\`${lang}\n${code}\n\`\`\`\n`;

// ---------------------------------------------------------------------------
// AC1 8 種類の図が figure.mdh-diagram の SVG になる
// ---------------------------------------------------------------------------
const KINDS = [
  ['flowchart', 'flowchart TD\n  A[申し込みフォームの送信を受け付けて、住所を確かめる] --> B{県外か}\n  subgraph 月末\n    C[CSV を書き出す]\n  end\n  B --> C', ['申し込みフォームの送信を受け付けて、住所を確かめる', '県外か', 'CSV を書き出す']],
  ['graph', 'graph LR\n  A["1 行目<br>2 行目"] --> B[次の手順]', ['1 行目', '2 行目', '次の手順']],
  ['sequenceDiagram', 'sequenceDiagram\n  participant 利用者\n  participant 管理画面\n  利用者->>管理画面: 予約の番号を入れる', ['利用者', '管理画面', '予約の番号を入れる']],
  ['stateDiagram', 'stateDiagram\n  [*] --> 待ち\n  待ち --> 完了', ['待ち', '完了']],
  ['stateDiagram-v2', 'stateDiagram-v2\n  [*] --> 下書き\n  下書き --> 公開: 承認する', ['下書き', '公開', '承認する']],
  ['classDiagram', 'classDiagram\n  class 文書 {\n    +タイトル\n  }', ['文書', 'タイトル']],
  ['erDiagram', 'erDiagram\n  顧客 ||--o{ 注文 : "注文する"', ['顧客', '注文', '注文する']],
  ['xychart-beta', 'xychart-beta\n  title "月ごとの件数"\n  x-axis [4月, 5月]\n  bar [120, 340]\n  line [120, 340]', ['月ごとの件数', '4月', '5月']]
];
for (const [kind, code, labels] of KINDS) {
  test(`AC1 ${kind} は figure.mdh-diagram の SVG になり、コードブロックが消え、ラベルが文字で残る`, async () => {
    const { $, warnings } = await render(`## 図\n\n${fence(code)}`);
    assert.deepEqual(warnings, []);
    const figure = $('article.mdh-doc figure.mdh-diagram');
    assert.equal(figure.length, 1);
    assert.equal(figure.attr('data-mdh-diagram'), kind);
    assert.equal(figure.parents('pre, code').length, 0);
    assert.equal($('article.mdh-doc pre').length, 0);
    const svg = figure.children('svg');
    assert.equal(svg.length, 1);
    assert.equal(svg.children('title').first().text(), `図（${kind}）`);
    assert.match(svg.attr('style'), /^max-width: [\d.]+px; min-width: [\d.]+px$/);
    assert.equal(svg.attr('width'), undefined);
    const text = svg.find('text, tspan').map((_, el) => $(el).text()).get().join('\n');
    for (const label of labels) assert.equal(text.includes(label), true, `${label} が無い`);
  });
}

// ---------------------------------------------------------------------------
// AC2 描けない図はコードのまま、警告 1 件、変換は続く
// ---------------------------------------------------------------------------
const FAILS = [
  ['対応していない種類（pie）', 'pie title 内訳\n  "県外" : 60', DIAGRAM_REASONS.unsupported],
  ['対応していない種類（gantt）', 'gantt\n  title 予定', DIAGRAM_REASONS.unsupported],
  ['空', '', DIAGRAM_REASONS.cannot],
  ['%% の行だけ', '%% メモだけ', DIAGRAM_REASONS.cannot],
  ['空白なしの矢印 A-->B;', 'graph LR\n  A-->B;', DIAGRAM_REASONS.cannot],
  ['空白なしの矢印 A-->B-->C', 'graph LR\n  A-->B-->C', DIAGRAM_REASONS.cannot],
  ['空白なしの矢印 A---B', 'graph LR\n  A---B', DIAGRAM_REASONS.cannot],
  ['ラベル付きの太い矢印', 'graph LR\n  E ==ラベル==> A[x]', DIAGRAM_REASONS.cannot],
  ['空白なしの矢印と複数先の展開が混ざる', 'flowchart TD\nA --> B & C\nD-->E', DIAGRAM_REASONS.cannot],
  ['ラベルをつなげた太い矢印と複数先の展開（日本語）', 'flowchart TD\nA --> B & C\nD ==ラベル==> E[x]', DIAGRAM_REASONS.cannot],
  ['ラベルをつなげた矢印（英語）', 'flowchart TD\nA --> B & C\nD --label--> E', DIAGRAM_REASONS.cannot],
  ['ラベルをつなげた点線の矢印', 'flowchart TD\nA -.ラベル.-> B', DIAGRAM_REASONS.cannot],
  ['丸で終わる矢印', 'flowchart TD\nA --o B', DIAGRAM_REASONS.cannot],
  ['×で終わる矢印', 'flowchart TD\nA --x B', DIAGRAM_REASONS.cannot]
];
for (const [name, code, reason] of FAILS) {
  test(`AC2 ${name}: コードのまま、警告「${reason}」1 件`, async () => {
    const { $, warnings } = await render(`## 図\n\n${fence(code)}\n## 後ろ\n\n本文\n`);
    assert.deepEqual(warnings.map((w) => w.reason), [reason]);
    assert.equal($('figure.mdh-diagram').length, 0);
    assert.equal($('article.mdh-doc pre code.language-mermaid').length, 1);
    assert.equal($('article.mdh-doc p').last().text(), '本文');
  });
}

test('AC2 矢印の確かめは、正しい書き方（空白・& ・空白で囲んだラベル・|ラベル|・点線・太線・ハイフン入りの名前）を落とさない', async () => {
  const { $, warnings } = await render(fence('graph LR\n  A --> B & C\n  B -- ラベル --> D\n  C -.-> D\n  D ==> E\n  E -->|はい| F\n  F == 太い ==> G\n  foo--bar[名前] --> A\n  G ==>|はい| A'));
  assert.deepEqual(warnings, []);
  assert.equal($('figure.mdh-diagram').length, 1);
});

// ---------------------------------------------------------------------------
// AC3 悪意のある入力を模した図
// ---------------------------------------------------------------------------
const UNSAFE_STYLES = ['url(https://example.com/x.svg#p)', 'u\\72l(https://example.com/x.svg#p)', 'URL(https://example.com/y)', 'url(x.svg)', 'var(--x)', 'expression(alert(1))'];
for (const value of UNSAFE_STYLES) {
  test(`AC3 style の値 ${value} の図はコードのまま、警告「${DIAGRAM_REASONS.unsafe}」`, async () => {
    const { $, warnings, html } = await render(fence(`flowchart TD\n  A --> B\n  style A fill:${value}`));
    assert.deepEqual(warnings.map((w) => w.reason), [DIAGRAM_REASONS.unsafe]);
    assert.equal($('figure.mdh-diagram').length, 0);
    assert.equal(/<svg[^>]*mdh-diagram|<figure/.test(html), false);
  });
}

test('AC3 ラベルに書いた <script>・onclick・javascript: は文字として扱われ、要素や属性にならない', async () => {
  const { $ } = await render(fence('flowchart TD\n  A["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(1)>"]\n  B --> C["javascript:alert(1)"]'));
  const figure = $('figure.mdh-diagram');
  if (figure.length) {
    assert.equal(figure.find('script, img, a, foreignObject').length, 0);
    assert.equal(figure.find('*').filter((_, el) => Object.keys(el.attribs).some((k) => /^on/i.test(k))).length, 0);
  } else {
    assert.equal($('article.mdh-doc pre code').length, 1);
  }
});

// ---------------------------------------------------------------------------
// AC4a 許可リストの全域（検査の関数に直接、許可リストの外の要素・属性を入れる）
// ---------------------------------------------------------------------------
test('AC4a 許可リストの外の要素・属性・相対の href・onload を含む SVG と、読めない文字列は図にしない', () => {
  const svg = (inner, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"${attrs}><text font-size="13">x</text>${inner}</svg>`;
  const ctx = { kind: 'flowchart', code: 'flowchart TD', n: 1, usedIds: new Set() };
  assert.equal(checkSvg(svg(''), ctx).kind, 'flowchart');
  const cases = [
    ['foreignObject', svg('<foreignObject><div>x</div></foreignObject>')],
    ['image', svg('<image href="x.png"/>')],
    ['use', svg('<use href="#a"/>')],
    ['a', svg('<a href="https://example.com"><text>x</text></a>')],
    ['iframe', svg('<iframe src="x"></iframe>')],
    ['script', svg('<script>alert(1)</script>')],
    ['許可リストに無い属性', svg('<rect filter="blur(2px)"/>')],
    ['相対の href', svg('<rect href="x.svg"/>')],
    ['onload', svg('', ' onload="alert(1)"')],
    ['文書の外の参照', svg('<rect fill="url(#nai)"/>')],
    ['読めない文字列', 'これは SVG ではない']
  ];
  for (const [name, text] of cases) {
    const result = checkSvg(text, { ...ctx, usedIds: new Set() });
    assert.equal(result.reason, DIAGRAM_REASONS.unsafe, `${name}: ${JSON.stringify(result)}`);
  }
});

// ---------------------------------------------------------------------------
// AC4 外への読み込みが無く、<style> が無く、id が重ならない
// ---------------------------------------------------------------------------
test('AC4 見本の図の中に外への読み込みと <style> が無く、id は mdh-diagram- で始まり出力全体で重ならない', async () => {
  const raw = await fs.readFile(samplePath, 'utf8');
  const { $ } = await render(`## mdh-diagram-1-arrowhead\n\n${raw}`);
  const figures = $('figure.mdh-diagram');
  assert.equal(figures.length, 8);
  const inner = figures.map((_, el) => $.html(el)).get().join('\n');
  assert.equal(/https?:|\/\/[a-z]/i.test(inner.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), false);
  assert.equal(figures.find('style').length, 0);
  figures.find('[id]').each((_, el) => assert.match($(el).attr('id'), /^mdh-diagram-\d+-/));
  const ids = $('[id]').map((_, el) => $(el).attr('id')).get();
  assert.equal(new Set(ids).size, ids.length, `重なった id: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(',')}`);
});

// ---------------------------------------------------------------------------
// AC8 static-renderer.mjs とそれが読むファイルは図の依存を読まない
// ---------------------------------------------------------------------------
test('AC8 static-renderer.mjs から import をたどっても diagrams.mjs と beautiful-mermaid に届かない', async () => {
  const seen = new Set();
  const visit = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = await fs.readFile(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      assert.equal(spec === 'beautiful-mermaid' || spec.endsWith('diagrams.mjs'), false, `${path.basename(file)} が ${spec} を読む`);
      if (spec.startsWith('.')) await visit(path.resolve(path.dirname(file), spec));
    }
  };
  await visit(path.join(root, 'scripts/lib/static-renderer.mjs'));
  assert.equal(seen.size > 1, true);
});

// ---------------------------------------------------------------------------
// AC9 図の処理は図の外の本文を変えない（混在の見本）
// ---------------------------------------------------------------------------
test('AC9 図・数式・部品・コード・見出しを混ぜた見本で、図の位置を除いた DOM と見出しの id が同じ', async () => {
  const body = (lang) => `## 前\n\n文中の式 $$x^2$$ です。\n\n> [!blue] 注意\n> 本文\n\n${fence('flowchart TD\n  A --> B', lang)}\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n## 後\n\n<!-- mdh:cards 2 -->\n- カード 1\n- カード 2\n`;
  const a = await render(body('mermaid'));
  const b = await render(body('text'));
  assert.equal(a.$('figure.mdh-diagram').length, 1);
  a.$('figure.mdh-diagram').remove();
  b.$('pre:has(code.language-text)').remove();
  assert.equal(a.$('article.mdh-doc').html(), b.$('article.mdh-doc').html());
  const ids = ($) => $('article.mdh-doc :header').map((_, el) => $(el).attr('id')).get();
  assert.deepEqual(ids(a.$), ids(b.$));
});
