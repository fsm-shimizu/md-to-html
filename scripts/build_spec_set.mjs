// 仕様書セットの一括ビルド。
//
//   node scripts/build_spec_set.mjs <setDir>
//
// 出力は常に `<setDir>/html/`（`--out` は設けない）。
// 実行契約: lock → 起動時リコンシリエーション → `.html.tmp/` へ生成 → §4.5 検査
//           → 削除ガード → swap（html→.html.old→html）→ .html.old 削除。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNotionHtmlString } from './lib/build-notion.mjs';
import { parseMarkdownDocument } from './lib/markdown-document.mjs';
import { renderPage, escapeHtml } from './lib/static-renderer.mjs';
import { buildSetIndex, buildHubModel, rewriteSpecLinks } from './lib/spec-set.mjs';
import { validateSpecSetDir, SPEC_SET_MARKER } from './validate_spec_set.mjs';

const LOCK_NAME = '.spec-set.lock';
const TMP_NAME = '.html.tmp';
const OLD_NAME = '.html.old';
const HTML_NAME = 'html';
const HUB_NAME = 'index.html';
const HUB_LINK = { href: `./${HUB_NAME}`, label: '索引' };
const MARKER_BODY = 'md-to-html spec set output. Managed by scripts/build_spec_set.mjs — do not hand-edit.\n';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');

// buildSetIndex の throw コードを CLI メッセージへ変換するときのヒント（§5 の graceful degradation）
export const SET_INDEX_ERROR_HINTS = {
  SPEC_SET_DIR_NOT_FOUND: 'セットディレクトリのパスを確認してください（相対パスは cwd 基準で解決されます）。',
  SPEC_SET_EMPTY: 'セットは <setDir> 直下の *.md 全件です（再帰なし・dotfile 除外）。',
  SPEC_SET_INDEX_MD: 'index.html は索引ハブの生成物です。index.md はセット外へ移すか改名してください。',
  SPEC_SET_CASE_COLLISION: '出力 html の basename が衝突します。大文字小文字だけが異なるファイル名を避けてください。'
};

export function describeSetIndexError(error) {
  const message = error?.message ?? String(error);
  const hint = SET_INDEX_ERROR_HINTS[error?.code];
  return hint ? `${message}\n  ヒント: ${hint}` : message;
}

// ---------------------------------------------------------------------------
// ビルド本体
// ---------------------------------------------------------------------------
export async function buildSpecSet(setDirInput, { log = console.log, warn = console.warn } = {}) {
  const setDir = path.resolve(setDirInput);

  // lock は setDir 内に作るため、先に実在を確かめて buildSetIndex と同じ診断に寄せる
  if (!isDirectory(setDir)) {
    throw specSetError('SPEC_SET_DIR_NOT_FOUND', `セットディレクトリが存在しません: ${setDir}`);
  }
  const realSetDir = fs.realpathSync(setDir);

  const lockDir = path.join(setDir, LOCK_NAME);
  const tmpDir = path.join(setDir, TMP_NAME);
  const oldDir = path.join(setDir, OLD_NAME);
  const htmlDir = path.join(setDir, HTML_NAME);

  // 1. 同時実行ガード（mkdir・待機しない）
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw specSetError(
        'SPEC_SET_LOCKED',
        `他のビルドが実行中です（待機しません）: ${lockDir}\n` +
          `  停止済みプロセスの残骸であれば、このディレクトリを手で削除してから再実行してください。`
      );
    }
    throw error;
  }

  try {
    // 1'. 起動時リコンシリエーション
    reconcile({ realSetDir, htmlDir, tmpDir, oldDir, warn });

    // 2. セット索引
    const setIndex = buildSetIndex(setDir);

    // 3. 削除ガードの前倒し（生成前に手置き html/ を検出して無駄な生成をしない）
    assertReplaceable(htmlDir, realSetDir);

    // 4. 一時領域へ全件生成
    fs.mkdirSync(tmpDir);
    fs.writeFileSync(path.join(tmpDir, SPEC_SET_MARKER), MARKER_BODY);

    const diagnostics = [];
    for (const doc of setIndex.docs) {
      const raw = fs.readFileSync(doc.inputPath, 'utf8');
      const collected = [];
      const html = await buildNotionHtmlString(raw, doc.inputPath, {
        hastTransforms: [(tree) => rewriteSpecLinks(tree, { setIndex, currentDoc: doc, diagnostics: collected })],
        hubLink: HUB_LINK,
        onWarning: ({ line, reason, marker }) => warn(`警告: ${doc.inputPath}:${line} ${reason}: ${marker}`)
      });
      // hast の line は「frontmatter・先頭 H1 を落とした本文」基準なので、元ファイルの行番号へ戻す
      const offset = lineOffsetOf(raw, doc.inputPath);
      for (const item of collected) {
        diagnostics.push({ ...item, line: typeof item.line === 'number' ? item.line + offset : item.line });
      }
      fs.writeFileSync(path.join(tmpDir, doc.outName), html);
    }
    fs.writeFileSync(path.join(tmpDir, HUB_NAME), renderHubPage(setIndex));

    // 5. 診断の出力（error があれば一時領域だけ捨てて fail）
    for (const item of diagnostics.filter((d) => d.severity === 'warning')) warn(formatDiagnostic(item));
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length) {
      for (const item of errors) warn(formatDiagnostic(item));
      removeManagedDir(tmpDir, realSetDir);
      throw specSetError('SPEC_SET_LINK_ERRORS', `リンク解決に失敗しました（${errors.length} 件）。既存の html/ は変更していません。`);
    }

    // 6. 一時領域に対する §4.5 検査（CLI と validate_spec_set.mjs で共用）
    const { failures } = await validateSpecSetDir(tmpDir);
    if (failures.length) {
      for (const failure of failures) warn(`error validate ${failure}`);
      removeManagedDir(tmpDir, realSetDir);
      throw specSetError('SPEC_SET_VALIDATION_FAILED', `生成物の検査に失敗しました（${failures.length} 件）。既存の html/ は変更していません。`);
    }

    // 7. swap（rename ×2＋旧領域削除）
    if (fs.existsSync(htmlDir)) {
      assertReplaceable(htmlDir, realSetDir);
      fs.renameSync(htmlDir, oldDir);
    }
    fs.renameSync(tmpDir, htmlDir);
    if (fs.existsSync(oldDir)) removeManagedDir(oldDir, realSetDir);

    log(`Wrote ${htmlDir} (${setIndex.docs.length} docs + ${HUB_NAME})`);
    if (diagnostics.length) log(`warnings: ${diagnostics.length}`);
    return { htmlDir, docs: setIndex.docs.length, diagnostics };
  } catch (error) {
    // 生成途中で落ちた場合も一時領域を残さない（既存 html/ は触っていない）
    if (fs.existsSync(tmpDir)) {
      try {
        removeManagedDir(tmpDir, realSetDir);
      } catch {
        /* 掃除失敗は元エラーを優先して握りつぶす */
      }
    }
    throw error;
  } finally {
    // 自プロセスが取った lock のみ解放する
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 索引ハブ
// ---------------------------------------------------------------------------
function renderHubPage(setIndex) {
  const { items } = buildHubModel(setIndex.docs);
  const list = items
    .map((item) => `        <li><a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a></li>`)
    .join('\n');
  const bodyHtml = `\n      <ul class="mdh-hub-list">\n${list}\n      </ul>\n    `;
  return renderPage({ title: setIndex.setName, data: {}, toc: [], bodyHtml }, { hubLink: HUB_LINK });
}

// ---------------------------------------------------------------------------
// リコンシリエーション・削除ガード
// ---------------------------------------------------------------------------
function reconcile({ realSetDir, htmlDir, tmpDir, oldDir, warn }) {
  if (fs.existsSync(oldDir)) {
    if (!fs.existsSync(htmlDir)) {
      // rename1 と rename2 の間でクラッシュした状態 → 直前の正常出力を html/ へ戻す
      assertManagedDir(oldDir, realSetDir);
      fs.renameSync(oldDir, htmlDir);
      warn(`recovered ${htmlDir} from ${oldDir}`);
    } else {
      // rename2 後・.html.old 削除前でクラッシュした状態
      removeManagedDir(oldDir, realSetDir);
    }
  }
  if (fs.existsSync(tmpDir)) removeManagedDir(tmpDir, realSetDir);
}

// 既存 html/ を置換してよいか（存在しない・空・マーカーを含む のいずれか）
function assertReplaceable(htmlDir, realSetDir) {
  if (!fs.existsSync(htmlDir)) return;
  assertManagedDir(htmlDir, realSetDir);
  const entries = fs.readdirSync(htmlDir);
  if (entries.length === 0) return;
  if (entries.includes(SPEC_SET_MARKER)) return;
  throw specSetError(
    'SPEC_SET_UNMANAGED_HTML_DIR',
    `既存の html/ に ${SPEC_SET_MARKER} マーカーがありません。手置きファイルを保護するため置換しません: ${htmlDir}`
  );
}

// symlink 経由の外部誘導を排除したうえで「setDir 直下の当該ディレクトリそのもの」であることを確認する
function assertManagedDir(target, realSetDir) {
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink()) {
    throw specSetError('SPEC_SET_UNSAFE_PATH', `symlink は操作対象にできません: ${target}`);
  }
  if (!stats.isDirectory()) {
    throw specSetError('SPEC_SET_UNSAFE_PATH', `ディレクトリではありません: ${target}`);
  }
  const real = fs.realpathSync(target);
  const expected = path.join(realSetDir, path.basename(target));
  if (real !== expected) {
    throw specSetError('SPEC_SET_UNSAFE_PATH', `セット外を指すため操作しません: ${target} → ${real}`);
  }
}

function removeManagedDir(target, realSetDir) {
  assertManagedDir(target, realSetDir);
  fs.rmSync(target, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------
function lineOffsetOf(raw, inputPath) {
  try {
    const parsed = parseMarkdownDocument(raw, inputPath);
    return countLines(raw) - countLines(parsed.markdown);
  } catch {
    return 0;
  }
}

function countLines(text) {
  return String(text).split('\n').length;
}

function formatDiagnostic({ severity, kind, file, line, url, message }) {
  const where = file ? `${file}:${line ?? '?'}` : '(unknown)';
  return `${severity} ${kind} ${where} ${url} — ${message}`;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function specSetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// npm script 経由（cwd がパッケージルートへ移る）でのみ INIT_CWD を優先する。
// node 直叩きでは INIT_CWD が親プロセスから漏れていても cwd を使う。
export function resolveSetDirArg(input, { cwd = process.cwd(), initCwd = process.env.INIT_CWD } = {}) {
  const resolvedInit = initCwd ? path.resolve(initCwd) : null;
  const base = resolvedInit && cwd === packageRoot && resolvedInit !== packageRoot ? resolvedInit : cwd;
  return path.resolve(base, input);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const usage = 'Usage: node scripts/build_spec_set.mjs <setDir>';

  if (args.includes('--out')) {
    console.error(`--out は実装しません。出力は常に <setDir>/html/ です。\n${usage}`);
    process.exit(1);
  }
  const unknownFlag = args.find((arg) => arg.startsWith('-'));
  if (unknownFlag) {
    console.error(`不明なオプションです: ${unknownFlag}\n${usage}`);
    process.exit(1);
  }
  if (args.length !== 1) {
    console.error(usage);
    process.exit(1);
  }

  try {
    await buildSpecSet(resolveSetDirArg(args[0]));
  } catch (error) {
    console.error(describeSetIndexError(error));
    process.exit(1);
  }
}
