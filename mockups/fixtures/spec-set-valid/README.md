# セットビルド検査用セット（valid）

`build_spec_set.mjs` の正常系を機械検査するための最小セット。
このセットは warning を1件も出さない（root 相対リンク・セット外 `.md` リンクを含まない）。

## 収録文書

- [要件](./REQUIREMENT-view.md)
- [仕様](./SPEC-view.md)
- [計画](./PLAN-view.md)
- [運用ガイド](./guide.md)

### 読む順序

上から順に読む。各ページの本文冒頭にある索引リンクでこのセットのハブへ戻れる。

## 検査観点

- 相互リンクが `./<stem>.html` に解決すること
- 画像・添付の相対参照が `html/` 基準へ再基準化されること
- 索引ハブが README → REQUIREMENT → SPEC → PLAN → その他 の順に並ぶこと
