// 仕様書セット出力の検証。
//
// 検査ロジックは export し、build_spec_set.mjs の swap 前検証と共用する。
// 単体でも `node scripts/validate_spec_set.mjs <setDir|htmlDir>` で動く。
//   1. `.mdh-spec-set` マーカーと index.html が存在し、index が全文書へのリンクを持つ
//   2. 各 html の nav.mdh-hub-nav が存在し index.html を指す
//   3. 全 html の相対 a[href] / img[src] が FS 上の実在ファイルへ解決する
//   4. .md を指す相対 <a> が残っていない（span.mdh-external-md は対象外）
//   5. 既存 validate_notion_html.mjs を各 html に対して実行し pass する
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

const execFileAsync = promisify(execFile);

export const SPEC_SET_MARKER = '.mdh-spec-set';
export const HUB_INDEX_NAME = 'index.html';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOTION_VALIDATOR = path.join(here, 'validate_notion_html.mjs');

// 引数は setDir / htmlDir のどちらでも受ける（検査は htmlDir を、規約コマンドは setDir を渡すため）。
// マーカーの所在で判別し、判別できない場合は html/ があればそれを検査対象にする（不在は検査側で fail）。
export function resolveHtmlDir(dir) {
  const resolved = path.resolve(dir);
  if (fs.existsSync(path.join(resolved, SPEC_SET_MARKER))) return resolved;
  const nested = path.join(resolved, 'html');
  if (fs.existsSync(path.join(nested, SPEC_SET_MARKER))) return nested;
  if (isDirectory(nested)) return nested;
  return resolved;
}

export async function validateSpecSetDir(dir, { runNotionValidator = true } = {}) {
  const htmlDir = resolveHtmlDir(dir);
  const failures = [];
  const fail = (message) => failures.push(message);

  if (!isDirectory(htmlDir)) {
    fail(`出力ディレクトリがありません: ${htmlDir}`);
    return { htmlDir, failures, checked: [] };
  }

  // 1. マーカー・index.html
  if (!fs.existsSync(path.join(htmlDir, SPEC_SET_MARKER))) {
    fail(`セットマーカーがありません: ${path.join(htmlDir, SPEC_SET_MARKER)}`);
  }

  const checked = fs
    .readdirSync(htmlDir)
    .filter((name) => name.toLowerCase().endsWith('.html'))
    .sort();
  const docNames = checked.filter((name) => name !== HUB_INDEX_NAME);

  if (!checked.includes(HUB_INDEX_NAME)) {
    fail(`索引ハブがありません: ${path.join(htmlDir, HUB_INDEX_NAME)}`);
  } else {
    const $index = load(fs.readFileSync(path.join(htmlDir, HUB_INDEX_NAME), 'utf8'));
    const linked = new Set(
      $index('article.mdh-doc a')
        .toArray()
        .map((el) => targetNameOf($index(el).attr('href')))
        .filter(Boolean)
    );
    for (const name of docNames) {
      if (!linked.has(name)) fail(`索引ハブに ${name} へのリンクがありません`);
    }
  }

  // 2〜4. 各 html
  for (const name of checked) {
    const filePath = path.join(htmlDir, name);
    const $ = load(fs.readFileSync(filePath, 'utf8'));

    const hub = $('nav.mdh-hub-nav');
    if (hub.length !== 1) {
      fail(`${name}: nav.mdh-hub-nav が1つではありません（${hub.length}）`);
    } else {
      const href = hub.find('a').attr('href');
      if (targetNameOf(href) !== HUB_INDEX_NAME) {
        fail(`${name}: ハブナビが index.html を指していません（${href ?? 'href なし'}）`);
      }
    }

    for (const [selector, property] of [['a[href]', 'href'], ['img[src]', 'src']]) {
      for (const el of $(selector).toArray()) {
        const url = $(el).attr(property);
        const pathPart = pathPartOf(url);
        if (!pathPart) continue;                                   // fragment のみ・空
        if (hasScheme(pathPart) || pathPart.startsWith('//')) continue;
        if (pathPart.startsWith('/')) continue;                    // root 相対は検査対象外（§4.2 行5）

        if (property === 'href' && pathPart.toLowerCase().endsWith('.md')) {
          fail(`${name}: .md を指す相対リンクが残っています（${url}）`);
          continue;
        }
        const target = path.resolve(htmlDir, pathPart);
        if (!fs.existsSync(target)) {
          fail(`${name}: 相対参照が解決しません（${url} → ${target}）`);
        }
      }
    }
  }

  // 5. 既存 validator
  if (runNotionValidator) {
    for (const name of checked) {
      try {
        await execFileAsync(process.execPath, [NOTION_VALIDATOR, path.join(htmlDir, name)]);
      } catch (error) {
        const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').join(' / ');
        fail(`${name}: validate_notion_html.mjs が fail しました（${detail}）`);
      }
    }
  }

  return { htmlDir, failures, checked };
}

// ---------------------------------------------------------------------------
// URL ユーティリティ（判定順は spec-set.mjs と同じく「1回 decode → 判定」）
// ---------------------------------------------------------------------------
function pathPartOf(url) {
  if (typeof url !== 'string') return '';
  const raw = url.match(/^([^?#]*)/)?.[1] ?? '';
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function targetNameOf(url) {
  const pathPart = pathPartOf(url);
  if (!pathPart || hasScheme(pathPart) || pathPart.startsWith('//')) return null;
  return path.basename(pathPart);
}

function hasScheme(pathPart) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathPart);
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// 非 ASCII パスでも壊れないよう fileURLToPath で比較する（文字列 URL 比較は使わない）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/validate_spec_set.mjs <setDir|htmlDir>');
    process.exit(1);
  }

  const { htmlDir, failures, checked } = await validateSpecSetDir(input);
  if (failures.length) {
    console.error(`Validation failed for ${htmlDir}`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`Validated ${htmlDir} (${checked.length} pages)`);
}
