// タイトルの行。static-renderer.mjs は編集版のブラウザの bundle にも入るため、Node の依存を持たないこのファイルに置き、
// markdown-document.mjs から出し直す。

// 改行（\r\n も \n とみなす）で分け、各行の前後の空白を取り、空の行を捨てる。
export const titleLines = (title) => String(title).replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);

// 見える見出し以外（<title>・一覧・書き出しのファイル名・先頭の見出しとの重なりの判定）で使う 1 行のタイトル。
export function oneLineTitle(title) {
  return titleLines(title).join(' ');
}
