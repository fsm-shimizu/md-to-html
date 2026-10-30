// 部品。コールアウト・折りたたみ・用語と説明・キャプションを、
// Markdown の木（mdast）の上で組み替える。HTML の要素名とクラスは data.hName・hProperties・hChildren で指定し、HTML の文字列は作らない。
// 組み替えた節点は型 `mdhComponent` にする。remark-rehype の既定の扱い（中身を変換して hName の要素にする）で HTML になり、
// 段落の変換が、部品の見出しとして取り除いた 1 行目を段落として拾わない。

// コールアウトの名前と色。原稿の文字をクラス名にせず、この一覧から写す（N1）。
const CALLOUT_COLORS = {
  gray: 'gray', blue: 'blue', green: 'green', yellow: 'yellow', red: 'red',
  note: 'gray', tip: 'blue', important: 'red', warning: 'yellow', caution: 'red'
};
const MARKER = /^\[!([A-Za-z]+)\]([+-]?)/;
// 警告の対象は、名前が英字でないものも含めて引用の 1 行目の先頭の `[!…]` すべて
const MARKER_LIKE = /^\[![^\]\n]*\]([+-]?)/;

const component = (hName, className, children, extra = {}) => ({
  type: 'mdhComponent',
  data: { hName, hProperties: className ? { className: className.split(' '), ...extra } : { ...extra } },
  children
});

function hasNewline(node) {
  if (node.type === 'break') return true;
  if (typeof node.value === 'string' && node.value.includes('\n')) return true;
  // 行内コードの中の改行は空白に変わるので、位置が複数の行にまたがるかでも見る
  if (node.type !== 'text' && node.position && node.position.start.line !== node.position.end.line) return true;
  return (node.children || []).some(hasNewline);
}

/**
 * 段落を行に分ける。文字の中の改行と break で区切る。
 * 強調・リンク・取り消し線・行内コードの中に改行があるときは null（「行に分けられない」）。
 * @returns {Array<{ nodes: object[], viaBreak: boolean }> | null} viaBreak はその行の前の区切りが break か
 */
export function splitLines(paragraph) {
  const lines = [{ nodes: [], viaBreak: false }];
  for (const node of paragraph.children || []) {
    if (node.type === 'break') {
      lines.push({ nodes: [], viaBreak: true });
      continue;
    }
    if (node.type === 'text') {
      node.value.split('\n').forEach((part, i) => {
        if (i) lines.push({ nodes: [], viaBreak: false });
        if (part) lines[lines.length - 1].nodes.push({ type: 'text', value: part, position: i === 0 ? node.position : undefined });
      });
      continue;
    }
    if (hasNewline(node)) return null;
    lines[lines.length - 1].nodes.push(node);
  }
  return lines;
}

// 行をつなぎ直す。文字の改行は文字の '\n'、break は break に戻す（B8 の「元の改行を保つ」）。
function joinLines(lines) {
  const out = [];
  lines.forEach((line, i) => {
    if (i) out.push(line.viaBreak ? { type: 'break' } : { type: 'text', value: '\n' });
    out.push(...line.nodes);
  });
  return out;
}

function trimInline(nodes) {
  const out = nodes.map((n) => (n.type === 'text' ? { ...n } : n));
  while (out.length && out[0].type === 'text' && !out[0].value.trim()) out.shift();
  while (out.length && out[out.length - 1].type === 'text' && !out[out.length - 1].value.trim()) out.pop();
  if (out.length && out[0].type === 'text') out[0].value = out[0].value.replace(/^\s+/, '');
  if (out.length && out[out.length - 1].type === 'text') out[out.length - 1].value = out[out.length - 1].value.replace(/\s+$/, '');
  return out;
}

// 引用を判定する。部品になるなら component、目印があって部品にならないなら warning を返す。
function classifyBlockquote(blockquote) {
  const first = blockquote.children?.[0];
  if (first?.type !== 'paragraph') return {};
  const head = first.children?.[0];
  if (head?.type !== 'text') return {};
  const like = MARKER_LIKE.exec(head.value);
  if (!like) return {};
  const warn = (reason) => ({ warning: { line: head.position?.start?.line, reason, marker: like[0] } });
  const m = MARKER.exec(head.value);
  const name = m ? m[1].toLowerCase() : '';
  const sign = m ? m[2] : '';
  if (!m || (name !== 'toggle' && !Object.hasOwn(CALLOUT_COLORS, name))) return warn('知らない名前');
  if (name !== 'toggle' && sign) return warn('色に開閉の記号');
  const lines = splitLines(first);
  if (!lines) return warn('行に分けられない');
  const [headLine, ...rest] = lines;
  const label = trimInline([{ ...headLine.nodes[0], value: headLine.nodes[0].value.slice(m[0].length) }, ...headLine.nodes.slice(1)]);
  if (name === 'toggle' && !label.length) return warn('見出しの無い toggle');
  const base = { label, rest };
  return { component: name === 'toggle' ? { kind: 'toggle', open: sign === '+', ...base } : { kind: 'callout', color: CALLOUT_COLORS[name], ...base } };
}

/**
 * 引用が部品かどうか。`remarkComponents` と `collectHeadings`はこの結果だけに従う。
 * @returns {{ kind: 'callout', color: string, label: object[], rest: object[] } | { kind: 'toggle', open: boolean, label: object[], rest: object[] } | null}
 */
export function blockquoteComponent(blockquote) {
  return classifyBlockquote(blockquote).component || null;
}

const ARROW = {
  type: 'mdhComponent',
  data: {
    hName: 'svg',
    hProperties: { className: ['mdh-toggle-arrow'], viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', ariaHidden: 'true' },
    hChildren: [{ type: 'element', tagName: 'path', properties: { d: 'M5 7.5l5 5 5-5' }, children: [] }]
  },
  children: []
};

function buildComponent(blockquote, info) {
  const bodyChildren = [];
  // 最初の段落の 2 行目以降は、段落として本文の先頭に残す。2 行目が無ければ段落ごと取り除く。
  if (info.rest.length) bodyChildren.push({ ...blockquote.children[0], children: joinLines([{ ...info.rest[0], viaBreak: false }, ...info.rest.slice(1)]) });
  bodyChildren.push(...blockquote.children.slice(1));
  if (info.kind === 'toggle') {
    return component('details', 'mdh-toggle', [
      component('summary', null, [...info.label, structuredClone(ARROW)]),
      component('div', 'mdh-toggle-body', bodyChildren)
    ], info.open ? { open: true } : {});
  }
  return component('div', `mdh-callout mdh-callout-${info.color}`, [
    ...(info.label.length ? [component('p', 'mdh-callout-label', info.label)] : []),
    component('div', 'mdh-callout-body', bodyChildren)
  ]);
}

// 引用を内側から変換する。
function transformBlockquotes(node) {
  if (!node.children) return node;
  node.children = node.children.map(transformBlockquotes);
  if (node.type !== 'blockquote') return node;
  const info = blockquoteComponent(node);
  return info ? { ...buildComponent(node, info), position: node.position } : node;
}

const startsWithColon = (line) => line.nodes[0]?.type === 'text' && line.nodes[0].value.startsWith(': ');

// 用語と説明の組。組にならなければ null。
function definitionPair(paragraph) {
  const lines = splitLines(paragraph);
  if (!lines || lines.length < 2) return null;
  const [term, ...rest] = lines;
  if (!term.nodes.length || startsWithColon(term)) return null;
  const isDescStart = (line) => startsWithColon(line) && (line.nodes[0].value.length > 2 || line.nodes.length > 1);
  if (!isDescStart(rest[0])) return null;
  const descriptions = [];
  for (const line of rest) {
    if (isDescStart(line)) {
      const nodes = [{ ...line.nodes[0], value: line.nodes[0].value.slice(2).replace(/^\s+/, '') }, ...line.nodes.slice(1)].filter((n) => n.type !== 'text' || n.value);
      descriptions.push([{ nodes, viaBreak: false }]);
    } else {
      descriptions[descriptions.length - 1].push(line);
    }
  }
  return component('div', null, [
    component('dt', null, term.nodes),
    ...descriptions.map((desc) => component('dd', null, joinLines(desc)))
  ]);
}

// キャプション付きの図。画像 1 つ・改行 1 つ・強調 1 つだけの段落。図にならなければ null。
function captionFigure(paragraph) {
  const tokens = [];
  for (const node of paragraph.children || []) {
    if (node.type === 'text' && !node.value.trim()) {
      if (node.value.includes('\n')) tokens.push({ kind: 'nl', node });
      continue;
    }
    if (node.type === 'break') tokens.push({ kind: 'nl', node });
    else if (node.type === 'image' || node.type === 'imageReference') tokens.push({ kind: 'img', node });
    else if (node.type === 'emphasis') tokens.push({ kind: 'em', node });
    else return null;
  }
  if (tokens.map((t) => t.kind).join(',') !== 'img,nl,em') return null;
  return component('figure', 'mdh-figure', [tokens[0].node, component('figcaption', null, tokens[2].node.children)]);
}

// 段落を用語と説明・キャプションに変換し、続く用語と説明を 1 つの dl にまとめる。
function transformParagraphs(node) {
  if (!node.children) return;
  const out = [];
  let dl = null;
  for (const child of node.children) {
    if (child.type === 'paragraph') {
      const pair = definitionPair(child);
      if (pair) {
        if (!dl) {
          dl = component('dl', 'mdh-dl', []);
          dl.position = child.position;
          out.push(dl);
        }
        dl.children.push(pair);
        continue;
      }
      const figure = captionFigure(child);
      dl = null;
      out.push(figure ? { ...figure, position: child.position } : child);
      continue;
    }
    dl = null;
    transformParagraphs(child);
    out.push(child);
  }
  node.children = out;
}

export function remarkComponents() {
  return (tree) => {
    // 2b の目印。collectHeadings を通った木では目印はもう無いので何もしない
    applyLayoutMarkers(tree);
    tree.children = tree.children.map(transformBlockquotes);
    transformParagraphs(tree);
  };
}

/**
 * 部品にならなかった引用の 1 行目の `[!…]` を、理由と行番号付きで返す。`remarkComponents` より前の木に当てる。
 * @returns {Array<{ line: number, reason: string, marker: string }>}
 */
export function findCalloutWarnings(tree) {
  const warnings = [];
  const walk = (node) => {
    if (node.type === 'blockquote') {
      const { warning } = classifyBlockquote(node);
      if (warning) warnings.push(warning);
    }
    (node.children || []).forEach(walk);
  };
  walk(tree);
  return warnings;
}

// 見出しの末尾の管理用記号。名前は空白・`]`・`}` を含まない 1 文字以上。
const HEADING_MARKER = /\s*(\[#([^\s\]}]+)\]|\{#([^\s\]}]+)\})\s*$/;
const RESERVED_ID = /^(mdh|user-content-|cmt-)/;
const RESERVED_IDS = new Set(['footnote-label']);
// md-to-html・注釈・コメント配信先が文書の外で使う id
export const isReservedId = (id) => RESERVED_ID.test(id) || RESERVED_IDS.has(id);

/**
 * 見出しの末尾の記号を切り出す。記号が無ければ null。
 * 使えないときは reason（'使えない名前' か '見出しが空になる'）を返し、使えるときは記号を取り除く strip() を返す。
 * 参照の定義があって `[#名前]` がリンク参照になっているときは、末尾が文字でないので記号にならない。
 * @returns {{ name: string, marker: string, line?: number, reason?: string, strip?: () => void } | null}
 */
export function parseHeadingMarker(heading) {
  const last = heading.children?.[heading.children.length - 1];
  if (last?.type !== 'text') return null;
  const m = HEADING_MARKER.exec(last.value);
  if (!m) return null;
  const name = m[2] ?? m[3];
  const result = { name, marker: m[1], line: heading.position?.start?.line };
  if (isReservedId(name)) return { ...result, reason: '使えない名前' };
  const remaining = last.value.slice(0, m.index);
  // 見出しの中の文中の式（inlineMath）も文字として数える（式だけの見出しを空とみなさない）
  const textOf = (node) => (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath' ? node.value || '' : (node.children || []).map(textOf).join(''));
  const rest = heading.children.slice(0, -1).map(textOf).join('') + remaining;
  if (!rest.trim()) return { ...result, reason: '見出しが空になる' };
  return {
    ...result,
    strip() {
      if (remaining) last.value = remaining;
      else heading.children.pop();
    }
  };
}

// ===========================================================================
// 部品。カード・複数カラム・結合セルの目印を、Markdown の木の上で処理する。
// ===========================================================================

// 目印の書き方。列の数は固定の一覧から写し、原稿の文字をクラス名にしない（N1）。
const LAYOUT_MARKERS = [
  [/^mdh:cards\s+([23])$/, (m) => ({ kind: 'cards', n: m[1] })],
  [/^mdh:columns\s+([23])$/, (m) => ({ kind: 'columns', n: m[1] })],
  [/^mdh:column-break$/, () => ({ kind: 'column-break' })],
  [/^mdh:columns-end$/, () => ({ kind: 'columns-end' })],
  [/^mdh:merge(\s+head=2)?$/, (m) => ({ kind: 'merge', head: m[1] ? 2 : 1 })],
  [/^mdh:tabs$/, () => ({ kind: 'tabs' })],
  [/^mdh:tabs-end$/, () => ({ kind: 'tabs-end' })],
  [/^mdh:(button|heatmap|heatmap primary)$/, () => ({ kind: 'existing' })]
];
const COLUMN_COUNTS = { 2: '2', 3: '3' };
const BLOCK_PARENTS = new Set(['root', 'listItem', 'blockquote', 'footnoteDefinition', 'mdhComponent']);

// html の節点を目印として読む。`<!-- mdh:` で始まらなければ null、書き方に合わなければ kind 'unknown'。
function readMarker(node) {
  if (node?.type !== 'html') return null;
  const value = String(node.value || '').trim();
  if (!/^<!--\s*mdh:/.test(value)) return null;
  const inner = /^<!--([\s\S]*?)-->$/.exec(value);
  const base = { marker: value, line: node.position?.start?.line };
  if (inner) {
    const text = inner[1].trim();
    for (const [re, make] of LAYOUT_MARKERS) {
      const m = re.exec(text);
      if (m) return { ...base, ...make(m) };
    }
  }
  return { ...base, kind: 'unknown' };
}

/**
 * 段落などの行内にある `<!-- mdh:` の html を「段落の中の目印」として返す。既存の目印を取り除く前の木に当てる。
 * @returns {Array<{ line: number, reason: string, marker: string }>}
 */
export function findInlineMarkerWarnings(tree) {
  const warnings = [];
  const walk = (node, parent) => {
    if (node.type === 'html' && parent && !BLOCK_PARENTS.has(parent.type)) {
      const value = String(node.value || '').trim();
      if (/^<!--\s*mdh:/.test(value)) warnings.push({ line: node.position?.start?.line, reason: '段落の中の目印', marker: value });
    }
    for (const child of node.children || []) walk(child, node);
  };
  walk(tree, null);
  return warnings;
}

// リンク付きカードにできない、HTML で押せる要素になるもの
function hasClickable(nodes) {
  const found = (node) => {
    if (['link', 'linkReference', 'footnoteReference'].includes(node.type)) return true;
    // 内側から処理するので、中のリンク付きカードはもう部品の a になっている
    if (node.type === 'mdhComponent' && node.data?.hName === 'a') return true;
    // タブはラジオボタンとラベルなので、リンクの中に入れられない
    if (node.type === 'mdhComponent' && node.data?.mdhKind === 'tabs') return true;
    if (node.type === 'blockquote' && blockquoteComponent(node)?.kind === 'toggle') return true;
    if (node.type === 'table' && node.data?.hProperties?.['data-mdh-heatmap']) return true;
    if (node.type === 'listItem' && node.checked != null) return true;
    return (node.children || []).some(found);
  };
  return nodes.some(found);
}

const CARD_ICON = {
  type: 'mdhComponent',
  data: {
    hName: 'svg',
    hProperties: { className: ['mdh-card-icon'], viewBox: '0 0 28 28', fill: 'none', stroke: 'currentColor', strokeWidth: '1', strokeLinecap: 'round', strokeLinejoin: 'round', ariaHidden: 'true' },
    hChildren: [
      { type: 'element', tagName: 'path', properties: { d: 'M9 19L19 9' }, children: [] },
      { type: 'element', tagName: 'path', properties: { d: 'M11 9h8v8' }, children: [] }
    ]
  },
  children: []
};

// 箇条書きの 1 項目を 1 枚のカードにする。リンク付きカードにできなかったときは clickable を true で返す。
function buildCard(item) {
  const [first, ...blocks] = item.children;
  const lines = splitLines(first);
  let title = first.children;
  let sub = null;
  const body = [];
  if (lines) {
    const [head, ...rest] = lines;
    title = trimInline(head.nodes);
    const second = rest[0] && trimInline(rest[0].nodes);
    if (second?.length === 1 && second[0].type === 'emphasis') {
      sub = second[0].children;
      rest.shift();
    }
    if (rest.length) body.push({ ...first, children: joinLines([{ ...rest[0], viaBreak: false }, ...rest.slice(1)]) });
  }
  body.push(...blocks);
  const link = title.length === 1 && title[0].type === 'link' ? title[0] : null;
  const clickable = link ? hasClickable([...link.children, ...(sub || []), ...body]) : false;
  const parts = (titleNodes) => [
    component('p', 'mdh-card-title', titleNodes),
    ...(sub ? [component('p', 'mdh-card-sub', sub)] : []),
    component('div', 'mdh-card-body', body)
  ];
  const card = link && !clickable
    ? component('a', 'mdh-card mdh-card-link', [structuredClone(CARD_ICON), ...parts(link.children)], { href: link.url, ...(link.title ? { title: link.title } : {}) })
    : component('div', 'mdh-card', parts(title));
  card.data.mdhKind = 'card';
  card.position = link && !clickable ? link.position : item.position;
  return { card, clickable };
}

// カードの並び。カードにできなければ null を返し、警告を出す。
function buildCards(list, info, warn) {
  const bad = list.children.find((item) => item.children?.[0]?.type !== 'paragraph' || item.checked != null);
  if (bad) {
    warn({ line: bad.position?.start?.line ?? info.line, reason: 'カードにならない項目', marker: info.marker });
    return null;
  }
  const cards = list.children.map((item) => {
    const { card, clickable } = buildCard(item);
    if (clickable) warn({ line: item.position?.start?.line ?? info.line, reason: 'リンク付きカードの中に押せる要素', marker: info.marker });
    return card;
  });
  return { ...component('div', `mdh-cards mdh-cards-${COLUMN_COUNTS[info.n]}`, cards), position: list.position };
}

const cellSymbol = (cell) => (cell.children?.length === 1 && cell.children[0].type === 'text' ? cell.children[0].value.trim() : null);

// 結合セルの判定。成り立てば表のセルに結合の印を付けて true、成り立たなければ理由を返す。
function mergeTable(table, head) {
  const width = table.children[0]?.children?.length || 0;
  const rows = table.children.map((row) => {
    const cells = row.children.slice(0, width);
    while (cells.length < width) cells.push({ type: 'tableCell', children: [] });
    return cells;
  });
  const owner = rows.map(() => []);
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const symbol = cellSymbol(rows[r][c]);
      if (symbol === '^') {
        // 見出しの最後の行と本文の最初の行をまたぐ ^ は結合しない
        if (r === 0 || r === head) return { reason: '結合先が無い' };
        owner[r][c] = owner[r - 1][c];
      } else if (symbol === '<') {
        if (c === 0) return { reason: '結合先が無い' };
        owner[r][c] = owner[r][c - 1];
      } else {
        owner[r][c] = r * width + c;
      }
    }
  }
  const spans = new Map();
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const o = owner[r][c];
      const s = spans.get(o) || { r0: r, c0: c, r1: r, c1: c, count: 0 };
      s.r0 = Math.min(s.r0, r); s.c0 = Math.min(s.c0, c); s.r1 = Math.max(s.r1, r); s.c1 = Math.max(s.c1, c); s.count += 1;
      spans.set(o, s);
    }
  }
  for (const s of spans.values()) {
    if (s.count !== (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1)) return { reason: '結合が長方形にならない' };
  }
  const setProps = (node, props) => {
    node.data ||= {};
    node.data.hProperties = { ...(node.data.hProperties || {}), ...props };
  };
  rows.forEach((cells, r) => {
    cells.forEach((cell, c) => {
      if (owner[r][c] !== r * width + c) {
        setProps(cell, { dataMdhMerged: 'true' });
        return;
      }
      const s = spans.get(owner[r][c]);
      const props = {};
      if (s.r1 > s.r0) props.rowSpan = s.r1 - s.r0 + 1;
      if (s.c1 > s.c0) props.colSpan = s.c1 - s.c0 + 1;
      if (Object.keys(props).length) setProps(cell, props);
    });
    table.children[r].children = cells;
  });
  setProps(table, { dataMdhMergeHead: String(head) });
  return { merged: true };
}

// カラムの範囲。start から同じ親の後ろの兄弟の columns-end までを探し、見つからなければ null。
function collectColumns(children, start, warn) {
  const info = readMarker(children[start]);
  const ranges = [[]];
  const nested = [];
  for (let i = start + 1; i < children.length; i += 1) {
    const marker = readMarker(children[i]);
    if (marker?.kind === 'columns-end') {
      for (const n of nested) warn({ line: n.line, reason: '入れ子のカラム', marker: n.marker });
      if (ranges.length !== Number(info.n)) warn({ line: info.line, reason: '区切りの数が合わない', marker: info.marker });
      return { end: i, ranges };
    }
    if (marker?.kind === 'column-break') ranges.push([]);
    else if (marker?.kind === 'columns') nested.push(marker);
    else ranges[ranges.length - 1].push(children[i]);
  }
  return null;
}

// 1 つの親の子を前から処理する。子の親は先に処理してある。
function processChildren(children, warn) {
  const out = [];
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    const info = readMarker(node);
    if (!info) {
      out.push(node);
      continue;
    }
    if (info.kind === 'existing') {
      out.push(node);
      continue;
    }
    if (info.kind === 'unknown') {
      warn({ line: info.line, reason: '知らない目印', marker: info.marker });
      out.push(node);
      continue;
    }
    if (info.kind === 'tabs') {
      i = processTabs(children, i, info, out, warn);
      continue;
    }
    if (info.kind === 'column-break' || info.kind === 'columns-end' || info.kind === 'tabs-end') {
      warn({ line: info.line, reason: '対応する始まりが無い', marker: info.marker });
      continue;
    }
    if (info.kind === 'columns') {
      const found = collectColumns(children, i, warn);
      if (!found) {
        warn({ line: info.line, reason: '終わりの目印が無い', marker: info.marker });
        continue;
      }
      const columns = found.ranges.map((range) => component('div', 'mdh-column', processChildren(range, warn)));
      out.push({ ...component('div', `mdh-columns mdh-columns-${COLUMN_COUNTS[info.n]}`, columns), position: node.position });
      i = found.end;
      continue;
    }
    const next = children[i + 1];
    if (info.kind === 'cards') {
      if (next?.type !== 'list') {
        warn({ line: info.line, reason: '目印の後ろに対象が無い', marker: info.marker });
        continue;
      }
      const cards = buildCards(next, info, warn);
      out.push(cards || next);
      i += 1;
      continue;
    }
    if (info.kind === 'merge') {
      if (next?.type !== 'table') {
        warn({ line: info.line, reason: '目印の後ろに対象が無い', marker: info.marker });
        continue;
      }
      const result = mergeTable(next, info.head);
      if (result.reason) warn({ line: info.line, reason: result.reason, marker: info.marker });
      out.push(next);
      i += 1;
    }
  }
  return out;
}


// ===========================================================================
// タブ。
// ===========================================================================
const TAB_MAX = 8;
const isTabMarker = (node) => ['tabs', 'tabs-end'].includes(readMarker(node)?.kind);

// 範囲の中の子孫で、先に組まれたタブの節点があるか（引用・リストの中など）
function hasTabsDeep(nodes) {
  return nodes.some((n) => (n.type === 'mdhComponent' && n.data?.mdhKind === 'tabs') || hasTabsDeep(n.children || []));
}
// 子孫のタブの節点を、組む前の本文に戻す
function flattenTabs(nodes) {
  return nodes.flatMap((n) => {
    if (n.type === 'mdhComponent' && n.data?.mdhKind === 'tabs') return flattenTabs(n.data.mdhTabsSource);
    if (n.children) n.children = flattenTabs(n.children);
    return [n];
  });
}

// start の `tabs` から、入れ子の深さを数えて対応する `tabs-end` を探す。見つからなければ null。
function collectTabs(children, start) {
  let depth = 0;
  let nested = false;
  for (let i = start + 1; i < children.length; i += 1) {
    const kind = readMarker(children[i])?.kind;
    if (kind === 'tabs') { depth += 1; nested = true; }
    else if (kind === 'tabs-end') {
      if (depth === 0) return { end: i, range: children.slice(start + 1, i), nested };
      depth -= 1;
    }
  }
  return null;
}

// `tabs` の目印を処理して out へ足し、次に処理する位置の 1 つ前を返す。
function processTabs(children, i, info, out, warn) {
  const found = collectTabs(children, i);
  if (!found) {
    // T12: 目印だけを取り除き、後ろの本文はこのまま処理を続ける
    warn({ line: info.line, reason: '終わりの目印が無い', marker: info.marker });
    return i;
  }
  const plain = (reason) => {
    warn({ line: info.line, reason, marker: info.marker });
    out.push(...processChildren(flattenTabs(found.range.filter((n) => !isTabMarker(n))), warn));
    return found.end;
  };
  if (found.nested || hasTabsDeep(found.range)) return plain('入れ子のタブ');
  // 最初の節点が見出しかは、部品を組む前の範囲で見る（先頭の目印が組んだ後に消えて、見出しが先頭に来るのを防ぐ）
  if (found.range[0]?.type !== 'heading') return plain('タブの見出しが無い');
  // 範囲の中の部品（段組み・カードなど）を先に組み、その中の見出しでタブを分けない
  const range = processChildren(found.range, warn);
  const processedPlain = (reason) => {
    warn({ line: info.line, reason, marker: info.marker });
    out.push(...range);
    return found.end;
  };
  const first = range[0];
  if (first?.type !== 'heading') return processedPlain('タブの見出しが無い');
  const depth = first.depth;
  if (range.some((n) => n.type === 'heading' && n.depth < depth)) return processedPlain('タブの見出しより浅い見出し');
  const groups = [];
  for (const n of range) {
    if (n.type === 'heading' && n.depth === depth) groups.push([]);
    groups[groups.length - 1].push(n);
  }
  if (groups.length < 2 || groups.length > TAB_MAX) return processedPlain(`タブの数は 2〜${TAB_MAX}`);
  const source = range.slice();
  const inputs = [];
  const labels = [];
  const panels = groups.map((group, k) => {
    const input = { type: 'mdhComponent', data: { hName: 'input', hProperties: { type: 'radio', value: String(k + 1), ...(k === 0 ? { checked: true } : {}) } }, children: [] };
    const label = { type: 'mdhComponent', data: { hName: 'label', hProperties: {} }, children: [{ type: 'text', value: '' }] };
    inputs.push(input);
    labels.push(label);
    return component('section', 'mdh-tab-panel', group, { dataMdhTab: String(k + 1) });
  });
  const list = component('div', 'mdh-tab-list', inputs.flatMap((input, k) => [input, labels[k]]), { role: 'radiogroup', ariaLabel: 'タブ' });
  const tabs = { ...component('div', 'mdh-tabs', [list, ...panels]), position: children[i].position };
  // ラベルの文字・名前・id は見出しの id が決まった後に finalizeTabs で入れる
  tabs.data.mdhKind = 'tabs';
  tabs.data.mdhTabsSource = source;
  tabs.data.mdhTabs = { headings: groups.map((g) => g[0]), inputs, labels };
  out.push(tabs);
  return found.end;
}

/**
 * タブのラベルの文字・ラジオボタンの名前と id を入れ、各タブの最初の見出しに mdh-tab-heading を付ける。
 * collectHeadings が見出しの id を決めた後に呼ぶ。usedIds は見出しの id の集合。
 */
export function finalizeTabs(tree, usedIds, textOf) {
  let n = 0;
  const walk = (node) => {
    if (node.type === 'mdhComponent' && node.data?.mdhKind === 'tabs') {
      n += 1;
      const name = `mdh-tabs-${n}`;
      const { headings, inputs, labels } = node.data.mdhTabs;
      inputs.forEach((input, k) => {
        let id = `${name}-${k + 1}`;
        if (usedIds.has(id)) {
          let x = 2;
          while (usedIds.has(`${id}-${x}`)) x += 1;
          id = `${id}-${x}`;
        }
        usedIds.add(id);
        Object.assign(input.data.hProperties, { name, id });
        labels[k].data.hProperties.htmlFor = id;
        // 記号にならずに見出しの文字に残った末尾の `[#…]`・`{#…}` は、ラベルの文字からだけ取り除く
        labels[k].children = [{ type: 'text', value: textOf(headings[k]).replace(HEADING_MARKER, '').trim() }];
        const h = headings[k];
        h.data ||= {};
        h.data.hProperties ||= {};
        h.data.hProperties.className = [...new Set([...(h.data.hProperties.className || []), 'mdh-tab-heading'])];
      });
    }
    (node.children || []).forEach(walk);
  };
  walk(tree);
}

/**
 * カード・複数カラム・結合セルの目印を処理する。既存の目印（mdh:button・mdh:heatmap）を取り除いた後の木に当てる。
 * 親を内側から処理し、組み替えた節点は型 `mdhComponent` にする（カードには data.mdhKind = 'card'）。警告は onWarning へ { line, reason, marker } で渡す。
 */
export function applyLayoutMarkers(tree, { onWarning } = {}) {
  const warn = (w) => onWarning?.(w);
  const walk = (node) => {
    if (!node.children || !BLOCK_PARENTS.has(node.type) && node.type !== 'list') return;
    for (const child of node.children) walk(child);
    if (BLOCK_PARENTS.has(node.type)) node.children = processChildren(node.children, warn);
  };
  walk(tree);
}
