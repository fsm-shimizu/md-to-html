// 仕様書セット純関数群の単体テスト（URL 判定表）
// ＋セットビルド CLI・検証スクリプトの統合テスト
// AC-14: §4.2 判定表の全行に最低1ケース。テスト名の「判定表 行N」で行との対応を可視化する。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

import { buildSetIndex, rewriteSpecLinks, rebaseRelativeUrl, buildHubModel, findCaseCollisions } from './lib/spec-set.mjs';
import { describeSetIndexError, SET_INDEX_ERROR_HINTS } from './build_spec_set.mjs';
import { validateSpecSetDir, resolveHtmlDir } from './validate_spec_set.mjs';

// ---------------------------------------------------------------------------
// fixture（実 FS。setIndex 導出とリンク実在判定が FS を読むため）
// ---------------------------------------------------------------------------
// <root>/spec/                     ← setDir
//   README.md / REQUIREMENT-baz.md / SPEC-foo.md / PLAN-bar.md / guide.md
//   note space.md                  ← percent-encoded リンクの突合用
//   LINKED.md -> ../outside/EXTERNAL.md（symlink・realpath がセット外）
//   img/diagram.png                ← 相対非 .md（画像）
//   attach/spec.txt                ← 相対非 .md（添付）
//   sub/INNER.md                   ← サブディレクトリ .md（N-6: セット外扱い）
// <root>/outside/EXTERNAL.md       ← セット外の実在 .md
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-specset-'));
const setDir = path.join(root, 'spec');
const outsideDir = path.join(root, 'outside');

fs.mkdirSync(setDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
fs.mkdirSync(path.join(setDir, 'img'), { recursive: true });
fs.mkdirSync(path.join(setDir, 'attach'), { recursive: true });
fs.mkdirSync(path.join(setDir, 'sub'), { recursive: true });

for (const name of ['README.md', 'REQUIREMENT-baz.md', 'SPEC-foo.md', 'PLAN-bar.md', 'guide.md', 'note space.md']) {
  fs.writeFileSync(path.join(setDir, name), `# ${name}\n`);
}
fs.writeFileSync(path.join(outsideDir, 'EXTERNAL.md'), '# external\n');
fs.writeFileSync(path.join(setDir, 'sub', 'INNER.md'), '# inner\n');
fs.writeFileSync(path.join(setDir, 'img', 'diagram.png'), 'png');
fs.writeFileSync(path.join(setDir, 'attach', 'spec.txt'), 'txt');
fs.symlinkSync(path.join(outsideDir, 'EXTERNAL.md'), path.join(setDir, 'LINKED.md'));

// 大文字小文字を区別しない FS（macOS 既定）では case 衝突 fixture を作れないため実行時判定する
const caseSensitiveFs = (() => {
  const probe = path.join(root, 'CaseProbe.tmp');
  fs.writeFileSync(probe, 'x');
  const insensitive = fs.existsSync(path.join(root, 'caseprobe.tmp'));
  fs.rmSync(probe, { force: true });
  return !insensitive;
})();

after(() => fs.rmSync(root, { recursive: true, force: true }));

const setIndex = buildSetIndex(setDir);
const currentDoc = setIndex.docs.find((doc) => doc.basename === 'README.md');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function el(tagName, properties, children = [], line = 7) {
  return {
    type: 'element',
    tagName,
    properties,
    children,
    position: { start: { line, column: 1, offset: 0 }, end: { line, column: 20, offset: 20 } }
  };
}

function anchor(href, line = 7) {
  return el('a', { href }, [{ type: 'text', value: 'ラベル' }], line);
}

function image(src, line = 11) {
  return el('img', { src, alt: '図' }, [], line);
}

function run(node, options = {}) {
  const diagnostics = [];
  const tree = { type: 'root', children: [el('p', {}, [node])] };
  rewriteSpecLinks(tree, { setIndex, currentDoc, diagnostics, ...options });
  return { tree, node, diagnostics };
}

const errorsOf = (diagnostics) => diagnostics.filter((d) => d.severity === 'error');
const warningsOf = (diagnostics) => diagnostics.filter((d) => d.severity === 'warning');

// ---------------------------------------------------------------------------
// buildSetIndex
// ---------------------------------------------------------------------------
test('buildSetIndex: setDir 直下の *.md のみを再帰なしで採録する', () => {
  const names = setIndex.docs.map((doc) => doc.basename).sort();
  assert.deepEqual(names, ['PLAN-bar.md', 'README.md', 'REQUIREMENT-baz.md', 'SPEC-foo.md', 'guide.md', 'note space.md']);
});

test('buildSetIndex: outName は stem + .html', () => {
  const doc = setIndex.docs.find((d) => d.basename === 'SPEC-foo.md');
  assert.equal(doc.outName, 'SPEC-foo.html');
  assert.equal(doc.inputPath, path.join(setDir, 'SPEC-foo.md'));
});

test('buildSetIndex: dotfile と非 .md と サブディレクトリを除外する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-specset-filter-'));
  fs.writeFileSync(path.join(dir, 'SPEC-a.md'), '# a\n');
  fs.writeFileSync(path.join(dir, '.hidden.md'), '# h\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'nested.md'));
  const index = buildSetIndex(dir);
  assert.deepEqual(index.docs.map((d) => d.basename), ['SPEC-a.md']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSetIndex: 拡張子判定は小文字化後（.MD を採録する）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-specset-ext-'));
  fs.writeFileSync(path.join(dir, 'SPEC-UPPER.MD'), '# a\n');
  const index = buildSetIndex(dir);
  assert.deepEqual(index.docs.map((d) => d.basename), ['SPEC-UPPER.MD']);
  assert.equal(index.docs[0].outName, 'SPEC-UPPER.html');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSetIndex: セットが空なら fail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-specset-empty-'));
  assert.throws(() => buildSetIndex(dir), (err) => err.code === 'SPEC_SET_EMPTY');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSetIndex: index.md 同梱は fail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-specset-index-'));
  fs.writeFileSync(path.join(dir, 'SPEC-a.md'), '# a\n');
  fs.writeFileSync(path.join(dir, 'index.md'), '# i\n');
  assert.throws(() => buildSetIndex(dir), (err) => err.code === 'SPEC_SET_INDEX_MD');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findCaseCollisions: 大文字小文字違いの衝突を配列入力だけで検出する（FS 非依存）', () => {
  assert.deepEqual(findCaseCollisions(['SPEC-a.md', 'spec-a.md']), [
    { key: 'spec-a.md', first: 'SPEC-a.md', second: 'spec-a.md' }
  ]);
  assert.deepEqual(findCaseCollisions(['README.md', 'SPEC-a.md', 'PLAN-b.md']), []);
  assert.deepEqual(findCaseCollisions([]), []);
  assert.equal(findCaseCollisions(['A.md', 'a.md', 'B.MD', 'b.md']).length, 2);
});

test('buildSetIndex: basename の大文字小文字違い衝突は fail', { skip: caseSensitiveFs ? false : '大文字小文字を区別しない FS のため fixture を作成できない（分岐自体は findCaseCollisions のテストで常時検査）' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-specset-case-'));
  fs.writeFileSync(path.join(dir, 'SPEC-a.md'), '# a\n');
  fs.writeFileSync(path.join(dir, 'spec-a.md'), '# b\n');
  assert.throws(() => buildSetIndex(dir), (err) => err.code === 'SPEC_SET_CASE_COLLISION');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSetIndex: realpath がセット外へ脱出する symlink .md はセット外扱いで除外する', () => {
  assert.equal(setIndex.docs.some((doc) => doc.basename === 'LINKED.md'), false);
});

test('buildSetIndex: docs に title を持つ（frontmatter → H1 → ファイル名）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-specset-title-'));
  fs.writeFileSync(path.join(dir, 'SPEC-front.md'), '---\ntitle: 前置きタイトル\n---\n\n# 別見出し\n');
  fs.writeFileSync(path.join(dir, 'SPEC-h1.md'), '# H1 タイトル\n\n本文\n');
  fs.writeFileSync(path.join(dir, 'no_title.md'), '本文のみ\n');
  const index = buildSetIndex(dir);
  const titleOf = (basename) => index.docs.find((doc) => doc.basename === basename).title;
  assert.equal(titleOf('SPEC-front.md'), '前置きタイトル');
  assert.equal(titleOf('SPEC-h1.md'), 'H1 タイトル');
  assert.equal(titleOf('no_title.md'), 'no title'); // parseMarkdownDocument のファイル名 fallback
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSetIndex → buildHubModel: 索引ハブは docs の title を表示に使う', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-specset-hubtitle-'));
  fs.writeFileSync(path.join(dir, 'SPEC-foo.md'), '# 仕様書（実物）\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# 読みもの\n');
  const model = buildHubModel(buildSetIndex(dir).docs);
  assert.deepEqual(model.items.map((item) => [item.href, item.title]), [
    ['./README.html', '読みもの'],
    ['./SPEC-foo.html', '仕様書（実物）']
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 判定表 行1: 相対 .md・setIndex 所属 → ./X.html（query/fragment 保持）
// ---------------------------------------------------------------------------
test('判定表 行1: 相対 .md・setIndex 所属 → ./X.html へ書換（a[href]）', () => {
  const { node, diagnostics } = run(anchor('./SPEC-foo.md'));
  assert.equal(node.tagName, 'a');
  assert.equal(node.properties.href, './SPEC-foo.html');
  assert.deepEqual(diagnostics, []);
});

test('判定表 行1: 相対 .md・setIndex 所属 → ディレクトリ記法なしでも書換', () => {
  const { node } = run(anchor('PLAN-bar.md'));
  assert.equal(node.properties.href, './PLAN-bar.html');
});

test('判定表 行1: 正規化後に所属判定する（./a/../SPEC-foo.md）', () => {
  const { node, diagnostics } = run(anchor('./sub/../SPEC-foo.md'));
  assert.equal(node.properties.href, './SPEC-foo.html');
  assert.deepEqual(diagnostics, []);
});

test('判定表 行1: query と fragment を原文どおり保持する', () => {
  const { node } = run(anchor('./SPEC-foo.md?v=2#4-2-リンク書換'));
  assert.equal(node.properties.href, './SPEC-foo.html?v=2#4-2-リンク書換');
});

test('判定表 行1: percent-encoded なファイル名も1回 decode して所属判定する', () => {
  const { node, diagnostics } = run(anchor('./note%20space.md#x'));
  assert.equal(node.properties.href, './note%20space.html#x');
  assert.deepEqual(diagnostics, []);
});

test('判定表 行1: セット所属 .md を img[src] が指す場合も fail（所属を問わず img-md）', () => {
  const { node, diagnostics } = run(image('./SPEC-foo.md'));
  const errors = errorsOf(diagnostics);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'img-md');
  assert.equal(errors[0].url, './SPEC-foo.md');
  assert.equal(errors[0].file, currentDoc.inputPath);
  assert.equal(errors[0].line, 11);
  assert.equal(node.properties.src, './SPEC-foo.md'); // fail 診断のみ・DOM は書き換えない
});

// ---------------------------------------------------------------------------
// 判定表 行2: 相対 .md・setIndex 非所属・FS 実在
// ---------------------------------------------------------------------------
test('判定表 行2: セット外実在 .md の a[href] は span.mdh-external-md へ置換＋warning', () => {
  const { node, diagnostics } = run(anchor('../outside/EXTERNAL.md'));
  assert.equal(node.tagName, 'span');
  assert.deepEqual(node.properties.className, ['mdh-external-md']);
  assert.equal(node.properties.title, '../outside/EXTERNAL.md');
  assert.equal('href' in node.properties, false);
  assert.deepEqual(node.children, [{ type: 'text', value: 'ラベル' }]);
  assert.equal(warningsOf(diagnostics).length, 1);
  assert.equal(errorsOf(diagnostics).length, 0);
  assert.equal(warningsOf(diagnostics)[0].kind, 'external-md');
  assert.equal(warningsOf(diagnostics)[0].url, '../outside/EXTERNAL.md');
  assert.equal(warningsOf(diagnostics)[0].file, currentDoc.inputPath);
  assert.equal(warningsOf(diagnostics)[0].line, 7);
});

test('判定表 行2: セット外の .md へのリンク付きカードは div.mdh-card の通常のカードになる', () => {
  const card = el('a', { className: ['mdh-card', 'mdh-card-link'], href: '../outside/EXTERNAL.md' }, [
    el('svg', { className: ['mdh-card-icon'], ariaHidden: 'true' }),
    el('p', { className: ['mdh-card-title'] }, [{ type: 'text', value: '外の文書' }]),
    el('div', { className: ['mdh-card-body'] }, [el('p', {}, [{ type: 'text', value: '本文' }])])
  ]);
  const { diagnostics } = run(card);
  assert.equal(card.tagName, 'div');
  assert.deepEqual(card.properties.className, ['mdh-card']);
  assert.equal('href' in card.properties, false);
  assert.deepEqual(card.children.map((c) => `${c.tagName}.${c.properties.className.join('.')}`), ['p.mdh-card-title', 'div.mdh-card-body']);
  const span = card.children[0].children[0];
  assert.equal(span.tagName, 'span');
  assert.deepEqual(span.properties, { className: ['mdh-external-md'], title: '../outside/EXTERNAL.md' });
  assert.deepEqual(span.children, [{ type: 'text', value: '外の文書' }]);
  assert.deepEqual(warningsOf(diagnostics).map((d) => d.kind), ['external-md']);
});

test('判定表 行2: サブディレクトリ内の実在 .md もセット外扱い（N-6）', () => {
  const { node, diagnostics } = run(anchor('./sub/INNER.md'));
  assert.equal(node.tagName, 'span');
  assert.equal(warningsOf(diagnostics).length, 1);
  assert.equal(errorsOf(diagnostics).length, 0);
});

test('判定表 行2: symlink でセット外を指す .md もセット外扱い（realpath 封じ込め判定）', () => {
  const { node, diagnostics } = run(anchor('./LINKED.md'));
  assert.equal(node.tagName, 'span');
  assert.equal(warningsOf(diagnostics).length, 1);
});

test('判定表 行2: img[src] が .md を指す場合は build fail', () => {
  const { diagnostics } = run(image('../outside/EXTERNAL.md'));
  const errors = errorsOf(diagnostics);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'img-md');
  assert.equal(errors[0].url, '../outside/EXTERNAL.md');
  assert.equal(errors[0].file, currentDoc.inputPath);
  assert.equal(errors[0].line, 11);
});

// ---------------------------------------------------------------------------
// 判定表 行3: 相対 .md・FS 上に不在 → fail
// ---------------------------------------------------------------------------
test('判定表 行3: 相対 .md が FS 上に不在なら fail（file・line・url を列挙）', () => {
  const { node, diagnostics } = run(anchor('./SPEC-missing.md', 42));
  const errors = errorsOf(diagnostics);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'missing-md');
  assert.equal(errors[0].file, currentDoc.inputPath);
  assert.equal(errors[0].line, 42);
  assert.equal(errors[0].url, './SPEC-missing.md');
  assert.equal(node.tagName, 'a'); // fail 診断のみ・DOM は変更しない
});

test('判定表 行3: セット外パスの不在 .md も fail', () => {
  const { diagnostics } = run(anchor('../outside/NOPE.md'));
  assert.equal(errorsOf(diagnostics).length, 1);
  assert.equal(errorsOf(diagnostics)[0].kind, 'missing-md');
});

// ---------------------------------------------------------------------------
// 判定表 行4: fragment のみ → 素通し
// ---------------------------------------------------------------------------
test('判定表 行4: fragment のみ（#section）は素通し', () => {
  const { node, diagnostics } = run(anchor('#4-2-リンク書換'));
  assert.equal(node.properties.href, '#4-2-リンク書換');
  assert.deepEqual(diagnostics, []);
});

// ---------------------------------------------------------------------------
// 判定表 行5: root 相対 → 素通し＋warning
// ---------------------------------------------------------------------------
test('判定表 行5: root 相対（/docs/…）は素通し＋warning', () => {
  const { node, diagnostics } = run(anchor('/docs/spec/SPEC-foo.md'));
  assert.equal(node.properties.href, '/docs/spec/SPEC-foo.md');
  assert.equal(node.tagName, 'a');
  assert.equal(warningsOf(diagnostics).length, 1);
  assert.equal(errorsOf(diagnostics).length, 0);
  assert.equal(warningsOf(diagnostics)[0].kind, 'root-relative');
});

test('判定表 行5: img[src] の root 相対も素通し＋warning', () => {
  const { node, diagnostics } = run(image('/assets/a.png'));
  assert.equal(node.properties.src, '/assets/a.png');
  assert.equal(warningsOf(diagnostics).length, 1);
  assert.equal(warningsOf(diagnostics)[0].kind, 'root-relative');
});

// ---------------------------------------------------------------------------
// 判定表 行6: 外部 URL・mailto: 等 → 素通し
// ---------------------------------------------------------------------------
test('判定表 行6: 外部 URL・mailto: 等は素通し（既存 sanitize に委ねる）', () => {
  for (const url of ['https://example.com/a.md', 'http://example.com/', 'mailto:a@b.com', 'tel:+81-3-0000-0000', '//example.com/a.png']) {
    const { node, diagnostics } = run(anchor(url));
    assert.equal(node.properties.href, url, url);
    assert.deepEqual(diagnostics, [], url);
  }
});

test('判定表 行6: javascript: も書換対象外で素通しする（除去は後段の sanitizer）', () => {
  const { node, diagnostics } = run(anchor('javascript:alert(1)'));
  assert.equal(node.properties.href, 'javascript:alert(1)');
  assert.deepEqual(diagnostics, []);
});

// ---------------------------------------------------------------------------
// 判定表 行7: 相対の非 .md → rebaseRelativeUrl で html/ 基準へ再基準化（不在は fail）
// ---------------------------------------------------------------------------
test('判定表 行7: img[src] の相対画像を html/ 基準へ再基準化する', () => {
  const { node, diagnostics } = run(image('./img/diagram.png'));
  assert.equal(node.properties.src, '../img/diagram.png');
  assert.deepEqual(diagnostics, []);
});

test('判定表 行7: a[href] の相対添付（非 .md）も再基準化する', () => {
  const { node, diagnostics } = run(anchor('./attach/spec.txt#page=2'));
  assert.equal(node.properties.href, '../attach/spec.txt#page=2');
  assert.deepEqual(diagnostics, []);
});

test('判定表 行7: 相対の非 .md が FS 上に不在なら fail', () => {
  const { diagnostics } = run(image('./img/missing.png', 23));
  const errors = errorsOf(diagnostics);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'missing-asset');
  assert.equal(errors[0].line, 23);
  assert.equal(errors[0].url, './img/missing.png');
});

// ---------------------------------------------------------------------------
// percent-encoding の正規化
// ---------------------------------------------------------------------------
test('percent: %2F… は decode 後に root 相対と判定して素通し＋warning（再基準化しない）', () => {
  const { node, diagnostics } = run(anchor('%2Fetc%2Fhosts'));
  assert.equal(node.properties.href, '%2Fetc%2Fhosts');
  assert.equal(node.tagName, 'a');
  assert.equal(warningsOf(diagnostics).length, 1);
  assert.equal(warningsOf(diagnostics)[0].kind, 'root-relative');
  assert.equal(errorsOf(diagnostics).length, 0);
});

test('percent: img[src] の %2F… も root 相対扱い（src を書き換えない）', () => {
  const { node, diagnostics } = run(image('%2Fetc%2Fpasswd.png'));
  assert.equal(node.properties.src, '%2Fetc%2Fpasswd.png');
  assert.equal(warningsOf(diagnostics)[0].kind, 'root-relative');
});

test('percent: %2e%2e%2f のトラバーサルは decode 後に封じ込め判定される（セット外 .md 扱い）', () => {
  const { node, diagnostics } = run(anchor('%2e%2e%2foutside%2fEXTERNAL.md'));
  assert.equal(node.tagName, 'span'); // セット外実在 .md としてリンク解除
  assert.deepEqual(node.properties.className, ['mdh-external-md']);
  assert.equal(warningsOf(diagnostics).length, 1);
  assert.equal(warningsOf(diagnostics)[0].kind, 'external-md');
  assert.equal(errorsOf(diagnostics).length, 0);
});

test('percent: %2e%2e%2f で外へ出た先の不在 .md は fail（封じ込め判定後に実在検査）', () => {
  const { diagnostics } = run(anchor('%2e%2e%2foutside%2fNOPE.md'));
  assert.equal(errorsOf(diagnostics).length, 1);
  assert.equal(errorsOf(diagnostics)[0].kind, 'missing-md');
});

test('percent: 二重エンコード（%2520）は decode を1回に留めるため不在 fail になる', () => {
  const { diagnostics } = run(anchor('./note%2520space.md'));
  assert.equal(errorsOf(diagnostics).length, 1);
  assert.equal(errorsOf(diagnostics)[0].kind, 'missing-md');
  assert.equal(errorsOf(diagnostics)[0].url, './note%2520space.md');
});

test('percent: 壊れた % は decodeURIComponent 例外を落とさず原文で判定する', () => {
  assert.doesNotThrow(() => run(anchor('./bad%zz.md')));
  const { diagnostics } = run(anchor('./bad%zz.md'));
  assert.equal(errorsOf(diagnostics).length, 1);
  assert.equal(errorsOf(diagnostics)[0].kind, 'missing-md');
});

test('percent: 壊れた % を含む実在ファイル参照も例外にせず処理する（非 .md）', () => {
  assert.doesNotThrow(() => run(image('./img/%zz.png')));
  const { diagnostics } = run(image('./img/%zz.png'));
  assert.equal(errorsOf(diagnostics)[0].kind, 'missing-asset');
});

test('rebaseRelativeUrl: percent-encoded な root 相対・scheme は decode 後判定で素通しする', () => {
  const htmlDir = path.join(setDir, 'html');
  assert.equal(rebaseRelativeUrl('%2Fetc%2Fhosts', setDir, htmlDir), '%2Fetc%2Fhosts');
  assert.equal(rebaseRelativeUrl('mailto%3Aa@b.com', setDir, htmlDir), 'mailto%3Aa@b.com');
});

// ---------------------------------------------------------------------------
// 走査対象・診断の一般契約
// ---------------------------------------------------------------------------
test('rewriteSpecLinks: a[href] と img[src] の両方を走査する（N-3）', () => {
  const diagnostics = [];
  const a = anchor('./SPEC-foo.md');
  const img = image('./img/diagram.png');
  const tree = { type: 'root', children: [el('p', {}, [a, img])] };
  rewriteSpecLinks(tree, { setIndex, currentDoc, diagnostics });
  assert.equal(a.properties.href, './SPEC-foo.html');
  assert.equal(img.properties.src, '../img/diagram.png');
});

test('rewriteSpecLinks: href を持たない要素・他属性は触らない', () => {
  const diagnostics = [];
  const anchorNoHref = el('a', { id: 'x' }, [{ type: 'text', value: 'x' }]);
  const div = el('div', { dataUrl: './SPEC-foo.md' }, []);
  const tree = { type: 'root', children: [anchorNoHref, div] };
  rewriteSpecLinks(tree, { setIndex, currentDoc, diagnostics });
  assert.equal(anchorNoHref.tagName, 'a');
  assert.equal(div.properties.dataUrl, './SPEC-foo.md');
  assert.deepEqual(diagnostics, []);
});

test('rewriteSpecLinks: 診断は {file,line,url,kind} を持つ（H-2 の列挙契約）', () => {
  const { diagnostics } = run(anchor('./SPEC-missing.md', 3));
  assert.deepEqual(Object.keys(diagnostics[0]).sort().filter((k) => ['file', 'kind', 'line', 'url'].includes(k)), ['file', 'kind', 'line', 'url']);
});

test('rewriteSpecLinks: tree を返し diagnostics を積み上げる（複数件）', () => {
  const diagnostics = [];
  const tree = {
    type: 'root',
    children: [el('p', {}, [anchor('./SPEC-missing.md', 2), anchor('/docs/x.md', 3), anchor('../outside/EXTERNAL.md', 4)])]
  };
  const returned = rewriteSpecLinks(tree, { setIndex, currentDoc, diagnostics });
  assert.equal(returned, tree);
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(diagnostics.map((d) => d.line), [2, 3, 4]);
});

// ---------------------------------------------------------------------------
// rebaseRelativeUrl
// ---------------------------------------------------------------------------
test('rebaseRelativeUrl: html/ へ1階層下がる分を ../ で補正する', () => {
  assert.equal(rebaseRelativeUrl('./img/a.png', setDir, path.join(setDir, 'html')), '../img/a.png');
  assert.equal(rebaseRelativeUrl('img/a.png', setDir, path.join(setDir, 'html')), '../img/a.png');
  assert.equal(rebaseRelativeUrl('../shared/a.png', setDir, path.join(setDir, 'html')), '../../shared/a.png');
});

test('rebaseRelativeUrl: query・fragment を保持する', () => {
  assert.equal(rebaseRelativeUrl('./img/a.png?v=1#f', setDir, path.join(setDir, 'html')), '../img/a.png?v=1#f');
});

test('rebaseRelativeUrl: 同一ディレクトリなら ./ 形へ正規化する', () => {
  assert.equal(rebaseRelativeUrl('./a.png', setDir, setDir), './a.png');
  assert.equal(rebaseRelativeUrl('a.png', setDir, setDir), './a.png');
});

test('rebaseRelativeUrl: 相対でない URL は素通し', () => {
  for (const url of ['#f', '/root/a.png', 'https://example.com/a.png', 'mailto:a@b.com', '//example.com/a.png']) {
    assert.equal(rebaseRelativeUrl(url, setDir, path.join(setDir, 'html')), url, url);
  }
});

test('rebaseRelativeUrl: 空文字・非文字列は素通し', () => {
  assert.equal(rebaseRelativeUrl('', setDir, path.join(setDir, 'html')), '');
  assert.equal(rebaseRelativeUrl(null, setDir, path.join(setDir, 'html')), null);
});

// ---------------------------------------------------------------------------
// buildHubModel
// ---------------------------------------------------------------------------
const hubDocs = [
  { basename: 'guide.md', outName: 'guide.html', title: '運用ガイド' },
  { basename: 'PLAN-bar.md', outName: 'PLAN-bar.html', title: 'PLAN bar' },
  { basename: 'SPEC-foo.md', outName: 'SPEC-foo.html', title: 'SPEC foo' },
  { basename: 'appendix.md', outName: 'appendix.html', title: '付録' },
  { basename: 'REQUIREMENT-baz.md', outName: 'REQUIREMENT-baz.html', title: 'REQ baz' },
  { basename: 'README.md', outName: 'README.html', title: '読みもの' }
];

test('buildHubModel: README→REQUIREMENT→SPEC→PLAN→その他ファイル名昇順に並べる', () => {
  const model = buildHubModel(hubDocs);
  assert.deepEqual(model.items.map((item) => item.basename), [
    'README.md',
    'REQUIREMENT-baz.md',
    'SPEC-foo.md',
    'PLAN-bar.md',
    'appendix.md',
    'guide.md'
  ]);
});

test('buildHubModel: プレフィクス一致は大文字小文字を無視する', () => {
  const model = buildHubModel([
    { basename: 'zzz.md', outName: 'zzz.html', title: 'z' },
    { basename: 'spec-lower.md', outName: 'spec-lower.html', title: 's' },
    { basename: 'readme.md', outName: 'readme.html', title: 'r' }
  ]);
  assert.deepEqual(model.items.map((i) => i.basename), ['readme.md', 'spec-lower.md', 'zzz.md']);
});

test('buildHubModel: href は ./<outName>', () => {
  const model = buildHubModel(hubDocs);
  assert.equal(model.items[0].href, './README.html');
  assert.equal(model.items[2].href, './SPEC-foo.html');
});

test('buildHubModel: title 未設定なら stem をタイトルに使う', () => {
  const model = buildHubModel([{ basename: 'SPEC-foo.md', outName: 'SPEC-foo.html' }]);
  assert.equal(model.items[0].title, 'SPEC-foo');
});

test('buildHubModel: 入力配列を破壊しない（純関数）', () => {
  const input = hubDocs.slice();
  buildHubModel(input);
  assert.deepEqual(input.map((d) => d.basename), hubDocs.map((d) => d.basename));
});

// ===========================================================================
// セットビルド CLI・検証スクリプトの統合テスト（Task 3）
// 実行契約 / 索引ハブ / ハブナビ / 検査
// AC-1・AC-2・AC-3・AC-4・AC-5・AC-7・AC-8・AC-12・AC-13・AC-15
// ===========================================================================
const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(here, '..');
const fixturesRoot = path.join(toolRoot, 'mockups', 'fixtures');
const buildCli = path.join(toolRoot, 'scripts', 'build_spec_set.mjs');
const validateCli = path.join(toolRoot, 'scripts', 'validate_spec_set.mjs');
const notionValidateCli = path.join(toolRoot, 'scripts', 'validate_notion_html.mjs');
const MARKER = '.mdh-spec-set';

const tempRoots = [];
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

// fixture は必ず一時ディレクトリへ複製してから使う（リポジトリ内 fixture を生成物で汚さない）。
// 手元で `node scripts/build_spec_set.mjs mockups/fixtures/spec-set-valid` を叩くと fixture 直下に
// 生成物が残る（.gitignore 済み）ため、複製時に build 管理下のディレクトリを除外して入力を素の状態に揃える。
const BUILD_ARTIFACTS = new Set(['html', '.html.tmp', '.html.old', '.spec-set.lock']);

function copyFixture(name) {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), `mdh-${name}-`));
  tempRoots.push(holder);
  const source = path.join(fixturesRoot, name);
  const dest = path.join(holder, name);
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (src) => !(path.dirname(src) === source && BUILD_ARTIFACTS.has(path.basename(src)))
  });
  return dest;
}

async function runNode(script, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const buildSet = (setDir) => runNode(buildCli, [setDir]);
const validateSet = (dir) => runNode(validateCli, [dir]);

function htmlNamesOf(htmlDir) {
  return fs.readdirSync(htmlDir).filter((name) => name.endsWith('.html')).sort();
}

function snapshotDir(dir) {
  const snapshot = new Map();
  for (const name of fs.readdirSync(dir).sort()) {
    snapshot.set(name, fs.readFileSync(path.join(dir, name)));
  }
  return snapshot;
}

function assertSameSnapshot(before, after_, label) {
  assert.deepEqual([...after_.keys()], [...before.keys()], `${label}: ファイル一覧が同一であること`);
  for (const [name, buffer] of before) {
    assert.ok(buffer.equals(after_.get(name)), `${label}: ${name} がバイト同一であること`);
  }
}

// ---------------------------------------------------------------------------
// AC-1 / AC-13（DOM）
// ---------------------------------------------------------------------------
test('AC-1: 正常セットのビルドで文書数+1 の html が出て相互リンクが .html に解決する', async () => {
  const setDir = copyFixture('spec-set-valid');
  const result = await buildSet(setDir);
  assert.equal(result.code, 0, result.stderr);

  const htmlDir = path.join(setDir, 'html');
  assert.deepEqual(htmlNamesOf(htmlDir), [
    'PLAN-view.html',
    'README.html',
    'REQUIREMENT-view.html',
    'SPEC-view.html',
    'guide.html',
    'index.html'
  ]);
  assert.ok(fs.existsSync(path.join(htmlDir, MARKER)), 'マーカーファイルが置かれること');

  const $ = load(fs.readFileSync(path.join(htmlDir, 'SPEC-view.html'), 'utf8'));
  // 非 ASCII の fragment/query は mdast-util-to-hast の normalizeUri が percent-encode する（単一文書ビルドと同じ既存挙動）。
  // 「原文どおり保持」はセット側が suffix を書き換えないことを指すので、比較は decode 後の形で行う。
  const hrefs = $('article.mdh-doc a')
    .toArray()
    .map((el) => $(el).attr('href'))
    .map((href) => {
      try {
        return href === undefined ? href : decodeURI(href);
      } catch {
        return href;
      }
    });
  assert.ok(hrefs.includes('./README.html'), hrefs.join(' | '));
  assert.ok(hrefs.includes('./REQUIREMENT-view.html'));
  assert.ok(hrefs.includes('./PLAN-view.html#手順'), 'fragment が保持されること');
  assert.ok(hrefs.includes('./guide.html?v=2#補足'), 'query と fragment が保持されること');
  assert.ok(hrefs.includes('#構成図'), '同一ページ内リンクは素通しされること');
  assert.ok(hrefs.includes('https://example.com/'), '外部 URL は素通しされること');
  assert.equal(hrefs.filter((href) => href?.endsWith('.md')).length, 0, '.md を指す a[href] が残らないこと');
  assert.equal($('.mdh-external-md').length, 0, 'valid セットではリンク解除が発生しないこと');
});

test('AC-1: 全ページの main 第1子が nav.mdh-hub-nav で index.html を指す', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');

  for (const name of htmlNamesOf(htmlDir)) {
    const $ = load(fs.readFileSync(path.join(htmlDir, name), 'utf8'));
    const first = $('main.mdh-page').children().first();
    assert.equal(first.get(0)?.tagName, 'nav', `${name}: main の第1子が nav であること`);
    assert.equal(first.attr('class'), 'mdh-hub-nav', name);
    assert.equal(first.find('a').attr('href'), './index.html', name);
  }
});

test('AC-13: セット出力の .mdh-shell 直接子は設定の details・aside・main（grid に並ぶのは aside・main）', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');

  for (const name of htmlNamesOf(htmlDir)) {
    const $ = load(fs.readFileSync(path.join(htmlDir, name), 'utf8'));
    const children = $('.mdh-shell').children().toArray().map((el) => el.tagName);
    assert.deepEqual(children, ['details', 'aside', 'main'], name);
    const gridChildren = $('.mdh-shell').children().not('.mdh-settings-menu').toArray().map((el) => el.tagName);
    assert.deepEqual(gridChildren, ['aside', 'main'], name);
    assert.equal($('.mdh-shell > nav.mdh-hub-nav').length, 0, name);
  }
});

test('AC-1: 索引ハブは README→REQUIREMENT→SPEC→PLAN→その他の順に全文書を列挙する', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);

  const $ = load(fs.readFileSync(path.join(setDir, 'html', 'index.html'), 'utf8'));
  const links = $('article.mdh-doc a').toArray().map((el) => $(el).attr('href'));
  assert.deepEqual(links, [
    './README.html',
    './REQUIREMENT-view.html',
    './SPEC-view.html',
    './PLAN-view.html',
    './guide.html'
  ]);
  assert.equal($('header.mdh-title h1').text().trim(), 'spec-set-valid', 'H1 はセット名');
});

// ---------------------------------------------------------------------------
// AC-2（冪等）
// ---------------------------------------------------------------------------
test('AC-2: 再実行しても exit 0 で生成物がバイト同一（冪等）', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const before = snapshotDir(path.join(setDir, 'html'));

  assert.equal((await buildSet(setDir)).code, 0);
  assertSameSnapshot(before, snapshotDir(path.join(setDir, 'html')), '再実行');

  // 一時領域・lock の残骸が無いこと
  assert.equal(fs.existsSync(path.join(setDir, '.html.tmp')), false);
  assert.equal(fs.existsSync(path.join(setDir, '.html.old')), false);
  assert.equal(fs.existsSync(path.join(setDir, '.spec-set.lock')), false);
});

// ---------------------------------------------------------------------------
// AC-3（画像・添付の再基準化）
// ---------------------------------------------------------------------------
test('AC-3: 画像と添付の相対参照が html/ 基準へ再基準化され FS 上で解決する', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');

  const $ = load(fs.readFileSync(path.join(htmlDir, 'SPEC-view.html'), 'utf8'));
  const src = $('article.mdh-doc img').attr('src');
  assert.equal(src, '../img/diagram.svg');
  assert.ok(fs.existsSync(path.resolve(htmlDir, src)), '画像が html/ 基準で解決すること');

  const attach = $('article.mdh-doc a').toArray().map((el) => $(el).attr('href')).find((href) => href?.endsWith('notes.txt'));
  assert.equal(attach, '../attach/notes.txt');
  assert.ok(fs.existsSync(path.resolve(htmlDir, attach)), '添付が html/ 基準で解決すること');
});

// ---------------------------------------------------------------------------
// AC-4（fail 3系・原因別に独立）
// ---------------------------------------------------------------------------
test('AC-4(a): 不在リンクの fixture は exit 非0 で file/line/url を列挙する', async () => {
  const setDir = copyFixture('spec-set-fail-missing');
  const result = await buildSet(setDir);
  assert.notEqual(result.code, 0);

  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /SPEC-missing\.md/, 'file が列挙されること');
  assert.match(output, /\.\/PLAN-nope\.md/, 'url が列挙されること');
  assert.match(output, /:\s*6|:6|行\s*6|line\s*6/, 'line が列挙されること');
  assert.match(output, /missing-md/);

  assert.equal(fs.existsSync(path.join(setDir, 'html')), false, 'fail 時に html/ を作らないこと');
  assert.equal(fs.existsSync(path.join(setDir, '.html.tmp')), false, '一時領域を掃除すること');
  assert.equal(fs.existsSync(path.join(setDir, '.spec-set.lock')), false, 'lock を解放すること');
});

test('AC-4(b): index.md 同梱の fixture は exit 非0', async () => {
  const setDir = copyFixture('spec-set-fail-index');
  const result = await buildSet(setDir);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /index\.md/);
  assert.equal(fs.existsSync(path.join(setDir, 'html')), false);
  assert.equal(fs.existsSync(path.join(setDir, '.spec-set.lock')), false);
});

test(
  'AC-4(c): basename の大文字小文字違い衝突は exit 非0',
  { skip: caseSensitiveFs ? false : '大文字小文字を区別しない FS のため衝突 fixture を実体化できない（文言・分岐は FS 非依存テストで常時検査）' },
  async () => {
    const setDir = copyFixture('spec-set-fail-case');
    fs.writeFileSync(path.join(setDir, 'spec-a.md'), '# 衝突相手（ランタイム生成）\n');
    const result = await buildSet(setDir);
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}${result.stderr}`, /大文字小文字|case/i);
    assert.equal(fs.existsSync(path.join(setDir, 'html')), false);
  }
);

test('AC-4(c): buildSetIndex の全 fail コードが CLI メッセージへ変換される（FS 非依存）', () => {
  for (const code of ['SPEC_SET_DIR_NOT_FOUND', 'SPEC_SET_EMPTY', 'SPEC_SET_INDEX_MD', 'SPEC_SET_CASE_COLLISION']) {
    assert.equal(typeof SET_INDEX_ERROR_HINTS[code], 'string', `${code} のヒントがあること`);
    const error = Object.assign(new Error(`原因の説明（${code}）`), { code });
    const described = describeSetIndexError(error);
    assert.match(described, /原因の説明/, code);
    assert.ok(described.includes(SET_INDEX_ERROR_HINTS[code]), `${code} のヒントが含まれること`);
  }
  const unknown = describeSetIndexError(new Error('未分類の失敗'));
  assert.match(unknown, /未分類の失敗/);
});

// ---------------------------------------------------------------------------
// AC-5（warn）
// ---------------------------------------------------------------------------
test('AC-5: warn セットは exit 0・warning 1件・span.mdh-external-md へ置換される', async () => {
  const setDir = copyFixture('spec-set-warn');
  const result = await buildSet(setDir);
  assert.equal(result.code, 0, result.stderr);

  const output = `${result.stdout}${result.stderr}`;
  const warningLines = output.split('\n').filter((line) => /external-md/.test(line));
  assert.equal(warningLines.length, 1, `warning 1件であること: ${output}`);
  assert.match(output, /INNER\.md/);

  const $ = load(fs.readFileSync(path.join(setDir, 'html', 'SPEC-warn.html'), 'utf8'));
  const external = $('span.mdh-external-md');
  assert.equal(external.length, 1);
  assert.equal(external.attr('title'), './notes/INNER.md');
  assert.equal($('article.mdh-doc a').toArray().filter((el) => $(el).attr('href')?.endsWith('.md')).length, 0);
});

// ---------------------------------------------------------------------------
// AC-7（validate_spec_set: pass と3種の人工改変で fail）・AC-12
// ---------------------------------------------------------------------------
test('AC-7: validate_spec_set は正常出力に pass する（setDir・htmlDir の両方を受ける）', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');

  assert.equal((await validateSet(setDir)).code, 0);
  assert.equal((await validateSet(htmlDir)).code, 0);
  assert.equal(resolveHtmlDir(setDir), htmlDir);
  assert.equal(resolveHtmlDir(htmlDir), htmlDir);

  const { failures } = await validateSpecSetDir(htmlDir);
  assert.deepEqual(failures, []);
});

test('AC-7: マーカー削除・リンク破壊・ハブナビ削除の各改変で validate_spec_set が fail する', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');
  const specHtmlPath = path.join(htmlDir, 'SPEC-view.html');
  const pristine = fs.readFileSync(specHtmlPath, 'utf8');

  // (1) マーカー削除
  fs.rmSync(path.join(htmlDir, MARKER));
  assert.notEqual((await validateSet(htmlDir)).code, 0);
  fs.writeFileSync(path.join(htmlDir, MARKER), '');
  assert.equal((await validateSet(htmlDir)).code, 0);

  // (2) リンク破壊（解決しない相対リンクへ差し替え）
  fs.writeFileSync(specHtmlPath, pristine.replace('./README.html', './GONE.html'));
  assert.notEqual((await validateSet(htmlDir)).code, 0);
  fs.writeFileSync(specHtmlPath, pristine);
  assert.equal((await validateSet(htmlDir)).code, 0);

  // (3) ハブナビ削除
  fs.writeFileSync(specHtmlPath, pristine.replace(/<nav class="mdh-hub-nav">.*?<\/nav>/s, ''));
  assert.notEqual((await validateSet(htmlDir)).code, 0);
  fs.writeFileSync(specHtmlPath, pristine);
  assert.equal((await validateSet(htmlDir)).code, 0);
});

test('AC-7: .md を指す相対 a[href] が残っていると validate_spec_set が fail する', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');
  const target = path.join(htmlDir, 'SPEC-view.html');
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('./README.html', './README.md'));
  assert.notEqual((await validateSet(htmlDir)).code, 0);
});

test('AC-12: セット出力の各文書 html に既存 validate_notion_html.mjs が pass する', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');

  for (const name of htmlNamesOf(htmlDir)) {
    const result = await runNode(notionValidateCli, [path.join(htmlDir, name)]);
    assert.equal(result.code, 0, `${name}: ${result.stdout}${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// AC-8（安全3系）
// ---------------------------------------------------------------------------
test('AC-8(a): マーカー無しの非空 html/ があるとビルドは fail し内容を保持する', async () => {
  const setDir = copyFixture('spec-set-valid');
  const htmlDir = path.join(setDir, 'html');
  fs.mkdirSync(htmlDir);
  fs.writeFileSync(path.join(htmlDir, 'hand-written.html'), '<p>手置き</p>');
  const before = snapshotDir(htmlDir);

  const result = await buildSet(setDir);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /手置き|マーカー|marker/i);
  assertSameSnapshot(before, snapshotDir(htmlDir), '手置きディレクトリ');
  assert.equal(fs.existsSync(path.join(setDir, '.html.tmp')), false);
});

test('AC-8(b): リンクエラーを含むセットのビルドでは既存 html/ が無傷で残る', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');
  const before = snapshotDir(htmlDir);

  fs.appendFileSync(path.join(setDir, 'guide.md'), '\n\n[壊れたリンク](./NOPE.md)\n');
  const result = await buildSet(setDir);
  assert.notEqual(result.code, 0);
  assertSameSnapshot(before, snapshotDir(htmlDir), '既存出力');
  assert.equal(fs.existsSync(path.join(setDir, '.html.tmp')), false);
  assert.equal(fs.existsSync(path.join(setDir, '.html.old')), false);
});

test('AC-8(c): lock が存在すると待たずに即 fail する（lock パスを案内する）', async () => {
  const setDir = copyFixture('spec-set-valid');
  const lockDir = path.join(setDir, '.spec-set.lock');
  fs.mkdirSync(lockDir);

  const result = await buildSet(setDir);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /\.spec-set\.lock/);
  assert.equal(fs.existsSync(lockDir), true, '他プロセスの lock を消さないこと');
  assert.equal(fs.existsSync(path.join(setDir, 'html')), false);
});

// ---------------------------------------------------------------------------
// AC-15（クラッシュ復旧3状態）
// ---------------------------------------------------------------------------
test('AC-15(i): .html.old だけが残る状態（rename1 と 2 の間）から復元してビルドできる', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');
  const expected = snapshotDir(htmlDir);

  fs.renameSync(htmlDir, path.join(setDir, '.html.old'));
  assert.equal(fs.existsSync(htmlDir), false);

  const result = await buildSet(setDir);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(setDir, '.html.old')), false);
  assertSameSnapshot(expected, snapshotDir(htmlDir), '復元後の再ビルド');
});

test('AC-15(ii): .html.tmp の残骸があっても掃除してビルドできる', async () => {
  const setDir = copyFixture('spec-set-valid');
  const tmpDir = path.join(setDir, '.html.tmp');
  fs.mkdirSync(tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'stale.html'), '<p>途中で死んだ生成物</p>');

  const result = await buildSet(setDir);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(tmpDir), false);
  assert.equal(htmlNamesOf(path.join(setDir, 'html')).includes('stale.html'), false);
});

test('AC-15(iii): .html.old と html が併存する状態（rename2 後）から .html.old を掃除してビルドできる', async () => {
  const setDir = copyFixture('spec-set-valid');
  assert.equal((await buildSet(setDir)).code, 0);
  const htmlDir = path.join(setDir, 'html');
  const expected = snapshotDir(htmlDir);
  fs.cpSync(htmlDir, path.join(setDir, '.html.old'), { recursive: true });

  const result = await buildSet(setDir);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(setDir, '.html.old')), false);
  assertSameSnapshot(expected, snapshotDir(htmlDir), '併存状態からの再ビルド');
});

// ---------------------------------------------------------------------------
// CLI の引数契約（--out は実装しない）
// ---------------------------------------------------------------------------
test('CLI: --out は実装せず、指定されたら fail する（出力は <setDir>/html 固定）', async () => {
  const setDir = copyFixture('spec-set-valid');
  const result = await runNode(buildCli, [setDir, '--out', path.join(setDir, 'anywhere')]);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /--out/);
  assert.equal(fs.existsSync(path.join(setDir, 'anywhere')), false);
  assert.equal(fs.existsSync(path.join(setDir, 'html')), false);
});

test('CLI: 引数なしは usage を出して fail する', async () => {
  const result = await runNode(buildCli, []);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Usage/i);
});

test('CLI: 相対パス引数を cwd 基準で解決する', async () => {
  const setDir = copyFixture('spec-set-valid');
  const parent = path.dirname(setDir);
  const { code } = await (async () => {
    try {
      await execFileAsync(process.execPath, [buildCli, 'spec-set-valid'], { cwd: parent });
      return { code: 0 };
    } catch (error) {
      return { code: typeof error.code === 'number' ? error.code : 1, stderr: error.stderr };
    }
  })();
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(setDir, 'html', 'index.html')));
});

test('buildSetIndex: 改行を含む title は一覧で 1 行になる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-specset-multiline-title-'));
  fs.writeFileSync(path.join(dir, 'SPEC-two.md'), '---\ntitle: |-\n  部品の検査\n  見本 2a\n---\n\n本文\n');
  const index = buildSetIndex(dir);
  assert.equal(index.docs.find((doc) => doc.basename === 'SPEC-two.md').title, '部品の検査 見本 2a');
  fs.rmSync(dir, { recursive: true, force: true });
});
