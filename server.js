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
const WORLD = { minX: -48, maxX: 48, minZ: -48, maxZ: 48 };
const PLAYER_SPEED = 6.5;
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.7;
const GRAVITY = 22;
const JUMP_SPEED = 8.5;

const LOG_DIR = path.join(__dirname, "logs");
const ERROR_LOG_FILE = path.join(LOG_DIR, "error.log");

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (error) {
  process.stderr.write("[ErrorLog] ログフォルダを作成できません: " + error.message + "\n");
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
    process.stderr.write("[ErrorLog] エラーログを書き込めません: " + writeError.message + "\n");
  }
}

// 常に「最後に発生したエラー」1件だけを保存する。
// 新しいエラーが発生すると error.log を上書きするため、2個前のログは残らない。
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  originalConsoleError(...args);

  const message = args.map((arg) => formatError(arg)).join(" ");
  saveLatestError(message, "console.error");
};

process.on("uncaughtException", (error) => {
  saveLatestError(error, "uncaughtException");
  originalConsoleError("[Fatal] 未処理の例外:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  saveLatestError(reason, "unhandledRejection");
  originalConsoleError("[Fatal] 未処理のPromise拒否:", reason);
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
    name: "Shotgun",
    damage: 10,
    fireInterval: 750,
    range: 40,
    pellets: 8,
    spread: 0.15,
    falloffStart: 8,
    minDamageMultiplier: 0.25,
    magazineSize: 8,
    reloadTime: 1400,
    automatic: false
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

            const child = spawn(process.execPath, [__filename], {
              cwd: __dirname,
              detached: true,
              stdio: "inherit",
              env: process.env
            });

            child.unref();
            process.exit(0);
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
  originalConsoleError("[Server Error]", error);
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, port: PORT, players: players.size });
});

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const players = new Map();
const spawnPoints = [
  [-36, 0, -36], [36, 0, 36], [-36, 0, 36], [36, 0, -36],
  [0, 0, -36], [0, 0, 36], [-36, 0, 0], [36, 0, 0]
];

const obstacles = [
  { x: 0, z: 0, w: 12, d: 2, h: 3.5 },
  { x: 0, z: 18, w: 18, d: 4, h: 3 },
  { x: 0, z: -18, w: 18, d: 4, h: 3 },
  { x: 20, z: 0, w: 4, d: 18, h: 3 },
  { x: -20, z: 0, w: 4, d: 18, h: 3 },
  { x: 22, z: 25, w: 10, d: 4, h: 3 },
  { x: -22, z: -25, w: 10, d: 4, h: 3 },
  { x: 22, z: -25, w: 10, d: 4, h: 3 },
  { x: -22, z: 25, w: 10, d: 4, h: 3 },
  { x: 10, z: 10, w: 8, d: 3, h: 2.2 },
  { x: -10, z: 10, w: 8, d: 3, h: 2.2 },
  { x: 10, z: -10, w: 8, d: 3, h: 2.2 },
  { x: -10, z: -10, w: 8, d: 3, h: 2.2 },
  { x: 30, z: 10, w: 4, d: 8, h: 2.5 },
  { x: -30, z: -10, w: 4, d: 8, h: 2.5 },
  { x: 30, z: -10, w: 4, d: 8, h: 2.5 },
  { x: -30, z: 10, w: 4, d: 8, h: 2.5 }
];

const ramps = [
  { x: 0, z: -3, w: 12, d: 4, h: 3.5, direction: "north" },
  { x: 0, z: 3, w: 12, d: 4, h: 3.5, direction: "south" }
];

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

function pickSpawn() {
  const alivePlayers = Array.from(players.values()).filter((p) => p.health > 0);
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

function collides(x, z, y = 0, height = PLAYER_HEIGHT) {
  if (x < WORLD.minX + PLAYER_RADIUS || x > WORLD.maxX - PLAYER_RADIUS) return true;
  if (z < WORLD.minZ + PLAYER_RADIUS || z > WORLD.maxZ - PLAYER_RADIUS) return true;

  const bodyBottom = y;
  const bodyTop = y + height;

  return obstacles.some((o) => {
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

function getGroundHeight(x, z, playerY = 0) {
  let height = 0;

  for (const ramp of ramps) {
    const rampHeight = getRampHeight(ramp, x, z);
    if (rampHeight !== null) height = Math.max(height, rampHeight);
  }

  const center = obstacles[0];
  if (Math.abs(x - center.x) <= center.w / 2 - PLAYER_RADIUS &&
      Math.abs(z - center.z) <= center.d / 2 + PLAYER_RADIUS) {
    height = Math.max(height, center.h);
  }
  return height;
}

function movePlayer(p, dt) {
  const now = Date.now();

  // 現在位置の地面高さを基準に、接地状態を毎tick正しく更新する。
  const groundBefore = getGroundHeight(p.x, p.z, p.y);
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
  const dx = (-sin * forward + cos * strafe) * PLAYER_SPEED * dt;
  const dz = (-cos * forward - sin * strafe) * PLAYER_SPEED * dt;
  const nextX = p.x + dx;
  const nextZ = p.z + dz;

  // 坂の上を歩いている場合は、坂の高さまで自然に追従させる。
  // 空中にいる場合は現在のYをそのまま使って壁との衝突だけ判定する。
  const nextGroundX = getGroundHeight(nextX, p.z, p.y);
  const collisionY = wasGrounded && p.velocityY <= 0
    ? Math.max(p.y, nextGroundX)
    : p.y;

  if (!collides(nextX, p.z, collisionY)) {
    p.x = nextX;
  }

  const nextGroundZ = getGroundHeight(p.x, nextZ, p.y);
  const collisionY2 = wasGrounded && p.velocityY <= 0
    ? Math.max(p.y, nextGroundZ)
    : p.y;

  if (!collides(p.x, nextZ, collisionY2)) {
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
    for (const obstacle of obstacles) {
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
      if (p.y < obstacle.h && p.y + PLAYER_HEIGHT > obstacle.h && previousY >= obstacle.h) {
        p.y = obstacle.h;
        p.velocityY = 0;
        p.grounded = true;
        p.lastGroundedAt = now;
        break;
      }
    }
  }

  const ground = getGroundHeight(p.x, p.z, p.y);

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

  p.x = clamp(p.x, WORLD.minX + PLAYER_RADIUS, WORLD.maxX - PLAYER_RADIUS);
  p.z = clamp(p.z, WORLD.minZ + PLAYER_RADIUS, WORLD.maxZ - PLAYER_RADIUS);
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

function rayHitsObstacle(origin, direction, maxDistance) {
  let nearest = Infinity;

  for (const o of obstacles) {
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
  const targetCenter = { x: target.x, y: target.y + 1.0, z: target.z };
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
      // 通常時も少しブレを大きくし、ジャンプ中はさらにブレる。
      const spreadMultiplier = shooter.grounded ? 1 : 2.0;
      const spread = weapon.spread * spreadMultiplier;
      yaw += (Math.random() - 0.5) * spread;
      pitch += (Math.random() - 0.5) * spread;
    }

    const dir = directionFromAngles(yaw, pitch);
    let bestHit = null;

    for (const target of players.values()) {
      if (target.id === shooter.id || target.health <= 0) continue;
      // リスポーン直後3秒間は被弾しない。
      if (target.invulnerableUntil > now) continue;

      const hitInfo = rayHitsPlayer(origin, dir, target);
      if (hitInfo === null || hitInfo.t > weapon.range) continue;

      // プレイヤーより手前に壁がある場合は、その弾丸を無効にする。
      const wallDistance = rayHitsObstacle(origin, dir, hitInfo.t);
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

    io.to(result.target.id).emit("damageTaken", {
      damage: Math.round(result.damage),
      zone: result.zone
    });

    if (result.target.health <= 0) {
      shooter.health = 100;
      result.target.health = 0;
      result.target.respawnAt = Date.now() + 5000;
      result.target.kills = result.target.kills || 0;
      shooter.kills += 1;
      result.target.deaths += 1;

      io.emit("elimination", {
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
      visualYaw += (Math.random() - 0.5) * weapon.spread;
      visualPitch += (Math.random() - 0.5) * weapon.spread;
    }
    const visualDir = directionFromAngles(visualYaw, visualPitch);
    const wallDistance = rayHitsObstacle(origin, visualDir, weapon.range);
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

  io.emit("shot", {
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

function publicPlayer(p) {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    name: p.name,
    health: p.health,
    kills: p.kills,
    deaths: p.deaths,
    weapon: p.weapon,
    ammo: p.ammo,
    reloading: p.reloadingUntil > Date.now(),
    respawnAt: p.respawnAt || 0,
    invulnerableUntil: p.invulnerableUntil || 0
  };
}

io.on("connection", (socket) => {
  socket.emit("world", { obstacles, ramps, world: WORLD, weapons: Object.fromEntries(
    Object.entries(WEAPONS).map(([id, w]) => [id, { name: w.name, fireInterval: w.fireInterval }])
  ) });

  socket.on("join", (data = {}) => {
    if (players.has(socket.id)) return;

    const weapon = sanitizeWeapon(data.weapon);
    const name = sanitizeName(data.name);
    const spawn = pickSpawn();

    players.set(socket.id, {
      id: socket.id,
      name,
      x: spawn[0],
      y: 0,
      z: spawn[2],
      yaw: 0,
      pitch: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      weapon,
      ammo: WEAPONS[weapon].magazineSize,
      reloadingUntil: 0,
      lastFire: 0,
      velocityY: 0,
      grounded: true,
      lastGroundedAt: Date.now(),
      jumpQueuedUntil: 0,
      input: { forward: 0, strafe: 0 },
      respawnAt: 0,
      invulnerableUntil: 0
    });

    socket.emit("joined", { player: publicPlayer(players.get(socket.id)) });
    io.emit("players", Array.from(players.values()).map(publicPlayer));
  });

  socket.on("input", (input = {}) => {
    const p = players.get(socket.id);
    if (!p) return;

    p.input.forward = clamp(Number(input.forward) || 0, -1, 1);
    p.input.strafe = clamp(Number(input.strafe) || 0, -1, 1);
    if (Number.isFinite(Number(input.yaw))) p.yaw = Number(input.yaw);
    if (Number.isFinite(Number(input.pitch))) p.pitch = clamp(Number(input.pitch), -1.35, 1.35);
  });

  socket.on("jump", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0) return;
    // 120msだけ入力を保持し、移動中の同時入力でもジャンプを取りこぼさない。
    p.jumpQueuedUntil = Date.now() + 120;
  });

  socket.on("fire", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0) return;
    fireShot(p);
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);
    if (!p || p.health > 0) return;
    if (!p.respawnAt || Date.now() < p.respawnAt) return;

    const spawn = pickSpawn();
    p.x = spawn[0];
    p.y = 0;
    p.z = spawn[2];
    p.velocityY = 0;
    p.grounded = true;
    p.lastGroundedAt = Date.now();
    p.jumpQueuedUntil = 0;
    p.health = 100;
    p.ammo = WEAPONS[p.weapon].magazineSize;
    p.reloadingUntil = 0;
    p.lastFire = 0;
    p.respawnAt = 0;
    // リスポーン後3秒間は攻撃・被弾ともに無効。
    p.invulnerableUntil = Date.now() + 3000;

    socket.emit("respawned", { player: publicPlayer(p) });
    io.emit("players", Array.from(players.values()).map(publicPlayer));
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0) return;
    startReload(p);
  });

  socket.on("changeWeapon", (weapon) => {
    const p = players.get(socket.id);
    if (!p) return;

    const nextWeapon = sanitizeWeapon(weapon);
    if (p.weapon === nextWeapon) return;

    p.weapon = nextWeapon;
    p.ammo = WEAPONS[nextWeapon].magazineSize;
    p.reloadingUntil = 0;
    p.lastFire = 0;
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    io.emit("players", Array.from(players.values()).map(publicPlayer));
  });
});

setInterval(() => {
  const dt = 1 / TICK_RATE;
  const now = Date.now();
  for (const p of players.values()) {
    if (p.health > 0) {
      finishReload(p, now);
      movePlayer(p, dt);
    }
  }

  io.emit("state", Array.from(players.values()).map(publicPlayer));
}, 1000 / TICK_RATE);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mobile FPS server running on http://0.0.0.0:${PORT}`);
  console.log(`[AutoUpdate] GitHubの更新を${AUTO_UPDATE_INTERVAL / 1000}秒ごとに確認します。`);
  setTimeout(checkForUpdates, AUTO_UPDATE_INTERVAL);
  setInterval(checkForUpdates, AUTO_UPDATE_INTERVAL);
});
