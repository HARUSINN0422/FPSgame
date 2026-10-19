const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { execFile, spawn } = require("child_process");

const PORT = 3007;
const AUTO_UPDATE_INTERVAL = 60 * 1000;
const AUTO_UPDATE_BRANCH = "main";
const TICK_RATE = 20;
// マップデータは map/<ゲームモード>/*.json から読み込みます。
const PLAYER_SPEED = 6.5;
const CROUCH_SPEED = 4.2;
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
  pistol: {
    name: "Pistol",
    damage: 34,
    fireInterval: 400,
    range: 68,
    spread: 0.018,
    falloffStart: 16,
    minDamageMultiplier: 0.50,
    magazineSize: 12,
    reloadTime: 1000,
    automatic: false
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
    spread: 0.15, falloffStart: 8, minDamageMultiplier: 0.25,
    magazineSize: 8, reloadTime: 1400, automatic: false
  },
  marksman: {
    name: "Marksman", damage: 42, fireInterval: 500, range: 100, spread: 0.006,
    falloffStart: 55, minDamageMultiplier: 0.7, magazineSize: 10,
    reloadTime: 1300, automatic: false
  },
  sniper: {
    name: "Sniper", damage: 85, fireInterval: 1200, range: 130, spread: 0.0015,
    falloffStart: 80, minDamageMultiplier: 0.8, magazineSize: 5,
    reloadTime: 1900, automatic: false
  }
};

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

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, port: PORT, players: players.size });
});

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const players = new Map();

const MAP_ROOT = path.join(__dirname, "map");
const MAP_MODE = "Melee";
const AREA_MODE = "Area";
const MAP_ROTATION_INTERVAL_MS = 10 * 60 * 1000;
const MAP_CHANGE_COUNTDOWN_MS = 5 * 1000;
const AREA_QUEUE_DURATION_MS = 20 * 1000;
const AREA_CONTROL_HOLD_MS = 5 * 1000;
const AREA_PROGRESS_PER_PERCENT_MS = 1500;
const AREA_BOT_NAMES = ["Liam", "Noah", "Oliver", "James", "Elijah", "Mateo", "Theodore", "Henry", "Lucas", "Jack"];

function loadMapsForMode(mode) {
  const modeDirectory = path.join(MAP_ROOT, mode);
  const files = fs.readdirSync(modeDirectory)
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .sort();

  const maps = [];
  for (const file of files) {
    const fullPath = path.join(modeDirectory, file);
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
const availableMaps = loadMapsForMode(MAP_MODE);
const areaMaps = loadMapsForMode(AREA_MODE);
const areaMap = areaMaps[0];
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

function getMapInfo(map, mode = MAP_MODE) {
  return { mode, id: map.id, name: map.name, description: map.description || "" };
}

function getMapForPlayer(player) {
  return player?.mode === AREA_MODE ? areaMap : activeMap;
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


function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeWeapon(value) {
  return Object.prototype.hasOwnProperty.call(WEAPONS, value) ? value : "pistol";
}

function sanitizeName(value) {
  const name = String(value || "").trim().replace(/[<>]/g, "");
  return name.slice(0, 16) || "Player";
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
  if (modeA === AREA_MODE) return Boolean(a.matchId && a.matchId === b.matchId);
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
      p.input.forward = clamp(distance / 8, 0.45, 0.95);
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
    p.input.forward = 0.42;
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
  if (holdObjective) {
    // エリア確保中は敵を狙って射撃するが、追いかけてエリア外へ出ない。
    p.input.forward = 0;
    p.input.strafe = 0;
  } else if (distance > 5) {
    p.input.forward = wallDistance !== null && wallDistance < distance - 1 ? 0.12 : 0.45;
    p.input.strafe = Math.sin(now / 850) * 0.35;
  } else {
    p.input.forward = -0.08;
    p.input.strafe = Math.sin(now / 500) * 0.5;
  }
  p.input.crouch = false;

  const visible = distance <= WEAPONS[p.weapon].range && (wallDistance === null || wallDistance >= distance - 0.7);
  if (visible && Math.abs(yawDelta) < 0.12 && now - p.lastFire >= WEAPONS[p.weapon].fireInterval) {
    // 約半分の発射で意図的に照準をずらし、BOTの命中率を下げる。
    const originalYaw = p.yaw;
    const originalPitch = p.pitch;
    if (Math.random() < 0.5) {
      p.yaw += (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.18);
      p.pitch = clamp(p.pitch + (Math.random() - 0.5) * 0.24, -1.0, 1.0);
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
  p.health = 100;
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

function movePlayer(p, dt) {
  const now = Date.now();
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
    p.velocityY = JUMP_SPEED;
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
  let moveSpeed = baseMoveSpeed;
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
  p.reloadingUntil = 0;
  return true;
}

function startReload(p) {
  const weapon = WEAPONS[p.weapon];
  const now = Date.now();

  if (p.health <= 0 || p.reloadingUntil > now) return false;
  if (p.ammo >= weapon.magazineSize) return false;

  p.reloadingUntil = now + weapon.reloadTime;
  return true;
}

function fireShot(shooter) {
  const weapon = WEAPONS[shooter.weapon];
  const now = Date.now();

  // リスポーン直後3秒間は攻撃できない。
  if (shooter.invulnerableUntil > now) return;

  finishReload(shooter, now);
  if (shooter.reloadingUntil > now) return;
  if (now - shooter.lastFire < weapon.fireInterval) return;

  if (shooter.ammo <= 0) {
    startReload(shooter);
    return;
  }

  shooter.lastFire = now;
  shooter.ammo -= 1;

  const pelletCount = weapon.pellets || 1;
  const origin = {
    x: shooter.x,
    y: shooter.y + PLAYER_HEIGHT - 0.15,
    z: shooter.z
  };

  const hitResults = [];
  const damageByTarget = new Map();

  for (let pellet = 0; pellet < pelletCount; pellet++) {
    let yaw = shooter.yaw;
    let pitch = shooter.pitch;

    if (weapon.spread) {
      // エリアモードのBOTだけ人間プレイヤーより弾が大きくブレる。ジャンプ中はさらに拡大する。
      const botSpreadMultiplier = shooter.isBot && shooter.mode === AREA_MODE ? 4.5 : 1;
      const movementSpreadMultiplier = shooter.grounded ? 1 : 2.0;
      const spread = weapon.spread * botSpreadMultiplier * movementSpreadMultiplier;
      yaw += (Math.random() - 0.5) * spread;
      pitch += (Math.random() - 0.5) * spread;
    }

    const dir = directionFromAngles(yaw, pitch);
    let bestHit = null;

    for (const target of players.values()) {
      if (target.id === shooter.id || target.health <= 0 || target.finished || !isSameGame(shooter, target)) continue;
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
    const damage = weapon.damage * bestHit.multiplier * distanceMultiplier;
    bestHit.target.health -= damage;

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
      shooter.health = 100;
      result.target.health = 0;
      result.target.respawnAt = Date.now() + 5000;
      result.target.kills = result.target.kills || 0;
      shooter.kills += 1;
      result.target.deaths += 1;

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
  for (let pellet = 0; pellet < pelletCount; pellet++) {
    let visualYaw = shooter.yaw;
    let visualPitch = shooter.pitch;
    if (weapon.spread) {
      const botSpreadMultiplier = shooter.isBot && shooter.mode === AREA_MODE ? 4.5 : 1;
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
    kills: p.kills,
    deaths: p.deaths,
    weapon: p.weapon,
    weaponSlots: Array.isArray(p.weaponSlots) ? [...p.weaponSlots] : [p.weapon],
    activeWeaponSlot: Number(p.activeWeaponSlot) || 0,
    ammo: p.ammo,
    reloading: p.reloadingUntil > Date.now(),
    respawnAt: p.respawnAt || 0,
    invulnerableUntil: p.invulnerableUntil || 0,
    damageHitstopUntil: p.damageHitstopUntil || 0,
    damageSlowUntil: p.damageSlowUntil || 0,
    isBot: Boolean(p.isBot),
    ...(includeSkin && p.skin ? { skin: p.skin } : {})
  };
}

function createAreaPlayer({ id, name, skin, weapon, secondaryWeapon, team, matchId, isBot, botSpawnIndex = 0 }, spawn) {
  const now = Date.now();
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
    health: 100,
    kills: 0,
    deaths: 0,
    weapon,
    weaponSlots: [weapon, secondaryWeapon],
    activeWeaponSlot: 0,
    ammo: WEAPONS[weapon].magazineSize,
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
    queuedAt: Date.now()
  };
  if (entry.secondaryWeapon === entry.weapon) {
    entry.secondaryWeapon = entry.weapon === "rifle" ? "shotgun" : "rifle";
  }

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

  socket.on("joinAreaQueue", (data = {}) => {
    queueAreaPlayer(socket, data);
  });

  socket.on("cancelAreaQueue", () => {
    cancelAreaQueue(socket.id);
  });

  socket.on("leaveAreaMatch", () => {
    removeAreaPlayer(socket.id);
  });

  socket.on("leaveMatch", () => {
    const player = players.get(socket.id);
    if (player?.mode === AREA_MODE) {
      removeAreaPlayer(socket.id);
      return;
    }

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
    const name = sanitizeName(data.name);
    const skin = sanitizeSkin(data.skin);
    const spawn = pickSpawn();
    socket.emit("world", getWorldPayload());

    players.set(socket.id, {
      id: socket.id,
      name,
      skin,
      mode: MAP_MODE,
      team: null,
      matchId: null,
      finished: false,
      isBot: false,
      x: spawn[0],
      y: 0,
      z: spawn[2],
      yaw: 0,
      pitch: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      weapon,
      weaponSlots,
      activeWeaponSlot: 0,
      ammo: WEAPONS[weapon].magazineSize,
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
      damageSlowUntil: 0
    });

    syncBots();
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

  socket.on("jump", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished) return;
    // 120msだけ入力を保持し、移動中の同時入力でもジャンプを取りこぼさない。
    p.jumpQueuedUntil = Date.now() + 120;
  });

  socket.on("fire", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || p.finished) return;
    fireShot(p);
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);
    if (!p || p.finished || p.health > 0) return;
    if (!p.respawnAt || Date.now() < p.respawnAt) return;

    const spawn = pickSpawnForPlayer(p, p.botSpawnIndex || 0);
    p.x = spawn[0];
    p.y = spawn[1] || 0;
    p.z = spawn[2];
    p.velocityY = 0;
    p.grounded = true;
    p.lastGroundedAt = Date.now();
    p.jumpQueuedUntil = 0;
    p.health = 100;
    p.ammo = WEAPONS[p.weapon].magazineSize;
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
    if (!Array.isArray(p.weaponSlots)) p.weaponSlots = [p.weapon, nextWeapon];
    p.weaponSlots[p.activeWeaponSlot || 0] = nextWeapon;
    p.weapon = nextWeapon;
    p.ammo = WEAPONS[nextWeapon].magazineSize;
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
    p.activeWeaponSlot = nextSlot;
    p.weapon = nextWeapon;
    p.ammo = WEAPONS[nextWeapon].magazineSize;
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
    p.health = 100;
    p.ammo = WEAPONS[p.weapon].magazineSize;
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
    if (p.isBot && p.health <= 0 && p.respawnAt && now >= p.respawnAt) {
      respawnBot(p, now);
    }
    if (p.health > 0) {
      if (p.isBot) updateBot(p, now);
      finishReload(p, now);
      movePlayer(p, dt);
    }
  }

  updateAreaMatches(dt, now);
  broadcastState();
}, 1000 / TICK_RATE);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mobile FPS server running on http://0.0.0.0:${PORT}`);
  console.log(`[AutoUpdate] GitHubの更新を${AUTO_UPDATE_INTERVAL / 1000}秒ごとに確認します。`);
  setTimeout(checkForUpdates, AUTO_UPDATE_INTERVAL);
  setInterval(checkForUpdates, AUTO_UPDATE_INTERVAL);
});
