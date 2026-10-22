import * as THREE from "three";

const socketPath = location.pathname.startsWith("/FPSgame/")
  ? "/FPSgame/socket.io/"
  : "/socket.io/";

const socket = io({
  path: socketPath,
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
let activeGamepad = null;
let controllerMode = false;
let gamepadJumpHeld = false;
let gamepadReloadHeld = false;
let gamepadCrouchHeld = false;
let gamepadSwitchHeld = false;
let gamepadScopeHeld = false;
let gamepadFireHeld = false;
let controllerRespawnRequested = false;
const clock = new THREE.Clock();

let worldData = null;
let respawnTimer = null;

let joined = false;
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
let scopeEnabled = false;
let lastWeaponSwitchAt = -Infinity;
const WEAPON_SWITCH_COOLDOWN_MS = 800;
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

let crouchHeld = false;

let yaw = 0;
let pitch = 0;
let lookPointerId = null;
let lastLookX = 0;
let lastLookY = 0;
let pointerLocked = false;

const weaponConfig = {
  pistol: { fireInterval: 400, automatic: false },
  smg: { fireInterval: 107, automatic: true },
  rifle: { fireInterval: 160, automatic: true },
  shotgun: { fireInterval: 750, automatic: false },
  marksman: { fireInterval: 450, automatic: true },
  sniper: { fireInterval: 1200, automatic: false }
};

async function refreshPublicWeaponSettings() {
  try {
    const apiBase = location.pathname.startsWith("/FPSgame/") ? "/FPSgame/" : "/";
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
  controllerButtons: { jump: 0, reload: 1, crouch: 2, switchWeapon: 3, scope: 6, fire: 7 },
  allowLookWhileActionHeld: true,
  allowLookWhileJumpCrouchHeld: true,
  keyboard: {
    forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD",
    jump: "Space", crouch: "KeyC", reload: "KeyR", switchWeapon: "KeyQ",
    weapon1: "Digit1", weapon2: "Digit2", fire: "MouseLeft", scope: "MouseRight"
  },
  layout: {
    movePad: { x: 14, y: 12, side: "left", size: 150 },
    jumpButton: { x: 128, y: 48, side: "right", size: 72 },
    reloadTouchButton: { x: 128, y: 128, side: "right", size: 72 },
    crouchButton: { x: 220, y: 48, side: "right", size: 72 },
    fireButton: { x: 14, y: 18, side: "right", size: 100 },
    switchWeaponButton: { x: 310, y: 140, side: "right", size: 76 },
    scopeButton: { x: 220, y: 220, side: "right", size: 68 },
    minimap: { x: 0, y: 0 },
    healthHud: { x: 0, y: 0 },
    kdHud: { x: 0, y: 0 },
    areaHud: { x: 0, y: 0, size: 100 },
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
      sniperSensitivity: THREE.MathUtils.clamp(Number(saved.sniperSensitivity) || 1, 0.2, 2.0),
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
      keyboard: savedKeyboard,
      layout: {
        movePad: { ...DEFAULT_SETTINGS.layout.movePad, ...(saved.layout?.movePad || {}) },
        jumpButton: { ...DEFAULT_SETTINGS.layout.jumpButton, ...(saved.layout?.jumpButton || {}) },
        reloadTouchButton: { ...DEFAULT_SETTINGS.layout.reloadTouchButton, ...(saved.layout?.reloadTouchButton || {}) },
        crouchButton: { ...DEFAULT_SETTINGS.layout.crouchButton, ...(saved.layout?.crouchButton || {}) },
        fireButton: { ...DEFAULT_SETTINGS.layout.fireButton, ...(saved.layout?.fireButton || {}) },
        switchWeaponButton: { ...DEFAULT_SETTINGS.layout.switchWeaponButton, ...(saved.layout?.switchWeaponButton || {}) },
        scopeButton: { ...DEFAULT_SETTINGS.layout.scopeButton, ...(saved.layout?.scopeButton || {}) },
        minimap: { ...DEFAULT_SETTINGS.layout.minimap, ...(saved.layout?.minimap || {}) },
        healthHud: { ...DEFAULT_SETTINGS.layout.healthHud, ...(saved.layout?.healthHud || {}) },
        kdHud: { ...DEFAULT_SETTINGS.layout.kdHud, ...(saved.layout?.kdHud || {}) },
        areaHud: { ...DEFAULT_SETTINGS.layout.areaHud, ...(saved.layout?.areaHud || {}) },
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
    ["crouchButton", gameSettings.layout.crouchButton],
    ["fireButton", gameSettings.layout.fireButton],
    ["switchWeaponButton", gameSettings.layout.switchWeaponButton],
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
    ["ammoHud", gameSettings.layout.reloadButton]
  ];

  for (const [id, cfg] of offsetTargets) {
    const el = document.getElementById(id);
    if (!el) continue;
    const x = Number(cfg?.x) || 0;
    const y = Number(cfg?.y) || 0;
    if (id === "areaHud") {
      el.style.setProperty("--layout-x", x + "px");
      el.style.setProperty("--layout-y", y + "px");
      const scale = THREE.MathUtils.clamp(Number(cfg?.size) || 100, 60, 150) / 100;
      el.style.setProperty("--area-hud-scale", String(scale));
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
    const settingValue = THREE.MathUtils.clamp(Number(gameSettings[settingName]) || 1, settingName === "sniperSensitivity" ? 0.2 : 0.4, settingName === "sniperSensitivity" ? 2.0 : 5.0);
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

  const allowLookToggle = document.getElementById("allowLookWhileActionHeldToggle");
  if (allowLookToggle) {
    allowLookToggle.checked = gameSettings.allowLookWhileActionHeld !== false;
    const label = document.getElementById("allowLookToggleValue");
    if (label) label.textContent = allowLookToggle.checked ? "ON（許可）" : "OFF（禁止）";
  }

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
  jump: "ジャンプ", crouch: "しゃがむ", reload: "リロード",
  switchWeapon: "武器切替", weapon1: "武器スロット1", weapon2: "武器スロット2",
  fire: "発射", scope: "スコープを覗く"
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
  const arrowAlias = ({
    ArrowUp: "forward", ArrowDown: "back", ArrowLeft: "left", ArrowRight: "right"
  })[code];
  const conflict = Object.entries(gameSettings.keyboard).find(([otherAction, existingCode]) =>
    otherAction !== action && existingCode === code
  ) || (arrowAlias && arrowAlias !== action ? [arrowAlias, code] : null);

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

    for (const id of ["minimap", "healthHud", "kdHud", "areaHud", "fullscreenButton", "settingsButton", "ammoHud", "crouchButton", "switchWeaponButton", "scopeButton"]) {
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

    for (const id of ["minimap", "healthHud", "kdHud", "areaHud", "fullscreenButton", "settingsButton", "ammoHud", "crouchButton", "switchWeaponButton", "scopeButton"]) {
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
    cfg.y = Math.round(startOffsetY + e.clientY - startY);
    if (id === "areaHud") {
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

  playerName = value.slice(0, 16);
  setCookie("fps_player_name", playerName);
  if (input) input.value = playerName;
  return playerName;
}

loadPlayerName();
setupSettings();
updateGamepadStatus();

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

function makeRamp(ramp, color = 0x71808d) {
  const halfW = ramp.w / 2;
  const halfD = ramp.d / 2;
  const xLow = -halfW;
  const xHigh = halfW;
  const zLow = -halfD;
  const zHigh = halfD;
  const yLow = 0;
  const yHigh = ramp.h;

  let vertices;
  if (ramp.direction === "east" || ramp.direction === "west") {
    const highAtXHigh = ramp.direction === "east";
    const aY = highAtXHigh ? yLow : yHigh;
    const bY = highAtXHigh ? yHigh : yLow;
    vertices = new Float32Array([
      xLow, yLow, zLow,   xLow, yLow, zHigh,
      xHigh, yLow, zLow,  xHigh, yLow, zHigh,
      xLow, aY, zLow,     xLow, aY, zHigh,
      xHigh, bY, zLow,    xHigh, bY, zHigh
    ]);
  } else {
    const highAtZHigh = ramp.direction === "north";
    const aY = highAtZHigh ? yLow : yHigh;
    const bY = highAtZHigh ? yHigh : yLow;
    vertices = new Float32Array([
      xLow, yLow, zLow,   xHigh, yLow, zLow,
      xLow, yLow, zHigh,  xHigh, yLow, zHigh,
      xLow, aY, zLow,     xHigh, aY, zLow,
      xLow, bY, zHigh,    xHigh, bY, zHigh
    ]);
  }

  const indices = [
    0,1,3, 0,3,2,
    0,4,5, 0,5,1,
    2,3,7, 2,7,6,
    0,2,6, 0,6,4,
    1,5,7, 1,7,3,
    4,6,7, 4,7,5
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  geometry.clearGroups();
  geometry.addGroup(0, indices.length - 6, 0);
  geometry.addGroup(indices.length - 6, 6, 1);

  // スロープ側面は照明・影の影響を受けないようにする。
  const sideMaterial = new THREE.MeshBasicMaterial({ color });
  const topMaterial = new THREE.MeshStandardMaterial({
    color,
    roughness: .9,
    metalness: .05
  });

  const mesh = new THREE.Mesh(geometry, [sideMaterial, topMaterial]);
  mesh.position.set(ramp.x, 0, ramp.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  worldGroup.add(mesh);
  return mesh;
}

function buildWorld(data) {
  // マップ切替時は前の床・壁・障害物を破棄してから新しいマップを描画する。
  for (const oldObject of [...worldGroup.children]) {
    worldGroup.remove(oldObject);
    oldObject.traverse?.((part) => {
      part.geometry?.dispose();
      const materials = Array.isArray(part.material) ? part.material : [part.material];
      for (const material of materials) {
        material?.map?.dispose();
        material?.dispose();
      }
    });
  }

  worldData = data;
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

  const gridSize = Math.max(worldWidth, worldDepth);
  const grid = new THREE.GridHelper(gridSize, Math.max(1, Math.round(gridSize / 2)), 0x879487, 0x6b756b);
  grid.position.set(centerX, 0.01, centerZ);
  worldGroup.add(grid);

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
    makeBox(o.w, o.h, o.d, o.x, o.h / 2, o.z, 0x687582);
  }

  // 射撃場専用の特殊床。面全体を単色にして、三角形の境目のような斜め分割を見せない。
  for (const tile of data.floorTiles || []) {
    const isFire = tile.type === "fire";
    const tileMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(tile.w, tile.d),
      new THREE.MeshBasicMaterial({
        color: isFire ? 0xd92727 : 0x26b866,
        side: THREE.DoubleSide
      })
    );
    tileMesh.rotation.x = -Math.PI / 2;
    tileMesh.position.set(tile.x, 0.035, tile.z);
    tileMesh.renderOrder = 2;
    worldGroup.add(tileMesh);

    const edge = new THREE.Mesh(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(tile.w, 0.035, tile.d)),
      new THREE.LineBasicMaterial({ color: isFire ? 0xff8b55 : 0x9affc2 })
    );
    edge.position.set(tile.x, 0.045, tile.z);
    worldGroup.add(edge);
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

  // 無敵中は敵全員を表示。それ以外は自分（エリアでは味方も）の視界に入った敵だけ表示。
  const showAllEnemies = Number(myState.invulnerableUntil || 0) > Date.now();
  const observers = [{ x: myState.x, y: myState.y || 0, z: myState.z, yaw, team: myState.team }];
  if (selectedGameMode === "Area") {
    for (const obj of remotePlayers.values()) {
      const ally = obj.userData.playerState;
      if (ally && ally.health > 0 && ally.team === myState.team && ally.mode === "Area") {
        observers.push({ x: obj.position.x, y: obj.position.y, z: obj.position.z, yaw: obj.rotation.y, team: ally.team });
      }
    }
  }

  const raycaster = new THREE.Raycaster();
  for (const obj of remotePlayers.values()) {
    const enemy = obj.userData.playerState;
    if (!enemy || enemy.health <= 0 || enemy.finished) continue;
    if (selectedGameMode === "Area" && enemy.team === myState.team) continue;

    const ex = Number(enemy.x), ez = Number(enemy.z);
    // 乱戦では、プレイヤーからマップの長辺の半分以上離れた敵もミニマップに表示する。
    const enemyDistance = Math.hypot(ex - myState.x, ez - myState.z);
    const showDistantMeleeEnemy = selectedGameMode === "Melee"
      && enemyDistance >= Math.max(worldWidth, worldDepth) / 2;
    let spotted = showAllEnemies || showDistantMeleeEnemy;
    if (!spotted) {
      for (const observer of observers) {
        const dx = ex - observer.x;
        const dz = ez - observer.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 0.01 || distance > 45) continue;
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
    ctx.fillStyle = selectedGameMode === "Area" ? (enemy.team === "blue" ? "#4aa5ff" : "#ff5c5c") : "#ff4d4d";
    ctx.beginPath();
    ctx.arc(exMap, ezMap, showAllEnemies ? 5 : 4, 0, Math.PI * 2);
    ctx.fill();
    if (showAllEnemies) {
      ctx.strokeStyle = "rgba(255,255,255,.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function createWeaponMesh(weapon) {
  const group = new THREE.Group();
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
      const clothingColor = p.mode === "Area"
        ? new THREE.Color(p.team === "blue" ? 0x287bd1 : 0xc93636)
        : playerClothingColor(p.name);
      for (const mesh of [obj.userData.skinMeshes?.base?.torso, obj.userData.skinMeshes?.base?.armL, obj.userData.skinMeshes?.base?.armR]) {
        if (!mesh) continue;
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (material?.color) material.color.copy(clothingColor);
      }
    }
    obj.userData.playerState = p;
    const nameSprite = obj.userData.nameSprite;
    const teamColor = p.mode === "Area"
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

function updateAimAssist() {
  if (!joined || !myState) return;
  const touchDevice = window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  let strengthPercent = 0;
  if (controllerMode) {
    strengthPercent = Number(gameSettings.controllerAimAssistStrength ?? (gameSettings.controllerAimAssistEnabled ? 10 : 0));
  } else if (touchDevice) {
    strengthPercent = Number(gameSettings.touchAimAssistStrength ?? (gameSettings.touchAimAssistEnabled ? 10 : 0));
  } else {
    return;
  }
  if (![5, 10].includes(strengthPercent)) return;
  const strength = strengthPercent / 100;
  const origin = camera.position.clone();
  let best = null;
  for (const obj of remotePlayers.values()) {
    const target = obj.userData.playerState;
    if (!target || target.health <= 0 || !obj.visible) continue;
    if (selectedGameMode === "Area" && target.team && myState.team && target.team === myState.team) continue;
    const targetHeight = strengthPercent === 5
      ? (target.crouched ? 1.02 : 1.52)
      : (target.crouched ? 0.72 : 1.12);
    const point = obj.position.clone().add(new THREE.Vector3(0, targetHeight, 0));
    const offset = point.clone().sub(origin);
    const distance = offset.length();
    if (distance > 38 || distance < 0.1) continue;
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

  const lookSpeed = .045 * gameSettings.controllerSensitivity * (scopeEnabled && selectedWeapon === "sniper" ? gameSettings.sniperSensitivity : 1);
  yaw -= rx * lookSpeed;
  pitch -= ry * lookSpeed;
  pitch = THREE.MathUtils.clamp(pitch, -1.35, 1.35);

  const buttonFor = (action) => Number(gameSettings.controllerButtons?.[action] ?? DEFAULT_SETTINGS.controllerButtons[action]);
  const jumpPressed = Boolean(pad.buttons?.[buttonFor("jump")]?.pressed);
  const reloadPressed = Boolean(pad.buttons?.[buttonFor("reload")]?.pressed);
  const crouchPressed = Boolean(pad.buttons?.[buttonFor("crouch")]?.pressed);
  const switchPressed = Boolean(pad.buttons?.[buttonFor("switchWeapon")]?.pressed);
  const scopePressed = Boolean(pad.buttons?.[buttonFor("scope")]?.pressed);
  const firePressed = Boolean(pad.buttons?.[buttonFor("fire")]?.pressed);

  if (jumpPressed && !gamepadJumpHeld) {
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
  if (firePressed) {
    if (!gamepadFireHeld || !autoFireTimer) startFiring(true);
  } else if (gamepadFireHeld && autoFireTimer) {
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
  const strafe = THREE.MathUtils.clamp(keyboardStrafe + joystick.strafe, -1, 1) * scopeMoveMultiplier;

  socket.emit("input", { forward, strafe, crouch: crouchHeld, yaw, pitch });
  lastInputSent = now;
}

function jump() {
  if (!joined || myState?.health <= 0) return;
  socket.emit("jump");
}

function setCrouch(held) {
  if (!joined || myState?.health <= 0) return;
  crouchHeld = Boolean(held);
}

function fire() {
  if (!joined || myState?.reloading) return;
  // リスポーン直後の無敵時間中は発射操作自体を受け付けない。
  if (myState && Number(myState.invulnerableUntil || 0) > Date.now()) return;

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

function weaponDisplayName(id) {
  return ({ pistol: "ハンドガン", smg: "サブマシンガン", rifle: "アサルトライフル", shotgun: "ショットガン", marksman: "マークスマン", sniper: "スナイパー" })[id] || String(id || "武器");
}

function updateWeaponReticle() {
  const crosshair = document.getElementById("crosshair");
  if (!crosshair) return;
  const reticles = {
    pistol: ["weapon-pistol", "+"],
    smg: ["weapon-smg", "┼"],
    rifle: ["weapon-rifle", "┼"],
    shotgun: ["weapon-shotgun", "◎"],
    marksman: ["weapon-marksman", "⊙"],
    sniper: ["weapon-sniper", "·"]
  };
  const [className, glyph] = reticles[selectedWeapon] || reticles.pistol;
  crosshair.classList.remove("weapon-pistol", "weapon-smg", "weapon-rifle", "weapon-shotgun", "weapon-marksman", "weapon-sniper");
  crosshair.classList.add(className);
  crosshair.textContent = glyph;
}

function updateWeaponSwitchButton() {
  const button = document.getElementById("switchWeaponButton");
  if (button) {
    button.textContent = "武器切替\n" + (activeWeaponSlot + 1) + "/2";
    button.setAttribute("aria-label", "武器切替。現在 " + weaponDisplayName(selectedWeapon));
    button.title = weaponDisplayName(selectedWeapon);
  }
  updateScopeButton();
  updateWeaponReticle();
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
  document.getElementById("scopeOverlay")?.classList.toggle("hidden", !scopeEnabled);
  updateScopeButton();
}

function selectWeaponSlot(slot) {
  if (!joined || myState?.health <= 0) return;
  const now = performance.now();
  if (now - lastWeaponSwitchAt < WEAPON_SWITCH_COOLDOWN_MS) return;
  const nextSlot = Number(slot);
  const slots = Array.isArray(myState?.weaponSlots) ? myState.weaponSlots : weaponSlots;
  if (!Number.isInteger(nextSlot) || nextSlot < 0 || nextSlot > 1 || !slots[nextSlot]) return;
  if (nextSlot === activeWeaponSlot && selectedWeapon === slots[nextSlot]) return;
  stopFiring();
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

function startFiring(forceRepeat = false) {
  fire();
  const cfg = weaponConfig[selectedWeapon];
  if ((!cfg.automatic && !forceRepeat) || autoFireTimer) return;
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
  if (event.weapon === "marksman") return;
  const start = new THREE.Vector3(event.x, event.y, event.z);
  const entries = Array.isArray(event.tracers) && event.tracers.length
    ? event.tracers
    : [{ yaw: event.yaw, pitch: event.pitch, distance: event.hit ? 18 : 12 }];

  // 全武器で弾の色を統一する。
  const bulletColor = 0xffe0a3;
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
    if (isRifle) {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        start,
        start
      ]);
      const material = new THREE.LineBasicMaterial({
        color: bulletColor,
        transparent: true,
        opacity: .8
      });
      line = new THREE.Line(geometry, material);
      line.userData.rifleTracer = true;
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
        isRifle ? .055 : event.weapon === "shotgun" ? .045 : .035,
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
      life: isRifle ? 110 : event.weapon === "shotgun" ? 115 : 100
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
  ammoEl.textContent = myState.reloading ? "RELOADING..." : `${ammo} / ∞`;
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
  myId = null;
  myState = null;
  stopAllControls();
  setScopeEnabled(false);
  for (const id of ["weaponScreen", "modeScreen", "areaQueuePanel", "areaResultPanel", "hud", "touchUi", "settingsPanel"]) {
    document.getElementById(id)?.classList.add("hidden");
  }
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
  document.getElementById("hud").classList.remove("hidden");
  document.getElementById("touchUi").classList.remove("hidden");
  document.getElementById("settingsButton")?.classList.remove("hidden");
  document.getElementById("areaHud")?.classList.toggle("hidden", selectedGameMode !== "Area");
  const areaTeamLabel = document.getElementById("areaTeamLabel");
  if (areaTeamLabel) areaTeamLabel.textContent = selectedGameMode === "Area"
    ? "あなた：" + (player.team === "blue" ? "BLUE" : "RED")
    : "";
  setConnectionStatus("接続済み", true);
  updateAmmoHud();
  updateWeaponSwitchButton();
  if (reconnecting) showMessage("サーバーに再接続しました");
});

socket.on("players", updateRemotePlayers);
socket.on("playerSkin", ({ id, skin }) => {
  const playerObject = remotePlayers.get(id);
  if (playerObject && skin) applyPlayerSkin(playerObject, skin);
});

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
    const rejoinData = {
      name: playerName,
      weapon: weaponSlots[0] || selectedWeapon,
      secondaryWeapon: weaponSlots[1] || selectedSecondaryWeapon,
      skin: window.getPlayerSkinData?.(),
      mode: selectedGameMode === "Training" ? "Training" : "free-for-all"
    };
    if (selectedGameMode === "Area") {
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

socket.on("disconnect", () => {
  setConnectionStatus("接続中…", false);

  if (joined || (selectedGameMode === "Area" && areaQueuePanel && !areaQueuePanel.classList.contains("hidden"))) {
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

function updateLoadoutSelectionUi() {
  document.querySelectorAll(".weapon-card").forEach((card) => {
    const id = card.dataset.weapon;
    card.classList.toggle("selected-primary", id === selectedPrimaryWeapon);
    card.classList.toggle("selected-secondary", id === selectedSecondaryWeapon);
    card.classList.toggle("editing-slot", (loadoutSlotToEdit === 0 && id === selectedPrimaryWeapon) || (loadoutSlotToEdit === 1 && id === selectedSecondaryWeapon));
  });
  document.querySelectorAll("[data-loadout-slot]").forEach(button => button.classList.toggle("active", Number(button.dataset.loadoutSlot) === loadoutSlotToEdit));
  const status = document.getElementById("loadoutSelectionStatus");
  if (status) status.textContent = "1個目：" + weaponDisplayName(selectedPrimaryWeapon) + " ／ 2個目：" + weaponDisplayName(selectedSecondaryWeapon) + "　（" + (loadoutSlotToEdit + 1) + "個目を選択中）";
}
document.querySelectorAll("[data-loadout-slot]").forEach(button => button.addEventListener("click", () => {
  loadoutSlotToEdit = Number(button.dataset.loadoutSlot) === 1 ? 1 : 0;
  updateLoadoutSelectionUi();
}));
for (const button of document.querySelectorAll(".weapon-card")) {
  button.addEventListener("click", () => {
    if (joined) return;
    const weapon = button.dataset.weapon;
    if (loadoutSlotToEdit === 0) {
      if (weapon === selectedSecondaryWeapon) selectedSecondaryWeapon = selectedPrimaryWeapon;
      selectedPrimaryWeapon = weapon;
    } else {
      if (weapon === selectedPrimaryWeapon) { showMessage("1個目と2個目は別の武器を選んでください"); return; }
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
    mode: "free-for-all",
    skin: window.getPlayerSkinData?.()
  });
});

document.getElementById("areaModeButton")?.addEventListener("click", () => {
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
  socket.emit("joinAreaQueue", {
    name,
    weapon: selectedPrimaryWeapon,
    secondaryWeapon: selectedSecondaryWeapon,
    skin: window.getPlayerSkinData?.()
  });
});
updateLoadoutSelectionUi();

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

  yaw -= dx * .0045 * gameSettings.touchSensitivity * (scopeEnabled && selectedWeapon === "sniper" ? gameSettings.sniperSensitivity : 1);
  pitch -= dy * .0045 * gameSettings.touchSensitivity * (scopeEnabled && selectedWeapon === "sniper" ? gameSettings.sniperSensitivity : 1);
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
setupDraggableButton("scopeButton", "scopeButton");
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

  yaw -= dx * .0045 * gameSettings.touchSensitivity;
  pitch -= dy * .0045 * gameSettings.touchSensitivity;
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

  yaw -= e.movementX * .0028 * gameSettings.mouseSensitivity * (scopeEnabled && selectedWeapon === "sniper" ? gameSettings.sniperSensitivity : 1);
  pitch -= e.movementY * .0028 * gameSettings.mouseSensitivity * (scopeEnabled && selectedWeapon === "sniper" ? gameSettings.sniperSensitivity : 1);
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

function performBoundAction(action, pressed, isRepeat = false) {
  switch (action) {
    case "forward": movement.forward = pressed; break;
    case "back": movement.back = pressed; break;
    case "left": movement.left = pressed; break;
    case "right": movement.right = pressed; break;
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
  }
}

window.addEventListener("keydown", (e) => {
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
  const arrowActions = {
    ArrowUp: "forward", ArrowDown: "back", ArrowLeft: "left", ArrowRight: "right"
  };
  const arrowAction = arrowActions[e.code];
  if (arrowAction && gameSettings.keyboard[arrowAction] !== e.code) {
    performBoundAction(arrowAction, true, e.repeat);
    handled = true;
  }
  if (handled) e.preventDefault();
});

window.addEventListener("keyup", (e) => {
  for (const [action, code] of Object.entries(gameSettings.keyboard || DEFAULT_SETTINGS.keyboard)) {
    if (code === e.code) performBoundAction(action, false, false);
  }
  const arrowActions = {
    ArrowUp: "forward", ArrowDown: "back", ArrowLeft: "left", ArrowRight: "right"
  };
  const arrowAction = arrowActions[e.code];
  if (arrowAction && gameSettings.keyboard[arrowAction] !== e.code) {
    performBoundAction(arrowAction, false, false);
  }
});

window.addEventListener("blur", () => {
  movement.forward = false;
  movement.back = false;
  movement.left = false;
  movement.right = false;
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
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
  renderer.setSize(innerWidth, innerHeight);
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
    const tracer = tracers[i];
    const life = tracer.life || 120;
    const progress = THREE.MathUtils.clamp((now - tracer.born) / life, 0, 1);
    if (tracer.dot && tracer.start && tracer.end) {
      tracer.dot.position.lerpVectors(tracer.start, tracer.end, progress);

      if (tracer.line) {
        if (tracer.line.userData?.rifleTracer) {
          const current = tracer.dot.position;
          const dir = tracer.end.clone().sub(tracer.start).normalize();
          const streakLength = 0.75;
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
      scene.remove(tracers[i].dot);
      tracers[i].dot.geometry.dispose();
      tracers[i].dot.material.dispose();
      tracers.splice(i, 1);
    }
  }

  renderer.render(scene, camera);
}

requestAnimationFrame(animate);
