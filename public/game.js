import * as THREE from "three";

const socket = io();

async function requestLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock("landscape");
    }
  } catch (_) {}
}

requestLandscape();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7fa4c4);
scene.fog = new THREE.Fog(0x7fa4c4, 45, 160);

const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.05, 150);
camera.rotation.order = "YXZ";

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.getElementById("game").appendChild(renderer.domElement);

const hemi = new THREE.HemisphereLight(0xdff1ff, 0x506050, 2.5);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 3.0);
sun.position.set(12, 30, 8);
sun.castShadow = true;
scene.add(sun);

const worldGroup = new THREE.Group();
scene.add(worldGroup);

const remotePlayers = new Map();
const tracers = [];
const clock = new THREE.Clock();

let joined = false;
let myId = null;
let myState = null;
let selectedWeapon = "pistol";
let playerName = "";
let lastInputSent = 0;
let lastFrameTime = performance.now();

const movement = {
  forward: false,
  back: false,
  left: false,
  right: false
};

let yaw = 0;
let pitch = 0;
let lookPointerId = null;
let lastLookX = 0;
let lastLookY = 0;
let pointerLocked = false;

const weaponNames = {
  pistol: "Pistol",
  rifle: "Rifle",
  shotgun: "Shotgun"
};

const weaponConfig = {
  pistol: { fireInterval: 330, automatic: false },
  rifle: { fireInterval: 110, automatic: true },
  shotgun: { fireInterval: 600, automatic: false }
};

let localLastFire = 0;
let autoFireTimer = null;

function getCookie(name) {
  const prefix = name + "=";
  const item = document.cookie.split("; ").find(row => row.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : "";
}

function setCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = name + "=" + encodeURIComponent(value) + "; expires=" + expires + "; path=/; SameSite=Lax";
}

function loadPlayerName() {
  const input = document.getElementById("playerName");
  if (input) input.value = getCookie("fps_player_name");
}

function savePlayerName() {
  const input = document.getElementById("playerName");
  const value = (input?.value || "").trim().replace(/[<>]/g, "");
  if (!value) {
    showMessage("名前を入力してください");
    return null;
  }
  playerName = value.slice(0, 16);
  setCookie("fps_player_name", playerName);
  input.value = playerName;
  return playerName;
}

loadPlayerName();

function makeBox(w, h, d, x, y, z, color = 0x647080) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: .9, metalness: .05 })
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  worldGroup.add(mesh);
  return mesh;
}

function buildWorld(data) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshStandardMaterial({ color: 0x526052, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  worldGroup.add(floor);

  const grid = new THREE.GridHelper(100, 50, 0x879487, 0x6b756b);
  grid.position.y = 0.01;
  worldGroup.add(grid);

  for (const o of data.obstacles || []) {
    makeBox(o.w, o.h, o.d, o.x, o.h / 2, o.z, 0x687582);
  }

  makeBox(100, 3, 1, 0, 1.5, -50, 0x58636e);
  makeBox(100, 3, 1, 0, 1.5, 50, 0x58636e);
  makeBox(1, 3, 100, -50, 1.5, 0, 0x58636e);
  makeBox(1, 3, 100, 50, 1.5, 0, 0x58636e);
}

function createWeaponMesh(weapon) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: weapon === "shotgun" ? 0x9a9a9a : weapon === "rifle" ? 0x4d6b4f : 0x303030,
    roughness: .7,
    metalness: .25
  });

  const barrelLength = weapon === "shotgun" ? .55 : weapon === "rifle" ? .7 : .42;
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(.10, .10, barrelLength), material);
  barrel.position.z = -barrelLength / 2;
  group.add(barrel);

  const stock = new THREE.Mesh(
    new THREE.BoxGeometry(weapon === "rifle" ? .16 : .13, .16, .28),
    material
  );
  stock.position.z = .16;
  group.add(stock);

  if (weapon === "shotgun") {
    const pump = new THREE.Mesh(new THREE.BoxGeometry(.16, .12, .24), material);
    pump.position.set(0, -.07, -.12);
    group.add(pump);
  }

  group.position.set(.34, 1.02, -.22);
  group.rotation.x = -.08;
  return group;
}

function createRemotePlayer() {
  const root = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b8cff, roughness: .8 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xffd2ba, roughness: .9 });
  const legMat = new THREE.MeshStandardMaterial({ color: 0x20252d, roughness: .9 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(.62, .72, .36), bodyMat);
  torso.position.y = 1.05;
  torso.castShadow = true;

  const head = new THREE.Mesh(new THREE.SphereGeometry(.28, 14, 12), skinMat);
  head.position.y = 1.62;
  head.castShadow = true;

  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(.09, .45, 4, 8), bodyMat);
  armL.position.set(-.43, 1.05, 0);
  armL.rotation.z = -.15;
  armL.castShadow = true;

  const armR = new THREE.Mesh(new THREE.CapsuleGeometry(.09, .45, 4, 8), bodyMat);
  armR.position.set(.43, 1.05, 0);
  armR.rotation.z = .15;
  armR.castShadow = true;

  const legL = new THREE.Mesh(new THREE.CapsuleGeometry(.11, .55, 4, 8), legMat);
  legL.position.set(-.18, .43, 0);
  legL.castShadow = true;

  const legR = new THREE.Mesh(new THREE.CapsuleGeometry(.11, .55, 4, 8), legMat);
  legR.position.set(.18, .43, 0);
  legR.castShadow = true;

  const weapon = createWeaponMesh("pistol");
  root.add(torso, head, armL, armR, legL, legR, weapon);
  root.userData.weaponMesh = weapon;
  root.userData.weaponType = "pistol";
  scene.add(root);
  return root;
}

function updateRemotePlayers(players) {
  const alive = new Set();

  for (const p of players) {
    if (p.id === myId) {
      myState = p;
      continue;
    }

    alive.add(p.id);
    let obj = remotePlayers.get(p.id);
    if (!obj) {
      obj = createRemotePlayer();
      remotePlayers.set(p.id, obj);
    }

    obj.position.set(p.x, p.y || 0, p.z);
    obj.rotation.y = p.yaw;
    obj.visible = p.health > 0;

    if (obj.userData.weaponType !== p.weapon) {
      const oldWeapon = obj.userData.weaponMesh;
      if (oldWeapon) obj.remove(oldWeapon);
      const newWeapon = createWeaponMesh(p.weapon);
      obj.add(newWeapon);
      obj.userData.weaponMesh = newWeapon;
      obj.userData.weaponType = p.weapon;
    }
  }

  for (const [id, obj] of remotePlayers) {
    if (!alive.has(id)) {
      scene.remove(obj);
      remotePlayers.delete(id);
    }
  }

  document.getElementById("playerCount").textContent = String(players.length);
}

function updateCamera() {
  if (!myState) return;
  camera.position.set(myState.x, 1.62 + (myState.y || 0), myState.z);
  camera.rotation.set(pitch, yaw, 0);
}

function sendInput(now) {
  if (!joined || now - lastInputSent < 33) return;

  const forward = (movement.forward ? 1 : 0) + (movement.back ? -1 : 0);
  const strafe = (movement.right ? 1 : 0) + (movement.left ? -1 : 0);

  socket.emit("input", { forward, strafe, yaw, pitch });
  lastInputSent = now;
}

function jump() {
  if (!joined) return;
  socket.emit("jump");
}

function fire() {
  if (!joined) return;

  const now = performance.now();
  const cfg = weaponConfig[selectedWeapon];
  if (now - localLastFire < cfg.fireInterval * .8) return;

  localLastFire = now;
  socket.emit("fire");
}

function startFiring() {
  fire();
  const cfg = weaponConfig[selectedWeapon];
  if (!cfg.automatic || autoFireTimer) return;
  autoFireTimer = setInterval(fire, cfg.fireInterval);
}

function stopFiring() {
  if (autoFireTimer) {
    clearInterval(autoFireTimer);
    autoFireTimer = null;
  }
}

function showMessage(text) {
  const el = document.getElementById("message");
  el.textContent = text;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    el.textContent = "";
  }, 1300);
}

function createTracer(event) {
  const start = new THREE.Vector3(event.x, event.y + (event.yOffset || 0), event.z);
  const dir = directionFromAngles(event.yaw, event.pitch);
  const end = start.clone().add(dir.multiplyScalar(event.hit ? 18 : 12));

  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({ color: 0xffc86b });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  tracers.push({ line, born: performance.now() });
}

function directionFromAngles(y, p) {
  // Three.jsのカメラが実際に向いている方向（ローカル-Z）と同じ計算にする。
  // yaw=0 のとき前方は -Z、右方向は +X。
  const cp = Math.cos(p);
  return new THREE.Vector3(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp);
}

socket.on("world", buildWorld);

socket.on("joined", ({ player }) => {
  joined = true;
  playerName = player.name || playerName;
  setCookie("fps_player_name", playerName);
  myId = player.id;
  myState = player;
  yaw = player.yaw;
  pitch = player.pitch;

  document.getElementById("weaponScreen").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");
  document.getElementById("touchUi").classList.remove("hidden");
  document.getElementById("weaponName").textContent = weaponNames[selectedWeapon];
});

socket.on("players", updateRemotePlayers);

socket.on("state", (players) => {
  updateRemotePlayers(players);
  updateCamera();

  if (myState) {
    document.getElementById("health").textContent = String(myState.health);
    document.getElementById("kills").textContent = String(myState.kills);
    document.getElementById("deaths").textContent = String(myState.deaths);
  }
});

socket.on("shot", createTracer);

socket.on("elimination", (event) => {
  if (event.killerId === myId) showMessage("ヒット");
  if (event.victimId === myId) showMessage("リスポーン");
});

socket.on("connect", () => {
  showMessage("サーバー接続済み");
});

for (const button of document.querySelectorAll(".weapon-card")) {
  button.addEventListener("click", () => {
    const name = savePlayerName();
    if (!name) return;

    selectedWeapon = button.dataset.weapon;

    if (!joined) {
      socket.emit("join", { name, weapon: selectedWeapon });
    } else {
      socket.emit("changeWeapon", selectedWeapon);
      document.getElementById("weaponName").textContent = weaponNames[selectedWeapon];
      document.getElementById("weaponScreen").classList.add("hidden");
    }
  });
}

document.getElementById("changeWeapon").addEventListener("click", () => {
  document.getElementById("weaponScreen").classList.remove("hidden");
  loadPlayerName();
});

const fullscreenButton = document.getElementById("fullscreenButton");
async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen?.();
    } else {
      await document.exitFullscreen?.();
    }
  } catch (_) {}
}
fullscreenButton?.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  if (fullscreenButton) fullscreenButton.textContent = document.fullscreenElement ? "全画面解除" : "全画面";
});

for (const button of document.querySelectorAll(".move-btn")) {
  const key = button.dataset.key;
  const set = (value, event) => {
    event.preventDefault();
    movement[key] = value;
    button.setPointerCapture?.(event.pointerId);
  };

  button.addEventListener("pointerdown", (e) => set(true, e));
  button.addEventListener("pointerup", (e) => set(false, e));
  button.addEventListener("pointercancel", (e) => set(false, e));
  button.addEventListener("pointerleave", (e) => {
    if (e.buttons === 0) movement[key] = false;
  });
}

const jumpButton = document.getElementById("jumpButton");
jumpButton.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  jumpButton.setPointerCapture?.(e.pointerId);
  jump();
});

const fireButton = document.getElementById("fireButton");
fireButton.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  fireButton.setPointerCapture?.(e.pointerId);
  startFiring();
});

const lookSurface = renderer.domElement;

lookSurface.addEventListener("pointerdown", (e) => {
  if (!joined || e.pointerType === "mouse") return;
  if (e.clientX < innerWidth * .42 || e.clientX > innerWidth * .58) {
    lookPointerId = e.pointerId;
    lastLookX = e.clientX;
    lastLookY = e.clientY;
    lookSurface.setPointerCapture?.(e.pointerId);
  }
});

lookSurface.addEventListener("pointermove", (e) => {
  if (e.pointerId !== lookPointerId) return;

  const dx = e.clientX - lastLookX;
  const dy = e.clientY - lastLookY;
  lastLookX = e.clientX;
  lastLookY = e.clientY;

  yaw -= dx * .0045;
  pitch -= dy * .0045;
  pitch = THREE.MathUtils.clamp(pitch, -1.35, 1.35);
});

function releaseLook(e) {
  if (e.pointerId === lookPointerId) lookPointerId = null;
}
lookSurface.addEventListener("pointerup", releaseLook);
lookSurface.addEventListener("pointercancel", releaseLook);

lookSurface.addEventListener("click", () => {
  if (!joined || !window.matchMedia("(pointer:fine)").matches) return;
  if (document.pointerLockElement !== lookSurface) {
    lookSurface.requestPointerLock?.();
  }
});

document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === lookSurface;
});

document.addEventListener("mousemove", (e) => {
  if (!pointerLocked) return;

  yaw -= e.movementX * .0028;
  pitch -= e.movementY * .0028;
  pitch = THREE.MathUtils.clamp(pitch, -1.35, 1.35);
});

lookSurface.addEventListener("contextmenu", (e) => e.preventDefault());

lookSurface.addEventListener("mousedown", (e) => {
  if (!joined || e.button !== 0) return;
  if (document.pointerLockElement !== lookSurface) {
    lookSurface.requestPointerLock?.();
  }
  startFiring();
});

window.addEventListener("mouseup", (e) => {
  if (e.button === 0) stopFiring();
});

window.addEventListener("blur", stopFiring);

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyW" || e.code === "ArrowUp") movement.forward = true;
  if (e.code === "KeyS" || e.code === "ArrowDown") movement.back = true;
  if (e.code === "KeyA" || e.code === "ArrowLeft") movement.left = true;
  if (e.code === "KeyD" || e.code === "ArrowRight") movement.right = true;

  if (e.code === "Space") {
    e.preventDefault();
    jump();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "KeyW" || e.code === "ArrowUp") movement.forward = false;
  if (e.code === "KeyS" || e.code === "ArrowDown") movement.back = false;
  if (e.code === "KeyA" || e.code === "ArrowLeft") movement.left = false;
  if (e.code === "KeyD" || e.code === "ArrowRight") movement.right = false;
});

window.addEventListener("blur", () => {
  movement.forward = false;
  movement.back = false;
  movement.left = false;
  movement.right = false;
});

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
  renderer.setSize(innerWidth, innerHeight);
});

function animate(now) {
  requestAnimationFrame(animate);

  const dt = Math.min(.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  clock.getDelta();

  sendInput(now);
  updateCamera();

  for (let i = tracers.length - 1; i >= 0; i--) {
    if (now - tracers[i].born > 120) {
      scene.remove(tracers[i].line);
      tracers[i].line.geometry.dispose();
      tracers[i].line.material.dispose();
      tracers.splice(i, 1);
    }
  }

  renderer.render(scene, camera);
}

requestAnimationFrame(animate);
