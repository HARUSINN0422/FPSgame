# マップデータ

このフォルダは、ゲームモードごとにマップJSONを保存する場所です。

```text
map/
├─ README.md
├─ Melee/
│  ├─ RampArena.json
│  └─ Courtyard.json
└─ （今後のモード名）/
   └─ *.json
```

## 追加方法

- 乱闘（Melee）のマップは `map/Melee/` にJSONファイルを追加します。
- 新しいゲームモードを作った場合は、`map/` の直下にモード名と同じフォルダを作り、そのモード専用のJSONを入れます。
- 現在のサーバーは `map/Melee/*.json` を読み込み、`rotationOrder` の昇順で10分ごとに切り替えます。
- マップ切替の5秒前から全クライアントにカウントダウンが表示されます。切替時は全プレイヤーを新しいマップのスポーン地点へ移動し、HPと弾薬を回復します。
- `rotationOrder` が同じマップはファイル名順で並びます。値を重複させないことを推奨します。

## JSON形式

- `rotationOrder`: ローテーション順（1, 2, 3... のような整数を推奨）
- `id`: 内部識別子
- `name`: マップ名
- `description`: 簡単な説明
- `world`: 移動可能範囲（`minX`, `maxX`, `minZ`, `maxZ`）
- `spawnPoints`: 出現位置の配列。各要素は `[x, y, z]`
- `obstacles`: 遮蔽物。各要素は `x, z, w, d, h`
- `ramps`: 坂。各要素は `x, z, w, d, h, direction`。方向は `north`, `south`, `east`, `west`
- `elevatedPlatforms`: プレイヤーが歩いて乗れる高台の範囲（`x, z, w, d, h`）

床・外周の壁は `world` の範囲から描画されます。遮蔽物の座標やサイズは、移動・弾の当たり判定にも利用されます。
