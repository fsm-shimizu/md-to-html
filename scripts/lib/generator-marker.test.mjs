// scripts/lib/generator-marker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATOR_META, hasGeneratorMarker } from './generator-marker.mjs';
import { renderPage } from './static-renderer.mjs';
import { renderEditablePage } from './render-editable-page.mjs';

test('GENERATOR_META は name=generator content=md-to-html の meta タグ', () => {
  assert.match(GENERATOR_META, /<meta[^>]*name=["']generator["'][^>]*>/i);
  assert.ok(hasGeneratorMarker(`<head>${GENERATOR_META}</head>`));
});

test('マーカー有り → true（属性順・大小文字・自己終了タグ不問）', () => {
  assert.ok(hasGeneratorMarker('<meta name="generator" content="md-to-html">'));
  assert.ok(hasGeneratorMarker('<meta content="md-to-html" name="generator">'));
  assert.ok(hasGeneratorMarker("<META NAME='generator' CONTENT='md-to-html' />"));
  assert.ok(hasGeneratorMarker('<meta   name = "generator"   content = "md-to-html" >'));
});

test('マーカー無し / 偽装 → false', () => {
  assert.equal(hasGeneratorMarker('<html><body><p>hi</p></body></html>'), false);
  assert.equal(hasGeneratorMarker('<meta name="generator" content="hugo">'), false);
  assert.equal(hasGeneratorMarker('<meta name="author" content="md-to-html">'), false);
  assert.equal(hasGeneratorMarker(''), false);
});

test('renderPage（共有の既定ビルド）出力にマーカーが含まれる', () => {
  const html = renderPage({ title: 'T', data: {}, toc: [], bodyHtml: '<p>x</p>' });
  assert.ok(hasGeneratorMarker(html));
});

test('renderEditablePage（エディタ版）出力にマーカーが含まれる', () => {
  const html = renderEditablePage({
    title: 'T', data: {}, editableDocument: { blocks: [] }, runtimeJs: '', editableCss: ''
  });
  assert.ok(hasGeneratorMarker(html));
});
