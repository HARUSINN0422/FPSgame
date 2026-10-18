# Area マップ設定

エリアモード専用マップのJSONを `map/Area/` に保存します。現在は `ControlCenter.json` を使用します。

## 重要なフィールド

- `world`: マップの移動範囲
- `spawnPoints`: 汎用スポーン位置
- `teamSpawnPoints.blue` / `teamSpawnPoints.red`: 各チームの出現位置（各3か所を推奨）
- `obstacles`: 遮蔽物。見た目、移動、弾の当たり判定で共用します
- `areaZone`: 制圧エリアの中心 `x`, `z` と半径 `radius`

エリアは `areaZone` の円内に生存プレイヤーがいるかで判定します。片方のチームだけが5秒間エリアを維持すると、そのチームが1.5秒ごとに1%獲得します。100%で試合終了です。

AreaマップはMeleeの10分ローテーションとは独立して読み込まれます。
