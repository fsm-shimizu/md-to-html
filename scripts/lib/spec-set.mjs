// 仕様書セット（as-built 層）の純関数群。
// 副作用は「FS の読み取り」のみ（書込・プロセス終了・stdout 出力はしない）。
import fs from 'node:fs';
import path from 'node:path';
import { visit } from 'unist-util-visit';
import { parseMarkdownDocument, oneLineTitle } from './markdown-document.mjs';

// 索引ハブの並び順プレフィクス（大文字小文字無視）
const HUB_PREFIX_ORDER = ['readme', 'requirement', 'spec', 'plan'];

export function specSetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// buildSetIndex — セット索引の導出
// ---------------------------------------------------------------------------
export function buildSetIndex(setDir) {
  const resolvedDir = path.resolve(setDir);

  let realSetDir;
  try {
    realSetDir = fs.realpathSync(resolvedDir);
  } catch {
    throw specSetError('SPEC_SET_DIR_NOT_FOUND', `セットディレクトリが存在しません: ${resolvedDir}`);
  }
  if (!fs.statSync(realSetDir).isDirectory()) {
    throw specSetError('SPEC_SET_DIR_NOT_FOUND', `セットディレクトリではありません: ${resolvedDir}`);
  }

  const docs = [];
  for (const entry of fs.readdirSync(resolvedDir, { withFileTypes: true })) {
    const basename = entry.name;
    if (basename.startsWith('.')) continue;                              // dotfile 除外
    if (path.extname(basename).toLowerCase() !== '.md') continue;        // 拡張子は小文字化後に判定

    const inputPath = path.join(resolvedDir, basename);
    let real;
    try {
      if (!fs.statSync(inputPath).isFile()) continue;                    // 再帰なし・ディレクトリ除外
      real = fs.realpathSync(inputPath);
    } catch {
      continue;
    }
    // realpath でセット外を指す .md はセット外扱い（symlink 封じ込め）
    if (path.dirname(real) !== realSetDir) continue;

    const stem = basename.slice(0, basename.length - path.extname(basename).length);
    docs.push({ basename, stem, inputPath, outName: `${stem}.html`, title: readTitle(inputPath, stem) });
  }

  docs.sort((a, b) => compareByName(a.basename, b.basename));

  const indexDoc = docs.find((doc) => doc.basename.toLowerCase() === 'index.md');
  if (indexDoc) {
    throw specSetError('SPEC_SET_INDEX_MD', `index.md は索引ハブの生成物と衝突するためセットに置けません: ${indexDoc.inputPath}`);
  }

  const collisions = findCaseCollisions(docs.map((doc) => doc.basename));
  if (collisions.length) {
    const { first, second } = collisions[0];
    throw specSetError('SPEC_SET_CASE_COLLISION', `basename が大文字小文字違いで衝突しています: ${first} / ${second}`);
  }

  if (docs.length === 0) {
    throw specSetError('SPEC_SET_EMPTY', `セットに *.md がありません: ${resolvedDir}`);
  }

  return {
    setDir: resolvedDir,
    realSetDir,
    setName: path.basename(resolvedDir),
    htmlDir: path.join(resolvedDir, 'html'),
    docs,
    byName: new Map(docs.map((doc) => [doc.basename, doc]))
  };
}

// basename 配列だけを見る純粋 helper（FS 非依存・大文字小文字違いの衝突検出）
export function findCaseCollisions(basenames = []) {
  const seen = new Map();
  const collisions = [];
  for (const basename of basenames) {
    const key = String(basename).toLowerCase();
    if (seen.has(key)) collisions.push({ key, first: seen.get(key), second: basename });
    else seen.set(key, basename);
  }
  return collisions;
}

// title は parseMarkdownDocument の既存規則（frontmatter title → H1 → ファイル名）をそのまま使う
function readTitle(inputPath, stem) {
  try {
    const parsed = parseMarkdownDocument(fs.readFileSync(inputPath, 'utf8'), inputPath);
    return typeof parsed.title === 'string' && parsed.title.trim() ? oneLineTitle(parsed.title) : stem;
  } catch {
    return stem;
  }
}

// ---------------------------------------------------------------------------
// rewriteSpecLinks — hast の a[href] / img[src] を書換
// ---------------------------------------------------------------------------
export function rewriteSpecLinks(tree, { setIndex, currentDoc, diagnostics = [] } = {}) {
  if (!setIndex) throw specSetError('SPEC_SET_NO_INDEX', 'rewriteSpecLinks には setIndex が必要です');

  const fromDir = currentDoc?.inputPath ? path.dirname(currentDoc.inputPath) : setIndex.setDir;
  const toDir = setIndex.htmlDir;
  const file = currentDoc?.inputPath ?? currentDoc?.basename ?? null;

  visit(tree, 'element', (node) => {
    const properties = node.properties;
    if (!properties) return;

    if (node.tagName === 'a' && typeof properties.href === 'string') {
      handleUrl(node, 'href', 'a');
    } else if (node.tagName === 'img' && typeof properties.src === 'string') {
      handleUrl(node, 'src', 'img');
    }
  });

  return tree;

  function handleUrl(node, property, elementKind) {
    const url = node.properties[property];
    const line = node.position?.start?.line ?? null;
    const { pathPart, suffix } = splitUrl(url);

    // fragment のみ（#section）／query のみ → 素通し
    if (pathPart === '') return;

    // path 部を1回だけ percent-decode してから scheme / root 相対を判定する
    // （`%2Fetc%2Fhosts` を root 相対として扱わないと再基準化で外部パスへ逃げるため）
    const decoded = decodeOnce(pathPart);

    // 外部 URL・mailto: 等・プロトコル相対 → 素通し（既存 sanitize に委ねる）
    if (hasScheme(decoded) || decoded.startsWith('//')) return;
    // root 相対（/docs/…）→ 素通し＋warning
    if (decoded.startsWith('/')) {
      diagnostics.push(diagnostic('warning', 'root-relative', 'root 相対 URL は書換・検査の対象外です'));
      return;
    }

    const absolute = path.resolve(fromDir, decoded);
    const isMarkdown = path.extname(decoded).toLowerCase() === '.md';
    const exists = fs.existsSync(absolute);

    if (isMarkdown) {
      // 判定表 行1/行2 共通: img[src] が .md を指す場合は setIndex 所属を問わず fail
      // （置換概念が適用不能な誤用。所属時に .html へ書換えると壊れた画像が検査を通過する）
      if (elementKind === 'img') {
        diagnostics.push(diagnostic('error', 'img-md', 'img[src] が .md を指しています（画像として解決不能）'));
        return;
      }
      // 相対 .md・FS 上に不在（セット内外問わず）→ fail
      if (!exists) {
        diagnostics.push(diagnostic('error', 'missing-md', '相対 .md リンクの参照先が存在しません'));
        return;
      }
      const member = memberOf(setIndex, absolute);
      if (member) {
        // 判定表 行1: setIndex 所属 → ./<stem>.html（同一ディレクトリ出力のため basename 化と等価）
        node.properties[property] = `./${encodePath(member.outName)}${suffix}`;
        return;
      }
      // 判定表 行2: setIndex 非所属・FS 実在
      unlinkAnchor(node, url);
      diagnostics.push(diagnostic('warning', 'external-md', 'セット外の .md リンクを解除しました'));
      return;
    }

    // 判定表 行7: 相対の非 .md（添付・画像）→ html/ 基準へ再基準化。不在は fail
    if (!exists) {
      diagnostics.push(diagnostic('error', 'missing-asset', '相対参照の参照先が存在しません'));
      return;
    }
    node.properties[property] = rebaseRelativeUrl(url, fromDir, toDir);

    function diagnostic(severity, kind, message) {
      return { file, line, url, kind, severity, message };
    }
  }
}

// <a> を <span class="mdh-external-md" title="<元パス>"> へ置換（壊れリンクを残さない）。
// リンク付きカード（a.mdh-card-link）は通常のカード（div.mdh-card）にし、アイコンを外してタイトルの中身を span で包む。
function unlinkAnchor(node, originalUrl) {
  const className = node.properties?.className || [];
  if (className.includes('mdh-card-link')) {
    node.tagName = 'div';
    node.properties = { className: className.filter((name) => name !== 'mdh-card-link') };
    node.children = node.children.filter((child) => !(child.type === 'element' && child.tagName === 'svg' && (child.properties?.className || []).includes('mdh-card-icon')));
    const title = node.children.find((child) => child.type === 'element' && (child.properties?.className || []).includes('mdh-card-title'));
    if (title) title.children = [{ type: 'element', tagName: 'span', properties: { className: ['mdh-external-md'], title: originalUrl }, children: title.children }];
    return;
  }
  node.tagName = 'span';
  node.properties = { className: ['mdh-external-md'], title: originalUrl };
}

function memberOf(setIndex, absolutePath) {
  let real;
  try {
    real = fs.realpathSync(absolutePath);
  } catch {
    return null;
  }
  // symlink 脱出・サブディレクトリはセット外
  if (path.dirname(real) !== setIndex.realSetDir) return null;
  return setIndex.byName.get(path.basename(real)) ?? null;
}

// ---------------------------------------------------------------------------
// rebaseRelativeUrl — 出力が html/ へ1階層下がる分の基準変換
// ---------------------------------------------------------------------------
export function rebaseRelativeUrl(url, fromDir, toDir) {
  if (typeof url !== 'string' || url === '') return url;

  const { pathPart, suffix } = splitUrl(url);
  if (pathPart === '') return url;

  // handleUrl と同じ順序（1回 decode → 判定）。percent-encode された scheme / root 相対も素通しにする
  const decoded = decodeOnce(pathPart);
  if (hasScheme(decoded) || decoded.startsWith('//') || decoded.startsWith('/')) return url;

  const absolute = path.resolve(fromDir, decoded);
  let relative = path.relative(toDir, absolute);
  if (relative === '') relative = '.';
  relative = relative.split(path.sep).join('/');

  const encoded = encodePath(relative);
  const normalized = encoded.startsWith('../') || encoded.startsWith('./') ? encoded : `./${encoded}`;
  return `${normalized}${suffix}`;
}

// ---------------------------------------------------------------------------
// buildHubModel — 索引ハブの入力モデル
// ---------------------------------------------------------------------------
export function buildHubModel(docs = []) {
  const items = docs
    .map((doc) => {
      const basename = doc.basename;
      const outName = doc.outName ?? `${basename.slice(0, basename.length - path.extname(basename).length)}.html`;
      const stem = doc.stem ?? basename.slice(0, basename.length - path.extname(basename).length);
      return {
        basename,
        outName,
        href: `./${encodePath(outName)}`,
        title: typeof doc.title === 'string' && doc.title.trim() ? doc.title : stem
      };
    })
    .sort((a, b) => hubRank(a.basename) - hubRank(b.basename) || compareByName(a.basename, b.basename));

  return { items };
}

function hubRank(basename) {
  const lower = basename.toLowerCase();
  const index = HUB_PREFIX_ORDER.findIndex((prefix) => lower.startsWith(prefix));
  return index === -1 ? HUB_PREFIX_ORDER.length : index;
}

// ---------------------------------------------------------------------------
// URL 文字列ユーティリティ
// ---------------------------------------------------------------------------
function splitUrl(url) {
  const match = String(url).match(/^([^?#]*)((?:\?[^#]*)?(?:#.*)?)$/);
  return { pathPart: match?.[1] ?? '', suffix: match?.[2] ?? '' };
}

function hasScheme(pathPart) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathPart);
}

// percent-decode は1回だけ
function decodeOnce(pathPart) {
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

function encodePath(relativePath) {
  return relativePath
    .split('/')
    .map((segment) => (segment === '.' || segment === '..' ? segment : encodeURIComponent(segment)))
    .join('/');
}

function compareByName(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
