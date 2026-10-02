import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeUrl } from './url-safety.mjs';

// 許可すべき相対参照
test('ディレクトリ無しの素の相対パスを許可する', () => {
  assert.equal(isSafeUrl('sample.png'), true);
});

test('サブディレクトリ相対パスを許可する', () => {
  assert.equal(isSafeUrl('images/photo.png'), true);
  assert.equal(isSafeUrl('a/b/c.png'), true);
});

test('コロンを含むファイル名でもパス後方なら相対参照として許可する', () => {
  // 最初のセグメントより後にコロンがあるものはスキームではない
  assert.equal(isSafeUrl('dir/a:b.png'), true);
});

test('従来の相対/fragment/許可スキームは引き続き許可する', () => {
  assert.equal(isSafeUrl('#section'), true);
  assert.equal(isSafeUrl('./a.png'), true);
  assert.equal(isSafeUrl('../a.png'), true);
  assert.equal(isSafeUrl('/root.png'), true);
  assert.equal(isSafeUrl('http://example.com/a.png'), true);
  assert.equal(isSafeUrl('https://example.com/a.png'), true);
  assert.equal(isSafeUrl('mailto:a@b.com'), true);
  assert.equal(isSafeUrl('tel:+81-3-0000-0000'), true);
});

// 拒否すべきもの
test('javascript: スキームは拒否する', () => {
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
});

test('難読化された javascript: も正規化後に拒否する', () => {
  assert.equal(isSafeUrl('java\nscript:alert(1)'), false);
});

test('data: スキームは拒否する（self-containが後段で付与するため入力では不許可）', () => {
  assert.equal(isSafeUrl('data:image/png;base64,AAAA'), false);
});

test('未知スキーム（コロン区切り・スラッシュ無し）は拒否する', () => {
  assert.equal(isSafeUrl('foo:bar.png'), false);
});

test('プロトコル相対 // は拒否する', () => {
  assert.equal(isSafeUrl('//evil.com/a.png'), false);
});

test('空・非文字列は拒否する', () => {
  assert.equal(isSafeUrl(''), false);
  assert.equal(isSafeUrl('   '), false);
  assert.equal(isSafeUrl(null), false);
  assert.equal(isSafeUrl(undefined), false);
  assert.equal(isSafeUrl(42), false);
});

test('配列は全要素が安全な場合のみ許可する', () => {
  assert.equal(isSafeUrl(['a.png', 'b/c.png']), true);
  assert.equal(isSafeUrl(['a.png', 'javascript:x']), false);
});
