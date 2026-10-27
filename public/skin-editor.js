import * as THREE from "three";

const SKIN_STORAGE_KEY = "fps_player_skin_v1";
const SKIN_SIZE = 64;

// キャラクター本体に使われるベース面だけを検査する。
// 外側レイヤーや未使用領域は通常から透明なので、判定対象に含めない。
const SKIN_BASE_FACE_RECTS = [
  [0,8,8,8], [16,8,8,8], [8,0,8,8], [16,0,8,8], [8,8,8,8], [24,8,8,8],
  [16,20,4,12], [28,20,4,12], [20,16,8,4], [28,16,8,4], [20,20,8,12], [32,20,8,12],
  [40,20,4,12], [48,20,4,12], [44,16,4,4], [48,16,4,4], [44,20,4,12], [52,20,4,12],
  [0,20,4,12], [8,20,4,12], [4,16,4,4], [8,16,4,4], [4,20,4,12], [12,20,4,12],
  [32,52,4,12], [40,52,4,12], [36,48,4,4], [40,48,4,4], [36,52,4,12], [44,52,4,12],
  [16,52,4,12], [24,52,4,12], [20,48,4,4], [24,48,4,4], [20,52,4,12], [28,52,4,12]
];

function hasMostlyErasedBaseSkin() {
  if (!skinCtx) return false;
  const pixels = skinCtx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE).data;
  const checked = new Uint8Array(SKIN_SIZE * SKIN_SIZE);
  let total = 0;
  let transparent = 0;
  for (const [x, y, w, h] of SKIN_BASE_FACE_RECTS) {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        const index = py * SKIN_SIZE + px;
        if (checked[index]) continue;
        checked[index] = 1;
        total++;
        if (pixels[index * 4 + 3] < 16) transparent++;
      }
    }
  }
  return total > 0 && transparent / total >= 0.5;
}

const editorPanel = document.getElementById("skinEditorPanel");
const skinCanvas = document.getElementById("skinCanvas");
const skinCtx = skinCanvas?.getContext("2d", { willReadFrequently: true });
const guideCanvas = document.getElementById("skinGuideCanvas");
const guideCtx = guideCanvas?.getContext("2d");
const previewCanvas = document.getElementById("skinPreview");
const previewCtx = previewCanvas?.getContext("2d");
const colorInput = document.getElementById("skinColor");
const brushSizeInput = document.getElementById("skinBrushSize");
const brushSizeValue = document.getElementById("skinBrushSizeValue");
const statusEl = document.getElementById("skinEditorStatus");
const skin3DCanvas = document.getElementById("skin3DCanvas");

let activeTool = "pencil";
let skinRenderer = null;
let skinScene = null;
let skinCamera = null;
let skinTexture = null;
let skinModel = null;
let skinRaycaster = null;
let skinPointer = null;
let rotatePointer = null;
let lastRotatePoint = null;
const skinPointers = new Map();
let pinchStartDistance = 0;
let pinchStartCameraDistance = 0;
let drawingPointer = null;
let lastCell = null;
let undoStack = [];
let skinLoadGeneration = 0;
const UNDO_LIMIT = 30;

function makeDefaultSkin() {
  skinCtx.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);

  const fill = (x, y, w, h, color) => {
    skinCtx.fillStyle = color;
    skinCtx.fillRect(x, y, w, h);
  };

  const shirt = "#2875b9";
  const pants = "#303b4b";
  const skin = "#e5b99a";
  const hair = "#34251f";

  // Head base (classic 64x64 skin atlas).
  fill(0, 0, 32, 16, skin);
  fill(8, 0, 8, 3, hair);
  fill(0, 8, 8, 3, hair);
  fill(8, 8, 8, 3, hair);
  fill(16, 8, 8, 3, hair);
  fill(24, 8, 8, 3, hair);
  fill(9, 11, 2, 1, "#292b30");
  fill(13, 11, 2, 1, "#292b30");
  fill(10, 14, 4, 1, "#9b5a4f");

  // Torso, right arm and right leg.
  fill(16, 16, 24, 16, shirt);
  fill(20, 16, 8, 4, shirt);
  fill(20, 20, 8, 2, skin);
  fill(40, 16, 16, 16, shirt);
  fill(0, 16, 16, 16, pants);

  // Left arm and left leg live in the lower half of a 64x64 skin.
  fill(32, 48, 16, 16, shirt);
  fill(16, 48, 16, 16, pants);

  // A small shirt accent on the front-facing torso and sleeves.
  fill(23, 22, 2, 7, "#e8edf3");
  fill(44, 25, 1, 5, "#e8edf3");
  fill(36, 57, 1, 5, "#e8edf3");

  skinCtx.imageSmoothingEnabled = false;
  drawGuides();
  drawPreview();
  skinTexture?.dispose();
  if (skinCanvas && skinRenderer) {
    skinTexture = new THREE.CanvasTexture(skinCanvas);
    skinTexture.magFilter = THREE.NearestFilter;
    skinTexture.minFilter = THREE.NearestFilter;
    skinTexture.colorSpace = THREE.SRGBColorSpace;
    skinModel?.traverse((object) => {
      if (object.isMesh) object.material.map = skinTexture;
    });
    skinTexture.needsUpdate = true;
  }
}

function drawGuides() {
  if (!guideCtx) return;
  guideCtx.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
  guideCtx.strokeStyle = "rgba(255,255,255,.34)";
  guideCtx.lineWidth = 0.35;
  for (let x = 0; x <= SKIN_SIZE; x += 4) {
    guideCtx.beginPath();
    guideCtx.moveTo(x + 0.5, 0);
    guideCtx.lineTo(x + 0.5, SKIN_SIZE);
    guideCtx.stroke();
  }
  for (let y = 0; y <= SKIN_SIZE; y += 4) {
    guideCtx.beginPath();
    guideCtx.moveTo(0, y + 0.5);
    guideCtx.lineTo(SKIN_SIZE, y + 0.5);
    guideCtx.stroke();
  }

  // Detect every atlas pixel used by the model's six faces, including both outer layers.
  // Unmapped pixels remain editable on the canvas, but changing them cannot alter the character.
  const mappedFaceRects = [
    // Head base and outer layer
    [0,8,8,8], [16,8,8,8], [8,0,8,8], [16,0,8,8], [8,8,8,8], [24,8,8,8],
    [32,8,8,8], [48,8,8,8], [40,0,8,8], [48,0,8,8], [40,8,8,8], [56,8,8,8],
    // Torso base and outer layer
    [16,20,4,12], [28,20,4,12], [20,16,8,4], [28,16,8,4], [20,20,8,12], [32,20,8,12],
    [16,36,4,12], [28,36,4,12], [20,32,8,4], [28,32,8,4], [20,36,8,12], [32,36,8,12],
    // Right arm base and outer layer
    [40,20,4,12], [48,20,4,12], [44,16,4,4], [48,16,4,4], [44,20,4,12], [52,20,4,12],
    [40,36,4,12], [48,36,4,12], [44,32,4,4], [48,32,4,4], [44,36,4,12], [52,36,4,12],
    // Right leg base and outer layer
    [0,20,4,12], [8,20,4,12], [4,16,4,4], [8,16,4,4], [4,20,4,12], [12,20,4,12],
    [0,36,4,12], [8,36,4,12], [4,32,4,4], [8,32,4,4], [4,36,4,12], [12,36,4,12],
    // Left arm base and outer layer
    [32,52,4,12], [40,52,4,12], [36,48,4,4], [40,48,4,4], [36,52,4,12], [44,52,4,12],
    [48,52,4,12], [56,52,4,12], [52,48,4,4], [56,48,4,4], [52,52,4,12], [60,52,4,12],
    // Left leg base and outer layer
    [16,52,4,12], [24,52,4,12], [20,48,4,4], [24,48,4,4], [20,52,4,12], [28,52,4,12],
    [0,52,4,12], [8,52,4,12], [4,48,4,4], [8,48,4,4], [4,52,4,12], [12,52,4,12]
  ];
  const mappedPixels = new Uint8Array(SKIN_SIZE * SKIN_SIZE);
  for (const [x, y, w, h] of mappedFaceRects) {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) mappedPixels[py * SKIN_SIZE + px] = 1;
    }
  }

  // Hatch every unmapped pixel instead of implying that only one blank strip is unused.
  guideCtx.save();
  guideCtx.beginPath();
  for (let y = 0; y < SKIN_SIZE; y++) {
    for (let x = 0; x < SKIN_SIZE; x++) {
      if (!mappedPixels[y * SKIN_SIZE + x]) guideCtx.rect(x, y, 1, 1);
    }
  }
  guideCtx.clip();
  guideCtx.fillStyle = "rgba(220, 65, 65, .24)";
  guideCtx.fillRect(0, 0, SKIN_SIZE, SKIN_SIZE);
  guideCtx.strokeStyle = "rgba(255, 115, 115, .8)";
  guideCtx.lineWidth = 0.7;
  for (let start = -SKIN_SIZE; start < SKIN_SIZE * 2; start += 4) {
    guideCtx.beginPath();
    guideCtx.moveTo(start, 0);
    guideCtx.lineTo(start - SKIN_SIZE, SKIN_SIZE);
    guideCtx.stroke();
  }
  guideCtx.restore();

  // Outline every mapped atlas block, including the head's outer layer and left limbs.
  guideCtx.lineWidth = 1;
  const mappedRegions = [
    [0, 0, 32, 16, "rgba(255,245,190,.95)"],   // head base
    [32, 0, 32, 16, "rgba(115,220,255,.95)"],  // head overlay
    [0, 16, 16, 16, "rgba(255,245,190,.95)"],  // right leg base
    [16, 16, 24, 16, "rgba(255,245,190,.95)"], // torso base
    [40, 16, 16, 16, "rgba(255,245,190,.95)"], // right arm base
    [0, 32, 16, 16, "rgba(115,220,255,.95)"],  // right leg overlay
    [16, 32, 24, 16, "rgba(115,220,255,.95)"], // torso overlay
    [40, 32, 16, 16, "rgba(115,220,255,.95)"], // right arm overlay
    [0, 48, 16, 16, "rgba(115,220,255,.95)"],  // left leg overlay
    [16, 48, 16, 16, "rgba(255,245,190,.95)"], // left leg base
    [32, 48, 16, 16, "rgba(255,245,190,.95)"], // left arm base
    [48, 48, 16, 16, "rgba(115,220,255,.95)"]  // left arm overlay
  ];
  for (const [x, y, w, h, color] of mappedRegions) {
    guideCtx.strokeStyle = color;
    guideCtx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
}

function drawPreview() {
  if (!previewCtx || !skinCanvas) return;
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.imageSmoothingEnabled = false;
  const crop = (sx, sy, sw, sh, dx, dy, dw, dh) =>
    previewCtx.drawImage(skinCanvas, sx, sy, sw, sh, dx, dy, dw, dh);

  // A small front-view cutout assembled from the front faces of the atlas.
  crop(8, 8, 8, 8, 48, 4, 32, 32);       // head
  crop(44, 20, 4, 12, 24, 40, 16, 64);   // right arm
  crop(20, 20, 8, 12, 40, 40, 48, 72);   // torso
  crop(36, 52, 4, 12, 88, 40, 16, 64);   // left arm
  crop(4, 20, 4, 12, 40, 112, 20, 64);   // right leg
  crop(20, 52, 4, 12, 68, 112, 20, 64);  // left leg
}

function buildSkinPart(name, dimensions, position, faceRects) {
  const geometry = new THREE.BoxGeometry(...dimensions);
  const uv = geometry.attributes.uv;
  // BoxGeometry faces are +X, -X, +Y, -Y, +Z, -Z; map each to its skin-atlas rectangle.
  for (let face = 0; face < 6; face++) {
    const [x, y, w, h] = faceRects[face];
    for (let vertex = face * 4; vertex < face * 4 + 4; vertex++) {
      const u = uv.getX(vertex);
      const v = uv.getY(vertex);
      uv.setXY(vertex, (x + u * w) / SKIN_SIZE, 1 - (y + (1 - v) * h) / SKIN_SIZE);
    }
  }
  uv.needsUpdate = true;
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    map: skinTexture, roughness: 0.92, metalness: 0, transparent: true, alphaTest: 0.02
  }));
  mesh.name = name;
  mesh.position.set(...position);
  skinModel.add(mesh);
  return mesh;
}

function init3DSkinEditor() {
  if (!skin3DCanvas || skinRenderer) return;
  skinRenderer = new THREE.WebGLRenderer({ canvas: skin3DCanvas, antialias: false, alpha: true });
  skinRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  skinRenderer.setSize(480, 480, false);
  skinRenderer.outputColorSpace = THREE.SRGBColorSpace;
  skinScene = new THREE.Scene();
  skinScene.background = new THREE.Color("#202a36");
  skinCamera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  skinCamera.position.set(7.5, 6.2, 10);
  skinCamera.lookAt(0, 0.2, 0);
  skinScene.add(new THREE.HemisphereLight(0xffffff, 0x566273, 2.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
  keyLight.position.set(5, 9, 7);
  skinScene.add(keyLight);
  skinTexture = new THREE.CanvasTexture(skinCanvas);
  skinTexture.magFilter = THREE.NearestFilter;
  skinTexture.minFilter = THREE.NearestFilter;
  skinTexture.colorSpace = THREE.SRGBColorSpace;
  skinModel = new THREE.Group();
  skinScene.add(skinModel);
  const head = [[0,8,8,8],[16,8,8,8],[8,0,8,8],[16,0,8,8],[8,8,8,8],[24,8,8,8]];
  const torso = [[16,20,4,12],[28,20,4,12],[20,16,8,4],[28,16,8,4],[20,20,8,12],[32,20,8,12]];
  const rightArm = [[40,20,4,12],[48,20,4,12],[44,16,4,4],[48,16,4,4],[44,20,4,12],[52,20,4,12]];
  const leftArm = [[32,52,4,12],[40,52,4,12],[36,48,4,4],[40,48,4,4],[36,52,4,12],[44,52,4,12]];
  const rightLeg = [[0,20,4,12],[8,20,4,12],[4,16,4,4],[8,16,4,4],[4,20,4,12],[12,20,4,12]];
  const leftLeg = [[16,52,4,12],[24,52,4,12],[20,48,4,4],[24,48,4,4],[20,52,4,12],[28,52,4,12]];
  buildSkinPart("head", [1,1,1], [0,2.45,0], head);
  buildSkinPart("torso", [1,1.5,0.5], [0,0.85,0], torso);
  buildSkinPart("rightArm", [0.5,1.5,0.5], [-0.75,0.85,0], rightArm);
  buildSkinPart("leftArm", [0.5,1.5,0.5], [0.75,0.85,0], leftArm);
  buildSkinPart("rightLeg", [0.5,1.5,0.5], [-0.25,-0.65,0], rightLeg);
  buildSkinPart("leftLeg", [0.5,1.5,0.5], [0.25,-0.65,0], leftLeg);
  skinRaycaster = new THREE.Raycaster();
  skinRenderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());
  skinRenderer.domElement.addEventListener("pointerdown", on3DSkinPointerDown);
  skinRenderer.domElement.addEventListener("pointermove", on3DSkinPointerMove);
  skinRenderer.domElement.addEventListener("pointerup", on3DSkinPointerUp);
  skinRenderer.domElement.addEventListener("pointercancel", on3DSkinPointerUp);
  skinRenderer.domElement.addEventListener("wheel", (event) => {
    event.preventDefault();
    skinCamera.position.multiplyScalar(event.deltaY > 0 ? 1.08 : 0.92);
    skinCamera.position.clampLength(5, 18);
    render3DSkin();
  }, { passive: false });
  render3DSkin();
}

function render3DSkin() {
  if (!skinRenderer || !skinScene || !skinCamera) return;
  const rect = skin3DCanvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * Math.min(window.devicePixelRatio || 1, 2)));
  const height = Math.max(1, Math.round(rect.height * Math.min(window.devicePixelRatio || 1, 2)));
  if (skinRenderer.domElement.width !== width || skinRenderer.domElement.height !== height) {
    skinRenderer.setSize(rect.width, rect.height, false);
    skinCamera.aspect = rect.width / Math.max(1, rect.height);
    skinCamera.updateProjectionMatrix();
  }
  skinRenderer.render(skinScene, skinCamera);
}

function get3DHit(event) {
  const rect = skin3DCanvas.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  skinRaycaster.setFromCamera(pointer, skinCamera);
  return skinRaycaster.intersectObjects(skinModel.children, false)[0] || null;
}

function paint3DHit(hit) {
  if (!hit?.uv || !skinCtx) return;
  const x = Math.max(0, Math.min(SKIN_SIZE - 1, Math.floor(hit.uv.x * SKIN_SIZE)));
  const y = Math.max(0, Math.min(SKIN_SIZE - 1, Math.floor((1 - hit.uv.y) * SKIN_SIZE)));
  paintCell(x, y);
  skinTexture.needsUpdate = true;
  drawPreview();
  render3DSkin();
}

function on3DSkinPointerDown(event) {
  if (event.pointerType === "touch") {
    skinPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (skinPointers.size >= 2) {
      skinPointer = null;
      rotatePointer = null;
      lastRotatePoint = null;
      const points = [...skinPointers.values()];
      pinchStartDistance = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
      pinchStartCameraDistance = skinCamera.position.distanceTo(new THREE.Vector3(0, 0.2, 0));
      skin3DCanvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
  }
  if (event.button === 2 || activeTool === "rotate") {
    rotatePointer = event.pointerId;
    lastRotatePoint = { x: event.clientX, y: event.clientY };
    skin3DCanvas.setPointerCapture(event.pointerId);
    skin3DCanvas.style.cursor = "grabbing";
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  event.preventDefault();
  const hit = get3DHit(event);
  // Touch/mouse drags that begin in the stage margin rotate the model; drags on the model paint it.
  if (!hit) {
    rotatePointer = event.pointerId;
    lastRotatePoint = { x: event.clientX, y: event.clientY };
    skin3DCanvas.setPointerCapture(event.pointerId);
    skin3DCanvas.style.cursor = "grabbing";
    return;
  }
  if (activeTool === "fill") {
    saveUndoState();
    const x = Math.max(0, Math.min(SKIN_SIZE - 1, Math.floor(hit.uv.x * SKIN_SIZE)));
    const y = Math.max(0, Math.min(SKIN_SIZE - 1, Math.floor((1 - hit.uv.y) * SKIN_SIZE)));
    floodFill(x, y);
    skinTexture.needsUpdate = true;
    render3DSkin();
    return;
  }
  saveUndoState();
  skinPointer = event.pointerId;
  skin3DCanvas.setPointerCapture(event.pointerId);
  paint3DHit(hit);
}

function on3DSkinPointerMove(event) {
  if (skinPointers.has(event.pointerId)) skinPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (skinPointers.size >= 2) {
    const points = [...skinPointers.values()];
    const distance = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
    const targetDistance = THREE.MathUtils.clamp(pinchStartCameraDistance * pinchStartDistance / distance, 5, 18);
    const target = new THREE.Vector3(0, 0.2, 0);
    const direction = skinCamera.position.clone().sub(target).normalize();
    skinCamera.position.copy(target.add(direction.multiplyScalar(targetDistance)));
    skinCamera.lookAt(0, 0.2, 0);
    render3DSkin();
    event.preventDefault();
    return;
  }
  if (event.pointerId === rotatePointer && lastRotatePoint) {
    const dx = event.clientX - lastRotatePoint.x;
    const dy = event.clientY - lastRotatePoint.y;
    skinModel.rotation.y += dx * 0.012;
    skinModel.rotation.x = Math.max(-0.45, Math.min(0.45, skinModel.rotation.x + dy * 0.006));
    lastRotatePoint = { x: event.clientX, y: event.clientY };
    render3DSkin();
    return;
  }
  if (event.pointerId !== skinPointer) return;
  const hit = get3DHit(event);
  if (hit) paint3DHit(hit);
}

function on3DSkinPointerUp(event) {
  skinPointers.delete(event.pointerId);
  if (skinPointers.size < 2) {
    pinchStartDistance = 0;
    pinchStartCameraDistance = 0;
  }
  if (event.pointerId === skinPointer) skinPointer = null;
  if (event.pointerId === rotatePointer) {
    rotatePointer = null;
    lastRotatePoint = null;
    skin3DCanvas.style.cursor = activeTool === "rotate" ? "grab" : "crosshair";
  }
}

function paintTransparentBasePixelsYellow() {
  if (!skinCtx) return;
  const image = skinCtx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE);
  const pixels = image.data;
  for (const [x, y, w, h] of SKIN_BASE_FACE_RECTS) {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        const offset = (py * SKIN_SIZE + px) * 4;
        if (pixels[offset + 3] === 0) {
          pixels[offset] = 255;
          pixels[offset + 1] = 230;
          pixels[offset + 2] = 0;
          pixels[offset + 3] = 255;
        }
      }
    }
  }
  skinCtx.putImageData(image, 0, 0);
  skinTexture && (skinTexture.needsUpdate = true);
  drawPreview();
  render3DSkin();
}

function saveUndoState() {
  if (!skinCtx) return;
  undoStack.push(skinCtx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function updatePreview() {
  drawPreview();
}

function getCell(event) {
  const rect = skinCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(SKIN_SIZE - 1, Math.floor((event.clientX - rect.left) / rect.width * SKIN_SIZE))),
    y: Math.max(0, Math.min(SKIN_SIZE - 1, Math.floor((event.clientY - rect.top) / rect.height * SKIN_SIZE)))
  };
}

function paintCell(x, y) {
  const brush = Math.max(1, Number(brushSizeInput?.value) || 1);
  const offset = Math.floor((brush - 1) / 2);
  if (activeTool === "eraser") {
    skinCtx.clearRect(x - offset, y - offset, brush, brush);
  } else {
    skinCtx.fillStyle = colorInput?.value || "#2875b9";
    skinCtx.fillRect(x - offset, y - offset, brush, brush);
  }
}

function paintLine(from, to) {
  let x0 = from.x, y0 = from.y;
  const x1 = to.x, y1 = to.y;
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;

  while (true) {
    paintCell(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * error;
    if (e2 >= dy) { error += dy; x0 += sx; }
    if (e2 <= dx) { error += dx; y0 += sy; }
  }
  updatePreview();
}

function samePixel(data, offset, color) {
  return data[offset] === color[0] &&
    data[offset + 1] === color[1] &&
    data[offset + 2] === color[2] &&
    data[offset + 3] === color[3];
}

function floodFill(startX, startY) {
  const image = skinCtx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE);
  const data = image.data;
  const startOffset = (startY * SKIN_SIZE + startX) * 4;
  const target = [data[startOffset], data[startOffset + 1], data[startOffset + 2], data[startOffset + 3]];

  const hex = colorInput?.value || "#2875b9";
  const replacement = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255
  ];
  if (target.every((value, i) => value === replacement[i])) return;

  const stack = [[startX, startY]];
  const visited = new Uint8Array(SKIN_SIZE * SKIN_SIZE);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= SKIN_SIZE || y < 0 || y >= SKIN_SIZE) continue;
    const cellIndex = y * SKIN_SIZE + x;
    if (visited[cellIndex]) continue;
    visited[cellIndex] = 1;
    const offset = cellIndex * 4;
    if (!samePixel(data, offset, target)) continue;
    data[offset] = replacement[0];
    data[offset + 1] = replacement[1];
    data[offset + 2] = replacement[2];
    data[offset + 3] = replacement[3];
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  skinCtx.putImageData(image, 0, 0);
  updatePreview();
}

function loadSkinDataUrl(dataUrl) {
  const generation = ++skinLoadGeneration;
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      // Ignore an older asynchronous image load if a newer load/save has started.
      if (generation !== skinLoadGeneration) {
        resolve(false);
        return;
      }
      skinCtx.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
      skinCtx.imageSmoothingEnabled = false;
      skinCtx.drawImage(image, 0, 0, SKIN_SIZE, SKIN_SIZE);
      if (hasMostlyErasedBaseSkin()) {
        makeDefaultSkin();
        const defaultDataUrl = skinCanvas.toDataURL("image/png");
        localStorage.setItem(SKIN_STORAGE_KEY, defaultDataUrl);
        window.applyPlayerSkinToServer?.(defaultDataUrl);
        document.dispatchEvent(new CustomEvent("fps-skin-saved", { detail: { dataUrl: defaultDataUrl } }));
        if (statusEl) statusEl.textContent = "スキンの半分以上が透明だったため、初期スキンに戻しました。";
      } else {
        drawGuides();
        drawPreview();
      }
      resolve(true);
    };
    image.onerror = () => resolve(false);
    image.src = dataUrl;
  });
}

async function openSkinEditor() {
  // Close the settings panel first so the editor has a clear, usable workspace.
  document.getElementById("settingsPanel")?.classList.add("hidden");
  const saved = localStorage.getItem(SKIN_STORAGE_KEY);
  if (saved) await loadSkinDataUrl(saved);
  else makeDefaultSkin();

  undoStack = [];
  drawingPointer = null;
  lastCell = null;
  editorPanel?.classList.remove("hidden");
  editorPanel?.setAttribute("aria-hidden", "false");
  init3DSkinEditor();
  requestAnimationFrame(render3DSkin);
}

function closeSkinEditor() {
  editorPanel?.classList.add("hidden");
  editorPanel?.setAttribute("aria-hidden", "true");
  drawingPointer = null;
  lastCell = null;
}

function updateBrushLabel() {
  if (brushSizeValue && brushSizeInput) brushSizeValue.textContent = brushSizeInput.value + " px";
}

document.getElementById("skinEditorOpenButton")?.addEventListener("click", openSkinEditor);
document.getElementById("settingsSkinEditorButton")?.addEventListener("click", openSkinEditor);
document.getElementById("skinEditorCloseButton")?.addEventListener("click", closeSkinEditor);

document.getElementById("skinExportButton")?.addEventListener("click", () => {
  try {
    const dataUrl = skinCanvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = "fps-skin-64x64.png";
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (statusEl) statusEl.textContent = "スキンをPNG画像として書き出しました（64×64ピクセル）";
  } catch (error) {
    if (statusEl) statusEl.textContent = "画像を書き出せませんでした: " + (error?.message || "不明なエラー");
  }
});

document.getElementById("skinImportButton")?.addEventListener("click", () => {
  document.getElementById("skinImportInput")?.click();
});

document.getElementById("skinImportInput")?.addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    if (file.type !== "image/png" && !/\.png$/i.test(file.name)) {
      throw new Error("PNG画像を選択してください");
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("画像ファイルを読み込めませんでした"));
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("PNG画像を開けませんでした"));
      img.src = dataUrl;
    });
    if (image.naturalWidth !== SKIN_SIZE || image.naturalHeight !== SKIN_SIZE) {
      throw new Error("スキン画像は64×64ピクセルにしてください（選択画像: " + image.naturalWidth + "×" + image.naturalHeight + "）");
    }
    const loaded = await loadSkinDataUrl(dataUrl);
    if (!loaded) throw new Error("スキン画像をキャンバスに読み込めませんでした");
    const normalizedDataUrl = skinCanvas.toDataURL("image/png");
    localStorage.setItem(SKIN_STORAGE_KEY, normalizedDataUrl);
    if (localStorage.getItem(SKIN_STORAGE_KEY) !== normalizedDataUrl) {
      throw new Error("読み込んだスキンを端末に保存できませんでした");
    }
    if (skinTexture) skinTexture.needsUpdate = true;
    drawGuides();
    drawPreview();
    render3DSkin();
    document.dispatchEvent(new CustomEvent("fps-skin-saved", { detail: { dataUrl: normalizedDataUrl } }));
    const result = await window.applyPlayerSkinToServer?.(normalizedDataUrl);
    if (statusEl) {
      statusEl.textContent = result?.ok
        ? "PNGスキンを読み込み、保存してゲームに適用しました"
        : "PNGスキンを読み込み、この端末に保存しました。ゲーム中でない場合は次回開始時に適用されます。";
    }
  } catch (error) {
    if (statusEl) statusEl.textContent = "画像を読み込めませんでした: " + (error?.message || "不明なエラー");
  } finally {
    if (input) input.value = "";
  }
});

document.querySelectorAll("[data-skin-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    activeTool = button.dataset.skinTool;
    if (skin3DCanvas) skin3DCanvas.style.cursor = activeTool === "rotate" ? "grab" : "crosshair";
    document.querySelectorAll("[data-skin-tool]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    if (statusEl) {
      statusEl.textContent = activeTool === "pencil" ? "ペン：ドラッグして描画"
        : activeTool === "eraser" ? "消しゴム：ドラッグして透明にする（保存時は黄色になります）"
        : activeTool === "rotate" ? "回転：ドラッグして3Dモデルを回転"
        : "塗りつぶし：選択色で同じ色の領域を塗る";
    }
  });
});

brushSizeInput?.addEventListener("input", updateBrushLabel);

skinCanvas?.addEventListener("contextmenu", (event) => event.preventDefault());
skinCanvas?.addEventListener("pointerdown", (event) => {
  if (!skinCtx || event.button === 2) return;
  event.preventDefault();
  const cell = getCell(event);
  if (activeTool === "fill") {
    saveUndoState();
    floodFill(cell.x, cell.y);
    return;
  }
  saveUndoState();
  drawingPointer = event.pointerId;
  lastCell = cell;
  skinCanvas.setPointerCapture?.(event.pointerId);
  paintLine(cell, cell);
});
skinCanvas?.addEventListener("pointermove", (event) => {
  if (event.pointerId !== drawingPointer || !lastCell) return;
  event.preventDefault();
  const cell = getCell(event);
  paintLine(lastCell, cell);
  lastCell = cell;
});
function stopDrawing(event) {
  if (event.pointerId !== drawingPointer) return;
  drawingPointer = null;
  lastCell = null;
}
skinCanvas?.addEventListener("pointerup", stopDrawing);
skinCanvas?.addEventListener("pointercancel", stopDrawing);
skinCanvas?.addEventListener("lostpointercapture", (event) => {
  if (event.pointerId === drawingPointer) {
    drawingPointer = null;
    lastCell = null;
  }
});
window.addEventListener("pointerup", (event) => {
  // Do not cancel a drawing gesture when a different finger/pointer is released.
  if (event.pointerId === drawingPointer) {
    drawingPointer = null;
    lastCell = null;
  }
});

document.getElementById("skinUndoButton")?.addEventListener("click", () => {
  const previous = undoStack.pop();
  if (!previous) return;
  skinCtx.putImageData(previous, 0, 0);
  updatePreview();
  if (skinTexture) skinTexture.needsUpdate = true;
  render3DSkin();
  if (statusEl) statusEl.textContent = "1回分を元に戻しました";
});

document.getElementById("skinClearButton")?.addEventListener("click", () => {
  saveUndoState();
  skinCtx.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
  updatePreview();
  if (skinTexture) skinTexture.needsUpdate = true;
  render3DSkin();
  if (statusEl) statusEl.textContent = "キャンバスを透明にしました。必要な部分を描いてください";
});

document.getElementById("skinResetButton")?.addEventListener("click", () => {
  saveUndoState();
  makeDefaultSkin();
  updatePreview();
  if (skinTexture) skinTexture.needsUpdate = true;
  render3DSkin();
  if (statusEl) statusEl.textContent = "初期スキンに戻しました（保存するまで適用されません）";
});

document.getElementById("skinSaveButton")?.addEventListener("click", async () => {
  const saveButton = document.getElementById("skinSaveButton");
  if (saveButton?.disabled) return;
  if (saveButton) saveButton.disabled = true;
  try {
    // Invalidate any image load started before this save so it cannot overwrite the new drawing.
    skinLoadGeneration++;
    paintTransparentBasePixelsYellow();
    const dataUrl = skinCanvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("PNGデータを作成できませんでした");

    localStorage.setItem(SKIN_STORAGE_KEY, dataUrl);
    if (localStorage.getItem(SKIN_STORAGE_KEY) !== dataUrl) {
      throw new Error("端末への保存内容を確認できませんでした");
    }

    // Local persistence is confirmed separately from applying it to an active server session.
    document.dispatchEvent(new CustomEvent("fps-skin-saved", { detail: { dataUrl } }));
    const result = await window.applyPlayerSkinToServer?.(dataUrl);

    if (result?.ok) {
      if (statusEl) statusEl.textContent = "保存してゲームに適用しました";
      closeSkinEditor();
    } else if (result?.notInGame || !result) {
      if (statusEl) statusEl.textContent = "この端末に保存しました。次回ゲーム開始時に適用されます。";
    } else if (result.reason === "timeout") {
      if (statusEl) statusEl.textContent = "端末には保存済みですが、サーバーの応答がありません。接続後にもう一度「保存して適用」を押してください。";
    } else {
      if (statusEl) statusEl.textContent = "端末には保存済みですが、ゲームへの適用に失敗しました（" + (result.reason || "不明な理由") + "）。接続を確認して再度保存してください。";
    }
  } catch (error) {
    if (statusEl) statusEl.textContent = "保存できませんでした: " + (error?.message || "不明なエラー");
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
});

// Initialize a usable default immediately, then replace it with the locally saved skin if present.
makeDefaultSkin();
const initialSkin = skinCanvas.toDataURL("image/png");
if (!localStorage.getItem(SKIN_STORAGE_KEY)) {
  localStorage.setItem(SKIN_STORAGE_KEY, initialSkin);
}
window.getPlayerSkinData = () => localStorage.getItem(SKIN_STORAGE_KEY) || skinCanvas.toDataURL("image/png");

window.addEventListener("resize", render3DSkin);

const brushPreview = document.getElementById("skinBrushSize");
updateBrushLabel();
if (brushPreview) brushPreview.value = "1";

// The saved skin is loaded when the editor opens. Avoid a second background load here:
 // overlapping image.onload callbacks could otherwise overwrite a newer edit.