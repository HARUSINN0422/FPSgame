const path = require("path");
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

const WEAPONS = {
  pistol: {
    name: "Pistol",
    damage: 34,
    fireInterval: 330,
    range: 70
  },
  rifle: {
    name: "Rifle",
    damage: 20,
    fireInterval: 110,
    range: 90
  },
  shotgun: {
    name: "Shotgun",
    damage: 16,
    fireInterval: 600,
    range: 42,
    pellets: 8,
    spread: 0.075
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
  { x: 0, z: 0, w: 12, d: 4, h: 3.5 },
  { x: 0, z: 18, w: 18, d: 4, h: 3 },
  { x: 0, z: -18, w: 18, d: 4, h: 3 },
  { x: 20, z: 0, w: 4, d: 18, h: 3 },
  { x: -20, z: 0, w: 4, d: 18, h: 3 },
  { x: 22, z: 25, w: 10, d: 4, h: 3 },
  { x: -22, z: -25, w: 10, d: 4, h: 3 },
  { x: 22, z: -25, w: 10, d: 4, h: 3 },
  { x: -22, z: 25, w: 10, d: 4, h: 3 }
];

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeWeapon(value) {
  return Object.prototype.hasOwnProperty.call(WEAPONS, value) ? value : "pistol";
}

function pickSpawn() {
  const candidates = spawnPoints.filter(([x, _y, z]) => {
    for (const p of players.values()) {
      if (Math.hypot(p.x - x, p.z - z) < 4) return false;
    }
    return true;
  });
  return candidates[Math.floor(Math.random() * (candidates.length || spawnPoints.length))] || [0, 0, 10];
}

function collides(x, z) {
  if (x < WORLD.minX + PLAYER_RADIUS || x > WORLD.maxX - PLAYER_RADIUS) return true;
  if (z < WORLD.minZ + PLAYER_RADIUS || z > WORLD.maxZ - PLAYER_RADIUS) return true;

  return obstacles.some((o) => {
    return (
      x > o.x - o.w / 2 - PLAYER_RADIUS &&
      x < o.x + o.w / 2 + PLAYER_RADIUS &&
      z > o.z - o.d / 2 - PLAYER_RADIUS &&
      z < o.z + o.d / 2 + PLAYER_RADIUS
    );
  });
}

function movePlayer(p, dt) {
  p.velocityY -= GRAVITY * dt;
  p.y += p.velocityY * dt;

  if (p.y <= 0) {
    p.y = 0;
    p.velocityY = 0;
    p.grounded = true;
  } else {
    p.grounded = false;
  }

  let forward = Number(p.input.forward || 0);
  let strafe = Number(p.input.strafe || 0);
  const len = Math.hypot(forward, strafe);
  if (len > 1) {
    forward /= len;
    strafe /= len;
  }

  const sin = Math.sin(p.yaw);
  const cos = Math.cos(p.yaw);

  const dx = (sin * forward + cos * strafe) * PLAYER_SPEED * dt;
  const dz = (-cos * forward + sin * strafe) * PLAYER_SPEED * dt;

  const nextX = p.x + dx;
  const nextZ = p.z + dz;

  if (!collides(nextX, p.z)) p.x = nextX;
  if (!collides(p.x, nextZ)) p.z = nextZ;

  p.x = clamp(p.x, WORLD.minX + PLAYER_RADIUS, WORLD.maxX - PLAYER_RADIUS);
  p.z = clamp(p.z, WORLD.minZ + PLAYER_RADIUS, WORLD.maxZ - PLAYER_RADIUS);
  p.pitch = clamp(p.pitch, -1.35, 1.35);
}

function directionFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp
  };
}

function rayHitsPlayer(origin, direction, target) {
  const targetCenter = { x: target.x, y: 1.0, z: target.z };
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
  return t >= 0 ? t : null;
}

function fireShot(shooter) {
  const weapon = WEAPONS[shooter.weapon];
  const now = Date.now();

  if (now - shooter.lastFire < weapon.fireInterval) return;
  shooter.lastFire = now;

  const pelletCount = weapon.pellets || 1;
  let bestHit = null;

  for (let pellet = 0; pellet < pelletCount; pellet++) {
    let yaw = shooter.yaw;
    let pitch = shooter.pitch;

    if (weapon.spread) {
      yaw += (Math.random() - 0.5) * weapon.spread;
      pitch += (Math.random() - 0.5) * weapon.spread;
    }

    const dir = directionFromAngles(yaw, pitch);
    const origin = {
      x: shooter.x,
      y: PLAYER_HEIGHT - 0.15,
      z: shooter.z
    };

    for (const target of players.values()) {
      if (target.id === shooter.id || target.health <= 0) continue;

      const t = rayHitsPlayer(origin, dir, target);
      if (t === null || t > weapon.range) continue;

      if (!bestHit || t < bestHit.t) {
        bestHit = { target, t };
      }
    }

    if (bestHit) break;
  }

  let hit = null;
  if (bestHit) {
    const target = bestHit.target;
    target.health -= weapon.damage * (weapon.pellets > 1 ? 1 : 1);
    hit = { id: target.id, damage: weapon.damage };

    if (target.health <= 0) {
      target.health = 0;
      shooter.kills += 1;
      target.deaths += 1;
      io.emit("elimination", {
        killerId: shooter.id,
        victimId: target.id,
        killerKills: shooter.kills
      });

      setTimeout(() => {
        if (!players.has(target.id)) return;
        const respawn = pickSpawn();
        target.x = respawn[0];
        target.y = 0;
        target.z = respawn[2];
        target.velocityY = 0;
        target.grounded = true;
        target.health = 100;
      }, 900);
    }
  }

  io.emit("shot", {
    id: shooter.id,
    x: shooter.x,
    y: PLAYER_HEIGHT - 0.15,
    z: shooter.z,
    yaw: shooter.yaw,
    pitch: shooter.pitch,
    weapon: shooter.weapon,
    hit
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
    health: p.health,
    kills: p.kills,
    deaths: p.deaths,
    weapon: p.weapon
  };
}

io.on("connection", (socket) => {
  socket.emit("world", { obstacles, world: WORLD, weapons: Object.fromEntries(
    Object.entries(WEAPONS).map(([id, w]) => [id, { name: w.name, fireInterval: w.fireInterval }])
  ) });

  socket.on("join", (data = {}) => {
    const weapon = sanitizeWeapon(data.weapon);
    const spawn = pickSpawn();

    players.set(socket.id, {
      id: socket.id,
      x: spawn[0],
      y: 0,
      z: spawn[2],
      yaw: 0,
      pitch: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      weapon,
      lastFire: 0,
      velocityY: 0,
      grounded: true,
      input: { forward: 0, strafe: 0 }
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
    if (!p || p.health <= 0 || !p.grounded) return;
    p.velocityY = JUMP_SPEED;
    p.grounded = false;
  });

  socket.on("fire", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0) return;
    fireShot(p);
  });

  socket.on("changeWeapon", (weapon) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.weapon = sanitizeWeapon(weapon);
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    io.emit("players", Array.from(players.values()).map(publicPlayer));
  });
});

setInterval(() => {
  const dt = 1 / TICK_RATE;
  for (const p of players.values()) {
    if (p.health > 0) movePlayer(p, dt);
  }

  io.emit("state", Array.from(players.values()).map(publicPlayer));
}, 1000 / TICK_RATE);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mobile FPS server running on http://0.0.0.0:${PORT}`);
  console.log(`[AutoUpdate] GitHubの更新を${AUTO_UPDATE_INTERVAL / 1000}秒ごとに確認します。`);
  setTimeout(checkForUpdates, AUTO_UPDATE_INTERVAL);
  setInterval(checkForUpdates, AUTO_UPDATE_INTERVAL);
});
