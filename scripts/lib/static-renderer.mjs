import GithubSlugger from 'github-slugger';
import { unified } from 'unified';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import { rehypeSanitizeUrls, isSafeUrl } from './url-safety.mjs';
import { GENERATOR_META } from './generator-marker.mjs';

export function collectText(node) {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') return node.value || '';
  if (!node.children) return '';
  return node.children.map(collectText).join('');
}

export function collectHeadings(tree) {
  const slugger = new GithubSlugger();
  const headings = [];

  visit(tree, 'heading', (node) => {
    const text = collectText(node).trim();
    const id = slugger.slug(text || 'section');
    node.data ||= {};
    node.data.hProperties ||= {};
    node.data.hProperties.id = id;
    headings.push({
      level: node.depth,
      originalDepth: node.data.originalDepth ?? node.depth,
      text,
      id,
      children: []
    });
  });

  return headings;
}

export function buildToc(headings) {
  const root = [];
  const stack = [];

  for (const heading of headings) {
    if (heading.level > 3 || heading.originalDepth > 3) continue;

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
const HEATMAP_PAREN_GROUP = /[（(]([^（）()]*)[）)]/g;
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
  // 全角％は主値モードの判定だけで半角へ寄せる（既定モードの isNumericCellText は変えない。T005 交差審査 F1）。
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
      cell.properties.style = `--mdh-heat: rgba(47,111,115,${alpha})`;
    }
  });
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

export function renderToc(nodes) {
  return nodes
    .map((node) => {
      if (node.level === 3) {
        return `<a class="mdh-toc-h3" href="#${escapeHtml(node.id)}">${escapeHtml(node.text)}</a>`;
      }

      const cls = `mdh-toc-node mdh-toc-h${node.level}`;
      const title = `<a class="mdh-toc-title mdh-toc-title-h${node.level}" href="#${escapeHtml(node.id)}">${escapeHtml(node.text)}</a>`;
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

// hubLink 指定時のみ main の第1子として出力するハブナビ。
// .mdh-shell は aside + main の2列 grid のため shell 直下には足さない（grid 非干渉）。
// 値型は `{ href, label = '索引' }` のオブジェクトのみ（文字列短縮形は受けない）。
// この nav は本文 sanitizer（rehypeSanitizeUrls）の外側で文字列生成されるため、
// href は同じ isSafeUrl() で検査し、危険スキームは TypeError で落とす（SPEC §4.4・§4.6）。
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

export function renderPage({ title, data, toc, bodyHtml }, { hubLink } = {}) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${GENERATOR_META}
  <title>${escapeHtml(title)}</title>
  <style>${CSS}${bodyHtml.includes('<div class="mdh-table-block mdh-heatmap-enabled">') ? HEATMAP_CSS : ''}</style>
</head>
<body>
  <div class="mdh-shell" data-editable="false">
    <button class="mdh-toc-toggle" type="button" data-action="toggle-toc" aria-expanded="true">目次を閉じる</button>
    <aside class="mdh-toc" aria-label="table of contents">
      <strong>目次</strong>
      <div class="mdh-toc-tree">${renderToc(toc)}</div>
    </aside>
    <main class="mdh-page">${renderHubNav(hubLink)}
      <header class="mdh-title">
        ${renderMeta(data)}
        <div class="mdh-title-icon">◎</div>
        <p class="mdh-title-label">Markdown Document</p>
        <h1>${escapeHtml(title)}</h1>
      </header>
      <article class="mdh-doc">${bodyHtml}</article>
    </main>
  </div>
  <script>${TOC_TOGGLE_SCRIPT}</script>
  <script>${COLUMN_RESIZE_SCRIPT}</script>
  <script>${TABLE_AUTOFILL_SCRIPT}</script>
</body>
</html>`;
}

export const TOC_TOGGLE_SCRIPT = `(() => {
  const shell = document.querySelector('.mdh-shell');
  const button = document.querySelector('[data-action="toggle-toc"]');
  if (!shell || !button) return;
  const mobileQuery = window.matchMedia('(max-width: 860px)');
  if (mobileQuery.matches) shell.classList.add('mdh-toc-collapsed');
  const update = () => {
    const collapsed = shell.classList.contains('mdh-toc-collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.textContent = collapsed ? '目次を開く' : '目次を閉じる';
  };
  button.addEventListener('click', () => {
    shell.classList.toggle('mdh-toc-collapsed');
    update();
  });
  document.querySelectorAll('.mdh-toc a').forEach((link) => {
    link.addEventListener('click', () => {
      if (mobileQuery.matches) {
        shell.classList.add('mdh-toc-collapsed');
        update();
      }
    });
  });
  update();
})();`;

// 表の列幅を、見出しセル右端のハンドルをホールドして左右に動かすことで広げたり狭めたりできるようにする（Notion の列幅変更と同じ操作）。
// 初回のドラッグまでは表に手を入れず、ドラッグ開始時に各列の実測幅を <col> に固定して table-layout: fixed へ切り替える。
// 列を広げると表全体が広がり、はみ出した分は .mdh-table-scroll の横スクロールで読む（隣の列は狭くならない）。
export const COLUMN_RESIZE_SCRIPT = `(() => {
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
// 全列の折り返しが無くなってなお余りがあれば、全列を同じ倍率で拡張する。横スクロールする表（自然幅が本文幅を超える表）とモバイルの
// stack 表示、ユーザーが COLUMN_RESIZE_SCRIPT でドラッグした表（.mdh-table-resized）は対象外。ウィンドウリサイズで再計算する（debounce 100ms）。
export const TABLE_AUTOFILL_SCRIPT = `(() => {
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
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(run, 100);
  });

  run();
})();`;

export const CSS = `
:root {
  --mdh-col-max-width: 180px;
  --ink: #222222;
  --muted: #6f6a62;
  --line: #e6e1da;
  --line-strong: #d3cdc4;
  --paper: #fbfaf8;
  --panel: #ffffff;
  --soft: #f4f1ec;
  --accent: #2f6f73;
  --accent-soft: #e5f0ef;
  --gold-soft: #f4eddb;
  --code: #f6f5f3;
  --toc-toggle-col: 22px;
  --toc-toggle-size: 20px;
  --toc-row-min: 32px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.65; }
a { color: inherit; text-decoration: none; }
.mdh-shell { max-width: 1180px; margin: 0 auto; padding: 38px 24px 64px; display: grid; grid-template-columns: 220px minmax(0, 760px); gap: 56px; align-items: start; }
.mdh-shell.mdh-toc-collapsed { max-width: 860px; grid-template-columns: minmax(0, 760px); justify-content: center; }
.mdh-shell.mdh-toc-collapsed .mdh-toc { display: none; }
.mdh-page, .mdh-doc { min-width: 0; }
.mdh-toc-toggle { position: fixed; top: 14px; left: 14px; z-index: 10; min-height: 32px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 6px; background: rgba(255,255,255,.92); color: var(--muted); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; box-shadow: 0 1px 6px rgba(34,34,34,.06); }
.mdh-toc-toggle:hover { color: var(--ink); border-color: var(--line-strong); }
.mdh-toc { position: sticky; top: 24px; max-height: calc(100vh - 48px); overflow-y: auto; overscroll-behavior: contain; color: var(--muted); font-size: 13px; }
.mdh-toc strong { display: block; margin-bottom: 10px; color: var(--ink); font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
.mdh-toc-tree { display: grid; gap: 3px; }
.mdh-toc-node { position: relative; display: block; min-height: var(--toc-row-min); border-radius: 6px; }
.mdh-toc-spacer { position: absolute; inset: 0 auto auto 0; width: var(--toc-toggle-size); min-height: var(--toc-row-min); }
.mdh-toc-disclosure { display: block; margin: 0; }
.mdh-toc-disclosure[open] { padding-top: var(--toc-row-min); }
.mdh-toc-disclosure summary { position: absolute; inset: 0 auto auto 0; display: flex; align-items: center; justify-content: center; min-height: var(--toc-row-min); width: var(--toc-toggle-size); padding: 4px 0; color: #4f4940; cursor: pointer; list-style: none; font-weight: 650; }
.mdh-toc-disclosure summary::-webkit-details-marker { display: none; }
.mdh-toc-disclosure summary::before { content: "›"; display: grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; color: var(--muted); font-size: 15px; line-height: 1; transition: transform .12s ease, background-color .12s ease; }
.mdh-toc-disclosure[open] summary::before { transform: rotate(90deg); background: var(--soft); }
.mdh-toc-title { position: absolute; inset: 0 0 auto var(--toc-toggle-col); z-index: 1; min-width: 0; padding: 5px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-left: 2px solid transparent; font-weight: 650; }
.mdh-toc-title:hover { color: var(--ink); border-left-color: var(--accent); padding-left: 8px; }
.mdh-toc-title-h1 { color: var(--ink); font-size: 13px; font-weight: 760; }
.mdh-toc-title-h2 { color: #4f4940; font-size: 12px; font-weight: 700; }
.mdh-toc-children { display: grid; gap: 1px; margin: 0 0 5px var(--toc-toggle-col); padding-left: 10px; border-left: 1px solid var(--line); }
.mdh-toc a { display: block; padding: 4px 0; border-left: 2px solid transparent; }
.mdh-toc a:hover { color: var(--ink); border-left-color: var(--accent); padding-left: 8px; }
.mdh-toc-h3 { color: var(--muted); font-size: 12px; }
.mdh-title { padding: 8px 0 18px; }
.mdh-title-icon { display: grid; place-items: center; width: 64px; height: 64px; margin-bottom: 12px; border-radius: 8px; background: var(--soft); font-size: 34px; }
.mdh-title-label { margin: 0 0 4px; color: var(--muted); font-size: 13px; }
.mdh-title h1 { margin: 0; font-size: 42px; line-height: 1.08; letter-spacing: 0; }
.mdh-title h1, .mdh-doc p, .mdh-doc li, .mdh-doc td, .mdh-doc th { overflow-wrap: anywhere; }
.mdh-meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.mdh-pill { display: inline-flex; min-height: 28px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--muted); font-size: 12px; font-weight: 620; }
.mdh-doc h1, .mdh-doc h2, .mdh-doc h3, .mdh-doc h4 { line-height: 1.22; letter-spacing: 0; scroll-margin-top: 24px; }
.mdh-doc h1 { margin: 48px 0 16px; font-size: 34px; font-weight: 760; }
.mdh-doc h2 { margin: 46px 0 14px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 25px; font-weight: 720; }
.mdh-doc h3 { margin: 30px 0 10px; font-size: 18px; font-weight: 700; }
.mdh-doc h3::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--accent); vertical-align: 2px; }
.mdh-doc h4 { margin: 22px 0 8px; color: #4f4940; font-size: 14px; font-weight: 750; }
.mdh-doc p { margin: 0 0 16px; }
.mdh-doc ul, .mdh-doc ol { margin: 0 0 18px; padding-top: 4px; padding-bottom: 4px; }
.mdh-doc li ul, .mdh-doc li ol { padding-top: 0; padding-bottom: 0; }
.mdh-doc li:last-child > ul:last-child, .mdh-doc li:last-child > ol:last-child { margin-bottom: 0; }
.mdh-doc li + li { margin-top: 4px; }
.mdh-doc blockquote, #cmt-imported-document blockquote { margin: 18px 0 24px; padding: 14px 16px; border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; background: var(--gold-soft); color: #3b362f; font-size: 14px; }
.mdh-doc p.mdh-button-row { margin: 16px 0 24px; }
.mdh-doc a.mdh-button { display: inline-block; padding: 10px 20px; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; line-height: 1.4; box-shadow: none; }
.mdh-doc a.mdh-button:hover, .mdh-doc a.mdh-button:focus-visible { background: #245a5d; color: #fff; text-decoration: none; }
.mdh-doc a.mdh-button::after { content: " ↗"; font-weight: 400; }
.mdh-doc blockquote p:last-child, #cmt-imported-document blockquote p:last-child { margin-bottom: 0; }
.mdh-doc .mdh-table-scroll, #cmt-imported-document .mdh-table-scroll { margin: 20px 0 28px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.mdh-doc table, #cmt-imported-document table { width: auto; max-width: 100%; border-collapse: separate; border-spacing: 0; margin: 20px 0 28px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel); box-shadow: 0 1px 2px rgba(34,34,34,.04); overflow: hidden; font-size: 14px; }
.mdh-doc .mdh-table-scroll > table, #cmt-imported-document .mdh-table-scroll > table { margin: 0; }
.mdh-doc th.mdh-num, .mdh-doc td.mdh-num, #cmt-imported-document th.mdh-num, #cmt-imported-document td.mdh-num { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.mdh-doc th, #cmt-imported-document th { position: relative; }
.mdh-doc .mdh-col-resizer, #cmt-imported-document .mdh-col-resizer { position: absolute; top: 0; right: 0; width: 10px; height: 100%; cursor: col-resize; touch-action: none; user-select: none; z-index: 1; }
.mdh-doc .mdh-col-resizer::after, #cmt-imported-document .mdh-col-resizer::after { content: ""; position: absolute; top: 0; bottom: 0; right: 0; width: 2px; background: var(--accent, #2f6fed); opacity: 0; transition: opacity .12s; }
.mdh-doc .mdh-col-resizer:hover::after, .mdh-doc .mdh-table-resizing .mdh-col-resizer::after, #cmt-imported-document .mdh-col-resizer:hover::after, #cmt-imported-document .mdh-table-resizing .mdh-col-resizer::after { opacity: 1; }
.mdh-doc table.mdh-table-resized, #cmt-imported-document table.mdh-table-resized { table-layout: fixed; }
.mdh-doc table.mdh-table-resized th, .mdh-doc table.mdh-table-resized td, #cmt-imported-document table.mdh-table-resized th, #cmt-imported-document table.mdh-table-resized td { overflow: hidden; overflow-wrap: anywhere; }
.mdh-doc table.mdh-table-resized .mdh-num, #cmt-imported-document table.mdh-table-resized .mdh-num { text-overflow: ellipsis; }
.mdh-doc table.mdh-table-autofilled, #cmt-imported-document table.mdh-table-autofilled { table-layout: fixed; }
.mdh-doc table.mdh-table-autofilled th, .mdh-doc table.mdh-table-autofilled td, #cmt-imported-document table.mdh-table-autofilled th, #cmt-imported-document table.mdh-table-autofilled td { overflow: hidden; overflow-wrap: anywhere; }
.mdh-doc table.mdh-table-autofilled .mdh-num, #cmt-imported-document table.mdh-table-autofilled .mdh-num { text-overflow: ellipsis; }
.mdh-doc table.mdh-table-resizing, #cmt-imported-document table.mdh-table-resizing { user-select: none; }
.mdh-doc th, .mdh-doc td, #cmt-imported-document th, #cmt-imported-document td { border: 0; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 11px 13px; text-align: left; vertical-align: top; }
.mdh-doc tr > :last-child, #cmt-imported-document tr > :last-child { border-right: 0; }
.mdh-doc tbody tr:last-child > *, #cmt-imported-document tbody tr:last-child > * { border-bottom: 0; }
.mdh-doc th, #cmt-imported-document th { background: var(--soft); color: #3b362f; font-size: 12px; font-weight: 760; }
.mdh-doc th, #cmt-imported-document th { white-space: nowrap; }
.mdh-doc td, #cmt-imported-document td { max-width: var(--mdh-col-max-width); }
.mdh-doc tbody tr:nth-child(even) td, #cmt-imported-document tbody tr:nth-child(even) td { background: rgba(244,241,236,.42); }
.mdh-doc tbody tr:hover td, #cmt-imported-document tbody tr:hover td { background: var(--accent-soft); }
.mdh-doc td:empty::before, #cmt-imported-document td:empty::before { content: "—"; color: var(--muted); }
.mdh-doc pre, #cmt-imported-document pre { margin: 18px 0 24px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--code); box-shadow: inset 0 1px 0 rgba(255,255,255,.72); overflow-x: auto; }
.mdh-doc code, #cmt-imported-document code { padding: 1px 4px; border-radius: 4px; background: var(--code); font-family: "SFMono-Regular", Consolas, monospace; font-size: 13px; }
.mdh-doc pre code, #cmt-imported-document pre code { display: block; padding: 0; background: transparent; border-radius: 0; line-height: 1.7; white-space: pre-wrap; }
.mdh-doc img, #cmt-imported-document img { max-width: 100%; height: auto; }
.mdh-doc ul.contains-task-list { padding-left: 0; list-style: none; }
.mdh-doc .task-list-item { list-style: none; }
.mdh-doc > :first-child { margin-top: 0; }
.mdh-doc > :last-child { margin-bottom: 0; }
@media (max-width: 860px) {
  .mdh-shell, .mdh-shell.mdh-toc-collapsed { max-width: 100%; grid-template-columns: minmax(0, 1fr); gap: 24px; justify-content: stretch; padding: 24px 18px 48px; }
  .mdh-shell.mdh-toc-collapsed .mdh-toc { display: block; visibility: hidden; pointer-events: none; transform: translateX(calc(-100% - 18px)); }
  .mdh-toc-toggle { z-index: 30; }
  .mdh-toc { position: fixed; top: 56px; left: 12px; z-index: 20; width: min(320px, calc(100vw - 24px)); max-height: calc(100vh - 72px); overflow-y: auto; overscroll-behavior: contain; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: 0 16px 40px rgba(34,34,34,.14); transform: translateX(0); visibility: visible; transition: transform .16s ease, visibility .16s ease; }
  .mdh-doc h1, .mdh-doc h2, .mdh-doc h3, .mdh-doc h4 { scroll-margin-top: 68px; }
  .mdh-title h1 { font-size: 32px; }
  .mdh-doc table.mdh-stackable-table, #cmt-imported-document table.mdh-stackable-table { display: block; border: 0; border-radius: 0; background: transparent; box-shadow: none; overflow: visible; }
  .mdh-doc table.mdh-stackable-table thead, #cmt-imported-document table.mdh-stackable-table thead { display: none; }
  .mdh-doc table.mdh-stackable-table tbody, .mdh-doc table.mdh-stackable-table tr, .mdh-doc table.mdh-stackable-table td, #cmt-imported-document table.mdh-stackable-table tbody, #cmt-imported-document table.mdh-stackable-table tr, #cmt-imported-document table.mdh-stackable-table td { display: block; width: 100%; }
  .mdh-doc table.mdh-stackable-table tr, #cmt-imported-document table.mdh-stackable-table tr { margin: 0 0 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel); box-shadow: 0 1px 2px rgba(34,34,34,.04); overflow: hidden; }
  .mdh-doc table.mdh-stackable-table td, #cmt-imported-document table.mdh-stackable-table td { display: grid; grid-template-columns: minmax(92px, 34%) minmax(0, 1fr); gap: 10px; align-items: start; border: 0; border-bottom: 1px solid var(--line); padding: 10px 12px; background: transparent; }
  .mdh-doc table.mdh-stackable-table td:last-child, #cmt-imported-document table.mdh-stackable-table td:last-child { border-bottom: 0; }
  .mdh-doc table.mdh-stackable-table td::before, #cmt-imported-document table.mdh-stackable-table td::before { content: attr(data-label); display: block; color: var(--muted); font-size: 11px; font-weight: 760; }
  .mdh-doc table.mdh-stackable-table td.mdh-num, #cmt-imported-document table.mdh-stackable-table td.mdh-num { text-align: left; white-space: normal; }
  .mdh-doc .mdh-table-scroll:has(> table.mdh-stackable-table), #cmt-imported-document .mdh-table-scroll:has(> table.mdh-stackable-table) { overflow-x: visible; }
  .mdh-doc table.mdh-stackable-table .mdh-col-resizer, #cmt-imported-document table.mdh-stackable-table .mdh-col-resizer { display: none; }
  .mdh-doc table.mdh-stackable-table.mdh-table-resized, #cmt-imported-document table.mdh-stackable-table.mdh-table-resized { width: auto !important; }
  .mdh-doc table.mdh-stackable-table.mdh-table-autofilled, #cmt-imported-document table.mdh-stackable-table.mdh-table-autofilled { width: auto !important; table-layout: auto !important; }
}
/* コメントレビュー注入時のみ、右のコメントパネル幅を本文の外側に確保する。
   コメントランタイムはパネルを fixed でオーバーレイするだけで本文領域を狭めないため、中央寄せの
   .mdh-shell が右端でパネル下に潜り込み本文が切れる。--cmt-panel-width は コメントランタイムが
   :root へ px 同期する変数で、runtime 非注入の通常閲覧では body.cmt-mode-comment が付かないため
   このブロックは発火せず、860px 中央寄せの見た目は不変。
   コメントランタイム側の 760px 以下ではパネルが下部シートへ変わるので対象外。 */
@media (min-width: 761px) {
  body.cmt-mode-comment:not(.cmt-panel-collapsed) .mdh-shell,
  body.cmt-mode-comment:not(.cmt-panel-collapsed) .mdh-shell.mdh-toc-collapsed { padding-right: calc(24px + var(--cmt-panel-width, 0px)); }
  body.cmt-mode-comment:not(.cmt-panel-collapsed) .mdh-shell { max-width: calc(1180px + var(--cmt-panel-width, 0px)); }
  body.cmt-mode-comment:not(.cmt-panel-collapsed) .mdh-shell.mdh-toc-collapsed { max-width: calc(860px + var(--cmt-panel-width, 0px)); }
}
@media (min-width: 861px) {
  body.cmt-mode-comment:not(.cmt-panel-collapsed) .mdh-shell:not(.mdh-toc-collapsed) { grid-template-columns: minmax(0, 220px) minmax(0, 760px); }
}
`;

export const HEATMAP_CSS = `
.mdh-doc .mdh-table-block, #cmt-imported-document .mdh-table-block { margin: 20px 0 28px; }
.mdh-doc .mdh-table-block > .mdh-table-scroll, #cmt-imported-document .mdh-table-block > .mdh-table-scroll { margin: 0; }
.mdh-doc .mdh-view-toggle, #cmt-imported-document .mdh-view-toggle { display: inline-flex; gap: 0; padding: 3px; background: var(--soft); border-radius: 10px; }
.mdh-doc .mdh-view-toggle input[type="radio"], #cmt-imported-document .mdh-view-toggle input[type="radio"] { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
.mdh-doc .mdh-view-toggle label, #cmt-imported-document .mdh-view-toggle label { display: inline-flex; align-items: center; min-height: 28px; padding: 6px 11px; color: var(--muted); border-radius: 7px; font: inherit; font-size: 11px; font-weight: 800; cursor: pointer; }
.mdh-doc .mdh-view-toggle input[type="radio"]:checked + label, #cmt-imported-document .mdh-view-toggle input[type="radio"]:checked + label { color: var(--ink); background: var(--panel); box-shadow: 0 1px 4px rgba(34,34,34,.12); }
.mdh-doc .mdh-view-toggle input[type="radio"]:focus-visible + label, #cmt-imported-document .mdh-view-toggle input[type="radio"]:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 1px; }
.mdh-doc .mdh-table-block > .mdh-view-toggle, #cmt-imported-document .mdh-table-block > .mdh-view-toggle { margin-bottom: 10px; }
.mdh-doc .mdh-table-block:has(input[value="heatmap"]:checked) td.mdh-heat, #cmt-imported-document .mdh-table-block:has(input[value="heatmap"]:checked) td.mdh-heat { background: var(--mdh-heat); }
`;
