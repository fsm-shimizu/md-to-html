import GithubSlugger from 'github-slugger';
import { unified } from 'unified';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import { rehypeSanitizeUrls, isSafeUrl } from './url-safety.mjs';
import { GENERATOR_META } from './generator-marker.mjs';
import { remarkComponents, blockquoteComponent, parseHeadingMarker, isReservedId, applyLayoutMarkers, findInlineMarkerWarnings, finalizeTabs } from './components.mjs';
import { oneLineTitle } from './title.mjs';

export function collectText(node) {
  if (!node) return '';
  // 見出しの中の文中の式は TeX の原文を目次の文字と id に使う
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath') return node.value || '';
  if (!node.children) return '';
  return node.children.map(collectText).join('');
}

// 見出しに id を割り当て、目次の項目を返す。
// 1 回目の走査で見出しの末尾の記号の名前を集め（最初の出現だけ）、2 回目で文書の順に、記号の名前か自動の id を割り当てる。
// 部品（コールアウト・折りたたみ）の中の見出しも同じ順序で id を持ち、目次の項目にだけ inComponent を付ける。
// 記号にならなかった記号は onWarning へ { line, reason, marker } で渡す。
export function collectHeadings(tree, { onWarning } = {}) {
  // 既存の目印（mdh:heatmap・mdh:button）を先に取り除き、目次と警告が本文（renderMarkdown）と同じ木で部品を判定するようにする。
  // renderMarkdown で同じ処理をもう一度通しても、目印はもう無いので何も変わらない。
  // 段落の中の行内の目印の警告は、既存の目印を取り除く前に集める（既存の目印の処理は行内の目印も消すため）。
  // 2b の目印（カード・複数カラム・結合セル）は既存の目印を取り除いた後に処理し、目次と本文が組み替えた後の同じ木を見るようにする。
  for (const w of findInlineMarkerWarnings(tree)) onWarning?.(w);
  markHeatmapTables(tree);
  markButtonLinks(tree);
  applyLayoutMarkers(tree, { onWarning });
  const entries = [];
  const walk = (node, inComponent) => {
    if (node.type === 'heading') {
      entries.push({ node, inComponent, marker: parseHeadingMarker(node) });
      return;
    }
    // カードの中の見出しも目次に出さない。複数カラムの中は普通の本文と同じに目次に出す
    // タブの中の見出しも目次に出さない（選ばれていないタブの見出しへは画面上で移れない）
    const inside = inComponent || (node.type === 'blockquote' && blockquoteComponent(node) !== null) || (node.type === 'mdhComponent' && ['card', 'tabs'].includes(node.data?.mdhKind));
    for (const child of node.children || []) walk(child, inside);
  };
  walk(tree, false);

  const markerNames = new Set(entries.filter((e) => e.marker && !e.marker.reason).map((e) => e.marker.name));
  const claimed = new Set();
  const slugger = new GithubSlugger();
  const headings = [];
  for (const { node, inComponent, marker } of entries) {
    let id = null;
    if (marker?.reason) {
      onWarning?.({ line: marker.line, reason: marker.reason, marker: marker.marker });
    } else if (marker) {
      marker.strip();
      if (claimed.has(marker.name)) onWarning?.({ line: marker.line, reason: '重なった名前', marker: marker.marker });
      else {
        claimed.add(marker.name);
        id = marker.name;
      }
    }
    const text = collectText(node).trim();
    if (id === null) {
      do id = slugger.slug(text || 'section');
      while (markerNames.has(id));
      // 記号を持っていた見出しの自動の id は、記号の文字から作られて使えない名前（接頭辞で決まるので番号を付けても外れない）と
      // 重なりうるので、そのときは section から作り直す。記号の無い見出しは今と同じ id にする。
      if (marker && isReservedId(id)) {
        do id = slugger.slug('section');
        while (markerNames.has(id) || isReservedId(id));
      }
    }
    node.data ||= {};
    node.data.hProperties ||= {};
    node.data.hProperties.id = id;
    headings.push({
      level: node.depth,
      originalDepth: node.data.originalDepth ?? node.depth,
      text,
      id,
      children: [],
      ...(inComponent ? { inComponent: true } : {})
    });
  }
  // タブのラベルの文字と id は、見出しの記号を外して id を決めた後に入れる
  finalizeTabs(tree, new Set(headings.map((h) => h.id)), collectText);

  return headings;
}

export function buildToc(headings) {
  const root = [];
  const stack = [];

  for (const heading of headings) {
    if (heading.inComponent || heading.level > 3 || heading.originalDepth > 3) continue;

    while (stack.length && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }

    if (!stack.length) root.push(heading);
    else stack[stack.length - 1].children.push(heading);
    stack.push(heading);
  }

  return root;
}

export async function renderMarkdown(tree, { hastTransforms = [] } = {}) {
  // XSS防御は2段構え: (1) allowDangerousHtml:false で raw HTML を除去し、
  // (2) rehypeSanitizeUrls で href/src のプロトコルを検査する。
  // rehypeSanitizeUrls は属性URLしか見ないため、allowDangerousHtml を有効化すると
  // 生 <script>/<img onerror> 等が素通りする。この false は防御の前提。変更しないこと。
  //
  // hastTransforms は呼び出し側が差し込む hast 変換（(tree, file) => void | Promise<void>）。
  // 挿入位置は rehypeEnhanceTables の後・rehypeSanitizeUrls の前で固定する。
  // 「rehypeSanitizeUrls が最後の AST mutation」は不変条件であり、
  // 変換が生成した URL も必ず sanitize を通す。この順序を変更しないこと。
  if (!Array.isArray(hastTransforms)) {
    throw new TypeError('renderMarkdown: hastTransforms must be an array of functions');
  }

  const processor = unified()
    .use(remarkMarkHeatmapTables)
    .use(remarkMarkButtonLinks)
    .use(remarkComponents)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeEnhanceTables)
    .use(rehypeExternalLinks)
    .use(rehypeButtonLinks);

  for (const transform of hastTransforms) {
    if (typeof transform !== 'function') {
      throw new TypeError('renderMarkdown: each hastTransform must be a function');
    }
    processor.use(() => transform);
  }

  processor.use(rehypeSanitizeUrls).use(rehypeStringify);
  const hast = await processor.run(tree);
  return processor.stringify(hast);
}

// http(s) の外部リンクだけ新しいタブで開く（rel は opener 遮断のため必須）。
// #・相対・mailto・tel は対象外。href の可否判定は後段の rehypeSanitizeUrls が担う。
export function rehypeExternalLinks() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'a' || !node.properties) return;
      const href = node.properties.href;
      if (typeof href !== 'string' || !/^https?:\/\//i.test(href.trim())) return;
      node.properties.target = '_blank';
      node.properties.rel = ['noopener', 'noreferrer'];
    });
  };
}

const BUTTON_MARKER = '<!-- mdh:button -->';
const BUTTON_PROPERTY = 'data-mdh-button';

// 静的版だけで、単独行の `<!-- mdh:button -->` 直後にある「リンク 1 つだけの段落」へ印を渡す。
// 対象が無い場合もマーカーは出力しない。
export function remarkMarkButtonLinks() {
  return (tree) => {
    markButtonLinks(tree);
  };
}

function markButtonLinks(parent) {
  const children = parent.children || [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (node?.type === 'html' && String(node.value || '').trim() === BUTTON_MARKER) {
      const next = children[index + 1];
      if (next?.type === 'paragraph' && next.children?.length === 1 && next.children[0].type === 'link') {
        next.data ||= {};
        next.data.hProperties ||= {};
        next.data.hProperties[BUTTON_PROPERTY] = 'true';
      }
      children.splice(index, 1);
      index -= 1;
      continue;
    }
    if (node?.children) markButtonLinks(node);
  }
}

export function rehypeButtonLinks() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'p' || node.properties?.[BUTTON_PROPERTY] !== 'true') return;
      delete node.properties[BUTTON_PROPERTY];
      const link = (node.children || []).find((child) => child.type === 'element' && child.tagName === 'a');
      if (!link) return;
      addClass(node, 'mdh-button-row');
      addClass(link, 'mdh-button');
    });
  };
}

// ヒートマップの塗り色（リンク色 #1B63AC の RGB）。描画・検証・単体テストの 3 か所がこの定数を共有する。
export const HEAT_RGB = '27,99,172';
const HEATMAP_MARKER = '<!-- mdh:heatmap -->';
const HEATMAP_MARKER_PRIMARY = '<!-- mdh:heatmap primary -->';
const HEATMAP_PROPERTY = 'data-mdh-heatmap';

// 静的版だけで、単独行のマーカー直後にある table ノードへ印を渡す。
// build_editable_notion_html.mjs の編集プレビューはこの remark プラグインを通らない。
export function remarkMarkHeatmapTables() {
  return (tree) => {
    markHeatmapTables(tree);
  };
}

function markHeatmapTables(parent) {
  const children = parent.children || [];
  let marked = false;
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (node?.type === 'html') {
      const trimmedValue = String(node.value || '').trim();
      const mode = trimmedValue === HEATMAP_MARKER ? 'true' : trimmedValue === HEATMAP_MARKER_PRIMARY ? 'primary' : null;
      if (mode) {
        const next = children[index + 1];
        if (next?.type === 'table') {
          next.data ||= {};
          next.data.hProperties ||= {};
          next.data.hProperties[HEATMAP_PROPERTY] = mode;
          marked = true;
        }
        // マーカーは表へ伝播した後、または対象表が無い場合も出力しない。
        children.splice(index, 1);
        index -= 1;
        continue;
      }
    }
    if (node?.children && markHeatmapTables(node)) marked = true;
  }
  return marked;
}

export function rehypeEnhanceTables() {
  return (tree) => {
    let heatmapIndex = 0;
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'table') return;
      if (node.properties?.dataMdhMergeHead) {
        if (parent && typeof index === 'number') {
          parent.children[index] = enhanceMergedTable(node);
          return index + 1;
        }
        return;
      }
      const heatmapMode = node.properties?.[HEATMAP_PROPERTY];
      const heatmapEnabled = heatmapMode === 'true' || heatmapMode === 'primary';
      if (heatmapEnabled) delete node.properties[HEATMAP_PROPERTY];
      enhanceTable(node, { heatmapEnabled, heatmapMode: heatmapMode === 'primary' ? 'primary' : 'default' });
      // 列数が多い表は本文幅に収まらないことがあるため、横スクロールできる枠で包む。
      // 表自体の overflow:hidden（角丸用）は残し、枠側だけが scroll する。
      if (parent && typeof index === 'number' && !(parent.properties?.className || []).includes('mdh-table-scroll')) {
        if (heatmapEnabled) {
          heatmapIndex += 1;
          parent.children[index] = createHeatmapBlock(node, heatmapIndex);
        } else {
          parent.children[index] = createTableScroll(node);
        }
        return index + 1;
      }
    });
  };
}

// 数値だけのセル（例: 1,119 / 48% / 579→422 / 30 人未満 / 2025-08-18）を判定する。
// 数字・区切り記号・矢印と、単位として使う短い語だけで構成されていれば数値セルとみなす。
const NUMERIC_TOKEN = /^[0-9０-９][0-9０-９,.\-+±%〜~/:]*%?$/;
const NUMERIC_UNITS = new Set(['人', '人未満', '件', '件未満', '名', '回', '円', '%', '％', '万円', '千円', 'pt', 'px', '位', '倍', '点', '日', '時間', '分', '秒', 'km', 'm', '㎡', 'ha']);
export function isNumericCellText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !/[0-9０-９]/.test(trimmed)) return false;
  const tokens = trimmed.split(/[\s→⇒➡]+/).filter(Boolean);
  return tokens.every((token) => NUMERIC_TOKEN.test(token) || NUMERIC_UNITS.has(token) || /^[0-9０-９][0-9０-９,.]*(人未満|人|件|名|回|円|万円|千円|位|倍|点|日|時間|分|秒|km|m|㎡|ha)$/.test(token));
}

const HEATMAP_NUMBER = /(?<!\d)([+-]?(?:\d+(?:[.,]\d+)*|\.\d+))(?:\s*(?:%|％))?(?:\s*(人未満|件未満))?/g;
const HEATMAP_EXCLUDED_HEADERS = new Set(['#', 'No', 'No.', '番号']);

function normalizeHeatmapDigits(value) {
  return value
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replaceAll('，', ',')
    .replaceAll('．', '.');
}

// セル内の最後の数値トークンをヒートマップ用の値へ変換する。
// 人未満／件未満は秘匿値なので、数値として扱わず null を返す。
export function extractHeatmapValue(text) {
  const normalized = normalizeHeatmapDigits(String(text ?? ''));
  const matches = [...normalized.matchAll(HEATMAP_NUMBER)];
  const last = matches.at(-1);
  if (!last || last[2]) return null;
  const value = Number(last[1].replaceAll(',', ''));
  return Number.isFinite(value) ? value : null;
}

// 主値モード: 括弧補足（中身が数字・区切り・単位語だけ）の許容文字。
// ブリーフの列挙（数字・/・／・空白・%・人・組・件・回・日・km）に、小数点付き数値
// （26.7% 等）を許容するため小数点・桁区切り（. ,）を加えている（DECISIONS 記載の仕様外判断）。
const HEATMAP_PAREN_CONTENT_ALLOWED = /^[0-9０-９,.\s/／%％人組件回日km]*$/;
const HEATMAP_PAREN_GROUP = /[（(]([^()]*)[）)]/g;
const HEATMAP_SLASH_SEGMENT_SOURCE = '[0-9０-９][0-9０-９,.]*\\s*(?:人|組|件|回|日|km|%|％)?';
const HEATMAP_SLASH_PATTERN = new RegExp(`^${HEATMAP_SLASH_SEGMENT_SOURCE}\\s*[/／]\\s*${HEATMAP_SLASH_SEGMENT_SOURCE}$`);
const HEATMAP_PRIMARY_PERCENT = /(?<!\d)([+-]?(?:\d+(?:[.,]\d+)*|\.\d+))\s*[%％]/g;
const HEATMAP_PRIMARY_NUMBER = /(?<!\d)([+-]?(?:\d+(?:[.,]\d+)*|\.\d+))/g;

function stripHeatmapParens(text) {
  return text.replace(HEATMAP_PAREN_GROUP, (match, inner) => (
    HEATMAP_PAREN_CONTENT_ALLOWED.test(inner) ? ' ' : match
  ));
}

function isSlashSeparatedNumericText(text) {
  return HEATMAP_SLASH_PATTERN.test(String(text || '').trim());
}

// 主値モードの数値セル判定（R2）: 従来の数値セル（isNumericCellText）に加え、
// (a) 括弧補足を除いた残りが数値セルであるもの、(b) `/`・`／` で区切られた数値を数値セルとみなす。
// 既定モードの isNumericCellText はシグネチャ・挙動とも変えない。
export function isNumericCellTextPrimary(text) {
  // 全角％は主値モードの判定だけで半角へ寄せる（既定モードの isNumericCellText は変えない）。
  const trimmed = String(text || '').trim().replaceAll('％', '%');
  if (!trimmed) return false;
  if (isNumericCellText(trimmed)) return true;
  if (isSlashSeparatedNumericText(trimmed)) return true;

  const stripped = stripHeatmapParens(trimmed).replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== trimmed) {
    if (isNumericCellText(stripped)) return true;
    if (isSlashSeparatedNumericText(stripped)) return true;
  }
  return false;
}

// 主値モードの値（R3）: `%`／`％` があれば最初の%値、無ければ最初の数値。
// `人未満`・`件未満` を含むセルは null（着色しない）。既定モードの extractHeatmapValue は変えない。
export function extractHeatmapValuePrimary(text) {
  const raw = String(text ?? '');
  if (/人未満|件未満/.test(raw)) return null;

  const normalized = normalizeHeatmapDigits(raw);
  const percentMatches = [...normalized.matchAll(HEATMAP_PRIMARY_PERCENT)];
  if (percentMatches.length) {
    const value = Number(percentMatches[0][1].replaceAll(',', ''));
    return Number.isFinite(value) ? value : null;
  }

  const numberMatches = [...normalized.matchAll(HEATMAP_PRIMARY_NUMBER)];
  if (numberMatches.length) {
    const value = Number(numberMatches[0][1].replaceAll(',', ''));
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

function addClass(node, className) {
  node.properties ||= {};
  node.properties.className = [...new Set([...(node.properties.className || []), className])];
}

function enhanceTable(table, { heatmapEnabled = false, heatmapMode = 'default' } = {}) {
  const headerRow = findFirstElement(table, 'tr', (row) => elementChildren(row, 'th').length > 0);
  const headers = headerRow ? elementChildren(headerRow, 'th') : [];
  const rows = findElements(table, 'tr').filter((row) => elementChildren(row, 'td').length > 0);

  // 数値セルは折り返さず右寄せにする。列の本文セルがすべて数値なら見出しセルも同じ扱いにし、列幅を内容に合わせて詰める。
  // この判定（mdh-num）は主値モードでも isNumericCellText のまま変えない（仕様外判断: DECISIONS 参照）。
  const numericByColumn = new Map();
  for (const row of rows) {
    elementChildren(row, 'td').forEach((cell, index) => {
      const numeric = isNumericCellText(collectHastText(cell));
      if (numeric) addClass(cell, 'mdh-num');
      numericByColumn.set(index, (numericByColumn.get(index) ?? true) && numeric);
    });
  }
  headers.forEach((cell, index) => {
    if (numericByColumn.get(index)) addClass(cell, 'mdh-num');
  });

  if (heatmapEnabled) {
    if (heatmapMode === 'primary') {
      const numericByColumnPrimary = new Map();
      for (const row of rows) {
        elementChildren(row, 'td').forEach((cell, index) => {
          const numeric = isNumericCellTextPrimary(collectHastText(cell));
          numericByColumnPrimary.set(index, (numericByColumnPrimary.get(index) ?? true) && numeric);
        });
      }
      addHeatmapCells(headers, rows, numericByColumnPrimary, { mode: 'primary' });
    } else {
      addHeatmapCells(headers, rows, numericByColumn, { mode: 'default' });
    }
  }

  if (headers.length < 3) return;

  addClass(table, 'mdh-stackable-table');
  const labels = headers.map((cell) => collectHastText(cell).trim());

  for (const row of rows) {
    elementChildren(row, 'td').forEach((cell, index) => {
      if (!labels[index]) return;
      cell.properties ||= {};
      cell.properties.dataLabel = labels[index];
    });
  }
}

// 既定モードの除外見出し（#・No・No.・番号）は両モードで有効。
// 主値モードはさらに「順位」を含む見出し列を除外する（順位は小さいほど上位で、大小の色が逆に読まれるため）。
function isHeatmapHeaderExcluded(headerText, mode) {
  if (HEATMAP_EXCLUDED_HEADERS.has(headerText)) return true;
  if (mode === 'primary' && headerText.includes('順位')) return true;
  return false;
}

function addHeatmapCells(headers, rows, numericByColumn, { mode = 'default' } = {}) {
  const extractValue = mode === 'primary' ? extractHeatmapValuePrimary : extractHeatmapValue;
  headers.forEach((header, index) => {
    if (!numericByColumn.get(index)) return;
    const headerText = collectHastText(header).trim();
    if (isHeatmapHeaderExcluded(headerText, mode)) return;

    const entries = rows
      .map((row) => elementChildren(row, 'td')[index])
      .filter(Boolean)
      .map((cell) => ({ cell, value: extractValue(collectHastText(cell)) }))
      .filter(({ value }) => value !== null);
    const values = entries.map(({ value }) => value);
    if (new Set(values).size < 2) return;

    const min = Math.min(...values);
    const max = Math.max(...values);
    for (const { cell, value } of entries) {
      const alpha = (0.10 + ((value - min) / (max - min)) * 0.45).toFixed(2);
      addClass(cell, 'mdh-heat');
      cell.properties ||= {};
      cell.properties.style = `--mdh-heat: rgba(${HEAT_RGB},${alpha})`;
    }
  });
}

// 結合した表。applyLayoutMarkers が付けた印（data-mdh-merge-head・data-mdh-merged）を読んで取り除き、
// 結合で消えるセルを取り除き、head=2 なら本文の 1 行目を見出しへ移す。enhanceTable（3 列以上の印と列の見出しの data-label・ヒートマップ）は通さない。
function enhanceMergedTable(table) {
  const head = Number(table.properties.dataMdhMergeHead);
  delete table.properties.dataMdhMergeHead;
  delete table.properties[HEATMAP_PROPERTY];
  const thead = elementChildren(table, 'thead')[0];
  const tbody = elementChildren(table, 'tbody')[0];
  if (head === 2 && thead && tbody) {
    const [moved] = elementChildren(tbody, 'tr');
    if (moved) {
      tbody.children = tbody.children.filter((child) => child !== moved);
      for (const cell of elementChildren(moved, 'td')) cell.tagName = 'th';
      thead.children.push({ type: 'text', value: '\n' }, moved);
      if (!elementChildren(tbody, 'tr').length) table.children = table.children.filter((child) => child !== tbody);
    }
  }
  const cells = (row) => (row.children || []).filter((child) => child.type === 'element' && (child.tagName === 'td' || child.tagName === 'th'));
  const isMerged = (cell) => Boolean(cell.properties?.dataMdhMerged);
  // 数値の右寄せ: 本文のセルはそのセルの文字で、見出しのセルは結合していない列の上にあり、その列の本文のセルがすべて数値のときだけ。
  // 列の位置は、結合で消えるセルを取り除く前の格子で数える。
  const bodyRows = tbody ? elementChildren(tbody, 'tr') : [];
  const numericByColumn = new Map();
  for (const row of bodyRows) {
    cells(row).forEach((cell, index) => {
      if (isMerged(cell)) return;
      const numeric = isNumericCellText(collectHastText(cell));
      if (numeric) addClass(cell, 'mdh-num');
      // 横に結合したセルは、覆う列すべての判定に入れる
      for (let c = index; c < index + (Number(cell.properties?.colSpan) || 1); c += 1) numericByColumn.set(c, (numericByColumn.get(c) ?? true) && numeric);
    });
  }
  for (const row of thead ? elementChildren(thead, 'tr') : []) {
    cells(row).forEach((cell, index) => {
      if (!isMerged(cell) && !cell.properties?.colSpan && numericByColumn.get(index)) addClass(cell, 'mdh-num');
    });
  }
  for (const row of findElements(table, 'tr')) {
    row.children = (row.children || []).filter((child) => !(child.type === 'element' && isMerged(child)));
  }
  addClass(table, 'mdh-merged-table');
  return { type: 'element', tagName: 'div', properties: { className: ['mdh-merged-scroll'] }, children: [table] };
}

function createTableScroll(table) {
  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['mdh-table-scroll'] },
    children: [table]
  };
}

function createHeatmapBlock(table, index) {
  const name = `mdh-view-${index}`;
  const input = (view, checked = false) => ({
    type: 'element',
    tagName: 'input',
    properties: {
      type: 'radio',
      name,
      id: `${name}-${view}`,
      value: view,
      ...(checked ? { checked: true } : {})
    },
    children: []
  });
  const label = (view, text) => ({
    type: 'element',
    tagName: 'label',
    properties: { htmlFor: `${name}-${view}` },
    children: [{ type: 'text', value: text }]
  });

  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['mdh-table-block', 'mdh-heatmap-enabled'] },
    children: [
      {
        type: 'element',
        tagName: 'div',
        properties: { className: ['mdh-view-toggle'], role: 'group', ariaLabel: '表の表示方法' },
        children: [input('table', true), label('table', '表'), input('heatmap'), label('heatmap', 'ヒートマップ')]
      },
      createTableScroll(table)
    ]
  };
}

function findFirstElement(node, tagName, predicate = () => true) {
  if (node?.type === 'element' && node.tagName === tagName && predicate(node)) return node;
  for (const child of node?.children || []) {
    const found = findFirstElement(child, tagName, predicate);
    if (found) return found;
  }
  return null;
}

function findElements(node, tagName, results = []) {
  if (node?.type === 'element' && node.tagName === tagName) results.push(node);
  for (const child of node?.children || []) findElements(child, tagName, results);
  return results;
}

function elementChildren(node, tagName) {
  return (node.children || []).filter((child) => child.type === 'element' && child.tagName === tagName);
}

function collectHastText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  return (node.children || []).map(collectHastText).join('');
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// 目次のリンク先。見出しの記号の名前は % を含みうるので %25 にする（TOC_CURRENT_SCRIPT の decodeURIComponent とブラウザの移動で元の id に戻る）。
// 自動の id は % を含まないので、今までの出力は変わらない。
const tocFragment = (id) => escapeHtml(String(id).replaceAll('%', '%25'));

export function renderToc(nodes) {
  return nodes
    .map((node) => {
      if (node.level === 3) {
        return `<a class="mdh-toc-h3" href="#${tocFragment(node.id)}" title="${escapeHtml(node.text)}">${escapeHtml(node.text)}</a>`;
      }

      const cls = `mdh-toc-node mdh-toc-h${node.level}`;
      const title = `<a class="mdh-toc-title mdh-toc-title-h${node.level}" href="#${tocFragment(node.id)}" title="${escapeHtml(node.text)}">${escapeHtml(node.text)}</a>`;
      if (!node.children.length) {
        return `<div class="${cls} mdh-toc-leaf"><span class="mdh-toc-spacer" aria-hidden="true"></span>${title}</div>`;
      }

      const open = node.level === 2 ? ' open' : '';
      return `<div class="${cls}"><details class="mdh-toc-disclosure"${open}><summary aria-label="${escapeHtml(node.text)}を開閉"></summary><div class="mdh-toc-children">${renderToc(node.children)}</div></details>${title}</div>`;
    })
    .join('');
}

export function renderMeta(data) {
  const entries = [];
  for (const key of ['date', 'author', 'status']) {
    if (data[key]) entries.push([key, formatMetaValue(data[key])]);
  }
  if (Array.isArray(data.tags) && data.tags.length) {
    entries.push(['tags', data.tags.map(formatMetaValue).join(', ')]);
  }
  if (!entries.length) return '';

  return `<div class="mdh-meta">${entries
    .map(([key, value]) => `<span class="mdh-pill">${escapeHtml(key)}: ${escapeHtml(value)}</span>`)
    .join('')}</div>`;
}

export function formatMetaValue(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(formatMetaValue).join(', ');
  return String(value);
}

// 文書の種類。名前の無い種類は表紙と印刷の目次を付けない。
export const DOC_TYPES = {
  analysis: '分析レポート',
  proposal: '提案書',
  policy: null,
  manual: '手順書',
  report: 'ご報告',
  handover: '引き継ぎ資料'
};

// 表紙の日付。Date と、YYYY-MM-DD と、Date を JSON にした形の文字列は UTC の年月日で組む。編集版は JSON で往復するので後者で届く。
const JSON_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function formatCoverDate(value) {
  const date = value instanceof Date ? value
    : typeof value === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(value) || JSON_DATE.test(value)) ? new Date(value) : null;
  if (date && !Number.isNaN(date.getTime())) return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  return formatMetaValue(value);
}

// 印刷の 1 頁目の表紙と 2 頁目の目次。見出しの要素を使わない（コメント配信先の節分けに入らない）。
function renderPrintFront(data, title, toc) {
  const kind = typeof data?.type === 'string' && Object.hasOwn(DOC_TYPES, data.type) ? DOC_TYPES[data.type] : null;
  if (!kind) return '';
  const has = (v) => v !== undefined && v !== null && String(formatMetaValue(v)).trim() !== '';
  const lines = [
    `<p class="mdh-cover-kind">${escapeHtml(kind)}</p>`,
    `<p class="mdh-cover-title">${String(title).split('\n').map(escapeHtml).join('<br>')}</p>`
  ];
  if (has(data.to)) lines.push(`<p class="mdh-cover-to">${escapeHtml(formatMetaValue(data.to))}</p>`);
  const foot = [has(data.date) ? formatCoverDate(data.date) : null, has(data.author) ? formatMetaValue(data.author) : null].filter(Boolean);
  if (foot.length) lines.push(`<p class="mdh-cover-foot">${foot.map((v) => `<span>${escapeHtml(v)}</span>`).join('')}</p>`);
  const items = toc.flatMap((node) => [[1, node], ...node.children.map((child) => [2, child])])
    .map(([level, node]) => `<li class="mdh-print-toc-l${level}"><a href="#${tocFragment(node.id)}">${escapeHtml(node.text)}</a></li>`).join('');
  const nav = items ? `<nav class="mdh-print-toc" aria-label="印刷用の目次"><p class="mdh-print-toc-label">目次</p><ol>${items}</ol></nav>` : '';
  return `\n      <div class="mdh-print-front"><section class="mdh-cover" aria-label="表紙">${lines.join('')}</section>${nav}</div>`;
}

// hubLink 指定時のみ main の第1子として出力するハブナビ。
// .mdh-shell は aside + main の2列 grid のため shell 直下には足さない（grid 非干渉）。
// 値型は `{ href, label = '索引' }` のオブジェクトのみ（文字列短縮形は受けない）。
// この nav は本文 sanitizer（rehypeSanitizeUrls）の外側で文字列生成されるため、
// href は同じ isSafeUrl() で検査し、危険スキームは TypeError で落とす。
function renderHubNav(hubLink) {
  if (!hubLink) return '';
  if (typeof hubLink !== 'object' || Array.isArray(hubLink)) {
    throw new TypeError('renderPage: hubLink must be an object like { href, label }');
  }
  const { href, label = '索引' } = hubLink;
  if (typeof href !== 'string' || !href) {
    throw new TypeError('renderPage: hubLink requires a non-empty href');
  }
  if (!isSafeUrl(href)) {
    throw new TypeError(`renderPage: hubLink.href is not a safe URL: ${href}`);
  }
  return `\n      <nav class="mdh-hub-nav"><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></nav>`;
}

// 書体の読み込み。本文は欧文も和文も Noto Sans JP、コードは IBM Plex Mono（LINE Seed JP は読みづらかった）。
// Google Fonts から 2 書体を読む（Noto Sans JP は 400・500・700）。
const FONT_PRECONNECT = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>';
export const FONT_LINKS = {
  google: `${FONT_PRECONNECT}<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@400&display=swap">`
};

export function renderPage({ title, data, toc, bodyHtml }, { hubLink, fonts = 'google' } = {}) {
  if (!Object.hasOwn(FONT_LINKS, fonts)) throw new TypeError(`renderPage: unknown fonts option: ${fonts}`);
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${GENERATOR_META}
  <title>${escapeHtml(oneLineTitle(title))}</title>
  ${FONT_LINKS[fonts]}
  <style>${CSS}${bodyHtml.includes('<div class="mdh-table-block mdh-heatmap-enabled">') ? HEATMAP_CSS : ''}</style>
</head>
<body>
  <div class="mdh-shell" data-editable="false">
    <details class="mdh-settings-menu">
    <summary class="mdh-settings-toggle" data-action="toggle-settings" aria-label="表示の設定"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 6h9M15 6h2M3 14h2M8 14h9"/><circle cx="13.5" cy="6" r="1.8"/><circle cx="6.5" cy="14" r="1.8"/></svg></summary>
    <div class="mdh-settings" id="mdhSettingsPanel" role="group" aria-label="表示の設定">
      <h2>目次</h2>
      <div class="mdh-settings-seg mdh-settings-toc" data-setting="toc" role="radiogroup" aria-label="目次"><label><input type="radio" name="mdh-toc" value="show" checked>表示</label><label><input type="radio" name="mdh-toc" value="hide">非表示</label></div>
      <div class="mdh-settings-switch mdh-settings-drawer"><h3>目次を開く</h3><label><input type="checkbox" name="mdh-toc-drawer" aria-label="目次を開く"></label></div>
      <h2>本文の幅</h2>
      <div class="mdh-settings-seg" data-setting="width" role="radiogroup" aria-label="本文の幅"><label><input type="radio" name="mdh-width" value="normal" checked>標準</label><label><input type="radio" name="mdh-width" value="wide">広め</label><label><input type="radio" name="mdh-width" value="full">最大</label></div>
      <div class="mdh-settings-scripted">
      <h2>見出しの色</h2>
      <div class="mdh-settings-item">
        <div class="mdh-settings-switch"><h3>背景帯</h3><button type="button" data-setting="band.on" aria-pressed="false" aria-label="背景帯"></button></div>
        <div data-sub="band"><div class="mdh-settings-levels" data-setting="band.levels" role="group" aria-label="背景帯を付ける見出し"><button type="button" data-v="h1" aria-pressed="true">h1</button><button type="button" data-v="h2" aria-pressed="false">h2</button><button type="button" data-v="h3" aria-pressed="false">h3</button><button type="button" data-v="h4" aria-pressed="false">h4</button></div><div class="mdh-settings-seg" data-setting="band.shape" role="group" aria-label="背景帯の形"><button type="button" data-v="band" aria-pressed="true">帯</button><button type="button" data-v="bar" aria-pressed="false">帯＋左の線</button></div></div>
      </div>
      <div class="mdh-settings-item">
        <div class="mdh-settings-switch"><h3>文字色</h3><button type="button" data-setting="text.on" aria-pressed="false" aria-label="文字色"></button></div>
        <div data-sub="text"><div class="mdh-settings-levels" data-setting="text.levels" role="group" aria-label="文字色を付ける見出し"><button type="button" data-v="h1" aria-pressed="true">h1</button><button type="button" data-v="h2" aria-pressed="false">h2</button><button type="button" data-v="h3" aria-pressed="false">h3</button><button type="button" data-v="h4" aria-pressed="false">h4</button></div></div>
      </div>
      <button class="mdh-settings-export" type="button" data-action="export-html">HTML を書き出す</button>
      <p class="mdh-settings-status" data-export-status role="status" hidden></p>
      </div>
    </div>
    </details>
    <aside class="mdh-toc" aria-label="table of contents">
      <strong>目次</strong>
      <div class="mdh-toc-tree">${renderToc(toc)}</div>
    </aside>
    <main class="mdh-page">${renderHubNav(hubLink)}${renderPrintFront(data, title, toc)}
      <header class="mdh-title">
        ${renderMeta(data)}
        <h1>${String(title).split('\n').map(escapeHtml).join('<br>')}</h1>
      </header>
      <article class="mdh-doc">${bodyHtml}</article>
    </main>
  </div>
  <script>${SETTINGS_SCRIPT}</script>
  <script>${TOC_CURRENT_SCRIPT}</script>
  <script>${COLUMN_RESIZE_SCRIPT}</script>
  <script>${TABLE_AUTOFILL_SCRIPT}</script>
</body>
</html>`;
}

// 読み手の表示の設定。左上の設定ボタンで開くパネルで、目次の表示、本文の幅、
// 見出しの背景帯と文字色を切り替え、読み手のブラウザに文書ごとに保存し、今の設定を最初の表示として持つ HTML を書き出す。
// 旧 TOC_TOGGLE_SCRIPT（左上の「目次を閉じる」ボタン）の振る舞い（860px 以下は読み込み時に目次を閉じ、目次のリンクで閉じる）を含む。
export const SETTINGS_SCRIPT = `/* mdh:script */
(() => {
  const root = document.documentElement;
  const shell = document.querySelector('.mdh-shell');
  const menu = document.querySelector('details.mdh-settings-menu');
  const toggle = document.querySelector('[data-action="toggle-settings"]');
  const panel = document.getElementById('mdhSettingsPanel');
  if (!shell || !menu || !toggle || !panel) return;
  // スクリプトが動いた印。印が無い（文書のスクリプトを止める配信先）では、スクリプトでしか動かない部品を CSS が隠す。
  root.setAttribute('data-mdh-settings-ready', '');
  const LEVELS = ['h1', 'h2', 'h3', 'h4'];
  const DEFAULTS = { v: 1, toc: 'show', width: 'normal', band: { on: false, levels: ['h1'], shape: 'band' }, text: { on: false, levels: ['h1'] } };
  const KEY = 'mdh-settings:v1:' + location.pathname + location.search;
  const NL = String.fromCharCode(10);
  const mobile = window.matchMedia('(max-width: 860px)');
  const radios = (name) => Array.from(panel.querySelectorAll('input[name="' + name + '"]'));
  const drawer = panel.querySelector('input[name="mdh-toc-drawer"]');
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const levels = (value, fallback) => (Array.isArray(value) ? LEVELS.filter((l) => value.includes(l)) : fallback.slice());
  const parse = (raw) => {
    if (raw == null) return null;
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && o.v === 1 ? o : null;
    } catch (error) {
      return null;
    }
  };
  // 採用した候補の中で、取りうる値に無いフィールドだけを既定に戻す。
  const colours = (o) => {
    const b = o && o.band && typeof o.band === 'object' ? o.band : {};
    const t = o && o.text && typeof o.text === 'object' ? o.text : {};
    return {
      band: { on: typeof b.on === 'boolean' ? b.on : DEFAULTS.band.on, levels: levels(b.levels, DEFAULTS.band.levels), shape: pick(b.shape, ['band', 'bar'], DEFAULTS.band.shape) },
      text: { on: typeof t.on === 'boolean' ? t.on : DEFAULTS.text.on, levels: levels(t.levels, DEFAULTS.text.levels) },
    };
  };
  const readStored = () => {
    try { return localStorage.getItem(KEY); } catch (error) { return null; }
  };
  const writeStored = (value) => {
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch (error) { /* 保存できない環境では保存だけをあきらめる */ }
  };
  // 目次・幅の状態は部品の checked が持つ。
  const selected = (name, fallback) => (radios(name).find((r) => r.checked) || {}).value || fallback;
  const select = (name, value) => radios(name).forEach((r) => { r.checked = r.value === value; });
  // 最初の表示の優先順は 保存 → 埋め込み（部品の初期値＋JSON の見出しの色） → 既定。
  const stored = parse(readStored());
  const state = stored ? colours(stored) : colours(parse(root.getAttribute('data-mdh-settings')));
  if (stored) {
    select('mdh-toc', pick(stored.toc, ['show', 'hide'], DEFAULTS.toc));
    select('mdh-width', pick(stored.width, ['normal', 'wide', 'full'], DEFAULTS.width));
  }
  // 保存と書き出しの JSON は、そのつど部品と見出しの色の状態から作る。
  const snapshot = () => ({ v: 1, toc: selected('mdh-toc', DEFAULTS.toc), width: selected('mdh-width', DEFAULTS.width), band: state.band, text: state.text });

  const render = () => {
    root.setAttribute('data-mdh-band-shape', state.band.shape);
    if (state.band.on) root.setAttribute('data-mdh-band', state.band.levels.join(' ')); else root.removeAttribute('data-mdh-band');
    if (state.text.on) root.setAttribute('data-mdh-text', state.text.levels.join(' ')); else root.removeAttribute('data-mdh-text');
    panel.querySelectorAll('[data-setting]').forEach((el) => {
      const key = el.getAttribute('data-setting');
      const [group, field] = key.split('.');
      if (!state[group]) return;
      const value = field ? state[group][field] : state[group];
      if (el.tagName === 'BUTTON') {
        el.setAttribute('aria-pressed', String(Boolean(value)));
        return;
      }
      el.querySelectorAll('[data-v]').forEach((b) => {
        const v = b.getAttribute('data-v');
        b.setAttribute('aria-pressed', String(Array.isArray(value) ? value.includes(v) : value === v));
      });
    });
    panel.querySelectorAll('[data-sub]').forEach((sub) => {
      const off = !state[sub.getAttribute('data-sub')].on;
      sub.querySelectorAll('[data-setting]').forEach((group) => group.setAttribute('aria-disabled', String(off)));
      sub.querySelectorAll('button').forEach((b) => { b.tabIndex = off ? -1 : 0; });
    });
  };
  // 本文の幅が変わる切り替えの後は、表の自動拡張にその場で計算し直させ（ちらつきを防ぐ）、目次の現在位置にも測り直させる。
  const relayout = () => {
    window.dispatchEvent(new Event('mdh:layout'));
    window.dispatchEvent(new Event('resize'));
  };
  // 設定を変えたら保存し、測り直させる。
  const changed = () => {
    render();
    writeStored(snapshot());
    relayout();
  };

  const setOpen = (open) => { menu.open = open; };
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) setOpen(false);
  });
  // 目次・幅・引き出しの部品の変化。引き出しは保存しない。
  panel.addEventListener('change', (event) => {
    const name = event.target.getAttribute('name');
    if (name === 'mdh-toc-drawer') {
      if (drawer.checked) setOpen(false);
      relayout();
      return;
    }
    if (name === 'mdh-toc' || name === 'mdh-width') changed();
  });
  // コメント配信先のコメントモードは document の捕捉段階の mousedown・mouseup でピンを置き、click でコメントの位置を移す。それより先に動く
  // window の捕捉段階で、設定ボタンとパネルの上で始まった押下（ボタンごと）と dragstart を止め、click は設定の操作をここで行ってから止める。
  const inSettings = (target) => target instanceof Element && Boolean(target.closest('#mdhSettingsPanel, [data-action="toggle-settings"]'));
  // 折りたたみの見出しの押下とクリックも同じく止める。開閉（既定の動作）は止めない。
  const inToggleSummary = (target) => target instanceof Element && Boolean(target.closest('.mdh-toggle > summary'));
  const pressesInSettings = new Set();
  window.addEventListener('mousedown', (event) => {
    if (!inSettings(event.target) && !inToggleSummary(event.target)) return;
    pressesInSettings.add(event.button);
    event.stopPropagation();
  }, true);
  window.addEventListener('mouseup', (event) => {
    if (pressesInSettings.delete(event.button)) event.stopPropagation();
  }, true);
  window.addEventListener('dragstart', (event) => {
    if (inSettings(event.target)) event.stopPropagation();
  }, true);

  const absolute = (url) => (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : new URL(url, document.baseURI).href);
  const escapeText = (text) => text.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
  const fileName = (title) => {
    const bad = '/:*?"<>|' + String.fromCharCode(92);
    const cleaned = Array.from(title).map((ch) => (bad.includes(ch) || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? '-' : ch)).join('').slice(0, 120);
    return (cleaned || 'document') + '.html';
  };
  // 書き出し: 画面の複製でなく、md-to-html 自身の部品（目印付きの style・script と .mdh-shell）を拾って組み立て直す。
  const exportHtml = () => {
    const status = panel.querySelector('[data-export-status]');
    const style = Array.from(document.querySelectorAll('style')).find((el) => el.textContent.trimStart().startsWith('/* mdh:style */'));
    const scripts = Array.from(document.querySelectorAll('script')).filter((el) => el.textContent.trimStart().startsWith('/* mdh:script */'));
    if (!style || !scripts.length) {
      status.hidden = false;
      status.textContent = '書き出せませんでした';
      return;
    }
    status.hidden = true;
    status.textContent = '';
    const copy = shell.cloneNode(true);
    // 表とヒートマップの切り替えなど、今の選択（checked プロパティ）を属性へ写す。複製の直列化は属性しか保存しないため。
    const liveInputs = shell.querySelectorAll('input');
    copy.querySelectorAll('input').forEach((input, index) => {
      if (liveInputs[index] && liveInputs[index].checked) input.setAttribute('checked', ''); else input.removeAttribute('checked');
    });
    copy.querySelectorAll('.mdh-col-resizer, table > colgroup').forEach((el) => el.remove());
    copy.querySelectorAll('table').forEach((table) => {
      table.classList.remove('mdh-table-autofilled', 'mdh-table-resized', 'mdh-table-resizing');
      table.style.removeProperty('width');
      if (!table.getAttribute('style')) table.removeAttribute('style');
    });
    copy.querySelectorAll('.mdh-toc-current').forEach((el) => el.classList.remove('mdh-toc-current'));
    copy.querySelectorAll('.mdh-toc .mdh-toc-node > details').forEach((details) => {
      if (details.parentElement.classList.contains('mdh-toc-h2')) details.setAttribute('open', ''); else details.removeAttribute('open');
    });
    // パネルと引き出しの開閉は書き出さない。目次と幅は上で写した checked のまま。
    copy.querySelector('details.mdh-settings-menu').removeAttribute('open');
    copy.querySelectorAll('input[name="mdh-toc-drawer"]').forEach((input) => input.removeAttribute('checked'));
    [copy, ...copy.querySelectorAll('*')].forEach((el) => {
      if (el !== copy && el.tagName.includes('-')) {
        el.remove();
        return;
      }
      Array.from(el.attributes).forEach((attr) => { if (attr.name.startsWith('data-cmt-')) el.removeAttribute(attr.name); });
      Array.from(el.classList).forEach((name) => { if (name.startsWith('cmt-')) el.classList.remove(name); });
      if (el.hasAttribute('class') && !el.getAttribute('class')) el.removeAttribute('class');
    });
    copy.querySelectorAll('img[src]').forEach((img) => img.setAttribute('src', absolute(img.getAttribute('src'))));
    copy.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href.startsWith('#')) a.setAttribute('href', absolute(href));
    });
    // 見える見出しの改行は 1 行にする
    const title = ((document.querySelector('.mdh-title h1') || {}).innerText || document.title || 'document').split(NL).map((line) => line.trim()).filter(Boolean).join(' ') || 'document';
    const close = '</' + 'script>';
    const html = [
      '<!doctype html>',
      '<html lang="ja" data-mdh-settings="' + escapeText(JSON.stringify({ v: 1, band: state.band, text: state.text })) + '">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      ${JSON.stringify(GENERATOR_META)},
      '<title>' + escapeText(title) + '</title>',
      ${JSON.stringify(FONT_LINKS.google)},
      '<style>' + style.textContent + '</style>',
      '</head>',
      '<body>',
      copy.outerHTML,
      ...scripts.map((el) => '<script>' + el.textContent + close),
      '</body>',
      '</html>',
      '',
    ].join(NL);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    link.download = fileName(title);
    // パネルの中に置き、リンクの click も設定の操作として window の捕捉段階で止める。コメント配信先の入力待ちの取り消しに既定の動作（ダウンロード）を消させない。
    panel.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const onPanelClick = (event) => {
    const button = event.target.closest('button');
    if (!button || !panel.contains(button)) return;
    if (button.matches('[data-action="export-html"]')) {
      exportHtml();
      return;
    }
    if (button.matches('button[data-setting]')) {
      const [group, field] = button.getAttribute('data-setting').split('.');
      state[group][field] = !state[group][field];
      changed();
      return;
    }
    const group = button.closest('[data-setting]');
    if (!group || group.getAttribute('aria-disabled') === 'true') return;
    const key = group.getAttribute('data-setting');
    const value = button.getAttribute('data-v');
    const [name, field] = key.split('.');
    if (field === 'levels') {
      const list = state[name].levels.includes(value) ? state[name].levels.filter((l) => l !== value) : state[name].levels.concat(value);
      state[name].levels = LEVELS.filter((l) => list.includes(l));
    } else if (field) {
      state[name][field] = value;
    } else {
      state[name] = value;
    }
    changed();
  };
  window.addEventListener('click', (event) => {
    if (!inSettings(event.target) && inToggleSummary(event.target)) {
      // document へ届かないので、設定パネルの外側クリックで閉じる処理をここで代わりに行う
      if (menu.open) setOpen(false);
      event.stopPropagation();
      return;
    }
    if (!inSettings(event.target)) return;
    // 伝播だけを止める。設定ボタン（summary）の開閉と label・radio の選択は既定の動作に任せる。
    event.stopPropagation();
    if (!toggle.contains(event.target)) onPanelClick(event);
  }, true);
  // 860px 以下では目次のリンクを押したら引き出しを閉じる。
  const closeDrawer = () => {
    if (!drawer || !drawer.checked) return;
    drawer.checked = false;
    relayout();
  };
  document.querySelectorAll('.mdh-toc a').forEach((link) => link.addEventListener('click', () => {
    if (mobile.matches) closeDrawer();
  }));
  const onMedia = closeDrawer;
  if (mobile.addEventListener) mobile.addEventListener('change', onMedia); else mobile.addListener(onMedia);
  render();
})();`;

// 目次で、いま読んでいる見出しのリンクに mdh-toc-current を付ける。画面上端から 120px の位置を過ぎた最後の見出しを
// 現在位置とし（末尾までスクロールしたときは最後の見出し）、その見出しが閉じた目次の中にあるときは、見えている親の見出しに付ける。
export const TOC_CURRENT_SCRIPT = `/* mdh:script */
(() => {
  const links = new Map();
  document.querySelectorAll('.mdh-toc a[href^="#"]').forEach((link) => links.set(decodeURIComponent(link.getAttribute('href').slice(1)), link));
  const headings = Array.from(document.querySelectorAll('.mdh-doc h1[id], .mdh-doc h2[id], .mdh-doc h3[id]')).filter((h) => links.has(h.id));
  if (!headings.length) return;
  let current = null;
  let queued = false;
  const visibleLink = (link) => {
    let closed = link.closest('details:not([open])');
    while (closed) {
      link = closed.parentElement.querySelector(':scope > .mdh-toc-title');
      closed = link.closest('details:not([open])');
    }
    return link;
  };
  const update = () => {
    queued = false;
    let active = headings[0];
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= 120) active = heading; else break;
    }
    // 末尾までスクロールしきったときは、上端に届かない最後の見出しを現在位置にする。
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) active = headings[headings.length - 1];
    const link = visibleLink(links.get(active.id));
    if (link === current) return;
    current?.classList.remove('mdh-toc-current');
    link.classList.add('mdh-toc-current');
    current = link;
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  document.querySelectorAll('.mdh-toc details').forEach((details) => details.addEventListener('toggle', () => { current?.classList.remove('mdh-toc-current'); current = null; schedule(); }));
  update();
})();`;

// 表の列幅を、見出しセル右端のハンドルをホールドして左右に動かすことで広げたり狭めたりできるようにする（Notion の列幅変更と同じ操作）。
// 初回のドラッグまでは表に手を入れず、ドラッグ開始時に各列の実測幅を <col> に固定して table-layout: fixed へ切り替える。
// 列を広げると表全体が広がり、はみ出した分は .mdh-table-scroll の横スクロールで読む（隣の列は狭くならない）。
export const COLUMN_RESIZE_SCRIPT = `/* mdh:script */
(() => {
  const MIN_WIDTH = 48;
  const tables = document.querySelectorAll('.mdh-doc .mdh-table-scroll > table');
  tables.forEach((table) => {
    const headerRow = table.querySelector('tr');
    if (!headerRow) return;
    const headers = Array.from(headerRow.children);
    if (!headers.length) return;
    let cols = null;
    const fixLayout = () => {
      if (cols) return;
      // 自動拡張（TABLE_AUTOFILL_SCRIPT）が先に列幅を広げていた場合、その結果幅をそのままドラッグの初期値として引き継ぐ。
      const widths = headers.map((cell) => Math.ceil(cell.getBoundingClientRect().width));
      table.querySelector(':scope > colgroup.mdh-autofill-colgroup')?.remove();
      table.classList.remove('mdh-table-autofilled');
      const colgroup = document.createElement('colgroup');
      cols = widths.map((width) => {
        const col = document.createElement('col');
        col.style.width = width + 'px';
        colgroup.append(col);
        return col;
      });
      table.insertBefore(colgroup, table.firstChild);
      table.classList.add('mdh-table-resized');
      table.style.width = widths.reduce((sum, width) => sum + width, 0) + 'px';
    };
    const resetLayout = () => {
      if (!cols) return;
      table.querySelector('colgroup').remove();
      table.classList.remove('mdh-table-resized');
      table.style.width = '';
      cols = null;
    };
    headers.forEach((cell, index) => {
      const handle = document.createElement('span');
      handle.className = 'mdh-col-resizer';
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'ドラッグで列幅を変更（ダブルクリックで元に戻す）';
      cell.append(handle);
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        fixLayout();
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startWidth = parseFloat(cols[index].style.width);
        try { handle.setPointerCapture(pointerId); } catch (_) { /* capture が取れなくても document 側の listener で追従する */ }
        table.classList.add('mdh-table-resizing');
        const move = (moveEvent) => {
          if (moveEvent.pointerId !== pointerId) return;
          const width = Math.max(MIN_WIDTH, Math.round(startWidth + moveEvent.clientX - startX));
          cols[index].style.width = width + 'px';
          table.style.width = cols.reduce((sum, col) => sum + parseFloat(col.style.width), 0) + 'px';
        };
        const finish = (endEvent) => {
          if (endEvent.pointerId !== pointerId) return;
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', finish);
          document.removeEventListener('pointercancel', finish);
          try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch (_) { /* 既に解放済み */ }
          table.classList.remove('mdh-table-resizing');
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', finish);
      });
      handle.addEventListener('dblclick', resetLayout);
    });
  });
})();`;

// 列の上限（--mdh-col-max-width）の和が本文幅（.mdh-table-scroll の幅）に満たない表を、本文幅まで自動で広げる。
// 折り返している列（現在幅 < 折り返さない幅）を優先して広げ、その列が折り返さなくなる幅で止めて余りを他の折り返し列へ回す。
// 全列の折り返しが無くなってなお余りがあれば、全列を同じ倍率で拡張する。横スクロールする表（自然幅が本文幅を超える表）と 860px 以下の
// 画面、ユーザーが COLUMN_RESIZE_SCRIPT でドラッグした表（.mdh-table-resized）は対象外。ウィンドウリサイズと本文欄の幅の変化で再計算する（debounce 100ms）。
export const TABLE_AUTOFILL_SCRIPT = `/* mdh:script */
(() => {
  // スクリプトが動いた印。印が無い（文書のスクリプトを止める配信先）では CSS の min-width で本文幅まで広げる。
  document.documentElement.setAttribute('data-mdh-autofill-ready', '');
  const MOBILE_QUERY = window.matchMedia('(max-width: 860px)');
  const MAX_ITER = 10;
  const EPSILON = 0.5;

  const columnCells = (table, colCount) => {
    const cellsByColumn = Array.from({ length: colCount }, () => []);
    table.querySelectorAll('tr').forEach((row) => {
      Array.from(row.children).forEach((cell, index) => {
        if (index < colCount) cellsByColumn[index].push(cell);
      });
    });
    return cellsByColumn;
  };

  const maxWidths = (cellsByColumn) => cellsByColumn.map((cells) => cells.reduce((max, cell) => Math.max(max, cell.getBoundingClientRect().width), 0));

  // 現在（上限つき）の列幅と、折り返さない幅（一時的に nowrap・max-width:none を当てて測る）を両方測る。
  const measure = (table) => {
    const headerRow = table.querySelector('tr');
    if (!headerRow) return null;
    const colCount = headerRow.children.length;
    if (!colCount) return null;
    const cellsByColumn = columnCells(table, colCount);
    const currentWidths = maxWidths(cellsByColumn);
    const allCells = cellsByColumn.flat();
    const saved = allCells.map((cell) => [cell.style.whiteSpace, cell.style.maxWidth]);
    allCells.forEach((cell) => {
      cell.style.whiteSpace = 'nowrap';
      cell.style.maxWidth = 'none';
    });
    const unwrappedWidths = maxWidths(cellsByColumn);
    allCells.forEach((cell, index) => {
      cell.style.whiteSpace = saved[index][0];
      cell.style.maxWidth = saved[index][1];
    });
    return { currentWidths, unwrappedWidths };
  };

  // extraTotal を、折り返している列（不足分に応じた比率）へ優先的に配る。上限（unwrappedWidths）に達したら除外して再配分し、
  // 折り返し列が無くなってもなお余れば、全列へ同じ倍率で配る。
  const distribute = (currentWidths, unwrappedWidths, extraTotal) => {
    const widths = currentWidths.slice();
    let extra = extraTotal;
    for (let iter = 0; iter < MAX_ITER && extra > EPSILON; iter += 1) {
      const indices = widths.map((width, i) => (width < unwrappedWidths[i] - EPSILON ? i : -1)).filter((i) => i >= 0);
      if (!indices.length) break;
      const deficits = indices.map((i) => unwrappedWidths[i] - widths[i]);
      const totalDeficit = deficits.reduce((sum, value) => sum + value, 0);
      if (totalDeficit <= EPSILON) break;
      let used = 0;
      indices.forEach((i, k) => {
        const grant = Math.min((deficits[k] / totalDeficit) * extra, unwrappedWidths[i] - widths[i]);
        widths[i] += grant;
        used += grant;
      });
      extra -= used;
    }
    if (extra > EPSILON) {
      const sum = widths.reduce((total, width) => total + width, 0);
      if (sum > EPSILON) {
        const scale = (sum + extra) / sum;
        for (let i = 0; i < widths.length; i += 1) widths[i] *= scale;
      } else {
        const share = extra / widths.length;
        for (let i = 0; i < widths.length; i += 1) widths[i] += share;
      }
    }
    return widths;
  };

  const removeFill = (table) => {
    table.querySelector(':scope > colgroup.mdh-autofill-colgroup')?.remove();
    table.classList.remove('mdh-table-autofilled');
    table.style.width = '';
  };

  const applyFill = (table) => {
    if (table.classList.contains('mdh-table-resized')) return;
    const scroll = table.closest('.mdh-table-scroll');
    if (!scroll) return;
    const containerWidth = scroll.getBoundingClientRect().width;
    if (!containerWidth) return;
    const naturalTableWidth = table.getBoundingClientRect().width;
    if (naturalTableWidth >= containerWidth - EPSILON) return;
    const measured = measure(table);
    if (!measured) return;
    const { currentWidths, unwrappedWidths } = measured;
    const overhead = naturalTableWidth - currentWidths.reduce((sum, width) => sum + width, 0);
    const extraTotal = containerWidth - naturalTableWidth;
    const widths = distribute(currentWidths, unwrappedWidths, extraTotal);
    let colgroup = table.querySelector(':scope > colgroup.mdh-autofill-colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      colgroup.className = 'mdh-autofill-colgroup';
      table.insertBefore(colgroup, table.firstChild);
    }
    colgroup.innerHTML = '';
    widths.forEach((width) => {
      const col = document.createElement('col');
      col.style.width = Math.max(0, width) + 'px';
      colgroup.append(col);
    });
    table.classList.add('mdh-table-autofilled');
    table.style.width = Math.ceil(widths.reduce((sum, width) => sum + width, 0) + overhead) + 'px';
  };

  const resetAll = () => {
    document.querySelectorAll('.mdh-doc .mdh-table-scroll > table.mdh-table-autofilled').forEach(removeFill);
  };

  const run = () => {
    resetAll();
    if (MOBILE_QUERY.matches) return;
    document.querySelectorAll('.mdh-doc .mdh-table-scroll > table').forEach(applyFill);
  };

  let resizeTimer = null;
  const schedule = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(run, 100);
  };
  window.addEventListener('resize', schedule);
  // 本文欄の幅は window の大きさを変えなくても変わる（コメントパネルの開閉で余白が縮む）ため、本文欄の幅の変化でも再計算する。
  const doc = document.querySelector('.mdh-doc');
  let lastWidth = doc ? doc.getBoundingClientRect().width : 0;
  // 設定パネルで本文の幅や目次を切り替えたときは、待たずにその場で計算し直す。100ms の間に古い列幅で描かれてちらつくのを防ぐ（SETTINGS_SCRIPT が送る）。
  window.addEventListener('mdh:layout', () => {
    clearTimeout(resizeTimer);
    run();
    if (doc) lastWidth = doc.getBoundingClientRect().width;
  });
  if (doc && 'ResizeObserver' in window) {
    new ResizeObserver(() => {
      const width = doc.getBoundingClientRect().width;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      schedule();
    }).observe(doc);
  }

  run();
})();`;

export const CSS = `/* mdh:style */
:root {
  --mdh-col-max-width: 180px;
  --ink: #333333;
  --muted: #6C6C6C;
  --line: #DFE6E9;
  --line-strong: #DFE6E9;
  --paper: #ffffff;
  --panel: #ffffff;
  --soft: #F6F8F9;
  --accent: #1B63AC;
  --accent-soft: #F0F5FA;
  --link: #1B63AC;
  --code: #F6F8F9;
  --hair: 1px;
  --font-sans: "Noto Sans JP", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Consolas, monospace;
  --mdh-toc-width: 288px;
  --mdh-doc-width: 1000px;
  --mdh-content-width: 720px;
  --toc-toggle-col: 24px;
  --toc-toggle-size: 20px;
  --toc-row-min: 34px;
}
* { box-sizing: border-box; }
html, body { overscroll-behavior-y: none; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--font-sans); font-size: 16px; line-height: 1.7; font-weight: 400; }
a { color: inherit; text-decoration: none; }
.mdh-shell { max-width: calc(var(--mdh-toc-width) + var(--mdh-doc-width)); margin: 0 auto; padding: 0; display: grid; grid-template-columns: var(--mdh-toc-width) minmax(0, var(--mdh-doc-width)); gap: 0; align-items: start; }
/* 目次を畳んだ状態。編集版は .mdh-toc-collapsed、静的版は設定パネルの部品で表す。860px 以下は引き出しの規則が担う。 */
@media (min-width: 861px) {
  .mdh-shell.mdh-toc-collapsed, .mdh-shell:has(input[name="mdh-toc"][value="hide"]:checked) { max-width: var(--mdh-doc-width); grid-template-columns: minmax(0, var(--mdh-doc-width)); justify-content: center; }
  .mdh-shell.mdh-toc-collapsed .mdh-toc, .mdh-shell:has(input[name="mdh-toc"][value="hide"]:checked) .mdh-toc { display: none; }
}
.mdh-page, .mdh-doc { min-width: 0; }
/* 文書列の左右の余白は、列が広いときは 140px（章コンテンツ幅 720px）、列が狭まると左右均等に 24px まで縮める。 */
.mdh-page { padding: 120px max(24px, min(140px, calc((100% - var(--mdh-content-width)) / 2))) 100px; }
.mdh-toc-toggle { position: fixed; top: 14px; left: 14px; z-index: 10; min-height: 32px; padding: 5px 10px; border: 0; border-radius: 6px; background: rgba(255,255,255,.94); box-shadow: inset 0 0 0 var(--hair) var(--line); color: var(--muted); font: inherit; font-size: 12px; font-weight: 500; line-height: 1.5; cursor: pointer; }
.mdh-toc-toggle:hover { color: var(--ink); }
.mdh-toc { position: sticky; top: 0; max-height: 100vh; overflow-y: auto; overscroll-behavior: contain; padding: 120px 24px 24px; color: var(--muted); font-size: 14px; line-height: 22px; }
.mdh-toc strong { display: block; margin: 0 0 8px; padding: 0 12px; color: var(--ink); font-size: 14px; font-weight: 500; }
.mdh-toc-tree { display: grid; gap: 4px; }
/* 目次の見出しは 2 行までで切り、全文は title 属性で出す。見出しのリンクを flex の order で開閉の中身より上に置き、開閉の矢印は左上に重ねる。 */
.mdh-toc-node { position: relative; display: flex; flex-direction: column; min-height: 0; }
.mdh-toc-node > .mdh-toc-title { order: -1; }
.mdh-toc-spacer { display: none; }
.mdh-toc-disclosure { display: block; margin: 0; }
.mdh-toc-disclosure summary { position: absolute; top: 0; left: 0; z-index: 2; display: flex; align-items: center; justify-content: center; width: var(--toc-toggle-size); height: var(--toc-row-min); padding: 0; color: var(--muted); cursor: pointer; list-style: none; }
.mdh-toc-disclosure summary::-webkit-details-marker { display: none; }
.mdh-toc-disclosure summary::before { content: "›"; display: grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; font-size: 15px; line-height: 1; transition: transform .12s ease; }
.mdh-toc-disclosure[open] summary::before { transform: rotate(90deg); }
/* 上下の余白は border で取る。overflow: hidden は padding の外側までを見せるので、padding にすると 3 行目の上端が余白に見える。 */
.mdh-toc-title, .mdh-toc a { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; padding: 0 12px 0 var(--toc-toggle-col); border-block: 6px solid transparent; border-radius: 6px; color: var(--muted); font-size: 14px; font-weight: 400; line-height: 22px; overflow-wrap: anywhere; cursor: pointer; }
.mdh-toc-title:hover, .mdh-toc a:hover { background: var(--soft); color: var(--ink); }
.mdh-toc a.mdh-toc-current { background: var(--soft); color: var(--ink); font-weight: 500; }
.mdh-toc-children { display: grid; gap: 4px; margin: 4px 0 0 12px; }
.mdh-title { margin: 0 0 24px; padding: 0; }
.mdh-title h1 { margin: 0; color: var(--ink); font-size: 44px; font-weight: 500; line-height: 56px; letter-spacing: -0.01em; }
.mdh-title h1, .mdh-doc p, .mdh-doc li, .mdh-doc td, .mdh-doc th { overflow-wrap: anywhere; }
.mdh-meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.mdh-pill { display: inline-flex; min-height: 28px; padding: 4px 9px; border-radius: 6px; background: #fff; box-shadow: inset 0 0 0 var(--hair) var(--line); color: var(--muted); font-size: 12px; font-weight: 500; line-height: 20px; }
/* 字間は要素ごとに指定し、14px の要素でも自分の文字の大きさの 2% になるようにする（親から px で受け継がせない）。 */
.mdh-doc :is(p, li, dt, dd, th, td, blockquote, figcaption, section.footnotes), .mdh-doc :is(h4, h5, h6) { letter-spacing: 0.02em; }
.mdh-doc h1, .mdh-doc h2, .mdh-doc h3, .mdh-doc h4, .mdh-doc h5, .mdh-doc h6 { color: var(--ink); scroll-margin-top: 24px; }
.mdh-doc h1 { margin: 72px 0 18px; font-size: 34px; font-weight: 500; line-height: 44px; letter-spacing: -0.01em; }
.mdh-doc h2 { margin: 40px 0 10px; font-size: 26px; font-weight: 700; line-height: 36px; letter-spacing: -0.01em; }
/* 見出しの大きさは本文 16px に対して タイトル 44・h1 34・h2 26・h3 20・h4 以下 18（パターン D）。 */
.mdh-doc h3 { margin: 28px 0 7px; font-size: 20px; font-weight: 700; line-height: 28px; letter-spacing: -0.01em; }
.mdh-doc h4, .mdh-doc h5, .mdh-doc h6 { margin: 28px 0 7px; font-size: 18px; font-weight: 700; line-height: 26px; }
.mdh-doc h1 + h2 { margin-top: 0; }
/* 見出しの上下の余白は上:下＝4:1（h1 72/18・h2 40/10・h3 以下 28/7、パターン E）。
   見出しの直後に来るリスト・引用・コード・表は、見出しの下の余白だけで詰める（部品の上の 24px と相殺させない）。 */
.mdh-doc :is(h1, h2, h3, h4, h5, h6) + :is(ul, ol, blockquote, pre, .mdh-table-scroll, .mdh-table-block) { margin-top: 0; }
.mdh-doc p { margin: 0 0 20px; }
.mdh-doc strong, #cmt-imported-document strong { font-weight: 700; }
.mdh-doc em, #cmt-imported-document em { font-style: normal; }
.mdh-doc a:not(.mdh-button):not(.mdh-card-link), #cmt-imported-document a:not(.mdh-button):not(.mdh-card-link) { color: var(--link); text-decoration-line: underline; text-decoration-style: solid; text-decoration-thickness: 0.04em; text-underline-offset: 0.2em; text-decoration-color: currentColor; text-decoration-skip-ink: auto; }
.mdh-doc a:focus-visible, .mdh-toc a:focus-visible, .mdh-doc summary:focus-visible, .mdh-toc summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.mdh-doc ul, .mdh-doc ol { margin: 24px 0 20px; padding: 0 0 0 28px; }
.mdh-doc li ul, .mdh-doc li ol { margin: 8px 0 0; }
.mdh-doc li:last-child > ul:last-child, .mdh-doc li:last-child > ol:last-child { margin-bottom: 0; }
.mdh-doc li + li { margin-top: 8px; }
.mdh-doc li::marker { font-weight: 500; }
.mdh-doc ul.contains-task-list { padding-left: 0; list-style: none; }
/* チェックボックスは項目の左の余白に置き、文・強調・子リストは通常の流れのまま並べる（flex にすると子リストが横に並ぶ）。 */
.mdh-doc .task-list-item { position: relative; padding-left: 24px; list-style: none; }
.mdh-doc .task-list-item > input[type="checkbox"], .mdh-doc .task-list-item > p:first-child > input[type="checkbox"] { appearance: none; position: absolute; top: calc((1.7em - 16px) / 2); left: 0; width: 16px; height: 16px; margin: 0; border-radius: 3px; background: #fff; box-shadow: inset 0 0 0 .5px var(--muted); }
.mdh-doc .task-list-item > input[type="checkbox"]:checked, .mdh-doc .task-list-item > p:first-child > input[type="checkbox"]:checked { background: var(--muted) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.2l2.6 2.6L12 5.4' fill='none' stroke='%23fff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 16px 16px no-repeat; }
/* 引用・注釈・表・コードは本文に従属する要素として 14px／1.6 で揃える。 */
.mdh-doc blockquote, #cmt-imported-document blockquote { position: relative; margin: 24px 0; padding: 0 0 0 19px; border: 0; background: none; color: var(--ink); font-size: 14px; line-height: 1.6; }
.mdh-doc blockquote::before, #cmt-imported-document blockquote::before { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 3px; border-radius: 1px; background: var(--line); }
.mdh-doc blockquote p, #cmt-imported-document blockquote p { margin: 0 0 8px; }
.mdh-doc blockquote p:last-child, #cmt-imported-document blockquote p:last-child { margin-bottom: 0; }
.mdh-doc hr, #cmt-imported-document hr { height: 1px; margin: 40px 0; border: 0; background: var(--line); }
.mdh-doc p.mdh-button-row { margin: 16px 0 24px; }
.mdh-doc a.mdh-button { display: inline-block; padding: 10px 20px; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 500; text-decoration: none; line-height: 1.4; box-shadow: none; }
.mdh-doc a.mdh-button:hover, .mdh-doc a.mdh-button:focus-visible { background: #164F8A; color: #fff; text-decoration: none; }
.mdh-doc a.mdh-button::after { content: " ↗"; font-weight: 400; }
.mdh-doc .mdh-table-scroll, #cmt-imported-document .mdh-table-scroll { margin: 24px 0; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.mdh-doc table, #cmt-imported-document table { width: auto; max-width: 100%; border-collapse: separate; border-spacing: 0; margin: 24px 0; border: 0; border-radius: 8px; background: var(--panel); box-shadow: inset 0 0 0 var(--hair) var(--line); overflow: hidden; font-size: 14px; line-height: 1.6; }
.mdh-doc .mdh-table-scroll > table, #cmt-imported-document .mdh-table-scroll > table { margin: 0; }
:root:not([data-mdh-autofill-ready]) :is(.mdh-doc, #cmt-imported-document) .mdh-table-scroll > table:not(.mdh-table-resized) { min-width: 100%; }
.mdh-doc th.mdh-num, .mdh-doc td.mdh-num, #cmt-imported-document th.mdh-num, #cmt-imported-document td.mdh-num { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.mdh-doc th, #cmt-imported-document th { position: relative; }
.mdh-doc .mdh-col-resizer, #cmt-imported-document .mdh-col-resizer { position: absolute; top: 0; right: 0; width: 10px; height: 100%; cursor: col-resize; touch-action: none; user-select: none; z-index: 1; }
.mdh-doc .mdh-col-resizer::after, #cmt-imported-document .mdh-col-resizer::after { content: ""; position: absolute; top: 0; bottom: 0; right: 0; width: 2px; background: var(--line); opacity: 0; transition: opacity .12s; }
.mdh-doc .mdh-col-resizer:hover::after, .mdh-doc .mdh-table-resizing .mdh-col-resizer::after, #cmt-imported-document .mdh-col-resizer:hover::after, #cmt-imported-document .mdh-table-resizing .mdh-col-resizer::after { opacity: 1; }
.mdh-doc table.mdh-table-resized, #cmt-imported-document table.mdh-table-resized { table-layout: fixed; }
.mdh-doc table.mdh-table-resized th, .mdh-doc table.mdh-table-resized td, #cmt-imported-document table.mdh-table-resized th, #cmt-imported-document table.mdh-table-resized td { overflow: hidden; overflow-wrap: anywhere; }
.mdh-doc table.mdh-table-resized .mdh-num, #cmt-imported-document table.mdh-table-resized .mdh-num { text-overflow: ellipsis; }
.mdh-doc table.mdh-table-autofilled, #cmt-imported-document table.mdh-table-autofilled { table-layout: fixed; }
.mdh-doc table.mdh-table-autofilled th, .mdh-doc table.mdh-table-autofilled td, #cmt-imported-document table.mdh-table-autofilled th, #cmt-imported-document table.mdh-table-autofilled td { overflow: hidden; overflow-wrap: anywhere; }
.mdh-doc table.mdh-table-autofilled .mdh-num, #cmt-imported-document table.mdh-table-autofilled .mdh-num { text-overflow: ellipsis; }
.mdh-doc table.mdh-table-resizing, #cmt-imported-document table.mdh-table-resizing { user-select: none; }
.mdh-doc th, .mdh-doc td, #cmt-imported-document th, #cmt-imported-document td { border: 0; border-bottom: var(--hair) solid var(--line); padding: 12px 16px; color: var(--ink); text-align: left; vertical-align: top; }
.mdh-doc tbody tr:last-child > *, #cmt-imported-document tbody tr:last-child > * { border-bottom: 0; }
.mdh-doc th, #cmt-imported-document th { background: var(--soft); font-size: 14px; font-weight: 700; white-space: nowrap; }
.mdh-doc td, #cmt-imported-document td { max-width: var(--mdh-col-max-width); }
.mdh-doc tbody tr:hover td, #cmt-imported-document tbody tr:hover td { background: var(--soft); }
.mdh-doc td:empty::before, #cmt-imported-document td:empty::before { content: "—"; color: var(--muted); }
.mdh-doc pre, #cmt-imported-document pre { margin: 24px 0; padding: 16px; border: 0; border-radius: 8px; background: var(--code); box-shadow: inset 0 0 0 var(--hair) var(--line); overflow-x: auto; }
.mdh-doc code, #cmt-imported-document code { padding: 0; border-radius: 0; background: none; font-family: var(--font-mono); font-size: 14px; line-height: 1.6; letter-spacing: 0; }
.mdh-doc pre code, #cmt-imported-document pre code { display: block; padding: 0; background: transparent; border-radius: 0; line-height: 1.6; white-space: pre-wrap; }
.mdh-doc img, #cmt-imported-document img { max-width: 100%; height: auto; }
.mdh-doc .sr-only, #cmt-imported-document .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.mdh-doc section.footnotes, #cmt-imported-document section.footnotes { margin-top: 40px; padding-top: 40px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; line-height: 1.6; }
.mdh-doc section.footnotes ol, #cmt-imported-document section.footnotes ol { margin-top: 0; }
.mdh-doc > :first-child { margin-top: 0; }
.mdh-doc > :last-child { margin-bottom: 0; }
@media (max-width: 860px) {
  .mdh-shell, .mdh-shell.mdh-toc-collapsed { max-width: 100%; grid-template-columns: minmax(0, 1fr); gap: 0; justify-content: stretch; padding: 0; }
  .mdh-page { padding: 72px 18px 64px; }
  .mdh-shell.mdh-toc-collapsed .mdh-toc, .mdh-shell:has(input[name="mdh-toc-drawer"]):not(:has(input[name="mdh-toc-drawer"]:checked)) .mdh-toc { display: block; visibility: hidden; pointer-events: none; transform: translateX(calc(-100% - 18px)); }
  .mdh-toc-toggle { z-index: 30; }
  .mdh-toc { position: fixed; top: 56px; left: 12px; z-index: 20; width: min(320px, calc(100vw - 24px)); max-height: calc(100vh - 72px); overflow-y: auto; overscroll-behavior: contain; padding: 12px; border-radius: 8px; background: #fff; box-shadow: inset 0 0 0 var(--hair) var(--line), 0 16px 40px rgba(0,0,0,.12); transform: translateX(0); visibility: visible; transition: transform .16s ease, visibility .16s ease; }
  .mdh-doc h1, .mdh-doc h2, .mdh-doc h3, .mdh-doc h4 { scroll-margin-top: 68px; }
  .mdh-title h1 { font-size: 32px; line-height: 42px; }
}
/* 読み手の表示の設定。左上の設定ボタンとパネル。 */
:root { --mdh-heading-text: #3045B1; --mdh-heading-bg: #EEF0F8; }
.mdh-settings-menu { position: absolute; top: 0; left: 0; width: 0; height: 0; }
.mdh-settings-toggle { position: fixed; top: 14px; left: 14px; z-index: 40; display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 8px; background: rgba(255,255,255,.94); box-shadow: inset 0 0 0 var(--hair) var(--line); color: var(--ink); cursor: pointer; list-style: none; }
.mdh-settings-toggle::-webkit-details-marker { display: none; }
.mdh-settings-toggle::marker { content: ""; }
.mdh-settings-toggle:hover { background: var(--soft); }
.mdh-settings-menu[open] > .mdh-settings-toggle { background: var(--ink); color: #fff; }
.mdh-settings-toggle svg { width: 20px; height: 20px; }
/* スクリプトが動かないときは、スクリプトでしか動かない部品（見出しの色・書き出し）を出さない。 */
:root:not([data-mdh-settings-ready]) .mdh-settings-scripted { display: none; }
.mdh-settings { position: fixed; top: 58px; left: 14px; z-index: 40; width: 264px; max-height: calc(100vh - 72px); overflow-y: auto; overscroll-behavior: contain; padding: 4px 16px 16px; border-radius: 8px; background: #fff; box-shadow: inset 0 0 0 var(--hair) var(--line), 0 8px 24px rgba(0,0,0,.10); color: var(--ink); font-size: 13px; line-height: 20px; letter-spacing: 0; }
.mdh-settings[hidden] { display: none; }
.mdh-settings h2 { margin: 16px 0 8px; font-size: 14px; font-weight: 700; line-height: 20px; }
.mdh-settings h3 { margin: 0; font-size: 13px; font-weight: 400; line-height: 20px; }
.mdh-settings-seg { display: flex; padding: 2px; border-radius: 8px; background: var(--soft); }
.mdh-settings input { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); border: 0; white-space: nowrap; }
.mdh-settings-seg label { flex: 1; padding: 4px 6px; border-radius: 6px; color: var(--muted); font-size: 12px; text-align: center; cursor: pointer; }
.mdh-settings-seg label:has(input:checked) { background: #fff; color: var(--ink); box-shadow: inset 0 0 0 var(--hair) var(--line); font-weight: 500; }
.mdh-settings-seg button, .mdh-settings-levels button { flex: 1; padding: 4px 6px; border: 0; border-radius: 6px; background: none; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
.mdh-settings-seg button[aria-pressed="true"] { background: #fff; color: var(--ink); box-shadow: inset 0 0 0 var(--hair) var(--line); font-weight: 500; }
.mdh-settings-levels { display: flex; gap: 4px; margin: 6px 0 4px; }
.mdh-settings-levels button { background: var(--soft); font-family: var(--font-mono); }
.mdh-settings-levels button[aria-pressed="true"] { background: var(--mdh-heading-text); color: #fff; }
.mdh-settings-item { padding: 6px 0; }
.mdh-settings-item + .mdh-settings-item { border-top: 1px solid var(--soft); }
.mdh-settings-switch { display: flex; align-items: center; justify-content: space-between; }
.mdh-settings-switch button { position: relative; width: 34px; height: 20px; padding: 0; border: 0; border-radius: 10px; background: var(--line); cursor: pointer; }
.mdh-settings-switch button::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .12s; }
.mdh-settings-switch button[aria-pressed="true"] { background: var(--mdh-heading-text); }
.mdh-settings-switch button[aria-pressed="true"]::after { left: 16px; }
.mdh-settings-switch label { position: relative; width: 34px; height: 20px; border-radius: 10px; background: var(--line); cursor: pointer; }
.mdh-settings-switch label::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .12s; }
.mdh-settings-switch label:has(input:checked) { background: var(--mdh-heading-text); }
.mdh-settings-switch label:has(input:checked)::after { left: 16px; }
/* 目次の項目は、861px 以上は表示／非表示、860px 以下は引き出しの開閉。 */
.mdh-settings-drawer { display: none; }
.mdh-settings [aria-disabled="true"] { opacity: .4; pointer-events: none; }
.mdh-settings [data-sub] .mdh-settings-seg { margin-top: 4px; }
.mdh-settings-export { width: 100%; margin-top: 16px; padding: 8px 12px; border: 0; border-radius: 8px; background: var(--ink); color: #fff; font: inherit; font-weight: 500; cursor: pointer; }
.mdh-settings-export:hover { background: #1A1A1A; }
.mdh-settings-status { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.mdh-settings button:focus-visible, .mdh-settings-toggle:focus-visible, .mdh-settings label:has(input:focus-visible) { outline: 2px solid var(--link); outline-offset: 2px; }
/* 見出しの背景帯と文字色。<html> の data 属性に含まれる段だけに付ける（h4 は h5・h6 を含む）。帯は左右に 12px はみ出し、文字の位置は本文と揃える。 */
:root[data-mdh-band~="h1"] .mdh-doc h1, :root[data-mdh-band~="h2"] .mdh-doc h2, :root[data-mdh-band~="h3"] .mdh-doc h3, :root[data-mdh-band~="h4"] .mdh-doc :is(h4, h5, h6) { margin-left: -12px; margin-right: -12px; padding: 6px 12px; border-radius: 6px; background: var(--mdh-heading-bg); }
:root[data-mdh-band-shape="bar"][data-mdh-band~="h1"] .mdh-doc h1, :root[data-mdh-band-shape="bar"][data-mdh-band~="h2"] .mdh-doc h2, :root[data-mdh-band-shape="bar"][data-mdh-band~="h3"] .mdh-doc h3, :root[data-mdh-band-shape="bar"][data-mdh-band~="h4"] .mdh-doc :is(h4, h5, h6) { margin-left: -15px; border-left: 3px solid var(--mdh-heading-text); border-radius: 0 6px 6px 0; }
:root[data-mdh-text~="h1"] .mdh-doc h1, :root[data-mdh-text~="h2"] .mdh-doc h2, :root[data-mdh-text~="h3"] .mdh-doc h3, :root[data-mdh-text~="h4"] .mdh-doc :is(h4, h5, h6) { color: var(--mdh-heading-text); }
/* 本文の幅。標準は既定のまま。広めは章コンテンツ 880px、最大は文書列の上限を外して画面の幅いっぱい（コメントパネル表示時の上限も外す）。860px 以下では効かない。 */
@media (min-width: 861px) {
  .mdh-shell:has(input[name="mdh-width"][value="wide"]:checked) .mdh-page { padding-left: max(24px, min(60px, calc((100% - 880px) / 2))); padding-right: max(24px, min(60px, calc((100% - 880px) / 2))); }
  .mdh-shell:has(input[name="mdh-width"][value="full"]:checked) .mdh-page { padding-left: 40px; padding-right: 40px; }
  .mdh-shell:has(input[name="mdh-width"][value="full"]:checked) { max-width: none !important; grid-template-columns: var(--mdh-toc-width) minmax(0, 1fr) !important; }
  .mdh-shell:has(input[name="mdh-width"][value="full"]:checked):has(input[name="mdh-toc"][value="hide"]:checked) { grid-template-columns: minmax(0, 1fr) !important; }
}
@media (max-width: 860px) {
  .mdh-settings { top: 58px; left: 12px; right: 12px; width: auto; }
  .mdh-settings-toc { display: none; }
  .mdh-settings-drawer { display: flex; }
}
/* コメント配信先の 760px 以下ではツールバーが上端に来るので、設定ボタンとパネルをその下へずらす。 */
@media (max-width: 760px) {
  body.cmt-active .mdh-settings-toggle { top: calc(var(--cmt-toolbar-h, 92px) + 8px); }
  body.cmt-active .mdh-settings { top: calc(var(--cmt-toolbar-h, 92px) + 52px); max-height: calc(100vh - var(--cmt-toolbar-h, 92px) - 64px); }
}
/* コメントレビュー注入時のみ、右のコメントパネル幅を本文の外側に確保する。
   コメントランタイムはパネルを fixed でオーバーレイするだけで本文領域を狭めないため、中央寄せの
   .mdh-shell が右端でパネル下に潜り込み本文が切れる。--cmt-panel-width は コメントランタイムが
   :root へ px 同期する変数で、runtime 非注入の通常閲覧では body.cmt-mode-comment が付かないため
   このブロックは発火しない。パネル幅のぶん文書列が狭まると、.mdh-page の左右の余白が 140px から
   左右均等に縮む。コメントランタイム側の 760px 以下ではパネルが下部シートへ変わるので対象外。
   パネルだけを隠した状態は、今のコメントランタイムは body に cmt-panel-hidden を付ける。旧名 cmt-panel-collapsed も残す。 */
@media (min-width: 761px) {
  body.cmt-mode-comment:not(.cmt-panel-collapsed):not(.cmt-panel-hidden) .mdh-shell,
  body.cmt-mode-comment:not(.cmt-panel-collapsed):not(.cmt-panel-hidden) .mdh-shell.mdh-toc-collapsed { padding-right: var(--cmt-panel-width, 0px); }
  body.cmt-mode-comment:not(.cmt-panel-collapsed):not(.cmt-panel-hidden) .mdh-shell { max-width: calc(var(--mdh-toc-width) + var(--mdh-doc-width) + var(--cmt-panel-width, 0px)); }
  body.cmt-mode-comment:not(.cmt-panel-collapsed):not(.cmt-panel-hidden) .mdh-shell.mdh-toc-collapsed { max-width: calc(var(--mdh-doc-width) + var(--cmt-panel-width, 0px)); }
}
/* 静的版の目次を畳んだ状態。861px 以上は目次の非表示、761〜860px は引き出しが閉じていること。上の 2 規則と同じ宣言。 */
@media (min-width: 861px) {
  body.cmt-mode-comment:not(.cmt-panel-collapsed):not(.cmt-panel-hidden) .mdh-shell:has(input[name="mdh-toc"][value="hide"]:checked) { padding-right: var(--cmt-panel-width, 0px); max-width: calc(var(--mdh-doc-width) + var(--cmt-panel-width, 0px)); }
}
@media (min-width: 761px) and (max-width: 860px) {
  body.cmt-mode-comment:not(.cmt-panel-collapsed):not(.cmt-panel-hidden) .mdh-shell:has(input[name="mdh-toc-drawer"]):not(:has(input[name="mdh-toc-drawer"]:checked)) { padding-right: var(--cmt-panel-width, 0px); max-width: calc(var(--mdh-doc-width) + var(--cmt-panel-width, 0px)); }
}
@media (min-width: 861px) {
  body.cmt-mode-comment:not(.cmt-panel-collapsed):not(.cmt-panel-hidden) .mdh-shell:not(.mdh-toc-collapsed):not(:has(input[name="mdh-toc"][value="hide"]:checked)) { grid-template-columns: minmax(0, var(--mdh-toc-width)) minmax(0, var(--mdh-doc-width)); }
}
/* 部品（セレクタはクラスだけ） */
.mdh-callout { margin: 24px 0; padding: 16px; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--c-line); background: var(--c-bg); color: var(--ink); font-size: 14px; line-height: 1.6; }
.mdh-callout + .mdh-callout { margin-top: 24px; }
.mdh-callout-label { margin: 0 0 8px; font-weight: 500; }
.mdh-callout-body > :first-child { margin-top: 0; }
.mdh-callout-body > :last-child { margin-bottom: 0; }
.mdh-callout-gray { --c-bg: #F6F8F9; --c-line: #DFE6E9; }
.mdh-callout-blue { --c-bg: #F0F5FA; --c-line: #BDCAD7; }
.mdh-callout-green { --c-bg: #F0F6F3; --c-line: #B3D0C2; }
.mdh-callout-yellow { --c-bg: #FFF9EC; --c-line: #D5C7A9; }
.mdh-callout-red { --c-bg: #FFF5F4; --c-line: #DEC4C0; }
.mdh-toggle { margin: 16px 0; padding: 24px; border-radius: 8px; background: #fff; box-shadow: inset 0 0 0 1px var(--line); color: var(--ink); font-size: 14px; line-height: 1.6; }
.mdh-toggle summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-weight: 500; cursor: pointer; list-style: none; }
.mdh-toggle summary::-webkit-details-marker { display: none; }
.mdh-toggle-arrow { flex: none; width: 20px; height: 20px; color: var(--muted); }
.mdh-toggle[open] .mdh-toggle-arrow { transform: rotate(180deg); }
.mdh-toggle-body { margin-top: 8px; }
.mdh-toggle-body > :first-child { margin-top: 0; }
.mdh-toggle-body > :last-child { margin-bottom: 0; }
.mdh-doc sup:has(> a[data-footnote-ref]) { vertical-align: baseline; font-size: inherit; line-height: inherit; }
.mdh-doc sup > a[data-footnote-ref]::before { content: "["; }
.mdh-doc sup > a[data-footnote-ref]::after { content: "]"; }
.mdh-dl { display: grid; gap: 8px; margin: 24px 0; font-size: 14px; line-height: 1.6; color: var(--ink); }
.mdh-dl dt { font-weight: 500; }
.mdh-dl dd { margin: 0; }
.mdh-figure { margin: 24px 0; }
.mdh-figure img { display: block; max-width: 100%; height: auto; }
.mdh-figure figcaption { margin-top: 8px; color: var(--muted); font-size: 14px; line-height: 1.6; }
/* 部品（カード・複数カラム・結合セル）。
   カード・カラムはクラスだけのセレクタ、結合した表は既存の表と同じく .mdh-doc と #cmt-imported-document を並べる */
.mdh-cards { display: grid; grid-template-columns: repeat(var(--mdh-cards-cols), minmax(0, 1fr)); gap: 16px; margin: 24px 0; }
.mdh-cards-2 { --mdh-cards-cols: 2; }
.mdh-cards-3 { --mdh-cards-cols: 3; }
.mdh-card { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 24px; border-radius: 8px; background: #fff; box-shadow: inset 0 0 0 1px var(--line); color: var(--ink); }
/* タイトルは .mdh-doc :is(p, …, section.footnotes)（詳細度 0,2,1）の字間に負けないよう、クラス 3 つにする */
.mdh-cards .mdh-card .mdh-card-title { display: block; margin: 0; font-size: 16px; font-weight: 500; line-height: 22px; letter-spacing: -0.01em; }
.mdh-card .mdh-card-sub { margin: 0; font-size: 14px; font-weight: 500; line-height: 1.6; }
.mdh-card-body { display: block; font-size: 14px; line-height: 1.6; }
.mdh-card .mdh-card-body > * { margin: 0; }
.mdh-card .mdh-card-body > * + * { margin-top: 8px; }
.mdh-card-link { text-decoration: none; cursor: pointer; }
.mdh-card-link:hover { box-shadow: inset 0 0 0 1px #1B63AC; }
.mdh-card-icon { width: 28px; height: 28px; color: #3A3C3D; }
.mdh-columns { display: grid; grid-template-columns: repeat(var(--mdh-columns-cols), minmax(0, 1fr)); gap: 40px; margin: 24px 0; }
.mdh-columns-2 { --mdh-columns-cols: 2; }
.mdh-columns-3 { --mdh-columns-cols: 3; }
.mdh-column { min-width: 0; }
.mdh-columns .mdh-column > :first-child { margin-top: 0; }
.mdh-columns .mdh-column > :last-child { margin-bottom: 0; }
/* 結合した表は .mdh-table-scroll で包まない（表の自動拡張と列幅の取っ手が 1 行目のセルの数を列の数とみなすため） */
.mdh-doc .mdh-merged-scroll, #cmt-imported-document .mdh-merged-scroll { margin: 24px 0; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.mdh-doc .mdh-merged-scroll > table, #cmt-imported-document .mdh-merged-scroll > table { margin: 0; }
@media (max-width: 860px) { .mdh-cards, .mdh-columns { grid-template-columns: minmax(0, 1fr); } }
.mdh-doc .mdh-merged-table th + th, .mdh-doc .mdh-merged-table td + td, .mdh-doc .mdh-merged-table tr:not(:first-child) > :first-child,
#cmt-imported-document .mdh-merged-table th + th, #cmt-imported-document .mdh-merged-table td + td, #cmt-imported-document .mdh-merged-table tr:not(:first-child) > :first-child { border-left: var(--hair) solid var(--line); }
.mdh-doc .mdh-merged-table thead tr:first-child > [rowspan] + [colspan], #cmt-imported-document .mdh-merged-table thead tr:first-child > [rowspan] + [colspan] { border-left: var(--hair) solid var(--line); }
.mdh-doc .mdh-merged-table th[colspan], #cmt-imported-document .mdh-merged-table th[colspan] { text-align: center; }
/* 数式。
   周りの文字と同じ大きさ・色で、式の中の文字（mtext）は本文の書体。独立した式は中央、前後 24px、はみ出す分は式の中だけスクロールする */
.mdh-math { font-size: 1em; color: inherit; }
.mdh-math mtext { font-family: var(--font-sans); }
.mdh-math-display { margin: 24px 0; overflow-x: auto; }
.mdh-math-display > math { display: block; width: 100%; }
.mdh-math-source { margin: 0 0 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
/* tml- の構造の class のうち、複数行の式の揃えに要る 3 つ。Chromium は表のセルで -webkit-right・-webkit-left だけを効かせる */
.mdh-math .tml-right { text-align: right; text-align: -webkit-right; }
.mdh-math .tml-left { text-align: left; text-align: -webkit-left; }
.mdh-math mtable.tml-jot > mtr > mtd { padding-top: 0.7ex; padding-bottom: 0.7ex; }
/* タブ。
   隠したラジオボタンと label で切り替え、:has() が効くときだけ選んでいないタブを隠す。コメントモードでは全部を縦に並べる */
.mdh-tabs { margin: 24px 0; }
.mdh-tab-list { display: inline-flex; flex-wrap: wrap; max-width: 100%; padding: 3px; margin-bottom: 12px; background: var(--soft); border-radius: 10px; }
.mdh-tab-list input { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.mdh-tab-list label { display: inline-flex; align-items: center; min-height: 28px; padding: 6px 12px; color: var(--muted); border-radius: 7px; font-size: 14px; line-height: 1.5; cursor: pointer; }
.mdh-tab-list input:checked + label { color: var(--ink); background: var(--panel); box-shadow: inset 0 0 0 var(--hair) var(--line); font-weight: 500; }
.mdh-tab-list input:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 1px; }
.mdh-tab-panel { padding: 20px 24px; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--line); }
.mdh-tab-panel > :first-child { margin-top: 0; }
.mdh-tab-panel > :last-child { margin-bottom: 0; }
.mdh-tab-panel + .mdh-tab-panel { margin-top: 12px; }
.mdh-tab-heading { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
@supports selector(:has(*)) {
  .mdh-tab-panel { display: none; }
  .mdh-tabs:has(> .mdh-tab-list > input[value="1"]:checked) > .mdh-tab-panel[data-mdh-tab="1"],
  .mdh-tabs:has(> .mdh-tab-list > input[value="2"]:checked) > .mdh-tab-panel[data-mdh-tab="2"],
  .mdh-tabs:has(> .mdh-tab-list > input[value="3"]:checked) > .mdh-tab-panel[data-mdh-tab="3"],
  .mdh-tabs:has(> .mdh-tab-list > input[value="4"]:checked) > .mdh-tab-panel[data-mdh-tab="4"],
  .mdh-tabs:has(> .mdh-tab-list > input[value="5"]:checked) > .mdh-tab-panel[data-mdh-tab="5"],
  .mdh-tabs:has(> .mdh-tab-list > input[value="6"]:checked) > .mdh-tab-panel[data-mdh-tab="6"],
  .mdh-tabs:has(> .mdh-tab-list > input[value="7"]:checked) > .mdh-tab-panel[data-mdh-tab="7"],
  .mdh-tabs:has(> .mdh-tab-list > input[value="8"]:checked) > .mdh-tab-panel[data-mdh-tab="8"] { display: block; }
}
body.cmt-mode-comment .mdh-tab-list { display: none; }
body.cmt-mode-comment .mdh-tab-panel { display: block; }
body.cmt-mode-comment .mdh-tab-heading { position: static; width: auto; height: auto; margin: 0 0 8px; overflow: visible; clip-path: none; white-space: normal; }
/* 図。beautiful-mermaid 1.1.3 の <style> を、
   .mdh-diagram の中だけに効く形に書き写した。md-to-html と名前が重なる変数（--line・--muted・--accent・--surface・--border）は読まず、図の値に固定する */
.mdh-diagram { margin: 24px 0; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.mdh-diagram svg {
  display: block; width: 100%; height: auto; margin: 0 auto; background: var(--bg);
  --bg: #FFFFFF; --fg: #333333;
  --_text: var(--fg);
  --_text-sec: color-mix(in srgb, var(--fg) 60%, var(--bg));
  --_text-muted: color-mix(in srgb, var(--fg) 40%, var(--bg));
  --_text-faint: color-mix(in srgb, var(--fg) 25%, var(--bg));
  --_line: color-mix(in srgb, var(--fg) 50%, var(--bg));
  --_arrow: color-mix(in srgb, var(--fg) 85%, var(--bg));
  --_node-fill: color-mix(in srgb, var(--fg) 3%, var(--bg));
  --_node-stroke: color-mix(in srgb, var(--fg) 20%, var(--bg));
  --_group-fill: var(--bg);
  --_group-hdr: color-mix(in srgb, var(--fg) 5%, var(--bg));
  --_inner-stroke: color-mix(in srgb, var(--fg) 12%, var(--bg));
  --_key-badge: color-mix(in srgb, var(--fg) 10%, var(--bg));
  --xychart-color-0: #3b82f6;
  --xychart-color-1: #0d5ba5;
  --xychart-color-2: #5f79f2;
  --xychart-color-3: #0a5076;
  --xychart-color-4: #9592f6;
  --xychart-color-5: #0a5e76;
  --xychart-color-6: #ac97f7;
  --xychart-color-7: #0a6d76;
  --xychart-color-8: #bf97f7;
  --xychart-color-9: #0a7671;
}
.mdh-diagram text { font-family: var(--font-sans); }
.mdh-diagram .mono { font-family: var(--font-mono); }
.mdh-diagram .xychart-grid { fill: var(--_inner-stroke); stroke: none; opacity: 0.65; }
.mdh-diagram .xychart-bar { stroke-width: 1.5; }
.mdh-diagram .xychart-line { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.mdh-diagram .xychart-line-shadow { fill: none; stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; opacity: 0.12; }
.mdh-diagram .xychart-dot { stroke: var(--bg); stroke-width: 2; }
.mdh-diagram .xychart-label { fill: var(--_text-muted); }
.mdh-diagram .xychart-axis-title { fill: var(--_text-sec); }
.mdh-diagram .xychart-title { fill: var(--_text); }
.mdh-diagram .xychart-bar.xychart-color-0 { stroke: var(--xychart-color-0); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-0) 25%); }
.mdh-diagram path.xychart-color-0, .mdh-diagram line.xychart-color-0 { stroke: var(--xychart-color-0); }
.mdh-diagram circle.xychart-color-0 { fill: var(--xychart-color-0); }
.mdh-diagram .xychart-bar.xychart-color-1 { stroke: var(--xychart-color-1); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-1) 25%); }
.mdh-diagram path.xychart-color-1, .mdh-diagram line.xychart-color-1 { stroke: var(--xychart-color-1); }
.mdh-diagram circle.xychart-color-1 { fill: var(--xychart-color-1); }
.mdh-diagram .xychart-bar.xychart-color-2 { stroke: var(--xychart-color-2); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-2) 25%); }
.mdh-diagram path.xychart-color-2, .mdh-diagram line.xychart-color-2 { stroke: var(--xychart-color-2); }
.mdh-diagram circle.xychart-color-2 { fill: var(--xychart-color-2); }
.mdh-diagram .xychart-bar.xychart-color-3 { stroke: var(--xychart-color-3); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-3) 25%); }
.mdh-diagram path.xychart-color-3, .mdh-diagram line.xychart-color-3 { stroke: var(--xychart-color-3); }
.mdh-diagram circle.xychart-color-3 { fill: var(--xychart-color-3); }
.mdh-diagram .xychart-bar.xychart-color-4 { stroke: var(--xychart-color-4); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-4) 25%); }
.mdh-diagram path.xychart-color-4, .mdh-diagram line.xychart-color-4 { stroke: var(--xychart-color-4); }
.mdh-diagram circle.xychart-color-4 { fill: var(--xychart-color-4); }
.mdh-diagram .xychart-bar.xychart-color-5 { stroke: var(--xychart-color-5); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-5) 25%); }
.mdh-diagram path.xychart-color-5, .mdh-diagram line.xychart-color-5 { stroke: var(--xychart-color-5); }
.mdh-diagram circle.xychart-color-5 { fill: var(--xychart-color-5); }
.mdh-diagram .xychart-bar.xychart-color-6 { stroke: var(--xychart-color-6); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-6) 25%); }
.mdh-diagram path.xychart-color-6, .mdh-diagram line.xychart-color-6 { stroke: var(--xychart-color-6); }
.mdh-diagram circle.xychart-color-6 { fill: var(--xychart-color-6); }
.mdh-diagram .xychart-bar.xychart-color-7 { stroke: var(--xychart-color-7); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-7) 25%); }
.mdh-diagram path.xychart-color-7, .mdh-diagram line.xychart-color-7 { stroke: var(--xychart-color-7); }
.mdh-diagram circle.xychart-color-7 { fill: var(--xychart-color-7); }
.mdh-diagram .xychart-bar.xychart-color-8 { stroke: var(--xychart-color-8); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-8) 25%); }
.mdh-diagram path.xychart-color-8, .mdh-diagram line.xychart-color-8 { stroke: var(--xychart-color-8); }
.mdh-diagram circle.xychart-color-8 { fill: var(--xychart-color-8); }
.mdh-diagram .xychart-bar.xychart-color-9 { stroke: var(--xychart-color-9); fill: color-mix(in srgb, var(--bg) 75%, var(--xychart-color-9) 25%); }
.mdh-diagram path.xychart-color-9, .mdh-diagram line.xychart-color-9 { stroke: var(--xychart-color-9); }
.mdh-diagram circle.xychart-color-9 { fill: var(--xychart-color-9); }
/* 表は狭い画面でもカードに組み替えず表のまま。文字のセルは 8 文字ぶんより細くせず、収まらない表は .mdh-table-scroll の中で横にスクロールする。
   画面だけに効かせる（印刷は 4 文字ぶん。#cmt-imported-document のセレクタは詳細度が高く、印刷の規則で打ち消せないため） */
@media screen and (max-width: 860px) {
  .mdh-doc th:not(.mdh-num), .mdh-doc td:not(.mdh-num), #cmt-imported-document th:not(.mdh-num), #cmt-imported-document td:not(.mdh-num) { min-width: 8em; }
}
/* 表紙と印刷の目次は、画面（コメントモードを含む）には出さない */
.mdh-print-front { display: none; }
/* 印刷。既存の画面幅の切り替えには手を入れず、
   A4 の幅で効いてしまう狭い画面の指定を、このまとまりの中で上書きする。セレクタはクラスだけで、コメント配信先の頁の中の文書にも効く */
@media print {
  .mdh-settings-menu, .mdh-settings-toggle, .mdh-settings, .mdh-toc, .mdh-toc-toggle, .mdh-view-toggle, .mdh-tab-list,
  input[name="mdh-toc"], input[name="mdh-width"], input[name="mdh-toc-drawer"], label:has(> input[name="mdh-toc-drawer"]) { display: none !important; }
  .mdh-shell, .mdh-shell.mdh-toc-collapsed { display: block !important; max-width: none !important; padding: 0 !important; }
  .mdh-page { max-width: none !important; padding: 0 !important; }
  .mdh-tab-panel { display: block !important; }
  .mdh-tab-panel + .mdh-tab-panel { margin-top: 12px; }
  .mdh-tab-heading { position: static; width: auto; height: auto; margin: 0 0 8px; overflow: visible; clip-path: none; white-space: normal; }
  .mdh-toggle::details-content { content-visibility: visible; display: block; }
  .mdh-toggle-arrow { display: none; }
  .mdh-diagram { overflow: visible; }
  .mdh-diagram svg { min-width: 0 !important; }
  .mdh-table-scroll, .mdh-merged-scroll { overflow: visible !important; }
  .mdh-table-scroll > table, .mdh-merged-scroll > table { width: 100% !important; min-width: 0 !important; table-layout: auto !important; }
  .mdh-table-scroll > table > colgroup, .mdh-merged-scroll > table > colgroup { display: none; }
  /* 紙の幅に列を収めるため、文字は小さくせずセルの左右の余白を詰め、文字のセルには 4 文字ぶんの最低幅を持たせる */
  .mdh-doc th, .mdh-doc td { max-width: none !important; padding: 8px !important; }
  .mdh-doc th:not(.mdh-num), .mdh-doc td:not(.mdh-num) { min-width: 4em; }
  .mdh-doc th:not(.mdh-num), .mdh-doc td:not(.mdh-num) { white-space: normal !important; overflow-wrap: anywhere; }
  /* 数値のセルは画面と同じく折り返さない（数字の途中で折り返すと読めない）。数値の列の見出しは文字なので、紙の幅に収めるため折り返す */
  .mdh-doc td.mdh-num { white-space: nowrap !important; }
  .mdh-doc th.mdh-num { white-space: normal !important; }
  .mdh-col-resizer { display: none !important; }
  /* 行末の全角の閉じかっこを半分に詰めると、かっこが行の外へぶら下がり、紙の幅を超えたぶん Chromium が紙全体を縮める。印刷では詰めない */
  .mdh-title, .mdh-doc { text-spacing-trim: space-all; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  tr, .mdh-callout, .mdh-toggle, .mdh-card, .mdh-math-display, .mdh-tab-panel, .mdh-diagram { break-inside: avoid; }
  .mdh-callout, .mdh-heat, .mdh-doc pre, .mdh-tab-panel, .mdh-doc th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* 表紙と印刷の目次。表紙の高さは紙の大きさに頼らず、題が 3 行までなら A4 でも Letter でも 1 頁に収まる */
  .mdh-print-front { display: block; }
  .mdh-page:has(.mdh-print-front) :is(.mdh-title, .mdh-hub-nav) { display: none; }
  .mdh-cover { padding: 40mm 6mm 0; break-after: page; }
  .mdh-cover-kind { margin: 0 0 6mm; font-size: 11pt; letter-spacing: .12em; color: var(--muted); }
  .mdh-cover-title { margin: 0; padding: 0 0 8mm; border-bottom: 1.2pt solid var(--ink); font-size: 26pt; font-weight: 700; line-height: 1.35; }
  .mdh-cover-to { margin: 10mm 0 0; font-size: 14pt; }
  .mdh-cover-foot { margin: 90mm 0 0; font-size: 10.5pt; line-height: 1.9; }
  .mdh-cover-foot span { display: block; }
  .mdh-print-toc { padding: 6mm 6mm 0; break-after: page; }
  .mdh-print-toc-label { margin: 0 0 6mm; font-size: 16pt; font-weight: 700; }
  .mdh-print-toc ol { margin: 0; padding: 0; list-style: none; }
  .mdh-print-toc li { padding: .8mm 0; border-bottom: .5pt solid var(--line); font-size: 10pt; line-height: 1.5; break-inside: avoid; }
  .mdh-print-toc .mdh-print-toc-l1 { padding-top: 3mm; font-size: 11pt; font-weight: 700; }
  .mdh-print-toc .mdh-print-toc-l2 { padding-left: 6mm; }
  .mdh-print-toc a { color: inherit; text-decoration: none; }
}
`;

export const HEATMAP_CSS = `
.mdh-doc .mdh-table-block, #cmt-imported-document .mdh-table-block { margin: 24px 0; }
.mdh-doc .mdh-table-block > .mdh-table-scroll, #cmt-imported-document .mdh-table-block > .mdh-table-scroll { margin: 0; }
.mdh-doc .mdh-view-toggle, #cmt-imported-document .mdh-view-toggle { display: inline-flex; gap: 0; padding: 3px; background: var(--soft); border-radius: 10px; }
.mdh-doc .mdh-view-toggle input[type="radio"], #cmt-imported-document .mdh-view-toggle input[type="radio"] { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
.mdh-doc .mdh-view-toggle label, #cmt-imported-document .mdh-view-toggle label { display: inline-flex; align-items: center; min-height: 28px; padding: 6px 11px; color: var(--muted); border-radius: 7px; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
.mdh-doc .mdh-view-toggle input[type="radio"]:checked + label, #cmt-imported-document .mdh-view-toggle input[type="radio"]:checked + label { color: var(--ink); background: var(--panel); box-shadow: inset 0 0 0 var(--hair) var(--line); }
.mdh-doc .mdh-view-toggle input[type="radio"]:focus-visible + label, #cmt-imported-document .mdh-view-toggle input[type="radio"]:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 1px; }
.mdh-doc .mdh-table-block > .mdh-view-toggle, #cmt-imported-document .mdh-table-block > .mdh-view-toggle { margin-bottom: 10px; }
.mdh-doc .mdh-table-block:has(input[value="heatmap"]:checked) td.mdh-heat, #cmt-imported-document .mdh-table-block:has(input[value="heatmap"]:checked) td.mdh-heat { background: var(--mdh-heat); }
`;
