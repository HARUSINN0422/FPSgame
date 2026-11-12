import * as THREE from "three";

const isVercelFrontend = location.hostname === "test-gamma-two-87.vercel.app";
const socketPath = isVercelFrontend || location.pathname.startsWith("/FPSgame/")
  ? "/FPSgame/socket.io/"
  : "/socket.io/";
const socketOrigin = isVercelFrontend ? "https://harusinn.com" : undefined;

const socket = io(socketOrigin, {
  path: socketPath,
  // Vercel側はApacheのWebSocketプロキシ経由で接続する。
  // HTTP long-pollingは /FPSgame/socket.io/ のWS専用プロキシでは通らないため、
  // Vercelフロントエンドでは最初からWebSocket接続に限定する。
  ...(isVercelFrontend ? { transports: ["websocket"] } : {}),
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
scene.add(camera);

const isLowPowerDisplay = window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
const renderer = new THREE.WebGLRenderer({ antialias: !isLowPowerDisplay, powerPreference: "high-performance" });
const maxPixelRatio = isLowPowerDisplay ? 1.25 : 1.5;
renderer.setPixelRatio(Math.min(devicePixelRatio, maxPixelRatio));
renderer.setSize(innerWidth, innerHeight);
// Shadow maps are expensive on mobile GPUs; keep lighting but skip real-time shadow rendering.
renderer.shadowMap.enabled = false;
document.getElementById("game").appendChild(renderer.domElement);

const smokeScreenOverlay = document.createElement("div");
smokeScreenOverlay.style.cssText = "position:absolute;inset:0;display:none;pointer-events:none;background:rgba(143,148,153,0.72);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);z-index:4";
document.getElementById("game").appendChild(smokeScreenOverlay);
const smokePuffGeometry = new THREE.SphereGeometry(1, 12, 8);

const hemi = new THREE.HemisphereLight(0xdff1ff, 0x506050, 2.5);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 3.0);
sun.position.set(12, 30, 8);
sun.castShadow = false;
scene.add(sun);

const worldGroup = new THREE.Group();
scene.add(worldGroup);
let payloadCartGroup = null;
let payloadCartMapState = null;
let payloadRole = null;
let payloadAttackingTeam = null;
let payloadGateMeshes = [];
function updatePayloadGateColors(attackingTeam) {
  if (attackingTeam !== "blue" && attackingTeam !== "red") return;
  payloadAttackingTeam = attackingTeam;
  for (const gate of payloadGateMeshes) {
    const team = gate.userData.role === "attack" ? attackingTeam : (attackingTeam === "blue" ? "red" : "blue");
    const color = team === "blue" ? 0x258be8 : 0xe34b52;
    gate.material.color.setHex(color);
    gate.material.emissive.setHex(color);
  }
}

const remotePlayers = new Map();
const tracers = [];
const smokeProjectileMeshes = new Map();
const grenadeProjectileMeshes = new Map();
const grappleTethers = new Map();
const grenadeExplosionMeshes = new Map();
const skyfallImpactMeshes = new Map();
const smokeCloudMeshes = new Map();
let localWeaponViewModel = null;
let localWeaponViewModelType = "";
let localWeaponActionStartedAt = -Infinity;
let localWeaponActionType = "";
let activeGamepad = null;
let controllerMode = false;
let gamepadJumpHeld = false;
let gamepadReloadHeld = false;
let gamepadCrouchHeld = false;
let gamepadSwitchHeld = false;
let gamepadScopeHeld = false;
let gamepadFireHeld = false;
let gamepadUltimateHeld = false;
let controllerRespawnRequested = false;
const clock = new THREE.Clock();

let worldData = null;
let buildPreviewMesh = null;
let buildPreviewActive = true;
let selectedBuildType = "wall";
let buildPreviewPosition = null;
let gamepadBuildLeftHeld = false;
let gamepadBuildRightHeld = false;
let gamepadBuildPlaceHeld = false;
let respawnTimer = null;
let autoRespawnRequested = false;

let joined = false;
const payloadReconnectToken = (() => { try { let token = sessionStorage.getItem("fpsPayloadReconnectToken"); if (!token) { token = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(36).slice(2)); sessionStorage.setItem("fpsPayloadReconnectToken", token); } return token; } catch (_) { return String(Date.now()) + "-" + Math.random().toString(36).slice(2); } })();
let myId = null;
let myState = null;
let selectedGameMode = "Melee";
let areaResultOpen = false;
let lobbyScreenAfterLeave = "modeScreen";
let selectedWeapon = "pistol";
let weaponSlots = ["pistol", "rifle"];
let activeWeaponSlot = 0;
let selectedPrimaryWeapon = "pistol";
let selectedSecondaryWeapon = "rifle";
let loadoutSlotToEdit = 0;
let selectedCharm = "none";
let selectedUltimate = "skyfall";
let scopeEnabled = false;
const ATTACHMENT_WEAPONS = ["smg", "rifle", "marksman"];
const attachmentSettings = (() => {
  const defaults = { smg: "none", rifle: "none", marksman: "none" };
  try {
    const saved = JSON.parse(localStorage.getItem("fps_weapon_attachments") || "{}");
    for (const weapon of ATTACHMENT_WEAPONS) defaults[weapon] = saved[weapon] === "laser" ? "laser" : "none";
  } catch {}
  return defaults;
})();
let laserSightLine = null;
let lastWeaponSwitchAt = -Infinity;
const WEAPON_SWITCH_COOLDOWN_MS = 400;
let playerName = "";
let lastInputSent = 0;
let lastFrameTime = performance.now();
let lastMinimapUpdate = 0;
let lastWorldLodUpdate = 0;

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

let crouchHeld = false;

let yaw = 0;
let pitch = 0;
const keyboardLook = { up: false, down: false, left: false, right: false };
let lastKeyboardLookAt = 0;
let lookPointerId = null;
let lastLookX = 0;
let lastLookY = 0;
let pointerLocked = false;

const weaponConfig = {
  pickaxe: { fireInterval: 650, automatic: false, melee: true },
  sword: { fireInterval: 650, automatic: false, melee: true },
  smoke: { fireInterval: 1300, automatic: false },
  grenadeLauncher: { fireInterval: 900, automatic: false },
  shockwaveLauncher: { fireInterval: 900, automatic: false },
  grappler: { fireInterval: 1100, automatic: false },
  rocketLauncher: { fireInterval: 1250, automatic: false },
  pistol: { fireInterval: 400, automatic: false },
  smg: { fireInterval: 107, automatic: true },
  rifle: { fireInterval: 160 / 1.5, automatic: true },
  shotgun: { fireInterval: 750, automatic: false },
  marksman: { fireInterval: 450, automatic: true },
  formingGun: { fireInterval: 1000, automatic: false },
  sniper: { fireInterval: 1200, automatic: false },
  bow: { fireInterval: 1, automatic: false },
  minigun: { fireInterval: 107 / 3, automatic: false },
  railgun: { fireInterval: 1, automatic: false }, flamethrower: { fireInterval: 500, automatic: true }, laserBeam: { fireInterval: 500, automatic: true }, freezeCannon: { fireInterval: 500, automatic: true }
};

async function refreshPublicWeaponSettings() {
  try {
    const apiBase = location.hostname === "test-gamma-two-87.vercel.app"
      ? "https://harusinn.com/FPSgame/"
      : (location.pathname.startsWith("/FPSgame/") ? "/FPSgame/" : "/");
    const response = await fetch(apiBase + "api/weapons", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    for (const [id, config] of Object.entries(data.weapons || {})) {
      if (weaponConfig[id] && Number.isFinite(Number(config.fireInterval))) {
        weaponConfig[id].fireInterval = Math.max(1, Number(config.fireInterval));
      }
      if (weaponConfig[id] && typeof config.automatic === "boolean") weaponConfig[id].automatic = config.automatic;
      const card = document.querySelector('.weapon-card[data-weapon="' + id + '"] span');
      if (card && typeof config.description === "string") card.textContent = config.description;
    }
  } catch (_) {}
}
refreshPublicWeaponSettings();
socket.on("weaponConfigUpdated", (configs = {}) => {
  for (const [id, config] of Object.entries(configs)) {
    if (weaponConfig[id] && Number.isFinite(Number(config.fireInterval))) {
      weaponConfig[id].fireInterval = Math.max(1, Number(config.fireInterval));
    }
    if (weaponConfig[id] && typeof config.automatic === "boolean") weaponConfig[id].automatic = config.automatic;
    const card = document.querySelector('.weapon-card[data-weapon="' + id + '"] span');
    if (card && typeof config.description === "string") card.textContent = config.description;
  }
  if (autoFireTimer) {
    clearInterval(autoFireTimer);
    autoFireTimer = null;
    if (weaponConfig[selectedWeapon]?.automatic) autoFireTimer = setInterval(fire, weaponConfig[selectedWeapon].fireInterval);
  }
});

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
  touchSensitivity: 1,
  controllerSensitivity: 1,
  mouseSensitivity: 1,
  sniperSensitivity: 1,
  touchAimAssistEnabled: false,
  controllerAimAssistEnabled: false,
  touchAimAssistStrength: 10,
  controllerAimAssistStrength: 10,
  aimAssistEnabled: false,
  aimAssistStrength: 0,
  controllerButtons: { jump: 0, reload: 1, crouch: 2, switchWeapon: 3, ultimate: 5, scope: 6, fire: 7 },
  allowLookWhileActionHeld: true,
  allowLookWhileJumpCrouchHeld: true,
  autoRespawnEnabled: false,
  bowUsesSniperSensitivity: true,
  keyboard: {
    forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD",
    lookUp: "ArrowUp", lookDown: "ArrowDown", lookRight: "ArrowRight", lookLeft: "ArrowLeft",
    jump: "Space", crouch: "KeyC", reload: "KeyR", switchWeapon: "KeyQ",
    weapon1: "Digit1", weapon2: "Digit2", ultimate: "KeyF", fire: "MouseLeft", scope: "MouseRight"
  },
  layout: {
    movePad: { x: 14, y: 12, side: "left", size: 150 },
    jumpButton: { x: 128, y: 48, side: "right", size: 72 },
    reloadTouchButton: { x: 128, y: 128, side: "right", size: 72 },
    crouchButton: { x: 220, y: 48, side: "right", size: 72 },
    fireButton: { x: 14, y: 18, side: "right", size: 100 },
    switchWeaponButton: { x: 310, y: 140, side: "right", size: 76 },
    inventoryButton: { x: 310, y: 230, side: "right", size: 88 },
    ultimateButton: { x: 310, y: 320, side: "right", size: 76 },
    scopeButton: { x: 220, y: 220, side: "right", size: 68 },
    minimap: { x: 0, y: 0 },
    healthHud: { x: 0, y: 0 },
    kdHud: { x: 0, y: 0 },
    areaHud: { x: 0, y: 0, size: 100 },
    fullscreenButton: { x: 0, y: 0 },
    settingsButton: { x: 0, y: 0 },
    reloadButton: { x: 0, y: 0 },
    buildToolbar: { x: 0, y: 0, size: 100 }
  }
};

let gameSettings = loadGameSettings();
function getScopeSensitivityMultiplier() {
  const sniperAiming = selectedWeapon === "sniper" && scopeEnabled;
  const bowAiming = selectedWeapon === "bow" && bowChargeStartedAt > 0 &&
    gameSettings.bowUsesSniperSensitivity !== false;
  return sniperAiming || bowAiming ? gameSettings.sniperSensitivity : 1;
}
let layoutEditing = false;

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

function loadGameSettings() {
  try {
    const raw = getCookie("fps_game_settings");
    if (!raw) return cloneSettings(DEFAULT_SETTINGS);
    const saved = JSON.parse(raw);
    const legacySensitivity = THREE.MathUtils.clamp(Number(saved.sensitivity) || 1, 0.4, 5.0);
    const savedKeyboard = { ...DEFAULT_SETTINGS.keyboard, ...(saved.keyboard || {}) };
    // 旧バージョンの標準F発射を左クリックへ移行し、スコープ割り当てを追加する。
    if (saved.keyboard?.fire === "KeyF") savedKeyboard.fire = "MouseLeft";
    if (!saved.keyboard?.scope) savedKeyboard.scope = "MouseRight";
    return {
      sensitivity: legacySensitivity,
      touchSensitivity: THREE.MathUtils.clamp(Number(saved.touchSensitivity) || legacySensitivity, 0.4, 5.0),
      controllerSensitivity: THREE.MathUtils.clamp(Number(saved.controllerSensitivity) || legacySensitivity, 0.4, 5.0),
      mouseSensitivity: THREE.MathUtils.clamp(Number(saved.mouseSensitivity) || legacySensitivity, 0.4, 5.0),
      sniperSensitivity: THREE.MathUtils.clamp(Number(saved.sniperSensitivity) || 1, 0.01, 2.0),
      touchAimAssistStrength: saved.touchAimAssistStrength != null && [0, 5, 10].includes(Number(saved.touchAimAssistStrength))
        ? Number(saved.touchAimAssistStrength)
        : (typeof saved.touchAimAssistEnabled === "boolean" ? (saved.touchAimAssistEnabled ? 10 : 0) : 10),
      controllerAimAssistStrength: saved.controllerAimAssistStrength != null && [0, 5, 10].includes(Number(saved.controllerAimAssistStrength))
        ? Number(saved.controllerAimAssistStrength)
        : (typeof saved.controllerAimAssistEnabled === "boolean" ? (saved.controllerAimAssistEnabled ? 10 : 0) : 10),
      touchAimAssistEnabled: Number(saved.touchAimAssistStrength ?? (saved.touchAimAssistEnabled === true ? 10 : 0)) > 0,
      controllerAimAssistEnabled: Number(saved.controllerAimAssistStrength ?? (saved.controllerAimAssistEnabled === true ? 10 : 0)) > 0,
      aimAssistEnabled: false,
      aimAssistStrength: 0,
      controllerButtons: { ...DEFAULT_SETTINGS.controllerButtons, ...(saved.controllerButtons || {}) },
      allowLookWhileActionHeld: saved.allowLookWhileActionHeld !== false,
      allowLookWhileJumpCrouchHeld: saved.allowLookWhileJumpCrouchHeld !== false,
      autoRespawnEnabled: saved.autoRespawnEnabled === true,
      bowUsesSniperSensitivity: saved.bowUsesSniperSensitivity !== false && saved.bowScopeZoomEnabled !== false,
      keyboard: savedKeyboard,
      layout: {
        movePad: { ...DEFAULT_SETTINGS.layout.movePad, ...(saved.layout?.movePad || {}) },
        jumpButton: { ...DEFAULT_SETTINGS.layout.jumpButton, ...(saved.layout?.jumpButton || {}) },
        reloadTouchButton: { ...DEFAULT_SETTINGS.layout.reloadTouchButton, ...(saved.layout?.reloadTouchButton || {}) },
        crouchButton: { ...DEFAULT_SETTINGS.layout.crouchButton, ...(saved.layout?.crouchButton || {}) },
        fireButton: { ...DEFAULT_SETTINGS.layout.fireButton, ...(saved.layout?.fireButton || {}) },
        switchWeaponButton: { ...DEFAULT_SETTINGS.layout.switchWeaponButton, ...(saved.layout?.switchWeaponButton || {}) },
        inventoryButton: { ...DEFAULT_SETTINGS.layout.inventoryButton, ...(saved.layout?.inventoryButton || {}) },
        ultimateButton: { ...DEFAULT_SETTINGS.layout.ultimateButton, ...(saved.layout?.ultimateButton || {}) },
        scopeButton: { ...DEFAULT_SETTINGS.layout.scopeButton, ...(saved.layout?.scopeButton || {}) },
        minimap: { ...DEFAULT_SETTINGS.layout.minimap, ...(saved.layout?.minimap || {}) },
        healthHud: { ...DEFAULT_SETTINGS.layout.healthHud, ...(saved.layout?.healthHud || {}) },
        kdHud: { ...DEFAULT_SETTINGS.layout.kdHud, ...(saved.layout?.kdHud || {}) },
        areaHud: { ...DEFAULT_SETTINGS.layout.areaHud, ...(saved.layout?.areaHud || {}) },
        fullscreenButton: { ...DEFAULT_SETTINGS.layout.fullscreenButton, ...(saved.layout?.fullscreenButton || {}) },
        settingsButton: { ...DEFAULT_SETTINGS.layout.settingsButton, ...(saved.layout?.settingsButton || {}) },
        reloadButton: { ...DEFAULT_SETTINGS.layout.reloadButton, ...(saved.layout?.reloadButton || {}) },
        buildToolbar: { ...DEFAULT_SETTINGS.layout.buildToolbar, ...(saved.layout?.buildToolbar || {}) }
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
    ["crouchButton", gameSettings.layout.crouchButton],
    ["fireButton", gameSettings.layout.fireButton],
    ["switchWeaponButton", gameSettings.layout.switchWeaponButton],
    ["inventoryButton", gameSettings.layout.inventoryButton],
    ["ultimateButton", gameSettings.layout.ultimateButton],
    ["scopeButton", gameSettings.layout.scopeButton]
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
    ["kdHud", gameSettings.layout.kdHud],
    ["areaHud", gameSettings.layout.areaHud],
    ["fullscreenButton", gameSettings.layout.fullscreenButton],
    ["settingsButton", gameSettings.layout.settingsButton],
    ["ammoHud", gameSettings.layout.reloadButton],
    ["buildToolbar", gameSettings.layout.buildToolbar]
  ];

  for (const [id, cfg] of offsetTargets) {
    const el = document.getElementById(id);
    if (!el) continue;
    const x = Number(cfg?.x) || 0;
    const y = Number(cfg?.y) || 0;
    if (id === "areaHud" || id === "buildToolbar") {
      el.style.setProperty("--layout-x", x + "px");
      el.style.setProperty("--layout-y", y + "px");
      if (id === "areaHud") {
        const scale = THREE.MathUtils.clamp(Number(cfg?.size) || 100, 60, 150) / 100;
        el.style.setProperty("--area-hud-scale", String(scale));
      } else {
        const scale = THREE.MathUtils.clamp(Number(cfg?.size) || 100, 60, 160) / 100;
        el.style.setProperty("--build-toolbar-scale", String(scale));
      }
    } else {
      el.style.transform = "translate(" + x + "px, " + y + "px)";
    }
  }

  const knob = document.getElementById("moveKnob");
  if (knob) {
    const size = Math.max(48, Math.round(gameSettings.layout.movePad.size * 0.387));
    knob.style.width = size + "px";
    knob.style.height = size + "px";
  }
}

function updateSettingsUi() {
  const sensitivityControls = [
    ["touchSensitivitySlider", "touchSensitivityValue", "touchSensitivity"],
    ["controllerSensitivitySlider", "controllerSensitivityValue", "controllerSensitivity"],
    ["mouseSensitivitySlider", "mouseSensitivityValue", "mouseSensitivity"],
    ["sniperSensitivitySlider", "sniperSensitivityValue", "sniperSensitivity"]
  ];
  for (const [sliderId, valueId, settingName] of sensitivityControls) {
    const slider = document.getElementById(sliderId);
    const value = document.getElementById(valueId);
    const settingValue = THREE.MathUtils.clamp(Number(gameSettings[settingName]) || 1, settingName === "sniperSensitivity" ? 0.01 : 0.4, settingName === "sniperSensitivity" ? 2.0 : 5.0);
    gameSettings[settingName] = settingValue;
    if (slider) slider.value = String(settingValue);
    if (value) value.textContent = settingValue.toFixed(2);
  }

  const areaHudSizeSlider = document.getElementById("areaHudSizeSlider");
  const areaHudSizeValue = document.getElementById("areaHudSizeValue");
  const areaHudSize = THREE.MathUtils.clamp(Number(gameSettings.layout.areaHud.size) || 100, 60, 150);
  gameSettings.layout.areaHud.size = Math.round(areaHudSize);
  if (areaHudSizeSlider) areaHudSizeSlider.value = String(areaHudSize);
  if (areaHudSizeValue) areaHudSizeValue.textContent = Math.round(areaHudSize) + "%";

  const buildToolbarSizeSlider = document.getElementById("buildToolbarSizeSlider");
  const buildToolbarSizeValue = document.getElementById("buildToolbarSizeValue");
  const buildToolbarSize = THREE.MathUtils.clamp(Number(gameSettings.layout.buildToolbar.size) || 100, 60, 160);
  gameSettings.layout.buildToolbar.size = Math.round(buildToolbarSize);
  if (buildToolbarSizeSlider) buildToolbarSizeSlider.value = String(buildToolbarSize);
  if (buildToolbarSizeValue) buildToolbarSizeValue.textContent = Math.round(buildToolbarSize) + "%";

  const movePadSizeSlider = document.getElementById("movePadSizeSlider");
  const movePadSizeValue = document.getElementById("movePadSizeValue");
  const movePadSize = Number(gameSettings.layout.movePad.size) || DEFAULT_SETTINGS.layout.movePad.size;
  if (movePadSizeSlider) movePadSizeSlider.value = String(movePadSize);
  if (movePadSizeValue) movePadSizeValue.textContent = Math.round(movePadSize) + "px";

  const fireButtonSizeSlider = document.getElementById("fireButtonSizeSlider");
  const fireButtonSizeValue = document.getElementById("fireButtonSizeValue");
  const fireButtonSize = THREE.MathUtils.clamp(
    Number(gameSettings.layout.fireButton.size) || DEFAULT_SETTINGS.layout.fireButton.size,
    60,
    180
  );
  gameSettings.layout.fireButton.size = Math.round(fireButtonSize);
  if (fireButtonSizeSlider) fireButtonSizeSlider.value = String(fireButtonSize);
  if (fireButtonSizeValue) fireButtonSizeValue.textContent = Math.round(fireButtonSize) + "px";

  const switchSizeSlider = document.getElementById("switchWeaponButtonSizeSlider");
  const switchSizeValue = document.getElementById("switchWeaponButtonSizeValue");
  const switchSize = THREE.MathUtils.clamp(Number(gameSettings.layout.switchWeaponButton.size) || 76, 60, 180);
  gameSettings.layout.switchWeaponButton.size = Math.round(switchSize);
  if (switchSizeSlider) switchSizeSlider.value = String(switchSize);
  if (switchSizeValue) switchSizeValue.textContent = Math.round(switchSize) + "px";
  const jumpSizeSlider = document.getElementById("jumpButtonSizeSlider");
  const jumpSizeValue = document.getElementById("jumpButtonSizeValue");
  const jumpSize = THREE.MathUtils.clamp(Number(gameSettings.layout.jumpButton.size) || 72, 48, 160);
  gameSettings.layout.jumpButton.size = Math.round(jumpSize);
  if (jumpSizeSlider) jumpSizeSlider.value = String(jumpSize);
  if (jumpSizeValue) jumpSizeValue.textContent = Math.round(jumpSize) + "px";

  const autoRespawnToggle = document.getElementById("autoRespawnToggle");
  if (autoRespawnToggle) {
    autoRespawnToggle.checked = gameSettings.autoRespawnEnabled === true;
    const label = document.getElementById("autoRespawnToggleValue");
    if (label) label.textContent = autoRespawnToggle.checked ? "ON" : "OFF";
  }

  const allowLookToggle = document.getElementById("allowLookWhileActionHeldToggle");
  if (allowLookToggle) {
    allowLookToggle.checked = gameSettings.allowLookWhileActionHeld !== false;
    const label = document.getElementById("allowLookToggleValue");
    if (label) label.textContent = allowLookToggle.checked ? "ON（許可）" : "OFF（禁止）";
  }

  const ultimateSizeSlider = document.getElementById("ultimateButtonSizeSlider");
  ultimateSizeSlider?.addEventListener("input", () => {
    gameSettings.layout.ultimateButton.size = Math.round(THREE.MathUtils.clamp(Number(ultimateSizeSlider.value) || 76, 48, 160));
    applyButtonLayout(); updateSettingsUi(); saveGameSettings();
  });

  const ultimateSizeSliderUi = document.getElementById("ultimateButtonSizeSlider");
  const ultimateSizeValueUi = document.getElementById("ultimateButtonSizeValue");
  const ultimateSize = THREE.MathUtils.clamp(Number(gameSettings.layout.ultimateButton.size) || 76, 48, 160);
  gameSettings.layout.ultimateButton.size = Math.round(ultimateSize);
  if (ultimateSizeSliderUi) ultimateSizeSliderUi.value = String(ultimateSize);
  if (ultimateSizeValueUi) ultimateSizeValueUi.textContent = Math.round(ultimateSize) + "px";

  const scopeSizeSlider = document.getElementById("scopeButtonSizeSlider");
  const scopeSizeValue = document.getElementById("scopeButtonSizeValue");
  const scopeSize = THREE.MathUtils.clamp(Number(gameSettings.layout.scopeButton.size) || 68, 60, 180);
  gameSettings.layout.scopeButton.size = Math.round(scopeSize);
  if (scopeSizeSlider) scopeSizeSlider.value = String(scopeSize);
  if (scopeSizeValue) scopeSizeValue.textContent = Math.round(scopeSize) + "px";

  const jumpCrouchLookToggle = document.getElementById("allowLookWhileJumpCrouchHeldToggle");
  if (jumpCrouchLookToggle) {
    jumpCrouchLookToggle.checked = gameSettings.allowLookWhileJumpCrouchHeld !== false;
    const label = document.getElementById("allowLookWhileJumpCrouchHeldValue");
    if (label) label.textContent = jumpCrouchLookToggle.checked ? "ON（許可）" : "OFF（禁止）";
  }

  const bowScopeZoomToggle = document.getElementById("bowScopeZoomToggle");
  if (bowScopeZoomToggle) bowScopeZoomToggle.checked = gameSettings.bowUsesSniperSensitivity !== false;

  const touchAimAssistSelect = document.getElementById("touchAimAssistStrengthSelect");
  if (touchAimAssistSelect) touchAimAssistSelect.value = String(gameSettings.touchAimAssistStrength ?? 0);
  const controllerAimAssistSelect = document.getElementById("controllerAimAssistStrengthSelect");
  if (controllerAimAssistSelect) controllerAimAssistSelect.value = String(gameSettings.controllerAimAssistStrength ?? 0);
  for (const select of document.querySelectorAll("[data-controller-button]")) {
    const action = select.dataset.controllerButton;
    select.value = String(Number(gameSettings.controllerButtons?.[action] ?? DEFAULT_SETTINGS.controllerButtons[action]));
  }
  refreshKeyBindingLabels();
}

const KEY_BINDING_LABELS = {
  forward: "前進", back: "後退", left: "左移動", right: "右移動",
  lookUp: "上を向く", lookDown: "下を向く", lookRight: "右を向く", lookLeft: "左を向く",
  jump: "ジャンプ", crouch: "しゃがむ", reload: "リロード",
  switchWeapon: "武器切替", weapon1: "武器スロット1", weapon2: "武器スロット2",
  fire: "発射", scope: "スコープを覗く", ultimate: "アルティメット"
};
let pendingKeyBindingAction = null;

const MOUSE_BUTTON_CODES = ["MouseLeft", "MouseMiddle", "MouseRight", "MouseBack", "MouseForward"];
const MOUSE_BUTTON_NAMES = {
  MouseLeft: "左クリック",
  MouseMiddle: "中央クリック",
  MouseRight: "右クリック",
  MouseBack: "マウス戻るボタン",
  MouseForward: "マウス進むボタン"
};
let suppressContextMenuUntil = 0;

function mouseButtonCode(button) {
  return MOUSE_BUTTON_CODES[button] || null;
}

function assignKeyBinding(action, code) {
  if (!action || !code) return false;
  const conflict = Object.entries(gameSettings.keyboard).find(([otherAction, existingCode]) =>
    otherAction !== action && existingCode === code
  );

  pendingKeyBindingAction = null;
  if (conflict) {
    refreshKeyBindingLabels();
    const status = document.getElementById("keyBindingStatus");
    if (status) status.textContent =
      keyCodeLabel(code) + " は「" + (KEY_BINDING_LABELS[conflict[0]] || conflict[0]) + "」に割り当て済みです。";
    return false;
  }

  gameSettings.keyboard[action] = code;
  saveGameSettings();
  refreshKeyBindingLabels();
  const status = document.getElementById("keyBindingStatus");
  if (status) status.textContent =
    KEY_BINDING_LABELS[action] + "を「" + keyCodeLabel(code) + "」に設定しました。";
  return true;
}

function keyCodeLabel(code) {
  if (!code) return "未設定";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  const labels = {
    ...MOUSE_BUTTON_NAMES,
    Space: "Space", Escape: "Esc", Enter: "Enter", Tab: "Tab",
    Backspace: "Backspace", ShiftLeft: "左Shift", ShiftRight: "右Shift",
    ControlLeft: "左Ctrl", ControlRight: "右Ctrl", AltLeft: "左Alt", AltRight: "右Alt",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    CapsLock: "Caps Lock", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "Backquote",
    Backslash: "\\"
  };
  return labels[code] || code;
}

function refreshKeyBindingLabels() {
  document.querySelectorAll("[data-keybind-action]").forEach((button) => {
    const action = button.dataset.keybindAction;
    if (pendingKeyBindingAction === action) {
      button.textContent = "キー/マウスを入力…（Escで取消）";
      button.classList.add("waiting-for-key");
    } else {
      button.textContent = keyCodeLabel(gameSettings.keyboard?.[action] || DEFAULT_SETTINGS.keyboard[action]) + " に変更";
      button.classList.remove("waiting-for-key");
    }
  });
}

function setupSettings() {
  const settingsButton = document.getElementById("settingsButton");
  const panel = document.getElementById("settingsPanel");
  const close = document.getElementById("settingsCloseButton");
  const done = document.getElementById("settingsDoneButton");
  const edit = document.getElementById("layoutEditButton");
  const resetLayout = document.getElementById("layoutResetButton");
  const resetAll = document.getElementById("settingsResetButton");
  const status = document.getElementById("layoutEditStatus");
  const editDone = document.getElementById("layoutEditDoneButton");

  const settingsTabs = Array.from(panel?.querySelectorAll("[data-settings-tab]") || []);
  const activateSettingsTab = (tabName) => {
    settingsTabs.forEach((button) => {
      const active = button.dataset.settingsTab === tabName;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    panel?.querySelectorAll("[data-settings-content]").forEach((section) => {
      const active = section.dataset.settingsContent === tabName;
      section.classList.toggle("active", active);
      section.hidden = !active;
    });
  };
  settingsTabs.forEach((button) => button.addEventListener("click", () => {
    if (pendingKeyBindingAction) {
      pendingKeyBindingAction = null;
      refreshKeyBindingLabels();
    }
    activateSettingsTab(button.dataset.settingsTab);
  }));

  panel?.querySelectorAll("[data-keybind-action]").forEach((button) => {
    button.addEventListener("click", () => {
      pendingKeyBindingAction = button.dataset.keybindAction;
      const status = document.getElementById("keyBindingStatus");
      if (status) status.textContent = KEY_BINDING_LABELS[pendingKeyBindingAction] + "に割り当てるキーを押してください。Escでキャンセルできます。";
      activateSettingsTab("keymouse");
      refreshKeyBindingLabels();
    });
  });

  const open = () => {
    updateSettingsUi();
    activateSettingsTab("general");
    panel?.classList.remove("hidden");
  };
  const stopLayoutEditing = () => {
    layoutEditing = false;
    status?.classList.add("hidden");
    document.getElementById("touchUi")?.classList.remove("layout-editing");
    document.getElementById("touchUi")?.classList.toggle("hidden", controllerMode);
    document.getElementById("hud")?.classList.remove("layout-editing");

    for (const id of ["minimap", "healthHud", "kdHud", "areaHud", "fullscreenButton", "settingsButton", "ammoHud", "crouchButton", "switchWeaponButton", "scopeButton", "ultimateButton", "buildToolbar"]) {
      document.getElementById(id)?.classList.remove("layout-editing-target");
    }

    editDone?.classList.add("hidden");
    applyButtonLayout();
  };

  const closePanel = () => {
    if (pendingKeyBindingAction) {
      pendingKeyBindingAction = null;
      refreshKeyBindingLabels();
    }
    stopLayoutEditing();
    panel?.classList.add("hidden");
  };

  const navigateToLobbyScreen = (screenId) => {
    if (!["modeScreen", "weaponScreen"].includes(screenId)) return;
    if (pendingKeyBindingAction) {
      pendingKeyBindingAction = null;
      refreshKeyBindingLabels();
    }
    stopLayoutEditing();
    panel?.classList.add("hidden");
    if (joined) {
      lobbyScreenAfterLeave = screenId;
      socket.emit("leaveMatch");
      return;
    }

    document.getElementById("weaponScreen")?.classList.toggle("hidden", screenId !== "weaponScreen");
    document.getElementById("modeScreen")?.classList.toggle("hidden", screenId !== "modeScreen");
  };

  document.getElementById("settingsModeChangeButton")?.addEventListener("click", () => {
    navigateToLobbyScreen("modeScreen");
  });

  document.getElementById("settingsWeaponChangeButton")?.addEventListener("click", () => {
    navigateToLobbyScreen("weaponScreen");
  });

  settingsButton?.addEventListener("click", () => {
    if (layoutEditing) return;
    open();
  });
  close?.addEventListener("click", closePanel);
  done?.addEventListener("click", closePanel);

  document.getElementById("touchAimAssistStrengthSelect")?.addEventListener("change", (event) => {
    gameSettings.touchAimAssistStrength = [0, 5, 10].includes(Number(event.target.value)) ? Number(event.target.value) : 0;
    gameSettings.touchAimAssistEnabled = gameSettings.touchAimAssistStrength > 0;
    saveGameSettings();
  });
  document.getElementById("controllerAimAssistStrengthSelect")?.addEventListener("change", (event) => {
    gameSettings.controllerAimAssistStrength = [0, 5, 10].includes(Number(event.target.value)) ? Number(event.target.value) : 0;
    gameSettings.controllerAimAssistEnabled = gameSettings.controllerAimAssistStrength > 0;
    saveGameSettings();
  });
  panel?.querySelectorAll("[data-controller-button]")?.forEach((select) => {
    select.addEventListener("change", () => {
      const action = select.dataset.controllerButton;
      const index = Number(select.value);
      if (!Number.isInteger(index) || index < 0 || index > 15) return;
      gameSettings.controllerButtons[action] = index;
      saveGameSettings();
    });
  });

  for (const [sliderId, settingName] of [
    ["touchSensitivitySlider", "touchSensitivity"],
    ["controllerSensitivitySlider", "controllerSensitivity"],
    ["mouseSensitivitySlider", "mouseSensitivity"],
    ["sniperSensitivitySlider", "sniperSensitivity"]
  ]) {
    document.getElementById(sliderId)?.addEventListener("input", (event) => {
      gameSettings[settingName] = THREE.MathUtils.clamp(Number(event.target.value) || 1, settingName === "sniperSensitivity" ? 0.2 : 0.4, settingName === "sniperSensitivity" ? 2.0 : 5.0);
      updateSettingsUi();
      saveGameSettings();
    });
  }

  const areaHudSizeSlider = document.getElementById("areaHudSizeSlider");
  areaHudSizeSlider?.addEventListener("input", () => {
    const size = THREE.MathUtils.clamp(Number(areaHudSizeSlider.value) || 100, 60, 150);
    gameSettings.layout.areaHud.size = Math.round(size);
    applyButtonLayout();
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

  const buildToolbarSizeSlider = document.getElementById("buildToolbarSizeSlider");
  buildToolbarSizeSlider?.addEventListener("input", () => {
    gameSettings.layout.buildToolbar.size = Math.round(THREE.MathUtils.clamp(Number(buildToolbarSizeSlider.value) || 100, 60, 160));
    applyButtonLayout(); updateSettingsUi(); saveGameSettings();
  });

  const fireButtonSizeSlider = document.getElementById("fireButtonSizeSlider");
  fireButtonSizeSlider?.addEventListener("input", () => {
    const size = THREE.MathUtils.clamp(Number(fireButtonSizeSlider.value) || 100, 60, 180);
    gameSettings.layout.fireButton.size = Math.round(size);
    applyButtonLayout();
    updateSettingsUi();
    saveGameSettings();
  });

  const switchSizeSlider = document.getElementById("switchWeaponButtonSizeSlider");
  switchSizeSlider?.addEventListener("input", () => {
    const size = THREE.MathUtils.clamp(Number(switchSizeSlider.value) || 76, 60, 180);
    gameSettings.layout.switchWeaponButton.size = Math.round(size);
    applyButtonLayout(); updateSettingsUi(); saveGameSettings();
  });
  const jumpSizeSlider = document.getElementById("jumpButtonSizeSlider");
  jumpSizeSlider?.addEventListener("input", () => {
    const size = THREE.MathUtils.clamp(Number(jumpSizeSlider.value) || 72, 48, 160);
    gameSettings.layout.jumpButton.size = Math.round(size);
    applyButtonLayout(); updateSettingsUi(); saveGameSettings();
  });

  document.getElementById("autoRespawnToggle")?.addEventListener("change", (event) => {
    gameSettings.autoRespawnEnabled = Boolean(event.target.checked);
    const label = document.getElementById("autoRespawnToggleValue");
    if (label) label.textContent = event.target.checked ? "ON" : "OFF";
    saveGameSettings();
  });

  document.getElementById("bowScopeZoomToggle")?.addEventListener("change", (event) => {
    gameSettings.bowUsesSniperSensitivity = Boolean(event.target.checked);
    // 感度設定のみ変更。弓のスコープ倍率・表示は常に有効。
    saveGameSettings();
  });

  document.getElementById("allowLookWhileActionHeldToggle")?.addEventListener("change", (event) => {
    gameSettings.allowLookWhileActionHeld = Boolean(event.target.checked);
    const label = document.getElementById("allowLookToggleValue");
    if (label) label.textContent = event.target.checked ? "ON（許可）" : "OFF（禁止）";
    saveGameSettings();
  });

  document.getElementById("allowLookWhileJumpCrouchHeldToggle")?.addEventListener("change", (event) => {
    gameSettings.allowLookWhileJumpCrouchHeld = Boolean(event.target.checked);
    const label = document.getElementById("allowLookWhileJumpCrouchHeldValue");
    if (label) label.textContent = event.target.checked ? "ON（許可）" : "OFF（禁止）";
    saveGameSettings();
  });

  const scopeSizeSlider = document.getElementById("scopeButtonSizeSlider");
  scopeSizeSlider?.addEventListener("input", () => {
    const size = THREE.MathUtils.clamp(Number(scopeSizeSlider.value) || 68, 60, 180);
    gameSettings.layout.scopeButton.size = Math.round(size);
    applyButtonLayout(); updateSettingsUi(); saveGameSettings();
  });

  edit?.addEventListener("click", () => {
    layoutEditing = true;
    status?.classList.remove("hidden");
    document.getElementById("touchUi")?.classList.remove("hidden");
    document.getElementById("touchUi")?.classList.add("layout-editing");
    document.getElementById("hud")?.classList.add("layout-editing");

    for (const id of ["minimap", "healthHud", "kdHud", "areaHud", "fullscreenButton", "settingsButton", "ammoHud", "crouchButton", "switchWeaponButton", "scopeButton", "ultimateButton", "buildToolbar"]) {
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

  const settingsExportButton = document.getElementById("settingsExportButton");
  const settingsImportButton = document.getElementById("settingsImportButton");
  const settingsImportInput = document.getElementById("settingsImportInput");
  settingsExportButton?.addEventListener("click", () => {
    const payload = {
      format: "fpsgame-settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: cloneSettings(gameSettings)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "fpsgame-settings.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
  settingsImportButton?.addEventListener("click", () => settingsImportInput?.click());
  settingsImportInput?.addEventListener("change", async () => {
    const file = settingsImportInput.files?.[0];
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("設定ファイルのサイズが大きすぎます。");
      const parsed = JSON.parse(await file.text());
      const imported = parsed?.format === "fpsgame-settings" ? parsed.settings : parsed;
      if (!imported || typeof imported !== "object" || Array.isArray(imported) ||
          !imported.layout || !imported.keyboard) {
        throw new Error("FPSgameの設定ファイルではありません。");
      }
      if (!window.confirm("現在の設定を読み込んだ内容で上書きします。よろしいですか？")) return;
      setCookie("fps_game_settings", JSON.stringify(imported), 3650);
      window.location.reload();
    } catch (error) {
      window.alert(error?.message || "設定ファイルを読み込めませんでした。");
    } finally {
      settingsImportInput.value = "";
    }
  });

  resetLayout?.addEventListener("click", () => {
    if (!window.confirm("画面上のボタンとHUDの配置・サイズを初期状態に戻します。よろしいですか？")) return;
    gameSettings.layout = cloneSettings(DEFAULT_SETTINGS.layout);
    applyButtonLayout();
    updateSettingsUi();
    saveGameSettings();
  });

  resetAll?.addEventListener("click", () => {
    pendingKeyBindingAction = null;
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

  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;

  const begin = (e) => {
    if (!layoutEditing) return;

    const cfg = gameSettings.layout[settingKey] || { x: 0, y: 0 };
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startOffsetX = Number(cfg.x) || 0;
    startOffsetY = Number(cfg.y) || 0;

    e.preventDefault();
    e.stopPropagation();

    try { el.setPointerCapture(pointerId); } catch (_) {}
  };

  const move = (e) => {
    if (!dragging || e.pointerId !== pointerId || !layoutEditing) return;

    const cfg = gameSettings.layout[settingKey];
    if (!cfg) return;

    cfg.x = Math.round(startOffsetX + e.clientX - startX);
    cfg.y = Math.round(startOffsetY + (id === "buildToolbar" ? startY - e.clientY : e.clientY - startY));
    if (id === "areaHud" || id === "buildToolbar") {
      el.style.setProperty("--layout-x", cfg.x + "px");
      el.style.setProperty("--layout-y", cfg.y + "px");
    } else {
      el.style.transform = "translate3d(" + cfg.x + "px, " + cfg.y + "px, 0)";
    }

    e.preventDefault();
    e.stopPropagation();
    saveGameSettings();
  };

  const end = (e) => {
    if (e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    e.stopPropagation();
  };

  el.addEventListener("pointerdown", begin, { passive: false });
  el.addEventListener("pointermove", move, { passive: false });
  el.addEventListener("pointerup", end, { passive: false });
  el.addEventListener("pointercancel", end, { passive: false });
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

  playerName = value.slice(0, 128);
  setCookie("fps_player_name", playerName);
  if (input) input.value = playerName;
  return playerName;
}

loadPlayerName();
setupSettings();

async function setupPushNotifications() {
  const button = document.getElementById("pushNotificationToggle");
  const status = document.getElementById("pushNotificationStatus");
  if (!button || !status) return;
  const base = location.hostname === "test-gamma-two-87.vercel.app"
    ? "https://harusinn.com/FPSgame/"
    : (location.pathname.startsWith("/FPSgame/") ? "/FPSgame/" : "/");
  const api = (path, options = {}) => fetch(base + "api/push/" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let busy = false;
  const update = async () => {
    if (!supported) {
      button.disabled = true;
      button.textContent = "通知非対応";
      status.textContent = "このブラウザではプッシュ通知を利用できません。";
      return;
    }
    try {
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => window.setTimeout(
          () => reject(new Error("通知機能の起動に時間がかかっています。ページを再読み込みしてください。")),
          15000
        ))
      ]);
      const subscription = await registration.pushManager.getSubscription();
      const enabled = Boolean(subscription);
      button.textContent = enabled ? "通知 ON（OFFにする）" : "通知 OFF（ONにする）";
      button.classList.toggle("push-enabled", enabled);
      status.textContent = enabled
        ? "通知はONです。日本時間9:00〜17:00のオンライン開始を通知します。"
        : (Notification.permission === "denied" ? "ブラウザの通知設定でFPSgameの通知を許可してください。" : "通知はOFFです。");
    } catch (error) {
      button.textContent = "通知状態を確認できません";
      button.disabled = true;
      button.classList.remove("push-enabled");
      status.textContent = (error.message || "通知状態を確認できませんでした。") + " ページを再読み込みしてください。";
    }
  };
  button.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      // iOSのホーム画面アプリでは通知許可要求がユーザー操作中に呼ばれる必要がある。
      // serviceWorker.ready等のawaitより先にrequestPermissionを開始する。
      const permissionRequest = Notification.permission === "granted"
        ? Promise.resolve("granted")
        : Notification.requestPermission();
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        await api("unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: existing.endpoint }) });
        await existing.unsubscribe();
        status.textContent = "通知をOFFにしました。";
      } else {
        if (Notification.permission === "denied") {
          status.textContent = "端末の設定でFPSgameの通知を許可してから、もう一度押してください。";
          return;
        }
        const permission = await permissionRequest;
        if (permission !== "granted") {
          status.textContent = "通知の許可が必要です。ホーム画面から開いたFPSgameで再度お試しください。";
          return;
        }
        const keyResponse = await api("public-key", { method: "GET", headers: {} });
        if (!keyResponse.ok) throw new Error("通知サーバーの設定を取得できません。");
        const { publicKey } = await keyResponse.json();
        const applicationServerKey = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        const saveResponse = await api("subscribe", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
        if (!saveResponse.ok) throw new Error("通知登録を保存できませんでした。");
        status.textContent = "通知をONにしました。";
      }
    } catch (error) {
      status.textContent = "通知設定に失敗しました: " + (error.message || "不明なエラー");
    } finally {
      busy = false;
      button.disabled = false;
      await update();
    }
  });
  await update();
}

setupPushNotifications();

const topScreen = document.getElementById("topScreen");
const topStartButton = document.getElementById("topStartButton");
const topSettingsButton = document.getElementById("topSettingsButton");
const topOnlineCount = document.getElementById("topOnlineCount");
const modePlayerCountElements = {
  shootingRange: document.getElementById("shootingRangePlayerCount"),
  wander: document.getElementById("wanderPlayerCount"),
  freeForAll: document.getElementById("freeForAllPlayerCount"),
  area: document.getElementById("areaPlayerCount"),
  payload: document.getElementById("payloadPlayerCount"),
  duel: document.getElementById("duelPlayerCount"),
  build: document.getElementById("buildPlayerCount")
};
const topNoticeList = document.getElementById("topNoticeList");
const lobbyApiBase = location.hostname === "test-gamma-two-87.vercel.app"
  ? "https://harusinn.com/FPSgame/"
  : (location.pathname.startsWith("/FPSgame/") ? "/FPSgame/" : "/");
async function refreshLobbyInfo() {
  try {
    const response = await fetch(lobbyApiBase + "api/lobby-info", { cache: "no-store" });
    if (!response.ok) return;
    const info = await response.json();
    const onlinePlayers = Math.max(0, Number(info.onlinePlayers) || 0);
    if (topOnlineCount) topOnlineCount.textContent = String(onlinePlayers);
    const modeCounts = info.modeCounts || {};
    for (const [mode, element] of Object.entries(modePlayerCountElements)) {
      if (element) element.textContent = String(Math.max(0, Number(modeCounts[mode]) || 0));
    }
    if (topNoticeList) {
      topNoticeList.replaceChildren();
      const lines = String(info.notice || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (!lines.length) {
        const empty = document.createElement("li");
        empty.textContent = "現在お知らせはありません。";
        topNoticeList.appendChild(empty);
      } else {
        for (const line of lines) {
          const item = document.createElement("li");
          item.textContent = line.replace(/^[-*・]\s*/, "");
          topNoticeList.appendChild(item);
        }
      }
    }
  } catch (_) {}
}
refreshLobbyInfo();
setInterval(refreshLobbyInfo, 10000);
topStartButton?.addEventListener("click", () => {
  if (joined) return;
  savePlayerName();
  topScreen?.classList.add("hidden");
  document.getElementById("weaponScreen")?.classList.remove("hidden");
});
topSettingsButton?.addEventListener("click", () => document.getElementById("settingsButton")?.click());
updateGamepadStatus();

function selectBuildType(type) {
  if (type !== "wall" && type !== "floor" && type !== "ramp") return;
  selectedBuildType = type;
  buildPreviewActive = true;
  document.getElementById("buildWallButton")?.classList.toggle("active", type === "wall");
  document.getElementById("buildFloorButton")?.classList.toggle("active", type === "floor");
  document.getElementById("buildRampButton")?.classList.toggle("active", type === "ramp");
  document.getElementById("buildWallButton")?.setAttribute("aria-pressed", String(type === "wall"));
  document.getElementById("buildFloorButton")?.setAttribute("aria-pressed", String(type === "floor"));
  document.getElementById("buildRampButton")?.setAttribute("aria-pressed", String(type === "ramp"));
  updateBuildPreview();
}

function placeBuildStructure() {
  if (!joined || selectedGameMode !== "Build" || !buildPreviewActive || !buildPreviewPosition || !socket.connected) return;
  socket.emit("buildPlace", {
    type: selectedBuildType,
    x: buildPreviewPosition.x,
    y: buildPreviewPosition.y,
    z: buildPreviewPosition.z,
    rotation: buildPreviewPosition.rotation
  });
}

function updateBuildToolbar() {
  const toolbar = document.getElementById("buildToolbar");
  const visible = joined && selectedGameMode === "Build";
  toolbar?.classList.toggle("hidden", !visible);
  if (visible) updateBuildPreview();
  else if (buildPreviewMesh) buildPreviewMesh.visible = false;
}

function buildPreviewTouches(a, b) {
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

function updateBuildPreview() {
  const hidePreview = () => {
    if (buildPreviewMesh) buildPreviewMesh.visible = false;
    buildPreviewPosition = null;
  };
  if (selectedGameMode !== "Build" || !joined || !buildPreviewActive ||
      !worldData?.map || worldData.map.id !== "build-world" || !myState) {
    hidePreview();
    return;
  }

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  raycaster.far = 12;
  const supportMeshes = worldGroup.children.filter(mesh => mesh.userData?.buildSupportSurface);
  const hits = raycaster.intersectObjects(supportMeshes, false);
  let target = hits[0]?.point?.clone() || null;
  if (!target) {
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    target = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(ground, target) ||
        target.distanceTo(raycaster.ray.origin) > 12) {
      // 上下を向いていて地面との交点がない場合も、視線上の仮ターゲットを使う。
      // y=0に固定すると天井方向の候補が地面側へ引っ張られる。
      target.copy(camera.position).addScaledVector(raycaster.ray.direction, 4);
    }
  }

  const snappedRotation = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
  const rotation = Math.atan2(Math.sin(snappedRotation), Math.cos(snappedRotation));
  const isWall = selectedBuildType === "wall";
  const isRamp = selectedBuildType === "ramp";
  const isSideways = Math.abs(Math.sin(rotation)) > 0.5;
  const w = isWall ? (isSideways ? 0.16 : 4) : 4;
  const d = isWall ? (isSideways ? 4 : 0.16) : 4;
  const rampDirection = Math.abs(rotation) < 0.1 ? "south"
    : Math.abs(rotation - Math.PI / 2) < 0.1 ? "west"
    : Math.abs(Math.abs(rotation) - Math.PI) < 0.1 ? "north" : "east";
  const bounds = worldData.world || { minX: -16, maxX: 16, minZ: -16, maxZ: 16 };

  // 視線が水平に近い場合はレイが設置面を捉えず、照準位置を基準にすると
  // 候補が消えることがある。候補グリッドは常にプレイヤー位置を基準に周囲を検索し、
  // 照準方向は候補の優先順位にだけ使う。
  const baseX = isWall
    ? (isSideways ? Math.round(myState.x / 4) * 4 : Math.floor(myState.x / 4) * 4 + 2)
    : Math.floor(myState.x / 4) * 4 + 2;
  const baseZ = isWall
    ? (isSideways ? Math.floor(myState.z / 4) * 4 + 2 : Math.round(myState.z / 4) * 4)
    : Math.floor(myState.z / 4) * 4 + 2;
  const aimDirection = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));

  const structures = Array.isArray(worldData.buildStructures) ? worldData.buildStructures : [];
  // 地面から接続をたどって到達できる建築物だけを有効な土台にする。
  // 浮いている建築物に接しているだけの候補は、設置後に連鎖破壊されるため除外する。
  const groundedStructures = new Set(
    structures.filter(item => (Number(item.y) || 0) <= 0.02).map(item => item.id)
  );
  let supportChanged = true;
  while (supportChanged) {
    supportChanged = false;
    for (const item of structures) {
      if (groundedStructures.has(item.id)) continue;
      const connectedToGround = structures.some(other =>
        groundedStructures.has(other.id) && buildPreviewTouches(item, {
          ...other,
          w: Number(other.w) || 4,
          d: Number(other.d) || 4,
          h: Number(other.h) || (other.type === "wall" || other.type === "ramp" ? 4 : 0.08)
        })
      );
      if (connectedToGround) {
        groundedStructures.add(item.id);
        supportChanged = true;
      }
    }
  }
  const groundedSupports = structures.filter(item => groundedStructures.has(item.id));
  const heights = new Set([0]);
  for (const item of structures) {
    const y = Number(item.y) || 0;
    const h = Number(item.h) || (item.type === "wall" || item.type === "ramp" ? 4 : 0.08);
    heights.add(y);
    heights.add(y + h);
  }

  const candidates = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const x = baseX + dx * 4;
      const z = baseZ + dz * 4;
      if (x - w / 2 < bounds.minX || x + w / 2 > bounds.maxX ||
          z - d / 2 < bounds.minZ || z + d / 2 > bounds.maxZ) continue;
      const playerDistance = Math.hypot(x - myState.x, z - myState.z);
      // 壁は従来どおりプレイヤーから一定距離を保つ。床は真下・真上にも置けるよう
      // 水平距離の下限を設けず、上下方向の候補も検索する。
      if (playerDistance > 6.05 || (isWall && playerDistance < 1.8)) continue;

      const possibleHeights = [...heights]
        .filter(y => y >= 0 && y <= 40)
        .sort((a, b) => Math.abs(a - target.y) - Math.abs(b - target.y));
      for (const y of possibleHeights) {
        const item = { type: selectedBuildType, x, y, z, rotation, direction: rampDirection, w, d, h: (isWall || isRamp) ? 4 : 0.08 };
        const occupied = structures.some(other => {
          const overlapX = Math.min(x + w / 2, other.x + other.w / 2) - Math.max(x - w / 2, other.x - other.w / 2);
          const overlapZ = Math.min(z + d / 2, other.z + other.d / 2) - Math.max(z - d / 2, other.z - other.d / 2);
          return other.type === selectedBuildType &&
            Math.abs((Number(other.y) || 0) - y) < 0.12 &&
            overlapX > 0.12 && overlapZ > 0.12;
        });
        if (occupied) continue;
        const supported = y <= 0.02 || groundedSupports.some(other => buildPreviewTouches(item, {
          ...other,
          w: Number(other.w) || 4,
          d: Number(other.d) || 4,
          h: Number(other.h) || (other.type === "wall" || other.type === "ramp" ? 4 : 0.08)
        }));
        if (!supported) continue;
        const center = new THREE.Vector3(x, y + ((isWall || isRamp) ? 2 : 0.04), z);
        const cameraDistance = center.distanceTo(camera.position);
        if (isWall) {
          const toCandidate = new THREE.Vector3(x - myState.x, 0, z - myState.z);
          const horizontalDistance = toCandidate.length();
          if (horizontalDistance <= 0.001) continue;
          const forwardDistance = toCandidate.dot(aimDirection);
          // 壁は視点の前方だけを候補にする。
          if (forwardDistance <= 0.35) continue;
          const lateralDistance = Math.sqrt(Math.max(0,
            horizontalDistance * horizontalDistance - forwardDistance * forwardDistance
          ));
          candidates.push({
            item,
            score: forwardDistance + lateralDistance * 2.5 + cameraDistance * 0.05
          });
        } else {
          // 床・階段はカメラの3D視線方向で候補を評価する。
          // 視線の先にある支持済みの床候補を選べるようにする。
          const viewDirection = raycaster.ray.direction.clone().normalize();
          const toCandidate = center.clone().sub(camera.position);
          const forwardDistance = toCandidate.dot(viewDirection);
          // カメラから前方12m以内、かつ照準線から大きく外れない床だけを候補にする。
          if (forwardDistance <= 0.2 || forwardDistance > 12) continue;
          const lateralDistance = toCandidate.clone()
            .addScaledVector(viewDirection, -forwardDistance).length();
          if (lateralDistance > 4.5) continue;
          const targetAlongRay = target.clone().sub(camera.position).dot(viewDirection);
          const targetDistance = center.distanceTo(target);
          // 視線との横ずれを最重視し、その次に照準先との距離を評価する。
          // プレイヤーから近いだけの床や、視線の後方・大きく外れた床は選ばない。
          candidates.push({
            item,
            score: lateralDistance * 5
              + Math.abs(forwardDistance - targetAlongRay) * 0.8
              + targetDistance * 0.35
              + forwardDistance * 0.03
          });
        }
        break;
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const candidate = candidates[0]?.item;
  if (!candidate) {
    hidePreview();
    return;
  }

  buildPreviewPosition = { x: candidate.x, y: candidate.y, z: candidate.z, rotation };
  if (!buildPreviewMesh || buildPreviewMesh.userData.buildType !== selectedBuildType ||
      (isRamp && buildPreviewMesh.userData.buildRampDirection !== rampDirection)) {
    if (buildPreviewMesh) {
      scene.remove(buildPreviewMesh);
      buildPreviewMesh.geometry.dispose();
      buildPreviewMesh.material.dispose();
    }
    let previewGeometry;
    if (isWall) {
      previewGeometry = new THREE.BoxGeometry(4, 4, 0.16);
    } else if (isRamp) {
      let vertices;
      if (rampDirection === "east" || rampDirection === "west") {
        const lowAtXLow = rampDirection === "west";
        const yAtXLow = lowAtXLow ? 4 : 0;
        const yAtXHigh = lowAtXLow ? 0 : 4;
        vertices = [
          -2,yAtXLow,-2, -2,yAtXLow,2,
          2,yAtXHigh,-2, 2,yAtXHigh,2
        ];
      } else {
        const lowAtZLow = rampDirection === "north";
        const yAtZLow = lowAtZLow ? 0 : 4;
        const yAtZHigh = lowAtZLow ? 4 : 0;
        vertices = [
          -2,yAtZLow,-2, 2,yAtZLow,-2,
          -2,yAtZHigh,2, 2,yAtZHigh,2
        ];
      }
      previewGeometry = new THREE.BufferGeometry();
      previewGeometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
      previewGeometry.setIndex([0,1,2,2,1,3]);
      previewGeometry.computeVertexNormals();
    } else {
      previewGeometry = new THREE.BoxGeometry(4, 0.08, 4);
    }
    buildPreviewMesh = new THREE.Mesh(
      previewGeometry,
      new THREE.MeshBasicMaterial({
        color: isWall ? 0x80d6ff : isRamp ? 0xffc36b : 0x8ee5a8,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    buildPreviewMesh.userData.buildType = selectedBuildType;
    if (isRamp) buildPreviewMesh.userData.buildRampDirection = rampDirection;
    buildPreviewMesh.renderOrder = 20;
    scene.add(buildPreviewMesh);
  }
  buildPreviewMesh.position.set(candidate.x, isWall ? candidate.y + 2 : isRamp ? candidate.y : candidate.y + 0.04, candidate.z);
  buildPreviewMesh.rotation.set(0, isWall ? rotation : 0, 0);
  buildPreviewMesh.visible = true;
}
document.getElementById("buildWallButton")?.addEventListener("click", () => { if (!layoutEditing) selectBuildType("wall"); });
document.getElementById("buildFloorButton")?.addEventListener("click", () => { if (!layoutEditing) selectBuildType("floor"); });
document.getElementById("buildRampButton")?.addEventListener("click", () => { if (!layoutEditing) selectBuildType("ramp"); });
document.getElementById("buildPlaceButton")?.addEventListener("click", () => { if (!layoutEditing) placeBuildStructure(); });

function makeBox(w, h, d, x, y, z, color = 0x647080) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: .9, metalness: .05 })
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.worldLod = true;
  mesh.userData.nearMaterial = mesh.material;
  mesh.userData.farMaterial = new THREE.MeshBasicMaterial({ color });
  worldGroup.add(mesh);
  return mesh;
}

function makeRamp(ramp, color = 0x71808d) {
  const halfW = ramp.w / 2;
  const halfD = ramp.d / 2;
  let vertices;

  // 階段は中身のない斜めの長方形板。下側を塞がず、下を通り抜けられる。
  if (ramp.direction === "east" || ramp.direction === "west") {
    const yAtXLow = ramp.direction === "west" ? ramp.h : 0;
    const yAtXHigh = ramp.direction === "west" ? 0 : ramp.h;
    vertices = new Float32Array([
      -halfW, yAtXLow, -halfD,
      -halfW, yAtXLow, halfD,
      halfW, yAtXHigh, -halfD,
      halfW, yAtXHigh, halfD
    ]);
  } else {
    const yAtZLow = ramp.direction === "north" ? 0 : ramp.h;
    const yAtZHigh = ramp.direction === "north" ? ramp.h : 0;
    vertices = new Float32Array([
      -halfW, yAtZLow, -halfD,
      halfW, yAtZLow, -halfD,
      -halfW, yAtZHigh, halfD,
      halfW, yAtZHigh, halfD
    ]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    depthWrite: true
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(ramp.x, Number(ramp.y) || 0, ramp.z);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  if (ramp.buildStructureId) mesh.userData.buildSupportSurface = true;
  worldGroup.add(mesh);
  return mesh;
}

function buildPayloadTrackVisual(pathPoints) {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2) return;
  const points = pathPoints.map(point => new THREE.Vector3(point[0], (point[1] || 0) + 0.055, point[2]));
  const roadMaterial = new THREE.MeshStandardMaterial({
    color: 0x252d35, roughness: 0.94, side: THREE.DoubleSide
  });
  const railMaterial = new THREE.MeshStandardMaterial({
    color: 0xb8bec4, metalness: 0.55, roughness: 0.5
  });

  // 角ごとに直方体を重ねる方式をやめ、連続した路面リボンとして描画する。
  // サーバー側の細分化済みpayloadPathと同じ点列を使うため、カートの軌道とずれない。
  const positions = [];
  const indices = [];
  for (let i = 0; i < points.length; i++) {
    const before = points[Math.max(0, i - 1)];
    const after = points[Math.min(points.length - 1, i + 1)];
    const tangent = new THREE.Vector3(after.x - before.x, 0, after.z - before.z).normalize();
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const point = points[i];
    positions.push(
      point.x + side.x * 4.1, 0.055, point.z + side.z * 4.1,
      point.x - side.x * 4.1, 0.055, point.z - side.z * 4.1
    );
    if (i > 0) {
      const previous = (i - 1) * 2;
      const current = i * 2;
      indices.push(previous, current, previous + 1, previous + 1, current, current + 1);
    }
  }
  const roadGeometry = new THREE.BufferGeometry();
  roadGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  roadGeometry.setIndex(indices);
  roadGeometry.computeVertexNormals();
  worldGroup.add(new THREE.Mesh(roadGeometry, roadMaterial));

  // ガードレールも経路全体を滑らかな曲線でつなぎ、折れ角での食い違いを防ぐ。
  for (const railSide of [-1, 1]) {
    const railPoints = points.map((point, index) => {
      const before = points[Math.max(0, index - 1)];
      const after = points[Math.min(points.length - 1, index + 1)];
      const tangent = new THREE.Vector3(after.x - before.x, 0, after.z - before.z).normalize();
      const side = new THREE.Vector3(-tangent.z, 0, tangent.x);
      return new THREE.Vector3(
        point.x + side.x * railSide * 3.85,
        0.18,
        point.z + side.z * railSide * 3.85
      );
    });
    const railCurve = new THREE.CatmullRomCurve3(railPoints, false, "centripetal");
    const railGeometry = new THREE.TubeGeometry(railCurve, Math.max(96, points.length * 2), 0.11, 6, false);
    worldGroup.add(new THREE.Mesh(railGeometry, railMaterial));
  }

  payloadCartGroup = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x202a33, metalness: 0.45, roughness: 0.58 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.72, 2.45), new THREE.MeshStandardMaterial({ color: 0x31536b, metalness: 0.25, roughness: 0.65 }));
  body.position.y = 0.95;
  payloadCartGroup.add(body);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.16, 2.2), new THREE.MeshStandardMaterial({ color: 0xc18a3d, metalness: 0.2, roughness: 0.8 }));
  deck.position.y = 1.38;
  payloadCartGroup.add(deck);
  const cargo = new THREE.Mesh(new THREE.BoxGeometry(1.55, 1.15, 1.55), new THREE.MeshStandardMaterial({ color: 0x5b6871, metalness: 0.25, roughness: 0.75 }));
  cargo.position.set(-0.35, 2.0, 0);
  payloadCartGroup.add(cargo);
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.45, 12), new THREE.MeshStandardMaterial({ color: 0xffcb45, emissive: 0x9b5d08, emissiveIntensity: 0.65 }));
  beacon.position.set(1.25, 2.05, 0);
  payloadCartGroup.add(beacon);
  const wheelGeometry = new THREE.CylinderGeometry(0.52, 0.52, 0.34, 16);
  for (const x of [-1.35, 1.35]) for (const z of [-1.18, 1.18]) {
    const wheel = new THREE.Mesh(wheelGeometry, dark);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, 0.56, z);
    payloadCartGroup.add(wheel);
  }
  payloadCartGroup.traverse(part => { if (part.isMesh) { part.castShadow = true; part.receiveShadow = true; } });
  worldGroup.add(payloadCartGroup);
  updatePayloadCartVisual({ x: pathPoints[0][0], y: pathPoints[0][1] || 0, z: pathPoints[0][2], yaw: 0 });
}
function updatePayloadCartVisual(cart) {
  if (!cart) return;
  payloadCartMapState = {
    x: Number(cart.x) || 0,
    z: Number(cart.z) || 0,
    yaw: Number(cart.yaw) || 0
  };
  if (!payloadCartGroup) return;
  payloadCartGroup.position.set(Number(cart.x) || 0, (Number(cart.y) || 0) + 0.02, Number(cart.z) || 0);
  payloadCartGroup.rotation.y = (Number(cart.yaw) || 0) + Math.PI / 2;
}

function buildWorld(data) {
  // マップ切替時は前の床・壁・障害物を破棄してから新しいマップを描画する。
  for (const oldObject of [...worldGroup.children]) {
    worldGroup.remove(oldObject);
    oldObject.traverse?.((part) => {
      part.geometry?.dispose();
      const materials = Array.isArray(part.material) ? part.material : [part.material];
      const allMaterials = new Set([...materials, part.userData?.nearMaterial, part.userData?.farMaterial].filter(Boolean));
      for (const material of allMaterials) {
        material?.map?.dispose();
        material?.dispose();
      }
    });
  }

  worldData = data;
  payloadCartGroup = null;
  payloadGateMeshes = [];
  const bounds = data.world || { minX: -48, maxX: 48, minZ: -48, maxZ: 48 };
  // マップ境界の外側に2ユニット分の床と壁を設けます。
  const worldWidth = bounds.maxX - bounds.minX + 4;
  const worldDepth = bounds.maxZ - bounds.minZ + 4;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(worldWidth, worldDepth),
    new THREE.MeshStandardMaterial({ color: 0x526052, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(centerX, 0, centerZ);
  floor.receiveShadow = true;
  worldGroup.add(floor);

  // Buildモードは1m単位の32×32グリッドを表示する。
  if (data.map?.id !== "payload-fractured-district") {
    const gridSize = data.map?.id === "build-world" ? 32 : Math.max(worldWidth, worldDepth);
    const gridDivisions = data.map?.id === "build-world" ? 32 : Math.max(1, Math.round(gridSize / (Math.max(worldWidth, worldDepth) > 150 ? 8 : 2)));
    const grid = new THREE.GridHelper(gridSize, gridDivisions, 0x879487, 0x6b756b);
    grid.position.set(centerX, 0.01, centerZ);
    worldGroup.add(grid);
  }

  if (data.areaZone && Number.isFinite(data.areaZone.radius)) {
    const zone = data.areaZone;
    const zoneFloor = new THREE.Mesh(
      new THREE.CircleGeometry(zone.radius, 64),
      new THREE.MeshBasicMaterial({
        color: 0xf2c84b,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    zoneFloor.rotation.x = -Math.PI / 2;
    zoneFloor.position.set(zone.x, 0.035, zone.z);
    worldGroup.add(zoneFloor);

    const zoneRing = new THREE.Mesh(
      new THREE.TorusGeometry(zone.radius, 0.16, 10, 64),
      new THREE.MeshBasicMaterial({ color: 0xffdf67, depthWrite: false })
    );
    zoneRing.rotation.x = Math.PI / 2;
    zoneRing.position.set(zone.x, 0.18, zone.z);
    worldGroup.add(zoneRing);

    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(zone.radius * 0.72, 0.045, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0xfff0ad, transparent: true, opacity: 0.8, depthWrite: false })
    );
    innerRing.rotation.x = Math.PI / 2;
    innerRing.position.set(zone.x, 0.12, zone.z);
    worldGroup.add(innerRing);
  }

  for (const o of data.obstacles || []) {
    if (o.teamOnlyRole) {
      const roleTeam = payloadAttackingTeam ? (o.teamOnlyRole === "attack" ? payloadAttackingTeam : (payloadAttackingTeam === "blue" ? "red" : "blue")) : null;
      const gateColor = roleTeam ? (roleTeam === "blue" ? 0x258be8 : 0xe34b52) : (o.teamOnlyRole === "attack" ? 0x258be8 : 0xe34b52);
      const gate = new THREE.Mesh(
        new THREE.BoxGeometry(o.w, o.h, o.d),
        new THREE.MeshStandardMaterial({
          color: gateColor,
          emissive: gateColor,
          emissiveIntensity: 0.3,
          transparent: true,
          opacity: 0.48,
          depthWrite: false,
          metalness: 0.25,
          roughness: 0.35
        })
      );
      gate.position.set(o.x, o.h / 2, o.z);
      gate.renderOrder = 3;
      gate.userData.role = o.teamOnlyRole;
      payloadGateMeshes.push(gate);
      worldGroup.add(gate);
    } else {
      const obstacleMesh = makeBox(o.w, o.h, o.d, o.x, o.ceiling ? o.y + o.h / 2 : o.h / 2, o.z, 0x687582);
      if (o.buildStructureId) obstacleMesh.userData.buildSupportSurface = true;
    }
  }

  // 射撃場専用の特殊床。薄い直方体全体をBasicMaterialで描画し、面を完全な単色にする。
  const floorStyles = {
    fire: { color: 0xd92727 },
    slime: { color: 0x26b866 },
    speed: { color: 0x00aaff },
    safe: { color: 0x26b866 },
    build: { color: 0x8b9eae }
  };
  for (const tile of data.floorTiles || []) {
    const style = floorStyles[tile.type] || floorStyles.safe;
    const tileHeight = tile.type === "build" ? 0.08 : 0.06;
    const tileMesh = new THREE.Mesh(
      new THREE.BoxGeometry(tile.w, tileHeight, tile.d),
      new THREE.MeshBasicMaterial({
        color: style.color,
        side: THREE.DoubleSide,
        toneMapped: false
      })
    );
    tileMesh.position.set(tile.x, tile.type === "build"
      ? (Number(tile.y) || 0) - tileHeight / 2
      : (Number(tile.y) || 0) + tileHeight / 2 - 0.005, tile.z);
    if (tile.buildStructureId) tileMesh.userData.buildSupportSurface = true;
    tileMesh.renderOrder = 2;
    worldGroup.add(tileMesh);
  }

  for (const ramp of data.ramps || []) {
    makeRamp(ramp);
  }

  for (const bridge of data.bridges || []) {
    makeBox(bridge.w, bridge.thickness, bridge.d, bridge.x, bridge.y + bridge.thickness / 2, bridge.z, 0x7b8792);
    // 橋の縁を少し高くして、立体感を出す。
    if (bridge.w > bridge.d) {
      makeBox(bridge.w, 0.45, 0.18, bridge.x, bridge.y + bridge.thickness + 0.22, bridge.z - bridge.d / 2 + 0.12, 0x56616c);
      makeBox(bridge.w, 0.45, 0.18, bridge.x, bridge.y + bridge.thickness + 0.22, bridge.z + bridge.d / 2 - 0.12, 0x56616c);
    } else {
      makeBox(0.18, 0.45, bridge.d, bridge.x - bridge.w / 2 + 0.12, bridge.y + bridge.thickness + 0.22, bridge.z, 0x56616c);
      makeBox(0.18, 0.45, bridge.d, bridge.x + bridge.w / 2 - 0.12, bridge.y + bridge.thickness + 0.22, bridge.z, 0x56616c);
    }
  }

  // 橋の端を地面まで支える柱。橋が空中に浮いて見えないようにする。
  for (const support of data.bridgeSupports || []) {
    makeBox(support.w, support.h, support.d, support.x, support.h / 2, support.z, 0x626d78);
  }

  makeBox(worldWidth, 3, 1, centerX, 1.5, bounds.minZ - 2, 0x58636e);
  makeBox(worldWidth, 3, 1, centerX, 1.5, bounds.maxZ + 2, 0x58636e);
  makeBox(1, 3, worldDepth, bounds.minX - 2, 1.5, centerZ, 0x58636e);
  makeBox(1, 3, worldDepth, bounds.maxX + 2, 1.5, centerZ, 0x58636e);
  if (Array.isArray(data.payloadPath)) buildPayloadTrackVisual(data.payloadPath);
}
let minimapRespawnMarkers = [];
function addEnemyRespawnMarker(playerId, x, z) {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(z))) return;
  const now = Date.now();
  minimapRespawnMarkers = minimapRespawnMarkers.filter(marker => marker.until > now && marker.playerId !== playerId);
  minimapRespawnMarkers.push({ playerId, x: Number(x), z: Number(z), until: now + 8000 });
}
function updateMinimap() {
  const canvas = document.getElementById("minimapCanvas");
  if (!canvas || !myState || !worldData?.world) return;

  const world = worldData.world;
  const worldWidth = Math.max(1, world.maxX - world.minX);
  const worldDepth = Math.max(1, world.maxZ - world.minZ);
  const minimap = document.getElementById("minimap");
  if (minimap) {
    minimap.style.aspectRatio = `${worldWidth} / ${worldDepth}`;
    // CSSだけのaspect-ratio指定に依存せず、表示枠の実寸もマップ比率に合わせる。
    const minimapWidth = minimap.getBoundingClientRect().width;
    if (minimapWidth > 0) {
      const minimapHeight = Math.max(1, Math.round(minimapWidth * worldDepth / worldWidth));
      if (Math.abs(minimap.getBoundingClientRect().height - minimapHeight) > 1) {
        minimap.style.height = `${minimapHeight}px`;
      }
    }
  }

  // Canvas自体もマップの縦横比に合わせ、実際の地形比率を保つ。
  const canvasWidth = 180;
  const canvasHeight = Math.max(1, Math.round(canvasWidth * worldDepth / worldWidth));
  if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
  if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(9,14,18,.9)";
  ctx.fillRect(0, 0, w, h);

  const mapX = (x) => ((x - world.minX) / (world.maxX - world.minX)) * w;
  const mapZ = (z) => ((z - world.minZ) / (world.maxZ - world.minZ)) * h;

  if (selectedGameMode === "Payload" && Array.isArray(worldData.payloadPath) && worldData.payloadPath.length > 1) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,220,115,.72)";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    worldData.payloadPath.forEach((point, index) => {
      const x = mapX(point[0]);
      const y = mapZ(point[2]);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);

  ctx.fillStyle = "rgba(150,160,170,.38)";
  for (const ramp of worldData.ramps || []) {
    const x = mapX(ramp.x - ramp.w / 2);
    const y = mapZ(ramp.z - ramp.d / 2);
    const rw = (ramp.w / (world.maxX - world.minX)) * w;
    const rh = (ramp.d / (world.maxZ - world.minZ)) * h;
    ctx.fillStyle = "rgba(105,145,170,.42)";
    ctx.fillRect(x, y, rw, rh);
  }

  for (const bridge of worldData.bridges || []) {
    const x = mapX(bridge.x - bridge.w / 2);
    const y = mapZ(bridge.z - bridge.d / 2);
    const bw = (bridge.w / (world.maxX - world.minX)) * w;
    const bh = (bridge.d / (world.maxZ - world.minZ)) * h;
    ctx.fillStyle = "rgba(210,175,100,.48)";
    ctx.fillRect(x, y, bw, bh);
  }

  for (const o of worldData.obstacles || []) {
    const x = mapX(o.x - o.w / 2);
    const y = mapZ(o.z - o.d / 2);
    const ow = (o.w / (world.maxX - world.minX)) * w;
    const oh = (o.d / (world.maxZ - world.minZ)) * h;
    ctx.fillRect(x, y, ow, oh);
  }

  if (selectedGameMode === "Payload" && payloadCartMapState) {
    const cartX = mapX(payloadCartMapState.x);
    const cartZ = mapZ(payloadCartMapState.z);
    ctx.save();
    ctx.translate(cartX, cartZ);
    ctx.rotate(-payloadCartMapState.yaw);
    ctx.fillStyle = "#ffd34f";
    ctx.strokeStyle = "#fff7d1";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6.5, 0);
    ctx.lineTo(0, 8);
    ctx.lineTo(-6.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
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

  // 敵がリスポーンした地点だけを短時間表示する（自分の復帰地点は表示しない）。
  // 敵の復帰地点は敵の通常スポット判定・視界遮蔽とは独立して描画する。
  const markerNow = Date.now();
  minimapRespawnMarkers = minimapRespawnMarkers.filter(marker => marker.until > markerNow);
  for (const marker of minimapRespawnMarkers) {
    ctx.fillStyle = "#ffd34f";
    ctx.strokeStyle = "rgba(255,255,255,.98)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mapX(marker.x), mapZ(marker.z), 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  const observers = [{ x: myState.x, y: myState.y || 0, z: myState.z, yaw, team: myState.team }];
  if (selectedGameMode === "Area" || selectedGameMode === "Payload") {
    for (const obj of remotePlayers.values()) {
      const ally = obj.userData.playerState;
      if (ally && ally.health > 0 && ally.team === myState.team && ally.mode === selectedGameMode) {
        observers.push({ x: obj.position.x, y: obj.position.y, z: obj.position.z, yaw: obj.rotation.y, team: ally.team });
      }
    }
  }

  const raycaster = new THREE.Raycaster();
  for (const obj of remotePlayers.values()) {
    const enemy = obj.userData.playerState;
    if (!enemy || enemy.health <= 0 || enemy.finished) continue;
    const isAlly = (selectedGameMode === "Area" || selectedGameMode === "Payload") && enemy.team === myState.team;

    const ex = Number(enemy.x), ez = Number(enemy.z);
    // 煙幕内で姿が完全に隠れる敵は、ミニマップにも表示しない。
    const hiddenBySmoke = [...smokeCloudMeshes.values()].some((group) => {
      const smoke = group.userData.smoke;
      const radius = Number(smoke?.radius) || 5.2;
      const dx = ex - group.position.x;
      const dy = Number(enemy.y || 0) - group.position.y;
      const dz = ez - group.position.z;
      return Math.hypot(dx, dy, dz) < radius * 0.9;
    });
    if (hiddenBySmoke) continue;

    // 遠距離の敵はミニマップに表示しない。味方表示は従来どおり。
    const enemyDistance = Math.hypot(ex - myState.x, ez - myState.z);
    let spotted = isAlly;
    if (!spotted) {
      for (const observer of observers) {
        const dx = ex - observer.x;
        const dz = ez - observer.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 0.01 || distance > 25) continue;
        const targetYaw = Math.atan2(-dx, -dz);
        const yawDiff = Math.atan2(Math.sin(targetYaw - observer.yaw), Math.cos(targetYaw - observer.yaw));
        if (Math.abs(yawDiff) > Math.PI * 0.24) continue;

        const origin = new THREE.Vector3(observer.x, observer.y + 1.35, observer.z);
        const target = new THREE.Vector3(ex, Number(enemy.y || 0) + 1.0, ez);
        const direction = target.clone().sub(origin);
        const rayDistance = direction.length();
        direction.normalize();
        raycaster.set(origin, direction);
        raycaster.far = Math.max(0, rayDistance - 0.8);
        const blockers = raycaster.intersectObjects(worldGroup.children, true);
        if (!blockers.length) {
          spotted = true;
          break;
        }
      }
    }

    if (!spotted) continue;
    const exMap = mapX(ex);
    const ezMap = mapZ(ez);
    ctx.fillStyle = (selectedGameMode === "Area" || selectedGameMode === "Payload") ? (enemy.team === "blue" ? "#4aa5ff" : "#ff5c5c") : "#ff4d4d";
    ctx.beginPath();
    ctx.arc(exMap, ezMap, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

let lastLaserSightUpdate = 0;
function updateLaserSight() {
  const enabled = joined && ATTACHMENT_WEAPONS.includes(selectedWeapon) && attachmentSettings[selectedWeapon] === "laser";
  if (!enabled) {
    if (laserSightLine) laserSightLine.visible = false;
    return;
  }
  if (performance.now() - lastLaserSightUpdate < 33) return;
  lastLaserSightUpdate = performance.now();
  if (!laserSightLine) {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -60)]);
    const material = new THREE.LineBasicMaterial({
      color: 0xff0000,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
      depthWrite: false,
      linewidth: 3
    });
    laserSightLine = new THREE.Line(geometry, material);
    laserSightLine.frustumCulled = false;
    laserSightLine.renderOrder = 1000;
    scene.add(laserSightLine);
  }
  const material = laserSightLine.material;
  material.color.setHex(0xff0000);
  material.opacity = 1.0;
  material.depthTest = false;
  material.depthWrite = false;
  material.needsUpdate = true;
  const start = new THREE.Vector3(0, 0, -0.35).applyMatrix4(camera.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const end = start.clone().addScaledVector(direction, 60);
  laserSightLine.geometry.setFromPoints([start, end]);
  laserSightLine.visible = true;
}

function refreshWeaponSightControl() {
  const sightSelect = document.getElementById("weaponSightSelect");
  if (!sightSelect) return;
  const supported = ATTACHMENT_WEAPONS.includes(selectedWeapon);
  sightSelect.disabled = !supported;
  sightSelect.value = supported ? (attachmentSettings[selectedWeapon] || "none") : "none";
  const status = document.getElementById("weaponSightStatus");
  if (status) {
    status.textContent = supported
      ? "現在装備中：" + weaponDisplayName(selectedWeapon) + "。この武器のサイトを設定します。"
      : weaponDisplayName(selectedWeapon) + "はサイト設定に対応していません。サブマシンガン、アサルトライフル、マークスマンで設定できます。";
  }
}

function initWeaponAttachmentControls() {
  const sightSelect = document.getElementById("weaponSightSelect");
  if (!sightSelect) return;
  sightSelect.addEventListener("change", () => {
    if (!ATTACHMENT_WEAPONS.includes(selectedWeapon)) {
      refreshWeaponSightControl();
      return;
    }
    attachmentSettings[selectedWeapon] = sightSelect.value === "laser" ? "laser" : "none";
    try { localStorage.setItem("fps_weapon_attachments", JSON.stringify(attachmentSettings)); } catch {}
    updateLaserSight();
    refreshWeaponSightControl();
    showMessage(weaponDisplayName(selectedWeapon) + "のサイトを" + (attachmentSettings[selectedWeapon] === "laser" ? "レーザーサイト" : "なし") + "に設定しました");
  });
  refreshWeaponSightControl();
}
initWeaponAttachmentControls();

function createWeaponMesh(weapon) {
  const group = new THREE.Group();

  if (weapon === "sword") {
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.34, 8), new THREE.MeshStandardMaterial({ color: 0x49352b, roughness: 0.82 }));
    grip.position.y = -0.22;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.07, 0.1), new THREE.MeshStandardMaterial({ color: 0xb78b42, metalness: 0.72, roughness: 0.28 }));
    guard.position.y = -0.02;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.08, 0.055), new THREE.MeshStandardMaterial({ color: 0xdde8f2, metalness: 0.88, roughness: 0.2 }));
    blade.position.y = 0.55;
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.025, 1.02, 0.018), new THREE.MeshBasicMaterial({ color: 0x75d9ff }));
    edge.position.set(0.072, 0.55, -0.006);
    group.add(grip, guard, blade, edge);
    group.position.set(0.34, 1.02, -0.22);
    group.rotation.x = -0.08;
    return group;
  }
  if (weapon === "pickaxe") {
    const wood = new THREE.MeshStandardMaterial({ color: 0x76502d, roughness: 0.85 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xb8c1c8, metalness: 0.72, roughness: 0.32 });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.048, 0.9, 8), wood);
    handle.position.set(0, -0.02, -0.02);
    handle.rotation.z = -0.2;
    handle.rotation.x = 0.16;
    group.add(handle);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.13, 0.16), steel);
    head.position.set(0.02, 0.36, -0.08);
    head.rotation.z = -0.13;
    group.add(head);
    const point = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.28, 6), steel);
    point.position.set(-0.34, 0.36, -0.08);
    point.rotation.z = Math.PI / 2;
    group.add(point);
    group.position.set(0.34, 1.02, -0.22);
    group.rotation.x = -0.08;
    return group;
  }

  if (weapon === "grappler") {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 0.34, 12), new THREE.MeshStandardMaterial({ color: 0x2c343d, metalness: 0.55, roughness: 0.38 }));
    body.rotation.x = Math.PI / 2;
    group.add(body);
    const cup = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.045, 8, 18), new THREE.MeshStandardMaterial({ color: 0x40d9e8, metalness: 0.25, roughness: 0.28, emissive: 0x12434a }));
    cup.position.z = -0.2;
    group.add(cup);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 0.18), new THREE.MeshStandardMaterial({ color: 0x48515d, metalness: 0.4, roughness: 0.5 }));
    grip.position.set(0, -0.25, 0.05);
    group.add(grip);
    group.position.set(0.34, 1.02, -0.22);
    group.rotation.x = -0.08;
    return group;
  }

  if (weapon === "grappler") { const grip=new THREE.Mesh(new THREE.CylinderGeometry(.06,.07,.55,10),new THREE.MeshStandardMaterial({color:0x394653,metalness:.6}));grip.rotation.x=Math.PI/2;group.add(grip);const cup=new THREE.Mesh(new THREE.CylinderGeometry(.19,.13,.16,16),new THREE.MeshStandardMaterial({color:0xe04d43}));cup.rotation.x=Math.PI/2;cup.position.z=-.35;group.add(cup);group.position.set(.34,1.02,-.22);group.rotation.x=-.08;return group; }
  if (weapon === "rocketLauncher") {
    const tubeMaterial = new THREE.MeshStandardMaterial({ color: 0x3b4148, metalness: 0.68, roughness: 0.32 });
    const muzzleMaterial = new THREE.MeshStandardMaterial({ color: 0xd85a35, metalness: 0.35, roughness: 0.42, emissive: 0x5a1b0c, emissiveIntensity: 0.35 });
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.92, 12), tubeMaterial);
    tube.rotation.x = Math.PI / 2;
    group.add(tube);
    const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.035, 8, 16), muzzleMaterial);
    muzzle.position.z = -0.46;
    group.add(muzzle);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.22), new THREE.MeshStandardMaterial({ color: 0xb7bdc3, metalness: 0.7 }));
    sight.position.set(0, 0.2, -0.05);
    group.add(sight);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.28, 0.18), tubeMaterial);
    grip.position.set(0, -0.24, 0.08);
    group.add(grip);
    group.position.set(0.34, 1.02, -0.22);
    group.rotation.x = -0.08;
    return group;
  }

  if (weapon === "smoke" || weapon === "grenadeLauncher" || weapon === "shockwaveLauncher") {
    const grenadeMaterial = new THREE.MeshStandardMaterial({ color: weapon === "shockwaveLauncher" ? 0x39b9d8 : weapon === "grenadeLauncher" ? 0x4d4a3c : 0x67716e, roughness: 0.62, metalness: 0.18, emissive: weapon === "shockwaveLauncher" ? 0x123d4b : 0x000000, emissiveIntensity: weapon === "shockwaveLauncher" ? 0.6 : 0 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), grenadeMaterial);
    group.add(body);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.025, 6, 16), new THREE.MeshStandardMaterial({ color: 0x292f2d, roughness: 0.7 }));
    band.rotation.x = Math.PI / 2;
    group.add(band);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.08, 8), new THREE.MeshStandardMaterial({ color: 0xaab0a8, metalness: 0.45, roughness: 0.4 }));
    cap.position.y = 0.2;
    group.add(cap);
    group.position.set(0.34, 1.02, -0.22);
    group.rotation.x = -0.08;
    return group;
  }

  const material = new THREE.MeshStandardMaterial({
    color: weapon === "shotgun" ? 0x9a9a9a : weapon === "rifle" ? 0x4d6b4f
      : weapon === "smg" ? 0x6b6650 : weapon === "marksman" ? 0x647b89
      : weapon === "sniper" ? 0x7b6247 : 0x303030,
    roughness: .7,
    metalness: .25
  });

  const barrelLength = weapon === "sniper" ? 1.0 : weapon === "marksman" ? .82
    : weapon === "shotgun" ? .55 : weapon === "rifle" ? .7 : weapon === "smg" ? .48 : .42;
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(.10, .10, barrelLength), material);
  barrel.position.z = -barrelLength / 2;
  group.add(barrel);

  const stock = new THREE.Mesh(
    new THREE.BoxGeometry(["rifle", "smg"].includes(weapon) ? .16 : .13, .16, .28),
    material
  );
  stock.position.z = .16;
  group.add(stock);

  if (weapon === "shotgun") {
    const pump = new THREE.Mesh(new THREE.BoxGeometry(.16, .12, .24), material);
    pump.position.set(0, -.07, -.12);
    group.add(pump);
  }

  if (weapon === "marksman" || weapon === "sniper") {
    const scope = new THREE.Mesh(
      new THREE.CylinderGeometry(.055, .055, weapon === "sniper" ? .42 : .32, 10),
      new THREE.MeshStandardMaterial({ color: 0x202020, metalness: .35, roughness: .4 })
    );
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, .095, -.18);
    group.add(scope);
  }

  group.position.set(.34, 1.02, -.22);
  group.rotation.x = -.08;
  return group;
}

function refreshLocalWeaponViewModel() {
  const shouldShow = joined && ["pickaxe", "sword", "smoke", "grenadeLauncher", "rocketLauncher", "shockwaveLauncher", "grappler"].includes(selectedWeapon);
  if (!shouldShow) {
    if (localWeaponViewModel) camera.remove(localWeaponViewModel);
    localWeaponViewModel = null;
    localWeaponViewModelType = "";
    return;
  }
  if (localWeaponViewModel && localWeaponViewModelType === selectedWeapon) return;
  if (localWeaponViewModel) camera.remove(localWeaponViewModel);
  localWeaponViewModel = createWeaponMesh(selectedWeapon);
  localWeaponViewModel.position.set(0.38, -0.34, -0.62);
  localWeaponViewModel.rotation.set(0.16, -0.18, -0.28);
  localWeaponViewModel.scale.setScalar(selectedWeapon === "pickaxe" ? 0.72 : 0.88);
  camera.add(localWeaponViewModel);
  localWeaponViewModelType = selectedWeapon;
}

function startLocalWeaponAction(weapon) {
  if (!["pickaxe", "sword", "swordLeap", "smoke", "grenadeLauncher", "shockwaveLauncher", "grappler"].includes(weapon)) return;
  localWeaponActionType = weapon;
  localWeaponActionStartedAt = performance.now();
}

function pickaxeSwingAngle(elapsedSeconds) {
  if (elapsedSeconds < 0 || elapsedSeconds >= 0.38) return 0;
  if (elapsedSeconds < 0.08) return -1.15 * (elapsedSeconds / 0.08);
  if (elapsedSeconds < 0.23) return -1.15 + 2.25 * ((elapsedSeconds - 0.08) / 0.15);
  return 1.1 * (1 - (elapsedSeconds - 0.23) / 0.15);
}

function animateLocalWeaponViewModel(now) {
  if (!localWeaponViewModel) return;
  const elapsed = (now - localWeaponActionStartedAt) / 1000;
  if (selectedWeapon === "sword" && swordGuardActive) {
    // ガード中は剣を顔の前に立て、画面中央寄りに構える。
    localWeaponViewModel.position.set(0.16, 0.02, -0.5);
    localWeaponViewModel.rotation.set(-0.12, -0.28, -0.32);
  } else if (localWeaponActionType === "sword" && elapsed >= 0 && elapsed < 0.48) {
    // 振り始め→斬り下ろし→短い戻しの一振りにし、直線的な回転や急な巻き戻りを抑える。
    const progress = elapsed / 0.48;
    const windup = progress < 0.18 ? progress / 0.18 : 1;
    const slash = progress >= 0.18 && progress < 0.72
      ? Math.sin(((progress - 0.18) / 0.54) * Math.PI * 0.5)
      : (progress >= 0.72 ? 1 : 0);
    const recovery = progress >= 0.72 ? 1 - (progress - 0.72) / 0.28 : 0;
    localWeaponViewModel.rotation.set(
      0.16 - windup * 0.22 - slash * 0.78 + recovery * 0.78 + recovery * 0.22,
      -0.18,
      -0.28 - windup * 0.42 + slash * 1.52 - recovery * 1.52 + recovery * 0.42
    );
    localWeaponViewModel.position.set(
      0.38 + windup * 0.025 - slash * 0.035 + recovery * 0.035 - recovery * 0.025,
      -0.34 + slash * 0.10 - recovery * 0.10,
      -0.62 - windup * 0.035 + slash * 0.055 - recovery * 0.055 + recovery * 0.035
    );
  } else if (localWeaponActionType === "swordLeap" && elapsed >= 0 && elapsed < 0.95) {
    const progress = elapsed / 0.95;
    localWeaponViewModel.rotation.set(-0.9 + progress * 1.8, -0.18, -0.28 + Math.sin(progress * Math.PI) * 0.7);
    localWeaponViewModel.position.set(0.38, -0.34 + Math.sin(progress * Math.PI) * 0.12, -0.62);
  } else if (localWeaponActionType === "pickaxe" && elapsed >= 0 && elapsed < 0.38) {
    const angle = pickaxeSwingAngle(elapsed);
    localWeaponViewModel.rotation.x = 0.16 + angle * 0.64;
    localWeaponViewModel.rotation.z = -0.28 - angle * 0.46;
    localWeaponViewModel.position.y = -0.34 - Math.max(0, angle) * 0.035;
  } else if (["smoke", "grenadeLauncher", "shockwaveLauncher", "grappler"].includes(localWeaponActionType) && elapsed >= 0 && elapsed < 0.26) {
    const progress = elapsed / 0.26;
    localWeaponViewModel.position.set(0.38 + 0.12 * progress, -0.34 + 0.07 * Math.sin(progress * Math.PI), -0.62 - 0.1 * progress);
    localWeaponViewModel.rotation.z = -0.28 - progress * 0.48;
  } else {
    localWeaponViewModel.rotation.set(0.16, -0.18, -0.28);
    localWeaponViewModel.position.set(0.38, -0.34, -0.62);
  }
}

function createSmokeProjectileVisual(data) {
  if (!data?.id) return;
  let mesh = smokeProjectileMeshes.get(data.id);
  const position = new THREE.Vector3(Number(data.x) || 0, Number(data.y) || 0, Number(data.z) || 0);
  if (!mesh) {
    const material = new THREE.MeshStandardMaterial({ color: 0x76817d, roughness: 0.58, metalness: 0.18 });
    mesh = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 10), material);
    mesh.userData.targetPosition = position.clone();
    mesh.userData.expiresAt = Number(data.expiresAt) || Date.now() + Number(data.remainingMs || 4500);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.022, 5, 14), new THREE.MeshStandardMaterial({ color: 0x292f2d, roughness: 0.72 }));
    band.rotation.x = Math.PI / 2;
    mesh.add(band);
    mesh.position.copy(position);
    scene.add(mesh);
    smokeProjectileMeshes.set(data.id, mesh);
  } else {
    mesh.userData.targetPosition.copy(position);
  }
}

function createGrenadeProjectileVisual(data) {
  if (!data?.id) return;
  let mesh = grenadeProjectileMeshes.get(data.id);
  const position = new THREE.Vector3(Number(data.x) || 0, Number(data.y) || 0, Number(data.z) || 0);
  if (!mesh) {
    const isShockwave = data.type === "shockwave";
    const isGrapple = data.type === "grapple";
    const isTornado = data.type === "tornado";
    const isRocket = data.type === "rocket";
    const isForming = data.type === "forming";
    const material = new THREE.MeshStandardMaterial({
      color: isTornado ? 0x8cecff : isGrapple ? 0x37d9e8 : isShockwave ? 0x4bdcff : isRocket ? 0xff542e : isForming ? 0xb66cff : 0x8b7a43,
      roughness: 0.35, metalness: 0.2, transparent: isTornado, opacity: isTornado ? 0.68 : 1,
      emissive: isTornado ? 0x1b8ab0 : isGrapple ? 0x12545c : isShockwave ? 0x145b78 : isRocket ? 0x9f210e : isForming ? 0x58208f : 0x000000,
      emissiveIntensity: isTornado ? 1.1 : isGrapple || isShockwave ? 0.8 : isRocket || isForming ? 1.0 : 0
    });
    mesh = new THREE.Mesh(
      isTornado ? new THREE.CylinderGeometry(0.075, 0.075, 14, 10, 1, false) :
      isGrapple ? new THREE.CylinderGeometry(0.1, 0.17, 0.24, 12) : new THREE.SphereGeometry(isRocket ? 0.38 : isForming ? 0.25 : 0.16, 14, 10),
      material
    );
    if (isTornado) {
      mesh.scale.set(5 / 0.075, 1, 5 / 0.075);
      // 棒の先端を明るくし、上下方向と飛行方向を視認しやすくする。
      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      tip.position.y = 7;
      mesh.add(tip);
      const tail = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x168bb8 })
      );
      tail.position.y = -7;
      mesh.add(tail);
    }
    if (isGrapple) {
      mesh.rotation.x = Math.PI / 2;
      const cup = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 7, 16), new THREE.MeshStandardMaterial({ color: 0x4ce7f0, metalness: 0.25, roughness: 0.25 }));
      cup.position.z = -0.12;
      mesh.add(cup);
      const tetherGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const tether = new THREE.Line(tetherGeometry, new THREE.LineBasicMaterial({ color: 0x48dce8, transparent: true, opacity: 0.9 }));
      tether.userData.ownerId = data.ownerId;
      mesh.userData.tether = tether;
      scene.add(tether);
    }
    mesh.userData.ownerId = data.ownerId;
    mesh.userData.projectileType = data.type;
    mesh.userData.targetPosition = position.clone();
    mesh.userData.expiresAt = Number(data.expiresAt) || Date.now() + Number(data.remainingMs || 4500);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.024, 5, 14), new THREE.MeshStandardMaterial({ color: 0x2d2b22, roughness: 0.72 }));
    band.rotation.x = Math.PI / 2;
    mesh.add(band);
    mesh.position.copy(position);
    scene.add(mesh);
    grenadeProjectileMeshes.set(data.id, mesh);
  } else mesh.userData.targetPosition.copy(position);
  if (data.type === "tornado") {
    mesh.quaternion.identity();
    mesh.rotation.set(0, 0.22, 0);
  }
}
function removeGrenadeProjectileVisual(id) {
  const mesh = grenadeProjectileMeshes.get(id);
  if (!mesh) return;
  scene.remove(mesh);
  if (mesh.userData.tether) {
    scene.remove(mesh.userData.tether);
    mesh.userData.tether.geometry.dispose();
    mesh.userData.tether.material.dispose();
  }
  mesh.traverse(part => {
    if (part.material) (Array.isArray(part.material) ? part.material : [part.material]).forEach(m => m?.dispose?.());
    if (part.geometry && part !== mesh) part.geometry.dispose();
  });
  mesh.geometry?.dispose();
  mesh.material?.dispose();
  grenadeProjectileMeshes.delete(id);
}
function createSkyfallImpactVisual(data) {
  if (!data?.id) return;
  const existing = skyfallImpactMeshes.get(data.id);
  if (existing) {
    existing.userData.expiresAt = Number(data.expiresAt) || Date.now() + 1800;
    existing.userData.targeting = Boolean(data.targeting);
    existing.material.opacity = data.targeting ? 0.24 : 0.3;
    return;
  }
  const radius = Math.max(0.5, Number(data.radius) || 20);
  const geometry = new THREE.CircleGeometry(radius, 48);
  const material = new THREE.MeshBasicMaterial({
    color: 0xff2020, transparent: true, opacity: 0.3,
    side: THREE.DoubleSide, depthWrite: false
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(Number(data.x) || 0, (Number(data.y) || 0) + 0.035, Number(data.z) || 0);
  mesh.userData.expiresAt = Number(data.expiresAt) || Date.now() + 8000;
  mesh.userData.targeting = Boolean(data.targeting);
  if (mesh.userData.targeting) material.opacity = 0.24;
  scene.add(mesh);
  skyfallImpactMeshes.set(data.id, mesh);
}

function createShockwaveBurstVisual(data) {
  if (!data?.id) return;
  const radius = Math.max(0.1, Number(data.radius) || 5.2);
  const geometry = new THREE.TorusGeometry(radius * 0.72, 0.16, 8, 48);
  const material = new THREE.MeshBasicMaterial({ color: 0x55ddff, transparent: true, opacity: 0.82, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(Number(data.x) || 0, (Number(data.y) || 0) + 0.18, Number(data.z) || 0);
  mesh.userData.expiresAt = Number(data.expiresAt) || Date.now() + 520;
  mesh.userData.maxScale = 1.38;
  scene.add(mesh);
  grenadeExplosionMeshes.set(data.id, mesh);
}
function createGrenadeExplosionVisual(data) {
  if (!data?.id) return;
  const geometry = new THREE.SphereGeometry(Math.max(0.1, Number(data.radius) || 5.2), 18, 12);
  const material = new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 0.38, wireframe: true, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(Number(data.x) || 0, Number(data.y) || 0, Number(data.z) || 0);
  mesh.userData.expiresAt = Number(data.expiresAt) || Date.now() + 420;
  mesh.userData.maxScale = 1;
  scene.add(mesh);
  grenadeExplosionMeshes.set(data.id, mesh);
}
function resetGrenadeVisuals() {
  for (const id of [...grenadeProjectileMeshes.keys()]) removeGrenadeProjectileVisual(id);
  for (const [id, mesh] of [...grenadeExplosionMeshes]) {
    scene.remove(mesh); mesh.geometry?.dispose(); mesh.material?.dispose(); grenadeExplosionMeshes.delete(id);
  }
}

function removeSmokeProjectileVisual(id) {
  const mesh = smokeProjectileMeshes.get(id);
  if (!mesh) return;
  scene.remove(mesh);
  mesh.traverse((part) => {
    if (part !== mesh) {
      const material = Array.isArray(part.material) ? part.material : [part.material];
      material.forEach((m) => m?.dispose?.());
    }
    if (part.geometry && part !== mesh) part.geometry.dispose();
  });
  mesh.geometry?.dispose();
  mesh.material?.dispose();
  smokeProjectileMeshes.delete(id);
}

function createSmokeCloudVisual(data) {
  if (!data?.id) return;
  removeSmokeCloudVisual(data.id);
  const radius = Math.max(1, Number(data.radius) || 5.2);
  const group = new THREE.Group();
  group.position.set(Number(data.x) || 0, Number(data.y) || 0, Number(data.z) || 0);
  group.userData.smoke = {
    radius,
    expiresAt: Number(data.expiresAt) || Date.now() + Number(data.remainingMs || 8500)
  };
  const puffCount = 18;
  for (let i = 0; i < puffCount; i++) {
    let dx = Math.random() * 2 - 1;
    let dy = Math.random() * 2 - 1;
    let dz = Math.random() * 2 - 1;
    let length = Math.hypot(dx, dy, dz) || 1;
    dx /= length; dy /= length; dz /= length;
    const spread = radius * (0.12 + Math.random() * 0.48);
    const size = radius * (0.28 + Math.random() * 0.18);
    const material = new THREE.MeshBasicMaterial({
      color: i % 3 === 0 ? 0x858c90 : 0xa3a8ab,
      transparent: true,
      opacity: 0.16 + Math.random() * 0.07,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const puff = new THREE.Mesh(smokePuffGeometry, material);
    puff.position.set(dx * spread, dy * spread, dz * spread);
    puff.scale.set(size, size * (0.72 + Math.random() * 0.28), size);
    puff.renderOrder = 4;
    puff.userData.baseOpacity = material.opacity;
    group.add(puff);
  }
  scene.add(group);
  smokeCloudMeshes.set(data.id, group);
}

function removeSmokeCloudVisual(id) {
  const group = smokeCloudMeshes.get(id);
  if (!group) return;
  scene.remove(group);
  group.traverse((part) => {
    if (part.material) {
      const materials = Array.isArray(part.material) ? part.material : [part.material];
      for (const material of materials) material?.dispose?.();
    }
  });
  smokeCloudMeshes.delete(id);
}

function resetSmokeVisuals() {
  for (const id of [...smokeProjectileMeshes.keys()]) removeSmokeProjectileVisual(id);
  for (const id of [...smokeCloudMeshes.keys()]) removeSmokeCloudVisual(id);
  smokeScreenOverlay.style.display = "none";
}

function startRemoteWeaponAction(event) {
  const obj = remotePlayers.get(event?.id);
  if (!obj) return;
  obj.userData.weaponActionStartedAt = performance.now();
  obj.userData.weaponActionType = event.action === "leap" ? "swordLeap" : event.weapon;
}

const activeWeaponBeams = new Map();
const weaponBeamMeshes = new Map();

function setWeaponBeam(data = {}) {
  if (!data.id) return;
  if (data.active && ["flamethrower", "laserBeam", "freezeCannon"].includes(data.weapon)) {
    // Remote playerのstate更新より先にbeamイベントが届いても描画状態を保持する。
    activeWeaponBeams.set(data.id, { ...data });
  } else {
    activeWeaponBeams.delete(data.id);
  }
}

function removeWeaponBeamVisual(id) {
  const beam = weaponBeamMeshes.get(id);
  if (!beam) return;
  scene.remove(beam);
  beam.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
      else child.material.dispose();
    }
  });
  weaponBeamMeshes.delete(id);
}

function updateWeaponBeamVisuals() {
  for (const [id, beamData] of activeWeaponBeams) {
    const weapon = beamData.weapon;
    let start, direction, playerX, playerY, playerZ, yawValue;
    if (id === myId) {
      if (!joined || !camera) continue;
      start = camera.getWorldPosition(new THREE.Vector3());
      direction = camera.getWorldDirection(new THREE.Vector3());
      // 一人称視点では銃口付近から細く描画し、画面手前でビームが太く見えるのを防ぐ。
      if (weapon === "laserBeam") {
        const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const cameraDown = new THREE.Vector3(0, -1, 0).applyQuaternion(camera.quaternion);
        start.addScaledVector(direction, 0.9).addScaledVector(cameraRight, 0.22).addScaledVector(cameraDown, 0.16);
      } else {
        start.addScaledVector(direction, 0.7);
      }
      playerX = myState?.x ?? start.x;
      playerY = myState?.y ?? start.y - 1.3;
      playerZ = myState?.z ?? start.z;
      yawValue = yaw;
    } else {
      const playerObject = remotePlayers.get(id);
      const player = playerObject?.userData.playerState;
      playerX = Number(playerObject?.position.x ?? beamData.x);
      playerY = Number(playerObject?.position.y ?? beamData.y ?? 0);
      playerZ = Number(playerObject?.position.z ?? beamData.z);
      yawValue = Number(player?.yaw ?? beamData.yaw);
      const pitchValue = Number(player?.pitch ?? beamData.pitch);
      if (![playerX, playerY, playerZ, yawValue, pitchValue].every(Number.isFinite)) continue;
      start = new THREE.Vector3(playerX, playerY + 1.28, playerZ);
      direction = directionFromAngles(yawValue, pitchValue);
    }
    const isFan = weapon === "flamethrower" || weapon === "freezeCannon";
    const range = weapon === "laserBeam" ? 100 : weapon === "flamethrower" ? 18 : 10.5;
    const color = weapon === "flamethrower" ? 0xff6a18 : weapon === "laserBeam" ? 0xff3030 : 0x74dfff;
    let beam = weaponBeamMeshes.get(id);
    if (isFan) {
      if (!beam || beam.userData.weapon !== weapon || !beam.userData.groundFan) {
        removeWeaponBeamVisual(id);
        const halfAngle = THREE.MathUtils.degToRad(45);
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.absarc(0, 0, range, -Math.PI / 2 - halfAngle, -Math.PI / 2 + halfAngle, false);
        shape.lineTo(0, 0);
        const geometry = new THREE.ShapeGeometry(shape, 48);
        const material = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: weapon === "flamethrower" ? 0.28 : 0.24,
          depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
        });
        beam = new THREE.Group();
        const fill = new THREE.Mesh(geometry, material);
        fill.renderOrder = 30;
        beam.add(fill);
        const edgePoints = [new THREE.Vector3(0, 0, 0)];
        const arcSegments = 48;
        for (let i = 0; i <= arcSegments; i++) {
          const angle = -Math.PI / 2 - halfAngle + (2 * halfAngle * i / arcSegments);
          edgePoints.push(new THREE.Vector3(Math.cos(angle) * range, Math.sin(angle) * range, 0));
        }
        const outlineGeometry = new THREE.BufferGeometry().setFromPoints(edgePoints);
        const outline = new THREE.Line(outlineGeometry, new THREE.LineBasicMaterial({
          color, transparent: true, opacity: 0.98, depthTest: false, depthWrite: false
        }));
        outline.renderOrder = 31;
        beam.add(outline);
        beam.userData.weapon = weapon;
        beam.userData.groundFan = true;
        scene.add(beam);
        weaponBeamMeshes.set(id, beam);
      }
      // ShapeGeometryを地面へ寝かせ、照準方向に合わせた扇形を足元から表示する。
      beam.position.set(playerX, playerY + 0.055, playerZ);
      beam.rotation.order = "YXZ";
      beam.rotation.set(Math.PI / 2, yawValue, 0);
      beam.scale.set(1, 1, 1);
    } else {
      if (!beam || beam.userData.weapon !== weapon || beam.userData.groundFan) {
        removeWeaponBeamVisual(id);
        const radius = weapon === "laserBeam" ? 0.044 : 0.075;
        beam = new THREE.Mesh(
          new THREE.CylinderGeometry(radius * 0.72, radius, 1, 12, 1, false),
          new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: weapon === "laserBeam" ? 0.72 : 0.94,
            depthTest: true, depthWrite: false,
            blending: THREE.AdditiveBlending, side: THREE.DoubleSide
          })
        );
        beam.userData.weapon = weapon;
        beam.renderOrder = 30;
        scene.add(beam);
        weaponBeamMeshes.set(id, beam);
      }
      const end = start.clone().addScaledVector(direction, range);
      const delta = end.sub(start);
      beam.position.copy(start).addScaledVector(delta, 0.5);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize());
      beam.scale.set(1, delta.length(), 1);
    }
  }
  for (const id of [...weaponBeamMeshes.keys()]) {
    if (!activeWeaponBeams.has(id)) removeWeaponBeamVisual(id);
  }
}

function updateSmokeVisuals(now, dt) {
  animateLocalWeaponViewModel(now);
  updateWeaponBeamVisuals();
  for (const [id, mesh] of [...grenadeProjectileMeshes]) {
    if (Date.now() >= Number(mesh.userData.expiresAt || Infinity)) { removeGrenadeProjectileVisual(id); continue; }
    if (mesh.userData.targetPosition) mesh.position.lerp(mesh.userData.targetPosition, 1 - Math.exp(-24 * dt));
  }
  for (const [id, mesh] of [...skyfallImpactMeshes]) {
    const remaining = Number(mesh.userData.expiresAt || 0) - Date.now();
    if (remaining <= 0) {
      scene.remove(mesh); mesh.geometry?.dispose(); mesh.material?.dispose();
      skyfallImpactMeshes.delete(id);
      continue;
    }
    mesh.material.opacity = 0.3 * Math.min(1, remaining / 450);
  }
  for (const [id, mesh] of [...grenadeExplosionMeshes]) {
    const remaining = Number(mesh.userData.expiresAt || 0) - Date.now();
    if (remaining <= 0) { scene.remove(mesh); mesh.geometry?.dispose(); mesh.material?.dispose(); grenadeExplosionMeshes.delete(id); continue; }
    mesh.material.opacity = Math.min(0.38, remaining / 420 * 0.38);
    const duration = mesh.userData.maxScale > 1 ? 520 : 420;
    const scale = 1 + (1 - remaining / duration) * ((mesh.userData.maxScale || 1) - 1);
    mesh.scale.setScalar(scale);
  }
  for (const [id, mesh] of [...smokeProjectileMeshes]) {
    if (Date.now() >= Number(mesh.userData.expiresAt || Infinity)) {
      removeSmokeProjectileVisual(id);
      continue;
    }
    if (mesh.userData.targetPosition) mesh.position.lerp(mesh.userData.targetPosition, 1 - Math.exp(-24 * dt));
  }

  const activeClouds = [];
  let overlayStrength = 0;
  const nowMs = Date.now();
  for (const [id, group] of [...smokeCloudMeshes]) {
    const smoke = group.userData.smoke;
    const remaining = Number(smoke?.expiresAt || 0) - nowMs;
    if (remaining <= 0) {
      removeSmokeCloudVisual(id);
      continue;
    }
    const fade = Math.min(1, remaining / 1500);
    for (const puff of group.children) {
      if (puff.material && Number.isFinite(puff.userData.baseOpacity)) puff.material.opacity = puff.userData.baseOpacity * fade;
    }
    const radius = Number(smoke.radius) || 5.2;
    const cameraDistance = camera.position.distanceTo(group.position);
    if (cameraDistance < radius * 0.88) {
      overlayStrength = Math.max(overlayStrength, (1 - cameraDistance / (radius * 0.88)) * 0.38 + 0.45);
    }
    activeClouds.push(group);
  }
  smokeScreenOverlay.style.display = overlayStrength > 0 ? "block" : "none";
  smokeScreenOverlay.style.opacity = String(Math.min(0.9, overlayStrength));

  for (const obj of remotePlayers.values()) {
    const player = obj.userData.playerState;
    if (!player) continue;
    const actionElapsed = (now - Number(obj.userData.weaponActionStartedAt || -Infinity)) / 1000;
    const weaponMesh = obj.userData.weaponMesh;
    const rightArm = obj.userData.rightArm;
    if (player.swordGuarding && obj.userData.weaponType === "sword") {
      // 他プレイヤーにも、顔の前で剣を立てるガード姿勢を表示する。
      if (weaponMesh) {
        weaponMesh.position.set(0.28, 1.28, -0.28);
        weaponMesh.rotation.set(-0.12, 0, -0.38);
      }
      if (rightArm) rightArm.rotation.set(-0.82, 0, 0.22);
    } else if (obj.userData.weaponActionType === "sword" && obj.userData.weaponType === "sword" && actionElapsed >= 0 && actionElapsed < 0.48) {
      const progress = actionElapsed / 0.48;
      const windup = progress < 0.18 ? progress / 0.18 : 1;
      const slash = progress >= 0.18 && progress < 0.72
        ? Math.sin(((progress - 0.18) / 0.54) * Math.PI * 0.5)
        : (progress >= 0.72 ? 1 : 0);
      const recovery = progress >= 0.72 ? 1 - (progress - 0.72) / 0.28 : 0;
      if (weaponMesh) {
        weaponMesh.position.set(0.34 + windup * 0.02 - slash * 0.025 + recovery * 0.005, 1.02 + slash * 0.10 - recovery * 0.10, -0.22);
        weaponMesh.rotation.set(-0.08 - windup * 0.18 - slash * 0.72 + recovery * 0.72 + recovery * 0.18, 0,
          -0.18 - windup * 0.35 + slash * 1.45 - recovery * 1.45 + recovery * 0.35);
      }
      if (rightArm) rightArm.rotation.set(-windup * 0.12 - slash * 0.62 + recovery * 0.62 + recovery * 0.12, 0,
        0.08 - windup * 0.08 - slash * 0.28 + recovery * 0.28 + recovery * 0.08);
    } else if (obj.userData.weaponActionType === "swordLeap" && obj.userData.weaponType === "sword" && actionElapsed >= 0 && actionElapsed < 0.95) {
      const progress = actionElapsed / 0.95;
      if (weaponMesh) {
        weaponMesh.position.set(0.34, 1.02 + Math.sin(progress * Math.PI) * 0.12, -0.22);
        weaponMesh.rotation.set(-0.9 + progress * 1.8, 0, Math.sin(progress * Math.PI) * 0.7);
      }
      if (rightArm) rightArm.rotation.set(-0.7 + progress * 1.4, 0, 0.08);
    } else if (obj.userData.weaponActionType === "pickaxe" && obj.userData.weaponType === "pickaxe" && actionElapsed >= 0 && actionElapsed < 0.38) {
      const angle = pickaxeSwingAngle(actionElapsed);
      if (weaponMesh) weaponMesh.rotation.set(-0.08 + angle * 0.55, 0, angle * 0.62);
      if (rightArm) rightArm.rotation.set(angle * 0.48, 0, 0.08 - angle * 0.24);
    } else if (["smoke", "grenadeLauncher", "shockwaveLauncher", "grappler"].includes(obj.userData.weaponActionType) && obj.userData.weaponType === obj.userData.weaponActionType && actionElapsed >= 0 && actionElapsed < 0.26) {
      const progress = actionElapsed / 0.26;
      if (weaponMesh) {
        weaponMesh.position.set(0.34 + 0.1 * progress, 1.02 + 0.05 * Math.sin(progress * Math.PI), -0.22 - 0.1 * progress);
        weaponMesh.rotation.set(-0.08, 0, -0.4 * progress);
      }
    } else {
      if (weaponMesh) {
        weaponMesh.position.set(0.34, 1.02, -0.22);
        weaponMesh.rotation.set(-0.08, 0, 0);
      }
      if (rightArm) rightArm.rotation.set(0, 0.08, 0);
    }

    obj.visible = Number(player.health) > 0;
    // Fade body parts inside smoke individually. Hide the name when more than half
    // of the player's body meshes are obscured by smoke.
    obj.updateMatrixWorld(true);
    let bodyMeshCount = 0;
    let obscuredBodyMeshCount = 0;
    obj.traverse((part) => {
      if (!part.isMesh || !part.material || part === weaponMesh) return;
      const materials = Array.isArray(part.material) ? part.material : [part.material];
      if (!part.userData.smokeOriginalMaterials) {
        part.userData.smokeOriginalMaterials = materials.map((material) => ({
          material,
          transparent: material.transparent,
          opacity: material.opacity,
          depthWrite: material.depthWrite
        }));
      }
      const worldPosition = new THREE.Vector3();
      part.getWorldPosition(worldPosition);
      const insideSmoke = activeClouds.some((group) => {
        const radius = Number(group.userData.smoke?.radius) || 5.2;
        return worldPosition.distanceTo(group.position) < radius * 0.9;
      });
      bodyMeshCount++;
      if (insideSmoke) obscuredBodyMeshCount++;
      for (const original of part.userData.smokeOriginalMaterials) {
        const material = original.material;
        if (!material) continue;
        material.transparent = insideSmoke ? true : original.transparent;
        material.opacity = insideSmoke ? Math.min(original.opacity, 0.34) : original.opacity;
        material.depthWrite = insideSmoke ? false : original.depthWrite;
        material.needsUpdate = true;
      }
    });
    if (obj.userData.nameSprite) {
      // Hide the name too when smoke lies between the camera and the enemy,
      // even if the enemy's body is just outside the smoke cloud.
      const cameraPosition = new THREE.Vector3();
      camera.getWorldPosition(cameraPosition);
      const namePosition = new THREE.Vector3();
      obj.userData.nameSprite.getWorldPosition(namePosition);
      const sightLine = namePosition.clone().sub(cameraPosition);
      const sightLineLengthSq = sightLine.lengthSq();
      const smokeBlocksName = activeClouds.some((group) => {
        const radius = Number(group.userData.smoke?.radius) || 5.2;
        const toCloud = group.position.clone().sub(cameraPosition);
        const t = sightLineLengthSq > 0
          ? THREE.MathUtils.clamp(toCloud.dot(sightLine) / sightLineLengthSq, 0, 1)
          : 0;
        const closestPoint = cameraPosition.clone().addScaledVector(sightLine, t);
        // Only count smoke between the camera and the name tag, not smoke behind it.
        return t > 0.02 && t < 0.98 && closestPoint.distanceTo(group.position) < radius * 0.9;
      });
      obj.userData.nameSprite.visible = bodyMeshCount > 0
        && obscuredBodyMeshCount / bodyMeshCount <= 0.5
        && !smokeBlocksName;
    }
  }
}

const SKIN_FACE_ORDER = ["right", "left", "top", "bottom", "front", "back"];

const SKIN_BASE_RECTS = {
  head: {
    right:[0,8,8,8], left:[16,8,8,8], top:[8,0,8,8], bottom:[16,0,8,8], front:[8,8,8,8], back:[24,8,8,8]
  },
  torso: {
    right:[16,20,4,12], left:[28,20,4,12], top:[20,16,8,4], bottom:[28,16,8,4], front:[20,20,8,12], back:[32,20,8,12]
  },
  armR: {
    right:[40,20,4,12], left:[48,20,4,12], top:[44,16,4,4], bottom:[48,16,4,4], front:[44,20,4,12], back:[52,20,4,12]
  },
  legR: {
    right:[0,20,4,12], left:[8,20,4,12], top:[4,16,4,4], bottom:[8,16,4,4], front:[4,20,4,12], back:[12,20,4,12]
  },
  armL: {
    right:[32,52,4,12], left:[40,52,4,12], top:[36,48,4,4], bottom:[40,48,4,4], front:[36,52,4,12], back:[44,52,4,12]
  },
  legL: {
    right:[16,52,4,12], left:[24,52,4,12], top:[20,48,4,4], bottom:[24,48,4,4], front:[20,52,4,12], back:[28,52,4,12]
  }
};

const SKIN_OVERLAY_RECTS = {
  head: {
    right:[32,8,8,8], left:[48,8,8,8], top:[40,0,8,8], bottom:[48,0,8,8], front:[40,8,8,8], back:[56,8,8,8]
  },
  torso: {
    right:[16,36,4,12], left:[28,36,4,12], top:[20,32,8,4], bottom:[28,32,8,4], front:[20,36,8,12], back:[32,36,8,12]
  },
  armR: {
    right:[40,36,4,12], left:[48,36,4,12], top:[44,32,4,4], bottom:[48,32,4,4], front:[44,36,4,12], back:[52,36,4,12]
  },
  legR: {
    right:[0,36,4,12], left:[8,36,4,12], top:[4,32,4,4], bottom:[8,32,4,4], front:[4,36,4,12], back:[12,36,4,12]
  },
  armL: {
    right:[48,52,4,12], left:[56,52,4,12], top:[52,48,4,4], bottom:[56,48,4,4], front:[52,52,4,12], back:[60,52,4,12]
  },
  legL: {
    right:[0,52,4,12], left:[8,52,4,12], top:[4,48,4,4], bottom:[8,48,4,4], front:[4,52,4,12], back:[12,52,4,12]
  }
};

const skinImageCache = new Map();
const skinMaterialCache = new Map();

function loadSkinAtlas(dataUrl) {
  if (skinImageCache.has(dataUrl)) return skinImageCache.get(dataUrl);
  const promise = new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
  skinImageCache.set(dataUrl, promise);
  return promise;
}

function getSkinFaceMaterial(dataUrl, image, rect, transparent) {
  const region = rect.join(",");
  const key = dataUrl + "|" + region + "|" + (transparent ? "overlay" : "base");
  if (skinMaterialCache.has(key)) return skinMaterialCache.get(key);

  const [x, y, w, h] = rect;
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = Math.max(1, w);
  faceCanvas.height = Math.max(1, h);
  const context = faceCanvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  context.drawImage(image, x, y, w, h, 0, 0, w, h);

  const texture = new THREE.CanvasTexture(faceCanvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: .88,
    metalness: 0,
    transparent,
    alphaTest: .04,
    depthWrite: !transparent
  });
  skinMaterialCache.set(key, material);
  return material;
}

function makeSkinMaterials(dataUrl, image, part, overlay = false) {
  const atlas = overlay ? SKIN_OVERLAY_RECTS : SKIN_BASE_RECTS;
  const faceRects = atlas[part];
  // The player model faces -Z, while BoxGeometry's "front" material slot is +Z.
  // Swap the atlas front/back rectangles so facial details appear on the avatar's actual front.
  return SKIN_FACE_ORDER.map((face) => {
    const atlasFace = face === "front" ? "back" : face === "back" ? "front" : face;
    return getSkinFaceMaterial(dataUrl, image, faceRects[atlasFace], overlay);
  });
}

async function applyPlayerSkin(root, dataUrl) {
  if (!root || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) return;
  if (root.userData.skinDataUrl === dataUrl) return;
  root.userData.skinDataUrl = dataUrl;

  const image = await loadSkinAtlas(dataUrl);
  if (!image || root.userData.skinDataUrl !== dataUrl) return;

  const meshes = root.userData.skinMeshes;
  if (!meshes) return;

  for (const [part, mesh] of Object.entries(meshes.base)) {
    mesh.material = makeSkinMaterials(dataUrl, image, part, false);
  }
  for (const [part, mesh] of Object.entries(meshes.overlay)) {
    mesh.material = makeSkinMaterials(dataUrl, image, part, true);
    mesh.visible = true;
  }
}

function createRemotePlayer() {
  const root = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b8cff, roughness: .8 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xffd2ba, roughness: .9 });
  const legMat = new THREE.MeshStandardMaterial({ color: 0x20252d, roughness: .9 });

  // Box-shaped body parts make a standard 64x64 skin atlas line up predictably.
  const torso = new THREE.Mesh(new THREE.BoxGeometry(.62, .72, .36), bodyMat);
  torso.position.y = 1.05;
  torso.castShadow = true;

  const head = new THREE.Mesh(new THREE.BoxGeometry(.46, .46, .46), skinMat);
  head.position.y = 1.62;
  head.castShadow = true;

  const armL = new THREE.Mesh(new THREE.BoxGeometry(.18, .62, .22), bodyMat);
  armL.position.set(-.43, 1.05, 0);
  armL.rotation.z = -.08;
  armL.castShadow = true;

  const armR = new THREE.Mesh(new THREE.BoxGeometry(.18, .62, .22), bodyMat);
  armR.position.set(.43, 1.05, 0);
  armR.rotation.z = .08;
  armR.castShadow = true;

  const legL = new THREE.Mesh(new THREE.BoxGeometry(.22, .62, .24), legMat);
  legL.position.set(-.18, .38, 0);
  legL.castShadow = true;

  const legR = new THREE.Mesh(new THREE.BoxGeometry(.22, .62, .24), legMat);
  legR.position.set(.18, .38, 0);
  legR.castShadow = true;

  const outerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const headOuter = new THREE.Mesh(new THREE.BoxGeometry(.50, .50, .50), outerMat.clone());
  headOuter.position.copy(head.position);
  const torsoOuter = new THREE.Mesh(new THREE.BoxGeometry(.65, .75, .39), outerMat.clone());
  torsoOuter.position.copy(torso.position);
  const armLOuter = new THREE.Mesh(new THREE.BoxGeometry(.21, .65, .25), outerMat.clone());
  armLOuter.position.copy(armL.position);
  armLOuter.rotation.copy(armL.rotation);
  const armROuter = new THREE.Mesh(new THREE.BoxGeometry(.21, .65, .25), outerMat.clone());
  armROuter.position.copy(armR.position);
  armROuter.rotation.copy(armR.rotation);
  const legLOuter = new THREE.Mesh(new THREE.BoxGeometry(.25, .65, .27), outerMat.clone());
  legLOuter.position.copy(legL.position);
  const legROuter = new THREE.Mesh(new THREE.BoxGeometry(.25, .65, .27), outerMat.clone());
  legROuter.position.copy(legR.position);

  const outerMeshes = [headOuter, torsoOuter, armLOuter, armROuter, legLOuter, legROuter];
  for (const mesh of outerMeshes) {
    mesh.castShadow = true;
    mesh.visible = false;
  }

  const weapon = createWeaponMesh("pistol");

  root.add(torso, head, armL, armR, legL, legR, ...outerMeshes, weapon);
  const skinOutlineMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.9, depthTest: true });
  for (const mesh of [head, torso, armR, armL, legR, legL]) {
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), skinOutlineMaterial.clone());
    outline.scale.setScalar(1.006);
    outline.renderOrder = 3;
    mesh.add(outline);
  }

  root.userData.skinMeshes = {
    base: { head, torso, armR, armL, legR, legL },
    overlay: { head: headOuter, torso: torsoOuter, armR: armROuter, armL: armLOuter, legR: legROuter, legL: legLOuter }
  };
  root.userData.weaponMesh = weapon;
  root.userData.weaponType = "pistol";
  root.userData.rightArm = armR;
  root.userData.weaponActionStartedAt = -Infinity;
  root.userData.weaponActionType = "";

  const invulnerabilityShield = new THREE.Mesh(
    new THREE.SphereGeometry(1.15, 20, 14),
    new THREE.MeshBasicMaterial({
      color: 0x72c8ff,
      transparent: true,
      opacity: .18,
      wireframe: true,
      depthWrite: false
    })
  );
  invulnerabilityShield.visible = false;
  invulnerabilityShield.renderOrder = 20;
  root.add(invulnerabilityShield);
  root.userData.invulnerabilityShield = invulnerabilityShield;

  // 凍結中は敵側からも一目で分かるよう、氷の輪郭を全身に表示する。
  const freezeShell = new THREE.Mesh(
    new THREE.SphereGeometry(0.88, 14, 10),
    new THREE.MeshBasicMaterial({
      color: 0x70eaff, transparent: true, opacity: 0.26,
      wireframe: true, depthWrite: false
    })
  );
  freezeShell.position.y = 1.0;
  freezeShell.visible = false;
  freezeShell.renderOrder = 18;
  root.add(freezeShell);
  root.userData.freezeShell = freezeShell;

  // 名前とは別の状態ラベルを頭上に表示する。
  const freezeCanvas = document.createElement("canvas");
  freezeCanvas.width = 384;
  freezeCanvas.height = 96;
  const freezeContext = freezeCanvas.getContext("2d");
  freezeContext.font = "bold 58px Arial, sans-serif";
  freezeContext.textAlign = "center";
  freezeContext.textBaseline = "middle";
  freezeContext.lineJoin = "round";
  freezeContext.lineWidth = 12;
  freezeContext.strokeStyle = "rgba(0,20,35,0.95)";
  freezeContext.strokeText("❄ 凍結中", 192, 48);
  freezeContext.fillStyle = "#a8f4ff";
  freezeContext.fillText("❄ 凍結中", 192, 48);
  const freezeTexture = new THREE.CanvasTexture(freezeCanvas);
  freezeTexture.colorSpace = THREE.SRGBColorSpace;
  const freezeLabel = new THREE.Sprite(new THREE.SpriteMaterial({
    map: freezeTexture, transparent: true, depthTest: false, depthWrite: false
  }));
  freezeLabel.scale.set(1.75, 0.44, 1);
  freezeLabel.position.set(0, 2.62, 0);
  freezeLabel.visible = false;
  freezeLabel.renderOrder = 40;
  root.add(freezeLabel);
  root.userData.freezeLabel = freezeLabel;

  // 名前はキャラクターモデル/スキンとは独立したSpriteとして表示する。
  const nameCanvas = document.createElement("canvas");
  nameCanvas.width = 512;
  nameCanvas.height = 96;
  const nameTexture = new THREE.CanvasTexture(nameCanvas);
  nameTexture.colorSpace = THREE.SRGBColorSpace;
  const nameSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: nameTexture,
    transparent: true,
    depthTest: true,
    depthWrite: false
  }));
  nameSprite.scale.set(2.8, 0.52, 1);
  nameSprite.position.set(0, 2.15, 0);
  nameSprite.renderOrder = 10;
  root.add(nameSprite);
  root.userData.nameCanvas = nameCanvas;
  root.userData.nameTexture = nameTexture;
  root.userData.nameSprite = nameSprite;
  root.userData.nameText = "";
  root.userData.nameColor = "";

  root.userData.targetPosition = new THREE.Vector3();
  root.userData.targetYaw = 0;
  root.userData.hasNetworkTransform = false;
  scene.add(root);
  return root;
}

function playerClothingColor(name) {
  let hash = 2166136261;
  for (const char of String(name || "Player")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return new THREE.Color().setHSL(((hash >>> 0) % 360) / 360, 0.62, 0.48);
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

    if (p.skin) applyPlayerSkin(obj, p.skin);
    if (!obj.userData.skinDataUrl) {
      const clothingColor = ["Area", "Payload"].includes(p.mode)
        ? new THREE.Color(p.team === "blue" ? 0x287bd1 : 0xc93636)
        : playerClothingColor(p.name);
      for (const mesh of [obj.userData.skinMeshes?.base?.torso, obj.userData.skinMeshes?.base?.armL, obj.userData.skinMeshes?.base?.armR]) {
        if (!mesh) continue;
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (material?.color) material.color.copy(clothingColor);
      }
    }
    const previousPlayerState = obj.userData.playerState;
    if (previousPlayerState && Number(previousPlayerState.health) <= 0 && Number(p.health) > 0) {
      const isEnemy = !(["Area", "Payload"].includes(selectedGameMode) && p.team === myState?.team);
      if (isEnemy) addEnemyRespawnMarker(p.id, p.x, p.z);
    }
    obj.userData.playerState = p;
    const isFrozen = Number(p.frozenUntil || 0) > Date.now() && p.health > 0;
    if (obj.userData.freezeShell) obj.userData.freezeShell.visible = isFrozen && !p.invisible;
    if (obj.userData.freezeLabel) obj.userData.freezeLabel.visible = isFrozen && !p.invisible;
    for (const mesh of Object.values(obj.userData.skinMeshes?.base || {})) mesh.visible = !p.invisible;
    for (const mesh of Object.values(obj.userData.skinMeshes?.overlay || {})) mesh.visible = !p.invisible;
    if (obj.userData.nameSprite) obj.userData.nameSprite.visible = !p.invisible;
    if (obj.userData.weaponMesh) obj.userData.weaponMesh.visible = !p.invisible;
    const nameSprite = obj.userData.nameSprite;
    const teamColor = ["Area", "Payload"].includes(p.mode)
      ? (p.team === "blue" ? "#54b7ff" : "#ff6565")
      : "#ffffff";
    if (nameSprite && (obj.userData.nameText !== p.name || obj.userData.nameColor !== teamColor)) {
      const canvas = obj.userData.nameCanvas;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = "bold 44px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(0,0,0,0.95)";
      ctx.lineWidth = 10;
      ctx.strokeText(String(p.name || "Player"), canvas.width / 2, canvas.height / 2);
      ctx.fillStyle = teamColor;
      ctx.fillText(String(p.name || "Player"), canvas.width / 2, canvas.height / 2);
      obj.userData.nameTexture.needsUpdate = true;
      obj.userData.nameText = p.name;
      obj.userData.nameColor = teamColor;
    }
    obj.userData.targetPosition.set(p.x, p.y || 0, p.z);
    obj.userData.targetYaw = p.yaw || 0;
    obj.userData.crouched = Boolean(p.crouched);
    const crouchScale = obj.userData.crouched ? 0.62 : 1;
    obj.scale.y = crouchScale;
    // 全身を低くしつつ、頭部と頭部スキンのサイズだけは維持する。
    const headScaleY = obj.userData.crouched ? 1 / crouchScale : 1;
    for (const headMesh of [obj.userData.skinMeshes?.base?.head, obj.userData.skinMeshes?.overlay?.head]) {
      if (!headMesh) continue;
      headMesh.scale.y = headScaleY;
    }
    obj.visible = p.health > 0;

    const shield = obj.userData.invulnerabilityShield;
    if (shield) {
      shield.visible = p.health > 0 && Number(p.invulnerableUntil || 0) > Date.now();
    }

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

function isAimAssistBlockedBySmoke(origin, targetPoint) {
  const segment = targetPoint.clone().sub(origin);
  const lengthSq = segment.lengthSq();
  if (lengthSq < 1e-8) return false;

  const now = Date.now();
  for (const group of smokeCloudMeshes.values()) {
    const smoke = group.userData.smoke;
    if (!smoke || Number(smoke.expiresAt) <= now) continue;

    // 見た目の煙幕の広がりを考慮し、線分と煙幕球の最短距離を調べる。
    const radius = Math.max(1, Number(smoke.radius) || 5.2) * 0.92;
    const toCenter = group.position.clone().sub(origin);
    const t = THREE.MathUtils.clamp(toCenter.dot(segment) / lengthSq, 0, 1);
    const closestPoint = origin.clone().addScaledVector(segment, t);
    if (closestPoint.distanceToSquared(group.position) <= radius * radius) return true;
  }
  return false;
}

let lastAimAssistUpdate = 0;
function updateAimAssist() {
  const now = performance.now();
  if (now - lastAimAssistUpdate < 50) return;
  lastAimAssistUpdate = now;
  if (!joined || !myState) return;
  const touchDevice = window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  let strengthPercent = 0;
  const controllerConnected = Boolean(controllerMode || activeGamepad?.connected);
  if (controllerConnected) {
    strengthPercent = Number(gameSettings.controllerAimAssistStrength ?? (gameSettings.controllerAimAssistEnabled ? 10 : 0));
  } else if (touchDevice) {
    strengthPercent = Number(gameSettings.touchAimAssistStrength ?? (gameSettings.touchAimAssistEnabled ? 10 : 0));
  } else {
    return;
  }
  if (![5, 10].includes(strengthPercent)) return;
  const aimAssistTargetPercent = strengthPercent;
  if (myState.charm === "aim") strengthPercent = strengthPercent === 5 ? 30 : 60;
  const strength = strengthPercent / 100;
  const origin = camera.position.clone();
  let best = null;
  for (const obj of remotePlayers.values()) {
    const target = obj.userData.playerState;
    if (!target || target.health <= 0 || !obj.visible) continue;
    if (selectedGameMode === "Area" && target.team && myState.team && target.team === myState.team) continue;
    const targetHeight = aimAssistTargetPercent === 5
      ? (target.crouched ? 1.02 : 1.52)
      : (target.crouched ? 0.72 : 1.12);
    const point = obj.position.clone().add(new THREE.Vector3(0, targetHeight, 0));
    const offset = point.clone().sub(origin);
    const distance = offset.length();
    if (distance > 38 || distance < 0.1) continue;
    // 煙幕が照準と敵の間にある、または照準元・敵が煙幕内なら補助照準を無効化。
    if (isAimAssistBlockedBySmoke(origin, point)) continue;
    const targetYaw = Math.atan2(-offset.x, -offset.z);
    const targetPitch = Math.atan2(offset.y, Math.hypot(offset.x, offset.z));
    const yawDelta = Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw));
    const pitchDelta = targetPitch - pitch;
    if (Math.abs(yawDelta) > 0.22 + strength * 0.14 || Math.abs(pitchDelta) > 0.18 + strength * 0.12) continue;
    aimAssistRaycaster.set(origin, offset.clone().normalize());
    const blockers = aimAssistRaycaster.intersectObjects(worldGroup.children, true);
    if (blockers.length && blockers[0].distance < distance - 0.45) continue;
    const score = Math.abs(yawDelta) * 1.15 + Math.abs(pitchDelta) + distance * 0.0015;
    if (!best || score < best.score) best = { yawDelta, pitchDelta, score };
  }
  if (!best) return;
  const pull = 0.012 + strength * 0.16;
  yaw += best.yawDelta * pull;
  pitch = THREE.MathUtils.clamp(pitch + best.pitchDelta * pull, -1.35, 1.35);
}
const aimAssistRaycaster = new THREE.Raycaster();

function updateCamera() {
  if (!myState) return;
  const targetCameraHeight = myState.crouched ? 1.0 : 1.62;
  const currentCameraY = camera.position.y - (myState.y || 0);
  const cameraHeight = THREE.MathUtils.lerp(currentCameraY, targetCameraHeight, 0.35);
  camera.position.set(myState.x, cameraHeight + (myState.y || 0), myState.z);
  camera.rotation.set(pitch, yaw, 0);
}

function applyControllerMode(enabled) {
  controllerMode = enabled;
  document.body.classList.toggle("controller-mode", enabled);
  if (!layoutEditing) document.getElementById("touchUi")?.classList.toggle("hidden", enabled);
  document.getElementById("gamepadStatus")?.replaceChildren(
    document.createTextNode(enabled && activeGamepad ? ("接続中: " + (activeGamepad.id || "Gamepad")) : "未接続")
  );
}

function findGamepad() {
  if (!navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  return Array.from(pads || []).find((pad) => pad && pad.connected) || null;
}

function updateGamepadStatus() {
  const pad = findGamepad();
  activeGamepad = pad;
  applyControllerMode(Boolean(pad));
  return pad;
}

function pollGamepad(now) {
  const pad = findGamepad();
  if (!pad) {
    if (activeGamepad || controllerMode) {
      if (gamepadFireHeld) stopFiring();
      gamepadFireHeld = false;
      activeGamepad = null;
      applyControllerMode(false);
    }
    return;
  }

  activeGamepad = pad;
  if (!controllerMode) applyControllerMode(true);

  const deadzone = .16;
  const axis = (value) => Math.abs(value) < deadzone ? 0 : (value - Math.sign(value) * deadzone) / (1 - deadzone);

  const lx = axis(pad.axes?.[0] || 0);
  const ly = axis(pad.axes?.[1] || 0);
  const rx = axis(pad.axes?.[2] || 0);
  const ry = axis(pad.axes?.[3] || 0);

  // 左スティックはタッチ操作と同じ向きに対応させる。
  joystick.strafe = lx;
  joystick.forward = -ly;

  const lookSpeed = .045 * gameSettings.controllerSensitivity * (getScopeSensitivityMultiplier());
  yaw -= rx * lookSpeed;
  pitch -= ry * lookSpeed;
  pitch = THREE.MathUtils.clamp(pitch, -1.35, 1.35);

  const buttonFor = (action) => Number(gameSettings.controllerButtons?.[action] ?? DEFAULT_SETTINGS.controllerButtons[action]);
  const jumpPressed = Boolean(pad.buttons?.[buttonFor("jump")]?.pressed);
  const buildLeftPressed = selectedGameMode === "Build" && Boolean(pad.buttons?.[14]?.pressed);
  const buildRightPressed = selectedGameMode === "Build" && Boolean(pad.buttons?.[15]?.pressed);
  const buildPlacePressed = selectedGameMode === "Build" && Boolean(pad.buttons?.[0]?.pressed);
  if (buildLeftPressed && !gamepadBuildLeftHeld) selectBuildType("wall");
  if (buildRightPressed && !gamepadBuildRightHeld) selectBuildType("floor");
  if (buildPlacePressed && !gamepadBuildPlaceHeld) placeBuildStructure();
  gamepadBuildLeftHeld = buildLeftPressed;
  gamepadBuildRightHeld = buildRightPressed;
  gamepadBuildPlaceHeld = buildPlacePressed;
  const reloadPressed = Boolean(pad.buttons?.[buttonFor("reload")]?.pressed);
  const crouchPressed = Boolean(pad.buttons?.[buttonFor("crouch")]?.pressed);
  const switchPressed = Boolean(pad.buttons?.[buttonFor("switchWeapon")]?.pressed);
  const scopePressed = Boolean(pad.buttons?.[buttonFor("scope")]?.pressed);
  const firePressed = Boolean(pad.buttons?.[buttonFor("fire")]?.pressed);
  const ultimatePressed = Boolean(pad.buttons?.[buttonFor("ultimate")]?.pressed);
  if (ultimatePressed && !gamepadUltimateHeld) activateUltimate();
  gamepadUltimateHeld = ultimatePressed;

  if (jumpPressed && !gamepadJumpHeld && selectedGameMode !== "Build") {
    if (myState?.health <= 0) {
      requestRespawn();
    } else {
      jump();
    }
  }
  if (reloadPressed && !gamepadReloadHeld) reload();
  if (switchPressed && !gamepadSwitchHeld) selectWeaponSlot(activeWeaponSlot === 0 ? 1 : 0);
  if (scopePressed && !gamepadScopeHeld && selectedWeapon === "sniper") {
    setScopeEnabled(!scopeEnabled);
  }
  crouchHeld = crouchPressed;
  gamepadJumpHeld = jumpPressed;
  gamepadReloadHeld = reloadPressed;
  gamepadCrouchHeld = crouchPressed;
  gamepadSwitchHeld = switchPressed;
  gamepadScopeHeld = scopePressed;

  // コントローラーの射撃ボタンは、長押し中に武器の発射間隔で連射する。
  if (firePressed && !gamepadFireHeld) {
    startFiring(true);
  } else if (!firePressed && gamepadFireHeld) {
    // 弓・ミニガンはautoFireTimerを使わないため、ボタンを離した時は必ずチャージを解放する。
    stopFiring();
  }
  gamepadFireHeld = firePressed;

  if (now - lastInputSent >= 33) {
    const scopeMoveMultiplier = scopeEnabled ? 0.5 : 1;
    socket.emit("input", {
      forward: joystick.forward * scopeMoveMultiplier,
      strafe: joystick.strafe * scopeMoveMultiplier,
      crouch: crouchHeld, yaw, pitch
    });
    lastInputSent = now;
  }
}

function sendInput(now) {
  if (!joined || myState?.health <= 0 || now - lastInputSent < 33) return;

  const keyboardForward = (movement.forward ? 1 : 0) + (movement.back ? -1 : 0);
  const keyboardStrafe = (movement.right ? 1 : 0) + (movement.left ? -1 : 0);

  // スコープを覗いている間は移動速度を落とす。
  const scopeMoveMultiplier = scopeEnabled ? 0.5 : 1;
  const forward = THREE.MathUtils.clamp(keyboardForward + joystick.forward, -1, 1) * scopeMoveMultiplier;
  const lookDelta = lastKeyboardLookAt ? Math.min((now - lastKeyboardLookAt) / 1000, 0.1) : 0;
  lastKeyboardLookAt = now;
  const lookSpeed = 1.8 * gameSettings.mouseSensitivity * (getScopeSensitivityMultiplier());
  // 視点の回転方向を入力方向に合わせる（右/上は正方向ではなく反対符号）。
  yaw -= ((keyboardLook.right ? 1 : 0) - (keyboardLook.left ? 1 : 0)) * lookSpeed * lookDelta;
  pitch -= ((keyboardLook.down ? 1 : 0) - (keyboardLook.up ? 1 : 0)) * lookSpeed * lookDelta;
  pitch = THREE.MathUtils.clamp(pitch, -1.35, 1.35);
  const strafe = THREE.MathUtils.clamp(keyboardStrafe + joystick.strafe, -1, 1) * scopeMoveMultiplier;

  socket.emit("input", { forward, strafe, crouch: crouchHeld, yaw, pitch });
  lastInputSent = now;
}

let lastLocalJumpInputAt = 0;
function jump() {
  if (!joined || myState?.health <= 0) return;
  lastLocalJumpInputAt = Date.now();
  socket.emit("jump");
}

function setCrouch(held) {
  if (!joined || myState?.health <= 0) return;
  crouchHeld = Boolean(held);
}

function fire() {
  if (["bow","minigun","railgun","formingGun","flamethrower","laserBeam","freezeCannon"].includes(selectedWeapon)) return;
  if (!joined || myState?.reloading) return;
  // 武器切替中はレティクルが隠れている時間と同じ長さだけ発射を禁止する。
  if (performance.now() - lastWeaponSwitchAt < WEAPON_SWITCH_COOLDOWN_MS) return;
  // リスポーン直後の無敵時間中は発射操作自体を受け付けない。
  if (myState && Number(myState.invulnerableUntil || 0) > Date.now()) return;

  if (!["pickaxe", "sword", "smoke", "shockwaveLauncher", "grappler","railgun","formingGun","flamethrower","laserBeam","freezeCannon"].includes(selectedWeapon) && myState && myState.ammo <= 0) {
    // 弾切れによる自動リロードでは射撃ボタンの長押し状態を維持する。
    reload(true);
    return;
  }

  const now = performance.now();
  const cfg = weaponConfig[selectedWeapon];
  // 剣の通常攻撃はサーバーのダメージ間隔と同じ650msをローカルでも厳守する。
  const localFireInterval = selectedWeapon === "sword" ? cfg.fireInterval : cfg.fireInterval * .8;
  if (now - localLastFire < localFireInterval) return;
  // 入力経路が重複しても、剣の振りアニメーションと発射要求は650ms間隔を下回らない。
  if (selectedWeapon === "sword" && now < localSwordNextAttackAt) return;

  localLastFire = now;
  if (selectedWeapon === "sword") localSwordNextAttackAt = now + Math.max(650, cfg.fireInterval || 650);
  if (["pickaxe", "sword", "smoke", "grenadeLauncher", "rocketLauncher", "shockwaveLauncher", "grappler"].includes(selectedWeapon)) {
    startLocalWeaponAction(selectedWeapon === "sword" && myState?.grounded === false ? "swordLeap" : selectedWeapon);
  }
  socket.emit("fire", { scoped: selectedWeapon === "sniper" && scopeEnabled });
}

function reload(preserveFiring = false) {
  if (!joined || myState?.reloading || ["pickaxe", "sword", "smoke", "shockwaveLauncher", "grappler","railgun","flamethrower","laserBeam","freezeCannon"].includes(selectedWeapon)) return;
  if (!preserveFiring) stopFiring();
  socket.emit("reload");
}

function weaponDisplayName(id) {
  return ({ rocketLauncher:"ロケットランチャー",formingGun:"ホーミングガン",railgun:"レールガン",flamethrower:"火炎放射器",laserBeam:"レーザービーム",freezeCannon:"フリーズキャノン", pickaxe: "ツルハシ", sword: "剣", smoke: "煙幕", grenadeLauncher: "グレネード", shockwaveLauncher: "ショックウェーブランチャー", grappler: "グラップラー", pistol: "ハンドガン", smg: "サブマシンガン", rifle: "アサルトライフル", shotgun: "ショットガン", marksman: "マークスマン", sniper: "スナイパーライフル", bow: "弓", minigun: "ミニガン" })[id] || String(id || "武器");
}

function updateWeaponReticle() {
  const crosshair = document.getElementById("crosshair");
  if (!crosshair) return;
  const reticles = {
    bow: ["weapon-bow", "⌒"],
    minigun: ["weapon-minigun", "✣"],
    pickaxe: ["weapon-pickaxe", "+"],
    sword: ["weapon-pickaxe", "+"],
    smoke: ["weapon-smoke", "○"],
    grenadeLauncher: ["weapon-grenade", "◎"],
    rocketLauncher: ["weapon-grenade", "◎"],
    shockwaveLauncher: ["weapon-grenade", "◉"], grappler: ["weapon-grenade", "⊂"],
    pistol: ["weapon-pistol", "+"],
    smg: ["weapon-smg", "┼"],
    rifle: ["weapon-rifle", "┼"],
    shotgun: ["weapon-shotgun", "◎"],
    marksman: ["weapon-marksman", "⊙"],
    sniper: ["weapon-sniper", "·"]
  };
  const noReticle = selectedWeapon === "flamethrower" || selectedWeapon === "freezeCannon";
  const [className, glyph] = reticles[selectedWeapon] || reticles.pistol;
  crosshair.classList.remove("weapon-bow", "weapon-minigun", "weapon-pickaxe", "weapon-smoke", "weapon-grenade", "weapon-pistol", "weapon-smg", "weapon-rifle", "weapon-shotgun", "weapon-marksman", "weapon-sniper", "weapon-fan", "weapon-no-reticle");
  crosshair.classList.add(className);
  crosshair.classList.toggle("weapon-no-reticle", noReticle);
  crosshair.textContent = glyph;
  updatePickaxeReticleBounds();
}

// Server melee hit check uses dot >= 0.72, equivalent to this horizontal half-angle.
// Project that angle through the current camera so the bracket edges track the real attack cone.
function updatePickaxeReticleBounds() {
  const crosshair = document.getElementById("crosshair");
  if (!crosshair) return;
  if (selectedWeapon !== "pickaxe" && selectedWeapon !== "sword") {
    crosshair.style.width = "";
    return;
  }
  const halfAngle = Math.acos(0.9);
  const halfHorizontalFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
  const projectedWidth = innerWidth * Math.tan(halfAngle) / Math.tan(halfHorizontalFov);
  crosshair.style.width = Math.min(innerWidth, projectedWidth) + "px";
}


const inventoryPanel = document.getElementById("inventoryPanel");
function renderInventory() {
  refreshWeaponSightControl();
  const container = document.getElementById("inventoryWeaponSlots");
  if (!container) return;
  container.replaceChildren();
  const slots = Array.isArray(myState?.weaponSlots) ? myState.weaponSlots : weaponSlots;
  slots.slice(0, 2).forEach((weapon, index) => {
    const card = document.createElement("div");
    card.className = "inventory-weapon-card" + (index === activeWeaponSlot ? " active" : "");
    const title = document.createElement("strong");
    title.textContent = (index + 1) + "番スロット： " + weaponDisplayName(weapon);
    const state = document.createElement("span");
    state.textContent = index === activeWeaponSlot ? "現在装備中" : "待機中";
    const equip = document.createElement("button");
    equip.type = "button";
    equip.textContent = index === activeWeaponSlot ? "装備中" : "この武器に持ち替え";
    equip.disabled = index === activeWeaponSlot;
    equip.addEventListener("click", () => {
      selectWeaponSlot(index);
      renderInventory();
    });
    card.append(title, state, equip);
    container.appendChild(card);
  });
}
function openInventory() {
  if (!joined || !inventoryPanel) return;
  renderInventory();
  inventoryPanel.classList.remove("hidden");
  inventoryPanel.setAttribute("aria-hidden", "false");
  document.getElementById("inventoryButton")?.setAttribute("aria-expanded", "true");
}
function closeInventory() {
  inventoryPanel?.classList.add("hidden");
  inventoryPanel?.setAttribute("aria-hidden", "true");
  document.getElementById("inventoryButton")?.setAttribute("aria-expanded", "false");
}
document.getElementById("inventoryCloseButton")?.addEventListener("click", closeInventory);
inventoryPanel?.addEventListener("click", (event) => {
  if (event.target === inventoryPanel) closeInventory();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && inventoryPanel && !inventoryPanel.classList.contains("hidden")) closeInventory();
});

function updateWeaponSwitchButton() {
  refreshWeaponSightControl();
  const button = document.getElementById("switchWeaponButton");
  if (button) {
    button.textContent = "武器切替\n" + (activeWeaponSlot + 1) + "/2";
    button.setAttribute("aria-label", "武器切替。現在 " + weaponDisplayName(selectedWeapon));
    button.title = weaponDisplayName(selectedWeapon);
  }
  updateScopeButton();
  updateWeaponReticle();
  refreshLocalWeaponViewModel();
}
function updateScopeButton() {
  const button = document.getElementById("scopeButton");
  if (!button) return;
  button.classList.toggle("hidden", !(joined && selectedWeapon === "sniper"));
  button.textContent = scopeEnabled ? "スコープ\n解除" : "スコープ\n覗く";
  button.setAttribute("aria-label", scopeEnabled ? "スコープを解除" : "スコープを覗く");
}
function setScopeEnabled(enabled) {
  scopeEnabled = Boolean(enabled) && selectedWeapon === "sniper";
  camera.fov = scopeEnabled ? 24 : 76;
  camera.updateProjectionMatrix();
  const scopeOverlay = document.getElementById("scopeOverlay");
  scopeOverlay?.classList.toggle("hidden", !scopeEnabled);
  if (scopeOverlay) scopeOverlay.style.opacity = scopeEnabled ? "1" : "0";
  updateScopeButton();
}

function isLocalGrapplerExtended() {
  if (!myId) return false;
  if (grappleTethers.has(myId)) return true;
  for (const mesh of grenadeProjectileMeshes.values()) {
    if (mesh.userData.ownerId === myId && mesh.userData.projectileType === "grapple") return true;
  }
  return false;
}

function selectWeaponSlot(slot) {
  if (!joined || myState?.health <= 0 || isLocalGrapplerExtended() || performance.now() < swordLeapLocalUntil) return;
  const now = performance.now();
  if (now - lastWeaponSwitchAt < WEAPON_SWITCH_COOLDOWN_MS) return;
  const nextSlot = Number(slot);
  const slots = Array.isArray(myState?.weaponSlots) ? myState.weaponSlots : weaponSlots;
  if (!Number.isInteger(nextSlot) || nextSlot < 0 || nextSlot > 1 || !slots[nextSlot]) return;
  if (nextSlot === activeWeaponSlot && selectedWeapon === slots[nextSlot]) return;
  cancelFiringForWeaponSwitch();
  lastWeaponSwitchAt = now;
  const switchReticle = document.getElementById("crosshair");
  switchReticle?.classList.add("weapon-switch-blocked");
  window.setTimeout(() => {
    if (lastWeaponSwitchAt === now) switchReticle?.classList.remove("weapon-switch-blocked");
  }, WEAPON_SWITCH_COOLDOWN_MS);
  activeWeaponSlot = nextSlot;
  weaponSlots = [...slots];
  selectedWeapon = weaponSlots[nextSlot];
  if (selectedWeapon !== "sniper") setScopeEnabled(false);
  socket.emit("switchWeapon", nextSlot);
  updateWeaponSwitchButton();
}

function switchWeapon() {
  selectWeaponSlot(activeWeaponSlot === 0 ? 1 : 0);
}

let bowChargeInterval = null;
let minigunChargeInterval = null;
let minigunChargeValue = 0;
let minigunCharging = false;
let minigunDraining = false;
let minigunLastUpdateAt = 0;
let bowChargeStartedAt = 0;
let bowNextChargeAt = 0;
const BOW_FIRE_COOLDOWN_MS = 750;
function updateBowChargeScope(progress) {
  const amount = THREE.MathUtils.clamp(progress / 0.5, 0, 1);
  if (selectedWeapon !== "bow" || scopeEnabled) return;
  const zoomAmount = amount;
  camera.fov = 76 - (52 * zoomAmount);
  camera.updateProjectionMatrix();
  const overlay = document.getElementById("scopeOverlay");
  if (overlay) {
    overlay.classList.toggle("hidden", zoomAmount <= 0.001);
    overlay.style.opacity = String(zoomAmount);
  }
}
function resetBowChargeScope() {
  if (selectedWeapon !== "bow" || scopeEnabled) return;
  camera.fov = 76;
  camera.updateProjectionMatrix();
  const overlay = document.getElementById("scopeOverlay");
  if (overlay) { overlay.classList.add("hidden"); overlay.style.opacity = "0"; }
}
let railgunChargeStartedAt=0,railgunChargeTimer=null;
function startRailgunCharge() {
  if (!joined || selectedWeapon !== "railgun" || myState?.health <= 0 ||
      railgunChargeStartedAt || myState?.frozenUntil > Date.now()) return;
  railgunChargeStartedAt = performance.now();
  socket.emit("railgunChargeStart");
  const hud = document.getElementById("bowChargeHud");
  const fill = document.getElementById("bowChargeFill");
  const label = hud?.querySelector("span");
  if (label) label.textContent = "レールガン チャージ";
  hud?.setAttribute("aria-label", "レールガンのチャージ");
  if (fill) fill.style.width = "0%";
  hud?.classList.remove("hidden");
  if (railgunChargeTimer) clearInterval(railgunChargeTimer);
  railgunChargeTimer = setInterval(() => {
    if (fill) fill.style.width = Math.min(100, (performance.now() - railgunChargeStartedAt) / 10) + "%";
  }, 30);
}
function releaseRailgunCharge() {
  if (!railgunChargeStartedAt) return;
  const elapsed = performance.now() - railgunChargeStartedAt;
  railgunChargeStartedAt = 0;
  if (railgunChargeTimer) clearInterval(railgunChargeTimer);
  railgunChargeTimer = null;
  const hud = document.getElementById("bowChargeHud");
  hud?.classList.add("hidden");
  const fill = document.getElementById("bowChargeFill");
  if (fill) fill.style.width = "0%";
  const label = hud?.querySelector("span");
  if (label) label.textContent = "弓のチャージ";
  hud?.setAttribute("aria-label", "弓のチャージ");
  if (elapsed >= 1000 && selectedWeapon === "railgun") socket.emit("railgunRelease");
}
function startBowCharge() {
  if (!joined || selectedWeapon !== "bow" || myState?.health <= 0 || bowChargeStartedAt || performance.now() < bowNextChargeAt) return;
  bowChargeStartedAt = performance.now();
  socket.emit("bowChargeStart");
  const gauge = document.getElementById("bowChargeHud");
  const fill = document.getElementById("bowChargeFill");
  const label = gauge?.querySelector("span");
  if (label) label.textContent = "弓のチャージ";
  gauge?.setAttribute("aria-label", "弓のチャージ");
  gauge?.classList.remove("hidden");
  if (bowChargeInterval) clearInterval(bowChargeInterval);
  const update = () => {
    const progress = Math.min(1, (performance.now() - bowChargeStartedAt) / 1125);
    updateBowChargeScope(progress);
    if (fill) fill.style.width = (progress * 100) + "%";
    if (gauge) gauge.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  };
  update();
  bowChargeInterval = setInterval(update, 30);
}
function releaseBowCharge() {
  if (!bowChargeStartedAt) return;
  bowChargeStartedAt = 0;
  resetBowChargeScope();
  if (bowChargeInterval) clearInterval(bowChargeInterval);
  bowChargeInterval = null;
  document.getElementById("bowChargeHud")?.classList.add("hidden");
  const fill = document.getElementById("bowChargeFill");
  if (fill) fill.style.width = "0%";
  bowNextChargeAt = performance.now() + BOW_FIRE_COOLDOWN_MS;
  socket.emit("bowRelease");
}

function startMinigunCharge() {
  if (!joined || selectedWeapon !== "minigun" || myState?.health <= 0 ||
      Number(myState?.invulnerableUntil || 0) > Date.now() || minigunCharging || minigunDraining) return;
  minigunCharging = true;
  minigunLastUpdateAt = performance.now();
  socket.emit("minigunChargeStart");
  const gauge = document.getElementById("bowChargeHud");
  const fill = document.getElementById("bowChargeFill");
  const label = gauge?.querySelector("span");
  if (label) label.textContent = "ミニガン チャージ";
  gauge?.setAttribute("aria-label", "ミニガンのチャージ");
  if (fill) fill.style.width = "0%";
  gauge?.setAttribute("aria-label", "ミニガンのチャージ");
  gauge?.classList.remove("hidden");
  if (minigunChargeInterval) clearInterval(minigunChargeInterval);
  minigunChargeInterval = setInterval(updateMinigunCharge, 20);
}
function updateMinigunCharge() {
  const now = performance.now();
  const elapsed = Math.max(0, now - minigunLastUpdateAt);
  minigunLastUpdateAt = now;
  if (minigunCharging) minigunChargeValue = Math.min(1, minigunChargeValue + elapsed / 1500);
  else if (minigunDraining) minigunChargeValue = Math.max(0, minigunChargeValue - elapsed / 1500);
  const fill = document.getElementById("bowChargeFill");
  const gauge = document.getElementById("bowChargeHud");
  if (fill) fill.style.width = (minigunChargeValue * 100) + "%";
  if (gauge) gauge.setAttribute("aria-valuenow", String(Math.round(minigunChargeValue * 100)));
  if (minigunDraining && minigunChargeValue <= 0) {
    minigunDraining = false;
    if (minigunChargeInterval) clearInterval(minigunChargeInterval);
    minigunChargeInterval = null;
    gauge?.classList.add("hidden");
    if (gauge?.querySelector("span")) gauge.querySelector("span").textContent = "弓のチャージ";
    gauge?.setAttribute("aria-label", "弓のチャージ");
  }
}
function releaseMinigunCharge() {
  if (!minigunCharging) return;
  minigunCharging = false;
  minigunDraining = minigunChargeValue > 0;
  minigunLastUpdateAt = performance.now();
  socket.emit("minigunRelease");
  if (!minigunDraining && minigunChargeInterval) {
    clearInterval(minigunChargeInterval);
    minigunChargeInterval = null;
    document.getElementById("bowChargeHud")?.classList.add("hidden");
  }
}
function cancelMinigunCharge() {
  if (minigunCharging || minigunDraining || minigunChargeValue > 0) socket.emit("minigunCancel");
  minigunCharging = false;
  minigunDraining = false;
  minigunChargeValue = 0;
  if (minigunChargeInterval) clearInterval(minigunChargeInterval);
  minigunChargeInterval = null;
  document.getElementById("bowChargeFill")?.style.setProperty("width", "0%");
  document.getElementById("bowChargeHud")?.classList.add("hidden");
}
let swordGuardActive = false;
let swordPressStartedAt = 0;
let swordAirAttack = false;
let swordLeapLocalUntil = 0;
let swordMeleeLocalReadyAt = 0;
let localSwordNextAttackAt = 0;
let swordGuardQueueTimer = null;
let swordGuardQueued = false;

function beginQueuedSwordGuard() {
  swordGuardQueueTimer = null;
  if (!swordGuardQueued || !swordPressStartedAt || selectedWeapon !== "sword" ||
      swordGuardActive || swordAirAttack) return;
  swordGuardQueued = false;
  swordGuardActive = true;
  socket.emit("swordGuardStart");
}

let formingChargeStartedAt = 0;
let formingChargeTimer = null;
function startFormingCharge() {
  if (!joined || selectedWeapon !== "formingGun" || myState?.health <= 0 || formingChargeStartedAt ||
      Number(myState?.invulnerableUntil || 0) > Date.now() || myState?.frozenUntil > Date.now()) return;
  formingChargeStartedAt = performance.now();
  socket.emit("formingChargeStart");
  const hud = document.getElementById("bowChargeHud");
  const fill = document.getElementById("bowChargeFill");
  const label = hud?.querySelector("span");
  if (label) label.textContent = "ホーミングガン チャージ";
  hud?.setAttribute("aria-label", "ホーミングガンのチャージ");
  hud?.classList.remove("hidden");
  if (fill) fill.style.width = "0%";
  if (formingChargeTimer) clearInterval(formingChargeTimer);
  formingChargeTimer = setInterval(() => {
    const progress = Math.min(1, (performance.now() - formingChargeStartedAt) / 1000);
    if (fill) fill.style.width = (progress * 100) + "%";
    hud?.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  }, 25);
}
function releaseFormingCharge(cancelled = false) {
  if (!formingChargeStartedAt) return;
  const elapsed = performance.now() - formingChargeStartedAt;
  formingChargeStartedAt = 0;
  if (formingChargeTimer) clearInterval(formingChargeTimer);
  formingChargeTimer = null;
  const hud = document.getElementById("bowChargeHud");
  hud?.classList.add("hidden");
  const fill = document.getElementById("bowChargeFill");
  if (fill) fill.style.width = "0%";
  const label = hud?.querySelector("span");
  if (label) label.textContent = "弓のチャージ";
  hud?.setAttribute("aria-label", "弓のチャージ");
  if (cancelled || selectedWeapon !== "formingGun") socket.emit("formingCancel");
  else socket.emit("formingRelease");
}

function startFiring(forceRepeat = false) {
  if (selectedGameMode === "Build") {
    buildPreviewActive = false;
    updateBuildPreview();
  }
  if (selectedWeapon === "sword") {
    if (swordPressStartedAt || swordGuardActive || swordAirAttack) return;
    const airborneOrJustJumped = myState?.grounded === false || Date.now() - lastLocalJumpInputAt <= 900;
    const cooldownRemaining = swordMeleeLocalReadyAt - performance.now();
    if (airborneOrJustJumped) {
      if (cooldownRemaining > 0) return;
      // 空中ではガードを開始せず、押した瞬間にジャンプ攻撃を発動する。
      swordAirAttack = true;
      swordMeleeLocalReadyAt = performance.now() + (weaponConfig.sword?.fireInterval || 650);
      swordLeapLocalUntil = performance.now() + 1000;
      fire();
      return;
    }
    swordPressStartedAt = Date.now();
    if (cooldownRemaining > 0) {
      // 振り終わり前から押し続けている場合、クールタイム終了と同時にガードへ移行する。
      swordGuardQueued = true;
      if (swordGuardQueueTimer) clearTimeout(swordGuardQueueTimer);
      swordGuardQueueTimer = setTimeout(beginQueuedSwordGuard, cooldownRemaining);
      return;
    }
    // 攻撃可能な地上状態では押した瞬間にガードを開始する。
    swordGuardActive = true;
    socket.emit("swordGuardStart");
    return;
  }
  if(selectedWeapon==="railgun"){startRailgunCharge();return;}
  if(selectedWeapon==="formingGun"){startFormingCharge();return;}
  if(["flamethrower","laserBeam","freezeCannon"].includes(selectedWeapon)){socket.emit("beamStart");return;}
  if (selectedWeapon === "bow") { startBowCharge(); return; }
  if (selectedWeapon === "minigun") { startMinigunCharge(); return; }
  fire();
  const cfg = weaponConfig[selectedWeapon];
  if ((!cfg.automatic && !forceRepeat) || autoFireTimer) return;
  autoFireTimer = setInterval(fire, cfg.fireInterval);
}

function stopFiring(cancelled = false) {
  if (swordAirAttack) {
    swordAirAttack = false;
    return;
  }
  if (selectedWeapon === "sword" || swordPressStartedAt || swordGuardActive || swordGuardQueued) {
    const heldFor = swordPressStartedAt ? Date.now() - swordPressStartedAt : Infinity;
    const wasQueuedForCooldown = swordGuardQueued;
    swordPressStartedAt = 0;
    swordGuardQueued = false;
    if (swordGuardQueueTimer) {
      clearTimeout(swordGuardQueueTimer);
      swordGuardQueueTimer = null;
    }
    if (swordGuardActive) {
      swordGuardActive = false;
      socket.emit("swordGuardStop");
    }
    // クールタイム中に押して離した入力は攻撃に変換しない。押し続けた場合のみ終了時にガードする。
    if (!wasQueuedForCooldown && !cancelled && heldFor < 180 && selectedWeapon === "sword" && performance.now() >= swordMeleeLocalReadyAt) {
      // fire()より先に次の攻撃可能時刻を確定し、連打・多重pointerイベントを抑止。
      swordMeleeLocalReadyAt = performance.now() + (weaponConfig.sword?.fireInterval || 650);
      fire();
    }
    return;
  }
  // 押し始めた武器のチャージだけを解放し、現在選択中の武器名で誤判定しない。
  if (railgunChargeStartedAt) { releaseRailgunCharge(); return; }
  if (formingChargeStartedAt) { releaseFormingCharge(cancelled); return; }
  if (bowChargeStartedAt) { releaseBowCharge(); return; }
  if (minigunCharging) { releaseMinigunCharge(); return; }
  if (["flamethrower", "laserBeam", "freezeCannon"].includes(selectedWeapon)) socket.emit("beamStop");
  if (autoFireTimer) {
    clearInterval(autoFireTimer);
    autoFireTimer = null;
  }
}

function cancelFiringForWeaponSwitch() {
  swordPressStartedAt = 0;
  swordGuardQueued = false;
  if (swordGuardQueueTimer) {
    clearTimeout(swordGuardQueueTimer);
    swordGuardQueueTimer = null;
  }
  if (swordGuardActive) {
    swordGuardActive = false;
    socket.emit("swordGuardStop");
  }
  if (autoFireTimer) {
    clearInterval(autoFireTimer);
    autoFireTimer = null;
  }
  // 武器切替は「発射」ではなくキャンセル。チャージ中の武器が切り替わっても誤発射しない。
  if (formingChargeStartedAt) releaseFormingCharge(true);
  if (railgunChargeStartedAt) {
    railgunChargeStartedAt = 0;
    if (railgunChargeTimer) clearInterval(railgunChargeTimer);
    railgunChargeTimer = null;
  }
  if (bowChargeStartedAt) {
    bowChargeStartedAt = 0;
    if (bowChargeInterval) clearInterval(bowChargeInterval);
    bowChargeInterval = null;
    resetBowChargeScope();
  }
  if (minigunCharging || minigunDraining || minigunChargeValue > 0) cancelMinigunCharge();
  swordPressStartedAt = 0;
  swordAirAttack = false;
  if (swordGuardActive) {
    swordGuardActive = false;
    socket.emit("swordGuardStop");
  }
  if (["flamethrower", "laserBeam", "freezeCannon"].includes(selectedWeapon)) socket.emit("beamStop");
  const hud = document.getElementById("bowChargeHud");
  hud?.classList.add("hidden");
  const fill = document.getElementById("bowChargeFill");
  if (fill) fill.style.width = "0%";
  const label = hud?.querySelector("span");
  if (label) label.textContent = "弓のチャージ";
  hud?.setAttribute("aria-label", "弓のチャージ");
}

function stopAllControls() {
  stopFiring();
  movement.forward = false;
  movement.back = false;
  movement.left = false;
  movement.right = false;
  joystick.forward = 0;
  joystick.strafe = 0;
  crouchHeld = false;
  resetJoystick();
}

function requestRespawn() {
  if (!joined || !myState || myState.health > 0) return false;

  const respawnAt = Number(myState.respawnAt) || 0;
  if (respawnAt > Date.now()) return false;

  socket.emit("respawn");
  controllerRespawnRequested = true;
  return true;
}

function showRespawnPanel() {
  const panel = document.getElementById("respawnPanel");
  const button = document.getElementById("respawnButton");
  const text = document.getElementById("respawnText");
  const touchUi = document.getElementById("touchUi");

  panel?.classList.remove("hidden");
  touchUi?.classList.add("hidden");
  controllerRespawnRequested = false;
  autoRespawnRequested = false;
  if (button) button.disabled = true;
  if (respawnTimer) clearInterval(respawnTimer);

  const target = Number(myState?.respawnAt) || (Date.now() + 5000);

  const update = () => {
    const remaining = Math.max(0, target - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    if (text) text.textContent = seconds > 0 ? ("リスポーンまで " + seconds + "秒") : "リスポーンできます";
    if (button) button.disabled = remaining > 0;
    if (remaining <= 0 && gameSettings.autoRespawnEnabled && !autoRespawnRequested) {
      autoRespawnRequested = true;
      socket.emit("respawn");
    }
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
  autoRespawnRequested = false;
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

function addDamageNumber(damage, zone, x, y, z, damageType = "health") {
  const container = document.getElementById("damageNumbers");
  if (!container) return;

  const el = document.createElement("div");
  el.className = "damage-number " + (damageType === "shield" ? "shield-damage" : "health-damage") + (zone === "head" ? " head critical" : "");
  el.textContent = String(Math.max(1, Math.round(damage)));

  // 被弾したプレイヤーのワールド座標を画面座標へ変換し、その周辺に表示する。
  const hasPosition = [x, y, z].every(value => Number.isFinite(Number(value)));
  if (hasPosition) {
    const projected = new THREE.Vector3(Number(x), Number(y), Number(z)).project(camera);
    if (projected.z >= -1 && projected.z <= 1) {
      el.style.left = ((projected.x * 0.5 + 0.5) * innerWidth + (Math.random() - 0.5) * 18) + "px";
      el.style.top = ((-projected.y * 0.5 + 0.5) * innerHeight + (Math.random() - 0.5) * 14) + "px";
    } else {
      el.style.left = "50%";
      el.style.top = "44%";
    }
  } else {
    el.style.left = "50%";
    el.style.top = "44%";
  }

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
  if (event.weapon === "railgun") {
    const start = new THREE.Vector3(event.x, event.y, event.z);
    const pellet = event.tracers?.[0] || {};
    const dir = directionFromAngles(pellet.yaw ?? event.yaw, pellet.pitch ?? event.pitch);
    const distance = Math.max(0, Number(pellet.distance) || 150);
    const end = new THREE.Vector3(
      pellet.x ?? start.x + dir.x * distance,
      pellet.y ?? start.y + dir.y * distance,
      pellet.z ?? start.z + dir.z * distance
    );
    // サーバー側のレールガン当たり判定と同じ半径2mで表示する。
    // 深度テストを無効にして、地形や敵モデルに隠れてビーム自体が見えなくなるのを防ぐ。
    const beamVector = end.clone().sub(start);
    const beamLength = Math.max(0.001, beamVector.length());
    const beamDirection = beamVector.clone().normalize();
    const hitRadius = 2;
    const geometry = new THREE.CylinderGeometry(hitRadius, hitRadius, beamLength, 24, 1, true);
    const material = new THREE.MeshBasicMaterial({
      color: 0x8cecff,
      transparent: true,
      opacity: 0.24,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });
    const line = new THREE.Mesh(geometry, material);
    line.position.copy(start).add(end).multiplyScalar(0.5);
    line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), beamDirection);
    line.renderOrder = 1000;
    scene.add(line);
    tracers.push({ line, dot: null, start, end, born: performance.now(), life: 110 });
    return;
  }
  if (event.weapon === "pickaxe" || event.weapon === "sword" || event.weapon === "smoke" || event.weapon === "grenadeLauncher" || event.weapon === "rocketLauncher" || event.weapon === "shockwaveLauncher" || event.weapon === "grappler") {
    if (event.id !== myId) startRemoteWeaponAction(event);
    else if (event.weapon === "sword" && event.action === "leap") startLocalWeaponAction("swordLeap");
    return;
  }
  // マークスマンは専用の弾道表示を使わない。
  if (event.weapon === "marksman") return;
  const start = new THREE.Vector3(event.x, event.y, event.z);
  const entries = Array.isArray(event.tracers) && event.tracers.length
    ? event.tracers
    : [{ yaw: event.yaw, pitch: event.pitch, distance: event.hit ? 18 : 12 }];

  // レールガンは高エネルギー弾として、長めの青白いトレーサーで表示する。
  const bulletColor = event.weapon === "railgun" ? 0x8cecff : 0xffe0a3;
  const isRifle = ["smg", "rifle", "marksman", "sniper"].includes(event.weapon);

  for (const pellet of entries) {
    const dir = directionFromAngles(pellet.yaw, pellet.pitch);
    const distance = Number(pellet.distance) || 12;
    const end = new THREE.Vector3(
      pellet.x ?? (start.x + dir.x * distance),
      pellet.y ?? (start.y + dir.y * distance),
      pellet.z ?? (start.z + dir.z * distance)
    );

    let line = null;

    // アサルトライフルは弾頭に短いトレーサーを付ける。
    // 弾そのものが長い線に見えないよう、線は弾の後ろだけに短く表示する。
    if (isRifle || event.weapon === "railgun") {
      const geometry = new THREE.BufferGeometry().setFromPoints([start, start]);
      const material = new THREE.LineBasicMaterial({
        color: bulletColor,
        transparent: true,
        opacity: event.weapon === "railgun" ? 1 : .8
      });
      line = new THREE.Line(geometry, material);
      if (event.weapon === "railgun") line.userData.railgunTracer = true;
      else line.userData.rifleTracer = true;
      scene.add(line);
    } else {
      const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
      const material = new THREE.LineBasicMaterial({
        color: bulletColor,
        transparent: true,
        opacity: .9
      });
      line = new THREE.Line(geometry, material);
      scene.add(line);
    }

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(
        event.weapon === "railgun" ? 1.3 : isRifle ? .075 : event.weapon === "shotgun" ? .06 : .045,
        8,
        8
      ),
      new THREE.MeshBasicMaterial({ color: bulletColor })
    );
    dot.position.copy(start);
    scene.add(dot);

    tracers.push({
      line,
      dot,
      start: start.clone(),
      end: end.clone(),
      born: performance.now(),
      life: event.weapon === "railgun" ? 650 : isRifle ? 150 : event.weapon === "shotgun" ? 135 : 120
    });
  }
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
  const hasAmmoMagazine = !["pickaxe", "smoke", "bow", "minigun", "shockwaveLauncher"].includes(selectedWeapon);
  ammoEl.textContent = myState.reloading ? "RELOADING..." : hasAmmoMagazine ? `${ammo} / ∞` : "弾薬不要";
  for (const id of ["reloadButton", "reloadTouchButton"]) {
    const reloadControl = document.getElementById(id);
    if (reloadControl) {
      reloadControl.classList.toggle("hidden", !hasAmmoMagazine);
      reloadControl.disabled = !hasAmmoMagazine;
    }
  }
  const nameEl = document.getElementById("weaponName");
  if (nameEl) nameEl.textContent = weaponDisplayName(myState.weapon) + " · " + (Number(myState.activeWeaponSlot || 0) + 1) + "/2";
  updateWeaponSwitchButton();
}

document.getElementById("respawnButton")?.addEventListener("click", () => {
  if (!joined || !myState || myState.health > 0) return;
  if (myState.respawnAt && Date.now() < myState.respawnAt) return;
  socket.emit("respawn");
});

socket.on("world", buildWorld);
socket.on("buildStructureUpdate", (data) => {
  if (selectedGameMode === "Build" && data?.map?.id === "build-world") buildWorld(data);
});
socket.on("riftDuelResult", data => showMessage(data?.won ? "鏡界の勝者！元の場所へ戻りました。3秒間無敵です。" : "鏡界で敗北しました。通常のデスとして処理されます。"));

const mapChangeCountdownElement = document.getElementById("mapChangeCountdown");
let mapChangeNoticeTimeout = null;

function displayMapChangeCountdown(seconds, nextMap) {
  if (!mapChangeCountdownElement) return;
  if (mapChangeNoticeTimeout) {
    clearTimeout(mapChangeNoticeTimeout);
    mapChangeNoticeTimeout = null;
  }
  const nextName = nextMap?.name ? "（次：" + nextMap.name + "）" : "";
  mapChangeCountdownElement.textContent = "マップ変更まで " + seconds + "秒 " + nextName;
  mapChangeCountdownElement.classList.remove("hidden");
}

socket.on("mapRotationStatus", (status = {}) => {
  if (!joined || selectedGameMode !== "Melee") return;
  const remaining = Number(status.changeAt) - Date.now();
  if (remaining > 0 && remaining <= 5000) {
    displayMapChangeCountdown(Math.max(1, Math.ceil(remaining / 1000)), status.nextMap);
  }
});

socket.on("mapChangeCountdown", ({ seconds, nextMap } = {}) => {
  if (!joined || selectedGameMode !== "Melee") return;
  displayMapChangeCountdown(seconds, nextMap);
});

socket.on("mapChanged", ({ map } = {}) => {
  if (selectedGameMode !== "Melee") return;
  stopAllControls();
  setScopeEnabled(false);
  yaw = 0;
  pitch = 0;
  // worldイベントとの順序差で旧マップの描画が残った場合に備え、切替通知時にも再構築する。
  if (worldData) buildWorld(worldData);
  if (!mapChangeCountdownElement) return;

  if (mapChangeNoticeTimeout) clearTimeout(mapChangeNoticeTimeout);
  mapChangeCountdownElement.textContent = "マップ変更：" + (map?.name || "新しいマップ");
  mapChangeCountdownElement.classList.remove("hidden");
  mapChangeNoticeTimeout = setTimeout(() => {
    mapChangeCountdownElement.classList.add("hidden");
    mapChangeNoticeTimeout = null;
  }, 3000);
});

const payloadQueuePanel = document.getElementById("payloadQueuePanel");
const payloadQueueStatusText = document.getElementById("payloadQueueStatus");
const payloadQueueCountText = document.getElementById("payloadQueueCount");
const payloadQueueTimeText = document.getElementById("payloadQueueTime");
const payloadQueueProgressFill = document.getElementById("payloadQueueProgressFill");
const areaQueuePanel = document.getElementById("areaQueuePanel");
const areaQueueStatusText = document.getElementById("areaQueueStatus");
const areaQueueCountText = document.getElementById("areaQueueCount");
const areaQueueTimeText = document.getElementById("areaQueueTime");
const areaQueueProgressFill = document.getElementById("areaQueueProgressFill");

socket.on("areaQueueStatus", (status = {}) => {
  if (!areaQueuePanel || joined) return;
  const remainingMs = Math.max(0, Number(status.remainingMs) || 0);
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (areaQueueStatusText) {
    areaQueueStatusText.textContent = seconds > 0
      ? "対戦相手を募集しています。"
      : "対戦を準備しています。";
  }
  if (areaQueueCountText) areaQueueCountText.textContent = (Number(status.waiting) || 0) + " / 6 人";
  if (areaQueueTimeText) areaQueueTimeText.textContent = seconds + "秒";
  if (areaQueueProgressFill) areaQueueProgressFill.style.width =
    Math.max(0, Math.min(100, 100 - remainingMs / 20000 * 100)) + "%";
});

socket.on("areaQueueError", ({ message } = {}) => {
  if (areaQueueStatusText) areaQueueStatusText.textContent = message || "マッチメイキングに失敗しました。";
});

socket.on("areaQueueCancelled", () => {
  areaQueuePanel?.classList.add("hidden");
  document.getElementById("modeScreen")?.classList.remove("hidden");
  selectedGameMode = "Melee";
  wasJoinedBeforeDisconnect = false;
});

socket.on("areaMatchStarted", ({ team, botCount, map } = {}) => {
  selectedGameMode = "Area";
  areaQueuePanel?.classList.add("hidden");
  document.getElementById("areaResultPanel")?.classList.add("hidden");
  document.getElementById("areaHud")?.classList.remove("hidden");
  const teamLabel = document.getElementById("areaTeamLabel");
  if (teamLabel) teamLabel.textContent = "あなた：" + (team === "blue" ? "BLUE" : "RED");
  showMessage((map?.name ? map.name + " · " : "") + "エリア対戦開始" + (botCount ? "（BOT " + botCount + "人）" : ""));
});


socket.on("payloadQueueStatus", status => {
  if (!payloadQueuePanel || joined) return;
  if (selectedGameMode === "Payload") { payloadQueuePanel.classList.remove("hidden"); document.getElementById("modeScreen")?.classList.add("hidden"); }
  const remaining = Math.max(0, Number(status.remainingMs) || 0);
  const seconds = Math.ceil(remaining / 1000);
  if (payloadQueueStatusText) payloadQueueStatusText.textContent = seconds ? "対戦相手を募集しています。" : "BOTを補充して試合を準備しています。";
  if (payloadQueueCountText) payloadQueueCountText.textContent = (Number(status.waiting) || 0) + " / 6 人";
  if (payloadQueueTimeText) payloadQueueTimeText.textContent = seconds + "秒";
  if (payloadQueueProgressFill) payloadQueueProgressFill.style.width = Math.max(0, Math.min(100, 100 - remaining / 20000 * 100)) + "%";
});
socket.on("payloadQueueError", ({ message } = {}) => {
  if (payloadQueueStatusText) payloadQueueStatusText.textContent = message || "マッチメイキングに失敗しました。";
});
socket.on("payloadQueueCancelled", () => {
  payloadQueuePanel?.classList.add("hidden");
  document.getElementById("modeScreen")?.classList.remove("hidden");
  selectedGameMode = "Melee";
  wasJoinedBeforeDisconnect = false;
});
socket.on("payloadMatchStarted", ({ team, role, botCount, map } = {}) => {
  selectedGameMode = "Payload";
  payloadRole = role || null;
  payloadQueuePanel?.classList.add("hidden");
  document.getElementById("payloadResultPanel")?.classList.add("hidden");
  document.getElementById("payloadHud")?.classList.remove("hidden");
  const teamLabel = document.getElementById("payloadTeamLabel");
  if (teamLabel) teamLabel.textContent = (role === "attack" ? "攻撃側" : "防衛側") + " · " + (team === "blue" ? "BLUE" : "RED");
  showMessage((map?.name ? map.name + " · " : "") + "ペイロード開始" + (botCount ? "（BOT " + botCount + "人）" : ""));
});
socket.on("payloadState", state => {
  if (state.matchId !== myState?.matchId || selectedGameMode !== "Payload") return;
  updatePayloadGateColors(state.attackingTeam);
  updatePayloadCartVisual(state.cart);
  const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
  const fill = document.getElementById("payloadProgressFill");
  const progressText = document.getElementById("payloadProgressText");
  if (fill) fill.style.width = progress + "%";
  if (progressText) progressText.textContent = Math.floor(progress) + "%";
  const timer = Math.max(0, Number(state.timeRemainingMs) || 0);
  const minutes = Math.floor(timer / 60000);
  const seconds = Math.floor(timer % 60000 / 1000);
  const timerText = document.getElementById("payloadTimer");
  if (timerText) timerText.textContent = state.overtime ? "延長戦" : String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  const status = document.getElementById("payloadStatus");
  if (status) {
    if (state.status === "contested") status.textContent = "争奪中 · 防衛側がカートを停止";
    else if (state.status === "pushing") status.textContent = "攻撃側がペイロードを護送中";
    else status.textContent = "ペイロード周辺を確保してください";
  }
  const counts = document.getElementById("payloadPresence");
  if (counts) counts.textContent = "攻撃 " + (Number(state.attackers) || 0) + "人 / 防衛 " + (Number(state.defenders) || 0) + "人";
});
socket.on("payloadCheckpoint", ({ checkpointIndex } = {}) => {
  showMessage("チェックポイント " + (Number(checkpointIndex) || 0) + " 到達 · 再出撃地点を更新");
});
socket.on("payloadMatchEnd", result => {
  stopAllControls();
  const won = Boolean(result.won);
  const title = document.getElementById("payloadResultTitle");
  const summary = document.getElementById("payloadResultSummary");
  if (title) { title.textContent = won ? "勝利" : "敗北"; title.classList.toggle("area-result-win", won); }
  const role = result.winnerRole === "attack" ? "攻撃側" : "防衛側";
  if (summary) summary.textContent = role + "が勝利しました。ペイロード進行率：" + Math.floor(Number(result.progress) || 0) + "%";
  const value = document.getElementById("payloadResultProgress");
  if (value) value.textContent = Math.floor(Number(result.progress) || 0) + "%";
  const kills = document.getElementById("payloadResultKills");
  const deaths = document.getElementById("payloadResultDeaths");
  const kd = document.getElementById("payloadResultKD");
  const k = Number(result.kills) || 0, d = Number(result.deaths) || 0;
  if (kills) kills.textContent = String(k);
  if (deaths) deaths.textContent = String(d);
  if (kd) kd.textContent = d ? (k / d).toFixed(2) : (k ? "∞" : "0.00");
  document.getElementById("payloadHud")?.classList.add("hidden");
  document.getElementById("payloadResultPanel")?.classList.remove("hidden");
});
document.getElementById("cancelPayloadQueueButton")?.addEventListener("click", () => socket.emit("cancelPayloadQueue"));
document.getElementById("payloadResultCloseButton")?.addEventListener("click", () => socket.emit("leavePayloadMatch"));
socket.on("payloadReturnToModeSelect", () => {
  joined = false;
  wasJoinedBeforeDisconnect = false;
  reconnecting = false;
  areaResultOpen = false;
  payloadRole = null;
  selectedGameMode = "Melee";
  updateBuildToolbar();
  buildPreviewActive = true;
  myId = null;
  myState = null;
  stopAllControls();
  setScopeEnabled(false);
  document.getElementById("payloadQueuePanel")?.classList.add("hidden");
  document.getElementById("payloadResultPanel")?.classList.add("hidden");
  document.getElementById("payloadHud")?.classList.add("hidden");
  document.getElementById("hud")?.classList.add("hidden");
  document.getElementById("touchUi")?.classList.add("hidden");
  document.getElementById("settingsButton")?.classList.add("hidden");
  document.getElementById("settingsPanel")?.classList.add("hidden");
  document.getElementById("weaponScreen")?.classList.toggle("hidden", lobbyScreenAfterLeave !== "weaponScreen");
  document.getElementById("modeScreen")?.classList.toggle("hidden", lobbyScreenAfterLeave !== "modeScreen");
  lobbyScreenAfterLeave = "modeScreen";
  mapChangeCountdownElement?.classList.add("hidden");
});

socket.on("areaState", (state = {}) => {
  if (state.matchId !== myState?.matchId || selectedGameMode !== "Area") return;
  const blue = Math.max(0, Math.min(100, Number(state.scores?.blue) || 0));
  const red = Math.max(0, Math.min(100, Number(state.scores?.red) || 0));
  const blueFill = document.getElementById("areaBlueFill");
  const redFill = document.getElementById("areaRedFill");
  const blueText = document.getElementById("areaBlueScore");
  const redText = document.getElementById("areaRedScore");
  if (blueFill) blueFill.style.width = blue + "%";
  if (redFill) redFill.style.width = red + "%";
  if (blueText) blueText.textContent = Math.floor(blue) + "%";
  if (redText) redText.textContent = Math.floor(red) + "%";

  const statusEl = document.getElementById("areaCaptureStatus");
  if (!statusEl) return;

  const teamName = (team) => team === "blue" ? "BLUE" : "RED";
  const ownerTeam = state.ownerTeam || null;
  const captureTeam = state.captureTeam || null;
  const seconds = Math.max(0, (Number(state.holdRemainingMs) || 0) / 1000);

  if (state.status === "contested") {
    statusEl.textContent = ownerTeam
      ? "争奪中 · 現在の制圧チーム：" + teamName(ownerTeam)
      : "争奪中：どちらのチームもまだ確保していません";
  } else if (captureTeam && captureTeam !== ownerTeam) {
    if (ownerTeam) {
      statusEl.textContent = teamName(captureTeam) + " が奪取中 · 所有権切替まで " +
        seconds.toFixed(1) + "秒";
    } else {
      statusEl.textContent = teamName(captureTeam) + " が確保中 · 所有権取得まで " +
        seconds.toFixed(1) + "秒";
    }
  } else if (ownerTeam) {
    // エリアが無人の間も得点は進むが、状態表示には「カウント進行中」を出さない。
    statusEl.textContent = state.status === "owned-empty"
      ? "制圧チーム：" + teamName(ownerTeam)
      : "制圧チーム：" + teamName(ownerTeam) + " · カウント進行中";
  } else {
    statusEl.textContent = "中央エリアを確保してください";
  }
});

socket.on("areaMatchEnd", (result = {}) => {
  areaResultOpen = true;
  stopAllControls();
  const won = Boolean(result.won);
  const title = document.getElementById("areaResultTitle");
  const summary = document.getElementById("areaResultSummary");
  if (title) {
    title.textContent = won ? "勝利" : "敗北";
    title.classList.toggle("area-result-win", won);
  }
  if (summary) {
    const winner = result.winnerTeam === "blue" ? "BLUE" : "RED";
    summary.textContent = winner + "チームがエリアを100%まで制圧しました。あなたのチーム：" +
      (result.team === "blue" ? "BLUE" : "RED");
  }
  const blueScore = document.getElementById("areaResultBlueScore");
  const redScore = document.getElementById("areaResultRedScore");
  if (blueScore) blueScore.textContent = Math.round(result.scores?.blue || 0) + "%";
  if (redScore) redScore.textContent = Math.round(result.scores?.red || 0) + "%";
  const kills = Number(result.kills) || 0;
  const deaths = Number(result.deaths) || 0;
  document.getElementById("areaResultKills").textContent = String(kills);
  document.getElementById("areaResultDeaths").textContent = String(deaths);
  document.getElementById("areaResultKD").textContent = deaths ? (kills / deaths).toFixed(2) : (kills ? "∞" : "0.00");
  document.getElementById("areaHud")?.classList.add("hidden");
  document.getElementById("areaResultPanel")?.classList.remove("hidden");
});

document.getElementById("cancelAreaQueueButton")?.addEventListener("click", () => {
  socket.emit("cancelAreaQueue");
});

document.getElementById("areaResultCloseButton")?.addEventListener("click", () => {
  socket.emit("leaveAreaMatch");
});

socket.on("areaReturnToModeSelect", () => {
  joined = false;
  wasJoinedBeforeDisconnect = false;
  reconnecting = false;
  areaResultOpen = false;
  selectedGameMode = "Melee";
  myId = null;
  myState = null;
  stopAllControls();
  setScopeEnabled(false);
  document.getElementById("areaResultPanel")?.classList.add("hidden");
  document.getElementById("areaQueuePanel")?.classList.add("hidden");
  document.getElementById("areaHud")?.classList.add("hidden");
  document.getElementById("hud")?.classList.add("hidden");
  document.getElementById("touchUi")?.classList.add("hidden");
  document.getElementById("settingsButton")?.classList.add("hidden");
  document.getElementById("settingsPanel")?.classList.add("hidden");
  document.getElementById("weaponScreen")?.classList.toggle("hidden", lobbyScreenAfterLeave !== "weaponScreen");
  document.getElementById("modeScreen")?.classList.toggle("hidden", lobbyScreenAfterLeave !== "modeScreen");
  lobbyScreenAfterLeave = "modeScreen";
  mapChangeCountdownElement?.classList.add("hidden");
});

socket.on("returnedToLobby", () => {
  joined = false;
  wasJoinedBeforeDisconnect = false;
  reconnecting = false;
  areaResultOpen = false;
  selectedGameMode = "Melee";
  updateBuildToolbar();
  buildPreviewActive = true;
  myId = null;
  myState = null;
  stopAllControls();
  setScopeEnabled(false);
  for (const id of [
    "weaponScreen", "modeScreen", "areaQueuePanel", "areaResultPanel", "payloadQueuePanel", "payloadResultPanel", "payloadHud", "hud", "touchUi",
    "settingsPanel", "duelResultScreen", "duelScoreHud"
  ]) {
    document.getElementById(id)?.classList.add("hidden");
  }
  showDuelScreen(null);
  duelSelectedRoomId = null;
  duelChangingRules = false;
  duelRoomCreating = false;
  document.getElementById("duelRematchReadyButton")?.classList.add("hidden");
  document.getElementById("duelRematchReadyButton")?.removeAttribute("disabled");
  document.getElementById("areaHud")?.classList.add("hidden");
  document.getElementById("settingsButton")?.classList.add("hidden");
  document.getElementById("weaponScreen")?.classList.toggle("hidden", lobbyScreenAfterLeave !== "weaponScreen");
  document.getElementById("modeScreen")?.classList.toggle("hidden", lobbyScreenAfterLeave !== "modeScreen");
  lobbyScreenAfterLeave = "modeScreen";
  mapChangeCountdownElement?.classList.add("hidden");
});

window.applyPlayerSkinToServer = (skinDataUrl) => {
  if (!joined || !socket.connected || typeof skinDataUrl !== "string") {
    return Promise.resolve({ ok: false, notInGame: true });
  }

  return new Promise((resolve) => {
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      if (result?.ok) showMessage("スキンを変更しました");
      resolve(result || { ok: false, reason: "no-response" });
    };
    const timeoutId = setTimeout(() => finish({ ok: false, reason: "timeout" }), 5000);
    socket.emit("updateSkin", skinDataUrl, finish);
  });
};

socket.on("joined", ({ player }) => {
  joined = true;
  socket.emit("requestSmokeState");
  socket.emit("requestGrenadeState");
  // join時の初回world通知に依存せず、参加確定後にマップデータを再取得する。
  socket.emit("requestWorld");
  wasJoinedBeforeDisconnect = true;
  reconnecting = false;
  selectedGameMode = player.mode || "Melee";
  areaResultOpen = false;
  playerName = player.name || playerName;
  setCookie("fps_player_name", playerName);
  selectedWeapon = player.weapon || selectedWeapon;
  weaponSlots = Array.isArray(player.weaponSlots) ? [...player.weaponSlots] : [selectedWeapon, selectedWeapon === "rifle" ? "shotgun" : "rifle"];
  selectedPrimaryWeapon = weaponSlots[0] || selectedWeapon;
  selectedSecondaryWeapon = weaponSlots[1] || (selectedWeapon === "rifle" ? "shotgun" : "rifle");
  selectedCharm = ["hp", "speed", "reload", "jump", "floor", "aim", "ultimate", "body"].includes(player.charm) ? player.charm : "none";
  selectedUltimate = ["skyfall", "teleport", "aegis", "invisible", "rift", "tornado"].includes(player.ultimateType) ? player.ultimateType : "skyfall";
  activeWeaponSlot = Number(player.activeWeaponSlot) || 0;
  setScopeEnabled(false);
  myId = player.id;
  myState = player;
  yaw = player.yaw;
  pitch = player.pitch;

  document.getElementById("weaponScreen").classList.add("hidden");
  document.getElementById("modeScreen")?.classList.add("hidden");
  document.getElementById("areaQueuePanel")?.classList.add("hidden");
  document.getElementById("areaResultPanel")?.classList.add("hidden");
  document.getElementById("payloadQueuePanel")?.classList.add("hidden");
  document.getElementById("payloadResultPanel")?.classList.add("hidden");
  showDuelScreen(null);
  document.getElementById("duelResultScreen")?.classList.add("hidden");
  document.getElementById("duelScoreHud")?.classList.toggle("hidden", selectedGameMode !== "Duel");
  if(selectedGameMode==="Duel"){const label=document.getElementById("duelRoundLabel");if(label)label.textContent="先取 "+duelCurrentFirstTo+" 本";}
  document.getElementById("hud").classList.remove("hidden");
  document.getElementById("touchUi").classList.remove("hidden");
  document.getElementById("settingsButton")?.classList.remove("hidden");
  document.getElementById("areaHud")?.classList.toggle("hidden", selectedGameMode !== "Area");
  document.getElementById("payloadHud")?.classList.toggle("hidden", selectedGameMode !== "Payload");
  updateBuildToolbar();
  payloadRole = player.role || payloadRole;
  const areaTeamLabel = document.getElementById("areaTeamLabel");
  if (areaTeamLabel) areaTeamLabel.textContent = selectedGameMode === "Area"
    ? "あなた：" + (player.team === "blue" ? "BLUE" : "RED")
    : "";
  const payloadTeamLabel = document.getElementById("payloadTeamLabel");
  if (payloadTeamLabel && selectedGameMode === "Payload") payloadTeamLabel.textContent = (payloadRole === "attack" ? "攻撃側" : "防衛側") + " · " + (player.team === "blue" ? "BLUE" : "RED");
  setConnectionStatus("接続済み", true);
  updateAmmoHud();
  updateWeaponSwitchButton();
  closeInventory();
  updateBuildToolbar();
  if (reconnecting) showMessage("サーバーに再接続しました");
});

socket.on("players", updateRemotePlayers);
socket.on("playerSkin", ({ id, skin }) => {
  const playerObject = remotePlayers.get(id);
  if (playerObject && skin) applyPlayerSkin(playerObject, skin);
});

function updateSelfFrozenHud() {
  let hud = document.getElementById("selfFrozenHud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "selfFrozenHud";
    Object.assign(hud.style, {
      position: "fixed", left: "50%", top: "17%", transform: "translateX(-50%)",
      zIndex: "10000", padding: "12px 24px", borderRadius: "12px",
      border: "2px solid rgba(150,235,255,.95)", background: "rgba(5,35,55,.88)",
      color: "#c9f7ff", font: "bold 24px sans-serif", letterSpacing: ".08em",
      textShadow: "0 2px 8px #00131d", boxShadow: "0 0 22px rgba(80,210,255,.55)",
      pointerEvents: "none", display: "none", whiteSpace: "nowrap"
    });
    hud.textContent = "❄ 凍結中";
    document.body.appendChild(hud);
  }
  const remaining = Math.max(0, Number(myState?.frozenUntil || 0) - Date.now());
  hud.style.display = joined && myState?.health > 0 && remaining > 0 ? "block" : "none";
  if (remaining > 0) hud.textContent = "❄ 凍結中 " + (remaining / 1000).toFixed(1) + "秒";
}

socket.on("state", (players) => {
  updateRemotePlayers(players);
  updateSelfFrozenHud();
  updateCamera();

  if (myState) {
    const maxHp = Math.max(100, Number(myState.maxHealth) || 100);
    const hp = Math.max(0, Math.min(maxHp, Number(myState.health) || 0));
    const healthValue = document.getElementById("healthValue");
    const healthFill = document.getElementById("healthBarFill");
    if (healthValue) healthValue.textContent = Math.round(hp) + " / " + maxHp;
    if (healthFill) {
      healthFill.style.width = (hp / maxHp * 100) + "%";
      healthFill.style.background = hp > 60 ? "#55d66f" : hp > 30 ? "#e6c84a" : "#e55a5a";
    }
    const shieldFill = document.getElementById("shieldBarFill");
    if (shieldFill) shieldFill.style.width = Math.max(0, Math.min(100, Number(myState.shield) || 0)) + "%";

    const ultimateButton = document.getElementById("ultimateButton");
    if (ultimateButton) {
      const charge = Math.max(0, Math.min(100, Number(myState.ultimateCharge) || 0));
      ultimateButton.style.setProperty("--ultimate-progress", charge + "%");
      ultimateButton.disabled = !joined || Number(myState.health) <= 0 || ultimateRequestPending;
      ultimateButton.textContent = charge >= 100 ? "ULT" : Math.floor(charge) + "%";
    }
    document.getElementById("kills").textContent = String(myState.kills);
    document.getElementById("deaths").textContent = String(myState.deaths);
    updateAmmoHud();

    // リロード中も射撃タイマーは止めない。fire()側でリロード中の発射を抑止し、
    // 完了後に長押しが続いていれば次の発射タイミングで自動再開する。

    if (hp <= 0) {
      stopAllControls();
      showRespawnPanel();
    } else {
      hideRespawnPanel();
    }

    const invulnerabilityHud = document.getElementById("invulnerabilityHud");
    const invulnerableUntil = Number(myState.invulnerableUntil || 0);
    const invRemaining = Math.max(0, invulnerableUntil - Date.now());
    if (invulnerabilityHud) {
      if (invRemaining > 0) {
        invulnerabilityHud.classList.remove("hidden");
        invulnerabilityHud.textContent = "無敵 " + (invRemaining / 1000).toFixed(1) + "秒";
      } else {
        invulnerabilityHud.classList.add("hidden");
      }
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

socket.on("enemyRespawnMarker", (data = {}) => {
  if (!data.playerId || data.playerId === myId) return;
  const enemy = remotePlayers.get(data.playerId)?.userData.playerState;
  const markerTeam = data.team || enemy?.team;
  if ((selectedGameMode === "Area" || selectedGameMode === "Payload") &&
      markerTeam && myState?.team && markerTeam === myState.team) return;
  // players/stateの更新タイミングに左右されないよう、イベント受信時にも記録する。
  addEnemyRespawnMarker(data.playerId, data.x, data.z);
});

socket.on("weaponBeam", setWeaponBeam);
socket.on("shot", createTracer);
socket.on("smokeProjectileSpawn", createSmokeProjectileVisual);
socket.on("smokeProjectileUpdate", (data) => createSmokeProjectileVisual(data));
socket.on("smokeProjectileRemove", ({ id }) => removeSmokeProjectileVisual(id));
socket.on("grappleImpact", data => {
  const ownerId = data.ownerId || data.id;
  const old = grappleTethers.get(ownerId);
  if (old) { scene.remove(old); old.geometry.dispose(); old.material.dispose(); }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(data.x, data.y, data.z)]), new THREE.LineBasicMaterial({ color: 0xe7e7e7 }));
  line.userData.anchor = new THREE.Vector3(data.x, data.y, data.z);
  scene.add(line); grappleTethers.set(ownerId, line);
  setTimeout(() => { if (grappleTethers.get(ownerId) === line) { scene.remove(line); line.geometry.dispose(); line.material.dispose(); grappleTethers.delete(ownerId); } }, 900);
});
socket.on("grenadeProjectileSpawn", createGrenadeProjectileVisual);
socket.on("grenadeProjectileUpdate", createGrenadeProjectileVisual);
socket.on("grenadeProjectileRemove", ({ id }) => removeGrenadeProjectileVisual(id));
socket.on("grenadeExplosion", createGrenadeExplosionVisual);
socket.on("shockwaveBurst", createShockwaveBurstVisual);
socket.on("skyfallTargeting", (data) => createSkyfallImpactVisual({ ...data, targeting: true }));
socket.on("skyfallImpact", (data) => createSkyfallImpactVisual({ ...data, targeting: false }));
socket.on("grenadeState", (projectiles = []) => {
  resetGrenadeVisuals();
  for (const projectile of projectiles) createGrenadeProjectileVisual(projectile);
});
socket.on("smokeCloudSpawn", createSmokeCloudVisual);
socket.on("smokeCloudRemove", ({ id }) => removeSmokeCloudVisual(id));
socket.on("smokeState", ({ projectiles = [], clouds = [] } = {}) => {
  resetSmokeVisuals();
  for (const projectile of projectiles) createSmokeProjectileVisual(projectile);
  for (const cloud of clouds) createSmokeCloudVisual(cloud);
});

socket.on("damageDealt", (event) => {
  const dealtDamage = Math.max(0, Number(event.damage) || 0);
  if (dealtDamage > 0) addDamageNumber(dealtDamage, event.zone, event.x, event.y, event.z, "health");
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
    const rejoinData = {
      name: playerName,
      weapon: weaponSlots[0] || selectedWeapon,
      secondaryWeapon: weaponSlots[1] || selectedSecondaryWeapon,
      charm: selectedCharm,
      ultimateType: selectedUltimate,
      skin: window.getPlayerSkinData?.(),
      reconnectToken: payloadReconnectToken,
      charm: selectedCharm,
      ultimateType: selectedUltimate,
      mode: selectedGameMode === "Build" ? "Build" : selectedGameMode === "Training" ? "Training" : selectedGameMode === "Duel" ? "Duel" : "free-for-all",
      ...(selectedGameMode === "Duel" && duelSelectedRoomId ? { duelRoomId: duelSelectedRoomId } : {})
    };
    if (selectedGameMode === "Payload") {
      document.getElementById("modeScreen")?.classList.add("hidden");
      payloadQueuePanel?.classList.add("hidden");
      showMessage("ペイロードの試合へ復帰しています…");
      socket.emit("joinPayloadQueue", rejoinData);
    } else if (selectedGameMode === "Area") {
      document.getElementById("modeScreen")?.classList.add("hidden");
      document.getElementById("areaResultPanel")?.classList.add("hidden");
      areaQueuePanel?.classList.remove("hidden");
      if (areaQueueStatusText) areaQueueStatusText.textContent = "再接続しました。エリア対戦を再検索しています。";
      socket.emit("joinAreaQueue", rejoinData);
    } else {
      socket.emit("join", rejoinData);
    }
  } else {
    showMessage("サーバー接続済み");
  }
});

// FPS_BACKGROUND_PRESENCE
// バックグラウンドへ移ったら明示的に退出し、復帰時はロビーから接続し直す。
let backgroundLeavePending = false;
let returnToWeaponOnForeground = false;
let backgroundDisconnectTimer = null;
function leaveGameForBackground() {
  if (backgroundLeavePending) return;
  // バックグラウンド退出後のreturnedToLobbyイベントがモード選択へ戻さないようにする。
  lobbyScreenAfterLeave = "weaponScreen";
  backgroundLeavePending = true;
  joined = false;
  wasJoinedBeforeDisconnect = false;
  updateBuildToolbar();
  stopAllControls();
  if (backgroundDisconnectTimer) clearTimeout(backgroundDisconnectTimer);
  backgroundDisconnectTimer = setTimeout(() => {
    if (socket.connected) socket.disconnect();
    backgroundLeavePending = false;
  }, 1200);
  if (socket.connected) {
    socket.timeout(900).emit("leaveMatch", () => {
      if (backgroundDisconnectTimer) clearTimeout(backgroundDisconnectTimer);
      backgroundDisconnectTimer = null;
      if (socket.connected) socket.disconnect();
      backgroundLeavePending = false;
      if (document.visibilityState === "visible" && !socket.connected) socket.connect();
    });
  } else {
    if (backgroundDisconnectTimer) clearTimeout(backgroundDisconnectTimer);
    backgroundDisconnectTimer = null;
    backgroundLeavePending = false;
    socket.disconnect();
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    returnToWeaponOnForeground = true;
    lobbyScreenAfterLeave = "weaponScreen";
    leaveGameForBackground();
  } else if (document.visibilityState === "visible") {
    if (returnToWeaponOnForeground && !joined) {
      returnToWeaponOnForeground = false;
      document.getElementById("modeScreen")?.classList.add("hidden");
      document.getElementById("weaponScreen")?.classList.remove("hidden");
      document.getElementById("topScreen")?.classList.add("hidden");
    }
    if (!socket.connected) socket.connect();
  }
});
window.addEventListener("pagehide", leaveGameForBackground);
window.addEventListener("focus", () => {
  if (document.visibilityState !== "visible") return;
  if (!joined) {
    document.getElementById("modeScreen")?.classList.add("hidden");
    document.getElementById("weaponScreen")?.classList.remove("hidden");
    document.getElementById("topScreen")?.classList.add("hidden");
  }
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && !joined) {
    document.getElementById("modeScreen")?.classList.add("hidden");
    document.getElementById("weaponScreen")?.classList.remove("hidden");
    document.getElementById("topScreen")?.classList.add("hidden");
  }
  if (document.visibilityState === "visible" && !socket.connected) socket.connect();
});
setInterval(() => {
  if (document.visibilityState === "visible" && socket.connected) {
    socket.emit("presence");
  }
}, 10000);

socket.on("disconnect", () => {
  setConnectionStatus("接続中…", false);

  if (joined || (selectedGameMode === "Area" && areaQueuePanel && !areaQueuePanel.classList.contains("hidden")) || (selectedGameMode === "Payload" && payloadQueuePanel && !payloadQueuePanel.classList.contains("hidden"))) {
    wasJoinedBeforeDisconnect = true;
    joined = false;
    updateBuildToolbar();
    stopAllControls();
    showMessage("サーバーとの接続が切れました。再接続しています…");
  }
});

// iPad/iPhoneのホーム画面アプリがバックグラウンドへ移動したら、プレイヤー枠を明示的に解放する。
// 復帰時はページを再読み込みし、古い試合画面への自動再参加を防ぐ。
let leftMatchForBackground = false;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    const inQueue = (selectedGameMode === "Area" && areaQueuePanel && !areaQueuePanel.classList.contains("hidden")) ||
      (selectedGameMode === "Payload" && payloadQueuePanel && !payloadQueuePanel.classList.contains("hidden"));
    if (!joined && !inQueue) return;
    leftMatchForBackground = true;
    if (selectedGameMode === "Area") socket.emit("cancelAreaQueue");
    if (selectedGameMode === "Payload") socket.emit("cancelPayloadQueue");
    if (joined) {
      wasJoinedBeforeDisconnect = false;
      joined = false;
      stopAllControls();
      socket.timeout(1200).emit("leaveMatch", () => socket.disconnect());
      setTimeout(() => { if (socket.connected) socket.disconnect(); }, 1500);
    } else {
      socket.disconnect();
    }
    return;
  }
  if (document.visibilityState === "visible" && leftMatchForBackground) {
    leftMatchForBackground = false;
    document.getElementById("modeScreen")?.classList.add("hidden");
    document.getElementById("weaponScreen")?.classList.remove("hidden");
    document.getElementById("topScreen")?.classList.add("hidden");
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

function updateLoadoutSelectionUi() {
  document.querySelectorAll(".weapon-card").forEach((card) => {
    const id = card.dataset.weapon;
    card.classList.toggle("selected-primary", id === selectedPrimaryWeapon);
    card.classList.toggle("selected-secondary", id === selectedSecondaryWeapon);
    card.classList.toggle("editing-slot", (loadoutSlotToEdit === 0 && id === selectedPrimaryWeapon) || (loadoutSlotToEdit === 1 && id === selectedSecondaryWeapon));
  });
  document.querySelectorAll(".charm-card[data-charm]").forEach(card => card.classList.toggle("selected-charm", card.dataset.charm === selectedCharm));
  document.querySelectorAll("[data-loadout-slot]").forEach(button => button.classList.toggle("active", Number(button.dataset.loadoutSlot) === loadoutSlotToEdit));
  document.querySelector(".weapon-grid-all")?.classList.toggle("hidden", loadoutSlotToEdit >= 2);
  document.getElementById("charmGrid")?.classList.toggle("hidden", loadoutSlotToEdit !== 2);
  document.getElementById("ultimateGrid")?.classList.toggle("hidden", loadoutSlotToEdit !== 3);
  const status = document.getElementById("loadoutSelectionStatus");
  const charmNames = { hp: "HPのお守り", speed: "移動速度のお守り", reload: "リロードのお守り", jump: "ジャンプのお守り", floor: "床のお守り", aim: "オートエイムのお守り", ultimate: "アルティメットのお守り", body: "身体のお守り" };
  const ultimateNames = { skyfall: "天墜", teleport: "空間跳躍", aegis: "蒼天障壁", invisible: "幽影", rift: "鏡界" };
  document.querySelectorAll(".ultimate-card").forEach(card => card.classList.toggle("selected-charm", card.dataset.ultimate === selectedUltimate));
  document.getElementById("ultimateGrid")?.classList.toggle("hidden", loadoutSlotToEdit !== 3);
  const charmName = charmNames[selectedCharm] || "未選択";
  if (status) status.textContent = "1個目：" + weaponDisplayName(selectedPrimaryWeapon) + " ／ 2個目：" + weaponDisplayName(selectedSecondaryWeapon) + " ／ お守り：" + charmName + " ／ アルティメット：" + (ultimateNames[selectedUltimate] || "天墜") + "　（" + (loadoutSlotToEdit === 2 ? "お守り" : loadoutSlotToEdit === 3 ? "アルティメット" : (loadoutSlotToEdit + 1) + "個目") + "を選択中）";
}
document.querySelectorAll("[data-loadout-slot]").forEach(button => button.addEventListener("click", () => {
  const slot = Number(button.dataset.loadoutSlot);
  loadoutSlotToEdit = slot >= 0 && slot <= 3 ? slot : 0;
  updateLoadoutSelectionUi();
}));
document.querySelectorAll(".ultimate-card").forEach(card => card.addEventListener("click", () => {
  if (joined) return;
  selectedUltimate = ["skyfall", "teleport", "aegis", "invisible", "rift", "tornado"].includes(card.dataset.ultimate) ? card.dataset.ultimate : "skyfall";
  updateLoadoutSelectionUi();
}));
document.querySelectorAll(".charm-card[data-charm]").forEach(card => card.addEventListener("click", () => {
  if (joined) return;
  selectedCharm = ["hp", "speed", "reload", "jump", "floor", "aim", "ultimate", "body"].includes(card.dataset.charm) ? card.dataset.charm : "none";
  updateLoadoutSelectionUi();
}));
for (const button of document.querySelectorAll(".weapon-card")) {
  button.addEventListener("click", () => {
    if (joined) return;
    const weapon = button.dataset.weapon;
    if (!weapon) return;
    if (loadoutSlotToEdit === 0) {
      if (weapon === selectedSecondaryWeapon) selectedSecondaryWeapon = selectedPrimaryWeapon;
      selectedPrimaryWeapon = weapon;
    } else {
      if (weapon === selectedPrimaryWeapon) {
        showMessage("1個目と2個目は別の武器を選んでください");
        return;
      }
      selectedSecondaryWeapon = weapon;
    }
    updateLoadoutSelectionUi();
  });
}
document.getElementById("confirmLoadoutButton")?.addEventListener("click", () => {
  if (joined) return;
  if (selectedPrimaryWeapon === selectedSecondaryWeapon) { showMessage("1個目と2個目に別の武器を選んでください"); return; }
  savePlayerName();
  document.getElementById("weaponScreen")?.classList.add("hidden");
  document.getElementById("modeScreen")?.classList.remove("hidden");
});

document.getElementById("backToLoadoutButton")?.addEventListener("click", () => {
  document.getElementById("modeScreen")?.classList.add("hidden");
  document.getElementById("weaponScreen")?.classList.remove("hidden");
});

let wanderMapsLoaded = false;
let wanderMaps = [];
const wanderMapChoices = document.getElementById("wanderMapChoices");
socket.on("wanderMaps", (maps = []) => {
  wanderMaps = maps;
  wanderMapsLoaded = true;
  if (!wanderMapChoices) return;
  wanderMapChoices.replaceChildren();
  for (const map of maps) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-card";
    const title = document.createElement("strong");
    title.textContent = map.name;
    const description = document.createElement("span");
    description.textContent = "このステージを1人で探索する";
    button.append(title, description);
    button.addEventListener("click", () => startWanderOnMap(map));
    wanderMapChoices.appendChild(button);
  }
});
function startWanderOnMap(map) {
  if (joined || !map) return;
  const name = savePlayerName();
  selectedGameMode = "Wander";
  areaResultOpen = false;
  selectedWeapon = selectedPrimaryWeapon;
  weaponSlots = [selectedPrimaryWeapon, selectedSecondaryWeapon];
  document.getElementById("wanderMapScreen")?.classList.add("hidden");
  document.getElementById("modeScreen")?.classList.add("hidden");
  socket.emit("join", {
    name,
    weapon: selectedPrimaryWeapon,
    secondaryWeapon: selectedSecondaryWeapon,
    charm: selectedCharm,
      ultimateType: selectedUltimate,
    mode: "Wander",
    mapId: map.id,
    skin: window.getPlayerSkinData?.()
  });
}
document.getElementById("wanderModeButton")?.addEventListener("click", () => {
  if (joined) return;
  document.getElementById("modeScreen")?.classList.add("hidden");
  document.getElementById("wanderMapScreen")?.classList.remove("hidden");
  if (!wanderMapsLoaded) {
    if (wanderMapChoices) wanderMapChoices.innerHTML = "<p>ステージ一覧を読み込んでいます…</p>";
    socket.emit("getWanderMaps");
  }
});
document.getElementById("backFromWanderMapsButton")?.addEventListener("click", () => {
  document.getElementById("wanderMapScreen")?.classList.add("hidden");
  document.getElementById("modeScreen")?.classList.remove("hidden");
});

document.getElementById("shootingRangeModeButton")?.addEventListener("click", () => {
  if (joined) return;
  const name = savePlayerName();
  selectedGameMode = "Training";
  areaResultOpen = false;
  selectedWeapon = selectedPrimaryWeapon;
  weaponSlots = [selectedPrimaryWeapon, selectedSecondaryWeapon];
  document.getElementById("modeScreen")?.classList.add("hidden");
  document.getElementById("areaQueuePanel")?.classList.add("hidden");
  document.getElementById("areaResultPanel")?.classList.add("hidden");
  socket.emit("join", {
    name,
    weapon: selectedPrimaryWeapon,
    secondaryWeapon: selectedSecondaryWeapon,
    charm: selectedCharm,
      ultimateType: selectedUltimate,
    mode: "Training",
    skin: window.getPlayerSkinData?.()
  });
});

document.getElementById("freeForAllModeButton")?.addEventListener("click", () => {
  if (joined) return;
  const name = savePlayerName();
  selectedGameMode = "Melee";
  areaResultOpen = false;
  selectedWeapon = selectedPrimaryWeapon;
  weaponSlots = [selectedPrimaryWeapon, selectedSecondaryWeapon];
  document.getElementById("modeScreen")?.classList.add("hidden");
  document.getElementById("areaQueuePanel")?.classList.add("hidden");
  document.getElementById("areaResultPanel")?.classList.add("hidden");
  socket.emit("join", {
    name,
    weapon: selectedPrimaryWeapon,
    secondaryWeapon: selectedSecondaryWeapon,
    charm: selectedCharm,
      ultimateType: selectedUltimate,
    mode: "free-for-all",
    skin: window.getPlayerSkinData?.()
  });
});

let duelRoomCreating = false, duelChangingRules = false, duelSelectedRoomId = null, duelCurrentFirstTo = 3;
const duelRoomScreen=document.getElementById("duelRoomScreen"), duelRulesScreen=document.getElementById("duelRulesScreen"), duelWaitScreen=document.getElementById("duelWaitScreen");
const duelRoomList=document.getElementById("duelRoomList"), duelMapSelect=document.getElementById("duelMapSelect"), duelFirstToSelect=document.getElementById("duelFirstToSelect");
function showDuelScreen(screen){[duelRoomScreen,duelRulesScreen,duelWaitScreen].forEach(n=>n?.classList.add("hidden"));if(screen)screen.classList.remove("hidden");}
function renderDuelRooms(rooms=[]){
 if(!duelRoomList)return;duelRoomList.replaceChildren();
 if(!rooms.length){const p=document.createElement("p");p.textContent="現在、参加できる部屋はありません。";duelRoomList.append(p);return;}
 rooms.forEach(room=>{const card=document.createElement("div");card.className="duel-room-card";const info=document.createElement("div"),title=document.createElement("strong"),details=document.createElement("span"),button=document.createElement("button");
 title.textContent=(room.hostName||"プレイヤー")+" の部屋";details.textContent=(room.mapName||room.mapId)+" ・ "+room.firstTo+"本先取";info.append(title,details);button.type="button";button.textContent="参加";
 button.addEventListener("click",()=>{duelSelectedRoomId=room.id;socket.emit("duel:joinRoom",{roomId:room.id});});card.append(info,button);duelRoomList.append(card);});
}
document.getElementById("duelModeButton")?.addEventListener("click",()=>{if(joined)return;document.getElementById("modeScreen")?.classList.add("hidden");showDuelScreen(duelRoomScreen);socket.emit("duel:listRooms");socket.emit("duel:getMaps");});
document.getElementById("duelCreateRoomButton")?.addEventListener("click",()=>{duelRoomCreating=true;duelChangingRules=false;document.getElementById("duelRulesTitle").textContent="部屋のルール設定";document.getElementById("duelConfirmRulesButton").textContent="ルールを確定して部屋を作る";document.getElementById("duelRulesStatus").textContent="";showDuelScreen(duelRulesScreen);socket.emit("duel:getMaps");});
document.getElementById("duelRefreshRoomsButton")?.addEventListener("click",()=>socket.emit("duel:listRooms"));
document.getElementById("duelBackToModesButton")?.addEventListener("click",()=>{showDuelScreen(null);document.getElementById("modeScreen")?.classList.remove("hidden");});
document.getElementById("duelCancelRulesButton")?.addEventListener("click",()=>showDuelScreen(duelRoomScreen));
document.getElementById("duelCancelWaitButton")?.addEventListener("click",()=>socket.emit("duel:cancelRoom"));
document.getElementById("duelConfirmRulesButton")?.addEventListener("click",()=>{
 const mapId=duelMapSelect?.value, firstTo=Math.max(1,Math.min(10,Number(duelFirstToSelect?.value)||3));
 if(!mapId){const el=document.getElementById("duelRulesStatus");if(el)el.textContent="マップを選択してください。";return;}
 if(duelChangingRules){socket.emit("duel:updateRules",{roomId:duelSelectedRoomId,mapId,firstTo});document.getElementById("duelResultScreen")?.classList.remove("hidden");showDuelScreen(null);return;}
 socket.emit("duel:createRoom",{mapId,firstTo,name:savePlayerName(),weapon:selectedPrimaryWeapon,secondaryWeapon:selectedSecondaryWeapon,skin:window.getPlayerSkinData?.()});
});
socket.on("duel:maps",(maps=[])=>{if(!duelMapSelect)return;const old=duelMapSelect.value;duelMapSelect.replaceChildren();maps.forEach(map=>{const o=document.createElement("option");o.value=map.id;o.textContent=map.name;duelMapSelect.append(o);});if(maps.some(m=>m.id===old))duelMapSelect.value=old;});
socket.on("duel:rooms",renderDuelRooms);
socket.on("duel:roomCreated",({room}={})=>{duelSelectedRoomId=room?.id||null;duelCurrentFirstTo=room?.firstTo||3;showDuelScreen(duelWaitScreen);const el=document.getElementById("duelWaitSummary");if(el&&room)el.textContent=(room.mapName||room.mapId)+" ・ "+room.firstTo+"本先取。参加者が入室するまで待機しています。";});
socket.on("duel:error",({message}={})=>{const el=document.getElementById("duelRulesStatus");if(el)el.textContent=message||"部屋の処理に失敗しました。";if(duelRulesScreen?.classList.contains("hidden")){showDuelScreen(duelRoomScreen);if(duelRoomList){const p=document.createElement("p");p.textContent=message||"部屋の処理に失敗しました。";duelRoomList.prepend(p);}}});
socket.on("duel:matchReady",({roomId,firstTo}={})=>{duelSelectedRoomId=roomId;duelCurrentFirstTo=firstTo||3;selectedGameMode="Duel";selectedWeapon=selectedPrimaryWeapon;weaponSlots=[selectedPrimaryWeapon,selectedSecondaryWeapon];showDuelScreen(null);socket.emit("join",{name:savePlayerName(),weapon:selectedPrimaryWeapon,secondaryWeapon:selectedSecondaryWeapon,charm:selectedCharm,ultimateType:selectedUltimate,mode:"Duel",duelRoomId:roomId,skin:window.getPlayerSkinData?.()});});
function updateDuelScore(data={}){duelCurrentFirstTo=data.firstTo||duelCurrentFirstTo;const my=document.getElementById("duelMyScore"),op=document.getElementById("duelOpponentScore"),name=document.getElementById("duelOpponentName"),label=document.getElementById("duelRoundLabel");if(my)my.textContent=String(data.myScore??0);if(op)op.textContent=String(data.opponentScore??0);if(name)name.textContent=data.opponentName||"対戦相手";if(label)label.textContent="先取 "+duelCurrentFirstTo+" 本";}
socket.on("duel:score",data=>{updateDuelScore(data);showMessage("ラウンド取得！");});
socket.on("duel:matchEnd",data=>{updateDuelScore(data);document.getElementById("duelResultMyScore").textContent=String(data.myScore??0);document.getElementById("duelResultOpponentScore").textContent=String(data.opponentScore??0);document.getElementById("duelResultTitle").textContent=data.winnerId===myId?"勝利":"敗北";document.getElementById("duelResultSummary").textContent=(data.opponentName||"対戦相手")+" とのタイマンが終了しました。";document.getElementById("duelRematchStatus").textContent="";document.getElementById("duelRematchReadyButton").classList.add("hidden");document.getElementById("duelResultScreen").classList.remove("hidden");});
document.getElementById("duelRematchSameButton")?.addEventListener("click",()=>{socket.emit("duel:rematchReady",{roomId:duelSelectedRoomId});document.getElementById("duelRematchStatus").textContent="相手のOKを待っています…";});
document.getElementById("duelRematchChangeButton")?.addEventListener("click",()=>{duelChangingRules=true;socket.emit("duel:requestRuleChange",{roomId:duelSelectedRoomId});});
socket.on("duel:ruleChangeAllowed",({host}={})=>{if(!host){document.getElementById("duelRematchStatus").textContent="部屋の作成者がルールを変更しています。";return;}document.getElementById("duelRulesTitle").textContent="再戦ルールの変更";document.getElementById("duelConfirmRulesButton").textContent="ルールを更新する";document.getElementById("duelFirstToSelect").value=String(duelCurrentFirstTo);document.getElementById("duelRulesStatus").textContent="";document.getElementById("duelResultScreen").classList.add("hidden");showDuelScreen(duelRulesScreen);socket.emit("duel:getMaps");});
socket.on("duel:rulesChanged",({mapName,firstTo}={})=>{duelCurrentFirstTo=firstTo||duelCurrentFirstTo;document.getElementById("duelRematchStatus").textContent="ルール変更済み（"+(mapName||"マップ")+"・"+duelCurrentFirstTo+"本先取）。両者がOKを押すと再戦します。";document.getElementById("duelRematchReadyButton").classList.remove("hidden");document.getElementById("duelResultScreen").classList.remove("hidden");});
document.getElementById("duelRematchReadyButton")?.addEventListener("click",()=>{socket.emit("duel:rematchReady",{roomId:duelSelectedRoomId});document.getElementById("duelRematchReadyButton").disabled=true;document.getElementById("duelRematchStatus").textContent="相手のOKを待っています…";});
socket.on("duel:rematchStarted",({firstTo}={})=>{duelCurrentFirstTo=firstTo||duelCurrentFirstTo;document.getElementById("duelResultScreen")?.classList.add("hidden");document.getElementById("duelRematchReadyButton").disabled=false;document.getElementById("duelRematchReadyButton").classList.add("hidden");updateDuelScore({myScore:0,opponentScore:0,firstTo:duelCurrentFirstTo});document.getElementById("duelScoreHud")?.classList.remove("hidden");});
document.getElementById("duelQuitButton")?.addEventListener("click",()=>{
  const button=document.getElementById("duelQuitButton");
  if(button) button.disabled=true;
  lobbyScreenAfterLeave="modeScreen";
  stopAllControls();
  document.getElementById("duelResultScreen")?.classList.add("hidden");
  document.getElementById("duelScoreHud")?.classList.add("hidden");
  showDuelScreen(null);
  socket.emit("leaveMatch");
  // サーバー応答が届かない場合も画面操作を塞いだままにしない。
  setTimeout(()=>{if(!joined)return;if(button)button.disabled=false;},3000);
  selectedGameMode="Melee";
});
document.getElementById("buildModeButton")?.addEventListener("click", () => {
  if (joined) return;
  const name = savePlayerName();
  selectedGameMode = "Build";
  areaResultOpen = false;
  selectedWeapon = selectedPrimaryWeapon;
  weaponSlots = [selectedPrimaryWeapon, selectedSecondaryWeapon];
  document.getElementById("modeScreen")?.classList.add("hidden");
  document.getElementById("areaQueuePanel")?.classList.add("hidden");
  document.getElementById("payloadQueuePanel")?.classList.add("hidden");
  socket.emit("join", {
    name,
    weapon: selectedPrimaryWeapon,
    secondaryWeapon: selectedSecondaryWeapon,
    charm: selectedCharm,
    ultimateType: selectedUltimate,
    mode: "Build",
    skin: window.getPlayerSkinData?.()
  });
});

document.getElementById("areaModeButton")?.addEventListener("click",()=>{
  if (joined) return;
  const name = savePlayerName();
  selectedGameMode = "Area";
  areaResultOpen = false;
  selectedWeapon = selectedPrimaryWeapon;
  weaponSlots = [selectedPrimaryWeapon, selectedSecondaryWeapon];
  document.getElementById("modeScreen")?.classList.add("hidden");
  document.getElementById("areaResultPanel")?.classList.add("hidden");
  if (areaQueueStatusText) areaQueueStatusText.textContent = "対戦相手を募集しています。";
  if (areaQueueCountText) areaQueueCountText.textContent = "1 / 6 人";
  if (areaQueueTimeText) areaQueueTimeText.textContent = "20秒";
  if (areaQueueProgressFill) areaQueueProgressFill.style.width = "0%";
  if (areaQueuePanel) areaQueuePanel.classList.remove("hidden");
  document.getElementById("payloadQueuePanel")?.classList.add("hidden");
  socket.emit("joinAreaQueue", {
    name,
    weapon: selectedPrimaryWeapon,
    secondaryWeapon: selectedSecondaryWeapon,
    charm: selectedCharm,
      ultimateType: selectedUltimate,
    skin: window.getPlayerSkinData?.()
  });
});
document.getElementById("payloadModeButton")?.addEventListener("click", () => {
  if (joined) return;
  const name = savePlayerName();
  selectedGameMode = "Payload";
  payloadRole = null;
  areaResultOpen = false;
  selectedWeapon = selectedPrimaryWeapon;
  weaponSlots = [selectedPrimaryWeapon, selectedSecondaryWeapon];
  document.getElementById("modeScreen")?.classList.add("hidden");
  document.getElementById("payloadResultPanel")?.classList.add("hidden");
  if (payloadQueueStatusText) payloadQueueStatusText.textContent = "対戦相手を募集しています。";
  if (payloadQueueCountText) payloadQueueCountText.textContent = "1 / 6 人";
  if (payloadQueueTimeText) payloadQueueTimeText.textContent = "20秒";
  if (payloadQueueProgressFill) payloadQueueProgressFill.style.width = "0%";
  payloadQueuePanel?.classList.remove("hidden");
  socket.emit("joinPayloadQueue", { name, weapon: selectedPrimaryWeapon, secondaryWeapon: selectedSecondaryWeapon, charm: selectedCharm, ultimateType: selectedUltimate, skin: window.getPlayerSkinData?.(), reconnectToken: payloadReconnectToken });
});
updateLoadoutSelectionUi();

const fullscreenButton = document.getElementById("fullscreenButton");
function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function showFullscreenFallbackMessage() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  showMessage(isIOS
    ? "iPhoneのSafariはWebページの全画面化に対応していません。共有メニューから「ホーム画面に追加」して起動してください。"
    : "このブラウザでは全画面表示に対応していません。");
}
async function toggleFullscreen() {
  const active = getFullscreenElement();
  try {
    if (active) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (typeof exit !== "function") { showFullscreenFallbackMessage(); return; }
      await exit.call(document);
    } else {
      const target = document.documentElement;
      const request = target.requestFullscreen || target.webkitRequestFullscreen;
      if (typeof request !== "function") { showFullscreenFallbackMessage(); return; }
      await request.call(target);
    }
  } catch (error) {
    console.warn("[Fullscreen] 全画面切替に失敗しました:", error);
    showFullscreenFallbackMessage();
  }
}
fullscreenButton?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (layoutEditing) return;
  toggleFullscreen();
});
function updateFullscreenButton() {
  if (fullscreenButton) fullscreenButton.textContent = getFullscreenElement() ? "全画面解除" : "全画面";
}
document.addEventListener("fullscreenchange", updateFullscreenButton);
document.addEventListener("webkitfullscreenchange", updateFullscreenButton);

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
const crouchButton = document.getElementById("crouchButton");

const jumpCrouchLookPointers = new Map();

function beginJumpCrouchLookGesture(event) {
  if (layoutEditing || event.pointerType === "mouse") return;
  if (gameSettings.allowLookWhileJumpCrouchHeld === false) return;
  jumpCrouchLookPointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY
  });
}

// Capture-phase document listener still receives pointer moves while a touch button owns pointer capture.
document.addEventListener("pointermove", (event) => {
  const previous = jumpCrouchLookPointers.get(event.pointerId);
  if (!previous || gameSettings.allowLookWhileJumpCrouchHeld === false) return;

  const dx = event.clientX - previous.x;
  const dy = event.clientY - previous.y;
  previous.x = event.clientX;
  previous.y = event.clientY;

  yaw -= dx * .0045 * gameSettings.touchSensitivity * (getScopeSensitivityMultiplier());
  pitch -= dy * .0045 * gameSettings.touchSensitivity * (getScopeSensitivityMultiplier());
  pitch = THREE.MathUtils.clamp(pitch, -1.35, 1.35);
  event.preventDefault();
}, { capture: true, passive: false });

const endJumpCrouchLookGesture = (event) => {
  jumpCrouchLookPointers.delete(event.pointerId);
};
document.addEventListener("pointerup", endJumpCrouchLookGesture, true);
document.addEventListener("pointercancel", endJumpCrouchLookGesture, true);
window.addEventListener("blur", () => jumpCrouchLookPointers.clear());

jumpButton.addEventListener("pointerdown", (e) => {
  if (layoutEditing) return;
  e.preventDefault();
  jumpButton.setPointerCapture?.(e.pointerId);
  beginJumpCrouchLookGesture(e);
  jump();
});

crouchButton?.addEventListener("pointerdown", (e) => {
  if (layoutEditing) return;
  e.preventDefault();
  crouchButton.setPointerCapture?.(e.pointerId);
  beginJumpCrouchLookGesture(e);
  setCrouch(true);
});

crouchButton?.addEventListener("pointerup", (e) => {
  if (layoutEditing) return;
  e.preventDefault();
  setCrouch(false);
});

crouchButton?.addEventListener("pointercancel", () => setCrouch(false));

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

document.getElementById("inventoryButton")?.addEventListener("pointerdown", (e) => {
  if (layoutEditing || !joined) return;
  e.preventDefault(); e.stopPropagation(); openInventory();
});
document.getElementById("switchWeaponButton")?.addEventListener("pointerdown", (e) => {
  if (layoutEditing) return;
  e.preventDefault(); e.stopPropagation(); switchWeapon();
});
document.getElementById("scopeButton")?.addEventListener("pointerdown", (e) => {
  if (layoutEditing || selectedWeapon !== "sniper") return;
  e.preventDefault(); e.stopPropagation(); setScopeEnabled(!scopeEnabled);
});

setupDraggableButton("movePad", "movePad");
setupDraggableButton("jumpButton", "jumpButton");
setupDraggableButton("reloadTouchButton", "reloadTouchButton");
setupDraggableButton("crouchButton", "crouchButton");
setupDraggableButton("fireButton", "fireButton");
setupDraggableButton("switchWeaponButton", "switchWeaponButton");
setupDraggableButton("inventoryButton", "inventoryButton");
setupDraggableButton("scopeButton", "scopeButton");
setupDraggableButton("ultimateButton", "ultimateButton");
setupDraggableOffset("minimap", "minimap");
setupDraggableOffset("healthHud", "healthHud");
setupDraggableOffset("kdHud", "kdHud");
setupDraggableOffset("areaHud", "areaHud");

// MAP/HPバーは親要素やCanvasのイベント状態に左右されないよう、
// 配置編集中だけdocument側でもドラッグを拾う。
(function setupHudLayoutDragFallback() {
  const targets = new Map([
    ["minimap", "minimap"],
    ["healthHud", "healthHud"],
    ["kdHud", "kdHud"],
    ["settingsButton", "settingsButton"],
    ["ammoHud", "reloadButton"]
  ]);

  let active = null;

  document.addEventListener("pointerdown", (e) => {
    if (!layoutEditing) return;

    for (const [id, key] of targets) {
      const el = document.getElementById(id);
      if (!el) continue;

      const rect = el.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) continue;

      const cfg = gameSettings.layout[key] || { x: 0, y: 0 };
      active = {
        id,
        key,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        x: Number(cfg.x) || 0,
        y: Number(cfg.y) || 0
      };

      try { el.setPointerCapture?.(e.pointerId); } catch (_) {}
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }, true);

  document.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== active.pointerId || !layoutEditing) return;

    const cfg = gameSettings.layout[active.key];
    const el = document.getElementById(active.id);
    if (!cfg || !el) return;

    cfg.x = Math.round(active.x + e.clientX - active.startX);
    cfg.y = Math.round(active.y + e.clientY - active.startY);
    if (active.id === "areaHud") {
      el.style.setProperty("--layout-x", cfg.x + "px");
      el.style.setProperty("--layout-y", cfg.y + "px");
    } else {
      el.style.transform = "translate3d(" + cfg.x + "px, " + cfg.y + "px, 0)";
    }

    e.preventDefault();
    e.stopPropagation();
    saveGameSettings();
  }, true);

  const end = (e) => {
    if (!active || e.pointerId !== active.pointerId) return;
    active = null;
    e.preventDefault();
    e.stopPropagation();
  };

  document.addEventListener("pointerup", end, true);
  document.addEventListener("pointercancel", end, true);
})();


setupDraggableOffset("fullscreenButton", "fullscreenButton");
setupDraggableOffset("settingsButton", "settingsButton");
setupDraggableOffset("ammoHud", "reloadButton");
setupDraggableOffset("buildToolbar", "buildToolbar");

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
  stopFiring(true);
});

fireButton.addEventListener("pointerleave", (e) => {
  // Pointer Capture中の一時的なleaveで剣ガードを解除しない。
  if (e.buttons === 0 && selectedWeapon !== "sword") stopFiring();
});

const lookSurface = renderer.domElement;

const activeActionPointers = new Set();
document.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  if (e.target.closest?.("#touchUi button")) activeActionPointers.add(e.pointerId);
}, true);
document.addEventListener("pointerup", (e) => activeActionPointers.delete(e.pointerId), true);
document.addEventListener("pointercancel", (e) => activeActionPointers.delete(e.pointerId), true);
window.addEventListener("blur", () => activeActionPointers.clear());

lookSurface.addEventListener("pointerdown", (e) => {
  if (!joined || e.pointerType === "mouse") return;
  if (gameSettings.allowLookWhileActionHeld === false && activeActionPointers.size > 0) return;
  if (e.clientX < innerWidth * .42 || e.clientX > innerWidth * .58) {
    lookPointerId = e.pointerId;
    lastLookX = e.clientX;
    lastLookY = e.clientY;
    lookSurface.setPointerCapture?.(e.pointerId);
  }
});

lookSurface.addEventListener("pointermove", (e) => {
  if (e.pointerId !== lookPointerId) return;
  if (gameSettings.allowLookWhileActionHeld === false && activeActionPointers.size > 0) return;

  const dx = e.clientX - lastLookX;
  const dy = e.clientY - lastLookY;
  lastLookX = e.clientX;
  lastLookY = e.clientY;

  yaw -= dx * .0045 * gameSettings.touchSensitivity * getScopeSensitivityMultiplier();
  pitch -= dy * .0045 * gameSettings.touchSensitivity * getScopeSensitivityMultiplier();
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

  yaw -= e.movementX * .0028 * gameSettings.mouseSensitivity * (getScopeSensitivityMultiplier());
  pitch -= e.movementY * .0028 * gameSettings.mouseSensitivity * (getScopeSensitivityMultiplier());
  pitch = THREE.MathUtils.clamp(pitch, -1.35, 1.35);
});

// キーマウ割り当てにマウスの左・中央・右・戻る・進むボタンを使える。
const activeMouseBindings = new Map();
document.addEventListener("mousedown", (e) => {
  if (pendingKeyBindingAction) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.button === 2) suppressContextMenuUntil = Date.now() + 800;
    const code = mouseButtonCode(e.button);
    if (code) assignKeyBinding(pendingKeyBindingAction, code);
    return;
  }

  if (!joined || !document.getElementById("settingsPanel")?.classList.contains("hidden")) return;
  if (e.target !== lookSurface) return;

  const code = mouseButtonCode(e.button);
  if (!code) return;
  for (const [action, binding] of Object.entries(gameSettings.keyboard || DEFAULT_SETTINGS.keyboard)) {
    if (binding !== code) continue;
    performBoundAction(action, true, false);
    activeMouseBindings.set(action, code);
  }
}, true);

document.addEventListener("mouseup", (e) => {
  const code = mouseButtonCode(e.button);
  if (!code) return;
  for (const [action, activeCode] of activeMouseBindings) {
    if (activeCode !== code) continue;
    performBoundAction(action, false, false);
    activeMouseBindings.delete(action);
  }
}, true);

document.addEventListener("contextmenu", (e) => {
  if (joined || pendingKeyBindingAction || Date.now() < suppressContextMenuUntil) e.preventDefault();
});

window.addEventListener("blur", () => {
  stopFiring();
  for (const action of activeMouseBindings.keys()) performBoundAction(action, false, false);
  activeMouseBindings.clear();
  setScopeEnabled(false);
});

const ultimateButtonElement = document.getElementById("ultimateButton");
// 移動操作と同時に押せるよう、pointerdownの時点で発動する。
// Pointer Captureや移動量によるキャンセルは、マルチタッチ中の入力競合を起こすため使わない。
ultimateButtonElement?.addEventListener("pointerdown", event => {
  if (layoutEditing || ultimateButtonElement.disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  ultimateButtonElement.classList.add("ultimate-pressed");
  activateUltimate();
});
ultimateButtonElement?.addEventListener("pointerup", () => {
  ultimateButtonElement.classList.remove("ultimate-pressed");
});
ultimateButtonElement?.addEventListener("pointercancel", () => {
  ultimateButtonElement.classList.remove("ultimate-pressed");
});
// キーボード操作や支援技術からの click も維持する。
ultimateButtonElement?.addEventListener("click", event => {
  if (event.detail === 0 && !layoutEditing) activateUltimate();
});

function openUltimateMapPicker() {
  // 空間跳躍の地点選択ではマウスカーソルを操作できるようPointer Lockを解除する。
  if (document.pointerLockElement) document.exitPointerLock?.();
  pointerLocked = false;
  const overlay = document.getElementById("ultimateMapPicker");
  const canvas = document.getElementById("ultimateMapCanvas");
  const ctx = canvas?.getContext("2d");
  const bounds = worldData?.world;
  if (!overlay || !canvas || !ctx || !bounds) { showMessage("マップ情報を読み込めません"); return; }
  const w = canvas.width, h = canvas.height, pad = 24;
  const scale = Math.min((w - pad * 2) / (bounds.maxX - bounds.minX), (h - pad * 2) / (bounds.maxZ - bounds.minZ));
  const offsetX = (w - (bounds.maxX - bounds.minX) * scale) / 2;
  const offsetZ = (h - (bounds.maxZ - bounds.minZ) * scale) / 2;
  const drawX = x => offsetX + (x - bounds.minX) * scale;
  const drawZ = z => offsetZ + (z - bounds.minZ) * scale;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#182432"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#657b70"; ctx.fillRect(offsetX, offsetZ, (bounds.maxX - bounds.minX) * scale, (bounds.maxZ - bounds.minZ) * scale);
  for (const o of (worldData.obstacles || [])) { ctx.fillStyle = "#344252"; ctx.fillRect(drawX(o.x-o.w/2), drawZ(o.z-o.d/2), o.w*scale, o.d*scale); }
  canvas.dataset.mapMinX = String(bounds.minX); canvas.dataset.mapMaxX = String(bounds.maxX);
  canvas.dataset.mapMinZ = String(bounds.minZ); canvas.dataset.mapMaxZ = String(bounds.maxZ);
  canvas.dataset.mapScale = String(scale); canvas.dataset.mapOffsetX = String(offsetX); canvas.dataset.mapOffsetZ = String(offsetZ);
  overlay.classList.remove("hidden"); overlay.setAttribute("aria-hidden", "false");
}
document.getElementById("ultimateMapCancel")?.addEventListener("click", () => {
  const overlay = document.getElementById("ultimateMapPicker"); overlay?.classList.add("hidden"); overlay?.setAttribute("aria-hidden", "true");
});
document.getElementById("ultimateMapCanvas")?.addEventListener("click", event => {
  const canvas = event.currentTarget, rect = canvas.getBoundingClientRect();
  const px = (event.clientX - rect.left) * canvas.width / rect.width;
  const pz = (event.clientY - rect.top) * canvas.height / rect.height;
  const scale = Number(canvas.dataset.mapScale); if (!scale) return;
  const x = Number(canvas.dataset.mapMinX) + (px - Number(canvas.dataset.mapOffsetX)) / scale;
  const z = Number(canvas.dataset.mapMinZ) + (pz - Number(canvas.dataset.mapOffsetZ)) / scale;
  const minX=Number(canvas.dataset.mapMinX), maxX=Number(canvas.dataset.mapMaxX), minZ=Number(canvas.dataset.mapMinZ), maxZ=Number(canvas.dataset.mapMaxZ);
  if (x <= minX || x >= maxX || z <= minZ || z >= maxZ) return;
  sendUltimateRequest({ x, z }, () => {
    const overlay = document.getElementById("ultimateMapPicker");
    overlay?.classList.add("hidden");
    overlay?.setAttribute("aria-hidden", "true");
  });
});
let ultimateRequestPending = false;

function sendUltimateRequest(payload = {}, onSuccess) {
  if (ultimateRequestPending) return;
  if (!socket.connected) {
    showMessage("サーバーに接続されていません。再接続後に使用してください。");
    return;
  }

  ultimateRequestPending = true;
  const button = document.getElementById("ultimateButton");
  if (button) {
    button.disabled = true;
    button.dataset.previousText = button.textContent;
    button.textContent = "...";
  }

  socket.timeout(4000).emit("ultimate", payload, (error, result) => {
    ultimateRequestPending = false;
    if (button) {
      button.disabled = !joined || Number(myState?.health) <= 0;
      button.textContent = (Number(myState?.ultimateCharge) || 0) >= 100 ? "ULT" : Math.floor(Number(myState?.ultimateCharge) || 0) + "%";
    }
    if (error) {
      showMessage("アルティメットの応答がありません。接続状態を確認してください。");
      return;
    }
    if (!result?.ok) {
      showMessage(result?.message || "アルティメットを使用できませんでした。");
      return;
    }
    if (myState) myState.ultimateCharge = 0;
    const progressButton = document.getElementById("ultimateButton");
    if (progressButton) progressButton.style.setProperty("--ultimate-progress", "0%");
    if (typeof onSuccess === "function") onSuccess(result);
    showMessage(({aegis:"蒼天障壁を展開！",teleport:"空間跳躍！",invisible:"幽影を発動！",rift:"鏡界へ移動！",skyfall:"天墜！"})[result.type]||"アルティメット発動！");
  });
}

function activateUltimate() {
  if (layoutEditing) return;
  if (!joined || !myState) { showMessage("ゲームに参加してから使用できます。"); return; }
  if (Number(myState.health) <= 0 || myState.finished) { showMessage("復活してから使用してください。"); return; }
  const charge = Math.max(0, Math.min(100, Number(myState.ultimateCharge) || 0));
  if (myState.ultimateType === "skyfall" && Number(myState.ultimateActiveUntil) > Date.now()) {
    const startedAt = Number(myState.ultimateActiveUntil) - 3000;
    if (Date.now() - startedAt < 1000) { showMessage("降下は天墜の発動から1秒後に可能です。"); return; }
    sendUltimateRequest({ descend: true });
    return;
  }
  if (charge < 100) { showMessage("アルティメットのチャージ中です（" + Math.floor(charge) + "%）。"); return; }
  if (myState.ultimateType === "teleport") {
    openUltimateMapPicker();
    return;
  }
  sendUltimateRequest({});
}

function performBoundAction(action, pressed, isRepeat = false) {
  switch (action) {
    case "forward": movement.forward = pressed; break;
    case "back": movement.back = pressed; break;
    case "left": movement.left = pressed; break;
    case "right": movement.right = pressed; break;
    case "lookUp": keyboardLook.up = pressed; break;
    case "lookDown": keyboardLook.down = pressed; break;
    case "lookRight": keyboardLook.right = pressed; break;
    case "lookLeft": keyboardLook.left = pressed; break;
    case "crouch": setCrouch(pressed); break;
    case "jump":
      if (pressed && !isRepeat) {
        if (myState?.health <= 0) requestRespawn();
        else jump();
      }
      break;
    case "reload":
      if (pressed && !isRepeat) reload();
      break;
    case "switchWeapon":
      if (pressed && !isRepeat) switchWeapon();
      break;
    case "weapon1":
      if (pressed && !isRepeat) selectWeaponSlot(0);
      break;
    case "weapon2":
      if (pressed && !isRepeat) selectWeaponSlot(1);
      break;
    case "fire":
      if (pressed) {
        if (!isRepeat) startFiring();
      } else {
        stopFiring();
      }
      break;
    case "scope":
      setScopeEnabled(pressed && selectedWeapon === "sniper");
      break;
    case "ultimate":
      if (pressed && !isRepeat) activateUltimate();
      break;
  }
}

window.addEventListener("keydown", (e) => {
  if (joined && selectedGameMode === "Build" && !pendingKeyBindingAction && !e.repeat) {
    if (e.code === "KeyQ") { selectBuildType("wall"); e.preventDefault(); return; }
    if (e.code === "KeyE") { selectBuildType("floor"); e.preventDefault(); return; }
    if (e.code === "KeyF") { placeBuildStructure(); e.preventDefault(); return; }
  }
  if (pendingKeyBindingAction) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "Escape") {
      pendingKeyBindingAction = null;
      refreshKeyBindingLabels();
      const status = document.getElementById("keyBindingStatus");
      if (status) status.textContent = "キー設定をキャンセルしました。";
      return;
    }
    assignKeyBinding(pendingKeyBindingAction, e.code);
    return;
  }

  if (!document.getElementById("settingsPanel")?.classList.contains("hidden")) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

  let handled = false;
  for (const [action, code] of Object.entries(gameSettings.keyboard || DEFAULT_SETTINGS.keyboard)) {
    if (code === e.code) {
      performBoundAction(action, true, e.repeat);
      handled = true;
    }
  }
  if (handled) e.preventDefault();
});

window.addEventListener("keyup", (e) => {
  for (const [action, code] of Object.entries(gameSettings.keyboard || DEFAULT_SETTINGS.keyboard)) {
    if (code === e.code) performBoundAction(action, false, false);
  }
});

window.addEventListener("blur", () => {
  movement.forward = false;
  movement.back = false;
  movement.left = false;
  movement.right = false;
  keyboardLook.up = keyboardLook.down = keyboardLook.left = keyboardLook.right = false;
  lastKeyboardLookAt = 0;
  setCrouch(false);
});

window.addEventListener("gamepadconnected", () => updateGamepadStatus());
window.addEventListener("gamepaddisconnected", () => updateGamepadStatus());

document.getElementById("gamepadConnectButton")?.addEventListener("click", () => {
  const pad = updateGamepadStatus();
  if (pad) showMessage("コントローラーを検出しました");
  else showMessage("コントローラーが見つかりません");
});

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, maxPixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  updatePickaxeReticleBounds();
});

function animate(now) {
  requestAnimationFrame(animate);

  const dt = Math.min(.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  clock.getDelta();

  pollGamepad(now);
  updateAimAssist();
  sendInput(now);
  updateCamera();
  updateBuildPreview();
  updateLaserSight();
  // 広いマップでは遠景の壁を簡易マテリアルに切り替え、グリッドも粗くして描画負荷を抑える。
  if (worldData?.world && Math.max(worldData.world.maxX - worldData.world.minX, worldData.world.maxZ - worldData.world.minZ) > 150 && now - lastWorldLodUpdate >= 250) {
    lastWorldLodUpdate = now;
    for (const object of worldGroup.children) {
      if (!object.userData?.worldLod) continue;
      const far = object.position.distanceTo(camera.position) > 65;
      object.material = far ? object.userData.farMaterial : object.userData.nearMaterial;
    }
  }
  // Minimap redraws do not need to run at the full render frame rate.
  if (now - lastMinimapUpdate >= 100) {
    updateMinimap();
    lastMinimapUpdate = now;
  }

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

  for (const mesh of grenadeProjectileMeshes.values()) {
    const tether = mesh.userData.tether;
    if (!tether) continue;
    const ownerId = mesh.userData.ownerId;
    let start = null;
    if (ownerId === myId) start = camera.position.clone();
    else {
      const ownerObject = remotePlayers.get(ownerId);
      if (ownerObject) start = ownerObject.position.clone().add(new THREE.Vector3(0, 1.15, 0));
    }
    if (start) tether.geometry.setFromPoints([start, mesh.position]);
  }

  updateSmokeVisuals(now, dt);

  for (let i = tracers.length - 1; i >= 0; i--) {
    const tracer = tracers[i];
    const life = tracer.life || 120;
    const progress = THREE.MathUtils.clamp((now - tracer.born) / life, 0, 1);
    if (tracer.dot && tracer.start && tracer.end) {
      tracer.dot.position.lerpVectors(tracer.start, tracer.end, progress);

      if (tracer.line) {
        if (tracer.line.userData?.rifleTracer || tracer.line.userData?.railgunTracer) {
          const current = tracer.dot.position;
          const dir = tracer.end.clone().sub(tracer.start).normalize();
          const streakLength = tracer.line.userData?.railgunTracer ? 2.8 : 0.75;
          const streakStart = current.clone().sub(dir.multiplyScalar(streakLength));
          tracer.line.geometry.setFromPoints([streakStart, current]);
        } else {
          tracer.line.geometry.setFromPoints([tracer.start, tracer.end]);
        }
      }
    }

    if (now - tracer.born > life) {
      if (tracers[i].line) {
        scene.remove(tracers[i].line);
        tracers[i].line.geometry.dispose();
        tracers[i].line.material.dispose();
      }
      if (tracers[i].dot) {
        scene.remove(tracers[i].dot);
        tracers[i].dot.geometry.dispose();
        tracers[i].dot.material.dispose();
      }
      tracers.splice(i, 1);
    }
  }

  for (const [ownerId, line] of grappleTethers) { let origin = null; if (ownerId === myId && myState) origin = new THREE.Vector3(myState.x, (myState.y || 0) + 1.25, myState.z); else { const remote = remotePlayers.get(ownerId); if (remote) origin = remote.position.clone().add(new THREE.Vector3(0, 1.25, 0)); } if (origin) line.geometry.setFromPoints([origin, line.userData.anchor]); }
  renderer.render(scene, camera);
}

requestAnimationFrame(animate);
