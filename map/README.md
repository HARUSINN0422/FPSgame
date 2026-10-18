# マップデータ

このフォルダは、ゲームモードごとにマップJSONを保存する場所です。

```text
map/
├─ README.md
├─ Melee/
│  ├─ RampArena.json
│  └─ Courtyard.json
├─ Area/
│  ├─ README.md
│  └─ ControlCenter.json
└─ （今後のモード名）/
   └─ *.json
```

## 追加方法

- 乱闘（Melee）のマップは `map/Melee/`、エリア（Area）のマップは `map/Area/` にJSONファイルを追加します。
- Meleeは `rotationOrder` の昇順で10分ごとに切り替え、5秒前からカウントダウンを表示します。
- Areaは長辺の両端から中央の制圧エリアへ向かう専用マップを使います。遮蔽物やスポーン地点の仕様は `map/Area/README.md` を参照してください。
- 新しいゲームモードを作った場合は、`map/` の直下にモード名と同じフォルダを作り、そのモード専用のJSONを入れます。
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
