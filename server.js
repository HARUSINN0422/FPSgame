const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { execFile, spawn, spawnSync } = require("child_process");

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
const DAMAGE_HITSTOP_MS = 100;
const DAMAGE_SLOW_MS = 700;
const DAMAGE_SLOW_MULTIPLIER = 0.45;

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
    name: "Pickaxe", damage: 70, fireInterval: 650, range: 3.2, spread: 0,
    falloffStart: 3.2, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: false, melee: true
  },
  pistol: {
    name: "Pistol",
    damage: 50,
    fireInterval: 400,
    range: 68,
    spread: 0.018,
    falloffStart: 11,
    minDamageMultiplier: 0.32,
    magazineSize: 6,
    reloadTime: 1000,
    automatic: false
  },
  smg: {
    name: "Submachine Gun",
    damage: 9,
    fireInterval: 107,
    range: 68,
    spread: 0.045,
    falloffStart: 20,
    minDamageMultiplier: 0.45,
    magazineSize: 30,
    reloadTime: 1300,
    automatic: true
  },
  rifle: {
    name: "Rifle",
    damage: 18,
    fireInterval: 160,
    range: 78,
    spread: 0.032,
    falloffStart: 24,
    minDamageMultiplier: 0.55,
    magazineSize: 30,
    reloadTime: 1500,
    automatic: true
  },
  shotgun: {
    name: "Shotgun", damage: 10, fireInterval: 750, range: 40, pellets: 8,
    spread: 0.24, falloffStart: 10, minDamageMultiplier: 0.30,
    magazineSize: 6, reloadTime: 1400, automatic: false
  },
  grenadeLauncher: {
    name: "Grenade", damage: 60, fireInterval: 900, range: 0, spread: 0,
    falloffStart: 0, minDamageMultiplier: 0, magazineSize: 6, reloadTime: 1700, automatic: false
  },
  marksman: {
    name: "Marksman", damage: 35, fireInterval: 450, range: 100, spread: 0.006,
    falloffStart: 55, minDamageMultiplier: 0.7, magazineSize: 20,
    reloadTime: 1300, automatic: true
  },
  smoke: {
    name: "Smoke Grenade", damage: 0, fireInterval: 1300, range: 0, spread: 0,
    falloffStart: 0, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: false
  },
  sniper: {
    name: "Sniper", damage: 85, fireInterval: 1200, range: 130, spread: 0.0015,
    falloffStart: 80, minDamageMultiplier: 0.8, magazineSize: 3,
    reloadTime: 1900, automatic: false
  },
  bow: { name: "Bow", damage: 110, fireInterval: 100, range: 130, spread: 0, falloffStart: 130, minDamageMultiplier: 1, magazineSize: 0, reloadTime: 0, automatic: false },
  minigun: { name: "Minigun", damage: 7, fireInterval: 107 / 3, range: 68, spread: 0.055, falloffStart: 20, minDamageMultiplier: 0.45, magazineSize: 0, reloadTime: 0, automatic: false }
};

const WEAPON_LABELS = {
  pickaxe: "ツルハシ", pistol: "ハンドガン", smg: "サブマシンガン", rifle: "アサルトライフル",
  shotgun: "ショットガン", grenadeLauncher: "グレネード", marksman: "マークスマン", smoke: "煙幕", sniper: "スナイパーライフル", bow: "弓", minigun: "ミニガン"
};
const DEFAULT_WEAPON_DESCRIPTIONS = {
  pickaxe: "近接攻撃 / 70ダメージ",
  smoke: "投擲 / リロード不要 / 1300ms間隔で再投擲可能 / 着地点周囲を煙で遮蔽",
  pistol: "単発 / 胴体50ダメージ / 装弾数6発・距離減衰はやや大きめ",
  smg: "連射可能 / 胴体9ダメージ / 装弾数30発",
  rifle: "連射可能 / 胴体18ダメージ / 長射程・距離減衰が小さい",
  shotgun: "単発 / 8発の散弾（胴体全弾命中で80ダメージ） / 近距離向け",
  grenadeLauncher: "着弾地点で球状爆発 / 中心最大60ダメージ・外側ほど減衰 / 装弾数6発",
  marksman: "連射可能 / 胴体35ダメージ / 装弾数20発・中〜長距離向け",
  sniper: "高威力 / 装弾数3発・連射は遅い",
  bow: "長押しで弓を引く / 1.5秒で最大チャージ / 胴体5〜110ダメージ / 0.1秒間隔 / リロード不要",
  minigun: "長押しで弾をチャージ / 最大3秒 / 離すとチャージ量だけ連射 / SMGの3倍速 / 1発7ダメージ"
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

// 弓の発射間隔と最大胴体ダメージは、古いローカル武器設定に上書きされないよう固定する。
WEAPONS.bow.fireInterval = 100;
WEAPONS.bow.damage = 110;

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
const io = new Server(server);

server.on("error", (error) => {
  saveLatestError(error, "http.Server");
  safeConsoleWrite(originalConsoleError, "ERROR", ["[Server Error]", error]);
});

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const crypto = require("crypto");
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
      if (!Number.isFinite(value) || value < 0 || (key === "fireInterval" && value < 1) || (key === "magazineSize" && value < (["smoke", "bow"].includes(id) ? 0 : 1)) || (key === "minDamageMultiplier" && value > 1) || (key === "pellets" && (!Number.isInteger(value) || value < 1))) {
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
const duelRooms = new Map();
let duelRoomSequence = 0;

const MAP_ROOT = path.join(__dirname, "map");
const MAP_OVERRIDE_ROOT = path.join(__dirname, "data", "maps");
const MAP_MODE = "Melee";
const AREA_MODE = "Area";
const TRAINING_MODE = "Training";
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
      { id: "slime", type: "slime", x: -12, z: -3.75, w: 4, d: 13.5 }
    ],
    ramps: [],
    elevatedPlatforms: []
  };
}

function getMapInfo(map, mode = MAP_MODE) {
  return { mode, id: map.id, name: map.name, description: map.description || "" };
}

function getMapForPlayer(player) {
  if (player?.mode === AREA_MODE) return areaMap;
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
    world: map.world,
    ...(mode === AREA_MODE && map.areaZone ? { areaZone: map.areaZone } : {}),
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
      if (!filename || ![MAP_MODE, AREA_MODE].includes(mode)) return res.status(400).json({ error: "マップ指定が不正です" });
      const overrideTarget = path.join(MAP_OVERRIDE_ROOT, mode, filename);
      const baseTarget = path.join(MAP_ROOT, mode, filename);
      const target = fs.existsSync(overrideTarget) ? overrideTarget : baseTarget;
      if (!fs.existsSync(target)) return res.status(404).json({ error: "マップが見つかりません" });
      return res.json({ map: JSON.parse(fs.readFileSync(target, "utf8")) });
    }
    const maps = [];
    for (const mode of [MAP_MODE, AREA_MODE]) {
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
  if (![MAP_MODE, AREA_MODE].includes(mode) || !validateMapData(mapData)) return res.status(400).json({ error: "マップデータが不正です。スポーン地点・寸法・オブジェクトを確認してください" });
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
  const alivePlayers = Array.from(players.values()).filter((p) => p.health > 0 && p.mode !== AREA_MODE);
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

function pickSpawnForPlayer(player, index = 0) {
  if (player?.mode === AREA_MODE) {
    const teamSpawns = areaMap.teamSpawnPoints?.[player.team] || areaMap.spawnPoints;
    if (teamSpawns?.length) return teamSpawns[Math.abs(index) % teamSpawns.length];
  }
  return pickSpawn();
}

function isSameGame(a, b) {
  if (!a || !b) return false;
  const modeA = a.mode || MAP_MODE;
  const modeB = b.mode || MAP_MODE;
  if (modeA !== modeB) return false;
  if (modeA === AREA_MODE || modeA === TRAINING_MODE || modeA === "Duel") return Boolean(a.matchId && a.matchId === b.matchId);
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
    p.x=spawn[0];p.y=spawn[1]||0;p.z=spawn[2];p.yaw=index===0?0:Math.PI;p.pitch=0;p.health=100;p.shield=0;p.ultimateCharge=0;p.ultimateActiveUntil=0;p.ultimateAnchor=null;p.respawnAt=0;p.velocityY=0;p.grounded=true;p.finished=ended;p.invulnerableUntil=now+2500;
    p.ammo=WEAPONS[p.weapon].magazineSize;if(Array.isArray(p.weaponAmmo))p.weaponAmmo[p.activeWeaponSlot||0]=p.ammo;p.reloadingUntil=0;p.lastFire=0;
  }
  room.status = ended ? "ended" : "playing";
  for(const id of room.playerIds){const p=players.get(id);if(!p)continue;const other=players.get(room.playerIds.find(pid=>pid!==id));io.to(id).emit(ended?"duel:matchEnd":"duel:score",{roomId:room.id,firstTo:room.firstTo,myScore:room.scores[id]||0,opponentScore:room.scores[other?.id]||0,opponentName:other?.name||"対戦相手",winnerId:actualWinner.id,matchEnded:ended});}
  if(!ended)setTimeout(()=>{room.roundResolved=false;},1800);
  broadcastPlayers();
}

const SMOKE_RADIUS = 5.2;
const SMOKE_DURATION_MS = 8500;
const SMOKE_PROJECTILE_GRAVITY = 18;
const smokeProjectiles = new Map();
const grenadeProjectiles = new Map();
const smokeClouds = new Map();
let smokeSequence = 0;

function smokeProjectilePayload(projectile) {
  return {
    id: projectile.id, x: projectile.x, y: projectile.y, z: projectile.z,
    ownerId: projectile.ownerId, expiresAt: projectile.expiresAt
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

function spawnGrenadeProjectile(shooter, now = Date.now()) {
  const direction = directionFromAngles(shooter.yaw, shooter.pitch);
  const speed = 14;
  const horizontalSpeed = speed * 1.5;
  const height = shooter.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const origin = {
    x: shooter.x + direction.x * 0.62,
    y: shooter.y + height - 0.18,
    z: shooter.z + direction.z * 0.62
  };
  const id = "grenade-projectile-" + (++smokeSequence);
  const projectile = {
    id, owner: shooter, ownerId: shooter.id,
    x: origin.x, y: origin.y, z: origin.z,
    startX: origin.x, startY: origin.y, startZ: origin.z,
    vx: direction.x * horizontalSpeed, vy: direction.y * speed + 4.5, vz: direction.z * horizontalSpeed,
    expiresAt: now + 4500
  };
  grenadeProjectiles.set(id, projectile);
  broadcastGameEvent(shooter, "grenadeProjectileSpawn", smokeProjectilePayload(projectile));
  broadcastGameEvent(shooter, "shot", {
    id: shooter.id, x: origin.x, y: origin.y, z: origin.z,
    yaw: shooter.yaw, pitch: shooter.pitch, weapon: "grenadeLauncher", hit: null, tracers: []
  });
}

function explodeGrenade(projectile, position, now = Date.now()) {
  const radius = 5.2;
  const id = "grenade-explosion-" + (++smokeSequence);
  broadcastGameEvent(projectile.owner, "grenadeExplosion", {
    id, x: position.x, y: position.y, z: position.z, radius, expiresAt: now + 420
  });
  for (const target of players.values()) {
    if (target.health <= 0 || target.finished ||
        !isSameGame(projectile.owner, target)) continue;
    if (target.id !== projectile.ownerId && projectile.owner.mode === TRAINING_MODE && !target.isBot) continue;
    if (projectile.owner.mode === AREA_MODE && target.team === projectile.owner.team) continue;
    if (target.invulnerableUntil > now) continue;
    const targetHeight = target.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
    const dx = target.x - position.x;
    const dy = target.y + targetHeight * 0.5 - position.y;
    const dz = target.z - position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > radius) continue;
    const damage = Math.round(20 + 40 * (1 - distance / radius));
    if (damage <= 0) continue;
    applyIncomingDamage(target, damage);
    if (projectile.owner && projectile.owner.id !== target.id) projectile.owner.ultimateCharge = Math.min(100, (projectile.owner.ultimateCharge || 0) + damage / 3);
    target.damageHitstopUntil = now + DAMAGE_HITSTOP_MS;
    target.damageSlowUntil = now + DAMAGE_SLOW_MS;
    io.to(projectile.ownerId).emit("damageDealt", {
      targetId: target.id, damage, zone: "body",
      x: target.x, y: target.y + targetHeight * 0.5, z: target.z
    });
    io.to(target.id).emit("damageTaken", {
      damage, zone: "body", hitstopMs: DAMAGE_HITSTOP_MS,
      slowMs: DAMAGE_SLOW_MS, slowMultiplier: DAMAGE_SLOW_MULTIPLIER
    });
    if (target.health <= 0) {
      const selfElimination = target.id === projectile.ownerId;
      if (!selfElimination) {
        projectile.owner.health = Number(projectile.owner.maxHealth) || 100;
        projectile.owner.kills = (projectile.owner.kills || 0) + 1;
      }
      target.health = 0;
      target.respawnAt = now + 5000;
      target.kills = target.kills || 0;
      target.deaths += 1;
      if(target.mode==="Duel"){const winner=selfElimination?gamePlayersFor(target).find(p=>p.id!==target.id):projectile.owner;resolveDuelRound(winner,target);}
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
    if (now >= projectile.expiresAt) {
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
    if (now >= projectile.expiresAt) {
      grenadeProjectiles.delete(projectile.id);
      broadcastGameEvent(projectile.owner, "grenadeProjectileRemove", { id: projectile.id });
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
        if (target.id === projectile.ownerId || target.health <= 0 || target.finished ||
            !isSameGame(projectile.owner, target)) continue;
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
      explodeGrenade(projectile, impact, now);
      grenadeProjectiles.delete(projectile.id);
      broadcastGameEvent(projectile.owner, "grenadeProjectileRemove", { id: projectile.id });
      continue;
    }

    projectile.x = nextX;
    projectile.y = nextY;
    projectile.z = nextZ;
    projectile.vy -= SMOKE_PROJECTILE_GRAVITY * dt;
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
    health: 100, kills: 0, deaths: 0,
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
    input: { forward: 0, strafe: 0, crouch: false },
    crouched: false,
    respawnAt: 0,
    invulnerableUntil: 0,
    damageHitstopUntil: 0,
    damageSlowUntil: 0,
    botThinkAt: 0
  });
}

function updateBot(p, now) {
  if (!p.isBot || p.health <= 0 || p.finished || now < p.botThinkAt) return;
  p.botThinkAt = now + 100 + Math.random() * 80;

  const isAreaBot = p.mode === AREA_MODE;
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
  const match = isAreaBot ? areaMatches.get(p.matchId) : null;
  const targets = Array.from(players.values()).filter((other) =>
    other.id !== p.id &&
    other.health > 0 &&
    isSameGame(p, other) &&
    (isAreaBot ? other.team !== p.team : !other.isBot)
  );

  // 視認できる敵がいる場合だけ戦闘を優先し、遮蔽物越しの敵には釣られず制圧へ向かう。
  const visibleTargets = isAreaBot ? targets.filter((other) => {
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

  // 視認中の敵との交戦は優先し、それ以外の時間は制圧地点へ向かう。
  const zone = isAreaBot ? areaMap.areaZone : null;
  const livingTeamMembersInZone = zone ? Array.from(players.values()).filter((other) =>
    isSameGame(p, other) && other.health > 0 && other.team === p.team &&
    Math.hypot(other.x - zone.x, other.z - zone.z) <= zone.radius
  ).length : 0;
  const botInsideZone = Boolean(zone && Math.hypot(p.x - zone.x, p.z - zone.z) <= zone.radius * 0.9);
  const enemyOwnsOrUnclaimedZone = Boolean(zone && (!match?.ownerTeam || match.ownerTeam !== p.team));
  const enemyIsTakingZone = Boolean(match?.captureTeam && match.captureTeam !== p.team);
  // 中立/敵側のエリアでは味方の人数にかかわらずBOTも制圧に参加する。
  // 自チーム所有中は、エリア内の味方が2人未満なら守備要員として向かう。
  const needsObjectiveSupport = livingTeamMembersInZone < 2 || enemyOwnsOrUnclaimedZone || enemyIsTakingZone;
  const moveToObjective = Boolean(zone && !botInsideZone && visibleTargets.length === 0 && needsObjectiveSupport);
  // 敵が視認できないときは、エリア内にいるBOTが持ち場を離れないようにする。
  const holdObjective = Boolean(zone && botInsideZone && visibleTargets.length === 0);

  if (moveToObjective) {
    const dx = zone.x - p.x;
    const dz = zone.z - p.z;
    const distance = Math.max(0.001, Math.hypot(dx, dz));
    const targetYaw = Math.atan2(-dx, -dz);
    const yawDelta = Math.atan2(Math.sin(targetYaw - p.yaw), Math.cos(targetYaw - p.yaw));
    p.yaw += clamp(yawDelta, -0.18, 0.18);
    p.pitch = 0;
    const origin = { x: p.x, y: p.y + PLAYER_HEIGHT - 0.15, z: p.z };
    const dir = directionFromAngles(p.yaw, 0);
    const wallDistance = rayHitsObstacle(origin, dir, 3.8, p);
    if (wallDistance !== null && wallDistance < 2.4) {
      // 直進路が塞がれている場合は斜めに回り込み、壁の前で停滞しにくくする。
      const turnDirection = Math.sin(now / 1700 + (p.botOffset || 0)) >= 0 ? 1 : -1;
      p.yaw += turnDirection * 0.48;
      p.input.forward = 0.34;
      p.input.strafe = turnDirection * 0.72;
    } else {
      p.input.forward = 1;
      p.input.strafe = Math.sin(now / 1100 + (p.botOffset || 0)) * 0.12;
    }
    p.input.crouch = false;
    return;
  }

  if (!targets.length) {
    if (isAreaBot && holdObjective) {
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
    if (isAreaBot && visibleTargets.length) {
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
  p.yaw += clamp(yawDelta, -0.16, 0.16);
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
    // 射線が通らず撃ち合っていない間は、壁を避けながら最大速度で索敵する。
    if (wallDistance !== null && wallDistance < 2.4) p.yaw += Math.sin(now / 900) >= 0 ? 0.42 : -0.42;
    p.input.forward = 1;
    p.input.strafe = Math.sin(now / 850) * 0.2;
  } else if (distance > 5) {
    p.input.forward = 1;
    p.input.strafe = Math.sin(now / 850) * 0.35;
  } else {
    p.input.forward = -0.2;
    p.input.strafe = Math.sin(now / 500) * 0.5;
  }
  p.input.crouch = false;
  // 両モードのBOTは、射線が通り照準条件を満たしたとき60%の確率で射撃する。
  const botFireChance = 0.60;
  const botAimOffChance = isAreaBot ? 0.82 : 0.5;
  if (visible && Math.abs(yawDelta) < 0.085 && now - p.lastFire >= WEAPONS[p.weapon].fireInterval && Math.random() < botFireChance) {
    const originalYaw = p.yaw;
    const originalPitch = p.pitch;
    if (Math.random() < botAimOffChance) {
      const aimOffset = isAreaBot ? 0.3 + Math.random() * 0.32 : 0.2 + Math.random() * 0.18;
      p.yaw += (Math.random() < 0.5 ? -1 : 1) * aimOffset;
      p.pitch = clamp(p.pitch + (Math.random() - 0.5) * (isAreaBot ? 0.38 : 0.24), -1.0, 1.0);
    }
    fireShot(p);
    p.yaw = originalYaw;
    p.pitch = originalPitch;
  }
}

function respawnBot(p, now) {
  const spawn = pickSpawnForPlayer(p, p.botSpawnIndex || 0);
  p.x = spawn[0]; p.y = 0; p.z = spawn[2];
  p.yaw = 0; p.pitch = 0;
  p.velocityY = 0; p.grounded = true; p.lastGroundedAt = now;
  p.health = Number(p.maxHealth) || 100;
  p.ammo = WEAPONS[p.weapon].magazineSize;
  p.reloadingUntil = 0; p.lastFire = 0;
  p.input = { forward: 0, strafe: 0, crouch: false };
  p.crouched = false; p.respawnAt = 0;
  p.invulnerableUntil = now + 1500;
  p.damageHitstopUntil = 0; p.damageSlowUntil = 0;
}

function collides(x, z, y = 0, height = PLAYER_HEIGHT, player = null) {
  const map = getMapForPlayer(player);
  const bounds = map.world;
  const mapObstacles = map.obstacles || [];
  if (x < bounds.minX + PLAYER_RADIUS || x > bounds.maxX - PLAYER_RADIUS) return true;
  if (z < bounds.minZ + PLAYER_RADIUS || z > bounds.maxZ - PLAYER_RADIUS) return true;

  const bodyBottom = y;
  const bodyTop = y + height;

  return mapObstacles.some((o) => {
    if (bodyTop <= 0 || bodyBottom >= o.h) return false;
    return x > o.x - o.w / 2 - PLAYER_RADIUS &&
      x < o.x + o.w / 2 + PLAYER_RADIUS &&
      z > o.z - o.d / 2 - PLAYER_RADIUS &&
      z < o.z + o.d / 2 + PLAYER_RADIUS;
  });
}

function getRampHeight(ramp, x, z) {
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
  return clamp(t, 0, 1) * ramp.h;
}

function getGroundHeight(x, z, playerY = 0, player = null) {
  let height = 0;
  const map = getMapForPlayer(player);

  for (const ramp of map.ramps || []) {
    const rampHeight = getRampHeight(ramp, x, z);
    if (rampHeight !== null) height = Math.max(height, rampHeight);
  }

  for (const platform of map.elevatedPlatforms || []) {
    if (Math.abs(x - platform.x) <= platform.w / 2 - PLAYER_RADIUS &&
        Math.abs(z - platform.z) <= platform.d / 2 + PLAYER_RADIUS) {
      height = Math.max(height, platform.h);
    }
  }
  return height;
}

function canStand(p) {
  return !collides(p.x, p.z, p.y, PLAYER_HEIGHT, p);
}

function updateCrouchState(p) {
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

function movePlayer(p, dt) {
  const now = Date.now();
  if (p.ultimateActiveUntil > now) { p.input = { forward: 0, strafe: 0, crouch: false }; p.velocityY = 0; p.grounded = false; return; }
  if (p.ultimateActiveUntil && p.ultimateActiveUntil <= now) { p.ultimateActiveUntil = 0; p.velocityY = -1; p.grounded = false; p.ultimateAnchor = null; }
  updateCrouchState(p);

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
    p.velocityY = JUMP_SPEED * (p.charm === "jump" ? 1.3 : 1) * (p.charm === "floor" || p.charm === "jump" || !isOnFloorTile(p, "slime") ? 1 : 0.5);
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
  // 床と武器固有能力の速度倍率は加算せず、必ず乗算して適用する。
  const floorMoveMultiplier = p.charm === "floor" || !isOnFloorTile(p, "slime") ? 1 : 0.5;
  const weaponMoveMultiplier =
    p.weapon === "minigun" ? 0.6 :
    p.weapon === "bow" && p.bowChargeStartedAt ? 0.5 : 1;
  const charmMoveMultiplier = p.charm === "speed" ? 1.5 : 1;
  let moveSpeed = baseMoveSpeed * floorMoveMultiplier * weaponMoveMultiplier * charmMoveMultiplier;
  if (p.damageHitstopUntil > now) {
    moveSpeed = 0;
  } else if (p.damageSlowUntil > now) {
    moveSpeed *= DAMAGE_SLOW_MULTIPLIER;
  }
  const dx = (-sin * forward + cos * strafe) * moveSpeed * dt;
  const dz = (-cos * forward - sin * strafe) * moveSpeed * dt;
  const nextX = p.x + dx;
  const nextZ = p.z + dz;

  // 坂の上を歩いている場合は、坂の高さまで自然に追従させる。
  // 空中にいる場合は現在のYをそのまま使って壁との衝突だけ判定する。
  const nextGroundX = getGroundHeight(nextX, p.z, p.y, p);
  const currentHeight = p.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const collisionY = wasGrounded && p.velocityY <= 0
    ? Math.max(p.y, nextGroundX)
    : p.y;

  if (!collides(nextX, p.z, collisionY, currentHeight, p)) {
    p.x = nextX;
  }

  const nextGroundZ = getGroundHeight(p.x, nextZ, p.y, p);
  const collisionY2 = wasGrounded && p.velocityY <= 0
    ? Math.max(p.y, nextGroundZ)
    : p.y;

  if (!collides(p.x, nextZ, collisionY2, currentHeight, p)) {
    p.z = nextZ;
  }

  // ジャンプ中/空中では必ず重力を適用する。
  const previousY = p.y;
  if (!p.grounded) {
    p.velocityY -= GRAVITY * dt;
    p.y += p.velocityY * dt;
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
  } else {
    p.grounded = false;
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

function rayHitsObstacle(origin, direction, maxDistance, player = null) {
  let nearest = Infinity;
  const mapObstacles = getMapForPlayer(player).obstacles || [];

  for (const o of mapObstacles) {
    // 壁を少し厚くして、弾が境界をすり抜けるのを防ぐ。
    const minX = o.x - o.w / 2;
    const maxX = o.x + o.w / 2;
    const minY = 0;
    const maxY = o.h;
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


function rayHitsPlayer(origin, direction, target) {
  const targetHeight = target.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const targetCenter = { x: target.x, y: target.y + targetHeight * 0.5, z: target.z };
  const ox = origin.x - targetCenter.x;
  const oy = origin.y - targetCenter.y;
  const oz = origin.z - targetCenter.z;

  const b = 2 * (ox * direction.x + oy * direction.y + oz * direction.z);
  const c = ox * ox + oy * oy + oz * oz - PLAYER_RADIUS * PLAYER_RADIUS * 4;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;

  const t1 = (-b - Math.sqrt(disc)) / 2;
  const t2 = (-b + Math.sqrt(disc)) / 2;
  const t = t1 >= 0 ? t1 : t2;
  if (t < 0) return null;

  const hitY = origin.y + direction.y * t - target.y;
  let multiplier = 1.0;
  let zone = "body";

  if (hitY >= 1.42) {
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

  p.reloadingUntil = now + weapon.reloadTime * (p.charm === "reload" ? 0.25 : 1);
  return true;
}

function fireShot(shooter, sniperScoped = false, bowCharge = 1) {
  const weapon = WEAPONS[shooter.weapon];
  const now = Date.now();

  // リスポーン直後3秒間は攻撃できない。
  if (shooter.invulnerableUntil > now) return;

  finishReload(shooter, now);
  if (shooter.reloadingUntil > now) return;
  if (now - shooter.lastFire < weapon.fireInterval) return;

  if (shooter.weapon === "smoke") {
    shooter.lastFire = now;
    spawnSmokeProjectile(shooter, now);
    return;
  }

  if (shooter.weapon === "bow") {
    bowCharge = clamp(Number(bowCharge) || 0, 0, 1);
  } else if (shooter.weapon !== "minigun" && !weapon.melee && shooter.ammo <= 0) {
    startReload(shooter);
    return;
  }

  shooter.lastFire = now;
  if (!weapon.melee && !["bow", "minigun"].includes(shooter.weapon)) {
    shooter.ammo -= 1;
    if (Array.isArray(shooter.weaponAmmo)) shooter.weaponAmmo[shooter.activeWeaponSlot || 0] = shooter.ammo;
  }
  if (shooter.weapon === "grenadeLauncher") {
    spawnGrenadeProjectile(shooter, now);
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
    let best = null;
    for (const target of players.values()) {
      if (target.id === shooter.id || target.health <= 0 || target.finished || !isSameGame(shooter, target)) continue;
      if (shooter.mode === TRAINING_MODE && !target.isBot) continue;
      if (shooter.mode === AREA_MODE && target.team === shooter.team) continue;
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
      if (verticalDiff > 1.6) continue;
      const wallDistance = rayHitsObstacle(origin, {x: dx / distance, y: 0, z: dz / distance}, distance, shooter);
      if (wallDistance !== null && wallDistance < distance - 0.35) continue;
      if (!best || distance < best.distance) best = {target, distance};
    }
    if (best) {
      const damage = weapon.damage;
      applyIncomingDamage(best.target, damage);
      shooter.ultimateCharge = Math.min(100, (shooter.ultimateCharge || 0) + damage / 3);
      damageByTarget.set(best.target.id, {id: best.target.id, target: best.target, damage, zone: "body"});
      hitResults.push({target: best.target, damage, zone: "body", x: best.target.x, y: best.target.y + 1, z: best.target.z});
    }
  }

  for (let pellet = 0; !weapon.melee && pellet < pelletCount; pellet++) {
    let yaw = shooter.yaw;
    let pitch = shooter.pitch;

    if (weapon.spread) {
      // エリアモードのBOTだけ人間プレイヤーより弾が大きくブレる。ジャンプ中はさらに拡大する。
      const botSpreadMultiplier = shooter.isBot && shooter.mode === AREA_MODE ? 6.5 : 1;
      const isMoving = Math.abs(Number(shooter.input?.forward || 0)) > 0.05 ||
        Math.abs(Number(shooter.input?.strafe || 0)) > 0.05;
      const movingShotMultiplier = shooter.weapon === "sniper" && isMoving ? 2 : 1;
      const movementSpreadMultiplier = (shooter.grounded ? 1 : 2.0) * movingShotMultiplier;
      const sniperUnscopedMultiplier = shooter.weapon === "sniper" && !sniperScoped ? 3.2 : 1;
      const spread = weapon.spread * botSpreadMultiplier * movementSpreadMultiplier * sniperUnscopedMultiplier;
      yaw += (Math.random() - 0.5) * spread;
      pitch += (Math.random() - 0.5) * spread;
    }

    const dir = directionFromAngles(yaw, pitch);
    let bestHit = null;

    for (const target of players.values()) {
      if (target.id === shooter.id || target.health <= 0 || target.finished || !isSameGame(shooter, target)) continue;
      if (shooter.mode === TRAINING_MODE && !target.isBot) continue;
      if (shooter.mode === AREA_MODE && target.team === shooter.team) continue;
      // リスポーン直後3秒間は被弾しない。
      if (target.invulnerableUntil > now) continue;

      const hitInfo = rayHitsPlayer(origin, dir, target);
      if (hitInfo === null || hitInfo.t > weapon.range) continue;

      // プレイヤーより手前に壁がある場合は、その弾丸を無効にする。
      const wallDistance = rayHitsObstacle(origin, dir, hitInfo.t, shooter);
      if (wallDistance !== null && wallDistance <= hitInfo.t + 0.001) continue;

      if (!bestHit || hitInfo.t < bestHit.t) {
        bestHit = { target, ...hitInfo };
      }
    }

    if (!bestHit) continue;

    const distanceMultiplier = getDistanceDamageMultiplier(weapon, bestHit.t);
    const baseShotDamage = shooter.weapon === "bow" ? 5 + 105 * bowCharge : weapon.damage;
    const damage = baseShotDamage * bestHit.multiplier * distanceMultiplier;
    applyIncomingDamage(bestHit.target, damage);
    shooter.ultimateCharge = Math.min(100, (shooter.ultimateCharge || 0) + damage / 3);

    const existing = damageByTarget.get(bestHit.target.id);
    if (existing) {
      existing.damage += damage;
      if (bestHit.zone === "head") existing.zone = "head";
    } else {
      damageByTarget.set(bestHit.target.id, {
        id: bestHit.target.id,
        target: bestHit.target,
        damage,
        zone: bestHit.zone
      });
    }

    hitResults.push({
      target: bestHit.target,
      damage,
      zone: bestHit.zone,
      x: origin.x + dir.x * bestHit.t,
      y: origin.y + dir.y * bestHit.t,
      z: origin.z + dir.z * bestHit.t
    });
  }

  for (const result of damageByTarget.values()) {
    const feedback = hitResults
      .filter((hit) => hit.target.id === result.target.id)
      .reduce((best, hit) => hit.damage > best.damage ? hit : best, hitResults.find((hit) => hit.target.id === result.target.id));

    io.to(shooter.id).emit("damageDealt", {
      targetId: result.target.id,
      damage: Math.round(result.damage),
      zone: result.zone,
      x: feedback?.x ?? result.target.x,
      y: feedback?.y ?? result.target.y + 1,
      z: feedback?.z ?? result.target.z
    });

    // 被弾時に短いヒットストップを入れ、その後しばらく移動速度を低下させる。
    // 同時に複数回被弾した場合は効果時間を更新する。
    const damageNow = Date.now();
    result.target.damageHitstopUntil = damageNow + DAMAGE_HITSTOP_MS;
    result.target.damageSlowUntil = damageNow + DAMAGE_SLOW_MS;

    io.to(result.target.id).emit("damageTaken", {
      damage: Math.round(result.damage),
      zone: result.zone,
      hitstopMs: DAMAGE_HITSTOP_MS,
      slowMs: DAMAGE_SLOW_MS,
      slowMultiplier: DAMAGE_SLOW_MULTIPLIER
    });

    if (result.target.health <= 0) {
      shooter.health = Number(shooter.maxHealth) || 100;
      result.target.health = 0;
      result.target.respawnAt = Date.now() + 5000;
      result.target.kills = result.target.kills || 0;
      shooter.kills += 1;
      result.target.deaths += 1;
      if(result.target.mode==="Duel")resolveDuelRound(shooter,result.target);

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
      const botSpreadMultiplier = shooter.isBot && shooter.mode === AREA_MODE ? 6.5 : 1;
      const movementSpreadMultiplier = shooter.grounded ? 1 : 2.0;
      const visualSpread = weapon.spread * botSpreadMultiplier * movementSpreadMultiplier;
      visualYaw += (Math.random() - 0.5) * visualSpread;
      visualPitch += (Math.random() - 0.5) * visualSpread;
    }
    const visualDir = directionFromAngles(visualYaw, visualPitch);
    const wallDistance = rayHitsObstacle(origin, visualDir, weapon.range, shooter);
    const distance = wallDistance ?? weapon.range;
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
    hit,
    tracers: visualTracers
  });
}

function applyIncomingDamage(target, amount) {
  const damage = Math.max(0, Number(amount) || 0);
  if (target.shield > 0 && damage >= target.shield) { target.shield = 0; return 0; }
  if (target.shield > 0) { target.shield -= damage; return 0; }
  target.health = Math.max(0, target.health - damage);
  return damage;
}

function publicPlayer(p, includeSkin = false) {
  return {
    id: p.id,
    mode: p.mode || MAP_MODE,
    team: p.team || null,
    matchId: p.matchId || null,
    finished: Boolean(p.finished),
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    crouched: Boolean(p.crouched),
    name: p.name,
    health: p.health,
    maxHealth: Number(p.maxHealth) || 100,
    ultimateCharge: Math.min(100, Number(p.ultimateCharge) || 0),
    ultimateType: ["skyfall", "teleport", "aegis"].includes(p.ultimateType) ? p.ultimateType : "skyfall",
    shield: Math.max(0, Number(p.shield) || 0),
    ultimateActiveUntil: Number(p.ultimateActiveUntil) || 0,
    charm: ["hp", "speed", "reload", "jump", "floor", "aim"].includes(p.charm) ? p.charm : "none",
    kills: p.kills,
    deaths: p.deaths,
    weapon: p.weapon,
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

function createAreaPlayer({ id, name, skin, weapon, secondaryWeapon, charm, ultimateType, team, matchId, isBot, botSpawnIndex = 0 }, spawn) {
  const now = Date.now();
  const safeCharm = !isBot && ["hp", "speed", "reload", "jump", "floor", "aim"].includes(charm) ? charm : "none";
  const maxHealth = safeCharm === "hp" ? 120 : 100;
  return {
    id,
    name,
    skin: skin || "",
    mode: AREA_MODE,
    team,
    matchId,
    isBot: Boolean(isBot),
    finished: false,
    botSpawnIndex,
    botThinkAt: 0,
    botOffset: Math.random() * 1000,
    x: spawn[0],
    y: spawn[1] || 0,
    z: spawn[2],
    yaw: team === "blue" ? -Math.PI / 2 : Math.PI / 2,
    pitch: 0,
    health: maxHealth,
    maxHealth,
    ultimateCharge: 0,
    ultimateType: !isBot && ["skyfall", "teleport", "aegis"].includes(ultimateType) ? ultimateType : "skyfall",
    shield: 0,
    ultimateActiveUntil: 0,
    ultimateAnchor: null,
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
    charm: ["hp", "speed", "reload", "jump", "floor", "aim"].includes(data.charm) ? data.charm : "none",
    ultimateType: ["skyfall", "teleport", "aegis"].includes(data.ultimateType) ? data.ultimateType : "skyfall",
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
    const maps = [...availableMaps, ...areaMaps].map((map) => ({ id: map.id, name: map.name, mode: map === areaMap ? AREA_MODE : MAP_MODE }));
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
  socket.on("duel:rematchReady",({roomId}={})=>{const r=duelRooms.get(String(roomId||""));if(!r||r.status!=="ended")return;if(!r.readyIds.includes(socket.id))r.readyIds.push(socket.id);for(const id of r.playerIds)io.to(id).emit("duel:rematchWaiting",{readyCount:r.readyIds.length});if(r.playerIds.every(id=>r.readyIds.includes(id))){const map=[...availableMaps,...areaMaps].find(m=>m.id===r.mapId)||activeMap;r.status="starting";r.scores={};r.readyIds=[];r.roundResolved=false;const now=Date.now();for(const id of r.playerIds){const p=players.get(id);if(!p)continue;const index=r.playerIds.indexOf(id);const spawn=map.spawnPoints[index%map.spawnPoints.length]||map.spawnPoints[0];p.duelMap=map;p.duelFirstTo=r.firstTo;p.finished=false;p.health=100;p.x=spawn[0];p.y=spawn[1]||0;p.z=spawn[2];p.yaw=index===0?0:Math.PI;p.pitch=0;p.respawnAt=0;p.invulnerableUntil=now+3000;p.ammo=WEAPONS[p.weapon].magazineSize;if(Array.isArray(p.weaponAmmo))p.weaponAmmo[p.activeWeaponSlot||0]=p.ammo;p.reloadingUntil=0;p.lastFire=0;}r.status="playing";for(const id of r.playerIds)io.to(id).emit("duel:rematchStarted",{firstTo:r.firstTo});for(const id of r.playerIds){const p=players.get(id);if(p)io.to(id).emit("world",getWorldPayloadForMap(map,"Duel"));}broadcastPlayers();}});
  socket.on("leaveMatch", () => {
    const player = players.get(socket.id);
    if (player?.minigunFireTimer) clearTimeout(player.minigunFireTimer);
    if (player) player.minigunBurstId = (player.minigunBurstId || 0) + 1;
    if (player?.mode === AREA_MODE) {
      removeAreaPlayer(socket.id);
      return;
    }

    if (player?.mode === TRAINING_MODE) removeTrainingBots(player.matchId);
    if (player?.mode === "Duel") removeDuelPlayer(socket.id, player.duelRoomId);
    if (player) players.delete(socket.id);
    syncBots();
    broadcastPlayers();
    socket.emit("returnedToLobby");
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
    const charm = ["hp", "speed", "reload", "jump", "floor", "aim"].includes(data.charm) ? data.charm : "none";
    const maxHealth = charm === "hp" ? 120 : 100;
    const name = sanitizeName(data.name);
    const skin = sanitizeSkin(data.skin);
    const duelRoom=data.mode==="Duel"?duelRooms.get(String(data.duelRoomId||"")):null;
    if(data.mode==="Duel"&&(!duelRoom||!duelRoom.playerIds.includes(socket.id))){socket.emit("duel:error",{message:"タイマン部屋が見つかりません。"});return;}
    const requestedMode = data.mode === "Duel" ? "Duel" : data.mode === TRAINING_MODE ? TRAINING_MODE : data.mode === "Wander" ? "Wander" : MAP_MODE;
    const duelMap=requestedMode==="Duel"?[...availableMaps,...areaMaps].find(m=>m.id===duelRoom.mapId)||activeMap:null;
    const trainingMap = requestedMode === TRAINING_MODE ? createTrainingMap() : null;
    const wanderMap = requestedMode === "Wander"
      ? (data.mapId === "shooting-range" ? createTrainingMap() : [...availableMaps, ...areaMaps].find((map) => map.id === data.mapId) || activeMap)
      : null;
    const chosenMap = duelMap || trainingMap || wanderMap;
    const spawnIndex=requestedMode==="Duel"?Math.max(0,duelRoom.playerIds.indexOf(socket.id)):0;
    const spawn = chosenMap ? (chosenMap.spawnPoints[spawnIndex%chosenMap.spawnPoints.length]||chosenMap.spawnPoints[0]) : pickSpawn();
    socket.emit("world", chosenMap ? getWorldPayloadForMap(chosenMap, requestedMode) : getWorldPayload());

    players.set(socket.id, {
      id: socket.id,
      name,
      skin,
      mode: requestedMode,
      team: null,
      matchId: requestedMode === "Duel" ? duelRoom.id : requestedMode === TRAINING_MODE || requestedMode === "Wander" ? socket.id : null,
      duelRoomId: requestedMode === "Duel" ? duelRoom.id : null,
      duelMap, duelFirstTo: requestedMode === "Duel" ? duelRoom.firstTo : null,
      trainingMap,
      wanderMap,
      finished: false,
      isBot: false,
      x: spawn[0],
      y: 0,
      z: spawn[2],
      yaw: 0,
      pitch: 0,
      health: maxHealth,
      maxHealth,
      ultimateCharge: 0,
      ultimateType: ["skyfall", "teleport", "aegis"].includes(data.ultimateType) ? data.ultimateType : "skyfall",
      shield: 0,
      ultimateActiveUntil: 0,
      ultimateAnchor: null,
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
      grounded: true,
      lastGroundedAt: Date.now(),
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
    else if (requestedMode !== "Wander") syncBots();
    socket.emit("joined", { player: publicPlayer(players.get(socket.id), true) });
    broadcastPlayers();
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

  socket.on("input", (input = {}) => {
    const p = players.get(socket.id);
    if (!p || p.finished) return;

    p.input.forward = clamp(Number(input.forward) || 0, -1, 1);
    p.input.strafe = clamp(Number(input.strafe) || 0, -1, 1);
    p.input.crouch = Boolean(input.crouch);
    if (Number.isFinite(Number(input.yaw))) p.yaw = Number(input.yaw);
    if (Number.isFinite(Number(input.pitch))) p.pitch = clamp(Number(input.pitch), -1.35, 1.35);
  });

  socket.on("ultimate", (payload = {}) => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished || (p.ultimateCharge || 0) < 100) return;
    const type = ["skyfall", "teleport", "aegis"].includes(p.ultimateType) ? p.ultimateType : "skyfall";
    const now = Date.now();
    if (type === "skyfall") {
      p.ultimateAnchor = { x: p.x, y: p.y, z: p.z }; p.y += 12; p.velocityY = 0; p.grounded = false; p.ultimateActiveUntil = now + 5000;
    } else if (type === "aegis") {
      p.health = 100; p.maxHealth = 100; p.shield = 100; p.ultimateActiveUntil = 0;
    } else {
      const map = getMapForPlayer(p); const x = Number(payload.x), z = Number(payload.z);
      if (!Number.isFinite(x) || !Number.isFinite(z) || x < map.world.minX + PLAYER_RADIUS || x > map.world.maxX - PLAYER_RADIUS || z < map.world.minZ + PLAYER_RADIUS || z > map.world.maxZ - PLAYER_RADIUS) return;
      const y = getGroundHeight(x, z, p.y, p); if (collides(x, z, y, PLAYER_HEIGHT, p)) return;
      p.x = x; p.y = y; p.z = z; p.velocityY = 0; p.grounded = true;
    }
    p.ultimateCharge = 0; broadcastPlayers();
  });

  socket.on("jump", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished) return;
    // 120msだけ入力を保持し、移動中の同時入力でもジャンプを取りこぼさない。
    p.jumpQueuedUntil = Date.now() + 120;
  });

  socket.on("fire", (fireData = {}) => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished || ["bow", "minigun"].includes(p.weapon)) return;
    fireShot(p, p.weapon === "sniper" && fireData.scoped === true);
  });

  socket.on("bowChargeStart", () => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || p.health <= 0 || p.finished || p.weapon !== "bow" || p.invulnerableUntil > now) return;
    if (now < (p.bowNextFireAt || 0)) return;
    if (!p.bowChargeStartedAt) p.bowChargeStartedAt = now;
  });

  socket.on("bowRelease", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished || p.weapon !== "bow" || !p.bowChargeStartedAt) return;
    const now = Date.now();
    const startedAt = p.bowChargeStartedAt;
    p.bowChargeStartedAt = 0;
    if (now < (p.bowNextFireAt || 0)) return;
    p.bowNextFireAt = now + 750;
    fireShot(p, false, clamp((now - startedAt) / 1500, 0, 1));
  });

  socket.on("minigunChargeStart", () => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || p.health <= 0 || p.finished || p.weapon !== "minigun" || p.invulnerableUntil > now) return;
    if (!p.minigunChargeStartedAt && !p.minigunFireTimer) p.minigunChargeStartedAt = now;
  });

  socket.on("minigunRelease", () => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || p.health <= 0 || p.finished || p.weapon !== "minigun" || !p.minigunChargeStartedAt) return;
    const chargedMs = clamp(now - p.minigunChargeStartedAt, 0, 3000);
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
    p.y = spawn[1] || 0;
    p.z = spawn[2];
    p.velocityY = 0;
    p.grounded = true;
    p.lastGroundedAt = Date.now();
    p.jumpQueuedUntil = 0;
    p.health = Number(p.maxHealth) || 100;
    p.shield = 0;
    p.ultimateActiveUntil = 0;
    p.ultimateAnchor = null;
    p.ammo = WEAPONS[p.weapon].magazineSize;
    if (Array.isArray(p.weaponAmmo)) p.weaponAmmo[p.activeWeaponSlot || 0] = p.ammo;
    p.reloadingUntil = 0;
    p.lastFire = 0;
    p.input.crouch = false;
    p.crouched = false;
    p.respawnAt = 0;
    // リスポーン後3秒間は攻撃・被弾ともに無効。
    p.invulnerableUntil = Date.now() + 3000;
    p.damageHitstopUntil = 0;
    p.damageSlowUntil = 0;

    socket.emit("respawned", { player: publicPlayer(p) });
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
    if (p.weapon === nextWeapon) return;
    p.bowChargeStartedAt = 0;
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
    const nextSlot = Number(slotIndex);
    if (!Number.isInteger(nextSlot) || nextSlot < 0 || nextSlot >= Math.min(2, p.weaponSlots.length)) return;
    const nextWeapon = sanitizeWeapon(p.weaponSlots[nextSlot]);
    if (nextSlot === p.activeWeaponSlot && nextWeapon === p.weapon) return;
    p.bowChargeStartedAt = 0;
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

  socket.on("disconnect", () => {
    cancelAreaQueue(socket.id);
    const player = players.get(socket.id);
    if (player?.mode === AREA_MODE) {
      removeAreaPlayer(socket.id);
      return;
    }
    if (player?.mode === TRAINING_MODE) removeTrainingBots(player.matchId);
    if (player?.mode === "Duel") removeDuelPlayer(socket.id, player.duelRoomId);
    players.delete(socket.id);
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

setInterval(() => {
  const dt = 1 / TICK_RATE;
  const now = Date.now();
  for (const p of players.values()) {
    if (p.finished) continue;
    if (p.isBot && p.mode === TRAINING_MODE) {
      if (p.health <= 0 && p.respawnAt && now >= p.respawnAt) {
        p.health = Number(p.maxHealth) || 100;
        p.respawnAt = 0;
        p.damageHitstopUntil = 0;
        p.damageSlowUntil = 0;
      }
      continue;
    }
    if (p.isBot && p.health <= 0 && p.respawnAt && now >= p.respawnAt) {
      respawnBot(p, now);
    }
    if (p.health > 0) {
      p.ultimateCharge = Math.min(100, (p.ultimateCharge || 0) + dt * 0.5);
      if (p.isBot) updateBot(p, now);
      finishReload(p, now);
      movePlayer(p, dt);
      // 燃える床は、接地中に500msごとに15ダメージ。
      const onFireFloorGround = p.charm !== "floor" && isOnFloorTile(p, "fire") &&
        getGroundHeight(p.x, p.z, p.y, p) <= 0.08 && p.y <= 0.08;
      if (onFireFloorGround && now >= (p.fireFloorDamageAt || 0)) {
        p.fireFloorDamageAt = now + 500;
        applyIncomingDamage(p, 3);
        if (p.health <= 0) {
          p.respawnAt = now + 5000;
          p.deaths = (p.deaths || 0) + 1;
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
  updateAreaMatches(dt, now);
  broadcastState();
}, 1000 / TICK_RATE);

// Keep the SPA fallback after all API routes so unknown API requests never receive index.html.
app.get("/{*splat}", (req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "APIが見つかりません" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mobile FPS server running on http://0.0.0.0:${PORT}`);
  console.log(`[AutoUpdate] GitHubの更新を${AUTO_UPDATE_INTERVAL / 1000}秒ごとに確認します。`);
  setTimeout(checkForUpdates, AUTO_UPDATE_INTERVAL);
  setInterval(checkForUpdates, AUTO_UPDATE_INTERVAL);
});
