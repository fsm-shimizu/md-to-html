// 数式の組版。
// remark-math が切り出した math（`$$` の行で囲んだ式）と inlineMath（文中の `$$…$$`）を temml で MathML に組み、
// 節点の data.hName・hProperties・hChildren を差し替える。HTML の文字列は出力に差し込まない。
// 編集版のブラウザ用の bundle に temml を入れないため、static-renderer.mjs とそれが読むファイルからはこのファイルを読まない。
import { fromHtml } from 'hast-util-from-html';

export const MATH_REASONS = {
  cannot: '数式を組めない',
  unclosed: '閉じていない `$$`',
  meta: '`$$` の行に式がある'
};

// D14: 出力に許す MathML の要素
const MATHML = new Set([
  'math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot',
  'mstyle', 'mpadded', 'mphantom', 'menclose', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover',
  'mmultiscripts', 'mprescripts', 'none', 'semantics', 'annotation', 'merror'
]);
const FORBIDDEN_PROPS = new Set(['href', 'xlinkHref', 'id', 'name', 'src']);

const isBlankText = (n) => n.type === 'text' && n.value.trim() === '';
const sliceOf = (node, markdown) => {
  const s = node.position?.start?.offset;
  const e = node.position?.end?.offset;
  return typeof s === 'number' && typeof e === 'number' ? markdown.slice(s, e) : '';
};

// D7: 文中の式の原文。1 行なら切り出したまま、2 行以上なら先頭と末尾の `$` の並びで value を挟む
function inlineSource(node, markdown) {
  const s = sliceOf(node, markdown);
  if (s && !/[\r\n]/.test(s)) return s;
  const open = s.match(/^\$+/)?.[0] || '$$';
  const close = s.match(/\$+$/)?.[0] || '$$';
  return `${open}${node.value}${close}`;
}

// D7: `$$` の行で囲んだ式の原文。開きの行、value、閉じているときは閉じの `$` の並び
function flowSource(node, markdown) {
  const lines = sliceOf(node, markdown).split(/\r\n|\n|\r/);
  const parts = [lines[0] || '$$'];
  if (node.value !== '') parts.push(node.value);
  if (node.data?.mdhClosed) {
    const last = [...lines].reverse().find((l) => l.trim() !== '') || '$$';
    parts.push(last.replace(/^[\s>]*/, '').trim());
  }
  return parts.join('\n');
}

// D14: 根が math 1 つだけ、中は MathML の要素だけ、リンク・id などの属性と mdh- の class が無い
function acceptable(root) {
  const kids = root.children.filter((n) => !(n.type === 'text' && n.value.trim() === ''));
  if (kids.length !== 1 || kids[0].type !== 'element' || kids[0].tagName !== 'math') return null;
  const ok = (n) => {
    if (n.type === 'text') return true;
    if (n.type !== 'element' || !MATHML.has(n.tagName)) return false;
    for (const [key, value] of Object.entries(n.properties || {})) {
      if (FORBIDDEN_PROPS.has(key) || /^on/i.test(key)) return false;
      if (key === 'className' && [].concat(value).some((c) => String(c).startsWith('mdh-'))) return false;
    }
    return (n.children || []).every(ok);
  };
  return ok(kids[0]) ? kids[0] : null;
}

function typeset(temml, tex, displayMode) {
  let html;
  try {
    html = temml.renderToString(tex, { displayMode, throwOnError: true });
  } catch (error) {
    return { info: String(error?.message || error).trim().split('\n')[0] };
  }
  const math = acceptable(fromHtml(html, { fragment: true }));
  if (!math) return { info: '使えない命令' };
  const properties = { ...math.properties, className: [...[].concat(math.properties?.className || []), 'mdh-math'] };
  return { math: { properties, children: math.children } };
}

const sourceBlock = (value, position, source) => ({
  type: 'math',
  value,
  position,
  data: { hName: 'div', hProperties: { className: ['mdh-math-source'] }, hChildren: [{ type: 'text', value: source }] }
});

/**
 * 木の数式の節点を MathML に組む。木をその場で書き換え、戻り値は無い。
 * @param {import('mdast').Root} tree parseMarkdownDocument の木
 * @param {string} markdown parseMarkdownDocument が返した本文（節点の位置はこの文字列の位置）
 * @param {{ onWarning?: (w: { line: number, reason: string, marker: string }) => void }} [options]
 */
export async function typesetMath(tree, markdown, { onWarning } = {}) {
  const targets = [];
  (function walk(parent) {
    const children = parent.children || [];
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.type === 'math') {
        targets.push({ kind: 'flow', parent, node });
        continue;
      }
      if (node.type === 'paragraph') {
        const real = node.children.filter((n) => !isBlankText(n));
        if (real.length === 1 && real[0].type === 'inlineMath' && node.children.every((n) => n === real[0] || isBlankText(n))) {
          targets.push({ kind: 'para', parent, node, math: real[0] });
          continue;
        }
      }
      if (node.type === 'inlineMath') {
        targets.push({ kind: 'inline', parent, node });
        continue;
      }
      if (node.children) walk(node);
    }
  })(tree);
  if (!targets.length) return;

  const temml = (await import('temml')).default;
  // 警告の marker は節点の位置からの切り出し。表示用に組み立てた原文とは別
  const warn = (node, reason, info) => {
    if (!onWarning) return;
    const raw = sliceOf(node, markdown);
    const cut = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    onWarning({ line: node.position?.start?.line, reason, marker: info ? `${cut}（${info}）` : cut });
  };
  const replace = (parent, node, next) => {
    const index = parent.children.indexOf(node);
    if (index >= 0) parent.children[index] = next;
  };

  for (const t of targets) {
    if (t.kind === 'inline') {
      const source = inlineSource(t.node, markdown);
      const result = t.node.value.trim() === '' ? { info: '空の式' } : typeset(temml, t.node.value, false);
      if (result.math) {
        t.node.data = { hName: 'math', hProperties: result.math.properties, hChildren: result.math.children };
      } else {
        warn(t.node, MATH_REASONS.cannot, result.info);
        replace(t.parent, t.node, { type: 'text', value: source, position: t.node.position });
      }
      continue;
    }

    const node = t.kind === 'para' ? t.math : t.node;
    const source = t.kind === 'para' ? inlineSource(t.math, markdown) : flowSource(t.node, markdown);
    let reason = MATH_REASONS.cannot;
    let result;
    if (t.kind === 'flow' && !t.node.data?.mdhClosed) {
      reason = MATH_REASONS.unclosed;
      result = {};
    } else if (t.kind === 'flow' && t.node.meta) {
      reason = MATH_REASONS.meta;
      result = {};
    } else if (node.value.trim() === '') {
      result = { info: '空の式' };
    } else {
      result = typeset(temml, node.value, true);
    }
    if (result.math) {
      const display = {
        type: 'math',
        value: node.value,
        position: t.node.position,
        data: {
          hName: 'div',
          hProperties: { className: ['mdh-math-display'] },
          hChildren: [{ type: 'element', tagName: 'math', properties: result.math.properties, children: result.math.children }]
        }
      };
      replace(t.parent, t.node, display);
    } else {
      warn(node, reason, result.info);
      replace(t.parent, t.node, sourceBlock(node.value, t.node.position, source));
    }
  }
}
