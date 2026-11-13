const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { execFile, spawn, spawnSync } = require("child_process");
const { monitorEventLoopDelay } = require("perf_hooks");

// 自動更新で古いプロセスから直接起動された場合も、fpsというscreenセッションに戻す。
// 通常の@reboot screen起動では標準出力がTTYなので、そのままサーバーを起動する。
const FPS_SCREEN_WRAPPED_ENV = "FPS_SCREEN_WRAPPED";
const FPS_SCREEN_WORKDIR = "/home/harusinn/Desktop/FPSgame";
const FPS_SCREEN_COMMAND = "sleep 2; cd /home/harusinn/Desktop/FPSgame && exec /usr/bin/node server.js";

if (process.env[FPS_SCREEN_WRAPPED_ENV] !== "1" && !process.stdout.isTTY) {
  const screenEnv = { ...process.env, [FPS_SCREEN_WRAPPED_ENV]: "1" };
  delete screenEnv.STY;
  let screenResult;
  try {
    screenResult = spawnSync("/usr/bin/screen", [
      "-dmS", "fps", "bash", "-c", FPS_SCREEN_COMMAND
    ], {
      cwd: FPS_SCREEN_WORKDIR,
      env: screenEnv,
      stdio: "ignore",
      timeout: 10000
    });
  } catch (error) {
    console.error("[Startup] screenへの切り替えに失敗しました:", error);
    process.exit(1);
  }

  if (screenResult.error || screenResult.status !== 0) {
    console.error("[Startup] screenへの切り替えに失敗しました:",
      screenResult.error || "screen exit status " + screenResult.status);
    process.exit(1);
  }
  process.exit(0);
}

const PORT = 3007;
const AUTO_UPDATE_INTERVAL = 60 * 1000;
const AUTO_UPDATE_BRANCH = "main";
const TICK_RATE = 20;
// マップデータは map/<ゲームモード>/*.json から読み込みます。
const PLAYER_SPEED = 6.5;
const CROUCH_SPEED = 3.2;
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.7;
const CROUCH_HEIGHT = 1.0;
const GRAVITY = 22;
const JUMP_SPEED = 8.5;

const LOG_DIR = path.join(__dirname, "logs");
const ERROR_LOG_FILE = path.join(LOG_DIR, "error.log");
const SERVER_LOG_FILE = path.join(LOG_DIR, "server.log");

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (error) {
  appendServerLog("ERROR-LOG", ["ログフォルダを作成できません:", error]);
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function saveLatestError(error, source = "Unknown") {
  const timestamp = new Date().toISOString();
  const content =
    "=== FPSgame Error Log ===\n" +
    "発生日時: " + timestamp + "\n" +
    "発生元: " + source + "\n\n" +
    formatError(error) +
    "\n";

  try {
    fs.writeFileSync(ERROR_LOG_FILE, content, "utf8");
  } catch (writeError) {
    appendServerLog("ERROR-LOG", ["エラーログを書き込めません:", writeError]);
  }
}

// 端末やSSH/PTYが切断されても、console.logの書き込み失敗でゲームを落とさない。
let consoleOutputUnavailable = false;

function appendServerLog(level, args) {
  const line = new Date().toISOString() + " [" + level + "] " +
    args.map((arg) => formatError(arg)).join(" ") + "\n";
  try {
    fs.appendFileSync(SERVER_LOG_FILE, line, "utf8");
  } catch (_) {
    // ログファイルへの書き込みも失敗した場合、二次例外でサーバーを停止させない。
  }
}

function handleConsoleStreamError(error) {
  consoleOutputUnavailable = true;
  appendServerLog("CONSOLE-STREAM-ERROR", [error]);
}

// EIO / EPIPEなどのstream errorを未処理イベントにしない。
process.stdout.on("error", handleConsoleStreamError);
process.stderr.on("error", handleConsoleStreamError);

const originalConsoleLog = console.log.bind(console);
const originalConsoleInfo = console.info.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);

function safeConsoleWrite(originalMethod, level, args) {
  if (consoleOutputUnavailable) {
    appendServerLog(level, args);
    return;
  }

  try {
    originalMethod(...args);
  } catch (error) {
    consoleOutputUnavailable = true;
    appendServerLog("CONSOLE-WRITE-ERROR", [error]);
    appendServerLog(level, args);
  }
}

console.log = (...args) => safeConsoleWrite(originalConsoleLog, "INFO", args);
console.info = (...args) => safeConsoleWrite(originalConsoleInfo, "INFO", args);
console.warn = (...args) => safeConsoleWrite(originalConsoleWarn, "WARN", args);

// エラーは従来どおりerror.logへ保存し、端末出力に失敗した場合はserver.logへ退避する。
console.error = (...args) => {
  const message = args.map((arg) => formatError(arg)).join(" ");
  saveLatestError(message, "console.error");
  safeConsoleWrite(originalConsoleError, "ERROR", args);
};

process.on("uncaughtException", (error) => {
  saveLatestError(error, "uncaughtException");
  safeConsoleWrite(originalConsoleError, "FATAL", ["[Fatal] 未処理の例外:", error]);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  saveLatestError(reason, "unhandledRejection");
  safeConsoleWrite(originalConsoleError, "FATAL", ["[Fatal] 未処理のPromise拒否:", reason]);
});

const WEAPONS = {
  pickaxe: {
    name: "ツルハシ", damage: 120, fireInterval: 650, range: 3.2, spread: 0,
    falloffStart: 3.2, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: false, melee: true
  },
  sword: { name: "剣", damage: 50, fireInterval: 650, range: 6.4, spread: 0, falloffStart: 6.4, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: false, melee: true },
  pistol: {
    name: "ハンドガン",
    damage: 90,
    fireInterval: 400,
    range: 68,
    spread: 0.018,
    falloffStart: 22,
    minDamageMultiplier: 0.55,
    magazineSize: 6,
    reloadTime: 1000,
    automatic: false
  },
  smg: {
    name: "サブマシンガン",
    damage: 9,
    fireInterval: 107 / 5,
    range: 68,
    spread: 0.045,
    falloffStart: 20,
    minDamageMultiplier: 0.45,
    magazineSize: 90,
    reloadTime: 1300,
    automatic: true
  },
  rifle: {
    name: "アサルトライフル",
    damage: 40,
    fireInterval: 160 / 1.8,
    range: 78,
    spread: 0.032,
    falloffStart: 24,
    minDamageMultiplier: 0.55,
    magazineSize: 20,
    reloadTime: 1500,
    automatic: true
  },
  shotgun: {
    name: "ショットガン", damage: 10, fireInterval: 750, range: 40, pellets: 8,
    spread: 0.24 * 0.35 * 1.1, falloffStart: 10, minDamageMultiplier: 0.30,
    magazineSize: 6, reloadTime: 1400, automatic: false
  },
  grenadeLauncher: {
    name: "グレネード", damage: 110, fireInterval: 900, range: 0, spread: 0,
    falloffStart: 0, minDamageMultiplier: 0, magazineSize: 6, reloadTime: 1700, automatic: false
  },
  marksman: {
    name: "マークスマン", damage: 40, fireInterval: 450, range: 100, spread: 0.006,
    falloffStart: 100, minDamageMultiplier: 1, magazineSize: 30,
    reloadTime: 1300, automatic: true
  },
  formingGun: { name: "ホーミングガン", damage: 5, fireInterval: 1000, range: 0, spread: 0, falloffStart: 0, minDamageMultiplier: 0, magazineSize: 0, reloadTime: 0, automatic: false },
  smoke: {
    name: "煙幕", damage: 0, fireInterval: 1300, range: 0, spread: 0,
    falloffStart: 0, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: false
  },
  sniper: {
    name: "スナイパーライフル", damage: 85, fireInterval: 400, range: 130, spread: 0.0015,
    falloffStart: 80, minDamageMultiplier: 0.8, magazineSize: 6,
    reloadTime: 1900, automatic: false
  },
  bow: { name: "弓", damage: 140, fireInterval: 100, range: 130, spread: 0, falloffStart: 130, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: false },
  minigun: { name: "ミニガン", damage: 7, fireInterval: (107 / 3) * 1.3, range: 68, spread: 0.055, falloffStart: 20, minDamageMultiplier: 0.45, magazineSize: 0, reloadTime: 0, automatic: false },
  shockwaveLauncher: { name: "ショックウェーブランチャー", damage: 0, fireInterval: 900, range: 0, spread: 0, falloffStart: 0, minDamageMultiplier: 0, magazineSize: 0, reloadTime: 0, automatic: false },
  grappler: { name: "グラップラー", damage: 0, fireInterval: 1100, range: 0, spread: 0, falloffStart: 0, minDamageMultiplier: 0, magazineSize: 0, reloadTime: 0, automatic: false },
  railgun: { name: "レールガン", damage: 35, fireInterval: 2000, range: 150, spread: 0, falloffStart: 150, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: false },
  rocketLauncher: { name: "ロケットランチャー", damage: 180, fireInterval: 1250, range: 0, spread: 0, falloffStart: 0, minDamageMultiplier: 0, magazineSize: 3, reloadTime: 2400, automatic: false },
  cannonLauncher: { name: "キャノンランチャー", damage: 10, fireInterval: 1000, range: 0, spread: 0, falloffStart: 0, minDamageMultiplier: 1, magazineSize: 1, reloadTime: 5000, automatic: false },
  flamethrower: { name: "火炎放射器", damage: 5, fireInterval: 500, range: 12, spread: 0, falloffStart: 12, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: true },
  laserBeam: { name: "レーザービーム", damage: 4, fireInterval: 500, range: 100, spread: 0, falloffStart: 100, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: true },
  freezeCannon: { name: "フリーズキャノン", damage: 4, fireInterval: 500, range: 14, spread: 0, falloffStart: 14, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: true }
};

const WEAPON_LABELS = {
  pickaxe: "ツルハシ", sword: "剣", pistol: "ハンドガン", smg: "サブマシンガン", rifle: "アサルトライフル",
  shotgun: "ショットガン", grenadeLauncher: "グレネード", shockwaveLauncher: "ショックウェーブランチャー", grappler: "グラップラー", marksman: "マークスマン", formingGun: "ホーミングガン", smoke: "煙幕", sniper: "スナイパーライフル", bow: "弓", minigun: "ミニガン", railgun: "レールガン", rocketLauncher: "ロケットランチャー", cannonLauncher: "キャノンランチャー", flamethrower: "火炎放射器", laserBeam: "レーザービーム", freezeCannon: "フリーズキャノン"
};
const DEFAULT_WEAPON_DESCRIPTIONS = {
  pickaxe: "近接攻撃。ダメージ: 120。弾薬・リロード不要。",
  sword: "剣を振る近接攻撃。ダメージ: 50。長押しで飛び道具のダメージを50%軽減。空中で使用すると前方約7.7mへ山なりに飛び、着地時に半径10mの衝撃波を放つ。",
  smoke: "煙幕弾を投げ、着弾地点の周囲の視界を遮る。",
  pistol: "精度を活かして狙う単発拳銃。ダメージ: 90（距離により減衰）。装弾数6発。",
  smg: "近距離向けの高速連射武器。ダメージ: 1発9。装弾数90発。",
  rifle: "扱いやすいフルオート武器。ダメージ: 1発40（距離により減衰）。装弾数20発。",
  shotgun: "近距離向けの散弾銃。ダメージ: 散弾1発25（最大8発）。装弾数3発。",
  grenadeLauncher: "着弾地点で爆発するグレネード。ダメージ: 最大110（距離で減衰）。装弾数6発。",
  shockwaveLauncher: "着弾地点の周囲の敵を吹き飛ばす。",
  grappler: "吸盤付きワイヤーで着弾地点へ自分を引き寄せる。リロード不要。",
  marksman: "中〜遠距離向けの精密連射武器。ダメージ: 1発40。装弾数30発。",
  formingGun: "長押しでチャージし、最大まで溜めて離すと誘導弾を3発連続発射。半径15m以内で遮蔽物のない敵を追尾し、1発5ダメージ。",
  sniper: "遠距離向けのボルトアクション式狙撃銃。次弾まで0.4秒。ダメージ: 1発85（距離により減衰）。装弾数6発。",
  bow: "長押しで弓を引き、溜めてから放つ。ダメージ: 最大140。弾薬・リロード不要。",
  minigun: "長押しでチャージし、離すと連続発射。ダメージ: 1発7。",
  railgun: "2秒間チャージしてから発射する貫通弾。ダメージ: 35。射程最大150m。弾薬・リロード不要.",
  rocketLauncher: "やや遅いロケット弾を発射し、壁・床・プレイヤーへの着弾で爆発。爆発半径13m、自分にもダメージ。中心180ダメージから最小50ダメージまで距離に応じて減衰。装弾数3発.",
  cannonLauncher: "足元にキャノンを設置。遮蔽物のない敵へ1秒ごとに10ダメージ。10秒で消滅。リロード3秒。",
  flamethrower: "前方へ炎を連続噴射（射程9mの扇形範囲・上下±3m）。壁の向こうには命中せず、0.5秒ごとに10ダメージ。命中時に燃焼。",
  laserBeam: "長押しでレーザーを連続照射。同じ相手への連続命中で威力上昇。ダメージ: 1回4から最大128。",
  freezeCannon: "前方へ冷気を連続噴射（射程5.25mの扇形範囲・上下±3m）。壁の向こうには命中せず、0.5秒ごとに4ダメージ。命中を重ねると凍結."
};
const WEAPON_CONFIG_FILE = path.join(__dirname, "data", "weapons.json");
for (const [id, weapon] of Object.entries(WEAPONS)) {
  weapon.description = DEFAULT_WEAPON_DESCRIPTIONS[id] || "";
}
try {
  const savedWeapons = JSON.parse(fs.readFileSync(WEAPON_CONFIG_FILE, "utf8"));
  for (const id of Object.keys(WEAPONS)) {
    const saved = savedWeapons[id];
    if (!saved || typeof saved !== "object") continue;
    for (const key of ["name", "description", "damage", "fireInterval", "range", "spread", "falloffStart", "minDamageMultiplier", "magazineSize", "reloadTime", "automatic", "pellets", "melee"]) {
      if (key in saved && (key === "pellets" ? Number.isInteger(saved[key]) && saved[key] > 0 : typeof saved[key] === typeof WEAPONS[id][key]) && (typeof saved[key] !== "number" || Number.isFinite(saved[key]))) {
        WEAPONS[id][key] = saved[key];
      }
    }
  }
} catch (_) {
  // 初回起動時はserver.js内の標準設定を使用します。
}

// ローカルのdata/weapons.jsonに古い英語名が残っていても、対戦中の表示名は日本語に固定する。
const CANONICAL_WEAPON_NAMES = {
  pickaxe: "ツルハシ", sword: "剣", pistol: "ハンドガン", smg: "サブマシンガン", rifle: "アサルトライフル",
  shotgun: "ショットガン", grenadeLauncher: "グレネード", marksman: "マークスマン", smoke: "煙幕",
  sniper: "スナイパーライフル", bow: "弓", minigun: "ミニガン", shockwaveLauncher: "ショックウェーブランチャー",
  grappler: "グラップラー", railgun: "レールガン", rocketLauncher: "ロケットランチャー", cannonLauncher: "キャノンランチャー",
  flamethrower: "火炎放射器", laserBeam: "レーザービーム", freezeCannon: "フリーズキャノン"
};
for (const [id, name] of Object.entries(CANONICAL_WEAPON_NAMES)) WEAPONS[id].name = name;

// 武器説明は保存済みの古いdata/weapons.jsonに上書きされないよう、最新版を固定する。
for (const [id, description] of Object.entries(DEFAULT_WEAPON_DESCRIPTIONS)) {
  WEAPONS[id].description = description;
}

// バランス調整値は、古いローカル武器設定に上書きされないよう固定する。
WEAPONS.sniper.magazineSize = 6;
WEAPONS.sniper.description = DEFAULT_WEAPON_DESCRIPTIONS.sniper;
WEAPONS.smg.fireInterval = 107 / 4.5;
WEAPONS.rifle.damage = 40;
WEAPONS.rifle.fireInterval = 160 / 1.8;
WEAPONS.railgun.damage = 35;
WEAPONS.railgun.fireInterval = 2000;
WEAPONS.sniper.fireInterval = 400;
WEAPONS.minigun.fireInterval = (107 / 3) * 1.3 * 0.4;
WEAPONS.railgun.description = DEFAULT_WEAPON_DESCRIPTIONS.railgun;
WEAPONS.rocketLauncher.magazineSize = 3;
WEAPONS.rocketLauncher.reloadTime = 2400;
WEAPONS.rocketLauncher.damage = 180;
WEAPONS.rocketLauncher.description = DEFAULT_WEAPON_DESCRIPTIONS.rocketLauncher;
WEAPONS.cannonLauncher.magazineSize = 1;
WEAPONS.cannonLauncher.reloadTime = 3000;
WEAPONS.cannonLauncher.fireInterval = 1000;
WEAPONS.cannonLauncher.damage = 10;
WEAPONS.cannonLauncher.description = DEFAULT_WEAPON_DESCRIPTIONS.cannonLauncher;
WEAPONS.pickaxe.damage = 120;
WEAPONS.sword.damage = 50;
WEAPONS.sword.range = 6.4;
WEAPONS.sword.description = DEFAULT_WEAPON_DESCRIPTIONS.sword;
WEAPONS.grenadeLauncher.damage = 110;
WEAPONS.rifle.description = DEFAULT_WEAPON_DESCRIPTIONS.rifle;
WEAPONS.smg.magazineSize = 90;
WEAPONS.smg.description = DEFAULT_WEAPON_DESCRIPTIONS.smg;
WEAPONS.grappler.magazineSize = 0;
WEAPONS.grappler.description = DEFAULT_WEAPON_DESCRIPTIONS.grappler;
// 古いdata/weapons.jsonに空の説明が保存されていても、新武器の説明を必ず表示する。
for (const id of ["railgun", "flamethrower", "laserBeam", "freezeCannon"]) {
  if (!String(WEAPONS[id].description || "").trim()) WEAPONS[id].description = DEFAULT_WEAPON_DESCRIPTIONS[id];
}
WEAPONS.formingGun.damage = 5;
WEAPONS.formingGun.description = DEFAULT_WEAPON_DESCRIPTIONS.formingGun;
WEAPONS.bow.fireInterval = 100;
WEAPONS.bow.damage = 140;
WEAPONS.bow.description = DEFAULT_WEAPON_DESCRIPTIONS.bow;
WEAPONS.marksman.fireInterval = 220;
WEAPONS.marksman.magazineSize = 30;
WEAPONS.pistol.magazineSize = 6;
WEAPONS.pistol.damage = 90;
WEAPONS.pistol.falloffStart = 22;
WEAPONS.pistol.minDamageMultiplier = 0.55;
WEAPONS.marksman.falloffStart = WEAPONS.marksman.range;
WEAPONS.marksman.damage = 40;
WEAPONS.marksman.minDamageMultiplier = 1;
WEAPONS.marksman.description = "連射可能 / 胴体40ダメージ / 距離減衰なし / 装弾数30発";
WEAPONS.shotgun.damage = 25;
WEAPONS.shotgun.fireInterval = 750 * 1.25;
WEAPONS.shotgun.magazineSize = 8;
WEAPONS.shotgun.pellets = 8;
WEAPONS.shotgun.falloffStart = WEAPONS.shotgun.range;
WEAPONS.shotgun.minDamageMultiplier = 1;
WEAPONS.shotgun.spread = 0.24 * 0.35 * 1.1 * 1.5;
WEAPONS.shotgun.description = "単発 / 8発の散弾（1発25ダメージ・全弾命中で200ダメージ） / 装弾数8発・近距離向け";
WEAPONS.flamethrower.damage = 10;
WEAPONS.flamethrower.fireInterval = 500;
WEAPONS.flamethrower.range = 9;
WEAPONS.freezeCannon.fireInterval = 500;
WEAPONS.freezeCannon.range = 5.25;
WEAPONS.flamethrower.description = "長押しで連続噴射 / 射程9mの扇形範囲・上下±3m / 壁の向こうには命中しない / 0.5秒ごとに10ダメージ / 炎から離れた後も、炎に触れていた時間と同じ長さだけ燃焼（125msごとに8ダメージ） / 弾薬・リロード不要";

const app = express();

let updateInProgress = false;

function checkForUpdates() {
  if (updateInProgress) return;
  updateInProgress = true;

  execFile("git", ["fetch", "origin", AUTO_UPDATE_BRANCH], { cwd: __dirname }, (fetchError) => {
    if (fetchError) {
      console.error("[AutoUpdate] GitHubの確認に失敗しました:", fetchError.message);
      updateInProgress = false;
      return;
    }

    execFile("git", ["rev-parse", "HEAD"], { cwd: __dirname }, (localError, localStdout) => {
      if (localError) {
        console.error("[AutoUpdate] 現在のコミットを取得できません:", localError.message);
        updateInProgress = false;
        return;
      }

      execFile("git", ["rev-parse", "origin/" + AUTO_UPDATE_BRANCH], { cwd: __dirname }, (remoteError, remoteStdout) => {
        if (remoteError) {
          console.error("[AutoUpdate] GitHub側のコミットを取得できません:", remoteError.message);
          updateInProgress = false;
          return;
        }

        if (localStdout.trim() === remoteStdout.trim()) {
          updateInProgress = false;
          return;
        }

        console.log("[AutoUpdate] GitHubに新しい更新があります。更新を取得します。");

        execFile("git", ["pull", "--ff-only", "origin", AUTO_UPDATE_BRANCH], { cwd: __dirname }, (pullError, pullStdout, pullStderr) => {
          if (pullError) {
            console.error("[AutoUpdate] git pullに失敗しました:", pullError.message);
            if (pullStderr) console.error(pullStderr.trim());
            updateInProgress = false;
            return;
          }

          console.log(pullStdout.trim() || "[AutoUpdate] GitHubの更新を取得しました。");
          console.log("[AutoUpdate] npm installを実行します。");

          execFile("npm", ["install", "--omit=dev"], { cwd: __dirname }, (npmError, npmStdout, npmStderr) => {
            if (npmError) {
              console.error("[AutoUpdate] npm installに失敗しました。現在のプロセスを継続します:", npmError.message);
              if (npmStderr) console.error(npmStderr.trim());
              updateInProgress = false;
              return;
            }

            if (npmStdout) console.log(npmStdout.trim());
            console.log("[AutoUpdate] 更新完了。新しいNode.jsプロセスを起動します。");

            // @rebootと同じscreenセッション名・実行パスで再起動する。
            // 新しいNode.jsは、旧プロセスが3007番ポートを解放するまで2秒待って起動する。
            // screen内から再びscreenを起動するため、親セッションのSTYは引き継がない。
            const restartEnv = { ...process.env };
            delete restartEnv.STY;
            const restartCommand =
              "sleep 2; cd /home/harusinn/Desktop/FPSgame && exec /usr/bin/node server.js";
            let child;
            try {
              child = spawn("/usr/bin/screen", [
                "-dmS", "fps", "bash", "-c", restartCommand
              ], {
                cwd: "/home/harusinn/Desktop/FPSgame",
                detached: true,
                stdio: "ignore",
                env: restartEnv
              });
            } catch (error) {
              saveLatestError(error, "AutoUpdate restart screen");
              appendServerLog("ERROR", ["[AutoUpdate] screenで再起動できません:", error]);
              updateInProgress = false;
              return;
            }

            child.once("error", (error) => {
              saveLatestError(error, "AutoUpdate restart screen");
              appendServerLog("ERROR", ["[AutoUpdate] screenで再起動できません:", error]);
            });
            child.once("spawn", () => {
              appendServerLog("INFO", [
                "[AutoUpdate] screen -dmS fps bash -c \"" + restartCommand + "\" を起動しました。"
              ]);
              child.unref();
              process.exit(0);
            });
          });
        });
      });
    });
  });
}

const server = http.createServer(app);
const VERCEL_FRONTEND_ORIGIN = "https://test-gamma-two-87.vercel.app";
const io = new Server(server, {
  // Raspberry Piや一時的なCPU負荷でheartbeat応答が遅れても即切断しない。
  pingInterval: 20000,
  pingTimeout: 60000,
  upgradeTimeout: 30000,
  cors: {
    origin: [VERCEL_FRONTEND_ORIGIN],
    methods: ["GET", "POST"]
  }
});

// iOSのホーム画面アプリがバックグラウンドで停止し、接続が残る場合の検知。
setInterval(() => {
  const now = Date.now();
  for (const [id, player] of players) {
    if (player.isBot) continue;
    if (!player.lastPresenceAt) player.lastPresenceAt = now;
    if (now - player.lastPresenceAt <= 45000) continue;
    const client = io.sockets.sockets.get(id);
    appendServerLog("STALE-PRESENCE", ["45秒間応答なしのプレイヤーを切断:", id, player.name]);
    if (client) client.disconnect(true);
    else players.delete(id);
  }
}, 15000);


server.on("error", (error) => {
  saveLatestError(error, "http.Server");
  safeConsoleWrite(originalConsoleError, "ERROR", ["[Server Error]", error]);
});

app.use(express.json({ limit: "256kb" }));

// Vercel上のフロントエンドから、Raspberry Pi上の公開APIを呼び出せるようにする。
// 許可するオリジンは指定したVercelサイトだけに限定する。
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin === VERCEL_FRONTEND_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", VERCEL_FRONTEND_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

const crypto = require("crypto");
const webpush = require("web-push");

const PUSH_DATA_DIR = path.join(__dirname, "data");
const PUSH_KEYS_FILE = path.join(PUSH_DATA_DIR, "push-vapid-keys.json");
const PUSH_SUBSCRIPTIONS_FILE = path.join(PUSH_DATA_DIR, "push-subscriptions.json");
fs.mkdirSync(PUSH_DATA_DIR, { recursive: true });
function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}
let pushKeys = readJsonFile(PUSH_KEYS_FILE, null);
if (!pushKeys?.publicKey || !pushKeys?.privateKey) {
  pushKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(PUSH_KEYS_FILE, JSON.stringify(pushKeys, null, 2), { mode: 0o600 });
}
webpush.setVapidDetails("mailto:admin@harusinn.com", pushKeys.publicKey, pushKeys.privateKey);
let pushSubscriptions = readJsonFile(PUSH_SUBSCRIPTIONS_FILE, []);
if (!Array.isArray(pushSubscriptions)) pushSubscriptions = [];
function savePushSubscriptions() {
  fs.writeFileSync(PUSH_SUBSCRIPTIONS_FILE, JSON.stringify(pushSubscriptions, null, 2), { mode: 0o600 });
}
app.get("/api/push/public-key", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ publicKey: pushKeys.publicKey });
});
app.post("/api/push/subscribe", (req, res) => {
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "通知の登録情報が正しくありません。" });
  }
  pushSubscriptions = pushSubscriptions.filter(item => item.endpoint !== subscription.endpoint);
  pushSubscriptions.push(subscription);
  savePushSubscriptions();
  res.json({ ok: true });
});
app.post("/api/push/unsubscribe", (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint === "string") {
    pushSubscriptions = pushSubscriptions.filter(item => item.endpoint !== endpoint);
    savePushSubscriptions();
  }
  res.json({ ok: true });
});
async function sendOnlinePushNotification() {
  const payload = JSON.stringify({
    title: "FPSgame",
    body: "プレイヤーが参加しました",
    url: "./"
  });
  const subscriptions = [...pushSubscriptions];
  await Promise.all(subscriptions.map(async subscription => {
    try {
      await webpush.sendNotification(subscription, payload);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        pushSubscriptions = pushSubscriptions.filter(item => item.endpoint !== subscription.endpoint);
        savePushSubscriptions();
      } else {
        console.error("[Push] 通知送信に失敗しました:", error.message);
      }
    }
  }));
}

const ADMIN_PASSWORD = process.env.FPS_ADMIN_PASSWORD || "0422";
const adminSessions = new Map();
const loginAttempts = new Map();
function parseCookies(req) {
  const result = {};
  for (const item of String(req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index > 0) result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return result;
}
function adminAuth(req, res, next) {
  const token = parseCookies(req).fps_admin_session;
  const expiresAt = token && adminSessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ error: "ログインが必要です" });
  }
  next();
}
app.post("/api/admin/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (attempt.until > Date.now() && attempt.count >= 10) {
    return res.status(429).json({ error: "試行回数が多すぎます。しばらく待ってください" });
  }
  const supplied = Buffer.from(String(req.body?.password || ""));
  const expected = Buffer.from(String(ADMIN_PASSWORD));
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!valid) {
    attempt.count = attempt.until > Date.now() ? attempt.count + 1 : 1;
    attempt.until = Date.now() + 10 * 60 * 1000;
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: "パスワードが違います" });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", "fps_admin_session=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200" + (secure ? "; Secure" : ""));
  res.json({ ok: true });
});
app.get("/api/admin/session", adminAuth, (_req, res) => res.json({ ok: true }));
app.post("/api/admin/logout", (req, res) => {
  const token = parseCookies(req).fps_admin_session;
  if (token) adminSessions.delete(token);
  res.setHeader("Set-Cookie", "fps_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + ((req.secure || req.headers["x-forwarded-proto"] === "https") ? "; Secure" : ""));
  res.json({ ok: true });
});
const NOTICE_FILE = path.join(__dirname, "notices.txt");
app.get("/api/lobby-info", (_req, res) => {
  let notice = "";
  try { notice = fs.readFileSync(NOTICE_FILE, "utf8"); } catch (_) {}
  const connectedHumans = Array.from(players.values()).filter(player =>
    !player.isBot && !player.disconnectedAt && io.sockets.sockets.has(player.id)
  );
  const modeCounts = {
    shootingRange: connectedHumans.filter(player => player.mode === TRAINING_MODE).length,
    wander: connectedHumans.filter(player => player.mode === "Wander").length,
    freeForAll: connectedHumans.filter(player => (player.mode || MAP_MODE) === MAP_MODE).length,
    area: connectedHumans.filter(player => player.mode === AREA_MODE).length,
    payload: connectedHumans.filter(player => player.mode === PAYLOAD_MODE).length,
    duel: connectedHumans.filter(player => player.mode === "Duel").length,
    build: connectedHumans.filter(player => player.mode === BUILD_MODE).length
  };
  const onlinePlayers = connectedHumans.length;
  res.setHeader("Cache-Control", "no-store");
  res.json({ onlinePlayers, modeCounts, notice });
});

app.get("/api/online-count", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const count = Array.from(io.sockets.sockets.keys()).filter(id => { const p = players.get(id); return p && !p.isBot; }).length;
  res.json({ count });
});
app.get("/api/notices", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let notices = "";
  try { notices = fs.readFileSync(path.join(__dirname, "notices.txt"), "utf8"); } catch (_) {}
  res.type("text/plain; charset=utf-8").send(notices);
});
app.get("/api/weapons", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ weapons: Object.fromEntries(Object.entries(WEAPONS).map(([id, weapon]) => [id, { description: weapon.description || DEFAULT_WEAPON_DESCRIPTIONS[id] || "", fireInterval: weapon.fireInterval, automatic: weapon.automatic }])) });
});
app.get("/api/admin/weapons", adminAuth, (_req, res) => {
  res.json({ weapons: Object.fromEntries(Object.entries(WEAPONS).map(([id, weapon]) => [id, { ...weapon, label: WEAPON_LABELS[id] || id }])) });
});
app.post("/api/admin/weapons", adminAuth, (req, res) => {
  const input = req.body?.weapons;
  if (!input || typeof input !== "object") return res.status(400).json({ error: "武器データが不正です" });
  const next = {};
  const numericKeys = ["damage", "fireInterval", "range", "spread", "falloffStart", "minDamageMultiplier", "magazineSize", "reloadTime", "pellets"];
  for (const id of Object.keys(WEAPONS)) {
    const source = input[id];
    if (!source || typeof source !== "object") return res.status(400).json({ error: "武器データが不足しています: " + id });
    const item = { ...WEAPONS[id] };
    for (const key of numericKeys) {
      if (source[key] === undefined || source[key] === "") { if (key === "pellets") delete item[key]; continue; }
      const value = Number(source[key]);
      if (!Number.isFinite(value) || value < 0 || (key === "fireInterval" && value < 1) || (key === "magazineSize" && value < (["smoke", "bow", "sword", "shockwaveLauncher", "grappler"].includes(id) ? 0 : 1)) || (key === "minDamageMultiplier" && value > 1) || (key === "pellets" && (!Number.isInteger(value) || value < 1))) {
        return res.status(400).json({ error: id + " の " + key + " が不正です" });
      }
      item[key] = value;
    }
    if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 80) return res.status(400).json({ error: id + " の武器名が不正です" });
    if (typeof source.description !== "string" || source.description.length > 500) return res.status(400).json({ error: id + " の説明が長すぎます" });
    item.name = source.name.trim();
    item.description = source.description;
    item.automatic = source.automatic === true;
    next[id] = item;
  }
  try {
    fs.mkdirSync(path.dirname(WEAPON_CONFIG_FILE), { recursive: true });
    const persisted = Object.fromEntries(Object.entries(next).map(([id, weapon]) => [id, Object.fromEntries(
      ["name", "description", "damage", "fireInterval", "range", "spread", "falloffStart", "minDamageMultiplier", "magazineSize", "reloadTime", "automatic", "pellets"]
        .filter(key => weapon[key] !== undefined).map(key => [key, weapon[key]])
    )]));
    fs.writeFileSync(WEAPON_CONFIG_FILE, JSON.stringify(persisted, null, 2) + "\n", "utf8");
    for (const id of Object.keys(WEAPONS)) {
      if (!Object.prototype.hasOwnProperty.call(next[id], "pellets")) delete WEAPONS[id].pellets;
      Object.assign(WEAPONS[id], next[id]);
    }
    res.json({ ok: true, weapons: Object.fromEntries(Object.entries(WEAPONS).map(([id, weapon]) => [id, { ...weapon, label: WEAPON_LABELS[id] || id }])) });
    io.emit("weaponConfigUpdated", Object.fromEntries(Object.entries(WEAPONS).map(([id, weapon]) => [id, { fireInterval: weapon.fireInterval, automatic: weapon.automatic, description: weapon.description || "" }])));
  } catch (error) {
    console.error("[Admin] 武器設定を保存できません:", error);
    res.status(500).json({ error: "武器設定を保存できませんでした" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, port: PORT, players: players.size });
});

const players = new Map();
const riftDuels = new Map();
const duelRooms = new Map();
let duelRoomSequence = 0;

const MAP_ROOT = path.join(__dirname, "map");
const MAP_OVERRIDE_ROOT = path.join(__dirname, "data", "maps");
const MAP_MODE = "Melee";
const AREA_MODE = "Area";
const PAYLOAD_MODE = "Payload";
const TRAINING_MODE = "Training";
const BUILD_MODE = "Build";
const MAP_ROTATION_INTERVAL_MS = 10 * 60 * 1000;
const MAP_CHANGE_COUNTDOWN_MS = 5 * 1000;
const AREA_QUEUE_DURATION_MS = 20 * 1000;
const AREA_CONTROL_HOLD_MS = 5 * 1000;
const AREA_PROGRESS_PER_PERCENT_MS = 1500;
const AREA_BOT_NAMES = ["Liam", "Noah", "Oliver", "James", "Elijah", "Mateo", "Theodore", "Henry", "Lucas", "Jack"];

function loadMapsForMode(mode) {
  const filePaths = new Map();
  for (const modeDirectory of [path.join(MAP_ROOT, mode), path.join(MAP_OVERRIDE_ROOT, mode)]) {
    fs.mkdirSync(modeDirectory, { recursive: true });
    for (const file of fs.readdirSync(modeDirectory)
      .filter((file) => file.toLowerCase().endsWith(".json"))
      .sort()) {
      filePaths.set(file, path.join(modeDirectory, file));
    }
  }
  const files = Array.from(filePaths.keys()).sort();

  const maps = [];
  for (const file of files) {
    const fullPath = filePaths.get(file);
    try {
      const mapData = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (
        !mapData ||
        typeof mapData.id !== "string" ||
        typeof mapData.name !== "string" ||
        !mapData.world ||
        !Number.isFinite(mapData.world.minX) ||
        !Number.isFinite(mapData.world.maxX) ||
        !Number.isFinite(mapData.world.minZ) ||
        !Number.isFinite(mapData.world.maxZ) ||
        !Array.isArray(mapData.spawnPoints) ||
        mapData.spawnPoints.length === 0 ||
        !Array.isArray(mapData.obstacles) ||
        !Array.isArray(mapData.ramps)
      ) {
        throw new Error("必須項目（id/name/world/spawnPoints/obstacles/ramps）が不足しています");
      }

      maps.push({
        ...mapData,
        mapFile: file,
        elevatedPlatforms: Array.isArray(mapData.elevatedPlatforms) ? mapData.elevatedPlatforms : []
      });
    } catch (error) {
      console.warn("[Map] マップを読み込めないためスキップします:", file, error.message);
    }
  }

  if (maps.length === 0) {
    throw new Error("map/" + mode + "/ に有効なJSONマップがありません");
  }

  // rotationOrderが小さい順。未設定ならファイル名順で末尾側に配置する。
  maps.sort((a, b) => {
    const orderA = Number.isFinite(Number(a.rotationOrder)) ? Number(a.rotationOrder) : Number.MAX_SAFE_INTEGER;
    const orderB = Number.isFinite(Number(b.rotationOrder)) ? Number(b.rotationOrder) : Number.MAX_SAFE_INTEGER;
    return orderA - orderB || a.mapFile.localeCompare(b.mapFile);
  });
  return maps;
}

// 各モードのマップを別々に読み込みます。Areaは1枚の専用マップ上で独立した試合を行います。
let availableMaps = loadMapsForMode(MAP_MODE);
let areaMaps = loadMapsForMode(AREA_MODE);
let areaMap = areaMaps[0];
let payloadMaps = loadMapsForMode(PAYLOAD_MODE);
let payloadMap = payloadMaps[0];
let activeMapIndex = 0;
let activeMap = availableMaps[activeMapIndex];
let WORLD = activeMap.world;
let spawnPoints = activeMap.spawnPoints;
let obstacles = activeMap.obstacles;
let ramps = activeMap.ramps;
let elevatedPlatforms = activeMap.elevatedPlatforms;
let nextMapChangeAt = Date.now() + MAP_ROTATION_INTERVAL_MS;
let lastMapCountdownSecond = null;

const areaMatches = new Map();
let areaQueue = [];
const payloadMatches = new Map();
let payloadQueue = [];
const pendingPayloadDisconnects = new Map();
const PAYLOAD_RECONNECT_GRACE_MS = 20000;
let payloadQueueStartedAt = 0;
let lastPayloadQueueSecond = null;
let payloadMatchSequence = 0;
let areaQueueStartedAt = 0;
let lastAreaQueueSecond = null;
let areaMatchSequence = 0;

function createTrainingMap() {
  return {
    ...activeMap,
    id: "shooting-range",
    name: "射撃場",
    description: "狭い練習場。壁は1つだけ配置。",
    world: { minX: -16, maxX: 16, minZ: -16, maxZ: 16 },
    spawnPoints: [
      [0, 0, 10],
      [-6, 0, -5],
      [-2, 0, -5],
      [2, 0, -5],
      [6, 0, -5]
    ],
    obstacles: [{ x: 0, z: -11, w: 12, d: 1, h: 2.8 }],
    floorTiles: [
      { id: "fire", type: "fire", x: 12, z: -3.75, w: 4, d: 13.5 },
      { id: "speed", type: "speed", x: -12, z: 9.75, w: 4, d: 13.5 },
      { id: "slime", type: "slime", x: -12, z: -3.75, w: 4, d: 13.5 }
    ],
    ramps: [],
    elevatedPlatforms: []
  };
}

function getMapInfo(map, mode = MAP_MODE) {
  return { mode, id: map.id, name: map.name, description: map.description || "" };
}

function createRiftArenaMap() {
  return { id:"rift-duel-arena", name:"鏡界", description:"中央の壁を挟んで戦う異空間",
    world:{minX:-8,maxX:8,minZ:-8,maxZ:8},
    obstacles:[{x:0,z:0,w:0.8,d:5.2,h:2.8}],
    ramps:[],elevatedPlatforms:[],floorTiles:[],bridges:[],bridgeSupports:[] };
}
function finishRiftDuel(loser) {
  if(!loser?.riftDuelId)return false;
  const duel=riftDuels.get(loser.riftDuelId);
  if(!duel||duel.resolved)return false;
  duel.resolved=true;
  const winner=players.get(duel.playerIds.find(id=>id!==loser.id));
  if(winner&&winner.health>0){
    const o=winner.riftOrigin;
    if(o){winner.x=o.x;winner.y=o.y;winner.z=o.z;winner.yaw=o.yaw;winner.pitch=o.pitch;}
    winner.velocityY=0;winner.grounded=true;winner.invulnerableUntil=Date.now()+3000;winner.invisibleUntil=0;
  }
  for(const id of duel.playerIds){
    const p=players.get(id);if(!p)continue;
    const returnMap=p.riftReturnMap||getMapForPlayer(p);
    p.riftFirstHitProtected=false;
    p.riftDuelId=null;p.riftMap=null;p.riftReturnMap=null;p.riftOrigin=null;
    p.input={forward:0,strafe:0,crouch:false};
    const client=io.sockets.sockets.get(id);
    if(client)client.emit("world",getWorldPayloadForMap(returnMap,p.mode||MAP_MODE));
  }
  riftDuels.delete(duel.id);broadcastPlayers();
  if(winner)io.to(winner.id).emit("riftDuelResult",{won:true,invulnerableUntil:winner.invulnerableUntil});
  const loserClient=io.sockets.sockets.get(loser.id);
  if(loserClient)loserClient.emit("riftDuelResult",{won:false});
  return true;
}
function createBuildMap() {
  return {
    id: "build-world", name: "ビルドマップ", description: "32×32の建築マップ",
    world: { minX: -16, maxX: 16, minZ: -16, maxZ: 16 },
    spawnPoints: [[0, 0, 8]], obstacles: [], ramps: [], elevatedPlatforms: [],
    floorTiles: [], bridges: [], bridgeSupports: [], buildStructures: []
  };
}

function buildStructuresTouch(a, b) {
  if (!a || !b || ![a.x,a.y,a.z,a.w,a.d,b.x,b.y,b.z,b.w,b.d].every(value => Number.isFinite(Number(value))) ||
      Number(a.w) <= 0 || Number(a.d) <= 0 || Number(b.w) <= 0 || Number(b.d) <= 0) return false;
  const ax = a.x - a.w / 2, ar = a.x + a.w / 2;
  const az = a.z - a.d / 2, ab = a.z + a.d / 2;
  const bx = b.x - b.w / 2, br = b.x + b.w / 2;
  const bz = b.z - b.d / 2, bb = b.z + b.d / 2;
  const overlapX = Math.min(ar, br) - Math.max(ax, bx);
  const overlapZ = Math.min(ab, bb) - Math.max(az, bz);
  const edgeEpsilon = 0.06;
  const edgeTouchX = (Math.abs(ar - bx) <= edgeEpsilon || Math.abs(br - ax) <= edgeEpsilon) &&
    overlapZ > 0.08;
  const edgeTouchZ = (Math.abs(ab - bz) <= edgeEpsilon || Math.abs(bb - az) <= edgeEpsilon) &&
    overlapX > 0.08;
  const aY = Number(a.y) || 0;
  const bY = Number(b.y) || 0;
  const aHeight = a.type === "wall" || a.type === "ramp" ? (Number(a.h) || 4) : 0.08;
  const bHeight = b.type === "wall" || b.type === "ramp" ? (Number(b.h) || 4) : 0.08;
  const sameLevelEdgeTouch = Math.abs(aY - bY) < 0.12 && (edgeTouchX || edgeTouchZ);
  const verticalTouch = (
    Math.abs(aY + aHeight - bY) <= edgeEpsilon ||
    Math.abs(bY + bHeight - aY) <= edgeEpsilon
  ) && overlapX > 0.08 && overlapZ > 0.08;

  // 階段の高い端と、次の階段の低い端（または床の辺）が高さ・位置とも一致すれば接続。
  const rampLowEdge = ramp => {
    const halfW = ramp.w / 2, halfD = ramp.d / 2;
    if (ramp.direction === "east") return { axis: "x", edge: ramp.x - halfW, min: ramp.z - halfD, max: ramp.z + halfD };
    if (ramp.direction === "west") return { axis: "x", edge: ramp.x + halfW, min: ramp.z - halfD, max: ramp.z + halfD };
    if (ramp.direction === "north") return { axis: "z", edge: ramp.z - halfD, min: ramp.x - halfW, max: ramp.x + halfW };
    return { axis: "z", edge: ramp.z + halfD, min: ramp.x - halfW, max: ramp.x + halfW };
  };
  const rampHighEdge = ramp => {
    const halfW = ramp.w / 2, halfD = ramp.d / 2;
    if (ramp.direction === "east") return { axis: "x", edge: ramp.x + halfW, min: ramp.z - halfD, max: ramp.z + halfD };
    if (ramp.direction === "west") return { axis: "x", edge: ramp.x - halfW, min: ramp.z - halfD, max: ramp.z + halfD };
    if (ramp.direction === "north") return { axis: "z", edge: ramp.z + halfD, min: ramp.x - halfW, max: ramp.x + halfW };
    return { axis: "z", edge: ramp.z - halfD, min: ramp.x - halfW, max: ramp.x + halfW };
  };
  const rampEdgeConnects = (ramp, other, otherIsRampLow) => {
    const high = rampHighEdge(ramp);
    let low;
    if (otherIsRampLow) {
      if (ramp.direction !== other.direction) return false;
      low = rampLowEdge(other);
    } else {
      const halfW = other.w / 2, halfD = other.d / 2;
      low = high.axis === "x"
        ? { axis: "x", edge: Math.abs(high.edge - (other.x - halfW)) < Math.abs(high.edge - (other.x + halfW)) ? other.x - halfW : other.x + halfW, min: other.z - halfD, max: other.z + halfD }
        : { axis: "z", edge: Math.abs(high.edge - (other.z - halfD)) < Math.abs(high.edge - (other.z + halfD)) ? other.z - halfD : other.z + halfD, min: other.x - halfW, max: other.x + halfW };
    }
    const overlap = Math.min(high.max, low.max) - Math.max(high.min, low.min);
    const rampTopY = (Number(ramp.y) || 0) + (Number(ramp.h) || 4);
    const otherBaseY = Number(other.y) || 0;
    return high.axis === low.axis &&
      Math.abs(high.edge - low.edge) <= edgeEpsilon &&
      overlap >= 0.5 &&
      Math.abs(rampTopY - otherBaseY) <= 0.025;
  };
  const rampToRamp = a.type === "ramp" && b.type === "ramp" &&
    (rampEdgeConnects(a, b, true) || rampEdgeConnects(b, a, true));
  const rampToFloor = (a.type === "ramp" && b.type === "floor" && rampEdgeConnects(a, b, false)) ||
    (b.type === "ramp" && a.type === "floor" && rampEdgeConnects(b, a, false));
  return sameLevelEdgeTouch || verticalTouch || rampToRamp || rampToFloor;
}

function pruneUnsupportedBuildStructures(map) {
  const structures = map.buildStructures || [];
  const supported = new Set(structures.filter(item => (Number(item.y) || 0) <= 0.02).map(item => item.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of structures) {
      if (supported.has(item.id)) continue;
      if (structures.some(other => supported.has(other.id) && buildStructuresTouch(item, other))) {
        supported.add(item.id);
        changed = true;
      }
    }
  }
  const removed = new Set(structures.filter(item => !supported.has(item.id)).map(item => item.id));
  if (!removed.size) return false;
  map.buildStructures = structures.filter(item => !removed.has(item.id));
  map.obstacles = (map.obstacles || []).filter(item => !removed.has(item.buildStructureId));
  map.floorTiles = (map.floorTiles || []).filter(item => !removed.has(item.buildStructureId));
  map.elevatedPlatforms = (map.elevatedPlatforms || []).filter(item => !removed.has(item.buildStructureId));
  map.ramps = (map.ramps || []).filter(item => !removed.has(item.buildStructureId));
  return true;
}

function getMapForPlayer(player) {
  if (player?.riftMap) return player.riftMap;
  if (player?.mode === BUILD_MODE) return player.buildMap || createBuildMap();
  if (player?.mode === AREA_MODE) return areaMap;
  if (player?.mode === PAYLOAD_MODE) return payloadMap;
  if (player?.mode === "Duel") return player.duelMap || activeMap;
  if (player?.mode === TRAINING_MODE) return player.trainingMap || activeMap;
  if (player?.mode === "Wander") return player.wanderMap || activeMap;
  return activeMap;
}

function getMapCollectionsForPlayer(player) {
  const map = getMapForPlayer(player);
  return {
    world: map.world,
    obstacles: map.obstacles || [],
    ramps: map.ramps || [],
    elevatedPlatforms: map.elevatedPlatforms || []
  };
}

function getWorldPayloadForMap(map, mode) {
  return {
    map: getMapInfo(map, mode),
    obstacles: map.obstacles || [],
    ramps: map.ramps || [],
    elevatedPlatforms: map.elevatedPlatforms || [],
    floorTiles: map.floorTiles || [],
    buildStructures: map.buildStructures || [],
    bridges: map.bridges || [],
    bridgeSupports: map.bridgeSupports || [],
    world: map.world,
    ...(mode === AREA_MODE && map.areaZone ? { areaZone: map.areaZone } : {}),
    ...(Array.isArray(map.payloadPath) ? { payloadPath: map.payloadPath, payloadCheckpointDistances: map.payloadCheckpointDistances || [] } : {}),
    weapons: Object.fromEntries(
      Object.entries(WEAPONS).map(([id, w]) => [id, { name: w.name, fireInterval: w.fireInterval }])
    )
  };
}

function getWorldPayload() {
  return getWorldPayloadForMap(activeMap, MAP_MODE);
}

function getNextMap() {
  return availableMaps[(activeMapIndex + 1) % availableMaps.length];
}

function getMapRotationStatus() {
  return {
    currentMap: getMapInfo(activeMap),
    nextMap: getMapInfo(getNextMap()),
    changeAt: nextMapChangeAt,
    intervalMs: MAP_ROTATION_INTERVAL_MS
  };
}

console.log("[Map] モード:", MAP_MODE, "マップ:", activeMap.name, "(" + activeMap.id + ")");

function safeMapFilename(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}\.json$/.test(value) ? value : null;
}
function validateMapData(mapData) {
  if (!mapData || typeof mapData !== "object" || typeof mapData.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(mapData.id) ||
      typeof mapData.name !== "string" || !mapData.name.trim() || mapData.name.length > 80 ||
      !mapData.world || !["minX", "maxX", "minZ", "maxZ"].every(key => Number.isFinite(mapData.world[key])) ||
      mapData.world.minX >= mapData.world.maxX || mapData.world.minZ >= mapData.world.maxZ ||
      !Array.isArray(mapData.spawnPoints) || mapData.spawnPoints.length < 1 || mapData.spawnPoints.length > 128 ||
      !Array.isArray(mapData.obstacles) || mapData.obstacles.length > 500 ||
      !Array.isArray(mapData.ramps) || mapData.ramps.length > 200 ||
      (mapData.elevatedPlatforms !== undefined && (!Array.isArray(mapData.elevatedPlatforms) || mapData.elevatedPlatforms.length > 200))) return false;
  if (!mapData.spawnPoints.every(p => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every(Number.isFinite))) return false;
  for (const list of [mapData.obstacles, mapData.ramps, mapData.elevatedPlatforms || []]) {
    for (const o of list) {
      if (!o || typeof o !== "object" || !["x", "z", "w", "d", "h"].every(key => Number.isFinite(o[key])) || o.w <= 0 || o.d <= 0 || o.h < 0) return false;
    }
  }
  return true;
}
app.get("/api/admin/maps", adminAuth, (req, res) => {
  try {
    if (req.query.file) {
      const filename = safeMapFilename(String(req.query.file));
      const mode = String(req.query.mode || MAP_MODE);
      if (!filename || ![MAP_MODE, AREA_MODE, PAYLOAD_MODE].includes(mode)) return res.status(400).json({ error: "マップ指定が不正です" });
      const overrideTarget = path.join(MAP_OVERRIDE_ROOT, mode, filename);
      const baseTarget = path.join(MAP_ROOT, mode, filename);
      const target = fs.existsSync(overrideTarget) ? overrideTarget : baseTarget;
      if (!fs.existsSync(target)) return res.status(404).json({ error: "マップが見つかりません" });
      return res.json({ map: JSON.parse(fs.readFileSync(target, "utf8")) });
    }
    const maps = [];
    for (const mode of [MAP_MODE, AREA_MODE, PAYLOAD_MODE]) {
      const filenames = new Set();
      for (const dir of [path.join(MAP_ROOT, mode), path.join(MAP_OVERRIDE_ROOT, mode)]) {
        for (const filename of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) filenames.add(filename);
      }
      for (const filename of Array.from(filenames).sort()) {
        try {
          const overrideTarget = path.join(MAP_OVERRIDE_ROOT, mode, filename);
          const target = fs.existsSync(overrideTarget) ? overrideTarget : path.join(MAP_ROOT, mode, filename);
          const item = JSON.parse(fs.readFileSync(target, "utf8"));
          maps.push({ mode, filename, id: item.id, name: item.name });
        } catch (_) {}
      }
    }
    res.json({ maps });
  } catch (error) {
    console.error("[Admin] マップ一覧を読み込めません:", error);
    res.status(500).json({ error: "マップを読み込めませんでした" });
  }
});
app.post("/api/admin/maps", adminAuth, (req, res) => {
  const mode = String(req.body?.mode || "");
  const mapData = req.body?.map;
  if (![MAP_MODE, AREA_MODE, PAYLOAD_MODE].includes(mode) || !validateMapData(mapData)) return res.status(400).json({ error: "マップデータが不正です。スポーン地点・寸法・オブジェクトを確認してください" });
  const suppliedFilename = req.body?.filename ? safeMapFilename(String(req.body.filename)) : null;
  if (req.body?.filename && !suppliedFilename) return res.status(400).json({ error: "ファイル名が不正です" });
  const filename = suppliedFilename || (mapData.id + ".json");
  const target = path.join(MAP_OVERRIDE_ROOT, mode, filename);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!suppliedFilename && (fs.existsSync(target) || fs.existsSync(path.join(MAP_ROOT, mode, filename)))) return res.status(409).json({ error: "同じIDのマップが既にあります。一覧から既存マップを読み込んで編集してください" });
    mapData.elevatedPlatforms = Array.isArray(mapData.elevatedPlatforms) ? mapData.elevatedPlatforms : [];
    fs.writeFileSync(target, JSON.stringify(mapData, null, 2) + "\n", "utf8");
    availableMaps = loadMapsForMode(MAP_MODE);
    areaMaps = loadMapsForMode(AREA_MODE);
    payloadMaps = loadMapsForMode(PAYLOAD_MODE);
    payloadMap = payloadMaps.find(m => m.id === payloadMap.id) || payloadMaps[0];
    const updatedActive = availableMaps.find(m => m.id === activeMap.id) || availableMaps[0];
    activeMapIndex = Math.max(0, availableMaps.findIndex(m => m.id === updatedActive.id));
    activeMap = updatedActive;
    WORLD = activeMap.world; spawnPoints = activeMap.spawnPoints; obstacles = activeMap.obstacles; ramps = activeMap.ramps; elevatedPlatforms = activeMap.elevatedPlatforms;
    areaMap = areaMaps.find(m => m.id === areaMap.id) || areaMaps[0];
    io.emit("mapRotationStatus", getMapRotationStatus());
    res.json({ ok: true, filename, map: mapData });
  } catch (error) {
    console.error("[Admin] マップを保存できません:", error);
    res.status(500).json({ error: "マップを保存できませんでした" });
  }
});


function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeWeapon(value) {
  return Object.prototype.hasOwnProperty.call(WEAPONS, value) ? value : "pistol";
}

function sanitizeName(value) {
  const name = String(value || "").trim().replace(/[<>]/g, "");
  return name.slice(0, 128) || "Player";
}

function sanitizeSkin(value) {
  if (typeof value !== "string") return "";
  // 64x64 PNG data URL only; reject other content and keep Socket.IO messages bounded.
  if (value.length > 100000) return "";
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)) return "";
  return value;
}

function pickSpawn() {
  const alivePlayers = Array.from(players.values()).filter((p) => p.health > 0 && p.mode !== AREA_MODE && p.mode !== PAYLOAD_MODE);
  const scored = spawnPoints.map((spawn) => {
    const [x, _y, z] = spawn;
    const nearestDistance = alivePlayers.length
      ? Math.min(...alivePlayers.map((p) => Math.hypot(p.x - x, p.z - z)))
      : Infinity;
    return { spawn, nearestDistance };
  });

  const safe = scored.filter((entry) => entry.nearestDistance >= 16);
  if (safe.length) {
    return safe[Math.floor(Math.random() * safe.length)].spawn;
  }

  scored.sort((a, b) => b.nearestDistance - a.nearestDistance);
  return scored[0]?.spawn || [0, 0, 10];
}

function getPayloadTrackLength() {
  const pts=payloadMap?.payloadPath||[];let n=0;for(let i=1;i<pts.length;i++)n+=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][2]-pts[i-1][2]);return n;
}
function getPayloadPointAtDistance(distance) {
  const pts=payloadMap?.payloadPath||[];if(!pts.length)return{x:0,y:0,z:0,yaw:0};let left=clamp(Number(distance)||0,0,getPayloadTrackLength());
  for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i],len=Math.hypot(b[0]-a[0],b[2]-a[2]);if(left<=len||i===pts.length-1){const t=len?clamp(left/len,0,1):0;return{x:a[0]+(b[0]-a[0])*t,y:(a[1]||0)+((b[1]||0)-(a[1]||0))*t,z:a[2]+(b[2]-a[2])*t,yaw:Math.atan2(-(b[0]-a[0]),-(b[2]-a[2]))};}left-=len;}
  const p=pts[pts.length-1];return{x:p[0],y:p[1]||0,z:p[2],yaw:0};
}
function getPayloadCartCollisionInfo(player, x = player?.x, z = player?.z) {
  if (!player || player.mode !== PAYLOAD_MODE || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const match = payloadMatches.get(player.matchId);
  if (!match || match.finished) return null;
  const cart = getPayloadPointAtDistance(match.progress);
  const yaw = (Number(cart.yaw) || 0) + Math.PI / 2;
  const dx = x - cart.x, dz = z - cart.z;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  return {
    cart, yaw,
    localX: cos * dx - sin * dz,
    localZ: sin * dx + cos * dz,
    deckTop: (Number(cart.y) || 0) + 1.46,
    cargoTop: (Number(cart.y) || 0) + 2.575
  };
}

function getPayloadRespawnZones(map) {
  if (!map) return [];
  if (Array.isArray(map._payloadRespawnZones)) return map._payloadRespawnZones;
  const ceilings = (map.obstacles || []).filter((o) => o.respawnArea && o.ceiling);
  map._payloadRespawnZones = ceilings.map((ceiling) => {
    const gate = (map.obstacles || [])
      .filter((o) => o.respawnArea && o.teamOnlyRole)
      .filter((o) => Math.hypot(o.x - ceiling.x, o.z - ceiling.z) <= 8)[0] || null;
    let exitX = ceiling.x, exitZ = ceiling.z;
    if (gate) {
      if (gate.w < gate.d) exitX = gate.x + Math.sign(gate.x - ceiling.x || 1) * 1.8;
      else exitZ = gate.z + Math.sign(gate.z - ceiling.z || 1) * 1.8;
    }
    return { x: ceiling.x, z: ceiling.z, halfW: (ceiling.w || 12) / 2, halfD: (ceiling.d || 12) / 2,
      gateRole: gate?.teamOnlyRole || null, exitX, exitZ };
  });
  return map._payloadRespawnZones;
}

function getPayloadRespawnZoneAt(map, x, z) {
  return getPayloadRespawnZones(map).find((zone) =>
    Math.abs(x - zone.x) < zone.halfW - PLAYER_RADIUS &&
    Math.abs(z - zone.z) < zone.halfD - PLAYER_RADIUS
  ) || null;
}

function getPayloadSpawnPoint(player, index = 0) {
  const match = payloadMatches.get(player?.matchId);
  const total = getPayloadTrackLength();
  if (!total || !payloadMap?.payloadPath?.length) return [0, 0, 10];

  // 進行率を3段階に分け、各段階・各チームに固定の復帰地点を使う。
  // 段階内ではカートが進んでも座標は変わらない。
  const progress = clamp(Number(match?.progress) || 0, 0, total);
  const progressPercent = (progress / total) * 100;
  const stage = progressPercent < 35 ? "early" : progressPercent < 71 ? "middle" : "late";
  const role = player?.role === "defense" ? "defense" : "attack";
  const point = payloadMap.respawnPoints?.[stage]?.[role];

  if (Array.isArray(point) && point.length >= 3) return [...point];

  // マップデータに復帰地点がない場合のみ、マップ定義の通常スポーン地点へ退避する。
  const fallback = payloadMap.spawnPoints || [];
  return fallback[Math.abs(index) % fallback.length] || [0, 0, 10];
}
function isTeamMatchMode(mode){return mode===AREA_MODE||mode===PAYLOAD_MODE;}
function pickSpawnForPlayer(player, index = 0) {
  if(player?.mode===PAYLOAD_MODE)return getPayloadSpawnPoint(player,index);
  if (player?.mode === AREA_MODE) {
    const teamSpawns = areaMap.teamSpawnPoints?.[player.team] || areaMap.spawnPoints;
    if (teamSpawns?.length) return teamSpawns[Math.abs(index) % teamSpawns.length];
  }
  return pickSpawn();
}

function isSameGame(a, b) {
  if (!a || !b) return false;
  if (a.riftDuelId || b.riftDuelId) return Boolean(a.riftDuelId && a.riftDuelId === b.riftDuelId);
  const modeA = a.mode || MAP_MODE;
  const modeB = b.mode || MAP_MODE;
  if (modeA !== modeB) return false;
  if (isTeamMatchMode(modeA) || modeA === TRAINING_MODE || modeA === BUILD_MODE || modeA === "Duel" || modeA === "Wander") return Boolean(a.matchId && a.matchId === b.matchId);
  return true;
}

function gamePlayersFor(player) {
  return Array.from(players.values()).filter((candidate) => isSameGame(player, candidate));
}

function broadcastPlayers() {
  for (const client of io.sockets.sockets.values()) {
    const player = players.get(client.id);
    const visiblePlayers = player ? gamePlayersFor(player) : [];
    client.emit("players", visiblePlayers.map((entry) => publicPlayer(entry, true)));
  }
}

function broadcastGameEvent(referencePlayer, eventName, payload) {
  if (!referencePlayer) return;
  for (const client of io.sockets.sockets.values()) {
    const player = players.get(client.id);
    if (player && isSameGame(referencePlayer, player)) client.emit(eventName, payload);
  }
}

function resolveDuelRound(winner, loser) {
  if (!loser || loser.mode !== "Duel" || !loser.duelRoomId) return;
  const room = duelRooms.get(loser.duelRoomId);
  if (!room || room.status !== "playing" || room.roundResolved) return;
  const opponent = room.playerIds.map(id=>players.get(id)).find(p=>p&&p.id!==loser.id);
  const actualWinner = winner && winner.id !== loser.id ? winner : opponent;
  if (!actualWinner || !opponent) return;
  room.roundResolved = true;
  room.scores[actualWinner.id]=(room.scores[actualWinner.id]||0)+1;
  const ended=room.scores[actualWinner.id]>=room.firstTo;
  const map=[...availableMaps,...areaMaps].find(item=>item.id===room.mapId)||activeMap;
  const now=Date.now();
  for(const id of room.playerIds){const p=players.get(id);if(!p)continue;const index=room.playerIds.indexOf(id);const spawn=map.spawnPoints[index%map.spawnPoints.length]||map.spawnPoints[0];
    p.x=spawn[0];p.y=spawn[1]||0;p.z=spawn[2];p.yaw=index===0?0:Math.PI;p.pitch=0;p.health=Number(p.maxHealth)||100;p.shield=0;p.ultimateActiveUntil=0;p.ultimateAnchor=null;p.skyfallImpactPending=false;
    p.skyfallImpactId = null;p.respawnAt=0;p.velocityY=0;p.grounded=true;p.finished=ended;p.invulnerableUntil=now+2500;
    p.ammo=WEAPONS[p.weapon].magazineSize;if(Array.isArray(p.weaponAmmo))p.weaponAmmo[p.activeWeaponSlot||0]=p.ammo;p.reloadingUntil=0;p.lastFire=0;
  }
  room.status = ended ? "ended" : "playing";
  for(const id of room.playerIds){const p=players.get(id);if(!p)continue;const other=players.get(room.playerIds.find(pid=>pid!==id));io.to(id).emit(ended?"duel:matchEnd":"duel:score",{roomId:room.id,firstTo:room.firstTo,myScore:room.scores[id]||0,opponentScore:room.scores[other?.id]||0,opponentName:other?.name||"対戦相手",winnerId:actualWinner.id,matchEnded:ended});}
  if(!ended)setTimeout(()=>{room.roundResolved=false;},1800);
  broadcastPlayers();
}

const SKYFALL_IMPACT_RADIUS = 15;
const SKYFALL_IMPACT_DURATION_MS = 1800;
// 天墜の浮上時間はサーバー側で3秒に固定する（クライアント表示時間ではなく実際の滞空時間）。
const SKYFALL_FLIGHT_DURATION_MS = 3 * 1000;
let skyfallImpactSequence = 0;

function activateSkyfall(player, now = Date.now()) {
  if (!player || player.health <= 0 || player.finished || player.ultimateActiveUntil > now) return false;
  player.ultimateAnchor = { x: player.x, y: player.y, z: player.z };
  player.skyfallImpactId = "skyfall-impact-" + (++skyfallImpactSequence);
  broadcastGameEvent(player, "skyfallTargeting", {
    id: player.skyfallImpactId,
    x: player.x,
    y: getGroundHeight(player.x, player.z, player.y, player),
    z: player.z,
    radius: SKYFALL_IMPACT_RADIUS,
    expiresAt: now + SKYFALL_FLIGHT_DURATION_MS + SKYFALL_IMPACT_DURATION_MS
  });
  player.y += 12;
  player.velocityY = 0;
  player.grounded = false;
  player.skyfallImpactPending = false;
  player.skyfallStartedAt = now;
  player.ultimateActiveUntil = now + SKYFALL_FLIGHT_DURATION_MS;
  return true;
}

const SMOKE_RADIUS = 5.2;
const SMOKE_DURATION_MS = 8500;
const SMOKE_PROJECTILE_GRAVITY = 18;
const smokeProjectiles = new Map();
const grenadeProjectiles = new Map();
const grapplerProjectiles = new Map();
const smokeClouds = new Map();
const playerCannons = new Map();
let cannonSequence = 0;
let smokeSequence = 0;

function cannonPayload(cannon) { return { id: cannon.id, ownerId: cannon.ownerId, x: cannon.x, y: cannon.y, z: cannon.z, expiresAt: cannon.expiresAt }; }
function emitCannonState(socket, player) {
  const now = Date.now();
  socket.emit("cannonState", [...playerCannons.values()].filter(c => now < c.expiresAt && isSameGame(player, c.owner)).map(cannonPayload));
}
function placePlayerCannon(owner, now = Date.now()) {
  const y = getGroundHeight(owner.x, owner.z, owner.y, owner);
  const cannon = { id: "player-cannon-" + (++cannonSequence), owner, ownerId: owner.id, x: owner.x, y, z: owner.z, expiresAt: now + 10000, nextShotAt: now };
  playerCannons.set(cannon.id, cannon);
  broadcastGameEvent(owner, "cannonSpawn", cannonPayload(cannon));
}
function updatePlayerCannons(now = Date.now()) {
  for (const cannon of [...playerCannons.values()]) {
    const owner = cannon.owner;
    if (now >= cannon.expiresAt || !owner || players.get(cannon.ownerId) !== owner) {
      playerCannons.delete(cannon.id); if (owner) broadcastGameEvent(owner, "cannonRemove", { id: cannon.id }); continue;
    }
    if (now < cannon.nextShotAt) continue;
    cannon.nextShotAt = now + 1000;
    let best = null;
    for (const target of players.values()) {
      if (target.id === cannon.ownerId || target.health <= 0 || target.finished || !isSameGame(owner, target)) continue;
      if (owner.mode === TRAINING_MODE && !target.isBot) continue;
      if (isTeamMatchMode(owner.mode) && target.team === owner.team) continue;
      if (target.invulnerableUntil > now) continue;
      const dx = target.x-cannon.x, dy = target.y+0.9-(cannon.y+0.55), dz = target.z-cannon.z, distance = Math.hypot(dx,dy,dz);
      if (distance < 0.1 || (best && distance >= best.distance)) continue;
      const dir = {x:dx/distance,y:dy/distance,z:dz/distance};
      const blocked = rayHitsObstacle({x:cannon.x,y:cannon.y+0.55,z:cannon.z},dir,distance,owner);
      if (blocked !== null && blocked < distance-0.25) continue;
      best = {target,distance};
    }
    if (!best) continue;
    const target = best.target, origin = {x:cannon.x,y:cannon.y+0.55,z:cannon.z};
    const dealt = applyIncomingDamage(target,10,true).totalDamage;
    if (dealt > 0) addUltimateCharge(owner,dealt);
    io.to(target.id).emit("damageTaken",{damage:Math.round(dealt),zone:"body",source:"cannon"});
    io.to(owner.id).emit("damageDealt",{damage:Math.round(dealt),targetId:target.id,targetName:target.name,zone:"body"});
    broadcastGameEvent(owner,"cannonFire",{id:cannon.id,x:origin.x,y:origin.y,z:origin.z,targetX:target.x,targetY:target.y+0.9,targetZ:target.z});
    if (target.health <= 0) {
      owner.health = Number(owner.maxHealth) || 100;
      clearBurnStatus(owner);
      target.health=0; target.respawnAt=now+5000; target.deaths=(target.deaths||0)+1; owner.kills=(owner.kills||0)+1;
      if(target.mode==="Duel") resolveDuelRound(owner,target);
      target.invisibleUntil=0; if(target.riftDuelId) finishRiftDuel(target);
      broadcastGameEvent(owner,"elimination",{killerId:owner.id,killerName:owner.name,victimId:target.id,victimName:target.name,killerKills:owner.kills,zone:"body"});
    }
  }
}

function smokeProjectilePayload(projectile) {
  return {
    id: projectile.id, x: projectile.x, y: projectile.y, z: projectile.z,
    ownerId: projectile.ownerId, type: projectile.type || "grenade", expiresAt: projectile.expiresAt,
    vx: Number(projectile.vx) || 0, vy: Number(projectile.vy) || 0, vz: Number(projectile.vz) || 0
  };
}

function smokeCloudPayload(cloud, now = Date.now()) {
  return {
    id: cloud.id, x: cloud.x, y: cloud.y, z: cloud.z,
    radius: cloud.radius, expiresAt: cloud.expiresAt,
    remainingMs: Math.max(0, cloud.expiresAt - now)
  };
}

function emitSmokeState(socket, player) {
  const now = Date.now();
  socket.emit("smokeState", {
    projectiles: [...smokeProjectiles.values()]
      .filter((item) => isSameGame(player, item.owner))
      .map((item) => ({ ...smokeProjectilePayload(item), remainingMs: Math.max(0, item.expiresAt - now) })),
    clouds: [...smokeClouds.values()]
      .filter((item) => isSameGame(player, item.owner))
      .map((item) => smokeCloudPayload(item, now))
  });
}

function spawnSmokeCloud(owner, position, now = Date.now()) {
  const id = "smoke-cloud-" + (++smokeSequence);
  const groundY = getGroundHeight(position.x, position.z, position.y, owner);
  const cloud = {
    id, owner, x: position.x, y: Math.max(position.y, groundY) + SMOKE_RADIUS * 0.28,
    z: position.z, radius: SMOKE_RADIUS, expiresAt: now + SMOKE_DURATION_MS
  };
  smokeClouds.set(id, cloud);
  broadcastGameEvent(owner, "smokeCloudSpawn", smokeCloudPayload(cloud, now));
}

function spawnSmokeProjectile(shooter, now = Date.now()) {
  const direction = directionFromAngles(shooter.yaw, shooter.pitch);
  const speed = 14;
  const height = shooter.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const origin = {
    x: shooter.x + direction.x * 0.62,
    y: shooter.y + height - 0.18,
    z: shooter.z + direction.z * 0.62
  };
  const id = "smoke-projectile-" + (++smokeSequence);
  const projectile = {
    id, owner: shooter, ownerId: shooter.id,
    x: origin.x, y: origin.y, z: origin.z,
    vx: direction.x * speed, vy: direction.y * speed + 4.5, vz: direction.z * speed,
    expiresAt: now + 4500
  };
  smokeProjectiles.set(id, projectile);
  broadcastGameEvent(shooter, "smokeProjectileSpawn", smokeProjectilePayload(projectile));
  broadcastGameEvent(shooter, "shot", {
    id: shooter.id, x: origin.x, y: origin.y, z: origin.z,
    yaw: shooter.yaw, pitch: shooter.pitch, weapon: "smoke", hit: null, tracers: []
  });
}

function spawnGrenadeProjectile(shooter, now = Date.now(), type = "grenade") {
  const direction = directionFromAngles(shooter.yaw, shooter.pitch);
  const speed = 14;
  const horizontalSpeed = speed * 1.5;
  const height = shooter.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const origin = {
    x: shooter.x + direction.x * 0.62,
    y: shooter.y + height - 0.18,
    z: shooter.z + direction.z * 0.62
  };
  const id = (type === "shockwave" ? "shockwave-projectile-" : "grenade-projectile-") + (++smokeSequence);
  const projectile = {
    id, type, owner: shooter, ownerId: shooter.id,
    x: origin.x, y: origin.y, z: origin.z,
    startX: origin.x, startY: origin.y, startZ: origin.z,
    vx: direction.x * horizontalSpeed, vy: direction.y * speed + 4.5, vz: direction.z * horizontalSpeed,
    expiresAt: now + 4500
  };
  grenadeProjectiles.set(id, projectile);
  broadcastGameEvent(shooter, "grenadeProjectileSpawn", smokeProjectilePayload(projectile));
  broadcastGameEvent(shooter, "shot", {
    id: shooter.id, x: origin.x, y: origin.y, z: origin.z,
    yaw: shooter.yaw, pitch: shooter.pitch, weapon: type === "shockwave" ? "shockwaveLauncher" : "grenadeLauncher", hit: null, tracers: []
  });
}

function spawnRocketProjectile(shooter, now = Date.now()) {
  const direction = directionFromAngles(shooter.yaw, shooter.pitch);
  const speed = 18.5 * 1.5;
  const height = shooter.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const origin = { x: shooter.x + direction.x * 1.15, y: shooter.y + height - 0.12, z: shooter.z + direction.z * 1.15 };
  const id = "rocket-projectile-" + (++smokeSequence);
  const projectile = { id, type: "rocket", owner: shooter, ownerId: shooter.id,
    x: origin.x, y: origin.y, z: origin.z,
    vx: direction.x * speed, vy: direction.y * speed, vz: direction.z * speed,
    expiresAt: now + 9000 };
  grenadeProjectiles.set(id, projectile);
  broadcastGameEvent(shooter, "grenadeProjectileSpawn", smokeProjectilePayload(projectile));
  broadcastGameEvent(shooter, "shot", { id: shooter.id, x: origin.x, y: origin.y, z: origin.z,
    yaw: shooter.yaw, pitch: shooter.pitch, weapon: "rocketLauncher", hit: null, tracers: [] });
}

function spawnFormingProjectile(shooter, now = Date.now(), shotIndex = 0) {
  const speed = 18.5;
  const height = shooter.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const forward = directionFromAngles(shooter.yaw, shooter.pitch);
  const rightX = Math.cos(shooter.yaw), rightZ = -Math.sin(shooter.yaw);
  // 3発とも同じ銃口から発射し、連射ごとにごく小さく照準をずらす。
  const spread = (shotIndex - 1) * 0.009;
  const direction = directionFromAngles(shooter.yaw + spread, shooter.pitch);
  const origin = {
    x: shooter.x + forward.x * 0.85,
    y: shooter.y + height - 0.12,
    z: shooter.z + forward.z * 0.85
  };
  const id = "forming-projectile-" + (++smokeSequence);
  const projectile = {
    id, type: "forming", owner: shooter, ownerId: shooter.id,
    x: origin.x, y: origin.y, z: origin.z,
    vx: direction.x * speed, vy: direction.y * speed, vz: direction.z * speed,
    speed, targetId: null, homing: false, expiresAt: now + 9000
  };
  grenadeProjectiles.set(id, projectile);
  broadcastGameEvent(shooter, "grenadeProjectileSpawn", smokeProjectilePayload(projectile));
  broadcastGameEvent(shooter, "shot", { id: shooter.id, x: origin.x, y: origin.y, z: origin.z,
    yaw: shooter.yaw + spread, pitch: shooter.pitch, weapon: "formingGun", hit: null, tracers: [] });
}

function spawnFormingBurst(shooter, now = Date.now()) {
  const shotCount = 3;
  const intervalMs = 115;
  for (let index = 0; index < shotCount; index++) {
    setTimeout(() => {
      const current = players.get(shooter.id);
      if (current !== shooter || current.health <= 0 || current.finished || !isSameGame(current, shooter)) return;
      spawnFormingProjectile(current, Date.now(), index);
    }, index * intervalMs);
  }
}

function spawnTornadoProjectile(shooter, now = Date.now()) {
  const direction = directionFromAngles(shooter.yaw, 0);
  const speed = 40;
  const origin = { x: shooter.x + direction.x * 0.7, y: getGroundHeight(shooter.x, shooter.z, shooter.y, shooter) + 7, z: shooter.z + direction.z * 0.7 };
  const id = "tornado-projectile-" + (++smokeSequence);
  const projectile = {
    id, type: "tornado", owner: shooter, ownerId: shooter.id,
    x: origin.x, y: origin.y, z: origin.z,
    vx: direction.x * speed, vy: direction.y * speed, vz: direction.z * speed,
    expiresAt: now + 120000,
    hitPlayers: new Set()
  };
  grenadeProjectiles.set(id, projectile);
  broadcastGameEvent(shooter, "grenadeProjectileSpawn", smokeProjectilePayload(projectile));
  broadcastGameEvent(shooter, "shot", {
    id: shooter.id, x: origin.x, y: origin.y, z: origin.z,
    yaw: shooter.yaw, pitch: shooter.pitch, weapon: "tornadoUltimate", hit: null, tracers: []
  });
}

function spawnGrappleProjectile(shooter, now = Date.now()) {
  const direction = directionFromAngles(shooter.yaw, shooter.pitch);
  const speed = 30;
  const height = shooter.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const origin = { x: shooter.x + direction.x * 0.62, y: shooter.y + height - 0.18, z: shooter.z + direction.z * 0.62 };
  const id = "grapple-projectile-" + (++smokeSequence);
  const projectile = {
    id, type: "grapple", owner: shooter, ownerId: shooter.id,
    x: origin.x, y: origin.y, z: origin.z,
    startX: origin.x, startY: origin.y, startZ: origin.z,
    vx: direction.x * speed, vy: direction.y * speed, vz: direction.z * speed,
    expiresAt: now + 2200
  };
  grenadeProjectiles.set(id, projectile);
  broadcastGameEvent(shooter, "grenadeProjectileSpawn", smokeProjectilePayload(projectile));
  broadcastGameEvent(shooter, "shot", { id: shooter.id, x: origin.x, y: origin.y, z: origin.z, yaw: shooter.yaw, pitch: shooter.pitch, weapon: "grappler", hit: null, tracers: [] });
}

function applyGrapplePull(projectile, position) {
  const owner = projectile.owner;
  if (!owner || players.get(owner.id) !== owner || owner.health <= 0 || owner.finished) return;
  // 着弾後、画面上にグラップラーの紐が表示されている間は武器切替を禁止する。
  owner.grappleTetherUntil = Date.now() + 900;
  const dx = position.x - owner.x;
  const dy = position.y - (owner.y + (owner.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) * 0.65);
  const dz = position.z - owner.z;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal < 1.2 && Math.abs(dy) < 1.5) return;
  const directionX = horizontal > 0.001 ? dx / horizontal : 0;
  const directionZ = horizontal > 0.001 ? dz / horizontal : 0;
  const pullSpeed = clamp(72 + horizontal * 0.36, 72, 102);
  const floorY = getGroundHeight(position.x, position.z, position.y, owner);
  // 床面に着弾した場合は床上を目的地にする。壁面の場合は壁の内側へ入らないよう、
  // ワイヤーの進行方向と反対側へプレイヤー半径分だけ手前に着地点をずらす。
  const floorAnchor = position.y <= floorY + 0.2;
  const safeOffset = floorAnchor ? 0 : PLAYER_RADIUS + 0.55;
  const targetX = position.x - directionX * safeOffset;
  const targetZ = position.z - directionZ * safeOffset;
  const targetGroundY = getGroundHeight(targetX, targetZ, owner.y, owner);
  const targetY = floorAnchor
    ? targetGroundY
    : Math.max(targetGroundY, position.y - (owner.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) * 0.65);
  owner.grapplePullTarget = {
    x: targetX,
    y: targetY,
    z: targetZ,
    floorAnchor,
    expiresAt: Date.now() + 3200
  };
  owner.knockbackVelocityX = directionX * pullSpeed;
  owner.knockbackVelocityZ = directionZ * pullSpeed;
  owner.velocityY = floorAnchor ? 0 : clamp(5 + dy * 1.5, 3, 13);
  owner.grounded = false;
  owner.lastGroundedAt = 0;
  broadcastGameEvent(owner, "grappleImpact", { id: projectile.id, ownerId: owner.id, x: position.x, y: position.y, z: position.z });
}

function applyShockwave(projectile, position, now = Date.now()) {
  const radius = 7.8;
  const id = "shockwave-burst-" + (++smokeSequence);
  broadcastGameEvent(projectile.owner, "shockwaveBurst", {
    id, x: position.x, y: position.y, z: position.z, radius, expiresAt: now + 520
  });
  for (const target of players.values()) {
    if (target.health <= 0 || target.finished || !isSameGame(projectile.owner, target)) continue;
    if (projectile.owner.mode === TRAINING_MODE && target.id !== projectile.ownerId && !target.isBot) continue;
    if (isTeamMatchMode(projectile.owner.mode) && target.team === projectile.owner.team) continue;
    if (target.invulnerableUntil > now) continue;
    const dx = target.x - position.x;
    const dz = target.z - position.z;
    const targetHeight = target.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
    const dy = target.y + targetHeight * 0.5 - position.y;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > radius) continue;
    if (target.id !== projectile.ownerId) {
      target.ultimateCharge = Math.min(100, (Number(target.ultimateCharge) || 0) + 20);
    }
    const proximity = 1 - clamp(distance / radius, 0, 1);
    let dirX, dirY, dirZ;
    if (distance > 0.001) {
      dirX = dx / distance;
      dirY = dy / distance;
      dirZ = dz / distance;
    } else {
      const fallback = directionFromAngles(projectile.owner.yaw, 0);
      dirX = fallback.x;
      dirY = 0;
      dirZ = fallback.z;
    }
    const horizontalImpulse = (13 + 22 * proximity) * 1.4;
    target.knockbackVelocityX = (Number(target.knockbackVelocityX) || 0) + dirX * horizontalImpulse;
    target.knockbackVelocityZ = (Number(target.knockbackVelocityZ) || 0) + dirZ * horizontalImpulse;
    // 上方向の力を直前の設定から約6〜8%強化する。
    target.velocityY = Math.max(Number(target.velocityY) || 0, 4.3 + 6.3 * proximity);
    target.grounded = false;
    target.lastGroundedAt = 0;
  }
}

function explodeRocket(projectile, position, now = Date.now()) {
  const radius = 13, maxDamage = 180, minDamage = 50;
  damageBuildStructuresInRadius(projectile.owner, position, radius, maxDamage);
  const id = "rocket-explosion-" + (++smokeSequence);
  broadcastGameEvent(projectile.owner, "grenadeExplosion", { id, x: position.x, y: position.y, z: position.z, radius, expiresAt: now + 520 });
  for (const target of players.values()) {
    const isOwner = target.id === projectile.ownerId;
    if (target.health <= 0 || target.finished || !isSameGame(projectile.owner, target)) continue;
    if (!isOwner && projectile.owner.mode === TRAINING_MODE && !target.isBot) continue;
    if (!isOwner && isTeamMatchMode(projectile.owner.mode) && target.team === projectile.owner.team) continue;
    if (target.invulnerableUntil > now) continue;
    const targetHeight = target.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
    const dx = target.x - position.x, dy = target.y + targetHeight * 0.5 - position.y, dz = target.z - position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > radius) continue;
    const damage = Math.round(maxDamage - (maxDamage - minDamage) * clamp(distance / radius, 0, 1));
    const split = applyIncomingDamage(target, damage);
    if (!isOwner) addUltimateCharge(projectile.owner, damage);
    io.to(projectile.ownerId).emit("damageDealt", { targetId: target.id, damage, shieldDamage: split.shieldDamage, healthDamage: split.healthDamage, zone: "body", x: target.x, y: target.y + targetHeight * 0.5, z: target.z });
    io.to(target.id).emit("damageTaken", { damage, zone: "body" });
    if (target.health <= 0) {
      target.health = 0; target.respawnAt = now + 5000; target.deaths = (target.deaths || 0) + 1;
      if (!isOwner) {
        projectile.owner.health = Number(projectile.owner.maxHealth) || 100; clearBurnStatus(projectile.owner);
        projectile.owner.kills = (projectile.owner.kills || 0) + 1;
        if (target.mode === "Duel") resolveDuelRound(projectile.owner, target);
      }
      target.invisibleUntil = 0; if (target.riftDuelId) finishRiftDuel(target);
      if (!isOwner && projectile.owner.invisibleUntil > Date.now()) projectile.owner.invisibleUntil = 0;
      broadcastGameEvent(projectile.owner, "elimination", { killerId: isOwner ? null : projectile.owner.id, killerName: isOwner ? "環境" : projectile.owner.name, victimId: target.id, victimName: target.name, killerKills: projectile.owner.kills, zone: "body" });
    }
  }
}

function explodeGrenade(projectile, position, now = Date.now()) {
  const radius = 5.2;
  damageBuildStructuresInRadius(projectile.owner, position, radius, 110);
  const id = "grenade-explosion-" + (++smokeSequence);
  broadcastGameEvent(projectile.owner, "grenadeExplosion", {
    id, x: position.x, y: position.y, z: position.z, radius, expiresAt: now + 420
  });
  for (const target of players.values()) {
    if (target.health <= 0 || target.finished ||
        !isSameGame(projectile.owner, target)) continue;
    if (target.id !== projectile.ownerId && projectile.owner.mode === TRAINING_MODE && !target.isBot) continue;
    if (isTeamMatchMode(projectile.owner.mode) && target.team === projectile.owner.team) continue;
    if (target.invulnerableUntil > now) continue;
    const targetHeight = target.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
    const dx = target.x - position.x;
    const dy = target.y + targetHeight * 0.5 - position.y;
    const dz = target.z - position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > radius) continue;
    const damage = Math.round(20 + 90 * (1 - distance / radius));
    if (damage <= 0) continue;
    const damageSplit = applyIncomingDamage(target, damage);
    if (projectile.owner && projectile.owner.id !== target.id) addUltimateCharge(projectile.owner, damage);

    io.to(projectile.ownerId).emit("damageDealt", {
      targetId: target.id, damage, shieldDamage: damageSplit.shieldDamage, healthDamage: damageSplit.healthDamage, zone: "body",
      x: target.x, y: target.y + targetHeight * 0.5, z: target.z
    });
    io.to(target.id).emit("damageTaken", {
      damage, zone: "body"
    });
    if (target.health <= 0) {
      const selfElimination = target.id === projectile.ownerId;
      if (!selfElimination) {
        projectile.owner.health = Number(projectile.owner.maxHealth) || 100;
        clearBurnStatus(projectile.owner);
        projectile.owner.kills = (projectile.owner.kills || 0) + 1;
      }
      target.health = 0;
      target.respawnAt = now + 5000;
      target.kills = target.kills || 0;
      target.deaths += 1;
      if(target.mode==="Duel"){const winner=selfElimination?gamePlayersFor(target).find(p=>p.id!==target.id):projectile.owner;resolveDuelRound(winner,target);}
      target.invisibleUntil = 0;
      if (target.riftDuelId) finishRiftDuel(target);
      if (!selfElimination && projectile.owner.invisibleUntil > Date.now()) projectile.owner.invisibleUntil = 0;
      broadcastGameEvent(projectile.owner, "elimination", {
        killerId: selfElimination ? null : projectile.owner.id,
        killerName: selfElimination ? "自爆" : projectile.owner.name,
        victimId: target.id, victimName: target.name,
        killerKills: projectile.owner.kills, zone: "body"
      });
    }
  }
}

function updateSmokeProjectiles(dt, now = Date.now()) {
  for (const projectile of [...smokeProjectiles.values()]) {
    if (projectile.type !== "tornado" && now >= projectile.expiresAt) {
      smokeProjectiles.delete(projectile.id);
      broadcastGameEvent(projectile.owner, "smokeProjectileRemove", { id: projectile.id });
      continue;
    }

    const from = { x: projectile.x, y: projectile.y, z: projectile.z };
    const nextX = projectile.x + projectile.vx * dt;
    const nextY = projectile.y + projectile.vy * dt - 0.5 * SMOKE_PROJECTILE_GRAVITY * dt * dt;
    const nextZ = projectile.z + projectile.vz * dt;
    const delta = { x: nextX - from.x, y: nextY - from.y, z: nextZ - from.z };
    const distance = Math.hypot(delta.x, delta.y, delta.z);
    let impact = null;

    if (distance > 1e-5) {
      const direction = { x: delta.x / distance, y: delta.y / distance, z: delta.z / distance };
      let nearestHit = null;
      const wallDistance = rayHitsObstacle(from, direction, distance, projectile.owner);
      if (wallDistance !== null && !(projectile.type === "rocket" && wallDistance < 0.28)) nearestHit = { distance: wallDistance };

      // 外周の壁はクライアント側で生成されるため、マップ境界もここで衝突判定する。
      const bounds = getMapForPlayer(projectile.owner).world || WORLD;
      const boundaryPlanes = [
        { axis: "x", plane: bounds.minX - 1.5, outward: -1 },
        { axis: "x", plane: bounds.maxX + 1.5, outward: 1 },
        { axis: "z", plane: bounds.minZ - 1.5, outward: -1 },
        { axis: "z", plane: bounds.maxZ + 1.5, outward: 1 }
      ];
      for (const boundary of boundaryPlanes) {
        const before = from[boundary.axis];
        const after = boundary.axis === "x" ? nextX : nextZ;
        const crosses = boundary.outward < 0
          ? before >= boundary.plane && after <= boundary.plane
          : before <= boundary.plane && after >= boundary.plane;
        if (!crosses || Math.abs(after - before) < 1e-8) continue;
        const fraction = (boundary.plane - before) / (after - before);
        if (fraction < 0 || fraction > 1) continue;
        const yAtBoundary = from.y + delta.y * fraction;
        if (yAtBoundary < 0 || yAtBoundary > 3) continue;
        const boundaryDistance = fraction * distance;
        if (!nearestHit || boundaryDistance < nearestHit.distance) {
          nearestHit = { distance: boundaryDistance };
        }
      }

      for (const target of players.values()) {
        if (target.health <= 0 || target.finished ||
            !isSameGame(projectile.owner, target)) continue;
        // 発射直後に自分の当たり判定へ触れて即爆発しないよう、少し進んでから自分との衝突も有効にする。
        const isOwner = target.id === projectile.ownerId;
        const traveled = Math.hypot(from.x - projectile.startX, from.y - projectile.startY, from.z - projectile.startZ);
        if (isOwner && traveled < 1.4) continue;
        const hit = rayHitsPlayer(from, direction, target);
        if (hit && hit.t >= 0 && hit.t <= distance && (!nearestHit || hit.t < nearestHit.distance)) {
          nearestHit = { distance: hit.t };
        }
      }

      const groundY = getGroundHeight(nextX, nextZ, projectile.y, projectile.owner);
      let groundHitDistance = Infinity;
      if (projectile.vy <= 0 && nextY <= groundY + 0.12 && projectile.y >= groundY - 0.05) {
        const ySpan = projectile.y - nextY;
        const fraction = ySpan > 1e-5
          ? clamp((projectile.y - (groundY + 0.12)) / ySpan, 0, 1)
          : 0;
        groundHitDistance = fraction * distance;
      }

      if (nearestHit && nearestHit.distance <= groundHitDistance) {
        const t = clamp(nearestHit.distance, 0, distance);
        impact = {
          x: from.x + direction.x * t,
          y: from.y + direction.y * t,
          z: from.z + direction.z * t
        };
      } else if (groundHitDistance < Infinity) {
        const t = clamp(groundHitDistance, 0, distance);
        impact = { x: from.x + direction.x * t, y: groundY, z: from.z + direction.z * t };
      }
    }

    if (impact) {
      spawnSmokeCloud(projectile.owner, impact, now);
      smokeProjectiles.delete(projectile.id);
      broadcastGameEvent(projectile.owner, "smokeProjectileRemove", { id: projectile.id });
      continue;
    }

    projectile.x = nextX;
    projectile.y = nextY;
    projectile.z = nextZ;
    projectile.vy -= SMOKE_PROJECTILE_GRAVITY * dt;
    broadcastGameEvent(projectile.owner, "smokeProjectileUpdate", {
      id: projectile.id, x: projectile.x, y: projectile.y, z: projectile.z
    });
  }

  for (const cloud of [...smokeClouds.values()]) {
    if (now < cloud.expiresAt) continue;
    smokeClouds.delete(cloud.id);
    broadcastGameEvent(cloud.owner, "smokeCloudRemove", { id: cloud.id });
  }
}

function updateGrenadeProjectiles(dt, now = Date.now()) {
  for (const projectile of [...grenadeProjectiles.values()]) {
    // ショックウェーブは着弾から300ms待って、吹き飛ばしとエフェクトを同時に発生させる。
    if (projectile.pendingShockwaveAt) {
      if (now < projectile.pendingShockwaveAt) continue;
      applyShockwave(projectile, projectile.pendingShockwavePosition, now);
      grenadeProjectiles.delete(projectile.id);
      continue;
    }

    if (now >= projectile.expiresAt) {
      grenadeProjectiles.delete(projectile.id);
      broadcastGameEvent(projectile.owner, "grenadeProjectileRemove", { id: projectile.id });
      continue;
    }

    if (projectile.type === "forming") {
      const owner = projectile.owner;
      if (!owner || players.get(projectile.ownerId) !== owner) {
        grenadeProjectiles.delete(projectile.id);
        continue;
      }
      let target = projectile.targetId ? players.get(projectile.targetId) : null;
      const eligible = (candidate) => candidate && candidate.id !== projectile.ownerId &&
        candidate.health > 0 && !candidate.finished && isSameGame(owner, candidate) &&
        !(owner.mode === TRAINING_MODE && !candidate.isBot) &&
        !(isTeamMatchMode(owner.mode) && candidate.team === owner.team);
      if (projectile.homing && (!eligible(target) || !target)) {
        projectile.homing = false;
        projectile.homingDisabled = true;
        projectile.targetId = null;
      }
      if (!projectile.homing && !projectile.homingDisabled) {
        let nearest = null;
        for (const candidate of players.values()) {
          if (!eligible(candidate) || candidate.invulnerableUntil > now) continue;
          const center = { x: candidate.x, y: candidate.y + (candidate.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) * 0.55, z: candidate.z };
          const dx = center.x - projectile.x, dy = center.y - projectile.y, dz = center.z - projectile.z;
          const distance = Math.hypot(dx, dy, dz);
          if (distance > 15 || (nearest && distance >= nearest.distance)) continue;
          const dir = { x: dx / Math.max(distance, 1e-6), y: dy / Math.max(distance, 1e-6), z: dz / Math.max(distance, 1e-6) };
          const sightOrigin = { x: projectile.x, y: projectile.y, z: projectile.z };
          const mapWall = rayHitsObstacle(sightOrigin, dir, distance, owner);
          const cartWall = owner.mode === PAYLOAD_MODE ? rayHitsPayloadCart(sightOrigin, dir, distance, owner) : null;
          const wall = mapWall === null ? cartWall : cartWall === null ? mapWall : Math.min(mapWall, cartWall);
          if (wall !== null && wall < distance - 0.2) continue;
          nearest = { candidate, distance, dir };
        }
        if (nearest) {
          projectile.targetId = nearest.candidate.id;
          projectile.homing = true;
          target = nearest.candidate;
        }
      }
      if (projectile.homing && eligible(target)) {
        const center = { x: target.x, y: target.y + (target.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) * 0.55, z: target.z };
        const dx = center.x - projectile.x, dy = center.y - projectile.y, dz = center.z - projectile.z;
        const distance = Math.hypot(dx, dy, dz);
        const dir = { x: dx / Math.max(distance, 1e-6), y: dy / Math.max(distance, 1e-6), z: dz / Math.max(distance, 1e-6) };
        const sightOrigin = { x: projectile.x, y: projectile.y, z: projectile.z };
        const mapWall = rayHitsObstacle(sightOrigin, dir, distance, owner);
        const cartWall = owner.mode === PAYLOAD_MODE ? rayHitsPayloadCart(sightOrigin, dir, distance, owner) : null;
        const wall = mapWall === null ? cartWall : cartWall === null ? mapWall : Math.min(mapWall, cartWall);
        if (wall !== null && wall < distance - 0.2) {
          projectile.homing = false;
          projectile.homingDisabled = true;
          projectile.targetId = null;
        } else {
          const current = { x: projectile.vx / projectile.speed, y: projectile.vy / projectile.speed, z: projectile.vz / projectile.speed };
          const blend = Math.min(1, dt * 48);
          const nx = current.x + (dir.x - current.x) * blend;
          const ny = current.y + (dir.y - current.y) * blend;
          const nz = current.z + (dir.z - current.z) * blend;
          const norm = Math.hypot(nx, ny, nz) || 1;
          projectile.vx = nx / norm * projectile.speed;
          projectile.vy = ny / norm * projectile.speed;
          projectile.vz = nz / norm * projectile.speed;
        }
      }
      const from = { x: projectile.x, y: projectile.y, z: projectile.z };
      const next = { x: from.x + projectile.vx * dt, y: from.y + projectile.vy * dt, z: from.z + projectile.vz * dt };
      const physicalProjectileRadius = (item) => item.type === "rocket" ? 0.42
        : item.type === "forming" ? 0.25
        : item.type === "tornado" ? 0.7
        : item.type === "grapple" ? 0.16 : 0.22;
      let collidedProjectile = null;
      for (const other of grenadeProjectiles.values()) {
        if (other.id === projectile.id || other.pendingShockwaveAt || !["forming", "rocket", "grenade", "shockwave", "smoke", "grapple", "tornado"].includes(other.type)) continue;
        // ホーミングガンの3発は同じ所有者から連続発射されるため、味方弾同士では衝突させない。
        if (projectile.type === "forming" && other.type === "forming" && other.ownerId === projectile.ownerId) continue;
        const otherOwner = other.owner;
        if (!otherOwner || !isSameGame(owner, otherOwner)) continue;
        const ox = other.x - next.x, oy = other.y - next.y, oz = other.z - next.z;
        const radius = physicalProjectileRadius(projectile) + physicalProjectileRadius(other);
        if (ox * ox + oy * oy + oz * oz <= radius * radius) {
          collidedProjectile = other;
          break;
        }
      }
      if (collidedProjectile) {
        grenadeProjectiles.delete(projectile.id);
        grenadeProjectiles.delete(collidedProjectile.id);
        broadcastGameEvent(owner, "grenadeProjectileRemove", { id: projectile.id });
        broadcastGameEvent(collidedProjectile.owner, "grenadeProjectileRemove", { id: collidedProjectile.id });
        continue;
      }
      const delta = { x: next.x - from.x, y: next.y - from.y, z: next.z - from.z };
      const distance = Math.hypot(delta.x, delta.y, delta.z);
      const dir = { x: delta.x / Math.max(distance, 1e-6), y: delta.y / Math.max(distance, 1e-6), z: delta.z / Math.max(distance, 1e-6) };
      let hitTarget = null, hitInfo = null;
      for (const candidate of players.values()) {
        if (!eligible(candidate) || candidate.invulnerableUntil > now) continue;
        const height = candidate.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
        const center = { x: candidate.x, y: candidate.y + height * 0.55, z: candidate.z };
        const lengthSq = delta.x * delta.x + delta.y * delta.y + delta.z * delta.z;
        const t = lengthSq > 1e-9
          ? clamp(((center.x - from.x) * delta.x + (center.y - from.y) * delta.y + (center.z - from.z) * delta.z) / lengthSq, 0, 1)
          : 0;
        const closest = { x: from.x + delta.x * t, y: from.y + delta.y * t, z: from.z + delta.z * t };
        const horizontalDistance = Math.hypot(center.x - closest.x, center.z - closest.z);
        const verticalDistance = Math.abs(center.y - closest.y);
        // 1フレーム内の移動線分全体を判定し、細い弾が高速移動中に敵をすり抜けないようにする。
        if (horizontalDistance > PLAYER_RADIUS + 0.55 || verticalDistance > height * 0.58 + 0.4) continue;
        const hitDistance = distance * t;
        if (!hitInfo || hitDistance < hitInfo.t) {
          hitTarget = candidate;
          hitInfo = { t: hitDistance, zone: closest.y > candidate.y + height * 0.78 ? "head" : "body" };
        }
      }
      const mapWallDistance = distance > 1e-5 ? rayHitsObstacle(from, dir, distance, owner) : null;
      const cartWallDistance = distance > 1e-5 && owner.mode === PAYLOAD_MODE
        ? rayHitsPayloadCart(from, dir, distance, owner) : null;
      const wallDistance = mapWallDistance === null ? cartWallDistance
        : cartWallDistance === null ? mapWallDistance : Math.min(mapWallDistance, cartWallDistance);
      if (hitTarget && (wallDistance === null || wallDistance > hitInfo.t)) {
        const damage = 5;
        const split = applyIncomingDamage(hitTarget, damage, true);
        addUltimateCharge(owner, split.totalDamage);
        io.to(owner.id).emit("damageDealt", { targetId: hitTarget.id, damage: Math.round(split.totalDamage), shieldDamage: Math.round(split.shieldDamage), healthDamage: Math.round(split.healthDamage), zone: hitInfo.zone || "body", x: next.x, y: next.y, z: next.z });
        io.to(hitTarget.id).emit("damageTaken", { damage: Math.round(split.totalDamage), zone: hitInfo.zone || "body" });
        if (hitTarget.health <= 0) {
          owner.health = Number(owner.maxHealth) || 100;
          clearBurnStatus(owner);
          hitTarget.health = 0;
          hitTarget.respawnAt = now + 5000;
          hitTarget.deaths = (hitTarget.deaths || 0) + 1;
          hitTarget.invisibleUntil = 0;
          if (hitTarget.riftDuelId) finishRiftDuel(hitTarget);
          clearBurnStatus(hitTarget);
          owner.kills = (owner.kills || 0) + 1;
          if (owner.invisibleUntil > now) owner.invisibleUntil = 0;
          if (hitTarget.mode === "Duel") resolveDuelRound(owner, hitTarget);
          broadcastGameEvent(owner, "elimination", { killerId: owner.id, killerName: owner.name, victimId: hitTarget.id, victimName: hitTarget.name, killerKills: owner.kills, zone: hitInfo.zone || "body" });
        }
        grenadeProjectiles.delete(projectile.id);
        broadcastGameEvent(owner, "grenadeProjectileRemove", { id: projectile.id });
        continue;
      }
      const bounds = getMapForPlayer(owner).world || WORLD;
      if (next.x < bounds.minX || next.x > bounds.maxX || next.z < bounds.minZ || next.z > bounds.maxZ ||
          (wallDistance !== null && wallDistance <= distance)) {
        grenadeProjectiles.delete(projectile.id);
        broadcastGameEvent(owner, "grenadeProjectileRemove", { id: projectile.id });
        continue;
      }
      projectile.x = next.x; projectile.y = next.y; projectile.z = next.z;
      broadcastGameEvent(owner, "grenadeProjectileUpdate", { id: projectile.id, x: projectile.x, y: projectile.y, z: projectile.z, vx: projectile.vx, vy: projectile.vy, vz: projectile.vz });
      continue;
    }

    if (projectile.type === "tornado") {
      const next = {
        x: projectile.x + projectile.vx * dt,
        y: projectile.y,
        z: projectile.z + projectile.vz * dt
      };
      const bounds = getMapForPlayer(projectile.owner).world || WORLD;
      // 地面・天井・マップ外周のいずれかを越えるまで、障害物を貫通して直進する。
      const outside = next.x < bounds.minX || next.x > bounds.maxX ||
        next.z < bounds.minZ || next.z > bounds.maxZ || next.y < 0 || next.y > 200;
      if (outside) {
        grenadeProjectiles.delete(projectile.id);
        broadcastGameEvent(projectile.owner, "grenadeProjectileRemove", { id: projectile.id });
        continue;
      }

      // 命中しても飛行は止めず、同じプレイヤーへの重複ダメージだけを防ぐ。
      for (const target of players.values()) {
        if (target.id === projectile.ownerId || target.health <= 0 || target.finished ||
            !isSameGame(projectile.owner, target) ||
            (isTeamMatchMode(projectile.owner.mode) && target.team === projectile.owner.team) ||
            projectile.hitPlayers?.has(target.id)) continue;
        const center = { x: target.x, y: target.y + (target.crouched ? 0.55 : 0.85), z: target.z };
        const dx = next.x - projectile.x, dy = next.y - projectile.y, dz = next.z - projectile.z;
        const lengthSq = dx * dx + dy * dy + dz * dz;
        const t = lengthSq > 1e-8 ? clamp(((center.x - projectile.x) * dx + (center.y - projectile.y) * dy + (center.z - projectile.z) * dz) / lengthSq, 0, 1) : 0;
        const closest = { x: projectile.x + dx * t, y: projectile.y + dy * t, z: projectile.z + dz * t };
        if (Math.hypot(center.x - closest.x, center.z - closest.z) > 5 ||
            Math.abs(center.y - closest.y) > 7.85) continue;
        projectile.hitPlayers ||= new Set();
        projectile.hitPlayers.add(target.id);
        if (target.invulnerableUntil <= now) {
          const damage = 999;
          const split = applyIncomingDamage(target, damage);
          io.to(projectile.ownerId).emit("damageDealt", {
            targetId: target.id, damage, shieldDamage: split.shieldDamage, healthDamage: split.healthDamage,
            zone: "body", x: target.x, y: target.y + 0.85, z: target.z
          });
          io.to(target.id).emit("damageTaken", { damage, zone: "body" });
          if (target.health <= 0) {
            target.health = 0; target.respawnAt = now + 5000; target.deaths = (target.deaths || 0) + 1;
            projectile.owner.health = Number(projectile.owner.maxHealth) || 100;
        clearBurnStatus(projectile.owner);
            projectile.owner.kills = (projectile.owner.kills || 0) + 1;
            if (target.mode === "Duel") resolveDuelRound(projectile.owner, target);
            broadcastGameEvent(projectile.owner, "elimination", {
              killerId: projectile.owner.id, killerName: projectile.owner.name,
              victimId: target.id, victimName: target.name, killerKills: projectile.owner.kills, zone: "body"
            });
          }
        }
      }
      projectile.x = next.x; projectile.y = next.y; projectile.z = next.z;
      broadcastGameEvent(projectile.owner, "grenadeProjectileUpdate", {
        id: projectile.id, x: projectile.x, y: projectile.y, z: projectile.z,
        vx: projectile.vx, vy: projectile.vy, vz: projectile.vz
      });
      continue;
    }

    const from = { x: projectile.x, y: projectile.y, z: projectile.z };
    const nextX = projectile.x + projectile.vx * dt;
    const nextY = projectile.type === "rocket" ? projectile.y + projectile.vy * dt : projectile.y + projectile.vy * dt - 0.5 * SMOKE_PROJECTILE_GRAVITY * dt * dt;
    const nextZ = projectile.z + projectile.vz * dt;
    const delta = { x: nextX - from.x, y: nextY - from.y, z: nextZ - from.z };
    const distance = Math.hypot(delta.x, delta.y, delta.z);
    let impact = null;

    if (distance > 1e-5) {
      const direction = { x: delta.x / distance, y: delta.y / distance, z: delta.z / distance };
      let nearestHit = null;
      const wallDistance = rayHitsObstacle(from, direction, distance, projectile.owner);
      if (wallDistance !== null) nearestHit = { distance: wallDistance };

      // 外周の壁はクライアント側で生成されるため、マップ境界もここで衝突判定する。
      const bounds = getMapForPlayer(projectile.owner).world || WORLD;
      const boundaryPlanes = [
        { axis: "x", plane: bounds.minX - 1.5, outward: -1 },
        { axis: "x", plane: bounds.maxX + 1.5, outward: 1 },
        { axis: "z", plane: bounds.minZ - 1.5, outward: -1 },
        { axis: "z", plane: bounds.maxZ + 1.5, outward: 1 }
      ];
      for (const boundary of boundaryPlanes) {
        const before = from[boundary.axis];
        const after = boundary.axis === "x" ? nextX : nextZ;
        const crosses = boundary.outward < 0
          ? before >= boundary.plane && after <= boundary.plane
          : before <= boundary.plane && after >= boundary.plane;
        if (!crosses || Math.abs(after - before) < 1e-8) continue;
        const fraction = (boundary.plane - before) / (after - before);
        if (fraction < 0 || fraction > 1) continue;
        const yAtBoundary = from.y + delta.y * fraction;
        if (yAtBoundary < 0 || yAtBoundary > 3) continue;
        const boundaryDistance = fraction * distance;
        if (!nearestHit || boundaryDistance < nearestHit.distance) {
          nearestHit = { distance: boundaryDistance };
        }
      }

      for (const target of players.values()) {
        if (projectile.type === "grapple" || target.id === projectile.ownerId || target.health <= 0 || target.finished ||
            !isSameGame(projectile.owner, target)) continue;
        const hit = rayHitsPlayer(from, direction, target, projectile.type === "rocket" ? 0.8 : undefined);
        if (hit && hit.t >= 0 && hit.t <= distance && (!nearestHit || hit.t < nearestHit.distance)) {
          nearestHit = { distance: hit.t };
        }
      }

      const groundY = getGroundHeight(nextX, nextZ, projectile.y, projectile.owner);
      let groundHitDistance = Infinity;
      if (projectile.vy <= 0 && nextY <= groundY + 0.12 && projectile.y >= groundY - 0.05) {
        const ySpan = projectile.y - nextY;
        const fraction = ySpan > 1e-5
          ? clamp((projectile.y - (groundY + 0.12)) / ySpan, 0, 1)
          : 0;
        groundHitDistance = fraction * distance;
      }

      if (nearestHit && nearestHit.distance <= groundHitDistance) {
        const t = clamp(nearestHit.distance, 0, distance);
        impact = {
          x: from.x + direction.x * t,
          y: from.y + direction.y * t,
          z: from.z + direction.z * t
        };
      } else if (groundHitDistance < Infinity) {
        const t = clamp(groundHitDistance, 0, distance);
        impact = { x: from.x + direction.x * t, y: groundY, z: from.z + direction.z * t };
      }
    }

    if (impact) {
      if (projectile.type === "grapple") {
        applyGrapplePull(projectile, impact);
        grenadeProjectiles.delete(projectile.id);
        broadcastGameEvent(projectile.owner, "grenadeProjectileRemove", { id: projectile.id });
      } else if (projectile.type === "shockwave") {
        projectile.pendingShockwaveAt = now + 300;
        projectile.pendingShockwavePosition = impact;
        broadcastGameEvent(projectile.owner, "grenadeProjectileRemove", { id: projectile.id });
      } else if (projectile.type === "rocket") {
        explodeRocket(projectile, impact, now);
        grenadeProjectiles.delete(projectile.id);
        broadcastGameEvent(projectile.owner, "grenadeProjectileRemove", { id: projectile.id });
      } else {
        explodeGrenade(projectile, impact, now);
        grenadeProjectiles.delete(projectile.id);
        broadcastGameEvent(projectile.owner, "grenadeProjectileRemove", { id: projectile.id });
      }
      continue;
    }

    projectile.x = nextX;
    projectile.y = nextY;
    projectile.z = nextZ;
    if (projectile.type !== "grapple" && projectile.type !== "rocket") projectile.vy -= SMOKE_PROJECTILE_GRAVITY * dt;
    broadcastGameEvent(projectile.owner, "grenadeProjectileUpdate", {
      id: projectile.id, x: projectile.x, y: projectile.y, z: projectile.z
    });
  }

  for (const cloud of [...smokeClouds.values()]) {
    if (now < cloud.expiresAt) continue;
    smokeClouds.delete(cloud.id);
    broadcastGameEvent(cloud.owner, "smokeCloudRemove", { id: cloud.id });
  }
}

function broadcastModeEvent(mode, eventName, payload) {
  for (const client of io.sockets.sockets.values()) {
    const player = players.get(client.id);
    if (player && (player.mode || MAP_MODE) === mode) client.emit(eventName, payload);
  }
}

function broadcastState() {
  for (const client of io.sockets.sockets.values()) {
    const player = players.get(client.id);
    if (player) client.emit("state", gamePlayersFor(player).map((entry) => publicPlayer(entry)));
  }
}

function syncBuildBots(matchId) {
  const humans = Array.from(players.values()).filter(p =>
    !p.isBot && p.mode === BUILD_MODE && p.matchId === matchId
  );
  const bots = Array.from(players.values()).filter(p =>
    p.isBot && p.mode === BUILD_MODE && p.matchId === matchId
  );
  // 乱闘モードと同様、通常プレイヤーが1人だけの間はBOTを1体配置する。
  // 同じビルドマッチに通常プレイヤーが複数参加したらBOTを撤去する。
  if (humans.length !== 1) {
    for (const bot of bots) players.delete(bot.id);
    return;
  }
  if (bots.length) return;
  const owner = humans[0];
  const spawnCandidates = [[-8, 0, -8], [8, 0, -8], [0, 0, -12], [-12, 0, 0], [12, 0, 0]];
  const spawn = spawnCandidates.find(point =>
    !collides(point[0], point[2], point[1], PLAYER_HEIGHT, {
      mode: BUILD_MODE, buildMap: owner.buildMap, matchId: owner.matchId
    })
  );
  if (!spawn) return;
  const now = Date.now();
  const id = "bot:build:" + matchId;
  const usedNames = new Set(humans.map(player => String(player.name || "").toLowerCase()));
  const availableNames = AREA_BOT_NAMES.filter(name => !usedNames.has(name.toLowerCase()));
  const botName = availableNames.length
    ? availableNames[Math.floor(Math.random() * availableNames.length)]
    : "BOT-" + (Math.floor(Math.random() * 900) + 100);
  const yaw = Math.atan2(-(owner.x - spawn[0]), -(owner.z - spawn[2]));
  players.set(id, {
    id, name: botName,
    mode: BUILD_MODE, team: null, matchId: owner.matchId, buildMap: owner.buildMap,
    isBot: true, finished: false, botSpawnPoint: [...spawn], botSpawnIndex: 0,
    botThinkAt: 0, botOffset: Math.random() * 1000, botTactic: "push",
    botTacticUntil: 0, botStrafeSign: Math.random() < 0.5 ? -1 : 1,
    botAggression: 0.8, botBuildCount: 0, botNextBuildAt: 0,
    x: spawn[0], y: spawn[1], z: spawn[2], yaw, pitch: 0,
    health: 100, maxHealth: 100, shield: 0, kills: 0, deaths: 0,
    ultimateCharge: 0, ultimateType: "skyfall", ultimateActiveUntil: 0,
    ultimateAnchor: null, skyfallImpactPending: false, skyfallImpactId: null,
    weapon: "rifle", weaponSlots: ["rifle", "shotgun"], activeWeaponSlot: 0,
    ammo: WEAPONS.rifle.magazineSize,
    weaponAmmo: [WEAPONS.rifle.magazineSize, WEAPONS.shotgun.magazineSize],
    reloadingUntil: 0, lastFire: 0,
    velocityY: 0, grounded: true, lastGroundedAt: now, jumpQueuedUntil: 0,
    input: { forward: 0, strafe: 0, crouch: false }, crouched: false,
    respawnAt: 0, invulnerableUntil: now + 1200,
    damageHitstopUntil: 0, damageSlowUntil: 0, fireFloorDamageAt: 0
  });
}

function removeBuildBotsForMatch(matchId) {
  if (!matchId) return;
  for (const [id, player] of players) {
    if (player.isBot && player.mode === BUILD_MODE && player.matchId === matchId) players.delete(id);
  }
}

function createWanderBotForPlayer(owner) {
  if (!owner || owner.mode !== "Wander" || owner.wanderBotsEnabled !== true) return;
  const id = "bot:wander:" + owner.matchId;
  if (players.has(id)) return;
  const map = owner.wanderMap || activeMap;
  const points = Array.isArray(map?.spawnPoints) ? map.spawnPoints : [];
  const candidates = points.slice().sort(() => Math.random() - 0.5);
  let spawn = candidates.find(point =>
    Array.isArray(point) && point.length >= 3 &&
    Math.hypot(point[0] - owner.x, point[2] - owner.z) >= 8 &&
    !collides(point[0], point[2], Number(point[1]) || 0, PLAYER_HEIGHT, { mode: "Wander", wanderMap: map, matchId: owner.matchId })
  );
  if (!spawn) {
    const offsets = [[10,0],[-10,0],[0,10],[0,-10],[8,8],[-8,8],[8,-8],[-8,-8]];
    for (const [dx,dz] of offsets) {
      const x = owner.x + dx, z = owner.z + dz;
      const context = {mode:"Wander",wanderMap:map,matchId:owner.matchId};
      if (!collides(x,z,owner.y,PLAYER_HEIGHT,context)) {
        spawn = [x, getGroundHeight(x,z,owner.y,context), z];
        break;
      }
    }
  }
  if (!spawn) return;
  const now = Date.now();
  const usedNames = new Set([owner.name.toLowerCase()]);
  const availableNames = AREA_BOT_NAMES.filter(name => !usedNames.has(name.toLowerCase()));
  const botName = availableNames.length ? availableNames[Math.floor(Math.random()*availableNames.length)] : "BOT-1";
  players.set(id, {
    id, name: botName, mode: "Wander", team: null, matchId: owner.matchId,
    wanderMap: map, isBot: true, finished: false, botSpawnIndex: Math.max(1, points.indexOf(spawn)),
    x: spawn[0], y: Number(spawn[1]) || 0, z: spawn[2],
    yaw: Math.atan2(-(owner.x-spawn[0]), -(owner.z-spawn[2])), pitch: 0,
    health: 100, maxHealth: 100, shield: 0, kills: 0, deaths: 0,
    ultimateCharge: 0, ultimateType: "skyfall", ultimateActiveUntil: 0,
    ultimateAnchor: null, skyfallImpactPending: false, skyfallImpactId: null,
    weapon: "rifle", weaponSlots: ["rifle","marksman"], activeWeaponSlot: 0,
    ammo: WEAPONS.rifle.magazineSize, weaponAmmo: [WEAPONS.rifle.magazineSize,WEAPONS.marksman.magazineSize],
    reloadingUntil: 0, lastFire: 0, velocityY: 0, grounded: true, lastGroundedAt: now,
    jumpQueuedUntil: 0, input: {forward:0,strafe:0,crouch:false,jumpHeld:false},
    crouched: false, flying: false, slidingUntil: 0, slideDirectionX: 0, slideDirectionZ: 0,
    respawnAt: 0, invulnerableUntil: now + 1200, damageHitstopUntil: 0, damageSlowUntil: 0,
    botThinkAt: 0, botOffset: Math.random()*1000, botTactic: "push",
    botTacticUntil: 0, botStrafeSign: Math.random()<0.5?-1:1, botAggression: 0.8
  });
}

function syncBots() {
  const humanPlayers = Array.from(players.values()).filter((p) => !p.isBot && (p.mode || MAP_MODE) === MAP_MODE);
  const bots = Array.from(players.values()).filter((p) => p.isBot && (p.mode || MAP_MODE) === MAP_MODE);

  if (humanPlayers.length !== 1) {
    for (const bot of bots) players.delete(bot.id);
    return;
  }
  if (bots.length) return;

  const spawn = pickSpawn();
  const id = "bot:arena";
  const usedNames = new Set(humanPlayers.map((player) => player.name.toLowerCase()));
  const availableNames = AREA_BOT_NAMES.filter((name) => !usedNames.has(name.toLowerCase()));
  const botName = availableNames.length
    ? availableNames[Math.floor(Math.random() * availableNames.length)]
    : "BOT-1";
  players.set(id, {
    id,
    name: botName,
    isBot: true,
    x: spawn[0], y: 0, z: spawn[2],
    yaw: 0, pitch: 0,
    health: 100, maxHealth: 100, kills: 0, deaths: 0,
    ultimateCharge: 0, ultimateType: "skyfall", ultimateActiveUntil: 0,
    ultimateAnchor: null, skyfallImpactPending: false, skyfallImpactId: null,
    weapon: "rifle",
    weaponSlots: ["rifle", "marksman"],
    activeWeaponSlot: 0,
    ammo: WEAPONS.rifle.magazineSize,
    reloadingUntil: 0,
    lastFire: 0,
    velocityY: 0,
    grounded: true,
    lastGroundedAt: Date.now(),
    jumpQueuedUntil: 0,
    input: { forward: 0, strafe: 0, crouch: false, jumpHeld: false },
    crouched: false,
    flying: false,
    slidingUntil: 0,
    slideDirectionX: 0,
    slideDirectionZ: 0,
    respawnAt: 0,
    invulnerableUntil: 0,
    damageHitstopUntil: 0,
    damageSlowUntil: 0,
    botThinkAt: 0
  });
}

function tryBuildBotCover(bot, target, now) {
  const map = bot.buildMap;
  if (!map || (map.buildStructures || []).length >= 512 ||
      (bot.botBuildCount || 0) >= 12 || now < (bot.botNextBuildAt || 0)) return false;
  const dx = target.x - bot.x, dz = target.z - bot.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 5 || distance > 25) return false;

  // 敵へ直進するだけでなく、ランプと上段の床を連結して階段状に積み上げる。
  // BOTが上段へ登れたら、さらに次の高さへ建築して敵の側面・上方を取る。
  const buildLevel = Math.max(0, Math.min(36, Math.round((bot.y || 0) / 4) * 4));
  if ((bot.botBuildCount || 0) < 12 && distance >= 7 && distance <= 22 &&
      now >= (bot.botNextRampAt || 0) && buildLevel <= 36) {
    const stepX = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) * 4 : 0;
    const stepZ = Math.abs(dz) >= Math.abs(dx) ? Math.sign(dz) * 4 : 0;
    const x = Math.round((bot.x - 2) / 4) * 4 + 2 + stepX;
    const z = Math.round((bot.z - 2) / 4) * 4 + 2 + stepZ;
    const direction = stepZ < 0 ? "north" : stepZ > 0 ? "south" : stepX > 0 ? "east" : "west";
    const rotation = direction === "south" ? 0 : direction === "west" ? Math.PI / 2 :
      direction === "north" ? Math.PI : -Math.PI / 2;
    const insideBounds = x - 2 >= map.world.minX && x + 2 <= map.world.maxX &&
      z - 2 >= map.world.minZ && z + 2 <= map.world.maxZ;
    const occupied = (map.buildStructures || []).some(item =>
      Math.abs(item.x - x) < 3.8 && Math.abs(item.z - z) < 3.8 &&
      Math.abs((Number(item.y) || 0) - buildLevel) < 0.12
    );
    const rampId = "build-" + bot.id + "-ramp-" + now.toString(36);
    const floorId = rampId + "-top";
    const ramp = { id: rampId, type: "ramp", x, y: buildLevel, z, rotation, direction,
      w: 4, d: 4, h: 4, hp: 50 };
    const grounded = new Set((map.buildStructures || [])
      .filter(item => (Number(item.y) || 0) <= 0.02).map(item => item.id));
    let supportChanged = true;
    while (supportChanged) {
      supportChanged = false;
      for (const item of map.buildStructures || []) {
        if (grounded.has(item.id)) continue;
        if ((map.buildStructures || []).some(other =>
          grounded.has(other.id) && buildStructuresTouch(item, other))) {
          grounded.add(item.id);
          supportChanged = true;
        }
      }
    }
    const supported = buildLevel <= 0.02 || (map.buildStructures || []).some(item =>
      grounded.has(item.id) && buildStructuresTouch(ramp, item));
    if (insideBounds && !occupied && supported &&
        Math.hypot(x - bot.x, z - bot.z) <= 6.05 && buildLevel + 4 <= 40) {
      const floor = { id: floorId, type: "floor", x, y: buildLevel + 4, z,
        rotation: 0, w: 4, d: 4, h: 0.08, hp: 50 };
      map.buildStructures.push(ramp, floor);
      map.ramps.push({ x, y: buildLevel, z, w: 4, d: 4, h: 4, direction, buildStructureId: rampId });
      map.floorTiles.push({ id: floorId, buildStructureId: floorId, type: "build",
        x, y: buildLevel + 4, z, w: 4, d: 4 });
      map.elevatedPlatforms.push({ x, z, w: 4, d: 4, h: buildLevel + 4, buildStructureId: floorId });
      bot.botBuildCount = (bot.botBuildCount || 0) + 2;
      bot.botNextRampAt = now + 6500 + Math.random() * 4500;
      bot.botNextBuildAt = now + 1800;
      bot.jumpQueuedUntil = Math.max(bot.jumpQueuedUntil || 0, now + 180);
      broadcastGameEvent(bot, "buildStructureUpdate", getWorldPayloadForMap(map, BUILD_MODE));
      return true;
    }
    bot.botNextRampAt = now + 3000;
  }

  const targetToBotYaw = Math.atan2(-(bot.x - target.x), -(bot.z - target.z));
  const yawError = Math.atan2(Math.sin(targetToBotYaw - target.yaw), Math.cos(targetToBotYaw - target.yaw));
  if (Math.abs(yawError) > 0.28) return false;
  const targetOrigin = {
    x: target.x, y: target.y + (target.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) - 0.15, z: target.z
  };
  const targetWall = rayHitsObstacle(targetOrigin, directionFromAngles(target.yaw, target.pitch || 0), distance, target);
  if (targetWall !== null && targetWall < distance - 0.8) return false;

  let x, z, rotation;
  if (Math.abs(dx) > Math.abs(dz)) {
    rotation = Math.PI / 2;
    x = dx > 0 ? Math.ceil((bot.x + 1.15) / 4) * 4 : Math.floor((bot.x - 1.15) / 4) * 4;
    z = Math.floor(bot.z / 4) * 4 + 2;
  } else {
    rotation = 0;
    x = Math.floor(bot.x / 4) * 4 + 2;
    z = dz > 0 ? Math.ceil((bot.z + 1.15) / 4) * 4 : Math.floor((bot.z - 1.15) / 4) * 4;
  }
  const sideways = Math.abs(Math.sin(rotation)) > 0.5;
  const wallW = sideways ? 0.16 : 4, wallD = sideways ? 4 : 0.16;
  const bounds = map.world;
  if (x - wallW / 2 < bounds.minX || x + wallW / 2 > bounds.maxX ||
      z - wallD / 2 < bounds.minZ || z + wallD / 2 > bounds.maxZ ||
      Math.hypot(x - bot.x, z - bot.z) > 6.05) {
    bot.botNextBuildAt = now + 650;
    return false;
  }
  const towardX = dx / distance, towardZ = dz / distance;
  const wallProgress = (x - bot.x) * towardX + (z - bot.z) * towardZ;
  const targetPastWall = (target.x - x) * towardX + (target.z - z) * towardZ;
  if (wallProgress < 0.8 || targetPastWall < 0.8) {
    bot.botNextBuildAt = now + 900;
    return false;
  }
  const overlapsWall = (map.buildStructures || []).some(item => {
    if (item.type !== "wall" || Math.abs(Number(item.y) || 0) > 0.12) return false;
    const overlapX = Math.min(x + wallW / 2, item.x + item.w / 2) - Math.max(x - wallW / 2, item.x - item.w / 2);
    const overlapZ = Math.min(z + wallD / 2, item.z + item.d / 2) - Math.max(z - wallD / 2, item.z - item.d / 2);
    return overlapX > 0.12 && overlapZ > 0.12;
  });
  if (overlapsWall) {
    bot.botNextBuildAt = now + 1400;
    return false;
  }
  const id = "build-" + bot.id + "-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  map.buildStructures.push({ id, type: "wall", x, y: 0, z, rotation, w: wallW, d: wallD, h: 4, hp: 50 });
  map.obstacles.push({ x, y: 0, z, w: wallW, d: wallD, h: 4, ceiling: false, buildStructureId: id });
  bot.botBuildCount = (bot.botBuildCount || 0) + 1;
  bot.botNextBuildAt = now + 1700 + Math.random() * 900;
  broadcastGameEvent(bot, "buildStructureUpdate", getWorldPayloadForMap(map, BUILD_MODE));
  return true;
}

function updateBuildBot(bot, targets, now) {
  const target = targets.slice().sort((a, b) =>
    Math.hypot(a.x - bot.x, a.z - bot.z) - Math.hypot(b.x - bot.x, b.z - bot.z)
  )[0];
  if (!target) {
    if (!bot.botWanderTurnAt || now >= bot.botWanderTurnAt) {
      bot.yaw += (Math.random() - 0.5) * 1.1;
      bot.botWanderTurnAt = now + 900 + Math.random() * 1200;
    }
    bot.pitch = 0;
    bot.input.forward = 0.25;
    bot.input.strafe = Math.sin(now / 850) * 0.3;
    bot.input.crouch = false;
    return;
  }

  const dx = target.x - bot.x, dz = target.z - bot.z;
  const distance = Math.max(0.001, Math.hypot(dx, dz));
  const targetYaw = Math.atan2(-dx, -dz);
  const yawDelta = Math.atan2(Math.sin(targetYaw - bot.yaw), Math.cos(targetYaw - bot.yaw));
  bot.yaw += clamp(yawDelta, -0.55, 0.55);
  const targetY = target.y + (target.crouched ? 0.75 : 1.0);
  bot.pitch = clamp(Math.atan2(targetY - (bot.y + PLAYER_HEIGHT - 0.15), distance), -0.9, 0.9);

  // 敵がこちらを狙っていて射線が通る場合、壁を建てて弾を受け止める。
  tryBuildBotCover(bot, target, now);

  const origin = { x: bot.x, y: bot.y + PLAYER_HEIGHT - 0.15, z: bot.z };
  const direction = directionFromAngles(bot.yaw, bot.pitch);
  const wallDistance = rayHitsObstacle(origin, direction, Math.min(distance, WEAPONS[bot.weapon].range), bot);
  const visible = distance <= WEAPONS[bot.weapon].range &&
    (wallDistance === null || wallDistance >= distance - 0.7);
  const aligned = Math.abs(yawDelta) < 0.16;
  if (!visible) {
    const side = bot.botStrafeSign || 1;
    bot.input.forward = distance > 4 ? 0.62 : 0.12;
    bot.input.strafe = side * 0.82;
    if (wallDistance !== null && wallDistance < 2.2) bot.yaw += side * 0.08;
  } else if (distance > 5.5) {
    bot.input.forward = 0.88;
    bot.input.strafe = (bot.botStrafeSign || 1) * 0.22;
  } else {
    bot.input.forward = distance > 3.2 ? 0.22 : -0.12;
    bot.input.strafe = (bot.botStrafeSign || 1) * 0.55;
  }
  bot.input.crouch = false;

  if (visible && aligned && now - bot.lastFire >= WEAPONS[bot.weapon].fireInterval && Math.random() < 0.9) {
    const oldYaw = bot.yaw, oldPitch = bot.pitch;
    // 左右・上下の意図的な照準誤差を従来の1/3にする。
    bot.yaw = targetYaw + (Math.random() < 0.5 ? -1 : 1) * (0.012 + Math.random() * 0.018);
    bot.pitch = clamp(Math.atan2(targetY - (bot.y + PLAYER_HEIGHT - 0.15), distance) + (Math.random() - 0.5) * 0.05, -0.9, 0.9);
    fireShot(bot);
    bot.yaw = oldYaw;
    bot.pitch = oldPitch;
  }
}

function updateBot(p, now) {
  if (!p.isBot || p.health <= 0 || p.finished || now < p.botThinkAt) return;
  // 凍結中のBOTは移動だけでなく、照準・射撃AIも停止する。
  if (p.frozenUntil > now) {
    p.input.forward = 0;
    p.input.strafe = 0;
    p.input.jump = false;
    return;
  }
  const botSkyfallActive = Boolean(p.skyfallImpactId && p.ultimateActiveUntil > now);
  if (p.ultimateActiveUntil > now && !botSkyfallActive) return;
  p.botThinkAt = now + (botSkyfallActive ? 80 : 100 + Math.random() * 80);
  if (!botSkyfallActive && (!p.botTacticUntil || now >= p.botTacticUntil)) {
    const tactics = ["push", "flank", "circle", "cautious", "aggressive", "reposition"];
    p.botTactic = tactics[Math.floor(Math.random() * tactics.length)];
    p.botStrafeSign = Math.random() < 0.5 ? -1 : 1;
    p.botAggression = 0.55 + Math.random() * 0.9;
    p.botTacticUntil = now + 900 + Math.random() * 2300;
  }

  const isAreaBot=p.mode===AREA_MODE;
  const isPayloadBot=p.mode===PAYLOAD_MODE;
  const isObjectiveBot=isAreaBot||isPayloadBot;
  const botMap = getMapForPlayer(p);
  const isInfernoCrossing = botMap.id === "inferno-crossing" || botMap.name === "Inferno Crossing";
  // Inferno Crossingでは、炎床の高さにいるBOTは接地したタイミングでジャンプを予約する。
  // 炎床の上を歩き続けず、ジャンプを繰り返して床への接触を減らす。
  if (isInfernoCrossing && p.y < 0.55 && p.grounded &&
      (botMap.floorTiles || []).some((tile) => tile.type === "fire" &&
        Math.abs(p.x - tile.x) <= tile.w / 2 &&
        Math.abs(p.z - tile.z) <= tile.d / 2)) {
    p.jumpQueuedUntil = Math.max(p.jumpQueuedUntil || 0, now + 120);
  }
  const match=isAreaBot?areaMatches.get(p.matchId):isPayloadBot?payloadMatches.get(p.matchId):null;
  const targets = Array.from(players.values()).filter((other) =>
    other.id !== p.id &&
    other.health > 0 &&
    isSameGame(p, other) &&
    (isObjectiveBot ? other.team !== p.team : !other.isBot)
  );

  if (p.mode === BUILD_MODE) {
    updateBuildBot(p, targets, now);
    return;
  }

  // BOTも浮上中に敵の位置を追い、発動1秒後から狙いに合わせて任意降下する。
  if (botSkyfallActive) {
    const elapsed = now - (p.skyfallStartedAt || now);
    const skyfallTarget = targets.slice().sort((a, b) =>
      Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)
    )[0];
    let targetDistance = Infinity;
    if (skyfallTarget) {
      const dx = skyfallTarget.x - p.x;
      const dz = skyfallTarget.z - p.z;
      targetDistance = Math.hypot(dx, dz);
      const targetYaw = Math.atan2(-dx, -dz);
      const yawDelta = Math.atan2(Math.sin(targetYaw - p.yaw), Math.cos(targetYaw - p.yaw));
      p.yaw += clamp(yawDelta, -0.55, 0.55);
      p.pitch = clamp(Math.atan2((skyfallTarget.y || 0) + 1 - p.y, Math.max(0.001, targetDistance)), -0.8, 0.8);
      p.input.forward = targetDistance > 4 ? 1 : 0;
      p.input.strafe = Math.abs(yawDelta) > 0.4 ? Math.sign(yawDelta) * 0.25 : 0;
    } else {
      p.input.forward = 0;
      p.input.strafe = 0;
      p.pitch = 0;
    }
    if (elapsed >= 1000 &&
        ((skyfallTarget && targetDistance <= SKYFALL_IMPACT_RADIUS * 0.9) || elapsed >= 2200)) {
      p.ultimateActiveUntil = now;
      p.input.forward = 0;
      p.input.strafe = 0;
    }
    return;
  }

  // チャージが完了し、無敵時間外の敵が近距離にいる場合はBOTも天墜を使う。
  // 天墜は自分の足元に落ちるため、敵が半径内に入るまで温存する。
  if ((p.ultimateCharge || 0) >= 100 && p.grounded && p.invulnerableUntil <= now) {
    const closeEnemy = targets.find((other) =>
      other.invulnerableUntil <= now &&
      Math.hypot(other.x - p.x, other.z - p.z) <= SKYFALL_IMPACT_RADIUS * 0.68
    );
    if (closeEnemy && activateSkyfall(p, now)) {
      p.ultimateCharge = 0;
      return;
    }
  }

  // 敵の天墜予告範囲に入ったBOTは、まず発動者を撃ち落とそうとし、
  // 同時に範囲外へ移動する。遮蔽物があれば回り込む。
  const incomingSkyfall = targets
    .filter((other) => other.ultimateActiveUntil > now && other.skyfallImpactId)
    .map((other) => ({
      player: other,
      anchor: other.ultimateAnchor || { x: other.x, z: other.z },
      distance: Math.hypot(p.x - (other.ultimateAnchor?.x ?? other.x), p.z - (other.ultimateAnchor?.z ?? other.z))
    }))
    .filter((threat) => threat.distance <= SKYFALL_IMPACT_RADIUS + 1.25)
    .sort((a, b) => a.distance - b.distance)[0];

  if (incomingSkyfall) {
    const attacker = incomingSkyfall.player;
    const shotDx = attacker.x - p.x;
    const shotDz = attacker.z - p.z;
    const shotDistance = Math.hypot(shotDx, shotDz);
    const shotYaw = Math.atan2(-shotDx, -shotDz);
    const shotY = attacker.y + (attacker.crouched ? 0.75 : 1.0);
    const shotOrigin = { x: p.x, y: p.y + PLAYER_HEIGHT - 0.15, z: p.z };
    const shotPitch = clamp(Math.atan2(shotY - shotOrigin.y, Math.max(0.001, shotDistance)), -1.25, 1.25);
    const shotDirection = directionFromAngles(shotYaw, shotPitch);
    const shotRange = Math.hypot(shotDx, shotY - shotOrigin.y, shotDz);
    const shotWall = rayHitsObstacle(shotOrigin, shotDirection, Math.min(shotRange, WEAPONS[p.weapon].range), p);
    if (shotRange <= WEAPONS[p.weapon].range &&
        (shotWall === null || shotWall >= shotRange - 0.7) &&
        now - p.lastFire >= WEAPONS[p.weapon].fireInterval &&
        Math.random() < 0.85) {
      const oldYaw = p.yaw, oldPitch = p.pitch;
      p.yaw = shotYaw;
      p.pitch = shotPitch;
      fireShot(p);
      p.yaw = oldYaw;
      p.pitch = oldPitch;
    }

    const awayX = p.x - incomingSkyfall.anchor.x;
    const awayZ = p.z - incomingSkyfall.anchor.z;
    const awayLength = Math.hypot(awayX, awayZ) || 1;
    const escapeYaw = Math.atan2(-(awayX / awayLength), -(awayZ / awayLength));
    const escapeDelta = Math.atan2(Math.sin(escapeYaw - p.yaw), Math.cos(escapeYaw - p.yaw));
    p.yaw += clamp(escapeDelta, -0.3, 0.3);
    p.pitch = 0;
    const escapeOrigin = { x: p.x, y: p.y + PLAYER_HEIGHT - 0.15, z: p.z };
    const escapeWall = rayHitsObstacle(escapeOrigin, directionFromAngles(p.yaw, 0), 3.8, p);
    if (escapeWall !== null && escapeWall < 2.4) {
      const side = Math.sin(now / 500 + (p.botOffset || 0)) >= 0 ? 1 : -1;
      p.yaw += side * 0.62;
      p.input.forward = 0.75;
      p.input.strafe = side * 0.8;
    } else {
      p.input.forward = 1;
      p.input.strafe = 0.12;
    }
    p.input.crouch = false;
    if (p.grounded) p.jumpQueuedUntil = Math.max(p.jumpQueuedUntil || 0, now + 100);
    return;
  }

  // 視認できる敵がいる場合だけ戦闘を優先し、遮蔽物越しの敵には釣られず制圧へ向かう。
  const visibleTargets = isObjectiveBot ? targets.filter((other) => {
    const dx = other.x - p.x;
    const dz = other.z - p.z;
    const distance = Math.max(0.001, Math.hypot(dx, dz));
    if (distance > WEAPONS[p.weapon].range) return false;
    const targetYaw = Math.atan2(-dx, -dz);
    const targetY = other.y + (other.crouched ? 0.75 : 1.0);
    const targetPitch = clamp(Math.atan2(targetY - (p.y + PLAYER_HEIGHT - 0.15), distance), -1.0, 1.0);
    const origin = { x: p.x, y: p.y + PLAYER_HEIGHT - 0.15, z: p.z };
    const dir = directionFromAngles(targetYaw, targetPitch);
    const wallDistance = rayHitsObstacle(origin, dir, Math.min(distance, WEAPONS[p.weapon].range), p);
    return wallDistance === null || wallDistance >= distance - 0.7;
  }) : [];

  // ペイロードBOTは敵がカートより近ければ交戦し、それ以外はカートへ向かう。
  const cart=isPayloadBot?getPayloadPointAtDistance(match?.progress||0):null;
  if (isPayloadBot && !p.botHasLeftRespawnArea) {
    const spawnZone = getPayloadRespawnZoneAt(botMap, p.x, p.z);
    if (spawnZone) {
      const dx = spawnZone.exitX - p.x;
      const dz = spawnZone.exitZ - p.z;
      const targetYaw = Math.atan2(-dx, -dz);
      const yawDelta = Math.atan2(Math.sin(targetYaw - p.yaw), Math.cos(targetYaw - p.yaw));
      p.yaw += clamp(yawDelta, -0.22, 0.22);
      p.pitch = 0;
      p.input.forward = 1;
      p.input.strafe = 0;
      p.input.crouch = false;
      return;
    }
    p.botHasLeftRespawnArea = true;
  }
  const zone=isAreaBot?areaMap.areaZone:isPayloadBot?{x:cart.x,z:cart.z,radius:9}:null;
  const livingTeamMembersInZone = zone ? Array.from(players.values()).filter((other) =>
    isSameGame(p, other) && other.health > 0 && !other.disconnectedAt && other.team === p.team &&
    Math.hypot(other.x - zone.x, other.z - zone.z) <= zone.radius
  ).length : 0;
  const objectiveHoldRadius = zone ? (isPayloadBot && p.role === "defense" ? zone.radius * 0.32 : zone.radius * 0.9) : 0;
  const botInsideZone = Boolean(zone && Math.hypot(p.x - zone.x, p.z - zone.z) <= objectiveHoldRadius);
  const enemyOwnsOrUnclaimedZone=isAreaBot&&Boolean(zone&&(!match?.ownerTeam||match.ownerTeam!==p.team));
  const enemyIsTakingZone=isAreaBot&&Boolean(match?.captureTeam&&match.captureTeam!==p.team);
  // 中立/敵側のエリアでは味方の人数にかかわらずBOTも制圧に参加する。
  // 自チーム所有中は、エリア内の味方が2人未満なら守備要員として向かう。
  const needsObjectiveSupport=isPayloadBot?(p.role === "defense" ? true : livingTeamMembersInZone<2):livingTeamMembersInZone<2||enemyOwnsOrUnclaimedZone||enemyIsTakingZone;
  const visibleCloseEnemy = visibleTargets.some((target) => Math.hypot(target.x - p.x, target.z - p.z) <= 8);
  const nearestEnemyDistance = targets.length ? Math.min(...targets.map((target) => Math.hypot(target.x - p.x, target.z - p.z))) : Infinity;
  const cartDistance = isPayloadBot && cart ? Math.hypot(cart.x - p.x, cart.z - p.z) : Infinity;
  const enemyCloserThanCart = isPayloadBot && nearestEnemyDistance < cartDistance;
  const moveToObjective = Boolean(zone && !botInsideZone && needsObjectiveSupport && (isPayloadBot ? !enemyCloserThanCart : (!visibleTargets.length || !visibleCloseEnemy)));
  // ペイロードBOTは交戦中もカート周辺に残り、護送・停止判定に参加する。
  const holdObjective = Boolean(zone && botInsideZone && (isPayloadBot || visibleTargets.length === 0));

  if (moveToObjective) {
    const dx = zone.x - p.x;
    const dz = zone.z - p.z;
    const distance = Math.max(0.001, Math.hypot(dx, dz));
    const targetYaw = Math.atan2(-dx, -dz);
    const yawDelta = Math.atan2(Math.sin(targetYaw - p.yaw), Math.cos(targetYaw - p.yaw));
    p.yaw += clamp(yawDelta, -0.55, 0.55);
    p.pitch = 0;
    const origin = { x: p.x, y: p.y + PLAYER_HEIGHT - 0.15, z: p.z };
    const dir = directionFromAngles(p.yaw, 0);
    const wallDistance = rayHitsObstacle(origin, dir, 3.8, p);
    if (wallDistance !== null && wallDistance < 2.4) {
      // 直進路が塞がれている場合は斜めに回り込み、壁の前で停滞しにくくする。
      const turnDirection = p.botStrafeSign || 1;
      p.yaw += turnDirection * (0.32 + Math.random() * 0.28);
      p.input.forward = 0.28 + Math.random() * 0.28;
      p.input.strafe = turnDirection * (0.55 + Math.random() * 0.3);
    } else {
      p.input.forward = p.botTactic === "cautious" ? 0.62 : p.botTactic === "aggressive" ? 1 : 0.78 + Math.random() * 0.22;
      const strafeBase = p.botTactic === "flank" ? 0.42 : p.botTactic === "circle" ? 0.28 : 0.12;
      p.input.strafe = (p.botStrafeSign || 1) * (strafeBase + Math.random() * 0.12);
    }
    p.input.crouch = false;
    return;
  }

  if (!targets.length) {
    if (isObjectiveBot && holdObjective) {
      // 敵がエリア付近にいないときは、その場に留まって制圧を継続する。
      p.input.forward = 0;
      p.input.strafe = 0;
      p.input.crouch = false;
      p.yaw += (Math.random() - 0.5) * 0.08;
      p.pitch = 0;
      return;
    }
    // 相手がいない間も巡回する。壁が近い場合は向きを変えて進路を探す。
    if (!p.botWanderTurnAt || now >= p.botWanderTurnAt) {
      p.yaw += (Math.random() - 0.5) * 1.8;
      p.botWanderTurnAt = now + 1200 + Math.random() * 2200;
    }
    p.pitch = 0;
    const wanderOrigin = { x: p.x, y: p.y + PLAYER_HEIGHT - 0.15, z: p.z };
    const wanderDir = directionFromAngles(p.yaw, 0);
    const wanderWall = rayHitsObstacle(wanderOrigin, wanderDir, 3.2, p);
    if (wanderWall !== null && wanderWall < 2.4) {
      p.yaw += (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 1.1);
      p.botWanderTurnAt = now + 500;
    }
    p.input.forward = 1;
    p.input.strafe = Math.sin(now / 1100) * 0.22;
    p.input.crouch = false;
    return;
  }

  targets.sort((a, b) => {
    if (isObjectiveBot && visibleTargets.length) {
      const aVisible = visibleTargets.includes(a);
      const bVisible = visibleTargets.includes(b);
      if (aVisible !== bVisible) return aVisible ? -1 : 1;
    }
    return Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z);
  });
  const target = targets[0];
  const dx = target.x - p.x;
  const dz = target.z - p.z;
  const distance = Math.max(0.001, Math.hypot(dx, dz));
  const targetYaw = Math.atan2(-dx, -dz);
  const yawDelta = Math.atan2(Math.sin(targetYaw - p.yaw), Math.cos(targetYaw - p.yaw));
  p.yaw += clamp(yawDelta, -0.55, 0.55);
  const targetY = target.y + (target.crouched ? 0.75 : 1.0);
  p.pitch = clamp(Math.atan2(targetY - (p.y + PLAYER_HEIGHT - 0.15), distance), -1.0, 1.0);

  // 射線が壁に遮られているときは、横移動しながら射線を探す。
  const origin = { x: p.x, y: p.y + PLAYER_HEIGHT - 0.15, z: p.z };
  const dir = directionFromAngles(p.yaw, p.pitch);
  const wallDistance = rayHitsObstacle(origin, dir, Math.min(distance, WEAPONS[p.weapon].range), p);
  const visible = distance <= WEAPONS[p.weapon].range && (wallDistance === null || wallDistance >= distance - 0.7);
  if (holdObjective) {
    // エリア確保中は敵を狙って射撃するが、追いかけてエリア外へ出ない。
    p.input.forward = 0;
    p.input.strafe = 0;
  } else if (!visible) {
    // 射線が通らない場合は、BOTごとに異なる方向へ回り込みながら索敵する。
    if (wallDistance !== null && wallDistance < 2.4) p.yaw += (p.botStrafeSign || 1) * (0.3 + Math.random() * 0.25);
    p.input.forward = 0.65 + Math.random() * 0.35;
    p.input.strafe = (p.botStrafeSign || 1) * (0.12 + Math.random() * 0.3);
  } else if (distance > 5) {
    const tactic = p.botTactic || "push";
    if (tactic === "cautious") {
      p.input.forward = 0.35 + Math.random() * 0.25;
      p.input.strafe = (p.botStrafeSign || 1) * (0.35 + Math.random() * 0.25);
    } else if (tactic === "circle" || tactic === "flank") {
      p.input.forward = tactic === "flank" ? 0.45 + Math.random() * 0.35 : 0.05 + Math.random() * 0.2;
      p.input.strafe = (p.botStrafeSign || 1) * (0.65 + Math.random() * 0.3);
    } else if (tactic === "reposition") {
      p.input.forward = Math.random() < 0.35 ? -0.25 : 0.35;
      p.input.strafe = (p.botStrafeSign || 1) * (0.45 + Math.random() * 0.35);
    } else {
      p.input.forward = 0.7 + Math.random() * 0.3;
      p.input.strafe = (p.botStrafeSign || 1) * (0.08 + Math.random() * 0.28);
    }
  } else {
    p.input.forward = p.botTactic === "aggressive" ? 0.15 : -0.15 - Math.random() * 0.25;
    p.input.strafe = (p.botStrafeSign || 1) * (0.25 + Math.random() * 0.45);
  }
  p.input.crouch = false;
  // ペイロードBOTは交戦の手数を少し増やし、目標周辺の攻防を維持する。
  const botFireChance = isPayloadBot ? 0.95 : 0.90;
  const botAimOffChance = 1;
  if (visible && Math.abs(yawDelta) < 0.085 && now - p.lastFire >= WEAPONS[p.weapon].fireInterval && Math.random() < botFireChance) {
    const originalYaw = p.yaw;
    const originalPitch = p.pitch;
    if (Math.random() < botAimOffChance) {
      const aimOffset = 0.012 + Math.random() * 0.018;
      p.yaw += (Math.random() < 0.5 ? -1 : 1) * aimOffset;
      p.pitch = clamp(p.pitch + (Math.random() - 0.5) * 0.05, -1.0, 1.0);
    }
    fireShot(p);
    p.yaw = originalYaw;
    p.pitch = originalPitch;
  }
}

function respawnBot(p, now) {
  const spawn = p.mode === BUILD_MODE && Array.isArray(p.botSpawnPoint)
    ? p.botSpawnPoint
    : pickSpawnForPlayer(p, p.botSpawnIndex || 0);
  p.x = spawn[0]; p.y = 0; p.z = spawn[2];
  if (p.mode === PAYLOAD_MODE) {
    p.botHasLeftRespawnArea = !getPayloadRespawnZoneAt(getMapForPlayer(p), p.x, p.z);
  }
  p.yaw = p.mode === PAYLOAD_MODE ? -Math.PI / 2 : p.mode === BUILD_MODE ? Math.PI : 0; p.pitch = 0;
  p.velocityY = 0; p.grounded = true; p.flying = false; p.flightMaxY = 0; p.lastFlightJumpTapAt = 0; p.lastGroundedAt = now;
  p.health = Number(p.maxHealth) || 100;
  p.ultimateActiveUntil = 0;
  p.ultimateAnchor = null;
  p.skyfallImpactPending = false;
  p.skyfallImpactId = null;
  p.ammo = WEAPONS[p.weapon].magazineSize;
  p.reloadingUntil = 0; p.lastFire = 0;
  p.input = { forward: 0, strafe: 0, crouch: false };
  p.botTacticUntil = 0;
  p.botTactic = ["push", "flank", "circle", "cautious", "aggressive"][Math.floor(Math.random() * 5)];
  p.botStrafeSign = Math.random() < 0.5 ? -1 : 1;
  p.botAggression = 0.55 + Math.random() * 0.9;
  p.crouched = false; p.respawnAt = 0;
  p.invulnerableUntil = now + (p.mode === PAYLOAD_MODE ? 2500 : 1500);
  p.damageHitstopUntil = 0; p.damageSlowUntil = 0;
  // BOTの復帰も敵側クライアントへ通知し、ミニマップに復帰地点を残す。
  broadcastGameEvent(p, "enemyRespawnMarker", {
    playerId: p.id, x: p.x, z: p.z, team: p.team || null, mode: p.mode, durationMs: 8000
  });
}

function collides(x, z, y = 0, height = PLAYER_HEIGHT, player = null) {
  const map = getMapForPlayer(player);
  const bounds = map.world;
  const mapObstacles = map.obstacles || [];
  if (x < bounds.minX + PLAYER_RADIUS || x > bounds.maxX - PLAYER_RADIUS) return true;
  if (z < bounds.minZ + PLAYER_RADIUS || z > bounds.maxZ - PLAYER_RADIUS) return true;
  if (player?.isBot && player.mode === PAYLOAD_MODE && player.botHasLeftRespawnArea &&
      getPayloadRespawnZoneAt(map, x, z)) return true;

  const bodyBottom = y;
  const bodyTop = y + height;

  // 階段は薄い斜め板として扱う。板の下に十分な高さがあれば通過できるが、
  // プレイヤーの体が板の面を横切る場合は、下からでもすり抜けない。
  for (const ramp of map.ramps || []) {
    const rampSurface = getRampHeight(ramp, x, z);
    if (rampSurface === null) continue;
    const isStandingOnTop = bodyBottom >= rampSurface - 0.45;
    const isFullyBelow = bodyTop <= rampSurface + 0.04;
    if (!isStandingOnTop && !isFullyBelow) return true;
  }

  const cartInfo = getPayloadCartCollisionInfo(player, x, z);
  if (cartInfo) {
    const { localX, localZ, deckTop, cargoTop } = cartInfo;
    // 台車のデッキは上面に着地でき、側面は通り抜けられない。
    if (bodyBottom < deckTop - 0.03 && bodyTop > 0.08 &&
        Math.abs(localX) < 2.1 + PLAYER_RADIUS &&
        Math.abs(localZ) < 1.225 + PLAYER_RADIUS) return true;
    // 荷物部分も独立した立体として扱う。
    if (bodyBottom < cargoTop - 0.03 && bodyTop > deckTop - 0.04 &&
        Math.abs(localX + 0.35) < 0.775 + PLAYER_RADIUS &&
        Math.abs(localZ) < 0.775 + PLAYER_RADIUS) return true;
  }

  return mapObstacles.some((o) => {
    // 階段の下に重ねた壁は、斜面上を歩くプレイヤーの進路を塞がない。
    // 壁の足元が階段の範囲・高さと重なり、プレイヤーの足が斜面以上なら
    // その壁の衝突だけを無効化する。階段外や斜面より下では通常どおり壁に当たる。
    if (o.buildStructureId) {
      const rampPassage = (map.ramps || []).some((ramp) => {
        const halfW = (Number(ramp.w) || 0) / 2;
        const halfD = (Number(ramp.d) || 0) / 2;
        if (halfW <= 0 || halfD <= 0) return false;
        const closestX = clamp(x, ramp.x - halfW, ramp.x + halfW);
        const closestZ = clamp(z, ramp.z - halfD, ramp.z + halfD);
        if (Math.hypot(x - closestX, z - closestZ) > PLAYER_RADIUS + 0.45) return false;
        const rampSurface = getRampHeight(ramp, closestX, closestZ);
        if (rampSurface === null) return false;
        const obstacleBottom = Number(o.y) || 0;
        const obstacleTop = obstacleBottom + (Number(o.h) || 0);
        const rampBase = Number(ramp.y) || 0;
        const rampTop = rampBase + (Number(ramp.h) || 4);
        const verticalOverlap = obstacleBottom <= rampTop + 0.15 &&
          obstacleTop >= rampBase - 0.15;
        return verticalOverlap && bodyBottom >= rampSurface - 0.45;
      });
      if (rampPassage) return false;
    }

    // リスポーン区画のゲートは、該当ロールのプレイヤーだけ通過できる。
    if (o.teamOnlyRole && player?.role === o.teamOnlyRole) return false;
    if (o.teamOnly && player?.team === o.teamOnly) return false;
    const obstacleBottom = o.ceiling ? (Number(o.y) || 0) : (Number(o.y) || 0);
    const obstacleTop = obstacleBottom + (Number(o.h) || 0);
    if (bodyTop <= obstacleBottom || bodyBottom >= obstacleTop) return false;
    return x > o.x - o.w / 2 - PLAYER_RADIUS &&
      x < o.x + o.w / 2 + PLAYER_RADIUS &&
      z > o.z - o.d / 2 - PLAYER_RADIUS &&
      z < o.z + o.d / 2 + PLAYER_RADIUS;
  });
}

function getRampHeight(ramp, x, z) {
  if (!ramp || !Number.isFinite(Number(ramp.x)) || !Number.isFinite(Number(ramp.z)) ||
      !Number.isFinite(Number(ramp.w)) || !Number.isFinite(Number(ramp.d)) ||
      !Number.isFinite(Number(ramp.h)) || Number(ramp.w) <= 0 || Number(ramp.d) <= 0 ||
      !["north", "south", "east", "west"].includes(ramp.direction)) return null;
  const halfW = ramp.w / 2, halfD = ramp.d / 2;
  if (Math.abs(x - ramp.x) > halfW || Math.abs(z - ramp.z) > halfD) return null;

  let t;
  if (ramp.direction === "north") {
    t = (z - (ramp.z - halfD)) / ramp.d;
  } else if (ramp.direction === "south") {
    t = 1 - (z - (ramp.z - halfD)) / ramp.d;
  } else if (ramp.direction === "east") {
    t = (x - (ramp.x - halfW)) / ramp.w;
  } else {
    t = 1 - (x - (ramp.x - halfW)) / ramp.w;
  }
  return (Number(ramp.y) || 0) + clamp(t, 0, 1) * ramp.h;
}

function getGroundHeight(x, z, playerY = 0, player = null) {
  let height = 0;
  const map = getMapForPlayer(player);

  for (let i = 0; i < (map.ramps || []).length; i++) {
    const rampHeight = getRampHeight(map.ramps[i], x, z);
    // スロープ上に乗っている状態を維持しつつ、下の通路からは上面へ吸い上げない。
    if (rampHeight !== null &&
        (playerY >= rampHeight - 0.45 || player?.rampContactId === i)) {
      height = Math.max(height, rampHeight);
    }
  }

  for (const platform of map.elevatedPlatforms || []) {
    if (playerY >= platform.h - 0.35 &&
        Math.abs(x - platform.x) <= platform.w / 2 - PLAYER_RADIUS &&
        Math.abs(z - platform.z) <= platform.d / 2 + PLAYER_RADIUS) {
      height = Math.max(height, platform.h);
    }
  }
  const cartInfo = getPayloadCartCollisionInfo(player, x, z);
  if (cartInfo) {
    if (playerY >= cartInfo.deckTop - 0.35 &&
        Math.abs(cartInfo.localX) <= 2.1 - PLAYER_RADIUS * 0.25 &&
        Math.abs(cartInfo.localZ) <= 1.225 - PLAYER_RADIUS * 0.25) {
      height = Math.max(height, cartInfo.deckTop);
    }
    if (playerY >= cartInfo.cargoTop - 0.35 &&
        Math.abs(cartInfo.localX + 0.35) <= 0.775 - PLAYER_RADIUS * 0.25 &&
        Math.abs(cartInfo.localZ) <= 0.775 - PLAYER_RADIUS * 0.25) {
      height = Math.max(height, cartInfo.cargoTop);
    }
  }
  // 高い位置から降下中なら、壁・障害物の上面も着地面として扱う。
  for (const obstacle of map.obstacles || []) {
    if (obstacle.ceiling) continue;
    const insideX = Math.abs(x - obstacle.x) <= obstacle.w / 2 + PLAYER_RADIUS;
    const insideZ = Math.abs(z - obstacle.z) <= obstacle.d / 2 + PLAYER_RADIUS;
    const obstacleTop = (Number(obstacle.y) || 0) + (Number(obstacle.h) || 0);
    // 通常壁・建築壁を含む全ての非天井障害物の上面を着地面として扱う。
    if (insideX && insideZ && playerY >= obstacleTop - 0.2) height = Math.max(height, obstacleTop);
  }
  return height;
}

function canStand(p) {
  return !collides(p.x, p.z, p.y, PLAYER_HEIGHT, p);
}

function updateCrouchState(p) {
  if (p.flying) {
    p.crouched = false;
    return;
  }
  if (p.input.crouch) {
    p.crouched = true;
    return;
  }

  // 頭上に障害物がある場合は立ち上がれない。
  if (canStand(p)) {
    p.crouched = false;
  }
}

function isOnFloorTile(p, type) {
  const map = getMapForPlayer(p);
  return (map.floorTiles || []).some((tile) => tile.type === type &&
    Math.abs(p.x - tile.x) <= tile.w / 2 && Math.abs(p.z - tile.z) <= tile.d / 2);
}

function addUltimateCharge(player, damage) {
  if (!player || !Number.isFinite(Number(damage)) || Number(damage) <= 0) return;
  const charmMultiplier = player.charm === "ultimate" ? 2 : 1;
  player.ultimateCharge = Math.min(100, (player.ultimateCharge || 0) + Number(damage) / 10 * charmMultiplier);
}

function resolveSkyfallImpact(attacker, now = Date.now()) {
  const id = attacker.skyfallImpactId || ("skyfall-impact-" + (++skyfallImpactSequence));
  attacker.skyfallImpactId = null;
  const x = attacker.x;
  const z = attacker.z;
  const y = getGroundHeight(x, z, attacker.y, attacker);
  broadcastGameEvent(attacker, "skyfallImpact", {
    id, x, y, z, radius: SKYFALL_IMPACT_RADIUS,
    expiresAt: now + SKYFALL_IMPACT_DURATION_MS
  });

  for (const target of players.values()) {
    if (target.id === attacker.id || target.health <= 0 || target.finished || !isSameGame(attacker, target)) continue;
    if (attacker.mode === TRAINING_MODE && !target.isBot) continue;
    if (isTeamMatchMode(attacker.mode) && target.team === attacker.team) continue;
    if (target.invulnerableUntil > now) continue;
    if (Math.hypot(target.x - x, target.z - z) > SKYFALL_IMPACT_RADIUS) continue;

    const damage = 100;
    const damageSplit = applyIncomingDamage(target, damage);

    io.to(attacker.id).emit("damageDealt", {
      targetId: target.id, damage, shieldDamage: damageSplit.shieldDamage, healthDamage: damageSplit.healthDamage, zone: "body",
      x: target.x, y: target.y + (target.crouched ? 0.75 : 1), z: target.z
    });
    io.to(target.id).emit("damageTaken", {
      damage, zone: "body"
    });

    if (target.health <= 0) {
      target.health = 0;
      target.respawnAt = now + 5000;
      target.deaths += 1;
      attacker.health = Number(attacker.maxHealth) || 100;
        clearBurnStatus(attacker);
      attacker.kills = (attacker.kills || 0) + 1;
      if (target.mode === "Duel") resolveDuelRound(attacker, target);
      broadcastGameEvent(attacker, "elimination", {
        killerId: attacker.id, killerName: attacker.name,
        victimId: target.id, victimName: target.name,
        killerKills: attacker.kills, zone: "body"
      });
    }
  }
}

function applySwordLandingShockwave(player, now = Date.now()) {
  const radius = 10, id = "sword-shockwave-" + (++smokeSequence);
  broadcastGameEvent(player, "shockwaveBurst", { id, x: player.x, y: getGroundHeight(player.x, player.z, player.y, player), z: player.z, radius, expiresAt: now + 760 });
  for (const target of players.values()) {
    if (target.id === player.id || target.health <= 0 || target.finished || !isSameGame(player, target)) continue;
    if (player.mode === TRAINING_MODE && !target.isBot) continue;
    if (isTeamMatchMode(player.mode) && target.team === player.team) continue;
    if (target.invulnerableUntil > now || Math.hypot(target.x-player.x, target.z-player.z) > radius) continue;
    const dx = target.x - player.x, dy = target.y + (target.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) * 0.5 - (player.y + 0.25), dz = target.z - player.z;
    const distance = Math.hypot(dx, dy, dz) || 0.001;
    const direction = { x: dx / distance, y: dy / distance, z: dz / distance };
    const wall = rayHitsObstacle({ x: player.x, y: player.y + 0.25, z: player.z }, direction, distance, player);
    const cartWall = player.mode === PAYLOAD_MODE ? rayHitsPayloadCart({ x: player.x, y: player.y + 0.25, z: player.z }, direction, distance, player) : null;
    const blocker = wall === null ? cartWall : cartWall === null ? wall : Math.min(wall, cartWall);
    if (blocker !== null && blocker < distance - 0.35) continue;
    const split = applyIncomingDamage(target, 50);
    addUltimateCharge(player, 50);
    io.to(player.id).emit("damageDealt", { targetId: target.id, damage: Math.round(split.totalDamage), shieldDamage: Math.round(split.shieldDamage), healthDamage: Math.round(split.healthDamage), zone: "body", x: target.x, y: target.y+1, z: target.z });
    io.to(target.id).emit("damageTaken", { damage: Math.round(split.totalDamage), zone: "body" });
    if (target.health <= 0) {
      target.health=0; target.respawnAt=now+5000; target.deaths=(target.deaths||0)+1;
      player.kills=(player.kills||0)+1; player.health=Number(player.maxHealth)||100; clearBurnStatus(player);
      if (target.mode==="Duel") resolveDuelRound(player,target);
      broadcastGameEvent(player,"elimination",{killerId:player.id,killerName:player.name,victimId:target.id,victimName:target.name,killerKills:player.kills,zone:"body"});
    }
  }
}
function swordLeapHeight(t) {
  // 開始直後から上昇し、中央で最高点を通って着地まで滑らかに下降する放物線。
  const progress = clamp(t, 0, 1);
  return 4 * 6.76 * progress * (1 - progress);
}
function startSwordLeap(player, now = Date.now()) {
  const jumpGrace = now - (Number(player?.lastJumpInputAt) || 0) <= 900;
  const swordReadyAt = Math.max(Number(player?.swordLeapReadyAt || 0), Number(player?.swordMeleeReadyAt || 0));
  if (!player || player.swordLeap || now < swordReadyAt ||
      (player.grounded && !jumpGrace) || player.invulnerableUntil > now) return false;
  const bounds = getMapForPlayer(player).world;
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const candidates = [];
  const leapDistance = 12.8 * 0.6;
  for (let d = 0.5; d <= leapDistance; d += 0.5) {
    const t = d / leapDistance;
    const x = clamp(player.x + fx * d, bounds.minX + PLAYER_RADIUS, bounds.maxX - PLAYER_RADIUS);
    const z = clamp(player.z + fz * d, bounds.minZ + PLAYER_RADIUS, bounds.maxZ - PLAYER_RADIUS);
    const flightY = player.y + swordLeapHeight(t);
    if (collides(x, z, flightY, PLAYER_HEIGHT, player)) break;
    const candidateGround = getGroundHeight(x, z, player.y + 7, player);
    candidates.push({ x, z, ground: Number.isFinite(candidateGround) ? candidateGround : player.y });
  }
  // 空中では通過できても、降下時に壁の側面や天井へめり込む地点は着地点に選ばない。
  let landing = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (!collides(candidate.x, candidate.z, candidate.ground, PLAYER_HEIGHT, player)) {
      landing = candidate;
      break;
    }
  }
  if (!landing || Math.hypot(landing.x - player.x, landing.z - player.z) < 2) return false;
  const tx = landing.x, tz = landing.z, landingY = landing.ground;
  player.swordLeapReadyAt = now + (WEAPONS.sword?.fireInterval || 650);
  player.swordMeleeReadyAt = player.swordLeapReadyAt;
  player.swordLeap = { sx: player.x, sy: player.y, sz: player.z, tx, tz, at: now, duration: 950, landingY };
  player.grounded = false; player.velocityY = 0; player.input.forward = 0; player.input.strafe = 0;
  broadcastGameEvent(player, "shot", { id: player.id, x: player.x, y: player.y + 1, z: player.z, yaw: player.yaw, pitch: player.pitch, weapon: "sword", action: "leap", hit: null, tracers: [] });
  return true;
}
function updateSwordLeap(player, now = Date.now()) {
  const leap = player.swordLeap;
  if (!leap) return false;
  const t = clamp((now - leap.at) / leap.duration, 0, 1);
  // 水平方向も最初から最後まで進め、上下方向は同じ時間軸の放物線に合わせる。
  const ease = t * t * (3 - 2 * t);
  player.x = leap.sx + (leap.tx - leap.sx) * ease;
  player.z = leap.sz + (leap.tz - leap.sz) * ease;
  // 上面に着地可能な壁では、降下中も壁上面を候補の床として検出する。
  const ground = getGroundHeight(player.x, player.z, leap.sy + 7, player);
  player.y = leap.sy + (ground - leap.sy) * ease + swordLeapHeight(t);
  player.velocityY = 0;
  player.grounded = false;
  if (t >= 1) {
    player.y = getGroundHeight(player.x, player.z, player.y + 7, player);
    // 着地点の足元に障害物がある場合は、壁内部ではなく上面に固定する。
    player.y = Math.max(player.y, Number(leap.landingY) || 0);
    player.grounded = true; player.lastGroundedAt = now; player.swordLeap = null;
    applySwordLandingShockwave(player, now);
  }
  return true;
}
function movePlayer(p, dt) {
  const now = Date.now();
  if (p.frozenUntil > now) { p.input.forward = 0; p.input.strafe = 0; p.velocityY = 0; return; }
  if (p.swordLeap) { updateSwordLeap(p, now); return; }
  if (p.frozenUntil) p.frozenUntil = 0;
  if (p.ultimateActiveUntil > now) {
    // 天墜の浮上中は上下位置を維持しつつ、ごく低速で横移動できる。
    if (p.skyfallImpactId) {
      const input = p.input || {};
      const forward = clamp(Number(input.forward) || 0, -1, 1);
      const strafe = clamp(Number(input.strafe) || 0, -1, 1);
      const length = Math.hypot(forward, strafe) || 1;
      const speed = 20;
      const dx = (-Math.sin(p.yaw) * forward + Math.cos(p.yaw) * strafe) / length * speed * dt;
      const dz = (-Math.cos(p.yaw) * forward - Math.sin(p.yaw) * strafe) / length * speed * dt;
      const nextX = p.x + dx;
      const nextZ = p.z + dz;
      if (!collides(nextX, p.z, p.y, PLAYER_HEIGHT, p)) p.x = nextX;
      if (!collides(p.x, nextZ, p.y, PLAYER_HEIGHT, p)) p.z = nextZ;
      const bounds = getMapForPlayer(p).world;
      p.x = clamp(p.x, bounds.minX + PLAYER_RADIUS, bounds.maxX - PLAYER_RADIUS);
      p.z = clamp(p.z, bounds.minZ + PLAYER_RADIUS, bounds.maxZ - PLAYER_RADIUS);
    }
    p.velocityY = 0;
    p.grounded = false;
    return;
  }
  if (p.ultimateActiveUntil && p.ultimateActiveUntil <= now) {
    p.ultimateActiveUntil = 0;
    // 3秒経過時点の真下にある床面へ即座に着地。壁の上面も着地点に含める。
    p.y = getGroundHeight(p.x, p.z, p.y, p);
    p.velocityY = 0;
    p.grounded = false;
    p.lastGroundedAt = 0;
    p.skyfallImpactPending = true;
  }
  updateCrouchState(p);

  // 現在の高さと一致するスロープだけを「乗っている」と記録する。
  // 下の通路からスロープの範囲へ入っただけでは接触扱いにしない。
  const playerMap = getMapForPlayer(p);
  let rampContact = -1;
  for (let i = 0; i < (playerMap.ramps || []).length; i++) {
    const rampHeight = getRampHeight(playerMap.ramps[i], p.x, p.z);
    if (rampHeight !== null && Math.abs(p.y - rampHeight) <= 0.28) {
      rampContact = i;
      break;
    }
  }
  if (rampContact >= 0) {
    p.rampContactId = rampContact;
  } else if (p.rampContactId !== undefined) {
    const activeRamp = playerMap.ramps?.[p.rampContactId];
    const activeHeight = activeRamp ? getRampHeight(activeRamp, p.x, p.z) : null;
    if (activeHeight === null || p.y < activeHeight - 0.35) p.rampContactId = undefined;
  }

  // 現在位置の地面高さを基準に、接地状態を毎tick正しく更新する。
  const groundBefore = getGroundHeight(p.x, p.z, p.y, p);
  const wasGrounded = p.grounded;

  if (p.y <= groundBefore + 0.08 && p.velocityY <= 0) {
    p.y = groundBefore;
    p.velocityY = 0;
    p.grounded = true;
    p.lastGroundedAt = now;
  }

  // ジャンプ入力は短時間保持する。坂の上でも接地していればジャンプできる。
  if (p.jumpQueuedUntil >= now && (p.grounded || now - p.lastGroundedAt <= 140)) {
    p.velocityY = JUMP_SPEED * (p.charm === "jump" ? 1.5 : 1) * (p.charm === "floor" || p.charm === "jump" || !isOnFloorTile(p, "slime") ? 1 : 0.5);
    p.grounded = false;
    p.jumpQueuedUntil = 0;
  }

  let forward = Number(p.input.forward || 0);
  let strafe = Number(p.input.strafe || 0);
  const len = Math.hypot(forward, strafe);
  if (len > 1) {
    forward /= len;
    strafe /= len;
  }

  const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
  const baseMoveSpeed = p.crouched ? CROUCH_SPEED : PLAYER_SPEED;
  // 速度上昇床は通常床の2倍。減速床の効果とは乗算で適用する。
  const speedFloorMultiplier = isOnFloorTile(p, "speed") ? 2 : 1;
  const slowFloorMultiplier = p.charm === "floor" || !isOnFloorTile(p, "slime") ? 1 : 0.5;
  const floorMoveMultiplier = speedFloorMultiplier * slowFloorMultiplier;
  const weaponMoveMultiplier =
    p.weapon === "minigun" ? 0.6 :
    p.weapon === "bow" && p.bowChargeStartedAt ? 0.5 : 1;
  const charmMoveMultiplier = p.charm === "speed" ? 1.8 : p.charm === "slide" ? 1.5 : 1;
  let moveSpeed = baseMoveSpeed * floorMoveMultiplier * weaponMoveMultiplier * charmMoveMultiplier;
  if (p.grapplePullTarget) {
    const target = p.grapplePullTarget;
    const pullX = target.x - p.x;
    const pullY = target.y - p.y;
    const pullZ = target.z - p.z;
    const pullHorizontal = Math.hypot(pullX, pullZ);
    if (now >= target.expiresAt || (pullHorizontal < 0.65 && Math.abs(pullY) < 0.8)) {
      p.grapplePullTarget = null;
      p.knockbackVelocityX = 0;
      p.knockbackVelocityZ = 0;
      if (pullHorizontal < 0.65) p.velocityY = Math.min(Number(p.velocityY) || 0, 0);
    } else {
      const pullSpeed = clamp(72 + pullHorizontal * 0.36, 72, 102);
      p.knockbackVelocityX = pullHorizontal > 0.001 ? pullX / pullHorizontal * pullSpeed : 0;
      p.knockbackVelocityZ = pullHorizontal > 0.001 ? pullZ / pullHorizontal * pullSpeed : 0;
      p.velocityY = target.floorAnchor ? 0 : clamp(pullY * 2.4 + GRAVITY * 0.05, -16, 16);
      p.grounded = false;
      p.lastGroundedAt = 0;
    }
  }
  const knockbackX = Number(p.knockbackVelocityX) || 0;
  const knockbackZ = Number(p.knockbackVelocityZ) || 0;
  let dx = (-sin * forward + cos * strafe) * moveSpeed * dt + knockbackX * dt;
  let dz = (-cos * forward - sin * strafe) * moveSpeed * dt + knockbackZ * dt;
  if (p.slidingUntil > now) {
    const slideProgress = clamp((p.slidingUntil - now) / 700, 0, 1);
    const slideSpeed = PLAYER_SPEED * 1.5 * (0.55 + 0.45 * slideProgress);
    dx = (Number(p.slideDirectionX) || 0) * slideSpeed * dt + knockbackX * dt;
    dz = (Number(p.slideDirectionZ) || 0) * slideSpeed * dt + knockbackZ * dt;
    p.crouched = true;
  } else if (p.slidingUntil) {
    p.slidingUntil = 0;
    p.slideDirectionX = 0;
    p.slideDirectionZ = 0;
  }
  const cartContact = getPayloadCartCollisionInfo(p);
  if (cartContact) {
    const onDeck = p.y >= cartContact.deckTop - 0.22 &&
      Math.abs(cartContact.localX) <= 2.1 && Math.abs(cartContact.localZ) <= 1.225;
    const onCargo = p.y >= cartContact.cargoTop - 0.22 &&
      Math.abs(cartContact.localX + 0.35) <= 0.775 && Math.abs(cartContact.localZ) <= 0.775;
    if (onDeck || onCargo) {
      const localX = onCargo ? cartContact.localX + 0.35 : cartContact.localX;
      const localZ = cartContact.localZ;
      const halfX = onCargo ? 0.775 : 2.1;
      const halfZ = onCargo ? 0.775 : 1.225;
      let pushLocalX = 0, pushLocalZ = 0;
      if (Math.abs(localX) / halfX > Math.abs(localZ) / halfZ) pushLocalX = localX < 0 ? -1 : 1;
      else pushLocalZ = localZ < 0 ? -1 : 1;
      const c = Math.cos(cartContact.yaw), s = Math.sin(cartContact.yaw);
      const slideSpeed = onCargo ? 2.6 : 3.4;
      dx += (c * pushLocalX + s * pushLocalZ) * slideSpeed * dt;
      dz += (-s * pushLocalX + c * pushLocalZ) * slideSpeed * dt;
    }
  }
  p.knockbackVelocityX = knockbackX * Math.exp(-4.2 * dt);
  p.knockbackVelocityZ = knockbackZ * Math.exp(-4.2 * dt);
  if (Math.hypot(p.knockbackVelocityX, p.knockbackVelocityZ) < 0.15) {
    p.knockbackVelocityX = 0;
    p.knockbackVelocityZ = 0;
  }
  const currentHeight = p.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  if (p.grapplePullTarget) {
    // 高速の引き寄せを短い区間に分割し、壁・床の薄い当たり判定を飛び越えない。
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 0.12));
    let blocked = false;
    for (let step = 0; step < steps; step++) {
      const stepX = p.x + dx / steps;
      const groundX = getGroundHeight(stepX, p.z, p.y, p);
      const yX = wasGrounded && p.velocityY <= 0 ? Math.max(p.y, groundX) : p.y;
      if (!collides(stepX, p.z, yX, currentHeight, p)) p.x = stepX;
      else { blocked = true; break; }
      const stepZ = p.z + dz / steps;
      const groundZ = getGroundHeight(p.x, stepZ, p.y, p);
      const yZ = wasGrounded && p.velocityY <= 0 ? Math.max(p.y, groundZ) : p.y;
      if (!collides(p.x, stepZ, yZ, currentHeight, p)) p.z = stepZ;
      else { blocked = true; break; }
    }
    if (blocked) {
      p.grapplePullTarget = null;
      p.knockbackVelocityX = 0;
      p.knockbackVelocityZ = 0;
      p.velocityY = Math.min(Number(p.velocityY) || 0, 0);
    }
  } else {
    const nextX = p.x + dx;
    const nextZ = p.z + dz;
    // 坂の上を歩いている場合は、坂の高さまで自然に追従させる。
    // 空中にいる場合は現在のYをそのまま使って壁との衝突だけ判定する。
    const nextGroundX = getGroundHeight(nextX, p.z, p.y, p);
    const collisionY = wasGrounded && p.velocityY <= 0 ? Math.max(p.y, nextGroundX) : p.y;
    if (!collides(nextX, p.z, collisionY, currentHeight, p)) p.x = nextX;
    const nextGroundZ = getGroundHeight(p.x, nextZ, p.y, p);
    const collisionY2 = wasGrounded && p.velocityY <= 0 ? Math.max(p.y, nextGroundZ) : p.y;
    if (!collides(p.x, nextZ, collisionY2, currentHeight, p)) p.z = nextZ;
  }
  if (p.isBot && p.mode === PAYLOAD_MODE && !p.botHasLeftRespawnArea &&
      !getPayloadRespawnZoneAt(getMapForPlayer(p), p.x, p.z)) {
    p.botHasLeftRespawnArea = true;
  }

  // ジャンプ中/空中では必ず重力を適用する。
  const previousY = p.y;
  if (p.flying) {
    const verticalInput = (p.input.jumpHeld ? 1 : 0) - (p.input.crouch ? 1 : 0);
    p.velocityY = verticalInput * PLAYER_SPEED;
    const flightCeiling = Number.isFinite(p.flightMaxY) ? p.flightMaxY : p.y + 30;
    const nextFlightY = Math.min(flightCeiling, p.y + p.velocityY * dt);
    if (!collides(p.x, p.z, nextFlightY, currentHeight, p)) p.y = nextFlightY;
    else p.velocityY = 0;
    if (p.y >= flightCeiling - 0.001 && p.velocityY > 0) p.velocityY = 0;
  } else if (!p.grounded) {
    p.velocityY -= GRAVITY * dt;
    p.y += p.velocityY * dt;
  }

  // 階段の斜面は薄い板として上下両面を衝突面にする。
  // 下からジャンプして頭が板の下面を横切る場合は下面で止め、
  // 上から落ちる場合は斜面上面に着地させる。
  if (p.y !== previousY) {
    for (const ramp of getMapForPlayer(p).ramps || []) {
      const surfaceY = getRampHeight(ramp, p.x, p.z);
      if (surfaceY === null) continue;
      if (p.velocityY > 0) {
        const previousHead = previousY + currentHeight;
        const nextHead = p.y + currentHeight;
        if (previousHead <= surfaceY + 0.025 && nextHead > surfaceY + 0.025) {
          p.y = surfaceY - currentHeight - 0.025;
          p.velocityY = 0;
          p.grounded = false;
          break;
        }
      } else if (p.velocityY <= 0 && previousY >= surfaceY - 0.025 && p.y <= surfaceY) {
        p.y = surfaceY;
        p.velocityY = 0;
        p.grounded = true;
        p.lastGroundedAt = now;
        break;
      }
    }
  }

  // 台の上からゆっくり降りるときに、1tickの間に台を突き抜けないようにする。
  // プレイヤーの足元が台の上面を上から下へ横切った瞬間に、台の上面へ固定する。
  if (!p.grounded && p.velocityY <= 0 && p.y <= previousY) {
    for (const obstacle of (getMapForPlayer(p).obstacles || [])) {
      const insideX =
        p.x > obstacle.x - obstacle.w / 2 - PLAYER_RADIUS &&
        p.x < obstacle.x + obstacle.w / 2 + PLAYER_RADIUS;
      const insideZ =
        p.z > obstacle.z - obstacle.d / 2 - PLAYER_RADIUS &&
        p.z < obstacle.z + obstacle.d / 2 + PLAYER_RADIUS;

      if (!insideX || !insideZ) continue;

      if (previousY >= obstacle.h && p.y <= obstacle.h) {
        p.y = obstacle.h;
        p.velocityY = 0;
        p.grounded = true;
        p.lastGroundedAt = now;
        break;
      }

      // 何らかの理由で台の中へ入った状態も、台の上面へ戻す。
      if (p.y < obstacle.h && p.y + currentHeight > obstacle.h && previousY >= obstacle.h) {
        p.y = obstacle.h;
        p.velocityY = 0;
        p.grounded = true;
        p.lastGroundedAt = now;
        break;
      }
    }
  }

  const ground = getGroundHeight(p.x, p.z, p.y, p);

  // 坂を上るときは地面の高さに追従する。
  // 坂から外れた場合はground=0になり、重力で下へ落ちる。
  if (p.velocityY <= 0 && p.y <= ground + 0.08) {
    p.y = ground;
    p.velocityY = 0;
    p.grounded = true;
    p.lastGroundedAt = now;
    if (p.flying) { p.flying = false; p.flightMaxY = 0; p.lastFlightJumpTapAt = 0; }
  } else {
    p.grounded = false;
  }

  if (p.skyfallImpactPending && p.grounded) {
    p.skyfallImpactPending = false;
    p.ultimateAnchor = null;
    resolveSkyfallImpact(p, now);
  }

  const playerBounds = getMapForPlayer(p).world;
  p.x = clamp(p.x, playerBounds.minX + PLAYER_RADIUS, playerBounds.maxX - PLAYER_RADIUS);
  p.z = clamp(p.z, playerBounds.minZ + PLAYER_RADIUS, playerBounds.maxZ - PLAYER_RADIUS);
  p.pitch = clamp(p.pitch, -1.35, 1.35);
}

function getDistanceDamageMultiplier(weapon, distance) {
  const start = Number(weapon.falloffStart ?? 0);
  const range = Math.max(start + 0.001, Number(weapon.range) || 1);
  const minMultiplier = clamp(Number(weapon.minDamageMultiplier ?? 1), 0, 1);

  if (distance <= start) return 1;
  if (distance >= range) return minMultiplier;

  const progress = (distance - start) / (range - start);
  return 1 - (1 - minMultiplier) * progress;
}

function directionFromAngles(yaw, pitch) {
  // プレイヤーのカメラと完全に同じ前方ベクトル。
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp
  };
}

function buildStructureWorldPayload(map) {
  return { ...(map || {}), buildStructures: map?.buildStructures || [] };
}

function rayBuildStructureDistance(origin, direction, structure, maxDistance) {
  const minX = structure.x - (structure.w || 1) / 2;
  const maxX = structure.x + (structure.w || 1) / 2;
  const minY = Number(structure.y) || 0;
  const maxY = minY + (structure.type === "floor" ? 0.08 : (Number(structure.h) || 2));
  const minZ = structure.z - (structure.d || 1) / 2;
  const maxZ = structure.z + (structure.d || 1) / 2;
  let tMin = 0, tMax = maxDistance;
  for (const [o, d, lo, hi] of [
    [origin.x, direction.x, minX, maxX],
    [origin.y, direction.y, minY, maxY],
    [origin.z, direction.z, minZ, maxZ]
  ]) {
    if (Math.abs(d) < 1e-8) { if (o < lo || o > hi) return null; continue; }
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    tMin = Math.max(tMin, a); tMax = Math.min(tMax, b);
    if (tMin > tMax) return null;
  }
  return tMin >= 0 && tMin <= maxDistance ? tMin : null;
}

function damageBuildStructureOnRay(player, origin, direction, maxDistance, damage) {
  if (player?.mode !== BUILD_MODE || !player.buildMap || !(damage > 0)) return null;
  const map = player.buildMap;
  let nearest = null;
  for (const structure of map.buildStructures || []) {
    const distance = rayBuildStructureDistance(origin, direction, structure, maxDistance);
    if (distance !== null && (!nearest || distance < nearest.distance)) nearest = { structure, distance };
  }
  if (!nearest) return null;
  nearest.structure.hp = Math.max(0, (Number(nearest.structure.hp) || 50) - damage);
  const destroyed = nearest.structure.hp <= 0;
  if (destroyed) {
    map.buildStructures = (map.buildStructures || []).filter(item => item.id !== nearest.structure.id);
    map.obstacles = (map.obstacles || []).filter(item => item.buildStructureId !== nearest.structure.id);
    map.floorTiles = (map.floorTiles || []).filter(item => item.buildStructureId !== nearest.structure.id);
    map.elevatedPlatforms = (map.elevatedPlatforms || []).filter(item => item.buildStructureId !== nearest.structure.id);
    map.ramps = (map.ramps || []).filter(item => item.buildStructureId !== nearest.structure.id);
    pruneUnsupportedBuildStructures(map);
  }
  if (destroyed) broadcastGameEvent(player, "buildStructureUpdate", getWorldPayloadForMap(map, BUILD_MODE));
  return nearest;
}

function damageBuildStructuresInRadius(player, position, radius, damage) {
  if (player?.mode !== BUILD_MODE || !player.buildMap || !(damage > 0)) return;
  const map = player.buildMap;
  let destroyedAny = false;
  for (const structure of [...(map.buildStructures || [])]) {
    if (Math.hypot(structure.x - position.x, structure.z - position.z) > radius + 0.75) continue;
    structure.hp = Math.max(0, (Number(structure.hp) || 50) - damage);
    if (structure.hp <= 0) {
      destroyedAny = true;
      map.buildStructures = map.buildStructures.filter(item => item.id !== structure.id);
      map.obstacles = (map.obstacles || []).filter(item => item.buildStructureId !== structure.id);
      map.floorTiles = (map.floorTiles || []).filter(item => item.buildStructureId !== structure.id);
      map.elevatedPlatforms = (map.elevatedPlatforms || []).filter(item => item.buildStructureId !== structure.id);
      map.ramps = (map.ramps || []).filter(item => item.buildStructureId !== structure.id);
    }
  }
  if (destroyedAny) {
    pruneUnsupportedBuildStructures(map);
    broadcastGameEvent(player, "buildStructureUpdate", getWorldPayloadForMap(map, BUILD_MODE));
  }
}

function rayHitsObstacle(origin, direction, maxDistance, player = null) {
  let nearest = Infinity;
  const mapObstacles = getMapForPlayer(player).obstacles || [];

  for (const o of mapObstacles) {
    // 壁を少し厚くして、弾が境界をすり抜けるのを防ぐ。
    const minX = o.x - o.w / 2;
    const maxX = o.x + o.w / 2;
    const minY = o.ceiling ? o.y : 0;
    const maxY = o.ceiling ? o.y + o.h : o.h;
    const minZ = o.z - o.d / 2;
    const maxZ = o.z + o.d / 2;

    let tMin = 0;
    let tMax = maxDistance;

    const axes = [
      [origin.x, direction.x, minX, maxX],
      [origin.y, direction.y, minY, maxY],
      [origin.z, direction.z, minZ, maxZ]
    ];

    let intersects = true;

    for (const [originValue, directionValue, minValue, maxValue] of axes) {
      if (Math.abs(directionValue) < 1e-8) {
        if (originValue < minValue || originValue > maxValue) {
          intersects = false;
          break;
        }
        continue;
      }

      let t1 = (minValue - originValue) / directionValue;
      let t2 = (maxValue - originValue) / directionValue;
      if (t1 > t2) [t1, t2] = [t2, t1];

      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);

      if (tMin > tMax) {
        intersects = false;
        break;
      }
    }

    if (intersects && tMin >= 0 && tMin <= maxDistance) {
      nearest = Math.min(nearest, tMin);
    }
  }

  return Number.isFinite(nearest) ? nearest : null;
}


function rayHitsPayloadCart(origin, direction, maxDistance, player = null) {
  const info = getPayloadCartCollisionInfo(player);
  if (!info) return null;

  const dx = origin.x - info.cart.x;
  const dz = origin.z - info.cart.z;
  const cos = Math.cos(info.yaw);
  const sin = Math.sin(info.yaw);
  const localOrigin = {
    x: cos * dx - sin * dz,
    y: origin.y - (Number(info.cart.y) || 0),
    z: sin * dx + cos * dz
  };
  const localDirection = {
    x: cos * direction.x - sin * direction.z,
    y: direction.y,
    z: sin * direction.x + cos * direction.z
  };
  const deckTop = info.deckTop - (Number(info.cart.y) || 0);
  const cargoTop = info.cargoTop - (Number(info.cart.y) || 0);
  const boxes = [
    { minX: -2.1, maxX: 2.1, minY: 0.08, maxY: deckTop, minZ: -1.225, maxZ: 1.225 },
    { minX: -1.125, maxX: 0.425, minY: deckTop, maxY: cargoTop, minZ: -0.775, maxZ: 0.775 }
  ];
  let nearest = Infinity;

  for (const box of boxes) {
    let tMin = 0;
    let tMax = maxDistance;
    let intersects = true;
    const axes = [
      [localOrigin.x, localDirection.x, box.minX, box.maxX],
      [localOrigin.y, localDirection.y, box.minY, box.maxY],
      [localOrigin.z, localDirection.z, box.minZ, box.maxZ]
    ];
    for (const [o, d, min, max] of axes) {
      if (Math.abs(d) < 1e-8) {
        if (o < min || o > max) { intersects = false; break; }
        continue;
      }
      let t1 = (min - o) / d;
      let t2 = (max - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) { intersects = false; break; }
    }
    if (intersects && tMin >= 0 && tMin <= maxDistance) nearest = Math.min(nearest, tMin);
  }

  return Number.isFinite(nearest) ? nearest : null;
}

function rayHitsPlayer(origin, direction, target, hitRadiusOverride = null) {
  const targetHeight = target.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;

  // 頭部は胴体の大きな球判定から独立させる。
  // 先に頭部球との交点を調べることで、頭を通る弾が胴体側の判定に埋もれない。
  if (hitRadiusOverride === null) {
    const headCenter = {
      x: target.x,
      y: target.y + targetHeight * 0.88,
      z: target.z
    };
    const headRadius = target.crouched ? 0.27 : 0.32;
    const hx = origin.x - headCenter.x;
    const hy = origin.y - headCenter.y;
    const hz = origin.z - headCenter.z;
    const hb = 2 * (hx * direction.x + hy * direction.y + hz * direction.z);
    const hc = hx * hx + hy * hy + hz * hz - headRadius * headRadius;
    const hd = hb * hb - 4 * hc;
    if (hd >= 0) {
      const nearHead = (-hb - Math.sqrt(hd)) / 2;
      const farHead = (-hb + Math.sqrt(hd)) / 2;
      const headT = nearHead >= 0 ? nearHead : farHead;
      if (headT >= 0) return { t: headT, multiplier: 2.0, zone: "head" };
    }
  }

  const targetCenter = { x: target.x, y: target.y + targetHeight * 0.5, z: target.z };
  const ox = origin.x - targetCenter.x;
  const oy = origin.y - targetCenter.y;
  const oz = origin.z - targetCenter.z;

  // 通常武器は従来の判定半径。レールガンは指定された5mの判定半径を使用する。
  const hitRadius = Number.isFinite(Number(hitRadiusOverride)) && hitRadiusOverride !== null
    ? Math.max(0, Number(hitRadiusOverride))
    : PLAYER_RADIUS * 2;
  const b = 2 * (ox * direction.x + oy * direction.y + oz * direction.z);
  const c = ox * ox + oy * oy + oz * oz - hitRadius * hitRadius;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;

  const t1 = (-b - Math.sqrt(disc)) / 2;
  const t2 = (-b + Math.sqrt(disc)) / 2;
  const t = t1 >= 0 ? t1 : t2;
  if (t < 0) return null;

  const hitY = origin.y + direction.y * t - target.y;
  let multiplier = 1.0;
  let zone = "body";

  // レールガンなど頭部専用判定を使わない呼び出しでは、従来の高さ判定を維持する。
  if (hitRadiusOverride !== null && hitY >= 1.42) {
    multiplier = 2.0;
    zone = "head";
  } else if (hitY < 0.58) {
    multiplier = 0.75;
    zone = "legs";
  }

  return { t, multiplier, zone };
}

function finishReload(p, now = Date.now()) {
  if (!p.reloadingUntil || now < p.reloadingUntil) return false;

  const weapon = WEAPONS[p.weapon];
  p.ammo = weapon.magazineSize;
  if (Array.isArray(p.weaponAmmo)) p.weaponAmmo[p.activeWeaponSlot || 0] = p.ammo;
  p.reloadingUntil = 0;
  return true;
}

function startReload(p) {
  const weapon = WEAPONS[p.weapon];
  const now = Date.now();

  if (weapon.magazineSize <= 0 || p.health <= 0 || p.reloadingUntil > now) return false;
  if (p.ammo >= weapon.magazineSize) return false;

  p.reloadingUntil = now + weapon.reloadTime * (p.charm === "reload" ? 1 / 6 : 1);
  return true;
}

function getMovementSpeedSpreadMultiplier(shooter, now = Date.now()) {
  const input = shooter.input || {};
  const isMoving = Math.abs(Number(input.forward) || 0) > 0.05 ||
    Math.abs(Number(input.strafe) || 0) > 0.05;
  if (!isMoving) return 1;

  const baseMoveSpeed = shooter.crouched ? CROUCH_SPEED : PLAYER_SPEED;
  const floorMoveMultiplier =
    shooter.charm === "floor" || !isOnFloorTile(shooter, "slime") ? 1 : 0.5;
  const weaponMoveMultiplier =
    shooter.weapon === "minigun" ? 0.6 :
    shooter.weapon === "bow" && shooter.bowChargeStartedAt ? 0.5 : 1;
  const charmMoveMultiplier = shooter.charm === "speed" ? 1.8 : 1;
  let actualMoveSpeed = baseMoveSpeed * floorMoveMultiplier *
    weaponMoveMultiplier * charmMoveMultiplier;

  // 通常走行を1倍とし、それを超える速度は3.5乗で弾ブレに反映する。
  const speedRatio = Math.max(1, actualMoveSpeed / PLAYER_SPEED);
  return Math.min(40, Math.pow(speedRatio, 3.5));
}

function fireShot(shooter, sniperScoped = false, bowCharge = 1) {
  const weapon = WEAPONS[shooter.weapon];
  const now = Date.now();

  // リスポーン直後3秒間・凍結中は、BOTを含めて射撃できない。
  if (shooter.invulnerableUntil > now || shooter.frozenUntil > now) return;
  if (shooter.weapon === "railgun") {
    if (now - shooter.lastFire < 2000) return;
    shooter.lastFire = now;
    const dir = directionFromAngles(shooter.yaw, shooter.pitch);
    const eyeY = shooter.y + (shooter.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) - 0.15;
    // 画面中央（視点の中心）から照準方向へ発射する。
    const origin = { x: shooter.x, y: eyeY, z: shooter.z };
    damageBuildStructureOnRay(shooter, origin, dir, 150, 35);
    let best = null;
    for (const target of players.values()) {
      if (target.id === shooter.id || target.health <= 0 || target.finished || !isSameGame(shooter, target) ||
          (shooter.mode === TRAINING_MODE && !target.isBot) ||
          (isTeamMatchMode(shooter.mode) && target.team === shooter.team) || target.invulnerableUntil > now) continue;
      const hit = rayHitsPlayer(origin, dir, target, 2.0);
      if (hit && hit.t <= 150 && (!best || hit.t < best.t)) best = { target, ...hit };
    }

    // レールガンは移動弾を生成せず、発射フレームで照準上の最初の相手に即着弾する。
    // 既存仕様どおり壁は貫通し、射程は150m。
    if (best) {
      const damage = 35; // 頭部・胴体ともに固定35ダメージ
      const split = applyIncomingDamage(best.target, damage, true);
      addUltimateCharge(shooter, damage);
      const hitX = origin.x + dir.x * best.t;
      const hitY = origin.y + dir.y * best.t;
      const hitZ = origin.z + dir.z * best.t;

      io.to(shooter.id).emit("damageDealt", {
        targetId: best.target.id,
        damage: Math.round(split.totalDamage),
        shieldDamage: Math.round(split.shieldDamage),
        healthDamage: Math.round(split.healthDamage),
        zone: best.zone || "body",
        x: hitX, y: hitY, z: hitZ
      });
      io.to(best.target.id).emit("damageTaken", {
        damage: Math.round(split.totalDamage),
        zone: best.zone || "body"
      });

      if (best.target.health <= 0) {
        shooter.health = Number(shooter.maxHealth) || 100;
        clearBurnStatus(shooter);
        best.target.health = 0;
        best.target.respawnAt = now + 5000;
        best.target.kills = best.target.kills || 0;
        shooter.kills = (shooter.kills || 0) + 1;
        best.target.deaths = (best.target.deaths || 0) + 1;
        if (best.target.mode === "Duel") resolveDuelRound(shooter, best.target);
        best.target.invisibleUntil = 0;
        if (best.target.riftDuelId) finishRiftDuel(best.target);
        if (shooter.invisibleUntil > Date.now()) shooter.invisibleUntil = 0;
        broadcastGameEvent(shooter, "elimination", {
          killerId: shooter.id,
          killerName: shooter.name,
          victimId: best.target.id,
          victimName: best.target.name,
          killerKills: shooter.kills,
          zone: best.zone || "body"
        });
      }
    }

    // トレーサーは着弾点までの一直線を一度に描画する。移動弾の速度・補間処理は使わない。
    broadcastGameEvent(shooter, "shot", {
      id: shooter.id,
      x: origin.x, y: origin.y, z: origin.z,
      yaw: shooter.yaw, pitch: shooter.pitch,
      weapon: "railgun",
      hit: Boolean(best),
      tracers: [{ yaw: shooter.yaw, pitch: shooter.pitch, distance: best?.t || 150 }]
    });
    return;
  }

  finishReload(shooter, now);
  if (shooter.reloadingUntil > now) return;
  if (shooter.weapon === "sword" && now < Number(shooter.swordMeleeReadyAt || 0)) return;
  if (now - shooter.lastFire < weapon.fireInterval) return;

  if (shooter.weapon === "smoke") {
    shooter.lastFire = now;
    spawnSmokeProjectile(shooter, now);
    return;
  }
  if (shooter.weapon === "shockwaveLauncher") {
    shooter.lastFire = now;
    spawnGrenadeProjectile(shooter, now, "shockwave");
    return;
  }
  if (shooter.weapon === "grappler") {
    shooter.lastFire = now;
    spawnGrappleProjectile(shooter, now);
    return;
  }

  if (shooter.weapon === "bow") {
    bowCharge = clamp(Number(bowCharge) || 0, 0, 1);
  } else if (!["minigun", "shockwaveLauncher", "grappler"].includes(shooter.weapon) && !weapon.melee && shooter.ammo <= 0) {
    startReload(shooter);
    return;
  }

  shooter.lastFire = now;
  if (shooter.weapon === "sword") shooter.swordMeleeReadyAt = now + weapon.fireInterval;
  if (!weapon.melee && !["bow", "minigun", "shockwaveLauncher", "grappler"].includes(shooter.weapon)) {
    shooter.ammo -= 1;
    if (Array.isArray(shooter.weaponAmmo)) shooter.weaponAmmo[shooter.activeWeaponSlot || 0] = shooter.ammo;
  }
  if (shooter.weapon === "grenadeLauncher") {
    spawnGrenadeProjectile(shooter, now);
    return;
  }
  if (shooter.weapon === "rocketLauncher") {
    spawnRocketProjectile(shooter, now);
    return;
  }
  if (shooter.weapon === "cannonLauncher") {
    placePlayerCannon(shooter, now);
    broadcastGameEvent(shooter, "shot", { id: shooter.id, x: shooter.x, y: shooter.y, z: shooter.z, yaw: shooter.yaw, pitch: shooter.pitch, weapon: "cannonLauncher", hit: null, tracers: [] });
    return;
  }

  const pelletCount = weapon.pellets || 1;
  const shooterHeight = shooter.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const origin = {
    x: shooter.x,
    y: shooter.y + shooterHeight - 0.15,
    z: shooter.z
  };

  const hitResults = [];
  const damageByTarget = new Map();

  // ツルハシは弾丸を生成せず、正面の近距離にいる相手だけを近接判定する。
  if (weapon.melee) {
    const forward = directionFromAngles(shooter.yaw, shooter.pitch);
    damageBuildStructureOnRay(shooter, { x: shooter.x, y: shooter.y + 0.8, z: shooter.z }, { x: forward.x, y: 0, z: forward.z }, weapon.range * 1.8, weapon.damage);
    let best = null;
    for (const target of players.values()) {
      if (target.id === shooter.id || target.health <= 0 || target.finished || !isSameGame(shooter, target)) continue;
      if (shooter.mode === TRAINING_MODE && !target.isBot) continue;
      if (isTeamMatchMode(shooter.mode) && target.team === shooter.team) continue;
      if (target.invulnerableUntil > now) continue;
      const dx = target.x - shooter.x;
      const dz = target.z - shooter.z;
      // 正面に伸びる長方形。横幅はレティクルの角度（halfAngle = acos(0.9））に合わせる。
      const forwardDistance = forward.x * dx + forward.z * dz;
      if (forwardDistance <= 0 || forwardDistance > weapon.range * 1.8) continue;
      const lateralDistance = Math.abs(forward.x * dz - forward.z * dx);
      const halfAngle = Math.acos(0.9);
      const halfWidth = weapon.range * Math.tan(halfAngle) * 0.8;
      if (lateralDistance > halfWidth) continue;
      const distance = Math.hypot(dx, dz);
      const verticalDiff = Math.abs((target.y + (target.crouched ? 0.75 : 1.0)) - (shooter.y + shooterHeight * 0.72));
      if (verticalDiff > (shooter.weapon === "sword" ? 2.15 : 1.6)) continue;
      const meleeDirection = {x: dx / distance, y: 0, z: dz / distance};
      const wallDistance = rayHitsObstacle(origin, meleeDirection, distance, shooter);
      if (wallDistance !== null && wallDistance < distance - 0.35) continue;
      if (!best || distance < best.distance) best = {target, distance};
    }
    if (best) {
      const damage = weapon.damage;
      const split = applyIncomingDamage(best.target, damage);
      addUltimateCharge(shooter, damage);
      damageByTarget.set(best.target.id, {id: best.target.id, target: best.target, damage, shieldDamage: split.shieldDamage, healthDamage: split.healthDamage, zone: "body"});
      hitResults.push({target: best.target, damage, zone: "body", x: best.target.x, y: best.target.y + 1, z: best.target.z});
    }
  }

  for (let pellet = 0; !weapon.melee && pellet < pelletCount; pellet++) {
    let yaw = shooter.yaw;
    let pitch = shooter.pitch;

    if (weapon.spread) {
      // エリアモードのBOTだけ人間プレイヤーより弾が大きくブレる。ジャンプ中はさらに拡大する。
      const botSpreadMultiplier = shooter.isBot && isTeamMatchMode(shooter.mode) ? 3.25 : 1;
      const isMoving = Math.abs(Number(shooter.input?.forward || 0)) > 0.05 ||
        Math.abs(Number(shooter.input?.strafe || 0)) > 0.05;
      const movingShotMultiplier = shooter.weapon === "sniper" && isMoving ? 2 : 1;
      const jumpCharmSpreadMultiplier = shooter.charm === "jump" ? 0.5 : 1;
      const movementSpreadMultiplier = (shooter.grounded ? 1 : 2.0) *
        movingShotMultiplier * getMovementSpeedSpreadMultiplier(shooter, now) * jumpCharmSpreadMultiplier;
      const sniperUnscopedMultiplier = shooter.weapon === "sniper" && !sniperScoped ? 3.2 : 1;
      const spread = weapon.spread * botSpreadMultiplier * movementSpreadMultiplier * sniperUnscopedMultiplier;
      yaw += (Math.random() - 0.5) * spread;
      pitch += (Math.random() - 0.5) * spread;
    }

    const dir = directionFromAngles(yaw, pitch);
    damageBuildStructureOnRay(shooter, origin, dir, weapon.range, weapon.damage || 10);
    const cartDistance = rayHitsPayloadCart(origin, dir, weapon.range, shooter);
    let bestHit = null;

    for (const target of players.values()) {
      if (target.id === shooter.id || target.health <= 0 || target.finished || !isSameGame(shooter, target)) continue;
      if (shooter.mode === TRAINING_MODE && !target.isBot) continue;
      if (isTeamMatchMode(shooter.mode) && target.team === shooter.team) continue;
      // リスポーン直後3秒間は被弾しない。
      if (target.invulnerableUntil > now) continue;

      let hitInfo = null;
      if (shooter.weapon === "bow") {
        // 低チャージでも最低速度を確保し、速度に応じて命中ダメージを減らす。
        const arrowSpeed = Math.max(1.5, 10.4 * Math.pow(bowCharge, 3));
        const gravity = 1.3;
        // 判定間隔を広げて軌道サンプル数を削減し、射撃時のサーバー負荷を抑える。
        const stepTime = 0.1;
        const maxFlightTime = Math.min(weapon.range / arrowSpeed, 0.75);
        let previous = { ...origin };
        for (let elapsed = stepTime; arrowSpeed > 0.05 && elapsed <= maxFlightTime; elapsed += stepTime) {
          const current = {
            x: origin.x + dir.x * arrowSpeed * elapsed,
            y: origin.y + dir.y * arrowSpeed * elapsed - 0.5 * gravity * elapsed * elapsed,
            z: origin.z + dir.z * arrowSpeed * elapsed
          };
          const dx = current.x - previous.x, dy = current.y - previous.y, dz = current.z - previous.z;
          const segmentLength = Math.hypot(dx, dy, dz);
          if (segmentLength <= 1e-6) { previous = current; continue; }
          const segmentDir = { x: dx / segmentLength, y: dy / segmentLength, z: dz / segmentLength };
          const wallDistance = rayHitsObstacle(previous, segmentDir, segmentLength, shooter);
          const cartHit = rayHitsPayloadCart(previous, segmentDir, segmentLength, shooter);
          const hit = rayHitsPlayer(previous, segmentDir, target);
          if (hit && hit.t <= segmentLength && (wallDistance === null || wallDistance > hit.t) &&
              (cartHit === null || cartHit > hit.t)) {
            const hitRatio = clamp(hit.t / segmentLength, 0, 1);
            hitInfo = {
              ...hit,
              t: elapsed * arrowSpeed,
              x: previous.x + dx * hitRatio,
              y: previous.y + dy * hitRatio,
              z: previous.z + dz * hitRatio
            };
            break;
          }
          if ((wallDistance !== null && wallDistance <= segmentLength) ||
              (cartHit !== null && cartHit <= segmentLength)) break;
          previous = current;
        }
      } else {
        hitInfo = rayHitsPlayer(origin, dir, target);
        if (hitInfo === null || hitInfo.t > weapon.range) continue;
        if (cartDistance !== null && cartDistance <= hitInfo.t + 0.001) continue;
        // プレイヤーより手前に壁がある場合は、その弾丸を無効にする。
        const wallDistance = rayHitsObstacle(origin, dir, hitInfo.t, shooter);
        if (wallDistance !== null && wallDistance <= hitInfo.t + 0.001) continue;
      }
      if (!hitInfo) continue;
      if (!bestHit || hitInfo.t < bestHit.t) bestHit = { target, ...hitInfo };
    }

    if (!bestHit) continue;

    const distanceMultiplier = getDistanceDamageMultiplier(weapon, bestHit.t);
    const baseShotDamage = shooter.weapon === "bow" ? 5 + 135 * bowCharge : weapon.damage;
    const bowSpeedDamageMultiplier = shooter.weapon === "bow"
      ? clamp(Math.max(1.5, 10.4 * Math.pow(bowCharge, 3)) / 10.4, 0.2, 1)
      : 1;
    const damage = baseShotDamage * bowSpeedDamageMultiplier * bestHit.multiplier * distanceMultiplier;
    const split = applyIncomingDamage(bestHit.target, damage, true);
    addUltimateCharge(shooter, damage);

    const existing = damageByTarget.get(bestHit.target.id);
    if (existing) {
      existing.damage += damage;
      existing.shieldDamage += split.shieldDamage;
      existing.healthDamage += split.healthDamage;
      if (bestHit.zone === "head") existing.zone = "head";
    } else {
      damageByTarget.set(bestHit.target.id, {
        id: bestHit.target.id,
        target: bestHit.target,
        damage,
        shieldDamage: split.shieldDamage,
        healthDamage: split.healthDamage,
        zone: bestHit.zone
      });
    }

    hitResults.push({
      target: bestHit.target,
      damage,
      zone: bestHit.zone,
      x: bestHit.x ?? origin.x + dir.x * bestHit.t,
      y: bestHit.y ?? origin.y + dir.y * bestHit.t,
      z: bestHit.z ?? origin.z + dir.z * bestHit.t
    });
  }

  for (const result of damageByTarget.values()) {
    const feedback = hitResults
      .filter((hit) => hit.target.id === result.target.id)
      .reduce((best, hit) => hit.damage > best.damage ? hit : best, hitResults.find((hit) => hit.target.id === result.target.id));

    io.to(shooter.id).emit("damageDealt", {
      targetId: result.target.id,
      damage: Math.round(result.damage),
      shieldDamage: Math.round(result.shieldDamage),
      healthDamage: Math.round(result.healthDamage),
      zone: result.zone,
      x: feedback?.x ?? result.target.x,
      y: feedback?.y ?? result.target.y + 1,
      z: feedback?.z ?? result.target.z
    });


    io.to(result.target.id).emit("damageTaken", {
      damage: Math.round(result.damage),
      zone: result.zone,
    });

    if (result.target.health <= 0) {
      shooter.health = Number(shooter.maxHealth) || 100;
        clearBurnStatus(shooter);
      result.target.health = 0;
      result.target.respawnAt = Date.now() + 5000;
      result.target.kills = result.target.kills || 0;
      shooter.kills += 1;
      result.target.deaths += 1;
      if(result.target.mode==="Duel")resolveDuelRound(shooter,result.target);

      result.target.invisibleUntil = 0;
      if (result.target.riftDuelId) finishRiftDuel(result.target);
      if (shooter.invisibleUntil > Date.now()) shooter.invisibleUntil = 0;
      broadcastGameEvent(shooter, "elimination", {
        killerId: shooter.id,
        killerName: shooter.name,
        victimId: result.target.id,
        victimName: result.target.name,
        killerKills: shooter.kills,
        zone: result.zone
      });
    }
  }

  const hit = hitResults.length
    ? {
        id: hitResults[0].target.id,
        damage: hitResults.reduce((sum, r) => sum + r.damage, 0),
        zone: hitResults.some(r => r.zone === "head") ? "head" : hitResults[0].zone
      }
    : null;

  const visualTracers = [];
  for (let pellet = 0; !weapon.melee && pellet < pelletCount; pellet++) {
    let visualYaw = shooter.yaw;
    let visualPitch = shooter.pitch;
    if (weapon.spread) {
      const botSpreadMultiplier = shooter.isBot && isTeamMatchMode(shooter.mode) ? 6.5 : 1;
      const isMoving = Math.abs(Number(shooter.input?.forward || 0)) > 0.05 ||
        Math.abs(Number(shooter.input?.strafe || 0)) > 0.05;
      const movingShotMultiplier = shooter.weapon === "sniper" && isMoving ? 2 : 1;
      const jumpCharmSpreadMultiplier = shooter.charm === "jump" ? 0.5 : 1;
      const movementSpreadMultiplier = (shooter.grounded ? 1 : 2.0) *
        movingShotMultiplier * getMovementSpeedSpreadMultiplier(shooter, now) * jumpCharmSpreadMultiplier;
      const sniperUnscopedMultiplier = shooter.weapon === "sniper" && !sniperScoped ? 3.2 : 1;
      const visualSpread = weapon.spread * botSpreadMultiplier *
        movementSpreadMultiplier * sniperUnscopedMultiplier;
      visualYaw += (Math.random() - 0.5) * visualSpread;
      visualPitch += (Math.random() - 0.5) * visualSpread;
    }
    const visualDir = directionFromAngles(visualYaw, visualPitch);
    const wallDistance = rayHitsObstacle(origin, visualDir, weapon.range, shooter);
    const cartDistance = rayHitsPayloadCart(origin, visualDir, weapon.range, shooter);
    const distance = Math.min(wallDistance ?? weapon.range, cartDistance ?? weapon.range);
    visualTracers.push({
      yaw: visualYaw,
      pitch: visualPitch,
      distance,
      x: origin.x + visualDir.x * distance,
      y: origin.y + visualDir.y * distance,
      z: origin.z + visualDir.z * distance
    });
  }

  broadcastGameEvent(shooter, "shot", {
    id: shooter.id,
    x: origin.x,
    y: origin.y,
    z: origin.z,
    yaw: shooter.yaw,
    pitch: shooter.pitch,
    weapon: shooter.weapon,
    bowCharge: shooter.weapon === "bow" ? bowCharge : undefined,
    action: shooter.weapon === "sword" ? "swing" : undefined,
    hit,
    tracers: visualTracers
  });
}

setInterval(() => {
  const now=Date.now();
  for(const p of players.values()){
    if(p.freezeLastHitAt && now-p.freezeLastHitAt>=500 && (p.freezeDecayAt||0)<=now){p.freezeChance=Math.max(0,(p.freezeChance||0)-5);p.freezeDecayAt=now+500;}
  }
  for (const p of players.values()) {
    if (p.burnUntil > now && (p.burnStartAt || 0) <= now && (p.burnNextAt || 0) <= now && p.health > 0) {
      const burnDamage = 8;
      const split = applyIncomingDamage(p, burnDamage);
      const attacker = players.get(p.burnSourceId);
      io.to(p.id).emit("damageTaken", { damage: Math.round(split.totalDamage), zone: "body" });
      if (attacker && attacker.id !== p.id && split.totalDamage > 0) {
        addUltimateCharge(attacker, burnDamage);
        io.to(attacker.id).emit("damageDealt", {
          targetId: p.id,
          damage: Math.round(split.totalDamage),
          shieldDamage: Math.round(split.shieldDamage),
          healthDamage: Math.round(split.healthDamage),
          zone: "body",
          x: p.x,
          y: p.y + (p.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) * 0.5,
          z: p.z
        });
      }
      if (p.health <= 0) {
        p.health = 0;
        p.respawnAt = now + 5000;
        p.kills = p.kills || 0;
        p.deaths = (p.deaths || 0) + 1;
        p.invisibleUntil = 0;
        if (p.riftDuelId) finishRiftDuel(p);
        if (attacker && attacker.id !== p.id) {
          attacker.health = Number(attacker.maxHealth) || 100;
        clearBurnStatus(attacker);
          attacker.kills = (attacker.kills || 0) + 1;
          if (p.mode === "Duel") resolveDuelRound(attacker, p);
          if (attacker.invisibleUntil > Date.now()) attacker.invisibleUntil = 0;
          broadcastGameEvent(attacker, "elimination", {
            killerId: attacker.id,
            killerName: attacker.name,
            victimId: p.id,
            victimName: p.name,
            killerKills: attacker.kills,
            zone: "body"
          });
        }
      }
      p.burnNextAt = now + 125;
    }
    if (p.burnUntil <= now) {
      p.burnExposure = 0;
      p.burnNextAt = 0;
      p.burnStartAt = 0;
      p.burnSourceId = null;
    }
  }
},125).unref?.();

function clearBurnStatus(player) {
  if (!player) return;
  player.burnUntil = 0;
  player.burnExposure = 0;
  player.burnNextAt = 0;
  player.burnStartAt = 0;
  player.burnSourceId = null;
}

function applyIncomingDamage(target, amount, isProjectile = false) {
  if (target.riftFirstHitProtected && Number(amount) > 0) {
    target.riftFirstHitProtected = false;
    return { shieldDamage: 0, healthDamage: 0, totalDamage: 0 };
  }
  let damage = Math.max(0, Number(amount) || 0);
  if (isProjectile && target.swordGuarding) damage *= 0.5;
  // 天墜で浮上している間は受けるダメージを75%軽減する。
  if (target.skyfallImpactId && target.ultimateActiveUntil > Date.now()) damage *= 0.25;
  let shieldDamage = 0;
  if (target.shield > 0 && damage > 0) {
    shieldDamage = Math.min(target.shield, damage);
    target.shield -= shieldDamage;
    damage -= shieldDamage;
  }
  const healthBefore = Math.max(0, Number(target.health) || 0);
  if (damage > 0) target.health = Math.max(0, healthBefore - damage);
  const healthDamage = Math.min(healthBefore, damage);
  if (target.health <= 0) {
    target.invisibleUntil = 0;
    finishRiftDuel(target);
    // 死亡時はミニガンのチャージ・予約射撃を破棄し、リスポーンへの持ち越しを防ぐ。
    target.minigunChargeStartedAt = 0;
    target.minigunBurstId = (target.minigunBurstId || 0) + 1;
    if (target.minigunFireTimer) clearTimeout(target.minigunFireTimer);
    target.minigunFireTimer = null;
    const magazineSize = WEAPONS[target.weapon]?.magazineSize || 0;
    target.ammo = magazineSize;
    if (Array.isArray(target.weaponAmmo)) target.weaponAmmo[target.activeWeaponSlot || 0] = magazineSize;
    target.reloadingUntil = 0;
    target.lastFire = 0;
  }
  return { shieldDamage, healthDamage, totalDamage: shieldDamage + healthDamage };
}

function publicPlayer(p, includeSkin = false) {
  return {
    id: p.id,
    mode: p.mode || MAP_MODE,
    team: p.team || null,
    role: p.role || null,
    matchId: p.matchId || null,
    finished: Boolean(p.finished),
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    crouched: Boolean(p.crouched),
    frozenUntil: Number(p.frozenUntil) || 0,
    name: p.name,
    invisible: Number(p.invisibleUntil) > Date.now(),
    health: p.health,
    maxHealth: Number(p.maxHealth) || 100,
    ultimateCharge: Math.min(100, Number(p.ultimateCharge) || 0),
    ultimateType: ["skyfall", "teleport", "aegis", "invisible", "rift", "tornado"].includes(p.ultimateType) ? p.ultimateType : "skyfall",
    shield: Math.max(0, Number(p.shield) || 0),
    ultimateActiveUntil: Number(p.ultimateActiveUntil) || 0,
    charm: ["hp", "speed", "reload", "jump", "floor", "aim", "ultimate", "body", "slide", "flight"].includes(p.charm) ? p.charm : "none",
    kills: p.kills,
    deaths: p.deaths,
    weapon: p.weapon,
    swordGuarding: Boolean(p.swordGuarding),
    weaponSlots: Array.isArray(p.weaponSlots) ? [...p.weaponSlots] : [p.weapon],
    activeWeaponSlot: Number(p.activeWeaponSlot) || 0,
    ammo: p.ammo,
    weaponAmmo: Array.isArray(p.weaponAmmo) ? [...p.weaponAmmo] : [p.ammo],
    reloading: p.reloadingUntil > Date.now(),
    respawnAt: p.respawnAt || 0,
    invulnerableUntil: p.invulnerableUntil || 0,
    damageHitstopUntil: p.damageHitstopUntil || 0,
    damageSlowUntil: p.damageSlowUntil || 0,
    isBot: Boolean(p.isBot),
    ...(includeSkin && p.skin ? { skin: p.skin } : {})
  };
}

function createAreaPlayer({ id, name, skin, weapon, secondaryWeapon, charm, ultimateType, team, matchId, isBot, botSpawnIndex = 0, mode = AREA_MODE, role = null }, spawn) {
  const now = Date.now();
  const safeCharm = !isBot && ["hp", "speed", "reload", "jump", "floor", "aim", "ultimate", "body", "slide", "flight"].includes(charm) ? charm : "none";
  const maxHealth = safeCharm === "hp" ? 120 : 100;
  return {
    id,
    name,
    skin: skin || "",
    mode,
    team,
    role,
    matchId,
    isBot: Boolean(isBot),
    finished: false,
    botSpawnIndex,
    botThinkAt: 0,
    botOffset: Math.random() * 1000,
    botTactic: ["push", "flank", "circle", "cautious", "aggressive"][Math.floor(Math.random() * 5)],
    botTacticUntil: 0,
    botStrafeSign: Math.random() < 0.5 ? -1 : 1,
    botAggression: 0.65 + Math.random() * 0.7,
    x: spawn[0],
    y: spawn[1] || 0,
    z: spawn[2],
    yaw: mode === PAYLOAD_MODE ? -Math.PI / 2 : (team === "blue" ? -Math.PI / 2 : Math.PI / 2),
    pitch: 0,
    health: maxHealth,
    maxHealth,
    ultimateCharge: 0,
    ultimateType: !isBot && ["skyfall", "teleport", "aegis", "invisible", "rift", "tornado"].includes(ultimateType) ? ultimateType : "skyfall",
    shield: 0,
    ultimateActiveUntil: 0,
    ultimateAnchor: null,
    skyfallImpactPending: false,
    charm: safeCharm,
    kills: 0,
    deaths: 0,
    weapon,
    weaponSlots: [weapon, secondaryWeapon],
    activeWeaponSlot: 0,
    ammo: WEAPONS[weapon].magazineSize,
    weaponAmmo: [WEAPONS[weapon].magazineSize, WEAPONS[secondaryWeapon].magazineSize],
    reloadingUntil: 0,
    lastFire: 0,
    velocityY: 0,
    grounded: true,
    lastGroundedAt: now,
    jumpQueuedUntil: 0,
    input: { forward: 0, strafe: 0, crouch: false },
    crouched: false,
    respawnAt: 0,
    invulnerableUntil: now + 3000,
    damageHitstopUntil: 0,
    damageSlowUntil: 0
  };
}

function createPayloadPlayer(options,spawn){
  const player = createAreaPlayer({...options,mode:PAYLOAD_MODE},spawn);
  player.botHasLeftRespawnArea = !getPayloadRespawnZoneAt(payloadMap, player.x, player.z);
  return player;
}

function areaQueueStatus() {
  const remainingMs = Math.max(0, AREA_QUEUE_DURATION_MS - (Date.now() - areaQueueStartedAt));
  return {
    waiting: areaQueue.length,
    required: 6,
    remainingMs,
    secondsRemaining: Math.ceil(remainingMs / 1000)
  };
}

function broadcastAreaQueueStatus() {
  const status = areaQueueStatus();
  for (const entry of areaQueue) {
    io.to(entry.socketId).emit("areaQueueStatus", status);
  }
}

function tryJoinExistingAreaMatch(socket, entry) {
  for (const match of areaMatches.values()) {
    if (match.finished || match.playerIds.length >= 6) continue;
    const botId = match.playerIds.find((id) => {
      const player = players.get(id);
      return player?.isBot && player.mode === AREA_MODE && player.matchId === match.id;
    });
    if (!botId) continue;

    const bot = players.get(botId);
    const spawn = [bot.x, bot.y, bot.z];
    const player = createAreaPlayer({
      id: socket.id,
      name: entry.name,
      skin: entry.skin,
      weapon: entry.weapon,
      secondaryWeapon: entry.secondaryWeapon,
      charm: entry.charm,
      ultimateType: entry.ultimateType,
      team: bot.team,
      matchId: match.id,
      isBot: false,
      lastPresenceAt: Date.now(),
      botSpawnIndex: 0
    }, spawn);
    players.delete(botId);
    const index = match.playerIds.indexOf(botId);
    if (index >= 0) match.playerIds[index] = socket.id;
    match.humanIds.push(socket.id);
    players.set(socket.id, player);

    socket.emit("world", getWorldPayloadForMap(areaMap, AREA_MODE));
    socket.emit("joined", { player: publicPlayer(player, true) });
    socket.emit("areaMatchStarted", {
      matchId: match.id,
      team: player.team,
      botCount: match.playerIds.filter((id) => players.get(id)?.isBot).length,
      map: getMapInfo(areaMap, AREA_MODE)
    });
    broadcastPlayers();
    sendAreaMatchState(match, true);
    console.log("[Area] BOTを新規参加者に置換:", match.id, "team:", player.team);
    return true;
  }
  return false;
}

function queueAreaPlayer(socket, data = {}) {
  if (players.has(socket.id)) {
    socket.emit("areaQueueError", { message: "現在の対戦を終了してからモードを変更してください。" });
    return;
  }
  if (areaQueue.some((entry) => entry.socketId === socket.id)) {
    socket.emit("areaQueueStatus", areaQueueStatus());
    return;
  }

  const entry = {
    socketId: socket.id,
    name: sanitizeName(data.name),
    skin: sanitizeSkin(data.skin),
    weapon: sanitizeWeapon(data.weapon),
    secondaryWeapon: sanitizeWeapon(data.secondaryWeapon),
    charm: ["hp", "speed", "reload", "jump", "floor", "aim", "ultimate", "body", "slide", "flight"].includes(data.charm) ? data.charm : "none",
    ultimateType: ["skyfall", "teleport", "aegis", "invisible", "rift", "tornado"].includes(data.ultimateType) ? data.ultimateType : "skyfall",
    queuedAt: Date.now()
  };
  if (entry.secondaryWeapon === entry.weapon) {
    entry.secondaryWeapon = entry.weapon === "rifle" ? "shotgun" : "rifle";
  }

  // 進行中のエリア戦が6人未満なら、待機列に入れずBOT枠へ即参加する。
  if (tryJoinExistingAreaMatch(socket, entry)) return;

  if (areaQueue.length === 0) {
    areaQueueStartedAt = Date.now();
    lastAreaQueueSecond = null;
  }
  areaQueue.push(entry);
  broadcastAreaQueueStatus();

  if (areaQueue.length >= 6) startAreaMatch(false);
}

function cancelAreaQueue(socketId) {
  const before = areaQueue.length;
  areaQueue = areaQueue.filter((entry) => entry.socketId !== socketId);
  if (areaQueue.length === 0) {
    areaQueueStartedAt = 0;
    lastAreaQueueSecond = null;
  } else {
    broadcastAreaQueueStatus();
  }
  if (before !== areaQueue.length) io.to(socketId).emit("areaQueueCancelled");
}

function startAreaMatch(fillWithBots) {
  const waiting = areaQueue.splice(0, 6).filter((entry) => io.sockets.sockets.has(entry.socketId));
  areaQueueStartedAt = 0;
  lastAreaQueueSecond = null;
  if (waiting.length === 0) return;

  const usedNames = new Set(waiting.map((entry) => entry.name.toLowerCase()));
  const availableBotNames = AREA_BOT_NAMES.filter((name) => !usedNames.has(name.toLowerCase()));
  for (let i = availableBotNames.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [availableBotNames[i], availableBotNames[j]] = [availableBotNames[j], availableBotNames[i]];
  }

  const participants = waiting.map((entry) => ({ ...entry, isBot: false }));
  if (fillWithBots || participants.length < 6) {
    while (participants.length < 6) {
      const name = availableBotNames.shift();
      if (!name) break;
      participants.push({
        socketId: null,
        name,
        skin: "",
        weapon: Math.random() < 0.7 ? "rifle" : "marksman",
        secondaryWeapon: "shotgun",
        isBot: true
      });
    }
  }

  // 人間プレイヤーを先に均等配分し、人間同士のチーム人数差を最大1人に抑える。
  const teamCounts = { blue: 0, red: 0 };
  for (const participant of participants.filter((entry) => !entry.isBot)) {
    const team = teamCounts.blue === teamCounts.red
      ? (Math.random() < 0.5 ? "blue" : "red")
      : (teamCounts.blue < teamCounts.red ? "blue" : "red");
    participant.team = team;
    teamCounts[team] += 1;
  }
  // 残りの枠は総人数の少ない側へBOTを配置し、最終的に各チーム3人にそろえる。
  for (const participant of participants.filter((entry) => entry.isBot)) {
    const team = teamCounts.blue === teamCounts.red
      ? (Math.random() < 0.5 ? "blue" : "red")
      : (teamCounts.blue < teamCounts.red ? "blue" : "red");
    participant.team = team;
    teamCounts[team] += 1;
  }

  if (participants.length < 2) {
    for (const entry of waiting) io.to(entry.socketId).emit("areaQueueError", { message: "対戦相手を用意できませんでした。もう一度お試しください。" });
    return;
  }

  const matchId = "area-" + Date.now() + "-" + (++areaMatchSequence);
  const match = {
    id: matchId,
    playerIds: [],
    humanIds: waiting.map((entry) => entry.socketId),
    scores: { blue: 0, red: 0 },
    ownerTeam: null,
    captureTeam: null,
    captureStartedAt: 0,
    lastStateAt: 0,
    finished: false,
    winnerTeam: null
  };
  areaMatches.set(matchId, match);

  const teamSpawnCounts = { blue: 0, red: 0 };
  participants.forEach((entry, index) => {
    const team = entry.team || (index % 2 === 0 ? "blue" : "red");
    const teamSpawns = areaMap.teamSpawnPoints?.[team] || areaMap.spawnPoints;
    const spawnIndex = teamSpawnCounts[team]++;
    const spawn = teamSpawns[spawnIndex % teamSpawns.length];
    const id = entry.isBot ? "bot:" + matchId + ":" + index : entry.socketId;
    const player = createAreaPlayer({
      id,
      name: entry.name,
      skin: entry.skin,
      weapon: entry.weapon,
      secondaryWeapon: entry.secondaryWeapon,
      charm: entry.charm,
      ultimateType: entry.ultimateType,
      team,
      matchId,
      isBot: entry.isBot,
      botSpawnIndex: spawnIndex
    }, spawn);
    players.set(id, player);
    match.playerIds.push(id);

    if (!entry.isBot) {
      const client = io.sockets.sockets.get(entry.socketId);
      if (client) {
        client.emit("world", getWorldPayloadForMap(areaMap, AREA_MODE));
        client.emit("joined", { player: publicPlayer(player, true) });
        client.emit("areaMatchStarted", {
          matchId,
          team,
          botCount: participants.filter((participant) => participant.isBot).length,
          map: getMapInfo(areaMap, AREA_MODE)
        });
      }
    }
  });

  broadcastPlayers();
  sendAreaMatchState(match, true);
  console.log("[Area] 試合開始:", matchId, "players:", participants.length, "bots:", participants.filter((p) => p.isBot).length);
}

function sendAreaMatchState(match, force = false) {
  if (!match || match.finished) return;
  const now = Date.now();
  if (!force && now - match.lastStateAt < 200) return;
  match.lastStateAt = now;

  const zone = areaMap.areaZone;
  const occupants = match.playerIds
    .map((id) => players.get(id))
    .filter((player) => player && player.health > 0 && !player.finished &&
      Math.hypot(player.x - zone.x, player.z - zone.z) <= zone.radius);
  const blueInZone = occupants.filter((p) => p.team === "blue").length;
  const redInZone = occupants.filter((p) => p.team === "red").length;
  const state = {
    matchId: match.id,
    scores: { blue: Number(match.scores.blue.toFixed(2)), red: Number(match.scores.red.toFixed(2)) },
    blueInZone,
    redInZone,
    ownerTeam: match.ownerTeam,
    captureTeam: match.captureTeam,
    // holdTeam remains available for older client code; it represents the team currently taking the zone,
    // or the owner when nobody is challenging it.
    holdTeam: match.captureTeam || match.ownerTeam,
    holdRemainingMs: match.captureTeam
      ? Math.max(0, AREA_CONTROL_HOLD_MS - (now - match.captureStartedAt))
      : 0,
    status: blueInZone && redInZone ? "contested"
      : occupants.length === 0 ? (match.ownerTeam ? "owned-empty" : "empty")
      : match.captureTeam ? "taking"
      : match.ownerTeam ? "owned" : "holding"
  };
  for (const socketId of match.humanIds) io.to(socketId).emit("areaState", state);
}

function finishAreaMatch(match, winnerTeam) {
  if (!match || match.finished) return;
  match.finished = true;
  match.winnerTeam = winnerTeam;
  for (const id of match.playerIds) {
    const player = players.get(id);
    if (!player) continue;
    player.finished = true;
    player.input = { forward: 0, strafe: 0, crouch: false };
    player.jumpQueuedUntil = 0;
    player.respawnAt = 0;
  }

  for (const socketId of match.humanIds) {
    const player = players.get(socketId);
    if (!player) continue;
    io.to(socketId).emit("areaMatchEnd", {
      matchId: match.id,
      won: player.team === winnerTeam,
      team: player.team,
      winnerTeam,
      scores: { blue: Math.min(100, match.scores.blue), red: Math.min(100, match.scores.red) },
      kills: player.kills,
      deaths: player.deaths
    });
  }
  broadcastPlayers();
  console.log("[Area] 試合終了:", match.id, "winner:", winnerTeam);
}

function updateAreaMatches(dt, now) {
  for (const match of areaMatches.values()) {
    if (match.finished) continue;
    const zone = areaMap.areaZone;
    const occupants = match.playerIds
      .map((id) => players.get(id))
      .filter((player) => player && player.health > 0 && !player.finished &&
        Math.hypot(player.x - zone.x, player.z - zone.z) <= zone.radius);
    const presentTeams = new Set(occupants.map((player) => player.team));
    const soloTeam = presentTeams.size === 1 ? occupants[0].team : null;

    // 所有権がない、または相手が占領中の場合は、片方のチームだけが5秒間いると所有権を取得。
    // エリアが空、あるいは両チームが争っている間は所有権を維持し、奪取タイマーだけをリセットします。
    if (soloTeam && soloTeam !== match.ownerTeam) {
      if (match.captureTeam !== soloTeam) {
        match.captureTeam = soloTeam;
        match.captureStartedAt = now;
      }
      if (now - match.captureStartedAt >= AREA_CONTROL_HOLD_MS) {
        const previousOwner = match.ownerTeam;
        match.ownerTeam = soloTeam;
        match.captureTeam = null;
        match.captureStartedAt = 0;
        console.log("[Area] エリアを奪取:", match.id, previousOwner || "なし", "->", soloTeam);
      }
    } else {
      match.captureTeam = null;
      match.captureStartedAt = 0;
    }

    // 一度確保したチームの得点は、エリアが無人でも継続する。
    // カウントが止まるのは、相手チームが5秒間単独で確保して所有権を奪ったときだけ。
    if (match.ownerTeam) {
      match.scores[match.ownerTeam] = Math.min(
        100,
        match.scores[match.ownerTeam] + dt / (AREA_PROGRESS_PER_PERCENT_MS / 1000)
      );
      if (match.scores[match.ownerTeam] >= 100) {
        const winnerTeam = match.ownerTeam;
        match.scores[winnerTeam] = 100;
        sendAreaMatchState(match, true);
        finishAreaMatch(match, winnerTeam);
        continue;
      }
    }
    sendAreaMatchState(match);
  }
}

function removeAreaPlayer(socketId) {
  const player = players.get(socketId);
  if (!player || player.mode !== AREA_MODE) return;
  const match = areaMatches.get(player.matchId);
  players.delete(socketId);
  if (!match) {
    io.to(socketId).emit("areaReturnToModeSelect");
    broadcastPlayers();
    return;
  }

  match.playerIds = match.playerIds.filter((id) => id !== socketId);
  match.humanIds = match.humanIds.filter((id) => id !== socketId);
  io.to(socketId).emit("areaReturnToModeSelect");

  if (match.humanIds.length === 0) {
    for (const id of match.playerIds) players.delete(id);
    areaMatches.delete(match.id);
  }
  broadcastPlayers();
}


const PAYLOAD_BOT_NAMES=["Avery","Ethan","Mason","Logan","Eli","Mila","Aria","Leo","Ivy","Ezra","Nora","Kai"];
const PAYLOAD_ROUND_TIME_MS=480000,PAYLOAD_CAPTURE_RADIUS=9;
function payloadQueueStatus(){const remainingMs=Math.max(0,AREA_QUEUE_DURATION_MS-(Date.now()-payloadQueueStartedAt));return{waiting:payloadQueue.length,required:6,remainingMs,secondsRemaining:Math.ceil(remainingMs/1000)};}
function broadcastPayloadQueueStatus(){const status=payloadQueueStatus();for(const e of payloadQueue)io.to(e.socketId).emit("payloadQueueStatus",status);}
function buildPayloadQueueEntry(socket,data={}){const weapon=sanitizeWeapon(data.weapon);let secondaryWeapon=sanitizeWeapon(data.secondaryWeapon);if(secondaryWeapon===weapon)secondaryWeapon=weapon==="rifle"?"shotgun":"rifle";return{socketId:socket.id,reconnectToken:typeof data.reconnectToken==="string"?data.reconnectToken.slice(0,128):"",name:sanitizeName(data.name),skin:sanitizeSkin(data.skin),weapon,secondaryWeapon,charm:["hp","speed","reload","jump","floor","aim","ultimate","body","slide","flight"].includes(data.charm)?data.charm:"none",ultimateType:["skyfall","teleport","aegis"].includes(data.ultimateType)?data.ultimateType:"skyfall",queuedAt:Date.now()};}
function tryJoinExistingPayloadMatch(socket,entry){for(const match of payloadMatches.values()){if(match.finished||match.playerIds.length>=6)continue;const counts={blue:0,red:0};for(const id of match.humanIds){const p=players.get(id);if(p?.team)counts[p.team]++;}const order=counts.blue===counts.red?["blue","red"]:[counts.blue<counts.red?"blue":"red"];let botId=null;for(const team of order){botId=match.playerIds.find(id=>{const p=players.get(id);return p?.isBot&&p.mode===PAYLOAD_MODE&&p.team===team;});if(botId)break;}if(!botId)continue;const bot=players.get(botId);const player=createPayloadPlayer({id:socket.id,name:entry.name,skin:entry.skin,weapon:entry.weapon,secondaryWeapon:entry.secondaryWeapon,charm:entry.charm,ultimateType:entry.ultimateType,team:bot.team,role:bot.role,matchId:match.id,isBot:false},[bot.x,bot.y,bot.z]);player.reconnectToken=entry.reconnectToken;players.delete(botId);match.playerIds[match.playerIds.indexOf(botId)]=socket.id;match.humanIds.push(socket.id);players.set(socket.id,player);socket.emit("world",getWorldPayloadForMap(payloadMap,PAYLOAD_MODE));socket.emit("joined",{player:publicPlayer(player,true)});socket.emit("payloadMatchStarted",{matchId:match.id,team:player.team,role:player.role,botCount:match.playerIds.filter(id=>players.get(id)?.isBot).length,map:getMapInfo(payloadMap,PAYLOAD_MODE)});broadcastPlayers();sendPayloadMatchState(match,true);return true;}return false;}
function queuePayloadPlayer(socket,data={}){if(players.has(socket.id)){socket.emit("payloadQueueError",{message:"現在の対戦を終了してからモードを変更してください。"});return;}if(payloadQueue.some(e=>e.socketId===socket.id)){socket.emit("payloadQueueStatus",payloadQueueStatus());return;}const entry=buildPayloadQueueEntry(socket,data);if(entry.reconnectToken){const pending=pendingPayloadDisconnects.get(entry.reconnectToken);const oldPlayer=pending&&players.get(pending.playerId);const match=oldPlayer&&payloadMatches.get(oldPlayer.matchId);if(oldPlayer&&match&&!match.finished&&oldPlayer.mode===PAYLOAD_MODE&&oldPlayer.disconnectedAt&&Date.now()-oldPlayer.disconnectedAt<=PAYLOAD_RECONNECT_GRACE_MS){clearTimeout(pending.timer);pendingPayloadDisconnects.delete(entry.reconnectToken);players.delete(oldPlayer.id);oldPlayer.id=socket.id;oldPlayer.disconnectedAt=0;oldPlayer.reconnectToken=entry.reconnectToken;players.set(socket.id,oldPlayer);match.playerIds=match.playerIds.map(id=>id===pending.playerId?socket.id:id);match.humanIds=match.humanIds.map(id=>id===pending.playerId?socket.id:id);socket.emit("world",getWorldPayloadForMap(payloadMap,PAYLOAD_MODE));socket.emit("joined",{player:publicPlayer(oldPlayer,true)});socket.emit("payloadMatchStarted",{matchId:match.id,team:oldPlayer.team,role:oldPlayer.role,botCount:match.playerIds.filter(id=>players.get(id)?.isBot).length,map:getMapInfo(payloadMap,PAYLOAD_MODE)});broadcastPlayers();sendPayloadMatchState(match,true);console.log("[Payload] 切断前の試合へ復帰:",match.id);return;}}if(tryJoinExistingPayloadMatch(socket,entry))return;if(!payloadQueue.length){payloadQueueStartedAt=Date.now();lastPayloadQueueSecond=null;}payloadQueue.push(entry);broadcastPayloadQueueStatus();if(payloadQueue.length>=6)startPayloadMatch(false);}
function cancelPayloadQueue(socketId){const before=payloadQueue.length;payloadQueue=payloadQueue.filter(e=>e.socketId!==socketId);if(!payloadQueue.length){payloadQueueStartedAt=0;lastPayloadQueueSecond=null;}else broadcastPayloadQueueStatus();if(before!==payloadQueue.length)io.to(socketId).emit("payloadQueueCancelled");}
function startPayloadMatch(fillWithBots){const waiting=payloadQueue.splice(0,6).filter(e=>io.sockets.sockets.has(e.socketId));payloadQueueStartedAt=0;lastPayloadQueueSecond=null;if(!waiting.length)return;const used=new Set(waiting.map(e=>e.name.toLowerCase())),names=PAYLOAD_BOT_NAMES.filter(n=>!used.has(n.toLowerCase()));for(let i=names.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[names[i],names[j]]=[names[j],names[i]];}const parts=waiting.map(e=>({...e,isBot:false}));while((fillWithBots||parts.length<6)&&parts.length<6)parts.push({socketId:null,name:names.shift()||("Payload BOT "+(parts.length+1)),skin:"",weapon:Math.random()<.65?"rifle":"marksman",secondaryWeapon:"shotgun",charm:"none",ultimateType:"skyfall",isBot:true});const counts={blue:0,red:0};for(const p of parts.filter(p=>!p.isBot)){const t=counts.blue===counts.red?(Math.random()<.5?"blue":"red"):counts.blue<counts.red?"blue":"red";p.team=t;counts[t]++;}for(const p of parts.filter(p=>p.isBot)){const t=counts.blue===counts.red?(Math.random()<.5?"blue":"red"):counts.blue<counts.red?"blue":"red";p.team=t;counts[t]++;}const attackingTeam=Math.random()<.5?"blue":"red",matchId="payload-"+Date.now()+"-"+(++payloadMatchSequence);const match={id:matchId,playerIds:[],humanIds:waiting.map(e=>e.socketId),attackingTeam,defendingTeam:attackingTeam==="blue"?"red":"blue",progress:0,checkpointIndex:0,startedAt:Date.now(),lastStateAt:0,finished:false,overtime:false,status:"playing"};payloadMatches.set(matchId,match);const indexes={blue:0,red:0};parts.forEach((e,i)=>{const role=e.team===attackingTeam?"attack":"defense",id=e.isBot?"bot:"+matchId+":"+i:e.socketId,spawn=getPayloadSpawnPoint({matchId,role},indexes[e.team]++),p=createPayloadPlayer({id,name:e.name,skin:e.skin,weapon:e.weapon,secondaryWeapon:e.secondaryWeapon,charm:e.charm,ultimateType:e.ultimateType,team:e.team,role,matchId,isBot:e.isBot,botSpawnIndex:indexes[e.team]-1},spawn);p.reconnectToken=e.reconnectToken||"";players.set(id,p);match.playerIds.push(id);if(!e.isBot){const c=io.sockets.sockets.get(e.socketId);if(c){c.emit("world",getWorldPayloadForMap(payloadMap,PAYLOAD_MODE));c.emit("joined",{player:publicPlayer(p,true)});c.emit("payloadMatchStarted",{matchId,team:p.team,role:p.role,botCount:parts.filter(q=>q.isBot).length,map:getMapInfo(payloadMap,PAYLOAD_MODE)});}}});broadcastPlayers();sendPayloadMatchState(match,true);console.log("[Payload] 試合開始:",matchId);}
function sendPayloadMatchState(match,force=false){if(!match||match.finished)return;const now=Date.now();if(!force&&now-match.lastStateAt<150)return;match.lastStateAt=now;const cart=getPayloadPointAtDistance(match.progress),near=match.playerIds.map(id=>players.get(id)).filter(p=>p&&p.health>0&&!p.finished&&!p.disconnectedAt&&Math.hypot(p.x-cart.x,p.z-cart.z)<=PAYLOAD_CAPTURE_RADIUS),attackers=near.filter(p=>p.team===match.attackingTeam).length,defenders=near.filter(p=>p.team===match.defendingTeam).length,total=getPayloadTrackLength();const state={matchId:match.id,progress:total?Math.min(100,match.progress/total*100):0,distance:match.progress,totalDistance:total,cart,attackingTeam:match.attackingTeam,defendingTeam:match.defendingTeam,attackers,defenders,timeRemainingMs:Math.max(0,PAYLOAD_ROUND_TIME_MS-(now-match.startedAt)),overtime:match.overtime,checkpointIndex:match.checkpointIndex,status:attackers&&defenders?"contested":attackers?"pushing":"stalled"};for(const id of match.humanIds)io.to(id).emit("payloadState",state);}
function finishPayloadMatch(match,winnerTeam){if(!match||match.finished)return;match.finished=true;const winnerRole=winnerTeam===match.attackingTeam?"attack":"defense";for(const id of match.playerIds){const p=players.get(id);if(p){p.finished=true;p.input={forward:0,strafe:0,crouch:false};p.jumpQueuedUntil=0;p.respawnAt=0;}}for(const id of match.humanIds){const p=players.get(id);if(p)io.to(id).emit("payloadMatchEnd",{matchId:match.id,won:p.role===winnerRole,team:p.team,role:p.role,winnerRole,progress:Math.min(100,match.progress/getPayloadTrackLength()*100),kills:p.kills,deaths:p.deaths});}broadcastPlayers();}
function updatePayloadMatches(dt, now) {
  const total = getPayloadTrackLength();
  for (const m of payloadMatches.values()) {
    if (m.finished) continue;
    m.payloadUpdateTick = (m.payloadUpdateTick || 0) + 1;
    if (m.payloadUpdateTick % 2 !== 0) continue;

    const stepDt = dt * 2;
    const cart = getPayloadPointAtDistance(m.progress);
    const near = m.playerIds
      .map((id) => players.get(id))
      .filter((p) => p && p.health > 0 && !p.finished && !p.disconnectedAt &&
        Math.hypot(p.x - cart.x, p.z - cart.z) <= PAYLOAD_CAPTURE_RADIUS);
    const a = near.filter((p) => p.team === m.attackingTeam).length;
    const d = near.filter((p) => p.team === m.defendingTeam).length;

    if (a > 0 && !d) {
      m.progress = Math.min(total, m.progress + (1.68 + Math.max(0, Math.min(2, a - 1)) * 0.336) * stepDt);
    } else if (d > a) {
      m.progress = Math.max(0, m.progress - (1.68 + Math.max(0, Math.min(2, d - 1)) * 0.336) / 6 * stepDt);
    }

    // 経過時間の割合とペイロード進行率を比較し、遅れている側に逆転用チャージを付与。
    const elapsedPercent = clamp((now - m.startedAt) / PAYLOAD_ROUND_TIME_MS * 100, 0, 100);
    const progressPercent = total > 0 ? clamp(m.progress / total * 100, 0, 100) : 0;
    const losingTeam = progressPercent < elapsedPercent
      ? m.attackingTeam
      : progressPercent > elapsedPercent
        ? m.defendingTeam
        : null;

    if (losingTeam) {
      if (m.comebackChargeTeam !== losingTeam) {
        m.comebackChargeTeam = losingTeam;
        m.comebackChargeElapsedMs = 0;
      }
      m.comebackChargeElapsedMs = (m.comebackChargeElapsedMs || 0) + stepDt * 1000;
      while (m.comebackChargeElapsedMs >= 2000) {
        m.comebackChargeElapsedMs -= 2000;
        for (const id of m.playerIds) {
          const p = players.get(id);
          if (p && p.team === losingTeam && p.health > 0 && !p.finished) {
            p.ultimateCharge = Math.min(100, (p.ultimateCharge || 0) + 7);
          }
        }
      }
    } else {
      m.comebackChargeTeam = null;
      m.comebackChargeElapsedMs = 0;
    }

    const cps = payloadMap.payloadCheckpointDistances || [];
    while (m.checkpointIndex + 1 < cps.length && m.progress >= cps[m.checkpointIndex + 1]) {
      m.checkpointIndex++;
      for (const id of m.playerIds) {
        const p = players.get(id);
        if (p && !p.isBot) {
          p.ultimateCharge = Math.min(100, (p.ultimateCharge || 0) + 10);
          io.to(id).emit("payloadCheckpoint", { checkpointIndex: m.checkpointIndex });
        }
      }
    }

    if (m.progress >= total) {
      m.progress = total;
      sendPayloadMatchState(m, true);
      finishPayloadMatch(m, m.attackingTeam);
      continue;
    }

    const expired = now - m.startedAt >= PAYLOAD_ROUND_TIME_MS;
    const onCart = near.some((p) => p.team === m.attackingTeam);
    if (expired && !onCart) {
      sendPayloadMatchState(m, true);
      finishPayloadMatch(m, m.defendingTeam);
      continue;
    }
    if (expired) m.overtime = true;
    if (m.overtime && !onCart) {
      sendPayloadMatchState(m, true);
      finishPayloadMatch(m, m.defendingTeam);
      continue;
    }
    sendPayloadMatchState(m);
  }
}
function removePayloadPlayer(socketId){cancelPayloadQueue(socketId);const player=players.get(socketId);if(!player||player.mode!==PAYLOAD_MODE){io.to(socketId).emit("payloadReturnToModeSelect");return;}const match=payloadMatches.get(player.matchId);players.delete(socketId);if(!match){io.to(socketId).emit("payloadReturnToModeSelect");broadcastPlayers();return;}match.playerIds=match.playerIds.filter(id=>id!==socketId);match.humanIds=match.humanIds.filter(id=>id!==socketId);io.to(socketId).emit("payloadReturnToModeSelect");if(!match.humanIds.length){for(const id of match.playerIds)players.delete(id);payloadMatches.delete(match.id);}else if(!match.finished){const id="bot:"+match.id+":replacement:"+Date.now(),bot=createPayloadPlayer({id,name:PAYLOAD_BOT_NAMES[Math.floor(Math.random()*PAYLOAD_BOT_NAMES.length)],weapon:"rifle",secondaryWeapon:"shotgun",team:player.team,role:player.role,matchId:match.id,isBot:true},[player.x,player.y,player.z]);players.set(id,bot);match.playerIds.push(id);}broadcastPlayers();sendPayloadMatchState(match,true);}

function removeTrainingBots(matchId) {
  for (const [id, player] of players) {
    if (player.isBot && player.mode === TRAINING_MODE && player.matchId === matchId) players.delete(id);
  }
}

function createTrainingBotsForPlayer(player) {
  if (!player || player.mode !== TRAINING_MODE) return;
  const trainingMap = player.trainingMap || activeMap;
  const candidates = trainingMap.spawnPoints
    .filter((spawn) => Math.hypot(spawn[0] - player.x, spawn[2] - player.z) >= 7)
    .sort((a, b) => Math.hypot(a[0] - player.x, a[2] - player.z) - Math.hypot(b[0] - player.x, b[2] - player.z));
  const targetSpawns = candidates.length
    ? candidates.slice(0, 4)
    : [[player.x + 5, 0, player.z - 5], [player.x - 5, 0, player.z - 5], [player.x + 5, 0, player.z + 5], [player.x - 5, 0, player.z + 5]];
  targetSpawns.forEach((spawn, index) => {
    const id = "training-bot:" + player.id + ":" + index;
    players.set(id, {
      id, name: "練習BOT " + (index + 1), skin: "", mode: TRAINING_MODE,
      team: null, matchId: player.matchId, trainingMap: player.trainingMap || activeMap, finished: false, isBot: true,
      x: spawn[0], y: spawn[1] || 0, z: spawn[2],
      spawnX: spawn[0], spawnY: spawn[1] || 0, spawnZ: spawn[2],
      yaw: Math.atan2(-(player.x - spawn[0]), -(player.z - spawn[2])), pitch: 0,
      health: 100, kills: 0, deaths: 0, weapon: "rifle",
      weaponSlots: ["rifle", "marksman"], activeWeaponSlot: 0,
      ammo: WEAPONS.rifle.magazineSize,
      weaponAmmo: [WEAPONS.rifle.magazineSize, WEAPONS.marksman.magazineSize],
      reloadingUntil: 0, lastFire: 0, velocityY: 0, grounded: true,
      lastGroundedAt: Date.now(), jumpQueuedUntil: 0,
      input: { forward: 0, strafe: 0, crouch: false }, crouched: false,
      respawnAt: 0, invulnerableUntil: 0, damageHitstopUntil: 0, damageSlowUntil: 0
    });
  });
}

io.on("connection", (socket) => {
  socket.emit("world", getWorldPayload());
  socket.emit("mapRotationStatus", getMapRotationStatus());

  const initialMapChangeRemaining = nextMapChangeAt - Date.now();
  if (initialMapChangeRemaining > 0 && initialMapChangeRemaining <= MAP_CHANGE_COUNTDOWN_MS) {
    socket.emit("mapChangeCountdown", {
      seconds: Math.max(1, Math.ceil(initialMapChangeRemaining / 1000)),
      nextMap: getMapInfo(getNextMap())
    });
  }

  socket.on("getWanderMaps", () => {
    const maps = [...availableMaps, ...areaMaps, ...payloadMaps].map((map) => ({
      id: map.id,
      name: map.name,
      mode: Array.isArray(map.payloadPath) ? PAYLOAD_MODE : map === areaMap ? AREA_MODE : MAP_MODE
    }));
    maps.push({ id: "shooting-range", name: "射撃場", mode: TRAINING_MODE });
    socket.emit("wanderMaps", maps);
  });

  socket.on("joinAreaQueue", (data = {}) => {
    queueAreaPlayer(socket, data);
  });

  socket.on("cancelAreaQueue", () => {
    cancelAreaQueue(socket.id);
  });

  socket.on("leaveAreaMatch", () => {
    removeAreaPlayer(socket.id);
  });
  socket.on("joinPayloadQueue", (data = {}) => queuePayloadPlayer(socket, data));
  socket.on("cancelPayloadQueue", () => cancelPayloadQueue(socket.id));
  socket.on("leavePayloadMatch", () => removePayloadPlayer(socket.id));


  function emitDuelRooms(){
    const rooms=[...duelRooms.values()].filter(r=>r.status==="waiting"&&r.playerIds.length===1).map(r=>({id:r.id,hostName:r.hostName,mapId:r.mapId,mapName:r.mapName,firstTo:r.firstTo}));
    for(const client of io.sockets.sockets.values())client.emit("duel:rooms",rooms);
  }
  socket.on("duel:getMaps",()=>socket.emit("duel:maps",[...availableMaps,...areaMaps].filter(m=>m.id!=="shooting-range").map(m=>({id:m.id,name:m.name}))));
  socket.on("duel:listRooms",()=>emitDuelRooms());
  socket.on("duel:createRoom",(data={})=>{
    if(players.has(socket.id))return;
    const map=[...availableMaps,...areaMaps].find(m=>m.id===data.mapId&&m.id!=="shooting-range");
    if(!map){socket.emit("duel:error",{message:"選択したマップは利用できません。"});return;}
    for(const [id,r] of duelRooms)if(r.playerIds.includes(socket.id))duelRooms.delete(id);
    const firstTo=Math.max(1,Math.min(10,Math.floor(Number(data.firstTo)||3)));
    const id="duel-"+Date.now().toString(36)+"-"+(++duelRoomSequence).toString(36);
    const room={id,hostId:socket.id,hostName:sanitizeName(data.name),mapId:map.id,mapName:map.name,firstTo,playerIds:[socket.id],status:"waiting",scores:{},readyIds:[],roundResolved:false};
    duelRooms.set(id,room);socket.emit("duel:roomCreated",{room:{id,mapId:map.id,mapName:map.name,firstTo}});emitDuelRooms();
  });
  socket.on("duel:joinRoom",({roomId}={})=>{
    if(players.has(socket.id))return;const room=duelRooms.get(String(roomId||""));
    if(!room||room.status!=="waiting"||room.playerIds.length!==1||room.playerIds.includes(socket.id)){socket.emit("duel:error",{message:"この部屋には参加できません。部屋一覧を更新してください。"});emitDuelRooms();return;}
    room.playerIds.push(socket.id);room.status="starting";
    for(const id of room.playerIds)io.to(id).emit("duel:matchReady",{roomId:room.id,mapId:room.mapId,firstTo:room.firstTo});
    emitDuelRooms();
  });
  function removeDuelPlayer(playerId,roomId){const room=duelRooms.get(String(roomId||""));if(!room)return;room.playerIds=room.playerIds.filter(id=>id!==playerId);
    if(!room.playerIds.length||room.status!=="waiting"){for(const id of room.playerIds)io.to(id).emit("duel:error",{message:"対戦相手が退出しました。"});duelRooms.delete(room.id);}emitDuelRooms();}
  socket.on("duel:cancelRoom",()=>{for(const [id,r] of duelRooms){if(r.playerIds.includes(socket.id)){for(const other of r.playerIds)if(other!==socket.id)io.to(other).emit("duel:error",{message:"部屋の作成者が退出しました。"});duelRooms.delete(id);}}emitDuelRooms();socket.emit("returnedToLobby");});
  socket.on("duel:requestRuleChange",({roomId}={})=>{const r=duelRooms.get(String(roomId||""));if(!r||r.status!=="ended")return;for(const id of r.playerIds)io.to(id).emit("duel:ruleChangeAllowed",{host:socket.id===r.hostId});});
  socket.on("duel:updateRules",({roomId,mapId,firstTo}={})=>{const r=duelRooms.get(String(roomId||""));const map=[...availableMaps,...areaMaps].find(m=>m.id===mapId&&m.id!=="shooting-range");if(!r||r.hostId!==socket.id||r.status!=="ended"||!map){socket.emit("duel:error",{message:"ルールを変更できません。"});return;}r.mapId=map.id;r.mapName=map.name;r.firstTo=Math.max(1,Math.min(10,Math.floor(Number(firstTo)||3)));r.readyIds=[];for(const id of r.playerIds)io.to(id).emit("duel:rulesChanged",{mapName:r.mapName,firstTo:r.firstTo});});
  socket.on("duel:rematchReady",({roomId}={})=>{const r=duelRooms.get(String(roomId||""));if(!r||r.status!=="ended")return;if(!r.readyIds.includes(socket.id))r.readyIds.push(socket.id);for(const id of r.playerIds)io.to(id).emit("duel:rematchWaiting",{readyCount:r.readyIds.length});if(r.playerIds.every(id=>r.readyIds.includes(id))){const map=[...availableMaps,...areaMaps].find(m=>m.id===r.mapId)||activeMap;r.status="starting";r.scores={};r.readyIds=[];r.roundResolved=false;const now=Date.now();for(const id of r.playerIds){const p=players.get(id);if(!p)continue;const index=r.playerIds.indexOf(id);const spawn=map.spawnPoints[index%map.spawnPoints.length]||map.spawnPoints[0];p.duelMap=map;p.duelFirstTo=r.firstTo;p.finished=false;p.health=Number(p.maxHealth)||100;p.x=spawn[0];p.y=spawn[1]||0;p.z=spawn[2];p.yaw=index===0?0:Math.PI;p.pitch=0;p.respawnAt=0;p.invulnerableUntil=now+3000;p.ammo=WEAPONS[p.weapon].magazineSize;if(Array.isArray(p.weaponAmmo))p.weaponAmmo[p.activeWeaponSlot||0]=p.ammo;p.reloadingUntil=0;p.lastFire=0;}r.status="playing";for(const id of r.playerIds)io.to(id).emit("duel:rematchStarted",{firstTo:r.firstTo});for(const id of r.playerIds){const p=players.get(id);if(p)io.to(id).emit("world",getWorldPayloadForMap(map,"Duel"));}broadcastPlayers();}});
  socket.on("leaveMatch", (ack) => {
    const player = players.get(socket.id);
    if (player?.minigunFireTimer) clearTimeout(player.minigunFireTimer);
    if (player) player.minigunBurstId = (player.minigunBurstId || 0) + 1;
    if (player?.mode === AREA_MODE) {
      removeAreaPlayer(socket.id);
      if (typeof ack === "function") ack({ ok: true });
      return;
    }
    // 明示的な退出（アプリを閉じた場合を含む）は再接続猶予を設けず、即座に人数から除外する。
    if (player?.mode === PAYLOAD_MODE) {
      const token = typeof player.reconnectToken === "string" ? player.reconnectToken : "";
      const pending = token && pendingPayloadDisconnects.get(token);
      if (pending?.playerId === socket.id) {
        clearTimeout(pending.timer);
        pendingPayloadDisconnects.delete(token);
      }
      removePayloadPlayer(socket.id);
      if (typeof ack === "function") ack({ ok: true });
      return;
    }
    if (player?.mode === TRAINING_MODE) removeTrainingBots(player.matchId);
    if (player?.mode === "Wander") players.delete("bot:wander:" + player.matchId);
    if (player?.mode === "Duel") removeDuelPlayer(socket.id, player.duelRoomId);
    if (player) players.delete(socket.id);
    if (player?.mode === BUILD_MODE) syncBuildBots(player.matchId);
    syncBots();
    broadcastPlayers();
    socket.emit("returnedToLobby");
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("join", (data = {}) => {
    if (players.has(socket.id)) return;

    const weapon = sanitizeWeapon(data.weapon);
    let secondaryWeapon = sanitizeWeapon(data.secondaryWeapon);
    if (secondaryWeapon === weapon) {
      secondaryWeapon = weapon === "sniper" ? "rifle"
        : weapon === "marksman" ? "shotgun"
        : weapon === "shotgun" ? "rifle"
        : weapon === "rifle" ? "shotgun" : "rifle";
    }
    const weaponSlots = [weapon, secondaryWeapon];
    const charm = ["hp", "speed", "reload", "jump", "floor", "aim", "ultimate", "body", "slide", "flight"].includes(data.charm) ? data.charm : "none";
    const maxHealth = charm === "hp" ? 120 : 100;
    const name = sanitizeName(data.name);
    const skin = sanitizeSkin(data.skin);
    const duelRoom=data.mode==="Duel"?duelRooms.get(String(data.duelRoomId||"")):null;
    if(data.mode==="Duel"&&(!duelRoom||!duelRoom.playerIds.includes(socket.id))){socket.emit("duel:error",{message:"タイマン部屋が見つかりません。"});return;}
    const requestedMode = data.mode === "Duel" ? "Duel" : data.mode === TRAINING_MODE ? TRAINING_MODE : data.mode === BUILD_MODE ? BUILD_MODE : data.mode === "Wander" ? "Wander" : MAP_MODE;
    const duelMap=requestedMode==="Duel"?[...availableMaps,...areaMaps].find(m=>m.id===duelRoom.mapId)||activeMap:null;
    const trainingMap = requestedMode === TRAINING_MODE ? createTrainingMap() : null;
    const buildMap = requestedMode === BUILD_MODE ? createBuildMap() : null;
    const wanderMap = requestedMode === "Wander"
      ? (data.mapId === "shooting-range" ? createTrainingMap() : [...availableMaps, ...areaMaps, ...payloadMaps].find((map) => map.id === data.mapId) || activeMap)
      : null;
    const chosenMap = duelMap || trainingMap || buildMap || wanderMap;
    const spawnIndex=requestedMode==="Duel"?Math.max(0,duelRoom.playerIds.indexOf(socket.id)):0;
    const spawn = chosenMap ? (chosenMap.spawnPoints[spawnIndex%chosenMap.spawnPoints.length]||chosenMap.spawnPoints[0]) : pickSpawn();
    socket.emit("world", chosenMap ? getWorldPayloadForMap(chosenMap, requestedMode) : getWorldPayload());

    players.set(socket.id, {
      id: socket.id,
      name,
      skin,
      mode: requestedMode,
      team: null,
      matchId: requestedMode === "Duel" ? duelRoom.id : requestedMode === TRAINING_MODE || requestedMode === "Wander" || requestedMode === BUILD_MODE ? socket.id : null,
      duelRoomId: requestedMode === "Duel" ? duelRoom.id : null,
      duelMap, duelFirstTo: requestedMode === "Duel" ? duelRoom.firstTo : null,
      trainingMap,
      buildMap,
      wanderMap,
      finished: false,
      isBot: false,
      lastPresenceAt: Date.now(),
      x: spawn[0],
      y: Number(spawn[1]) || 0,
      z: spawn[2],
      yaw: 0,
      pitch: 0,
      health: maxHealth,
      maxHealth,
      ultimateCharge: 0,
      ultimateType: ["skyfall", "teleport", "aegis", "invisible", "rift", "tornado"].includes(data.ultimateType) ? data.ultimateType : "skyfall",
      shield: 0,
      ultimateActiveUntil: 0,
      ultimateAnchor: null,
      skyfallImpactPending: false,
      charm,
      kills: 0,
      deaths: 0,
      weapon,
      weaponSlots,
      activeWeaponSlot: 0,
      ammo: WEAPONS[weapon].magazineSize,
      weaponAmmo: [WEAPONS[weapon].magazineSize, WEAPONS[secondaryWeapon].magazineSize],
      reloadingUntil: 0,
      lastFire: 0,
      velocityY: 0,
      grounded: false,
      lastGroundedAt: 0,
      jumpQueuedUntil: 0,
      input: { forward: 0, strafe: 0, crouch: false },
      crouched: false,
      respawnAt: 0,
      invulnerableUntil: 0,
      damageHitstopUntil: 0,
      damageSlowUntil: 0,
      fireFloorDamageAt: 0
    });

    if (requestedMode === "Duel" && duelRoom.playerIds.every((id) => players.has(id))) {
      duelRoom.status = "playing";
      duelRoom.roundResolved = false;
    }
    if (requestedMode === TRAINING_MODE) createTrainingBotsForPlayer(players.get(socket.id));
    else if (requestedMode === BUILD_MODE) syncBuildBots(socket.id);
    else if (requestedMode === "Wander" && data.botEnabled === true) {
      const wanderPlayer = players.get(socket.id);
      if (wanderPlayer) wanderPlayer.wanderBotsEnabled = true;
      createWanderBotForPlayer(wanderPlayer);
    } else if (requestedMode !== "Wander") syncBots();
    socket.emit("joined", { player: publicPlayer(players.get(socket.id), true) });
    broadcastPlayers();
  });

  // joined通知の後にもマップを再送し、Vercel側で初回worldイベントを取りこぼした場合に備える。
  socket.on("requestWorld", () => {
    const player = players.get(socket.id);
    if (!player || player.isBot) return;
    const map = player.duelMap || player.trainingMap || player.buildMap || player.wanderMap ||
      (player.mode === AREA_MODE ? areaMap : player.mode === PAYLOAD_MODE ? payloadMap : activeMap);
    socket.emit("world", getWorldPayloadForMap(map, player.mode || MAP_MODE));
  });

  socket.on("buildPlace", (data = {}) => {
    try {
    const player = players.get(socket.id);
    if (!player || player.mode !== BUILD_MODE || !player.buildMap || player.health <= 0) return;
    const type = data.type === "floor" ? "floor" : data.type === "wall" ? "wall" : data.type === "ramp" ? "ramp" : null;
    const x = Number(data.x), z = Number(data.z), y = Number(data.y) || 0;
    const rotation = Number(data.rotation) || 0;
    if (!type || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(y) || y < 0 || y > 40 ||
        ![0, Math.PI / 2, Math.PI, -Math.PI / 2].some(value => Math.abs(Math.atan2(Math.sin(rotation - value), Math.cos(rotation - value))) < 0.01)) return;
    const map = player.buildMap;
    if ((map.buildStructures || []).length >= 512 || Math.hypot(x - player.x, z - player.z) > 6.05) return;
    const isSideways = Math.abs(Math.sin(rotation)) > 0.5;
    const wallW = isSideways ? 0.16 : 4;
    const wallD = isSideways ? 4 : 0.16;
    const newW = type === "wall" ? wallW : 4;
    const newD = type === "wall" ? wallD : 4;
    const halfW = newW / 2, halfD = newD / 2;
    const bounds = map.world;
    if (x - halfW < bounds.minX || x + halfW > bounds.maxX ||
        z - halfD < bounds.minZ || z + halfD > bounds.maxZ) return;
    const gridAligned = type === "floor" || type === "ramp"
      ? Math.abs((x - 2) / 4 - Math.round((x - 2) / 4)) < 0.001 && Math.abs((z - 2) / 4 - Math.round((z - 2) / 4)) < 0.001
      : (isSideways
          ? Math.abs(x / 4 - Math.round(x / 4)) < 0.001 && Math.abs((z - 2) / 4 - Math.round((z - 2) / 4)) < 0.001
          : Math.abs((x - 2) / 4 - Math.round((x - 2) / 4)) < 0.001 && Math.abs(z / 4 - Math.round(z / 4)) < 0.001);
    if (!gridAligned) return;
    const normalizedRotation = Math.atan2(Math.sin(rotation), Math.cos(rotation));
    const rampDirection = Math.abs(normalizedRotation) < 0.1 ? "south"
      : Math.abs(normalizedRotation - Math.PI / 2) < 0.1 ? "west"
      : Math.abs(Math.abs(normalizedRotation) - Math.PI) < 0.1 ? "north" : "east";
    const candidate = { type, x, z, y, rotation, direction: type === "ramp" ? rampDirection : undefined,
      w: newW, d: newD, h: type === "wall" || type === "ramp" ? 4 : 0.08 };
    const occupied = (map.buildStructures || []).some(item => {
      const overlapX = Math.min(x + halfW, item.x + item.w / 2) - Math.max(x - halfW, item.x - item.w / 2);
      const overlapZ = Math.min(z + halfD, item.z + item.d / 2) - Math.max(z - halfD, item.z - item.d / 2);
      const sameHeight = Math.abs((Number(item.y) || 0) - y) < 0.12;
      return item.type === type && sameHeight && overlapX > 0.12 && overlapZ > 0.12;
    });
    if (occupied) return;
    const structures = map.buildStructures || [];
    // 地面から接続をたどって到達できる構造物だけを土台として認める。
    // 浮いている構造物に接続した建築物が設置直後に連鎖破壊されるのを防ぐ。
    const groundedStructures = new Set(
      structures.filter(item => (Number(item.y) || 0) <= 0.02).map(item => item.id)
    );
    let supportChanged = true;
    while (supportChanged) {
      supportChanged = false;
      for (const item of structures) {
        if (groundedStructures.has(item.id)) continue;
        const connectedToGround = structures.some(other =>
          groundedStructures.has(other.id) && buildStructuresTouch(item, other)
        );
        if (connectedToGround) {
          groundedStructures.add(item.id);
          supportChanged = true;
        }
      }
    }
    // 地面への直接設置、または地面につながった構造物への接続だけ許可する。
    const supported = y <= 0.02 || structures.some(item =>
      groundedStructures.has(item.id) && buildStructuresTouch(candidate, item)
    );
    if (!supported) return;
    const id = "build-" + player.id + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const structure = { id, ...candidate, hp: 50 };
    map.buildStructures.push(structure);
    if (type === "wall") {
      map.obstacles.push({ x, y, z, w: wallW, d: wallD, h: 4, ceiling: y > 0.02, buildStructureId: id });
    } else if (type === "floor") {
      map.floorTiles.push({ id, buildStructureId: id, type: "build", x, y, z, w: 4, d: 4 });
      map.elevatedPlatforms.push({ x, z, w: 4, d: 4, h: y, buildStructureId: id });
    } else {
      map.ramps.push({ x, y, z, w: 4, d: 4, h: 4, direction: rampDirection, buildStructureId: id });
    }
    broadcastGameEvent(player, "buildStructureUpdate", getWorldPayloadForMap(map, BUILD_MODE));
    } catch (error) {
      // 建築処理の例外でSocket.IOイベント処理やサーバープロセス全体を停止させない。
      console.error("[Build] 設置処理エラー:", error?.stack || error);
      try { appendServerLog("BUILD-PLACE-ERROR", [String(error?.stack || error)]); } catch (_) {}
    }
  });

  socket.on("updateSkin", (skinDataUrl, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    const p = players.get(socket.id);
    if (!p || p.isBot) {
      reply({ ok: false, notInGame: true });
      return;
    }
    const safeSkin = sanitizeSkin(skinDataUrl);
    if (!safeSkin) {
      reply({ ok: false, reason: "invalid-skin" });
      return;
    }

    p.skin = safeSkin;
    // Broadcast the new skin only to players in the same match/mode.
    broadcastGameEvent(p, "playerSkin", { id: p.id, skin: p.skin });
    reply({ ok: true });
  });

  socket.on("presence", () => {
    const p = players.get(socket.id);
    if (p && !p.isBot) p.lastPresenceAt = Date.now();
  });

  socket.on("input", (input = {}) => {
    const p = players.get(socket.id);
    if (!p || p.finished) return;
    p.lastPresenceAt = Date.now();

    const previousCrouch = Boolean(p.input.crouch);
    p.input.forward = clamp(Number(input.forward) || 0, -1, 1);
    p.input.strafe = clamp(Number(input.strafe) || 0, -1, 1);
    p.input.crouch = Boolean(input.crouch);
    p.input.jumpHeld = Boolean(input.jumpHeld);
    const inputMagnitude = Math.hypot(p.input.forward, p.input.strafe);
    if (p.charm === "slide" && p.input.crouch && !previousCrouch && p.grounded && inputMagnitude >= 0.95) {
      const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
      const dirX = -sin * p.input.forward + cos * p.input.strafe;
      const dirZ = -cos * p.input.forward - sin * p.input.strafe;
      const dirLength = Math.hypot(dirX, dirZ) || 1;
      p.slideDirectionX = dirX / dirLength;
      p.slideDirectionZ = dirZ / dirLength;
      p.slidingUntil = Date.now() + 700;
    }
    if (Number.isFinite(Number(input.yaw))) p.yaw = Number(input.yaw);
    if (Number.isFinite(Number(input.pitch))) p.pitch = clamp(Number(input.pitch), -1.35, 1.35);
  });

  socket.on("ultimate", (payload = {}, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished) {
      reply({ ok: false, message: "現在はアルティメットを使用できません。" });
      return;
    }
    const type = ["skyfall", "teleport", "aegis", "invisible", "rift", "tornado"].includes(p.ultimateType) ? p.ultimateType : "skyfall";
    const now = Date.now();
    // 天墜開始から1秒経過後は、アルティメット再入力で任意に降下できる。
    if (type === "skyfall" && p.skyfallImpactId && p.ultimateActiveUntil > now) {
      if (now - (p.skyfallStartedAt || now) < 1000) {
        reply({ ok: false, message: "天墜の降下は発動から1秒後に可能です。" });
        return;
      }
      p.ultimateActiveUntil = now;
      reply({ ok: true, type: "skyfall", descended: true });
      return;
    }
    if ((p.ultimateCharge || 0) < 100) {
      reply({ ok: false, message: "チャージが不足しています。" });
      return;
    }
    if (type === "tornado") {
      spawnTornadoProjectile(p, now);
    } else if(type==="skyfall"){
      if(!activateSkyfall(p,now)){reply({ok:false,message:"天墜を発動できませんでした。"});return;}
    }else if(type==="aegis"){
      p.maxHealth=p.charm==="hp"?120:100;p.shield=50;p.ultimateActiveUntil=0;
    }else if(type==="invisible"){
      p.invisibleUntil=now+10000;
    }else if(type==="rift"){
      const opponent=gamePlayersFor(p).filter(q=>q.id!==p.id&&q.health>0&&!q.finished&&!q.riftDuelId&&!(isTeamMatchMode(p.mode)&&q.team===p.team))
        .sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];
      if(!opponent){reply({ok:false,message:"異空間へ呼び出せる敵がいません。"});return;}
      const duelId="rift:"+p.id+":"+now,arena=createRiftArenaMap();
      for(const q of [p,opponent]){
        q.riftReturnMap=getMapForPlayer(q);q.riftMap=arena;q.riftDuelId=duelId;
        q.riftOrigin={x:q.x,y:q.y,z:q.z,yaw:q.yaw,pitch:q.pitch};
        q.velocityY=0;q.grounded=true;q.input={forward:0,strafe:0,crouch:false};q.crouched=false;q.ultimateActiveUntil=0;
      }
      p.health=Number(p.maxHealth)||100;
      p.riftFirstHitProtected=true;
      opponent.riftFirstHitProtected=false;
      p.x=-4.2;p.y=0;p.z=0;p.yaw=-Math.PI/2;p.pitch=0;
      opponent.x=4.2;opponent.y=0;opponent.z=0;opponent.yaw=Math.PI/2;opponent.pitch=0;
      riftDuels.set(duelId,{id:duelId,playerIds:[p.id,opponent.id],resolved:false});
      for(const q of [p,opponent]){const client=io.sockets.sockets.get(q.id);if(client)client.emit("world",getWorldPayloadForMap(arena,q.mode||MAP_MODE));}
    }else{
      const map=getMapForPlayer(p),x=Number(payload.x),z=Number(payload.z);
      if(!Number.isFinite(x)||!Number.isFinite(z)||x<map.world.minX+PLAYER_RADIUS||x>map.world.maxX-PLAYER_RADIUS||z<map.world.minZ+PLAYER_RADIUS||z>map.world.maxZ-PLAYER_RADIUS){reply({ok:false,message:"マップ内の地点を選択してください。"});return;}
      const y=getGroundHeight(x,z,p.y,p);
      if(collides(x,z,y,PLAYER_HEIGHT,p)){reply({ok:false,message:"その地点にはテレポートできません。"});return;}
      p.x=x;p.y=y;p.z=z;p.velocityY=0;p.grounded=true;p.shield=Math.max(Number(p.shield)||0,10);
    }
    p.ultimateCharge=0;
    broadcastPlayers();
    reply({ ok: true, type });
  });

  socket.on("jump", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished || p.frozenUntil > Date.now()) return;
    const now = Date.now();
    p.lastJumpInputAt = now;
    const canJumpFromGround = p.grounded || now - (p.lastGroundedAt || 0) <= 140;

    if (p.charm === "body") {
      const armedAt = Number(p.bodyBlinkArmedAt) || 0;
      const isAirborne = !p.grounded;

      // 最初のジャンプから1.2秒以内に空中でもう一度押すと、前方へブリンクする。
      if (armedAt && now - armedAt <= 1200 && now - armedAt >= 80 && isAirborne) {
        const directionX = -Math.sin(p.yaw);
        const directionZ = -Math.cos(p.yaw);
        const height = p.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
        let destination = null;

        // 壁や建築物の中に入らないよう、最大7mから安全な位置を探す。
        for (let distance = 7; distance >= 1.5; distance -= 0.5) {
          const x = p.x + directionX * distance;
          const z = p.z + directionZ * distance;
          if (!collides(x, z, p.y, height, p)) {
            destination = { x, z };
            break;
          }
        }

        p.bodyBlinkArmedAt = 0;
        if (destination) {
          p.x = destination.x;
          p.z = destination.z;
          broadcastPlayers();
        }
        return;
      }

      if (canJumpFromGround) {
        // 接地中の再入力は新しいジャンプとして扱い、空中での次の入力を待つ。
        p.bodyBlinkArmedAt = now;
        p.jumpQueuedUntil = now + 120;
      }
      return;
    }

    if (p.charm === "flight" && !p.grounded) {
      if (!p.flying) {
        p.flying = true;
        p.velocityY = 0;
        p.flightMaxY = getGroundHeight(p.x, p.z, p.y, p) + 30;
        p.lastFlightJumpTapAt = 0;
      } else if (p.lastFlightJumpTapAt && now - p.lastFlightJumpTapAt <= 350) {
        p.flying = false;
        p.velocityY = 0;
        p.flightMaxY = 0;
        p.lastFlightJumpTapAt = 0;
      } else {
        p.lastFlightJumpTapAt = now;
      }
      return;
    }
    // 120msだけ入力を保持し、移動中の同時入力でもジャンプを取りこぼさない。
    p.jumpQueuedUntil = now + 120;
  });

  socket.on("requestCannonState", () => { const p = players.get(socket.id); if (p) emitCannonState(socket, p); });
  socket.on("fire", (fireData = {}) => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished || ["bow", "minigun", "railgun", "formingGun", "flamethrower", "laserBeam", "freezeCannon"].includes(p.weapon) || p.frozenUntil > Date.now()) return;
    if (p.weapon === "sword") {
      const now = Date.now();
      const jumpGrace = now - (Number(p.lastJumpInputAt) || 0) <= 900;
      // 剣はクライアント入力の重複に依存せず、サーバー側で攻撃間隔を一元管理する。
      if (now < Number(p.swordMeleeReadyAt || 0) || now < Number(p.swordLeapReadyAt || 0)) return;
      if (!p.grounded || jumpGrace) { startSwordLeap(p, now); return; }
    }
    fireShot(p, p.weapon === "sniper" && fireData.scoped === true);
  });
  socket.on("swordGuardStart", () => { const p = players.get(socket.id); if (p && p.weapon === "sword" && p.health > 0 && !p.finished) p.swordGuarding = true; });
  socket.on("swordGuardStop", () => { const p = players.get(socket.id); if (p) p.swordGuarding = false; });

  socket.on("formingChargeStart", () => {
    const p = players.get(socket.id), now = Date.now();
    if (!p || p.weapon !== "formingGun" || p.health <= 0 || p.finished || p.invulnerableUntil > now || p.frozenUntil > now) return;
    p.formingChargeStartedAt = now;
  });
  socket.on("formingRelease", () => {
    const p = players.get(socket.id), now = Date.now();
    if (!p || p.weapon !== "formingGun" || !p.formingChargeStartedAt || now - p.formingChargeStartedAt < 1000 ||
        p.health <= 0 || p.finished || p.invulnerableUntil > now || p.frozenUntil > now) return;
    p.formingChargeStartedAt = 0;
    p.lastFire = 0;
    spawnFormingBurst(p, now);
  });
  socket.on("formingCancel", () => {
    const p = players.get(socket.id);
    if (p) p.formingChargeStartedAt = 0;
  });

  socket.on("railgunChargeStart", () => {
    const p=players.get(socket.id),now=Date.now();
    if(!p||p.weapon!=="railgun"||p.health<=0||p.finished||p.invulnerableUntil>now||p.frozenUntil>now)return;
    p.railgunChargeStartedAt=now;
  });
  socket.on("railgunRelease", () => {
    const p=players.get(socket.id),now=Date.now();
    if(!p||p.weapon!=="railgun"||!p.railgunChargeStartedAt||now-p.railgunChargeStartedAt<2000||p.health<=0||p.finished||p.invulnerableUntil>now||p.frozenUntil>now)return;
    p.railgunChargeStartedAt=0;
    p.lastFire=0;
    fireShot(p);
  });
  socket.on("beamStart", () => {
    const p=players.get(socket.id),now=Date.now(); if(!p||p.health<=0||p.finished||!["flamethrower","laserBeam","freezeCannon"].includes(p.weapon)||p.invulnerableUntil>now||p.frozenUntil>now||p.beamTimer)return;
    broadcastGameEvent(p,"weaponBeam",{id:p.id,weapon:p.weapon,active:true,x:p.x,y:p.y,z:p.z,yaw:p.yaw,pitch:p.pitch});
    p.beamLastHitAt=new Map(); const beamTick=()=>{
      const a=players.get(socket.id),t=Date.now(); if(!a||a.health<=0||a.finished||!["flamethrower","laserBeam","freezeCannon"].includes(a.weapon)||a.frozenUntil>t){if(a?.beamTimer){clearInterval(a.beamTimer);broadcastGameEvent(a,"weaponBeam",{id:a.id,weapon:a.weapon,active:false,x:a.x,y:a.y,z:a.z,yaw:a.yaw,pitch:a.pitch});}if(a)a.beamTimer=null;return;}
      const origin={x:a.x,y:a.y+(a.crouched?CROUCH_HEIGHT:PLAYER_HEIGHT)-.15,z:a.z},dir=directionFromAngles(a.yaw,a.pitch),seen=new Set();
      const range=a.weapon==="laserBeam"?100:a.weapon==="flamethrower"?9:5.25;
      damageBuildStructureOnRay(a, origin, dir, range, (a.weapon === "laserBeam" || a.weapon === "freezeCannon") ? 4 : 5);
      const fanHalfAngle=(a.weapon==="flamethrower"||a.weapon==="freezeCannon")?Math.PI/4:0;
      const fanCos=Math.cos(fanHalfAngle);
      for(const q of players.values()){
        if(q.id===a.id||q.health<=0||q.finished||!isSameGame(a,q)||(a.mode===TRAINING_MODE&&!q.isBot)||(isTeamMatchMode(a.mode)&&q.team===a.team)||q.invulnerableUntil>t)continue;
        if(fanHalfAngle>0){
          // 火炎放射器/フリーズキャノンは地面に描画した扇形の真上を命中範囲にする。
          // 水平方向の扇形判定なので、照準の上下角に左右されず足元の範囲が一致する。
          const dx=q.x-a.x, dz=q.z-a.z;
          const forwardX=-Math.sin(a.yaw), forwardZ=-Math.cos(a.yaw);
          const forward=dx*forwardX+dz*forwardZ;
          const side=Math.abs(dx*forwardZ-dz*forwardX);
          const targetPadding=0.45;
          if(forward<=0||forward>range||side>Math.tan(fanHalfAngle)*forward+targetPadding)continue;
          // 両武器とも、攻撃者の高さを基準に上下3m以内の相手だけに命中する。
          if(Math.abs(q.y-a.y)>3)continue;
          const targetHeight=q.crouched?CROUCH_HEIGHT:PLAYER_HEIGHT;
          const target={x:q.x,y:q.y+targetHeight*0.5,z:q.z};
          const vx=target.x-origin.x,vy=target.y-origin.y,vz=target.z-origin.z;
          const distance=Math.hypot(vx,vy,vz);
          const wallDir={x:vx/distance,y:vy/distance,z:vz/distance};
          const wall=rayHitsObstacle(origin,wallDir,distance,a);
          // 火炎放射器もフリーズキャノンも、遮蔽物の向こう側には命中しない。
          if(wall!==null&&wall<distance-0.35)continue;
        }else{
          const h=rayHitsPlayer(origin,dir,q,a.weapon==="laserBeam"?PLAYER_RADIUS*4:null);
          if(!h||h.t>range)continue;
          if(a.weapon!=="laserBeam"){const wall=rayHitsObstacle(origin,dir,h.t,a);if(wall!==null&&wall<h.t)continue;}
        }
        seen.add(q.id);
        let beamDamage = 0;
        if (a.weapon === "laserBeam") {
          q.laserStreak = (a.beamLastHitAt.get(q.id) && t - a.beamLastHitAt.get(q.id) <= 700)
            ? Math.min(6, (q.laserStreak || 1) + 1) : 1;
          beamDamage = 4 * Math.pow(2, q.laserStreak - 1);
        } else if (a.weapon === "flamethrower") {
          beamDamage = 10;
          q.burnExposure = (q.burnExposure || 0) + 0.5;
          // 直接炎ダメージが止まってから500ms後に延焼ダメージを開始する。
          q.burnStartAt = t + 500;
          q.burnUntil = t + q.burnExposure * 1000 + 500;
          q.burnSourceId = a.id;
        } else {
          beamDamage = 4;
          q.freezeChance = Math.min(100, (q.freezeChance || 0) + 2.5);
          q.freezeLastHitAt = t;
          q.freezeDecayAt = t + 500;
          if (Math.random() * 100 < q.freezeChance) q.frozenUntil = t + 3000;
        }

        // 通常銃・弓と同じ damageDealt / damageTaken 通知を、ビーム系にも必ず送る。
        const split = applyIncomingDamage(q, beamDamage);
        addUltimateCharge(a, beamDamage);
        const damagePosition = {
          x: q.x,
          y: q.y + (q.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) * 0.5,
          z: q.z
        };
        io.to(a.id).emit("damageDealt", {
          targetId: q.id,
          damage: Math.round(split.totalDamage),
          shieldDamage: Math.round(split.shieldDamage),
          healthDamage: Math.round(split.healthDamage),
          zone: "body",
          ...damagePosition
        });
        io.to(q.id).emit("damageTaken", {
          damage: Math.round(split.totalDamage),
          zone: "body"
        });

        // ビームの継続ダメージでも通常武器と同じ死亡・キル処理を行う。
        if (q.health <= 0) {
          q.health = 0;
          q.respawnAt = t + 5000;
          q.kills = q.kills || 0;
          a.health = Number(a.maxHealth) || 100;
          a.kills = (a.kills || 0) + 1;
          q.deaths = (q.deaths || 0) + 1;
          if (q.mode === "Duel") resolveDuelRound(a, q);
          q.invisibleUntil = 0;
          if (q.riftDuelId) finishRiftDuel(q);
          if (a.invisibleUntil > Date.now()) a.invisibleUntil = 0;
          broadcastGameEvent(a, "elimination", {
            killerId: a.id,
            killerName: a.name,
            victimId: q.id,
            victimName: q.name,
            killerKills: a.kills,
            zone: "body"
          });
        }
        a.beamLastHitAt.set(q.id, t);
      }
      for(const q of players.values()){if(!seen.has(q.id)){if(a.weapon==="freezeCannon")q.freezeChance=Math.max(0,(q.freezeChance||0)-2.5);if(a.weapon==="laserBeam")q.laserStreak=0;}}
      broadcastPlayers();
    }; if(p.weapon==="laserBeam") beamTick(); p.beamTimer=setInterval(beamTick,500);p.beamTimer.unref?.();
  });
  socket.on("beamStop",()=>{const p=players.get(socket.id);if(p?.beamTimer)clearInterval(p.beamTimer);if(p){broadcastGameEvent(p,"weaponBeam",{id:p.id,weapon:p.weapon,active:false,x:p.x,y:p.y,z:p.z,yaw:p.yaw,pitch:p.pitch});p.beamTimer=null;p.beamLastHitAt=null;}});
  socket.on("bowChargeStart", () => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || p.health <= 0 || p.finished || p.weapon !== "bow" || p.invulnerableUntil > now || p.frozenUntil > now) return;
    if (now < (p.bowNextFireAt || 0)) return;
    if (!p.bowChargeStartedAt) p.bowChargeStartedAt = now;
  });

  socket.on("bowRelease", () => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || p.health <= 0 || p.finished || p.weapon !== "bow" || p.frozenUntil > now || !p.bowChargeStartedAt) return;
    const startedAt = p.bowChargeStartedAt;
    p.bowChargeStartedAt = 0;
    if (now < (p.bowNextFireAt || 0)) return;
    p.bowNextFireAt = now + 750;
    fireShot(p, false, clamp((now - startedAt) / 1125, 0, 1));
  });

  socket.on("minigunChargeStart", () => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || p.health <= 0 || p.finished || p.weapon !== "minigun" || p.invulnerableUntil > now || p.frozenUntil > now) return;
    if (!p.minigunChargeStartedAt && !p.minigunFireTimer) p.minigunChargeStartedAt = now;
  });

  socket.on("minigunRelease", () => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || p.health <= 0 || p.finished || p.weapon !== "minigun" ||
        p.invulnerableUntil > now || p.frozenUntil > now || !p.minigunChargeStartedAt) return;
    const chargedMs = clamp(now - p.minigunChargeStartedAt, 0, 1500);
    p.minigunChargeStartedAt = 0;
    const shotCount = Math.floor(chargedMs / WEAPONS.minigun.fireInterval);
    if (!shotCount) return;
    const burstId = (p.minigunBurstId || 0) + 1;
    p.minigunBurstId = burstId;
    let remaining = shotCount;
    const fireNext = () => {
      if (p.minigunBurstId !== burstId || p.weapon !== "minigun" || p.health <= 0 || p.finished || remaining <= 0) {
        if (p.minigunBurstId === burstId) p.minigunFireTimer = null;
        return;
      }
      fireShot(p);
      remaining -= 1;
      if (remaining > 0) p.minigunFireTimer = setTimeout(fireNext, WEAPONS.minigun.fireInterval);
      else p.minigunFireTimer = null;
    };
    fireNext();
  });

  socket.on("minigunCancel", () => {
    const p = players.get(socket.id);
    if (!p || p.weapon !== "minigun") return;
    p.minigunChargeStartedAt = 0;
    p.minigunBurstId = (p.minigunBurstId || 0) + 1;
    if (p.minigunFireTimer) clearTimeout(p.minigunFireTimer);
    p.minigunFireTimer = null;
  });

  socket.on("requestSmokeState", () => {
    const p = players.get(socket.id);
    if (p) emitSmokeState(socket, p);
  });

  socket.on("requestGrenadeState", () => {
    const p = players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    socket.emit("grenadeState", [...grenadeProjectiles.values()]
      .filter(item => isSameGame(p, item.owner))
      .map(item => ({ ...smokeProjectilePayload(item), remainingMs: Math.max(0, item.expiresAt - now) })));
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);
    if (!p || p.finished || p.health > 0) return;
    if (!p.respawnAt || Date.now() < p.respawnAt) return;

    const spawn = p.mode === TRAINING_MODE && p.trainingMap?.spawnPoints?.length
      ? p.trainingMap.spawnPoints[0]
      : pickSpawnForPlayer(p, p.botSpawnIndex || 0);
    p.x = spawn[0];
    p.y = Number(spawn[1]) || 0;
    p.z = spawn[2];
    if (p.mode === PAYLOAD_MODE) p.yaw = -Math.PI / 2;
    p.velocityY = 0;
    p.grounded = true;
    p.lastGroundedAt = Date.now();
    p.jumpQueuedUntil = 0;
    p.health = Number(p.maxHealth) || 100;
    p.shield = 0;
    p.ultimateActiveUntil = 0;
    p.ultimateAnchor = null;
    p.skyfallImpactPending = false;
    p.skyfallImpactId = null;
    p.ammo = WEAPONS[p.weapon].magazineSize;
    if (Array.isArray(p.weaponAmmo)) p.weaponAmmo[p.activeWeaponSlot || 0] = p.ammo;
    p.reloadingUntil = 0;
    p.lastFire = 0;
    p.minigunChargeStartedAt = 0;
    p.minigunBurstId = (p.minigunBurstId || 0) + 1;
    if (p.minigunFireTimer) clearTimeout(p.minigunFireTimer);
    p.minigunFireTimer = null;
    p.input.crouch = false;
    p.crouched = false;
    p.respawnAt = 0;
    // ペイロードでは復帰後4秒間、それ以外は従来どおり3秒間無敵。
    p.invulnerableUntil = Date.now() + (p.mode === PAYLOAD_MODE ? 4000 : 3000);
    p.damageHitstopUntil = 0;
    p.damageSlowUntil = 0;

    socket.emit("respawned", { player: publicPlayer(p) });
    // 同じ対戦内の他プレイヤーへ、敵の復帰地点だけを通知する。
    broadcastGameEvent(p, "enemyRespawnMarker", {
      playerId: p.id, x: p.x, z: p.z, team: p.team || null, mode: p.mode, durationMs: 8000
    });
    broadcastPlayers();
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished) return;
    startReload(p);
  });

  socket.on("changeWeapon", (weapon) => {
    const p = players.get(socket.id);
    if (!p || p.finished) return;
    const nextWeapon = sanitizeWeapon(weapon);
    if (p.swordLeap) return;
    if (p.weapon === nextWeapon) return;
    p.bowChargeStartedAt = 0; p.railgunChargeStartedAt=0; if(p.beamTimer){clearInterval(p.beamTimer);broadcastGameEvent(p,"weaponBeam",{id:p.id,weapon:p.weapon,active:false});}p.beamTimer=null;
    if (!Array.isArray(p.weaponSlots)) p.weaponSlots = [p.weapon, nextWeapon];
    p.weaponSlots[p.activeWeaponSlot || 0] = nextWeapon;
    p.weapon = nextWeapon;
    p.ammo = WEAPONS[nextWeapon].magazineSize;
    if (!Array.isArray(p.weaponAmmo)) p.weaponAmmo = [p.ammo, WEAPONS[p.weaponSlots[1] || nextWeapon].magazineSize];
    p.weaponAmmo[p.activeWeaponSlot || 0] = p.ammo;
    p.reloadingUntil = 0;
    p.lastFire = 0;
  });

  socket.on("switchWeapon", (slotIndex) => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished || !Array.isArray(p.weaponSlots)) return;
    const now = Date.now();
    if (p.swordLeap) return;
    const grappleInFlight = [...grenadeProjectiles.values()].some(projectile =>
      projectile.type === "grapple" && projectile.ownerId === p.id
    );
    if (grappleInFlight || Number(p.grappleTetherUntil || 0) > now) return;
    const nextSlot = Number(slotIndex);
    if (!Number.isInteger(nextSlot) || nextSlot < 0 || nextSlot >= Math.min(2, p.weaponSlots.length)) return;
    const nextWeapon = sanitizeWeapon(p.weaponSlots[nextSlot]);
    if (nextSlot === p.activeWeaponSlot && nextWeapon === p.weapon) return;
    p.bowChargeStartedAt = 0; p.railgunChargeStartedAt=0; if(p.beamTimer){clearInterval(p.beamTimer);broadcastGameEvent(p,"weaponBeam",{id:p.id,weapon:p.weapon,active:false});}p.beamTimer=null;
    p.minigunChargeStartedAt = 0;
    p.minigunBurstId = (p.minigunBurstId || 0) + 1;
    if (p.minigunFireTimer) clearTimeout(p.minigunFireTimer);
    p.minigunFireTimer = null;
    if (!Array.isArray(p.weaponAmmo)) p.weaponAmmo = [WEAPONS[p.weaponSlots[0]].magazineSize, WEAPONS[p.weaponSlots[1] || p.weaponSlots[0]].magazineSize];
    p.weaponAmmo[p.activeWeaponSlot || 0] = p.ammo;
    p.activeWeaponSlot = nextSlot;
    p.weapon = nextWeapon;
    p.ammo = Math.max(0, Math.min(WEAPONS[nextWeapon].magazineSize, Number(p.weaponAmmo[nextSlot]) || 0));
    p.reloadingUntil = 0;
    p.lastFire = 0;
  });

  socket.on("disconnect", (reason) => {
    const disconnectedPlayer = players.get(socket.id);
    if (disconnectedPlayer?.mode === PAYLOAD_MODE) {
      appendServerLog("PAYLOAD-DISCONNECT", [
        "reason=" + String(reason),
        "transport=" + String(socket.conn?.transport?.name || "unknown"),
        "match=" + String(disconnectedPlayer.matchId || "unknown"),
        "players=" + players.size
      ]);
    }
    cancelAreaQueue(socket.id);
    cancelPayloadQueue(socket.id);
    const player = players.get(socket.id);
    if(player?.beamTimer)clearInterval(player.beamTimer);
    if (player?.mode === AREA_MODE) {
      removeAreaPlayer(socket.id);
      return;
    }
    if (player?.mode === PAYLOAD_MODE) {
      player.input = { forward: 0, strafe: 0, crouch: false };
      const token = typeof player.reconnectToken === "string" ? player.reconnectToken : "";
      if (token) {
        const timer = setTimeout(() => {
          const pending = pendingPayloadDisconnects.get(token);
          if (pending?.playerId === socket.id) {
            pendingPayloadDisconnects.delete(token);
            removePayloadPlayer(socket.id);
          }
        }, PAYLOAD_RECONNECT_GRACE_MS);
        timer.unref?.();
        player.disconnectedAt = Date.now();
        pendingPayloadDisconnects.set(token, { playerId: socket.id, timer });
      } else {
        removePayloadPlayer(socket.id);
      }
      return;
    }
    if (player?.mode === TRAINING_MODE) removeTrainingBots(player.matchId);
    if (player?.mode === "Wander") players.delete("bot:wander:" + player.matchId);
    if (player?.mode === "Duel") removeDuelPlayer(socket.id, player.duelRoomId);
    players.delete(socket.id);
    if (player?.mode === BUILD_MODE) syncBuildBots(player.matchId);
    syncBots();
    broadcastPlayers();
  });
});

function rotateMeleeMap() {
  activeMapIndex = (activeMapIndex + 1) % availableMaps.length;
  activeMap = availableMaps[activeMapIndex];
  WORLD = activeMap.world;
  spawnPoints = activeMap.spawnPoints;
  obstacles = activeMap.obstacles;
  ramps = activeMap.ramps;
  elevatedPlatforms = activeMap.elevatedPlatforms;

  const now = Date.now();
  const connectedPlayers = Array.from(players.values()).filter((p) => (p.mode || MAP_MODE) === MAP_MODE);
  connectedPlayers.forEach((p, index) => {
    const spawn = spawnPoints[index % spawnPoints.length];
    p.x = spawn[0];
    p.y = spawn[1] || 0;
    p.z = spawn[2];
    p.yaw = 0;
    p.pitch = 0;
    p.health = Number(p.maxHealth) || 100;
    p.ammo = WEAPONS[p.weapon].magazineSize;
    if (Array.isArray(p.weaponAmmo)) p.weaponAmmo[p.activeWeaponSlot || 0] = p.ammo;
    p.reloadingUntil = 0;
    p.lastFire = 0;
    p.velocityY = 0;
    p.grounded = true;
    p.lastGroundedAt = now;
    p.jumpQueuedUntil = 0;
    p.input = { forward: 0, strafe: 0, crouch: false };
    p.crouched = false;
    p.respawnAt = 0;
    // Map transition resets everyone to full health and briefly protects them from spawn damage.
    p.invulnerableUntil = now + 3000;
    p.damageHitstopUntil = 0;
    p.damageSlowUntil = 0;
  });

  for (const client of io.sockets.sockets.values()) {
    const player = players.get(client.id);
    if (player && (player.mode || MAP_MODE) === MAP_MODE) client.emit("world", getWorldPayload());
  }
  broadcastModeEvent(MAP_MODE, "mapChanged", {
    map: getMapInfo(activeMap),
    nextMap: getMapInfo(getNextMap()),
    nextChangeAt: nextMapChangeAt
  });
  broadcastPlayers();
  console.log("[Map] マップを切り替えました:", activeMap.name, "(" + activeMap.id + ")");
}

setInterval(() => {
  const remaining = nextMapChangeAt - Date.now();
  if (remaining <= 0) {
    // 次の周期を先に設定し、mapChangedイベントにも正しい予定時刻を載せます。
    nextMapChangeAt = Date.now() + MAP_ROTATION_INTERVAL_MS;
    lastMapCountdownSecond = null;
    rotateMeleeMap();
    broadcastModeEvent(MAP_MODE, "mapRotationStatus", getMapRotationStatus());
    return;
  }

  if (availableMaps.length > 1 && remaining <= MAP_CHANGE_COUNTDOWN_MS) {
    const seconds = Math.max(1, Math.ceil(remaining / 1000));
    if (seconds !== lastMapCountdownSecond) {
      lastMapCountdownSecond = seconds;
      broadcastModeEvent(MAP_MODE, "mapChangeCountdown", {
        seconds,
        nextMap: getMapInfo(getNextMap())
      });
    }
  }
}, 100);

// Matchmaking window: start immediately at six humans, otherwise fill with BOTs after 20 seconds.
setInterval(() => {
  if (areaQueue.length === 0) return;
  const remaining = AREA_QUEUE_DURATION_MS - (Date.now() - areaQueueStartedAt);
  if (areaQueue.length >= 6) {
    startAreaMatch(false);
    return;
  }
  if (remaining <= 0) {
    startAreaMatch(true);
    return;
  }
  const second = Math.ceil(remaining / 1000);
  if (second !== lastAreaQueueSecond) {
    lastAreaQueueSecond = second;
    broadcastAreaQueueStatus();
  }
}, 200);

// Payload matchmaking: close the six-player lobby immediately, otherwise start with BOT fill after 20 seconds.
setInterval(() => {
  if (!payloadQueue.length) return;
  const remaining = AREA_QUEUE_DURATION_MS - (Date.now() - payloadQueueStartedAt);
  if (payloadQueue.length >= 6 || remaining <= 0) {
    startPayloadMatch(payloadQueue.length < 6);
    return;
  }
  const second = Math.ceil(remaining / 1000);
  if (second !== lastPayloadQueueSecond) {
    lastPayloadQueueSecond = second;
    broadcastPayloadQueueStatus();
  }
}, 200);

// Ultimate passive charge: update once per second instead of on every game tick.
setInterval(() => {
  for (const p of players.values()) {
    if (p.finished || p.health <= 0) continue;
    if (p.isBot && p.mode === TRAINING_MODE) continue;
    p.ultimateCharge = Math.min(100, (p.ultimateCharge || 0) + 0.5 * (p.charm === "ultimate" ? 2 : 1));
  }
}, 1000);

setInterval(() => {
  const dt = 1 / TICK_RATE;
  const now = Date.now();
  for (const p of players.values()) {
    if (p.finished) continue;
    if (p.isBot && p.mode === TRAINING_MODE) {
      if (p.health <= 0 && p.respawnAt && now >= p.respawnAt) {
        // 練習BOTは倒されたら、最初に配置されたスポーン地点へ戻す。
        p.x = Number.isFinite(p.spawnX) ? p.spawnX : p.x;
        p.y = Number.isFinite(p.spawnY) ? p.spawnY : 0;
        p.z = Number.isFinite(p.spawnZ) ? p.spawnZ : p.z;
        p.velocityY = 0;
        p.grounded = true;
        p.lastGroundedAt = now;
        p.jumpQueuedUntil = 0;
        p.knockbackVelocityX = 0;
        p.knockbackVelocityZ = 0;
        p.health = Number(p.maxHealth) || 100;
        p.respawnAt = 0;
        p.damageHitstopUntil = 0;
        p.damageSlowUntil = 0;
        broadcastGameEvent(p, "enemyRespawnMarker", {
          playerId: p.id, x: p.x, z: p.z, team: p.team || null, mode: p.mode, durationMs: 8000
        });
      }
      // BOTのAIは停止したまま、ノックバックと重力だけを適用する。
      if (p.health > 0) {
        try { movePlayer(p, dt); }
        catch (error) {
          console.error("[Movement] プレイヤー移動エラー:", error?.stack || error);
          try { appendServerLog("PLAYER-MOVE-ERROR", [p.id, p.mode, String(error?.stack || error)]); } catch (_) {}
          p.input = { forward: 0, strafe: 0, crouch: false };
          p.velocityY = 0;
        }
      }
      continue;
    }
    if (p.isBot && p.health <= 0 && p.respawnAt && now >= p.respawnAt) {
      respawnBot(p, now);
    }
    if (p.health > 0) {
      if (p.isBot) updateBot(p, now);
      finishReload(p, now);
      try { movePlayer(p, dt); }
      catch (error) {
        console.error("[Movement] プレイヤー移動エラー:", error?.stack || error);
        try { appendServerLog("PLAYER-MOVE-ERROR", [p.id, p.mode, String(error?.stack || error)]); } catch (_) {}
        p.input = { forward: 0, strafe: 0, crouch: false };
        p.velocityY = 0;
      }
      // 床のお守りは特殊床（炎・加速・スライム）の上で毎秒5HP回復する。
      const floorSurfaceY = getGroundHeight(p.x, p.z, p.y, p);
      const onSpecialFloor = ["fire", "speed", "slime"].some(type => isOnFloorTile(p, type)) &&
        Math.abs(p.y - floorSurfaceY) <= 0.12;
      if (p.charm === "floor" && onSpecialFloor && now >= (p.floorCharmHealAt || 0)) {
        p.floorCharmHealAt = now + 1000;
        p.health = Math.min(Number(p.maxHealth) || 100, p.health + 5);
      } else if (!onSpecialFloor) {
        p.floorCharmHealAt = 0;
      }
      // 赤い床は延焼状態を付与せず、接地中に毎秒3ダメージ。床のお守りなら無効化する。
      const fireFloorTile = (getMapForPlayer(p).floorTiles || []).find(tile =>
        tile.type === "fire" &&
        Math.abs(p.x - tile.x) <= tile.w / 2 &&
        Math.abs(p.z - tile.z) <= tile.d / 2
      );
      // 赤い床そのものの高さ(y)に接地している時だけダメージ。上にある足場や空中では発生させない。
      const fireFloorY = fireFloorTile ? (Number(fireFloorTile.y) || 0) : null;
      const onFireFloorGround = p.charm !== "floor" && Boolean(fireFloorTile) &&
        p.grounded === true && Math.abs(p.y - fireFloorY) <= 0.12;
      if (onFireFloorGround && now >= (p.fireFloorDamageAt || 0)) {
        p.fireFloorDamageAt = now + 1000;
        applyIncomingDamage(p, 3);
        io.to(p.id).emit("damageTaken", { damage: 3, zone: "environment", source: "fire-floor" });
        if (p.health <= 0) {
          p.respawnAt = now + 5000;
          p.deaths = (p.deaths || 0) + 1;
          if (p.riftDuelId) finishRiftDuel(p);
          broadcastGameEvent(p, "elimination", {
            killerId: null,
            killerName: "燃える床",
            victimId: p.id,
            victimName: p.name,
            killerKills: null,
            zone: "environment"
          });
        }
      } else if (!onFireFloorGround) {
        p.fireFloorDamageAt = 0;
      }
    }
  }

  updateSmokeProjectiles(dt, now);
  updateGrenadeProjectiles(dt, now);
  updatePlayerCannons(now);
  updateAreaMatches(dt, now);
  updatePayloadMatches(dt, now);
  broadcastState();
}, 1000 / TICK_RATE);

// Keep the SPA fallback after all API routes so unknown API requests never receive index.html.
app.get("/{*splat}", (req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "APIが見つかりません" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


let previousHumanOnlineCount = Array.from(players.values()).filter(player =>
  !player.isBot && !player.disconnectedAt && io.sockets.sockets.has(player.id)
).length;
setInterval(() => {
  const onlineCount = Array.from(players.values()).filter(player =>
    !player.isBot && !player.disconnectedAt && io.sockets.sockets.has(player.id)
  ).length;
  if (previousHumanOnlineCount === null) {
    previousHumanOnlineCount = onlineCount;
    return;
  }
  const previous = previousHumanOnlineCount;
  previousHumanOnlineCount = onlineCount;
  if (previous === 0 && onlineCount === 1 && pushSubscriptions.length > 0) {
    const japanTime = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date());
    const japanHour = Number(japanTime.find(part => part.type === "hour")?.value || 0);
    const japanMinute = Number(japanTime.find(part => part.type === "minute")?.value || 0);
    const japanMinutes = japanHour * 60 + japanMinute;
    if (japanMinutes >= 8 * 60 + 40 && japanMinutes < 17 * 60) {
      sendOnlinePushNotification().catch(error => console.error("[Push] 通知処理に失敗しました:", error));
    }
  }
}, 3000).unref?.();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mobile FPS server running on http://0.0.0.0:${PORT}`);
  console.log(`[AutoUpdate] GitHubの更新を${AUTO_UPDATE_INTERVAL / 1000}秒ごとに確認します。`);
  setTimeout(checkForUpdates, AUTO_UPDATE_INTERVAL);
  
// ループ遅延を記録し、Payload中の瞬断がサーバー負荷由来か判別できるようにする。
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
setInterval(() => {
  const p95 = eventLoopDelay.percentile(95) / 1e6;
  const max = eventLoopDelay.max / 1e6;
  const memory = process.memoryUsage();
  const heapLimit = require("v8").getHeapStatistics().heap_size_limit;
  if (p95 >= 100 || max >= 300) {
    appendServerLog("EVENT-LOOP-LAG", [
      "p95=" + p95.toFixed(1) + "ms",
      "max=" + max.toFixed(1) + "ms",
      "rss=" + Math.round(memory.rss / 1048576) + "MB",
      "heapUsed=" + Math.round(memory.heapUsed / 1048576) + "MB",
      "heapLimit=" + Math.round(heapLimit / 1048576) + "MB",
      "players=" + players.size,
      "payloadPlayers=" + Array.from(players.values()).filter((p) => p.mode === PAYLOAD_MODE).length
    ]);
  }
  if (memory.rss >= 5.5 * 1024 * 1024 * 1024 || memory.heapUsed >= heapLimit * 0.8) {
    appendServerLog("MEMORY-HIGH", [
      "rss=" + Math.round(memory.rss / 1048576) + "MB",
      "heapUsed=" + Math.round(memory.heapUsed / 1048576) + "MB",
      "heapLimit=" + Math.round(heapLimit / 1048576) + "MB",
      "external=" + Math.round(memory.external / 1048576) + "MB"
    ]);
  }
  eventLoopDelay.reset();
}, 30000).unref?.();

setInterval(checkForUpdates, AUTO_UPDATE_INTERVAL);
});
