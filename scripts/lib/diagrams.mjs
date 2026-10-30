// 図の描画。
// 言語が mermaid のコードブロックを beautiful-mermaid で SVG にし、要素・属性の名前・属性の値を許可リストで検査してから、
// 節点の data.hName・hProperties・hChildren に移す。SVG の文字列は出力に差し込まない。
// 編集版のブラウザ用の bundle に図の依存を入れないため、static-renderer.mjs とそれが読むファイルからはこのファイルを読まない。
import { renderMermaidSVG } from 'beautiful-mermaid';
import { fromHtml } from 'hast-util-from-html';

export const DIAGRAM_REASONS = {
  unsupported: '対応していない図',
  cannot: '図を描けない',
  unsafe: '図を安全に埋め込めない'
};

// D3: 描く種類
const KINDS = new Set(['flowchart', 'graph', 'sequenceDiagram', 'stateDiagram', 'stateDiagram-v2', 'classDiagram', 'erDiagram', 'xychart-beta']);
// D4: 色は白の背景と md-to-html の文字色（--ink）から作る
const COLORS = { bg: '#FFFFFF', fg: '#333333' };
const MIN_TEXT_PX = 10;
const DEFAULT_FONT_PX = 13;

// D6・§SVG の許可リスト（HAST のプロパティ名）
const ELEMENTS = new Set(['svg', 'g', 'defs', 'marker', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title']);
const NUM = /^[0-9eE+\-.,\s%pxm]*$/; // 数・px・em・%
const WORD = /^[A-Za-z0-9-]+$/;
const ID = /^[A-Za-z0-9_-]+$/;
const LOCAL_URL = /^url\(#([A-Za-z0-9_-]+)\)$/;
const COLOR = /^(?:none|transparent|currentColor|#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[A-Za-z]+|var\(--(?:bg|fg|_[a-z-]+)\))$/;
const ATTRS = {
  xmlns: (v) => v === 'http://www.w3.org/2000/svg',
  id: (v) => ID.test(v),
  className: (v) => [].concat(v).every((t) => ID.test(String(t))),
  d: (v) => /^[MLHVCSQTAZmlhvcsqtaz0-9eE+\-.,\s]*$/.test(v),
  transform: (v) => /^(?:\s*(?:translate|scale|rotate|matrix)\([0-9eE+\-.,\s]*\)\s*)*$/.test(v),
  fill: (v, ids) => COLOR.test(v) || localRef(v, ids),
  stroke: (v, ids) => COLOR.test(v) || localRef(v, ids),
  markerStart: (v, ids) => localRef(v, ids),
  markerEnd: (v, ids) => localRef(v, ids)
};
for (const k of ['viewBox', 'markerWidth', 'markerHeight', 'refX', 'refY', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'strokeWidth', 'strokeDashArray', 'opacity', 'fillOpacity', 'strokeOpacity', 'fontSize', 'dy', 'dx']) ATTRS[k] = (v) => NUM.test(v);
for (const k of ['orient', 'fontWeight', 'fontStyle', 'textAnchor', 'dominantBaseline', 'strokeLineJoin', 'strokeLineCap']) ATTRS[k] = (v) => WORD.test(v);

function localRef(v, ids) {
  const m = LOCAL_URL.exec(v);
  return Boolean(m && ids.has(m[1]));
}

const isData = (key) => /^data[A-Z0-9]/.test(key);

// 種類の判定。空行と %% の行を除いた最初の行の最初の語。中身が無ければ null
function kindOf(code) {
  const line = code.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('%%'));
  return line ? line.split(/\s+/)[0] : null;
}

// D12: 原稿の矢印の数（角括弧・丸括弧・波括弧・引用符・|…| の中を除いた後）
const ARROW = /<?-{2,}[->xo]|<?={2,}[=>xo]|-\.+-?>/g;
const SKIP_LINE = /^\s*(?:%%|style\b|classDef\b|class\b|linkStyle\b|click\b|subgraph\b|end\b|direction\b)/;
function sourceArrows(code) {
  return code.split(/\r?\n/).slice(1).filter((l) => !SKIP_LINE.test(l)).reduce((n, l) => {
    const stripped = l.replace(/"[^"]*"/g, '').replace(/\|[^|]*\|/g, '').replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\{[^}]*\}/g, '');
    return n + (stripped.match(ARROW) || []).length;
  }, 0);
}
// D12: beautiful-mermaid 1.1.3 が例外を出さずに誤読する書き方。
// 図全体の本数の比較だけでは、& で増えた矢印が別の行の欠落を打ち消すので、書き方そのものも見る。
//   1. 角括弧の無い名前のすぐ後ろに空白なしで矢印（A-->B・A---B・A-.->B・A==>B）。foo--bar のようなハイフン入りの名前は誤読されないので落とさない
//   2. 矢印にラベルを空白なしでつなげた形（A --ラベル--> B・A ==ラベル==> B・A -.ラベル.-> B）。A -- ラベル --> B と A -->|ラベル| B は正しく読まれる
//   3. 丸・×で終わる矢印（A --o B・A --x B）
const MISREAD = [
  /[A-Za-z0-9_](?:-{2,}[->xo]|-{3,}|={2,}[=>]|-\.+-?>)/,
  /(?:^|\s)(?:={2,}|-{2,}|-\.)(?=[^\s=\-.>#])/,
  /\s-{2,}[ox](?:\s|$)/
];
function hasMisreadArrow(code) {
  return code.split(/\r?\n/).slice(1).filter((l) => !SKIP_LINE.test(l)).some((l) => {
    const masked = l.replace(/"[^"]*"/g, '#').replace(/\|[^|]*\|/g, '#').replace(/\[[^\]]*\]/g, '#').replace(/\([^)]*\)/g, '#').replace(/\{[^}]*\}/g, '#');
    return MISREAD.some((re) => re.test(masked));
  });
}
// SVG の矢印の線（data-from を持つ線の要素）の数
function svgArrows(svg) {
  let n = 0;
  walk(svg, (el) => { if (['polyline', 'path', 'line'].includes(el.tagName) && el.properties?.dataFrom != null) n += 1; });
  return n;
}

function walk(node, fn) {
  if (node.type === 'element') fn(node);
  for (const c of node.children || []) walk(c, fn);
}

// D6: 許可リストで検査する。外れたら理由の文字を返す
function rejectReason(svg, ids) {
  let reason = null;
  walk(svg, (el) => {
    if (reason) return;
    if (!ELEMENTS.has(el.tagName)) { reason = `要素 ${el.tagName}`; return; }
    for (const [key, value] of Object.entries(el.properties || {})) {
      if (isData(key)) continue;
      const ok = ATTRS[key];
      const v = key === 'className' ? value : String(Array.isArray(value) ? value.join(' ') : value);
      if (!ok || !ok(v, ids)) { reason = `属性 ${key}`; return; }
    }
  });
  return reason;
}

/**
 * 1 つの Mermaid の文を、検査を通った SVG の hast にする。描けない・検査に通らないときは { reason, info } を返す。
 * @param {string} code
 * @param {{ n: number, usedIds: Set<string> }} ctx
 */
export function diagramFromCode(code, { n, usedIds }) {
  const kind = kindOf(code);
  if (!kind) return { reason: DIAGRAM_REASONS.cannot, info: '中身が無い' };
  if (!KINDS.has(kind)) return { reason: DIAGRAM_REASONS.unsupported, info: kind };
  let svgText;
  try {
    svgText = renderMermaidSVG(code, COLORS);
  } catch (error) {
    return { reason: DIAGRAM_REASONS.cannot, info: String(error?.message || error).trim().split('\n')[0] };
  }
  return checkSvg(svgText, { kind, code, n, usedIds });
}

/**
 * 描いた SVG の文字を読み、許可リストで検査し、id・大きさ・題を整えた hast を返す。
 * 描けない・検査に通らないときは { reason, info } を返す。例外はここで捕まえる（S3）。
 * @param {string} svgText
 * @param {{ kind: string, code: string, n: number, usedIds: Set<string> }} ctx
 */
export function checkSvg(svgText, { kind, code, n, usedIds }) {
  try {
    const root = fromHtml(svgText, { fragment: true });
    const kids = root.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
    if (kids.length !== 1 || kids[0].type !== 'element' || kids[0].tagName !== 'svg') return { reason: DIAGRAM_REASONS.unsafe, info: '根が svg 1 つでない' };
    const svg = kids[0];
    // D7: <style> を取り除く（同じ見た目の規則は static-renderer.mjs の CSS にある）。ルートの style・width・height も外す
    const strip = (node) => { node.children = (node.children || []).filter((c) => !(c.type === 'element' && c.tagName === 'style')); node.children.forEach((c) => c.children && strip(c)); };
    strip(svg);
    const width = Number(String(svg.properties.viewBox || '').trim().split(/[\s,]+/)[2]);
    for (const k of ['style', 'width', 'height']) delete svg.properties[k];
    // D8: id に図ごとの前置きを付け、url(#…) の参照も書き換える。見出しの id と重なれば後ろに -2… を足す
    const map = new Map();
    walk(svg, (el) => {
      const id = el.properties?.id;
      if (id == null) return;
      let next = `mdh-diagram-${n}-${id}`;
      if (usedIds.has(next)) { let x = 2; while (usedIds.has(`${next}-${x}`)) x += 1; next = `${next}-${x}`; }
      usedIds.add(next);
      map.set(String(id), next);
      el.properties.id = next;
    });
    walk(svg, (el) => {
      for (const key of ['fill', 'stroke', 'markerStart', 'markerEnd']) {
        const v = el.properties?.[key];
        if (typeof v === 'string') el.properties[key] = v.replace(/^url\(#([^)]+)\)$/, (m, id) => (map.has(id) ? `url(#${map.get(id)})` : m));
      }
    });
    const reason = rejectReason(svg, new Set(map.values()));
    if (reason) return { reason: DIAGRAM_REASONS.unsafe, info: reason };
    // D12: flowchart・graph は、描いた矢印の線の数が原稿の矢印の数より少なければ図にしない
    if ((kind === 'flowchart' || kind === 'graph') && (hasMisreadArrow(code) || svgArrows(svg) < sourceArrows(code))) return { reason: DIAGRAM_REASONS.cannot, info: '矢印が足りない' };
    // D9: 縮めても文字が 10px より小さくならない幅で止める
    const sizes = [];
    walk(svg, (el) => { const s = Number(el.properties?.fontSize); if (Number.isFinite(s) && s > 0) sizes.push(s); });
    const minFont = sizes.length ? Math.min(...sizes) : DEFAULT_FONT_PX;
    if (!Number.isFinite(width) || width <= 0) return { reason: DIAGRAM_REASONS.unsafe, info: 'viewBox が無い' };
    const minWidth = width * Math.min(1, MIN_TEXT_PX / minFont);
    svg.properties.style = `max-width: ${round(width)}px; min-width: ${round(minWidth)}px`;
    // D10: 読み上げ用の題
    svg.children.unshift({ type: 'element', tagName: 'title', properties: {}, children: [{ type: 'text', value: `図（${kind}）` }] });
    return { kind, svg };
  } catch (error) {
    return { reason: DIAGRAM_REASONS.unsafe, info: String(error?.message || error).trim().split('\n')[0] };
  }
}

const round = (v) => Math.round(v * 10) / 10;

/**
 * 木の Mermaid のコードブロックを図にする。木をその場で書き換え、戻り値は無い。
 * collectHeadings の後に呼ぶ。usedIds は見出しの id の集合（図の id はこれと重ならないように付ける）。
 * @param {import('mdast').Root} tree
 * @param {{ usedIds?: Set<string>, onWarning?: (w: { line: number, reason: string, marker: string }) => void }} [options]
 */
export function renderDiagrams(tree, { usedIds = new Set(), onWarning } = {}) {
  const ids = new Set(usedIds);
  let n = 0;
  (function visit(parent) {
    const children = parent.children || [];
    for (let i = 0; i < children.length; i += 1) {
      const node = children[i];
      if (node.type === 'code' && String(node.lang || '').toLowerCase() === 'mermaid') {
        n += 1;
        const result = diagramFromCode(String(node.value || ''), { n, usedIds: ids });
        if (result.reason) {
          onWarning?.({ line: node.position?.start?.line, reason: result.reason, marker: result.info });
          continue;
        }
        children[i] = {
          type: 'mdhDiagram',
          position: node.position,
          data: { hName: 'figure', hProperties: { className: ['mdh-diagram'], dataMdhDiagram: result.kind }, hChildren: [result.svg] }
        };
        continue;
      }
      if (node.children) visit(node);
    }
  })(tree);
}
