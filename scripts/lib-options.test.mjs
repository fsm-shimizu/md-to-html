import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { visit } from 'unist-util-visit';
import { buildNotionHtmlString } from './lib/build-notion.mjs';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixturesDir = path.join(root, 'mockups', 'fixtures');
const generatedDir = path.join(root, 'mockups', 'generated');

const SAMPLE = `# ハブナビ検査用ドキュメント

## 第1節

本文に [仕様書](./SPEC-foo.md) へのリンクを1つ置く。

## 第2節

もう1つの [外部リンク](https://example.com/) も置く。
`;

test('(a) hubLink オプションで main.mdh-page の第1子に nav.mdh-hub-nav が出る', async () => {
  const html = await buildNotionHtmlString(SAMPLE, path.join(fixturesDir, 'hub-nav-sample.md'), {
    hubLink: { href: './index.html', label: '索引' }
  });

  assert.ok(
    html.includes('<nav class="mdh-hub-nav"><a href="./index.html">索引</a></nav>'),
    'ハブナビの HTML 文字列がそのまま出力に含まれること'
  );

  const $ = load(html);
  const main = $('main.mdh-page');
  assert.equal(main.length, 1);

  const first = main.children().first();
  assert.equal(first.get(0).tagName, 'nav');
  assert.equal(first.attr('class'), 'mdh-hub-nav');
  assert.equal(first.find('a').attr('href'), './index.html');
  assert.equal(first.find('a').text(), '索引');

  // AC-13: .mdh-shell 直下は設定の details（中の設定ボタンとパネルは position: fixed、details 自身は position: absolute で grid に並ばない）と aside・main。grid に並ぶのは aside + main の2つ
  const shellChildren = $('.mdh-shell').children().toArray().map((el) => el.tagName);
  assert.deepEqual(shellChildren, ['details', 'aside', 'main']);
  const gridChildren = $('.mdh-shell').children().not('.mdh-settings-menu').toArray().map((el) => el.tagName);
  assert.deepEqual(gridChildren, ['aside', 'main']);
  assert.equal($('.mdh-shell > nav.mdh-hub-nav').length, 0);
});

test('(b) hastTransforms が注入した javascript: href は sanitizer に除去される', async () => {
  const poison = (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'a') return;
      node.properties ||= {};
      node.properties.href = 'javascript:alert(1)';
    });
  };

  const html = await buildNotionHtmlString(SAMPLE, path.join(fixturesDir, 'hub-nav-sample.md'), {
    hastTransforms: [poison]
  });

  assert.ok(!html.includes('javascript:'), '最終出力に javascript: が残らないこと');

  const $ = load(html);
  const anchors = $('article.mdh-doc a').toArray();
  assert.ok(anchors.length >= 2, '本文中の a 要素が存在すること（変換対象があること）');
  for (const anchor of anchors) {
    assert.equal($(anchor).attr('href'), undefined, 'sanitizer が href を落としていること');
  }
});

test('(c) options 未指定なら既存 fixture の生成物とバイト一致', async () => {
  const names = ['fixture-short', 'fixture-long', 'fixture-table-stack'];

  for (const name of names) {
    const inputPath = path.join(fixturesDir, `${name}.md`);
    const raw = await fs.readFile(inputPath, 'utf8');
    const html = await buildNotionHtmlString(raw, inputPath);
    const expected = await fs.readFile(path.join(generatedDir, `${name}.html`));
    assert.ok(Buffer.from(html, 'utf8').equals(expected), `${name}.html がバイト一致すること`);
  }
});

test('(d) hubLink.href は isSafeUrl 検査を通す（危険スキームは TypeError・文字列短縮形は不可）', async () => {
  const build = (hubLink) => buildNotionHtmlString(SAMPLE, path.join(fixturesDir, 'hub-nav-sample.md'), { hubLink });

  for (const href of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html;base64,AAAA', '//evil.example.com/index.html']) {
    await assert.rejects(() => build({ href }), /not a safe URL/, `危険な href が拒否されること: ${href}`);
  }

  // 文字列短縮形は受けない（オブジェクト型のみ。build-notion.mjs の JSDoc と一致）
  await assert.rejects(() => build('./index.html'), /must be an object/);
  await assert.rejects(() => build({ href: '' }), /non-empty href/);

  // 正常系（./index.html）は従来どおり出力される
  const ok = await build({ href: './index.html', label: '索引' });
  assert.ok(ok.includes('<nav class="mdh-hub-nav"><a href="./index.html">索引</a></nav>'));
});

test('(e) hastTransforms は rehypeEnhanceTables の後に走る（AC-6・順序の証明）', async () => {
  const markdown = `# 表の順序検査

| 列A | 列B | 列C |
|---|---|---|
| a1 | b1 | c1 |
`;

  const observed = { tableClasses: null, dataLabels: [] };
  const inspect = (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName === 'table') observed.tableClasses = node.properties?.className ?? null;
      if (node.tagName === 'td' && node.properties?.dataLabel) observed.dataLabels.push(node.properties.dataLabel);
    });
  };

  const html = await buildNotionHtmlString(markdown, path.join(fixturesDir, 'table-order-sample.md'), {
    hastTransforms: [inspect]
  });

  // transform に入った時点で既にテーブル強化が済んでいること
  assert.deepEqual(observed.tableClasses, ['mdh-stackable-table']);
  assert.deepEqual(observed.dataLabels, ['列A', '列B', '列C']);
  // 最終出力にも同じ属性が残る（transform が強化結果を壊していない）
  assert.ok(html.includes('mdh-stackable-table'));
  assert.ok(html.includes('data-label="列A"'));
});

test('(f) editable 経路の非退行（documentId 正規化＋script 除外 DOM 一致・禁止 DOM 0件）', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdh-editable-'));
  const outPath = path.join(tmpDir, 'editable-basic.html');
  try {
    // options 未指定で走る既存 editable ビルダーを子プロセスで実行（mockups/generated は汚さない）
    await execFileAsync(process.execPath, [
      path.join(root, 'scripts', 'build_editable_notion_html.mjs'),
      path.join(fixturesDir, 'editable-basic.md'),
      '--out',
      outPath
    ]);

    // 正規化: documentId（毎ビルド変わる UUID）を固定値へ、<script>（バンドル埋め込み）を除去、
    // <style> の中身は本 Task 非対象の CSS 差分（既知の生成物 stale）を除くため空にする
    const normalize = (html) => {
      const $ = load(html.replace(/(data-document-id=")[0-9a-f]{8}(")/g, '$1DOCID$2'));
      $('script').remove();
      $('style').text('');
      return $.html();
    };

    const built = await fs.readFile(outPath, 'utf8');
    const committed = await fs.readFile(path.join(generatedDir, 'editable-basic.html'), 'utf8');
    assert.equal(normalize(built), normalize(committed), 'editable の DOM が既存生成物と一致すること');

    // 禁止 DOM は実要素数で判定する（バンドル文字列中のリテラルは対象外）
    const $built = load(built);
    assert.equal($built('nav.mdh-hub-nav').length, 0);
    assert.equal($built('.mdh-external-md').length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
