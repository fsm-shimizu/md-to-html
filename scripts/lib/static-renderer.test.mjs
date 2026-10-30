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

// ---------------------------------------------------------------------------
// 期待値はテストの中の文字で書く。
// ---------------------------------------------------------------------------
const { buildNotionHtmlString } = await import('./build-notion.mjs');
const page = async (md) => load(await buildNotionHtmlString(md, '/tmp/headings-test.md'));
const headings = ($) => $('.mdh-doc :is(h1, h2, h3, h4)').toArray().map((el) => [$(el).attr('id'), $(el).text()]);
const tocLinks = ($) => $('.mdh-toc-tree a').toArray().map((el) => [$(el).attr('href'), $(el).text()]);
const duplicateIds = ($) => {
  const ids = $('[id]').toArray().map((el) => $(el).attr('id'));
  return ids.filter((id, i) => ids.indexOf(id) !== i);
};

for (const [name, heading, id] of [
  ['[#名前]', '## 事例 [#case-01]', 'case-01'],
  ['{#名前}', '## 事例 {#case-01}', 'case-01'],
  ['空白なしの [#名前]', '## 事例[#case-01]', 'case-01'],
  ['日本語の名前', '## 事例 [#案件1]', '案件1']
]) {
  test(`AC4 見出しの ${name} は id になり、見出しと目次に記号が出ない`, async () => {
    const $ = await page(`${heading}\n\n本文\n`);
    assert.deepEqual(headings($), [[id, '事例']]);
    assert.deepEqual(tocLinks($), [[`#${id}`, '事例']]);
    assert.deepEqual(duplicateIds($), []);
  });
}

test('AC4 同じ名前の 2 つ目は記号を外して自動の id', async () => {
  const $ = await page('## A [#case-01]\n\n## B [#case-01]\n');
  assert.deepEqual(headings($), [['case-01', 'A'], ['b', 'B']]);
  assert.deepEqual(duplicateIds($), []);
});

test('AC4 自動の id が記号の名前と重なるときは自動の id をずらす', async () => {
  const $ = await page('## case-01\n\n## B [#case-01]\n');
  assert.deepEqual(headings($), [['case-01-1', 'case-01'], ['case-01', 'B']]);
  assert.deepEqual(tocLinks($), [['#case-01-1', 'case-01'], ['#case-01', 'B']]);
  assert.deepEqual(duplicateIds($), []);
});

for (const name of ['mdhSettingsPanel', 'user-content-fn-1', 'cmt-host', 'cmt-imported-document', 'footnote-label']) {
  test(`AC4 使えない名前 ${name} は記号にせず見出しの文字のまま`, async () => {
    const $ = await page(`## 設定 [#${name}]\n\n本文[^1]\n\n[^1]: 注釈\n`);
    const [[id, text]] = headings($).filter(([, t]) => t.startsWith('設定'));
    assert.equal(text, `設定 [#${name}]`);
    assert.notEqual(id, name);
    assert.deepEqual(duplicateIds($), []);
  });
}

test('AC4 記号だけの見出しは記号にせず見出しの文字のまま', async () => {
  const $ = await page('## [#setup]\n');
  assert.deepEqual(headings($), [['setup', '[#setup]']]);
});

test('AC4 同じ名前の参照の定義がある見出しは参照のリンクのまま', async () => {
  const $ = await page('## 事例 [#case-01]\n\n[#case-01]: /ref\n');
  const h = $('.mdh-doc h1');
  assert.equal(h.attr('id'), '事例-case-01');
  assert.equal(h.find('a').attr('href'), '/ref');
});

test('AC4 記号の無い文書の id は今と同じ', async () => {
  const $ = await page('## A\n\n## A\n\n### 日本語 の見出し\n\n## B\n');
  assert.deepEqual(headings($).map(([id]) => id), ['a', 'a-1', '日本語-の見出し', 'b']);
});

test('AC5 部品の中の見出しは id を持ち目次に出ず、外の見出しの id は今と同じ', async () => {
  const $ = await page('> [!note]\n>\n> ## Same\n\n## Same\n');
  assert.deepEqual(headings($), [['same', 'Same'], ['same-1', 'Same']]);
  assert.equal($('.mdh-callout h1#same').length, 1);
  assert.deepEqual(tocLinks($), [['#same-1', 'Same']]);
});

test('AC5 折りたたみと入れ子の引用の中の見出しも目次に出ない', async () => {
  const $ = await page('> [!toggle]+ 問い\n>\n> ## 中\n\n> [!gray]\n>\n> > 普通の引用\n> >\n> > ## 奥\n\n## 外\n');
  assert.deepEqual(headings($), [['中', '中'], ['奥', '奥'], ['外', '外']]);
  assert.deepEqual(tocLinks($), [['#外', '外']]);
});

test('AC5（2b）カラムの中の見出しは目次に出て、カードの中の見出しは id を持ち目次に出ない', async () => {
  const $ = await page('## 外\n\n<!-- mdh:columns 2 -->\n## 列 A\n\n<!-- mdh:column-break -->\n## 列 B\n<!-- mdh:columns-end -->\n\n<!-- mdh:cards 2 -->\n- カード\n\n  ## 外\n- B\n');
  assert.deepEqual(headings($), [['外', '外'], ['列-a', '列 A'], ['列-b', '列 B'], ['外-1', '外']]);
  assert.equal($('.mdh-column h1#列-a').length, 1);
  assert.equal($('.mdh-card-body h1#外-1').length, 1);
  assert.deepEqual(tocLinks($), [['#外', '外'], ['#列-a', '列 A'], ['#列-b', '列 B']]);
  assert.deepEqual(duplicateIds($), []);
});

test('AC5 普通の引用の中の見出しは今までどおり目次に出る', async () => {
  const $ = await page('> ## 引用の見出し\n\n## 外\n');
  assert.deepEqual(tocLinks($), [['#引用の見出し', '引用の見出し'], ['#外', '外']]);
});

test('AC6 改行を含む title は見える見出しで <br>、<title> は 1 行', async () => {
  const $ = await page('---\ntitle: "  部品の検査  \\r\\n\\n  <見本> 2a  "\n---\n\n本文\n');
  assert.equal($('.mdh-title h1').html(), '部品の検査<br>&lt;見本&gt; 2a');
  assert.equal($('title').text(), '部品の検査 <見本> 2a');
});

test('AC6 2 行の title と同じ文字の先頭の見出しは重なりとして取り除き、後ろの見出しの段は今と同じ', async () => {
  const $ = await page('---\ntitle: |-\n  A\n  B\n---\n\n# A B\n\n## C\n');
  assert.equal($('.mdh-title h1').html(), 'A<br>B');
  assert.deepEqual($('.mdh-doc :is(h1, h2)').toArray().map((el) => [el.tagName, $(el).text()]), [['h1', 'C']]);
});

// 見出しの記号の名前の回帰
for (const name of ['%', 'a%20b', '案件%1']) {
  test(`記号の名前 ${name} は目次のリンク先を decodeURIComponent すると id に戻る`, async () => {
    const $ = await page(`## A [#${name}]\n`);
    assert.deepEqual(headings($), [[name, 'A']]);
    const href = $('.mdh-toc-tree a').attr('href');
    assert.equal(decodeURIComponent(href.slice(1)), name);
  });
}

for (const name of ['user-content-fn-1', 'user-content-fnref-1', 'footnote-label', 'cmt-host']) {
  test(`記号だけの見出し [#${name}] の自動の id はページの id と重ならない`, async () => {
    const $ = await page(`## [#${name}]\n\n本文[^1]\n\n[^1]: 注釈\n`);
    assert.notEqual(headings($)[0][0], name);
    assert.deepEqual(duplicateIds($), []);
  });
}

for (const marker of ['<!-- mdh:button -->', '<!-- mdh:heatmap -->', '<!-- mdh:heatmap primary -->']) {
  test(`引用の先頭の ${marker} の後ろのコールアウトは、本文・目次・警告で同じ判定になる`, async () => {
    const md = `> ${marker}\n>\n> [!note] 見出し\n>\n> ## 中\n\n> ${marker}\n>\n> [!purple] 見出し\n> 本文\n\n## 外\n`;
    const warnings = [];
    const $ = load(await buildNotionHtmlString(md, '/tmp/headings-test.md', { onWarning: (w) => warnings.push(w) }));
    assert.equal($('.mdh-callout-gray h1#中').length, 1);
    assert.deepEqual(tocLinks($), [['#外', '外']]);
    assert.deepEqual(warnings.map((w) => w.marker), ['[!purple]']);
  });
}

for (const marker of ['<!-- mdh:button -->', '<!-- mdh:heatmap -->', '<!-- mdh:heatmap primary -->']) {
  test(`折りたたみの見出しの中の ${marker} は取り除いてから判定し、本文・目次・警告がそろう`, async () => {
    const warnings = [];
    const $ = load(await buildNotionHtmlString(`> [!toggle] ${marker}\n>\n> ## Inside\n\n## Outside\n`, '/tmp/headings-test.md', { onWarning: (w) => warnings.push(w) }));
    assert.equal($('.mdh-doc blockquote').length, 1);
    assert.equal($('.mdh-toggle').length, 0);
    assert.deepEqual(tocLinks($), [['#inside', 'Inside'], ['#outside', 'Outside']]);
    // 段落の中の行内の目印の警告も出す（既存の目印も対象）
    assert.deepEqual(warnings.map((w) => w.reason), ['段落の中の目印', '見出しの無い toggle']);
  });
}

test('% を含む記号の名前の目次のリンクは validate_notion_html.mjs を通る', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdh-validate-'));
  const file = path.join(tmp, 'percent.html');
  await fs.writeFile(file, await buildNotionHtmlString('## A [#%]\n\n## B [#a%20b]\n\n## C [#案件%1]\n', '/tmp/percent.md'));
  const script = new URL('../validate_notion_html.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await fs.rm(tmp, { recursive: true, force: true });
});

// タブ
test('AC3 タブの中の見出しは目次に出ず、タブの外の見出しは今と同じく出る', async () => {
  const { buildNotionHtmlString } = await import('./build-notion.mjs');
  const md = '## 前\n\n<!-- mdh:tabs -->\n### 案 A\n#### 詳細 A\nx\n\n### 案 B\ny\n<!-- mdh:tabs-end -->\n\n## 後\n';
  const $ = load(await buildNotionHtmlString(md, '/tmp/toc-tabs.md'));
  const toc = $('.mdh-toc-tree').text();
  assert.equal(toc.includes('前'), true);
  assert.equal(toc.includes('後'), true);
  for (const t of ['案 A', '詳細 A', '案 B']) assert.equal(toc.includes(t), false, `${t} が目次に出ている`);
});

test('AC10 値が /* mdh:script */ で始まる定数は 4 つのまま', async () => {
  const mod = await import('./static-renderer.mjs');
  const scripts = Object.entries(mod).filter(([, v]) => typeof v === 'string' && v.startsWith('/* mdh:script */')).map(([k]) => k).sort();
  assert.deepEqual(scripts, ['COLUMN_RESIZE_SCRIPT', 'SETTINGS_SCRIPT', 'TABLE_AUTOFILL_SCRIPT', 'TOC_CURRENT_SCRIPT']);
});

// ---------------------------------------------------------------------------
// 表紙と印刷の目次。期待値はテストの中の文字で書く。
// ---------------------------------------------------------------------------
const front = (data, { title = '題', toc = [], hubLink } = {}) => (async () => {
  const { renderPage } = await import('./static-renderer.mjs');
  return load(renderPage({ title, data, toc, bodyHtml: '<p>本文</p>' }, hubLink ? { hubLink } : {}));
})();

for (const [type, kind] of [['analysis', '分析レポート'], ['proposal', '提案書'], ['manual', '手順書'], ['report', 'ご報告'], ['handover', '引き継ぎ資料']]) {
  test(`AC1 type: ${type} は印刷の表紙を 1 つ出し、名前は「${kind}」`, async () => {
    const $ = await front({ type });
    assert.equal($('.mdh-print-front').length, 1);
    assert.equal($('.mdh-print-front .mdh-cover-kind').text(), kind);
    assert.equal($('.mdh-print-front .mdh-cover-title').text(), '題');
  });
}

for (const [name, data] of [['policy', { type: 'policy' }], ['無し', {}], ['大文字', { type: 'Proposal' }], ['空白付き', { type: 'proposal ' }], ['配列', { type: ['proposal'] }]]) {
  test(`AC1 type が ${name} なら表紙を出さない`, async () => {
    const $ = await front(data);
    assert.equal($('.mdh-print-front').length, 0);
  });
}

test('AC2 宛先・作成者が無ければ行が無く、status と tags は表紙に出ない', async () => {
  const $ = await front({ type: 'proposal', date: '2026-09-15', status: 'draft', tags: ['secret-tag'] });
  assert.equal($('.mdh-cover-to').length, 0);
  assert.deepEqual($('.mdh-cover-foot span').toArray().map((el) => $(el).text()), ['2026年9月15日']);
  const text = $('.mdh-print-front').text();
  assert.equal(text.includes('draft'), false);
  assert.equal(text.includes('secret-tag'), false);
});

test('AC2 宛先・作成者がどちらも無く日付も無ければ脚の行ごと無い', async () => {
  const $ = await front({ type: 'proposal' });
  assert.equal($('.mdh-print-front .mdh-cover').length, 1);
  assert.equal($('.mdh-cover-foot').length, 0);
});

test('AC2 表紙の文字はエスケープされ、見出しの要素を使わず、題の改行は <br> になる', async () => {
  const $ = await front({ type: 'proposal', to: '<script>alert(1)</script>', author: 'A & B' }, { title: '一行目\n二行目', toc: [{ level: 2, id: 'a', text: '章', children: [] }] });
  assert.equal($('.mdh-cover-to').text(), '<script>alert(1)</script>');
  assert.equal($('.mdh-print-front script').length, 0);
  assert.equal($('.mdh-print-front').find('h1, h2, h3, h4, h5, h6').length, 0);
  assert.equal($('.mdh-cover-title br').length, 1);
  assert.equal($('.mdh-cover-foot span').text(), 'A & B');
});

for (const [name, date, expected] of [['Date', new Date('2026-09-15'), '2026年9月15日'], ['日付だけの文字列', '2026-09-15', '2026年9月15日'], ['JSON の 0 時', '2026-09-15T00:00:00.000Z', '2026年9月15日'], ['JSON の 0 時でない時刻', '2026-09-15T12:34:56.000Z', '2026年9月15日'], ['日付でない文字列', '2026年9月吉日', '2026年9月吉日']]) {
  test(`AC2 表紙の日付（${name}）は「${expected}」`, async () => {
    const $ = await front({ type: 'proposal', date });
    assert.equal($('.mdh-cover-foot span').first().text(), expected);
  });
}

test('AC3 印刷の目次は木の根と直下の子を文書の順に並べ、孫は出さない', async () => {
  const toc = [
    { level: 1, id: 'c1', text: '章 1', children: [{ level: 2, id: 's1', text: '節 1', children: [{ level: 3, id: 'g1', text: '孫', children: [] }] }] },
    { level: 1, id: 'c2', text: '章 2', children: [] }
  ];
  const $ = await front({ type: 'proposal' }, { toc });
  assert.deepEqual($('.mdh-print-toc li').toArray().map((el) => [$(el).attr('class'), $(el).text()]), [['mdh-print-toc-l1', '章 1'], ['mdh-print-toc-l2', '節 1'], ['mdh-print-toc-l1', '章 2']]);
});

test('AC3 見出しが無ければ印刷の目次を出さず、表紙だけ', async () => {
  const $ = await front({ type: 'proposal' });
  assert.equal($('.mdh-print-front .mdh-cover').length, 1);
  assert.equal($('.mdh-print-toc').length, 0);
});

test('AC3 印刷の目次のリンクは本文の見出しの id を指す（% を含む id も）', async () => {
  const md = '---\ntitle: T\ntype: proposal\n---\n\n## 前\n\n## 案 [#a%b]\n\n### 細目\n';
  const $ = load(await buildNotionHtmlString(md, '/tmp/types-toc.md'));
  const hrefs = $('.mdh-print-toc a').toArray().map((el) => $(el).attr('href'));
  assert.ok(hrefs.length >= 1);
  assert.ok(hrefs.some((h) => decodeURIComponent(h.slice(1)).includes('%')));
  const ids = new Set($('.mdh-doc :is(h1, h2, h3)').toArray().map((el) => $(el).attr('id')));
  for (const h of hrefs) assert.ok(ids.has(decodeURIComponent(h.slice(1))), `${h} の行き先が無い`);
});

test('hubLink があるときは索引のリンク・表紙・題の順に並ぶ', async () => {
  const $ = await front({ type: 'proposal' }, { hubLink: { href: 'index.html' } });
  assert.deepEqual($('main.mdh-page').children().toArray().map((el) => $(el).attr('class')), ['mdh-hub-nav', 'mdh-print-front', 'mdh-title', 'mdh-doc']);
});

for (const date of ['2026-09-15', '2026-09-15T12:34:56Z']) {
  test(`AC9 編集版から書き出しても表紙が出て、日付は通常の変換と同じ（date: ${date}）`, async () => {
    const { parseMarkdownDocument } = await import('./markdown-document.mjs');
    const { markdownDocumentToEditableDocument } = await import('./markdown-to-blocks.mjs');
    const { editableDocumentToStaticHtml } = await import('./blocks-to-static-html.mjs');
    const md = `---\ntitle: T\ntype: proposal\ndate: ${date}\n---\n\n## 章\n\n本文\n`;
    const editable = JSON.parse(JSON.stringify(markdownDocumentToEditableDocument(parseMarkdownDocument(md, '/tmp/types-editable.md'), md)));
    for (const $ of [load(await editableDocumentToStaticHtml(editable)), load(await buildNotionHtmlString(md, '/tmp/types-editable.md'))]) {
      assert.equal($('.mdh-print-front').length, 1);
      assert.equal($('.mdh-cover-foot span').length, 1);
      assert.equal($('.mdh-cover-foot span').text(), '2026年9月15日');
    }
  });
}

// AC4。知らない種類だけを警告し、行は前置きの最上位のキーの type の行
const typeWarnings = async (md) => {
  const warnings = [];
  const html = await buildNotionHtmlString(md, '/tmp/types-warn.md', { onWarning: (w) => warnings.push(w) });
  return { warnings: warnings.filter((w) => w.reason === '知らない文書の種類'), $: load(html) };
};
for (const [name, md, line, marker] of [
  ['3 行目の type: memo', '---\ntitle: T\ntype: memo\n---\n\n## a\n', 3, 'type: memo'],
  ['配列の type', '---\ntitle: T\ntype: [a]\n---\n\n## a\n', 3, 'type: a'],
  ['引用符付きのキーと本文の type:', '---\ntitle: T\n"type": memo\n---\n\nbody\n\ntype: body\n', 3, 'type: memo'],
  ['前置き全体の字下げ', '---\n  title: T\n  type: memo\n---\n\nb\n', 3, 'type: memo'],
  ['入れ子のキーの後の最上位の type', '---\nother:\n  type: proposal\ntype: memo\n---\nbody\n', 4, 'type: memo'],
  ['複数行の文字列の中の type の後', '---\nnotes: |\n  type: proposal\ntype: memo\n---\nbody\n', 4, 'type: memo'],
  ['---yaml で始まる前置き', '---yaml\ntitle: Example\ntype: memo\n---\nbody\n', 3, 'type: memo'],
  ['流れの形', '---\n{title: T, type: memo}\n---\nb\n', 1, 'type: memo'],
  ['複数行の文字列の中の ---', '---\nnotes: |\n  ---\ntype: memo\n---\nbody\n', 4, 'type: memo'],
  ['先頭の BOM', '\uFEFF---\ntitle: T\ntype: memo\n---\nbody\n', 3, 'type: memo'],
  ['終わりの --- の後の注釈', '---\ntitle: T\ntype: memo\n--- # end\nbody\n', 3, 'type: memo'],
  ['終わりの --- が無い', '---\ntitle: T\ntype: memo\n', 3, 'type: memo']
]) {
  test(`AC4 知らない種類は警告 1 件（${name}）で、表紙を出さない`, async () => {
    const { warnings, $ } = await typeWarnings(md);
    assert.deepEqual(warnings.map((w) => [w.line, w.marker]), [[line, marker]]);
    assert.equal($('.mdh-print-front').length, 0);
  });
}
for (const [name, md] of [['無し', '---\ntitle: T\n---\n\n## a\n'], ['policy', '---\ntype: policy\n---\n\n## a\n'], ['proposal', '---\ntype: proposal\n---\n\n## a\n']]) {
  test(`AC4 type が ${name} なら警告しない`, async () => {
    const { warnings } = await typeWarnings(md);
    assert.equal(warnings.length, 0);
  });
}
test('AC4 onWarning を渡さなければ、知らない種類でも例外を出さない', async () => {
  await buildNotionHtmlString('---\ntype: memo\n---\n\n## a\n', '/tmp/types-warn.md');
});
