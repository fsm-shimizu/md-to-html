import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineNodesToContent } from './markdown-to-blocks.mjs';

// url-safety の bare 相対許可が link 経路（編集版ブロック生成）へ正しく波及することを固定する。
// isSafeUrl(false) のリンクは link を剥がして children（テキスト）化される。

test('bare相対パスのリンクは保持される', () => {
  const out = inlineNodesToContent([
    { type: 'link', url: 'report.html', children: [{ type: 'text', value: 'レポート' }] }
  ]);
  assert.equal(out[0].type, 'link');
  assert.equal(out[0].url, 'report.html');
});

test('サブディレクトリ相対パスのリンクも保持される', () => {
  const out = inlineNodesToContent([
    { type: 'link', url: 'docs/a.html', children: [{ type: 'text', value: 'x' }] }
  ]);
  assert.equal(out[0].type, 'link');
  assert.equal(out[0].url, 'docs/a.html');
});

test('javascript: リンクは剥がされテキスト化される', () => {
  const out = inlineNodesToContent([
    { type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', value: 'click' }] }
  ]);
  assert.ok(out.every((n) => n.type !== 'link'), 'javascript: リンクが保持されてはいけない');
  assert.equal(out[0].text, 'click');
});

test('http(s)/fragment リンクは引き続き保持される', () => {
  for (const url of ['https://example.com/a', '#sec', './rel.html', '/root.html']) {
    const out = inlineNodesToContent([{ type: 'link', url, children: [{ type: 'text', value: 'l' }] }]);
    assert.equal(out[0].type, 'link', `${url} は保持されるべき`);
  }
});
