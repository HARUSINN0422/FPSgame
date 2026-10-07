import * as THREE from "three";

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  timeout: 10000
});

let wasJoinedBeforeDisconnect = false;
let reconnecting = false;

// iPhone/iPad等で誤ってブラウザズームされた場合の復旧ボタン。
const zoomResetButton = document.getElementById("zoomResetButton");
function updateZoomResetButton() {
  const scale = window.visualViewport?.scale ?? 1;
  zoomResetButton?.classList.toggle("hidden", scale <= 1.01);
}

zoomResetButton?.addEventListener("click", () => {
  // ブラウザ側のピンチ/ダブルタップズームを初期状態へ戻すため再読み込みする。
  window.location.reload();
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateZoomResetButton);
  window.visualViewport.addEventListener("scroll", updateZoomResetButton);
}
updateZoomResetButton();

async function requestLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock("landscape");
    }
  } catch (_) {}
}

// Safari/iOS can still zoom on a rapid double tap even with the viewport meta tag.
let lastTouchEnd = 0;
document.addEventListener("touchend", (event) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) {
    const target = event.target;
    const isEditable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (!isEditable) event.preventDefault();
  }
  lastTouchEnd = now;
}, { passive: false });

for (const eventName of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
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

let worldData = null;
let respawnTimer = null;

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

const joystick = {
  forward: 0,
  strafe: 0
};

let yaw = 0;
let pitch = 0;
let lookPointerId = null;
let lastLookX = 0;
let lastLookY = 0;
let pointerLocked = false;

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

const DEFAULT_SETTINGS = {
  sensitivity: 1,
  layout: {
    movePad: { x: 14, y: 12, side: "left", size: 150 },
    jumpButton: { x: 128, y: 48, side: "right", size: 72 },
    reloadTouchButton: { x: 128, y: 128, side: "right", size: 72 },
    fireButton: { x: 14, y: 18, side: "right", size: 100 },
    minimap: { x: 0, y: 0 },
    healthHud: { x: 0, y: 0 },
    fullscreenButton: { x: 0, y: 0 },
    settingsButton: { x: 0, y: 0 },
    reloadButton: { x: 0, y: 0 }
  }
};

let gameSettings = loadGameSettings();
let layoutEditing = false;

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

function loadGameSettings() {
  try {
    const raw = getCookie("fps_game_settings");
    if (!raw) return cloneSettings(DEFAULT_SETTINGS);
    const saved = JSON.parse(raw);
    return {
      sensitivity: THREE.MathUtils.clamp(Number(saved.sensitivity) || 1, 0.4, 5.0),
      layout: {
        movePad: { ...DEFAULT_SETTINGS.layout.movePad, ...(saved.layout?.movePad || {}) },
        jumpButton: { ...DEFAULT_SETTINGS.layout.jumpButton, ...(saved.layout?.jumpButton || {}) },
        reloadTouchButton: { ...DEFAULT_SETTINGS.layout.reloadTouchButton, ...(saved.layout?.reloadTouchButton || {}) },
        fireButton: { ...DEFAULT_SETTINGS.layout.fireButton, ...(saved.layout?.fireButton || {}) },
        minimap: { ...DEFAULT_SETTINGS.layout.minimap, ...(saved.layout?.minimap || {}) },
        healthHud: { ...DEFAULT_SETTINGS.layout.healthHud, ...(saved.layout?.healthHud || {}) },
        fullscreenButton: { ...DEFAULT_SETTINGS.layout.fullscreenButton, ...(saved.layout?.fullscreenButton || {}) },
        settingsButton: { ...DEFAULT_SETTINGS.layout.settingsButton, ...(saved.layout?.settingsButton || {}) },
        reloadButton: { ...DEFAULT_SETTINGS.layout.reloadButton, ...(saved.layout?.reloadButton || {}) }
      }
    };
  } catch (_) {
    return cloneSettings(DEFAULT_SETTINGS);
  }
}

function saveGameSettings() {
  setCookie("fps_game_settings", JSON.stringify(gameSettings), 3650);
}

function applyButtonLayout() {
  const configs = [
    ["movePad", gameSettings.layout.movePad],
    ["jumpButton", gameSettings.layout.jumpButton],
    ["reloadTouchButton", gameSettings.layout.reloadTouchButton],
    ["fireButton", gameSettings.layout.fireButton]
  ];

  for (const [id, cfg] of configs) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.left = "";
    el.style.right = "";
    el.style.top = "";
    el.style.bottom = "";
    el.style.width = cfg.size + "px";
    el.style.height = cfg.size + "px";

    if (cfg.side === "left") {
      el.style.left = cfg.x + "px";
    } else {
      el.style.right = cfg.x + "px";
    }
    el.style.bottom = cfg.y + "px";
  }

  const offsetTargets = [
    ["minimap", gameSettings.layout.minimap],
    ["healthHud", gameSettings.layout.healthHud],
    ["fullscreenButton", gameSettings.layout.fullscreenButton],
    ["settingsButton", gameSettings.layout.settingsButton],
    ["reloadButton", gameSettings.layout.reloadButton]
  ];

  for (const [id, cfg] of offsetTargets) {
    const el = document.getElementById(id);
    if (!el) continue;
    const x = Number(cfg?.x) || 0;
    const y = Number(cfg?.y) || 0;
    el.style.transform = "translate(" + x + "px, " + y + "px)";
  }

  const knob = document.getElementById("moveKnob");
  if (knob) {
    const size = Math.max(48, Math.round(gameSettings.layout.movePad.size * 0.387));
    knob.style.width = size + "px";
    knob.style.height = size + "px";
  }
}

function updateSettingsUi() {
  const slider = document.getElementById("sensitivitySlider");
  const value = document.getElementById("sensitivityValue");
  if (slider) slider.value = String(gameSettings.sensitivity);
  if (value) value.textContent = gameSettings.sensitivity.toFixed(2);

  const movePadSizeSlider = document.getElementById("movePadSizeSlider");
  const movePadSizeValue = document.getElementById("movePadSizeValue");
  const movePadSize = Number(gameSettings.layout.movePad.size) || DEFAULT_SETTINGS.layout.movePad.size;
  if (movePadSizeSlider) movePadSizeSlider.value = String(movePadSize);
  if (movePadSizeValue) movePadSizeValue.textContent = Math.round(movePadSize) + "px";
}

function setupSettings() {
  const settingsButton = document.getElementById("settingsButton");
  const panel = document.getElementById("settingsPanel");
  const close = document.getElementById("settingsCloseButton");
  const done = document.getElementById("settingsDoneButton");
  const slider = document.getElementById("sensitivitySlider");
  const edit = document.getElementById("layoutEditButton");
  const resetLayout = document.getElementById("layoutResetButton");
  const resetAll = document.getElementById("settingsResetButton");
  const status = document.getElementById("layoutEditStatus");
  const editDone = document.getElementById("layoutEditDoneButton");

  const open = () => {
    updateSettingsUi();
    panel?.classList.remove("hidden");
  };
  const stopLayoutEditing = () => {
    layoutEditing = false;
    status?.classList.add("hidden");
    document.getElementById("touchUi")?.classList.remove("layout-editing");
    document.getElementById("hud")?.classList.remove("layout-editing");

    for (const id of ["minimap", "healthHud", "fullscreenButton", "settingsButton", "reloadButton"]) {
      document.getElementById(id)?.classList.remove("layout-editing-target");
    }

    editDone?.classList.add("hidden");
    applyButtonLayout();
  };

  const closePanel = () => {
    stopLayoutEditing();
    panel?.classList.add("hidden");
  };

  settingsButton?.addEventListener("click", () => {
    if (layoutEditing) return;
    open();
  });
  close?.addEventListener("click", closePanel);
  done?.addEventListener("click", closePanel);

  slider?.addEventListener("input", () => {
    gameSettings.sensitivity = Number(slider.value);
    updateSettingsUi();
    saveGameSettings();
  });

  const movePadSizeSlider = document.getElementById("movePadSizeSlider");
  movePadSizeSlider?.addEventListener("input", () => {
    const size = THREE.MathUtils.clamp(Number(movePadSizeSlider.value) || 150, 90, 240);
    gameSettings.layout.movePad.size = Math.round(size);
    applyButtonLayout();
    updateSettingsUi();
    saveGameSettings();
  });

  edit?.addEventListener("click", () => {
    layoutEditing = true;
    status?.classList.remove("hidden");
    document.getElementById("touchUi")?.classList.add("layout-editing");
    document.getElementById("hud")?.classList.add("layout-editing");

    for (const id of ["minimap", "healthHud", "fullscreenButton", "settingsButton", "reloadButton"]) {
      document.getElementById(id)?.classList.add("layout-editing-target");
    }

    editDone?.classList.remove("hidden");
    panel?.classList.add("hidden");
    showMessage("配置編集中：各UIをドラッグしてください");
  });

  editDone?.addEventListener("click", () => {
    stopLayoutEditing();
    showMessage("ボタン配置を保存しました");
  });

  resetLayout?.addEventListener("click", () => {
    gameSettings.layout = cloneSettings(DEFAULT_SETTINGS.layout);
    applyButtonLayout();
    saveGameSettings();
  });

  resetAll?.addEventListener("click", () => {
    gameSettings = cloneSettings(DEFAULT_SETTINGS);
    applyButtonLayout();
    updateSettingsUi();
    saveGameSettings();
  });

  applyButtonLayout();
  updateSettingsUi();
}

function setupDraggableButton(id, settingKey) {
  const el = document.getElementById(id);
  if (!el) return;

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  el.addEventListener("pointerdown", (e) => {
    if (!layoutEditing) return;
    e.preventDefault();
    e.stopPropagation();

    pointerId = e.pointerId;
    el.setPointerCapture?.(pointerId);
    const rect = el.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
  });

  el.addEventListener("pointermove", (e) => {
    if (!layoutEditing || e.pointerId !== pointerId) return;
    e.preventDefault();

    const x = THREE.MathUtils.clamp(startLeft + (e.clientX - startX), 0, innerWidth - el.offsetWidth);
    const y = THREE.MathUtils.clamp(startTop + (e.clientY - startY), 0, innerHeight - el.offsetHeight);

    el.style.left = x + "px";
    el.style.right = "auto";
    el.style.top = y + "px";
    el.style.bottom = "auto";

    const cfg = gameSettings.layout[settingKey];
    cfg.x = cfg.side === "left" ? x : innerWidth - x - el.offsetWidth;
    cfg.y = innerHeight - y - el.offsetHeight;
    saveGameSettings();
  });

  const end = (e) => {
    if (e.pointerId === pointerId) pointerId = null;
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

function setupDraggableOffset(id, settingKey) {
  const el = document.getElementById(id);
  if (!el) return;

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;
  let moved = false;

  const move = (e) => {
    if (!layoutEditing || e.pointerId !== pointerId) return;
    e.preventDefault();

    const dx = startOffsetX + (e.clientX - startX);
    const dy = startOffsetY + (e.clientY - startY);

    if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) moved = true;

    const rect = el.getBoundingClientRect();
    const baseLeft = rect.left - startOffsetX;
    const baseTop = rect.top - startOffsetY;
    const maxX = innerWidth - el.offsetWidth - baseLeft;
    const maxY = innerHeight - el.offsetHeight - baseTop;
    const clampedX = THREE.MathUtils.clamp(dx, -baseLeft, maxX);
    const clampedY = THREE.MathUtils.clamp(dy, -baseTop, maxY);

    el.style.transform = "translate(" + Math.round(clampedX) + "px, " + Math.round(clampedY) + "px)";
    gameSettings.layout[settingKey].x = Math.round(clampedX);
    gameSettings.layout[settingKey].y = Math.round(clampedY);
    saveGameSettings();
  };

  const end = (e) => {
    if (e.pointerId !== pointerId) return;
    try { el.releasePointerCapture?.(pointerId); } catch (_) {}
    pointerId = null;
    if (moved) {
      el.dataset.suppressClick = "1";
      setTimeout(() => delete el.dataset.suppressClick, 0);
    }
  };

  el.addEventListener("pointerdown", (e) => {
    if (!layoutEditing) return;
    e.preventDefault();
    e.stopPropagation();

    pointerId = e.pointerId;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;

    const cfg = gameSettings.layout[settingKey] || { x: 0, y: 0 };
    startOffsetX = Number(cfg.x) || 0;
    startOffsetY = Number(cfg.y) || 0;

    el.setPointerCapture?.(pointerId);
  });

  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);

  el.addEventListener("click", (e) => {
    if (el.dataset.suppressClick === "1") {
      e.preventDefault();
      e.stopPropagation();
      delete el.dataset.suppressClick;
    }
  }, true);
}
function loadPlayerName() {
  const input = document.getElementById("playerName");
  if (input) input.value = getCookie("fps_player_name");
}

function createGuestName() {
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return "Player" + suffix;
}

function savePlayerName() {
  const input = document.getElementById("playerName");
  let value = (input?.value || "").trim().replace(/[<>]/g, "");

  if (!value) {
    value = createGuestName();
  }

  playerName = value.slice(0, 16);
  setCookie("fps_player_name", playerName);
  if (input) input.value = playerName;
  return playerName;
}

loadPlayerName();
setupSettings();

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
  worldData = data;
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

function updateMinimap() {
  const canvas = document.getElementById("minimapCanvas");
  if (!canvas || !myState || !worldData?.world) return;

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const world = worldData.world;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(9,14,18,.9)";
  ctx.fillRect(0, 0, w, h);

  const mapX = (x) => ((x - world.minX) / (world.maxX - world.minX)) * w;
  const mapZ = (z) => ((z - world.minZ) / (world.maxZ - world.minZ)) * h;

  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);

  ctx.fillStyle = "rgba(150,160,170,.38)";
  for (const o of worldData.obstacles || []) {
    const x = mapX(o.x - o.w / 2);
    const y = mapZ(o.z - o.d / 2);
    const ow = (o.w / (world.maxX - world.minX)) * w;
    const oh = (o.d / (world.maxZ - world.minZ)) * h;
    ctx.fillRect(x, y, ow, oh);
  }

  const px = mapX(myState.x);
  const pz = mapZ(myState.z);

  ctx.strokeStyle = "rgba(110,190,255,.95)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(px, pz);
  ctx.lineTo(px - Math.sin(yaw) * 14, pz - Math.cos(yaw) * 14);
  ctx.stroke();

  ctx.fillStyle = "#69b7ff";
  ctx.beginPath();
  ctx.arc(px, pz, 5, 0, Math.PI * 2);
  ctx.fill();
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
  root.userData.targetPosition = new THREE.Vector3();
  root.userData.targetYaw = 0;
  root.userData.hasNetworkTransform = false;
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

    if (!obj.userData.hasNetworkTransform) {
      obj.position.set(p.x, p.y || 0, p.z);
      obj.rotation.y = p.yaw || 0;
      obj.userData.hasNetworkTransform = true;
    }

    obj.userData.targetPosition.set(p.x, p.y || 0, p.z);
    obj.userData.targetYaw = p.yaw || 0;
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
  if (!joined || myState?.health <= 0 || now - lastInputSent < 33) return;

  const keyboardForward = (movement.forward ? 1 : 0) + (movement.back ? -1 : 0);
  const keyboardStrafe = (movement.right ? 1 : 0) + (movement.left ? -1 : 0);

  const forward = THREE.MathUtils.clamp(keyboardForward + joystick.forward, -1, 1);
  const strafe = THREE.MathUtils.clamp(keyboardStrafe + joystick.strafe, -1, 1);

  socket.emit("input", { forward, strafe, yaw, pitch });
  lastInputSent = now;
}

function jump() {
  if (!joined || myState?.health <= 0) return;
  socket.emit("jump");
}

function fire() {
  if (!joined || myState?.reloading) return;

  if (myState && myState.ammo <= 0) {
    reload();
    return;
  }

  const now = performance.now();
  const cfg = weaponConfig[selectedWeapon];
  if (now - localLastFire < cfg.fireInterval * .8) return;

  localLastFire = now;
  socket.emit("fire");
}

function reload() {
  if (!joined || myState?.reloading) return;
  stopFiring();
  socket.emit("reload");
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

function stopAllControls() {
  stopFiring();
  movement.forward = false;
  movement.back = false;
  movement.left = false;
  movement.right = false;
  joystick.forward = 0;
  joystick.strafe = 0;
  resetJoystick();
}

function showRespawnPanel() {
  const panel = document.getElementById("respawnPanel");
  const button = document.getElementById("respawnButton");
  const text = document.getElementById("respawnText");
  const touchUi = document.getElementById("touchUi");

  panel?.classList.remove("hidden");
  touchUi?.classList.add("hidden");
  if (button) button.disabled = true;
  if (respawnTimer) clearInterval(respawnTimer);

  const target = Number(myState?.respawnAt) || (Date.now() + 5000);

  const update = () => {
    const remaining = Math.max(0, target - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    if (text) text.textContent = seconds > 0 ? ("リスポーンまで " + seconds + "秒") : "リスポーンできます";
    if (button) button.disabled = remaining > 0;
    if (remaining <= 0) {
      clearInterval(respawnTimer);
      respawnTimer = null;
    }
  };

  update();
  respawnTimer = setInterval(update, 100);
}

function hideRespawnPanel() {
  document.getElementById("respawnPanel")?.classList.add("hidden");
  if (joined) document.getElementById("touchUi")?.classList.remove("hidden");
  if (respawnTimer) {
    clearInterval(respawnTimer);
    respawnTimer = null;
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

function triggerHitFlash() {
  const el = document.getElementById("hitFlash");
  if (!el) return;
  el.classList.remove("active");
  void el.offsetWidth;
  el.classList.add("active");
}

function addDamageNumber(damage, zone) {
  const container = document.getElementById("damageNumbers");
  if (!container) return;

  const el = document.createElement("div");
  el.className = "damage-number" + (zone === "head" ? " head critical" : "");
  el.textContent = String(Math.max(1, Math.round(damage)));

  // 敵の正確な位置はUIに残さず、画面中央付近から数字を出す。
  el.style.left = (50 + (Math.random() - 0.5) * 10) + "%";
  el.style.top = (44 + (Math.random() - 0.5) * 8) + "%";

  container.appendChild(el);
  setTimeout(() => el.remove(), 700);
}

function addKillLog(event) {
  const log = document.getElementById("killLog");
  if (!log) return;

  const entry = document.createElement("div");
  const mine = event.killerId === myId;
  const death = event.victimId === myId;
  entry.className = "kill-entry" + (mine ? " mine" : "") + (death ? " death" : "");

  const killer = document.createElement("span");
  killer.className = "killer";
  killer.textContent = event.killerName || "Player";

  const victim = document.createElement("span");
  victim.className = "victim";
  victim.textContent = event.victimName || "Player";

  entry.append(killer, document.createTextNode("  →  "), victim);
  if (event.zone === "head") {
    entry.append(document.createTextNode("  HEAD"));
  }

  log.prepend(entry);

  while (log.children.length > 5) {
    log.lastElementChild.remove();
  }

  setTimeout(() => entry.remove(), 5000);
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

function updateAmmoHud() {
  const ammoEl = document.getElementById("ammoCount");
  if (!ammoEl || !myState) return;

  const ammo = Math.max(0, Math.floor(Number(myState.ammo) || 0));
  ammoEl.textContent = myState.reloading ? "RELOADING..." : `${ammo} / ∞`;
}

document.getElementById("respawnButton")?.addEventListener("click", () => {
  if (!joined || !myState || myState.health > 0) return;
  if (myState.respawnAt && Date.now() < myState.respawnAt) return;
  socket.emit("respawn");
});

socket.on("world", buildWorld);

socket.on("joined", ({ player }) => {
  joined = true;
  wasJoinedBeforeDisconnect = true;
  reconnecting = false;
  playerName = player.name || playerName;
  setCookie("fps_player_name", playerName);
  selectedWeapon = player.weapon || selectedWeapon;
  myId = player.id;
  myState = player;
  yaw = player.yaw;
  pitch = player.pitch;

  document.getElementById("weaponScreen").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");
  document.getElementById("touchUi").classList.remove("hidden");
  document.getElementById("settingsButton")?.classList.remove("hidden");
  setConnectionStatus("接続済み", true);
  updateAmmoHud();
  if (reconnecting) showMessage("サーバーに再接続しました");
});

socket.on("players", updateRemotePlayers);

socket.on("state", (players) => {
  updateRemotePlayers(players);
  updateCamera();

  if (myState) {
    const hp = Math.max(0, Math.min(100, Number(myState.health) || 0));
    const healthValue = document.getElementById("healthValue");
    const healthFill = document.getElementById("healthBarFill");
    if (healthValue) healthValue.textContent = String(Math.round(hp));
    if (healthFill) {
      healthFill.style.width = hp + "%";
      healthFill.style.background = hp > 60 ? "#55d66f" : hp > 30 ? "#e6c84a" : "#e55a5a";
    }

    document.getElementById("kills").textContent = String(myState.kills);
    document.getElementById("deaths").textContent = String(myState.deaths);
    updateAmmoHud();

    if (myState.reloading) stopFiring();

    if (hp <= 0) {
      stopAllControls();
      showRespawnPanel();
    } else {
      hideRespawnPanel();
    }
  }
});

socket.on("respawned", ({ player }) => {
  myState = player;
  yaw = player.yaw;
  pitch = player.pitch;
  hideRespawnPanel();
  showMessage("リスポーンしました");
});

socket.on("shot", createTracer);

socket.on("damageDealt", (event) => {
  addDamageNumber(event.damage, event.zone);
});

socket.on("damageTaken", () => {
  triggerHitFlash();
});

socket.on("elimination", (event) => {
  addKillLog(event);
  if (event.killerId === myId) {
    showMessage("キル！");
  }
  if (event.victimId === myId) {
    showMessage("デス");
  }
});

function setConnectionStatus(text, connected = false) {
  const el = document.getElementById("connectionStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("connected", connected);
  el.classList.toggle("disconnected", !connected);
}

socket.on("connect", () => {
  setConnectionStatus("接続済み", true);

  if (wasJoinedBeforeDisconnect && playerName) {
    reconnecting = true;
    socket.emit("join", { name: playerName, weapon: selectedWeapon });
  } else {
    showMessage("サーバー接続済み");
  }
});

socket.on("disconnect", () => {
  setConnectionStatus("接続中…", false);

  if (joined) {
    wasJoinedBeforeDisconnect = true;
    joined = false;
    stopAllControls();
    showMessage("サーバーとの接続が切れました。再接続しています…");
  }
});

socket.io.on("reconnect_attempt", () => {
  setConnectionStatus("接続中…", false);
});

socket.io.on("reconnect_error", () => {
  setConnectionStatus("接続を再試行中…", false);
});

socket.io.on("reconnect_failed", () => {
  setConnectionStatus("再接続できません", false);
});

for (const button of document.querySelectorAll(".weapon-card")) {
  button.addEventListener("click", () => {
    if (joined) return;

    const name = savePlayerName();
    if (!name) return;

    selectedWeapon = button.dataset.weapon;
    socket.emit("join", { name, weapon: selectedWeapon });
  });
}

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
fullscreenButton?.addEventListener("click", () => {
  if (layoutEditing) return;
  toggleFullscreen();
});
document.addEventListener("fullscreenchange", () => {
  if (fullscreenButton) fullscreenButton.textContent = document.fullscreenElement ? "全画面解除" : "全画面";
});

const movePad = document.getElementById("movePad");
const moveKnob = document.getElementById("moveKnob");
let movePointerId = null;

function resetJoystick() {
  joystick.forward = 0;
  joystick.strafe = 0;
  if (moveKnob) moveKnob.style.transform = "translate(-50%, -50%)";
}

function updateJoystick(event) {
  if (layoutEditing || !movePad || event.pointerId !== movePointerId) return;

  const rect = movePad.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const maxDistance = Math.max(1, rect.width / 2 - 34);

  let dx = event.clientX - centerX;
  let dy = event.clientY - centerY;
  const distance = Math.hypot(dx, dy);

  if (distance > maxDistance) {
    const scale = maxDistance / distance;
    dx *= scale;
    dy *= scale;
  }

  joystick.strafe = THREE.MathUtils.clamp(dx / maxDistance, -1, 1);
  joystick.forward = THREE.MathUtils.clamp(-dy / maxDistance, -1, 1);

  if (moveKnob) {
    moveKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }
}

movePad?.addEventListener("pointerdown", (e) => {
  if (layoutEditing) return;
  e.preventDefault();
  movePointerId = e.pointerId;
  movePad.setPointerCapture?.(e.pointerId);
  updateJoystick(e);
});

movePad?.addEventListener("pointermove", updateJoystick);

movePad?.addEventListener("pointerup", (e) => {
  e.preventDefault();
  if (e.pointerId === movePointerId) {
    movePointerId = null;
    resetJoystick();
  }
});

movePad?.addEventListener("pointercancel", (e) => {
  if (e.pointerId === movePointerId) {
    movePointerId = null;
    resetJoystick();
  }
});

const jumpButton = document.getElementById("jumpButton");
jumpButton.addEventListener("pointerdown", (e) => {
  if (layoutEditing) return;
  e.preventDefault();
  jumpButton.setPointerCapture?.(e.pointerId);
  jump();
});

const reloadButton = document.getElementById("reloadButton");
const reloadTouchButton = document.getElementById("reloadTouchButton");

function bindReloadButton(button) {
  button?.addEventListener("pointerdown", (e) => {
    if (layoutEditing) return;
    e.preventDefault();
    button.setPointerCapture?.(e.pointerId);
    reload();
  });
}

bindReloadButton(reloadButton);
bindReloadButton(reloadTouchButton);

setupDraggableButton("movePad", "movePad");
setupDraggableButton("jumpButton", "jumpButton");
setupDraggableButton("reloadTouchButton", "reloadTouchButton");
setupDraggableButton("fireButton", "fireButton");
setupDraggableOffset("minimap", "minimap");
setupDraggableOffset("healthHud", "healthHud");
setupDraggableOffset("fullscreenButton", "fullscreenButton");
setupDraggableOffset("settingsButton", "settingsButton");
setupDraggableOffset("reloadButton", "reloadButton");

const fireButton = document.getElementById("fireButton");
fireButton.addEventListener("pointerdown", (e) => {
  if (layoutEditing) return;
  e.preventDefault();
  fireButton.setPointerCapture?.(e.pointerId);
  startFiring();
});

fireButton.addEventListener("pointerup", (e) => {
  if (layoutEditing) return;
  e.preventDefault();
  stopFiring();
});

fireButton.addEventListener("pointercancel", (e) => {
  if (layoutEditing) return;
  e.preventDefault();
  stopFiring();
});

fireButton.addEventListener("pointerleave", (e) => {
  if (e.buttons === 0) stopFiring();
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

  yaw -= dx * .0045 * gameSettings.sensitivity;
  pitch -= dy * .0045 * gameSettings.sensitivity;
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

  yaw -= e.movementX * .0028 * gameSettings.sensitivity;
  pitch -= e.movementY * .0028 * gameSettings.sensitivity;
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

  if (e.code === "KeyR") {
    e.preventDefault();
    reload();
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
  updateMinimap();

  // サーバーから受け取った他プレイヤーの位置を補間して滑らかに表示する。
  const interpolation = 1 - Math.exp(-18 * dt);
  for (const obj of remotePlayers.values()) {
    if (!obj.userData.hasNetworkTransform) continue;
    obj.position.lerp(obj.userData.targetPosition, interpolation);

    const currentYaw = obj.rotation.y;
    const targetYaw = obj.userData.targetYaw;
    const deltaYaw = Math.atan2(Math.sin(targetYaw - currentYaw), Math.cos(targetYaw - currentYaw));
    obj.rotation.y = currentYaw + deltaYaw * interpolation;
  }

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
