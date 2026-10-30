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

通常は静的HTMLを使う。静的HTMLは文書タイトル、本文、TOCを分離して表示し、TOCはボタンで開閉できる。TOCを閉じると本文は中央寄せになる。TOCは、いま読んでいる見出しに背景色を付ける（閉じた見出しの中にあるときは見えている親の見出し）。

左上の設定ボタンで開くパネルで、読む人が目次の表示／非表示、本文の幅（標準 720px・広め 880px・最大）、見出しの背景帯（帯／帯＋左の線、付ける段 h1〜h4）と文字色（ブルー #3045B1）を切り替えられる。設定はブラウザに文書ごと（URL のパスとクエリ）に保存し、「HTML を書き出す」で今の設定を最初の表示として持つ HTML を保存できる。書き出しは md-to-html 自身の部品（`/* mdh:style */`・`/* mdh:script */` で始まる style・script と `.mdh-shell`）を拾って組み立て直すので、コメント配信先の部品は入らない。相対パスの画像とリンクは書き出し時に絶対 URL へ書き換えるため、他の人へ渡すなら画像を埋め込んだ共有経路の文書から書き出す。目次の表示・本文の幅・パネルの開閉・860px 以下の目次の引き出しはパネルの部品（`details`・radio・checkbox）と CSS だけで動くので、文書のスクリプトを止める配信先（CSP でスクリプトを止める環境など）でも切り替えられる。その配信先では、スクリプトでしか動かない見出しの色と「HTML を書き出す」はパネルに出ず、設定も保存されない。

### デザインの値

CSS は `scripts/lib/static-renderer.mjs` の `CSS` が正本で、編集版も同じ CSS を読む。

- 書体: 本文・見出し・目次・表は欧文も和文も `Noto Sans JP`、コードは `IBM Plex Mono`。既定は Google Fonts の `<link>` で読む（Noto Sans JP は 400・500・700）。ネットにつながらない環境では端末の書体で表示される。
- 文字色: 見出し・本文 #333333、目次・注釈など補助 #6C6C6C、リンク #1B63AC（下線あり）。罫線 #DFE6E9、表の見出し行とコードの背景 #F6F8F9。
- 本文: 16px／1.7、字間 0.02em。タイトル 44px／500、h1 34px／500、h2 26px／700、h3 20px／700、h4 以下 18px／700。見出しの上下の余白は h1 72／18px、h2 40／10px、h3 以下 28／7px。強調 700、斜体は使わない。
- 表・コード・引用・注釈: 14px／1.6。表とコードの枠線 1px、表の行はホバーで背景 #F6F8F9。
- 配置: 目次 288px（見出しは 2 行までで切り、全文はマウスを乗せると出る）＋文書列 1000px（上 120px・下 100px、左右 140px で章コンテンツ幅 720px）。コメントパネルを開くと文書列が狭まり、左右の余白が 24px まで均等に縮む。

### 部品の書き方

静的 HTML・仕様書セットで同じ HTML になる。編集版の編集画面では部品にならない。

- コールアウト: 引用の 1 行目を `> [!色] 見出し` にする。色は `gray`・`blue`・`green`・`yellow`・`red`。GitHub の `[!NOTE]`（灰）・`[!TIP]`（青）・`[!IMPORTANT]`（赤）・`[!WARNING]`（黄）・`[!CAUTION]`（赤）も使える。見出しは書いたときだけ出る。
- 折りたたみ: `> [!toggle]- 見出し` は閉じた状態、`> [!toggle]+ 見出し` は開いた状態で始まる。見出しは必須。コメントモードでも見出しを押すと開閉する。
- 用語と説明: 1 行目に用語、次の行から `: 説明` を書く。`: ` で始まる行ごとに説明が増え、それ以外の行は直前の説明の続きになる。空行をはさんで続く組は 1 つにまとまる。
- キャプション: 画像の次の行に `*図 1｜…*` のように強調だけを書く。
- 見出しの行き先: 見出しの末尾の `[#名前]` か `{#名前}` は表示されず、見出しの id になる。`mdh`・`user-content-`・`cmt-` で始まる名前と `footnote-label` は使えない。
- タイトルの改行: YAML の `title` に改行を入れると、見える見出しだけ改行し、`<title>` などは 1 行になる。
- 1 行目の見出しを本文と分けるには、行末に `\` を書くか、改行して続ける。目印を文字のまま見せたいときは行内コードで包む。
- カード: `<!-- mdh:cards 2 -->` か `<!-- mdh:cards 3 -->` の直後の箇条書きの各項目が 1 枚のカードになる。項目の 1 行目がタイトル、2 行目が `*…*` の強調だけなら補助見出し、残りが本文。1 行目がリンクだけならカード全体がそのリンクになる（本文などにリンクや折りたたみがあるときは通常のカードになり、警告が出る）。860px 以下では 1 列。
- 複数カラム: `<!-- mdh:columns 2 -->`（か `3`）から `<!-- mdh:columns-end -->` までを、`<!-- mdh:column-break -->` で区切って列にする。列の中の見出しは目次に出る。終わりの目印が無いとカラムにならない。
- 結合セル: `<!-- mdh:merge -->` の直後の表で、`^` だけのセルは上と、`<` だけのセルは左と結合する。`<!-- mdh:merge head=2 -->` で本文の 1 行目も見出しにする。結合が長方形にならない・結合先が無いときは表ごと普通の表に戻る。記号を文字のまま見せたいときは行内コードで包む。ヒートマップとは併用できない。
- 数式: 文中は `$$…$$`、独立した式は `$$` だけの行で囲むか、`$$…$$` だけの 1 行にする（中央に置く）。単独の `$`（`$7.2M` など）は数式にならない。`$$` を文字で見せたいときは `\$$` か行内コード。式の中の日本語は `\text{…}` で書くと本文の書体になる。変換のときにブラウザ標準の数式表示（MathML）に組み、書体やスクリプトは配らない。組めない式・閉じていない `$$`・`$$` の行に続けて書いた式は、書いた原文のまま出て警告が出る。独立した式を続けるときは空行で分ける。編集版を通すと数式は失われる。
- 部品や記号にならなかった目印（知らない名前・色に `+`/`-`・見出しの無い toggle・使えない名前・重なった名前・知らない `mdh:` の目印・段落の中の目印など）は、変換のときに標準エラーへ `警告: <ファイル>:<行> <理由>: <目印>` と出る。変換は止まらず、その引用や見出しは今までどおりの見え方になる。

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
npm run layout:runtime
npm run layout:noscript
npm run layout:print
for task in smoke 4 5 6 7 8 9 10 11 12 13 14 15 16 17; do npm run e2e -- --task "$task" || exit $?; done
```

- 生成した HTML は Google Fonts を読むため、Playwright の検査はネットへ接続する。回線が無い環境では端末の書体で測ることになり、行の折り返しや高さが変わる。
- `size:editable`: editable HTMLが500,000 bytes以内に収まることを確認する。
- `layout:toc`: 展開可能なTOCで親見出しと最初の子見出しが重ならないことを実ブラウザで確認する。
- `layout:table`: 1280px viewportで見出しセル右端のハンドルを80pxドラッグし、その列と表だけが広がり、はみ出しが表の横スクロール枠に収まること、ダブルクリックで元に戻ることを確認する。
- `layout:heatmap`: 1280pxと390px viewportで、表／ヒートマップのradioラベル切り替え、数値列のalpha差、識別子列の非着色、表表示への復帰を実ブラウザで確認する。
- `layout:runtime`: チェックリストの項目で強調が文の中に並び子リストが下に来ること、目次の現在位置がスクロールに合わせて移り末尾で最後の見出しになることを確認する。
- `layout:noscript`: スクリプトを止めた Chromium で、設定ボタンでパネルが開閉し見出しの色と書き出しが隠れること、1440px で目次の非表示と本文の幅（720・880・1360px）が効くこと、390px で目次の引き出しが閉じて始まりスイッチで開閉でき、パネルを閉じると目次のリンクを押せること、部品の初期値（書き出しの埋め込み）どおりに始まること、横スクロールしない表が本文幅まで広がることを確かめる。設定の部品を取り除いた写しで落ちることも確かめる。
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
