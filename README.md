# HONNE（NFC恋愛カードゲーム プロトタイプ）

アプリ名は「HONNE（ホンネ）」です。

## ファイル構成（ステップ2時点）

```
honne/
  docs/step1-design.md   ステップ1 設計書
  firebase.json          Firebase Hosting / Firestore の設定
  firestore.rules        セキュリティルール
  public/
    index.html           S00 エントリー（NFCタグのURLの受け口）
    profile.html         S01 ニックネーム登録 / S02 事前アンケート
    lobby.html           S03 待機画面（ホーム） / S20 ルームロビー
    css/common.css       共通スタイル
    js/firebase-config.js  Firebase の設定値（ここだけ書き換える）
    js/firebase.js       初期化と匿名ログイン、ローカルモード判定
    js/store.js          Firestore の読み書き（ローカルモード実装つき）
    js/survey.js         事前アンケート5問のマスター
    js/topics.js         お題の抽出ロジック（フォールバック込み）
    js/ui.js             画面共通の部品
    js/index.js / profile.js / lobby.js   各画面のロジック
    data/presets.json    プリセットお題50問
```

`sniper.html`（ステップ3）、`bet.html`（ステップ4）、`anonymous.html` はまだありません。

## まず1台で試す（ローカルモード）

Firebase を用意しなくても、この端末だけで画面を確認できます。

```bash
cd honne/public
python3 -m http.server 8000
# ブラウザで http://localhost:8000/index.html?local=1
```

`firebase-config.js` が初期値のままなら、`?local=1` を付けなくても自動でローカルモードになります。ホーム画面の「ローカルモードの試遊」ボタンでカードのタッチを再現できます。ルームロビーでは「テスト用メンバーを追加」で3人以上にできます。

## Firebase で動かす

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作成します。
2. 「Authentication」→「ログイン方法」で **匿名** を有効にします。
3. 「Firestore Database」を作成します（本番モードで可）。
4. 「プロジェクトの設定」→「マイアプリ」でウェブアプリを追加し、表示された設定値を `public/js/firebase-config.js` に貼り付けます。
5. Firebase CLI でルールとサイトを公開します。

```bash
npm install -g firebase-tools
firebase login
firebase use --add            # 作成したプロジェクトを選ぶ
firebase deploy --only firestore:rules,hosting
```

公開後のURLは `https://<プロジェクトID>.web.app/` です。NFCタグは HTTPS のURLでないとスマホで開けないため、Hosting に置くのがおすすめです。

## NFCタグへの書き込み

「NFC Tools」などのアプリで、各タグに **URL レコード** を1つ書き込みます。

| カード | 書き込むURL |
|---|---|
| 個人カード（1人1枚） | `https://<ホスト>/index.html?card=P-0001`（番号はカードごとに変える） |
| 親カード（テーブル中央） | `https://<ホスト>/index.html?table=T-0001` |

個人カードは、最初にタッチした人のカードとして登録されます。登録の解除はホーム画面の「手放す」からできます。
