# md-to-html

Markdown documentsをNotion風の静的HTML、または軽量編集付きHTMLに変換する。

## Setup

Node.js が必要（v26 で動作確認済み）。ブラウザ検証（`layout:*`・`e2e`）は Playwright の Chromium を使う。

```bash
npm install
npx playwright install chromium
```

## Static Mode

```bash
node scripts/build_notion_html.mjs input.md --out output.html
node scripts/validate_notion_html.mjs output.html
```

通常は静的HTMLを使う。静的HTMLは文書タイトル、本文、TOCを分離して表示し、TOCはボタンで開閉できる。TOCを閉じると本文は中央寄せになる。

## Editable Mode

```bash
node scripts/build_editable_notion_html.mjs input.md --out output.editable.html
node scripts/validate_editable_notion_html.mjs output.editable.html
```

編集版はブラウザ内runtimeを含み、本文の軽微な編集、localStorage保存、Markdown export、静的HTML exportに対応する。編集状態は `blocks[]` を正とし、Markdown exportは `blocks[] -> mdast -> remark-stringify` 経由で生成する。

編集版にも見出し由来のTOCを表示する。見出しテキストを編集するとTOCも更新され、TOC開閉時の本文中央寄せは静的版と同じ挙動になる。

左側の `+` からブロック追加、ブロックメニューから Text / Heading / Code / Quote への変換、Duplicate、Delete、Move up/down を操作できる。paragraph先頭のSlash menuとMarkdown shortcutにも対応し、`#` / `##` / `###` / code fence / `>` / `-` / `1.` / `[ ]` から見出し、コード、引用、リスト、ToDoへ変換できる。

リストとToDoはitem単位で編集できる。ToDo checkboxのtoggleもlocalStorage保存、Markdown export、Undo/Redoの対象になる。

ブロックのD&Dは、デスクトップでトップレベルブロックの上下移動のみ対応する。リスト項目、表の行列、引用内の子ブロック、見出し配下セクション全体の移動、モバイルD&Dは未対応。

編集操作は `⌘Z` / `Ctrl+Z` でundo、`⌘⇧Z` / `Ctrl+Shift+Z` でredoできる。テキスト編集、ブロック追加・削除、タイプ変更、D&D並び替えを同じ履歴で扱う。

モバイルではTOCをfixed drawerとして表示する。静的版はモバイルviewportで初期collapseし、編集版は保存済みTOC preferenceがなければ初期collapseする。保存済みpreferenceがある場合はReset edits後もユーザー選択を優先する。

## Verification

```bash
npm run build
npm run validate
npm run build:editable
npm run build:editable:table-stack
npm run build:editable:long
npm run validate:editable
npm run roundtrip
npm run test:dnd
npm run size:editable
npm run layout:toc
npm run layout:mobile
npm run layout:table
npm run layout:heatmap
for task in smoke 4 5 6 7 8 9 10 11 12 13 14 15 16 17; do npm run e2e -- --task "$task" || exit $?; done
```

- `size:editable`: editable HTMLが500,000 bytes以内に収まることを確認する。
- `layout:toc`: 展開可能なTOCで親見出しと最初の子見出しが重ならないことを実ブラウザで確認する。
- `layout:table`: 1280px viewportで見出しセル右端のハンドルを80pxドラッグし、その列と表だけが広がり、はみ出しが表の横スクロール枠に収まること、ダブルクリックで元に戻ることを確認する。
- `layout:heatmap`: 1280pxと390px viewportで、表／ヒートマップのradioラベル切り替え、数値列のalpha差、識別子列の非着色、表表示への復帰を実ブラウザで確認する。
- `layout:mobile`: 390px viewportでdrawer closed/openの横スクロールが出ないこと、mobile drawerがviewport内に収まること、閉状態のTOCが本文を押し下げないこと、3列以上の表だけstackされることを確認する。

## Mobile Tables

モバイルでは3列以上の表だけカード状にstackする。各セルにはヘッダー由来の `data-label` を付与し、2列表は通常の表レイアウトを維持する。静的HTMLと編集版runtimeの両方で同じ仕様にしている。

## Numeric Cells and Wide Tables

- 表の幅は内容に合わせる（`width: auto; max-width: 100%`）。見出しセル（th）は折り返さず、本文セル（td）の幅は `:root` の `--mdh-col-max-width`（既定 180px）を上限にして折り返す。列の最小幅は見出しの文字幅で決まり、上限を超える列が多い表は横スクロール枠に収まる（120px では文章列のセル高が大きくなりすぎるため、180px を既定にしている）。

- 数値だけのセル（`1,119`・`48%`・`579→422`・`30 人未満` など。数字と区切り記号・矢印・単位語だけで構成されるもの）には `mdh-num` クラスを付け、折り返さず右寄せ・等幅数字で表示する。列の本文セルがすべて数値なら見出しセルにも `mdh-num` を付け、列幅を内容に合わせて詰める。
- すべての表を `<div class="mdh-table-scroll">` で包み、列数が多くて本文幅に収まらない表は枠内で横スクロールさせる（ページ全体の横スクロールは出さない）。
- モバイル（860px 以下）のstack表示では `mdh-num` の右寄せと折り返し禁止を解除し、通常のカード表示に戻す。
- 列幅の変更: 見出しセルの右端をホールドして左右に動かすと、その列の幅だけが広がったり狭まったりする（Notion と同じ操作。最小 48px）。初回のドラッグ時に各列の実測幅を `<colgroup>` に固定して `table-layout: fixed` へ切り替え、広げた分は表全体が広がって横スクロール枠に収まる。ハンドルのダブルクリックで元の自動レイアウトに戻る。幅は保存しない（再読み込みで戻る）。モバイルのstack表示ではハンドルを出さない。script は `COLUMN_RESIZE_SCRIPT`（`scripts/lib/static-renderer.mjs`）。
- ヒートマップ切り替え: 表の直前に単独行で `<!-- mdh:heatmap -->` を置くと、その表だけに「表／ヒートマップ」のradioトグルを付ける。空行はマーカーと表の間に置けるが、別のブロックを挟むと対象外になる。ヒートマップは数値列ごとに値の大小をセル背景のalphaで示し、`#`・`No`・`No.`・`番号`列と `人未満`・`件未満` の秘匿値は着色しない。切り替えはCSSだけで行い、マーカー自体は出力HTMLへ残さない。
- ヒートマップ「主値」モード: `<!-- mdh:heatmap -->` の代わりに `<!-- mdh:heatmap primary -->` を置くと、その表だけを「主値」モードで着色する。`2.49%（7 / 281）`・`281 / 12（26.7%）`のように括弧補足（分子・分母や人数）を伴うセルでも、括弧の中身が数字・区切り・単位語（`人`・`組`・`件`・`回`・`日`・`km`等）だけなら残りを数値とみなし、`63 件 / 45 人`のように `/`・`／` で区切られた数値も数値セルとして扱う。値は、セルに `%`／`％` があれば最初の%値、無ければ最初の数値を取る（既定モードは従来どおり最後の数値）。`人未満`・`件未満` を含むセルはnull扱いで着色しない。見出し文字列に `順位` を含む列は主値モードでも着色しない（順位は小さいほど上位で、大小の色が逆に読まれるため）。色・alphaの写し方とCSSは既定モードと共通で、通番は文書内の対象表を両モード通して1始まりにする。既定モード（マーカー無しの `<!-- mdh:heatmap -->`）の挙動と出力は変えない。
- 外部リンク: `http://`・`https://` で始まる `href` の `<a>` にだけ `target="_blank" rel="noopener noreferrer"` を付け、新しいタブで開く（静的HTMLのみ）。`#`・相対パス・`mailto:`・`tel:` は従来どおり同じタブ。
- ボタンリンク: 段落の直前に単独行で `<!-- mdh:button -->` を置くと、その段落が「リンク 1 つだけ」のときに限り、そのリンクをボタン風（`a.mdh-button`、段落は `p.mdh-button-row`）で描く。段落にリンク以外の文字があるときや対象が無いときは何もせず、マーカーは出力しない（静的HTMLのみ）。
- 対象は静的HTML（`renderMarkdown`）のみ。編集版runtimeの表はセル編集を優先し、この数値整形と横スクロール枠は適用しない。
- 判定は `scripts/lib/static-renderer.mjs` の `isNumericCellText`。判定を変えたら `scripts/lib/static-renderer.test.mjs` と `mockups/fixtures/fixture-table-stack.md` の検証を更新する。

## Fixtures

- `mockups/fixtures/fixture-short.md`: 基本的な短文fixture。
- `mockups/fixtures/fixture-long.md`: TOC、本文、2列表を含む長文fixture。
- `mockups/fixtures/fixture-table-stack.md`: 3列表stackと2列表維持の回帰fixture。
- `mockups/fixtures/fixture-table-heatmap.md`: マーカー付きヒートマップ表とマーカー無し表の回帰fixture。
- `mockups/fixtures/editable-basic.md`: 編集版の基本操作fixture。
- `mockups/fixtures/fixture-table-heatmap-primary.md`: 主値モードのヒートマップ表の回帰fixture。

## License

MIT
