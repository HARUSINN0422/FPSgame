# Mobile FPS Web

Node.js + Express + Socket.IO + Three.js のブラウザFPSプロトタイプです。

## 特徴

- ポート **3007** で起動
- 武器を選択すると試合開始画面を挟まず、そのまま対戦マップへ参加
- サーバーへ接続しているプレイヤー同士が常時同じマップで対戦
- スマホ・タブレット向けのタッチUI
  - 左側: 移動ボタン
  - 右側: FIREボタン
  - それ以外の画面: スライドして視点操作
- PCでは WASD / 矢印キー / Space でも操作可能
- ハンドガン、アサルトライフル、ショットガンを選択可能
- 撃破時に自動リスポーン

## 起動

Node.js 20以上を推奨します。

```bash
npm install
npm start
```

ブラウザ:

```
http://<サーバーIP>:3007/
```

同じURLへスマホ・タブレットからアクセスすると、同じゲームサーバーに接続できます。

## ディレクトリ

```
.
├─ server.js
├─ package.json
└─ public
   ├─ index.html
   ├─ game.js
   └─ style.css
```

## 注意

これは拡張用のプロトタイプです。次の段階では、マップの増設、武器モデル、弾数・リロード、銃声、より厳密なサーバー側当たり判定、認証、ランキングなどを追加できます。

## GitHub自動更新

`server.js` は起動後、60秒ごとにGitHubの `main` ブランチを確認します。

- GitHubに変更がなければ、そのまま動作
- GitHubに新しいコミットがあれば自動で `git pull`
- `npm install --omit=dev` を実行
- 新しいNode.jsプロセスを起動して、古いプロセスを終了

そのため、ラズパイでは最初にリポジトリをcloneして依存関係をインストールした後、通常どおり `node server.js` を起動するだけで、自動更新が有効になります。

### Raspberry Piでの初回設定

```bash
cd /home/harusinn
git clone https://github.com/yumakasugai0422-cmyk/FPSgame.git
cd FPSgame
npm install
node server.js
```

以降はGitHubの `main` が更新されると、最大60秒程度でラズパイ側にも反映されます。

※ ラズパイ側で手動編集したファイルがある場合、`git pull --ff-only` が失敗して自動更新されません。基本的にこのリポジトリはGitHub側を正として使用してください。