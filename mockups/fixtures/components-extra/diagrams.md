---
title: 部品の検査｜図
---

# 図の種類

## フローチャート

```mermaid
flowchart TD
  A[申し込みフォームの送信を受け付けて、住所の都道府県を確かめる] --> B{県外の住所か}
  B -->|はい| C[県外チェックインとして集計する]
  B -->|いいえ| D[県内として集計しない]
  subgraph 月末の作業
    E[CSV を書き出す] --> F[件数と人数を数える]
  end
  C --> E
```

## graph（改行入り）

```mermaid
graph LR
  A["1 行目<br>2 行目"] --> B[次の手順]
  B --> C & D
```

## シーケンス

```mermaid
sequenceDiagram
  participant 利用者
  participant 受付の画面
  participant 管理画面
  利用者->>受付の画面: 予約の番号を入れる
  受付の画面->>管理画面: チェックインを記録する
  管理画面-->>受付の画面: 住所の都道府県を返す
```

## 状態

```mermaid
stateDiagram-v2
  [*] --> 下書き
  下書き --> 確認中: 送る
  確認中 --> 下書き: 差し戻す
  確認中 --> 公開: 承認する
  公開 --> [*]
```

## クラス

```mermaid
classDiagram
  class 文書 {
    +タイトル
    +本文
    +配信する()
  }
  class コメント {
    +本文
    +付け先
  }
  文書 "1" --> "*" コメント
```

## ER

```mermaid
erDiagram
  顧客 ||--o{ 注文 : "注文する"
  注文 ||--|{ 注文の明細 : "含む"
  商品 ||--o{ 注文の明細 : "載る"
```

## XY チャート

```mermaid
xychart-beta
  title "月ごとの県外の件数"
  x-axis [4月, 5月, 6月, 7月]
  y-axis "件数" 0 --> 600
  bar [120, 340, 410, 380]
  line [120, 340, 410, 380]
```

## 古い書き方の状態図

```mermaid
stateDiagram
  [*] --> 待ち
  待ち --> 完了
```

# 図にならないもの

## 対応していない種類

```mermaid
pie title 内訳
  "県外" : 60
  "県内" : 40
```

## 書き損じ

```mermaid
flowchart TD
  A[閉じていない --> B
```

## 空白なしの矢印

```mermaid
graph TD
  A-->B
```

## 空

```mermaid
```

## 図にしないコード

```text
flowchart TD
  A --> B
```
