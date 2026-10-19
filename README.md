# HONNE（NFC恋愛カードゲーム プロトタイプ）

アプリ名は「HONNE（ホンネ）」です。

## ファイル構成

```
honne/
  docs/step1-design.md   ステップ1 設計書
  firebase.json          Firebase Hosting / Firestore の設定
  firestore.rules        セキュリティルール
  public/
    index.html           S00 エントリー（NFCタグのURLの受け口）
    profile.html         S01 ニックネーム登録 / S02 事前アンケート
    lobby.html           S03 待機画面（ホーム） / S20 ルームロビー
    versus.html          S09 1対1のモード選択（相手の個人カードをタッチしたあと）
    sniper.html          S10〜S12 1対1モード（ワード・スナイパー）
    defuse.html          D10〜D13 1対1モード（時限爆弾解除・60秒の協力プレイ）
    bet.html             S30〜S36 ステータス・ベット（1対1は3ラウンド、3〜6人は主役が1人ずつ交代）
    css/common.css       共通スタイル
    css/sniper.css       ワード・スナイパー専用スタイル
    css/defuse.css       時限爆弾解除専用スタイル（赤の点滅・特大タイマー・特大A/Bボタン）
    css/bet.css          ステータス・ベット専用スタイル（緑のカジノ卓・チップ・カードをめくる演出）
    js/firebase-config.js  Firebase の設定値（ここだけ書き換える）
    js/firebase.js       初期化と匿名ログイン、ローカルモード判定
    js/store.js          Firestore の読み書き（ローカルモード実装つき）
    js/survey.js         事前アンケート5問のマスター
    js/topics.js         お題の抽出ロジック（フォールバック込み）
    js/quiz.js           時限爆弾解除のフォールバック用「直感2択クイズ」
    js/ui.js             画面共通の部品
    js/index.js / profile.js / lobby.js / versus.js / sniper.js / defuse.js / bet.js   各画面のロジック
    data/presets.json    プリセットお題50問
```

`anonymous.html`（アノニマス・ターゲット）はまだありません。

## 公開URL

https://tshk10416-hub.github.io/honne/

main に変更が入ると、GitHub Actions（`.github/workflows/deploy-pages.yml`）が `public/` を `gh-pages` ブランチに公開します。Firebase の設定値を入れるまでは、1台で遊べるローカルモードで動きます。設定手順は [docs/firebase-setup.md](docs/firebase-setup.md) にあります。

## まず1台で試す（ローカルモード）

Firebase を用意しなくても、この端末だけで画面を確認できます。

```bash
cd honne/public
python3 -m http.server 8000
# ブラウザで http://localhost:8000/index.html?local=1
```

`firebase-config.js` が初期値のままなら、`?local=1` を付けなくても自動でローカルモードになります。ホーム画面の「ローカルモードの試遊」ボタンでカードのタッチを再現できます。「テスト相手と1対1で遊ぶ」では、自動で動くテスト相手とワード・スナイパーか時限爆弾解除を試せます。ルームロビーでは「テスト用メンバーを追加」で3人以上にできます。

## Firebase エミュレータで複数人を試す

Firebase プロジェクトを作らなくても、手元のエミュレータで本番と同じ動き（複数端末の同期、セキュリティルール）を確認できます。Java が必要です。

```bash
npm install -g firebase-tools
firebase emulators:start --project demo-honne
# ブラウザで http://localhost:5000/index.html?emulator=1
```

別のブラウザ（またはシークレットウィンドウ）でも同じURLを開くと、2人目のプレイヤーとして遊べます。

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
