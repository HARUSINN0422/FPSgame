const SKIN_STORAGE_KEY = "fps_player_skin_v1";
const SKIN_SIZE = 64;

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

let activeTool = "pencil";
let drawingPointer = null;
let lastCell = null;
let undoStack = [];
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

  guideCtx.strokeStyle = "rgba(255,245,190,.85)";
  guideCtx.lineWidth = 1;
  // Main atlas region boundaries, not a replacement for the user's pixels.
  for (const [x, y, w, h] of [
    [0, 0, 32, 16], [0, 16, 16, 16], [16, 16, 24, 16],
    [40, 16, 16, 16], [0, 32, 64, 16],
    [16, 48, 16, 16], [32, 48, 16, 16]
  ]) {
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
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      skinCtx.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
      skinCtx.imageSmoothingEnabled = false;
      skinCtx.drawImage(image, 0, 0, SKIN_SIZE, SKIN_SIZE);
      drawGuides();
      drawPreview();
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

document.querySelectorAll("[data-skin-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    activeTool = button.dataset.skinTool;
    document.querySelectorAll("[data-skin-tool]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    if (statusEl) {
      statusEl.textContent = activeTool === "pencil" ? "ペン：ドラッグして描画"
        : activeTool === "eraser" ? "消しゴム：ドラッグして透明にする"
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
window.addEventListener("pointerup", () => { drawingPointer = null; lastCell = null; });

document.getElementById("skinUndoButton")?.addEventListener("click", () => {
  const previous = undoStack.pop();
  if (!previous) return;
  skinCtx.putImageData(previous, 0, 0);
  updatePreview();
  if (statusEl) statusEl.textContent = "1回分を元に戻しました";
});

document.getElementById("skinClearButton")?.addEventListener("click", () => {
  saveUndoState();
  skinCtx.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
  updatePreview();
  if (statusEl) statusEl.textContent = "キャンバスを透明にしました。必要な部分を描いてください";
});

document.getElementById("skinResetButton")?.addEventListener("click", () => {
  saveUndoState();
  makeDefaultSkin();
  updatePreview();
  if (statusEl) statusEl.textContent = "初期スキンに戻しました（保存するまで適用されません）";
});

document.getElementById("skinSaveButton")?.addEventListener("click", () => {
  try {
    const dataUrl = skinCanvas.toDataURL("image/png");
    localStorage.setItem(SKIN_STORAGE_KEY, dataUrl);
    window.applyPlayerSkinToServer?.(dataUrl);
    closeSkinEditor();
    if (statusEl) statusEl.textContent = "保存しました";
    document.dispatchEvent(new CustomEvent("fps-skin-saved", { detail: { dataUrl } }));
  } catch (error) {
    if (statusEl) statusEl.textContent = "保存できませんでした: " + (error?.message || "不明なエラー");
  }
});

// Initialize a usable default immediately, then replace it with the locally saved skin if present.
makeDefaultSkin();
const initialSkin = skinCanvas.toDataURL("image/png");
if (!localStorage.getItem(SKIN_STORAGE_KEY)) {
  localStorage.setItem(SKIN_STORAGE_KEY, initialSkin);
}
window.getPlayerSkinData = () => localStorage.getItem(SKIN_STORAGE_KEY) || skinCanvas.toDataURL("image/png");

const brushPreview = document.getElementById("skinBrushSize");
updateBrushLabel();
if (brushPreview) brushPreview.value = "1";

const savedSkinAtStartup = localStorage.getItem(SKIN_STORAGE_KEY);
if (savedSkinAtStartup) {
  loadSkinDataUrl(savedSkinAtStartup);
}
