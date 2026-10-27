// 入口：装配画布、键盘/鼠标、元件库、属性面板、撤销重做、预览截图。
// 交互规则见 docs/03 §3（D-009：模态编辑，无拖放）。

import { emptyDoc, snap, type Doc, type Part } from "./model";
import { loadAllArt, loadArt, loadSymbols, type SymbolTable } from "./symbols";
import { mmToScreen, render, screenToMm, type View } from "./render";
import {
  cancel,
  commitPlace,
  commitWire,
  cursorFor,
  deleteAt,
  dropAt,
  enterPlace,
  modeLabel,
  orthoPoint,
  pickUp,
  toggleMirror,
  toggleRotate,
  type EditorHooks,
  type Mode,
} from "./mode";

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const n = document.querySelector(sel);
  if (!n) throw new Error(`缺少元素 ${sel}`);
  return n as T;
};

// ---------------------------------------------------------------- 状态

const doc: Doc = emptyDoc();
let table: SymbolTable;
let mode: Mode = { kind: "view" };
let view: View = { scale: 8, pan: { x: 120, y: 100 } };
let selectedId: string | null = null;
let hoverMm = { x: 0, y: 0 };
const artMap = new Map<string, { viewBox: string; inner: string }>();

const canvas = $<SVGSVGElement>("#canvas");

const past: string[] = [];
const future: string[] = [];
const snapshot = (): string => JSON.stringify(doc);

let hooks: EditorHooks;

function makeHooks(tableRef: SymbolTable): EditorHooks {
  return {
    doc,
    table: tableRef,
    commit() {
      past.push(snapshot());
      if (past.length > 200) past.shift();
      future.length = 0;
    },
    changed: repaint,
    setMode(m) {
      mode = m;
      repaint();
    },
    status(t) {
      $("#hint").textContent = t;
    },
  };
}

// ---------------------------------------------------------------- 渲染

function ghostOf(): { part: Part; at: { x: number; y: number }; valid: boolean } | null {
  if (mode.kind === "place") {
    return {
      part: { id: "ghost", ref: "?", symbol: mode.symbol, at: mode.at, rot: mode.rot, mirror: mode.mirror },
      at: mode.at,
      valid: true,
    };
  }
  if (mode.kind === "move") {
    const id = mode.partId;
    const p = id ? doc.parts.find((x) => x.id === id) : undefined;
    return p ? { part: p, at: p.at, valid: true } : null;
  }
  return null;
}

function repaint(): void {
  render(canvas, {
    doc,
    table,
    art: (f) => artMap.get(f),
    view,
    selectedId,
    ghost: ghostOf(),
    wirePreview: mode.kind === "wire" && mode.from ? { from: mode.from, to: orthoPoint(mode.from, hoverMm) } : null,
  });
  $("#mode").textContent = modeLabel(mode);
  canvas.style.cursor = cursorFor(mode);
  $("#stats").textContent = `${doc.parts.length} 元件 · ${doc.wires.length} 导线`;
  $("#pos").textContent = `${hoverMm.x.toFixed(1)}, ${hoverMm.y.toFixed(1)} mm`;
}

// ---------------------------------------------------------------- 键盘

window.addEventListener("keydown", (ev) => {
  if ((ev.target as HTMLElement)?.matches?.("input, textarea, select")) return;

  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "r") {
    ev.preventDefault();
    toggleRotate(mode, hooks);
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "e") {
    ev.preventDefault();
    toggleMirror(mode, hooks);
    return;
  }

  switch (ev.key) {
    case "Escape":
      cancel(mode, hooks);
      selectedId = null;
      $("#props").hidden = true;
      return;
    case " ":
      ev.preventDefault();
      openPalette();
      return;
    case "r":
      enterPlace("resistor", table, hooks, hoverMm);
      return;
    case "c":
      enterPlace("capacitor", table, hooks, hoverMm);
      return;
    case "w":
      hooks.setMode({ kind: "wire", from: null });
      hooks.status("画线：点击起点（只走上下左右），esc 退出");
      return;
    case "q":
      hooks.setMode({ kind: "delete" });
      hooks.status("删除：点元件删元件；点导线只删该段");
      return;
    case "m":
      moveArmed = true;
      hooks.setMode({ kind: "view" });
      hooks.status("移动：点一个元件拿起（点击画布放下，esc 放回）");
      return;
    case "d":
      hooks.setMode({ kind: "copy" });
      hooks.status("复制：点要复制的元件");
      return;
    default:
      return;
  }
});

let moveArmed = false;
/** m 的两段式：第一次点击拿起，第二次点击放下 */
function afterArmPick(partId: string | null): boolean {
  if (!moveArmed) return false;
  moveArmed = false;
  if (!partId) return false;
  const m = pickUp(partId, doc);
  if (!m) return false;
  hooks.setMode(m);
  hooks.status("移动：点击画布放下，esc 放回原位");
  return true;
}

// ---------------------------------------------------------------- 鼠标

canvas.addEventListener("pointermove", (ev) => {
  const r = canvas.getBoundingClientRect();
  hoverMm = screenToMm({ x: ev.clientX - r.left, y: ev.clientY - r.top }, view);
  if (panning) return;

  if (mode.kind === "place") mode = { ...mode, at: { x: snap(hoverMm.x), y: snap(hoverMm.y) } };
  if (mode.kind === "move" && mode.partId) {
    const id: string = mode.partId;
    const p = doc.parts.find((x) => x.id === id);
    if (p) p.at = { x: snap(hoverMm.x), y: snap(hoverMm.y) };
  }
  repaint();
});

canvas.addEventListener("pointerdown", (ev) => {
  if (ev.button === 1) return;
  const r = canvas.getBoundingClientRect();
  const at = screenToMm({ x: ev.clientX - r.left, y: ev.clientY - r.top }, view);
  const target = ev.target as Element;
  const partId = target.closest("[data-part-id]")?.getAttribute("data-part-id") ?? null;
  const wireId = target.closest("[data-wire-id]")?.getAttribute("data-wire-id") ?? null;

  // m 模式的第一下：拿起
  if (afterArmPick(partId)) return;

  switch (mode.kind) {
    case "place":
      commitPlace(mode, hooks);
      return;
    case "wire": {
      const p = { x: snap(at.x), y: snap(at.y) };
      if (!mode.from) {
        hooks.setMode({ ...mode, from: p });
      } else {
        const next = commitWire(mode.from, p, hooks);
        hooks.setMode({ ...mode, from: next });
      }
      return;
    }
    case "delete":
      deleteAt(doc, partId, wireId, hooks);
      return;
    case "copy": {
      if (!partId) return;
      const src = doc.parts.find((p) => p.id === partId);
      if (!src) return;
      enterPlace(src.symbol, table, hooks, at);
      const m = mode as unknown as Extract<Mode, { kind: "place" }>;
      hooks.setMode({ ...m, rot: src.rot, mirror: src.mirror });
      hooks.status(`复制 ${src.ref}：点击落点（ctrl+r 旋转，esc 退出）`);
      return;
    }
    case "move": {
      if (!mode.partId) return;
      dropAt(mode, at, hooks);
      hooks.setMode({ kind: "view" });
      return;
    }
    default: {
      selectedId = partId ?? wireId ?? null;
      if (partId) selectPart(partId, false);
      repaint();
    }
  }
});

canvas.addEventListener("dblclick", (ev) => {
  const partId = (ev.target as Element).closest("[data-part-id]")?.getAttribute("data-part-id") ?? null;
  if (partId) {
    selectedId = partId;
    selectPart(partId, true);
    repaint();
  }
});

// ---------------------------------------------------------------- 平移 / 缩放

let panning: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 1) return;
  panning = { x: ev.clientX, y: ev.clientY };
  ev.preventDefault();
});
window.addEventListener("pointerup", () => (panning = null));
window.addEventListener("pointermove", (ev) => {
  if (!panning) return;
  view = { ...view, pan: { x: view.pan.x + (ev.clientX - panning.x), y: view.pan.y + (ev.clientY - panning.y) } };
  panning = { x: ev.clientX, y: ev.clientY };
  repaint();
});
canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const at = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    const before = screenToMm(at, view);
    const k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const scale = Math.min(60, Math.max(2, view.scale * k));
    view = { scale, pan: { x: at.x - before.x * scale, y: at.y - before.y * scale } };
    repaint();
  },
  { passive: false },
);

// ---------------------------------------------------------------- 元件库

function openPalette(): void {
  const dlg = $<HTMLDialogElement>("#palette");
  const list = $("#paletteList");
  list.replaceChildren();
  for (const [slug, sym] of Object.entries(table.symbols)) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sym";
    card.title = `${sym.name.zh} / ${sym.name.en} · ${sym.standard}`;
    const art = artMap.get(sym.file);
    card.innerHTML = `<span class="thumb">${
      art ? `<svg viewBox="${art.viewBox}" width="100%" height="100%">${art.inner}</svg>` : ""
    }</span><span class="name">${sym.name.zh}</span><span class="meta">${sym.pins
      .map((p) => p.id)
      .join(" ")}</span>`;
    card.addEventListener("click", () => {
      dlg.close();
      enterPlace(slug, table, hooks, hoverMm);
    });
    list.append(card);
  }
  dlg.showModal();
}

// ---------------------------------------------------------------- 属性面板

function selectPart(partId: string, open: boolean): void {
  const p = doc.parts.find((x) => x.id === partId);
  if (!p) return;
  const sym = table.symbols[p.symbol];
  if (!sym) return;
  const panel = $<HTMLDivElement>("#props");
  panel.hidden = !open;
  if (!open) return;

  panel.innerHTML = `
    <h3>${sym.name.zh} <small>${p.ref}</small></h3>
    <label>参考编号 <input id="p-ref" value="${p.ref}"></label>
    <label>别名 <input id="p-alias" value="${p.alias ?? ""}" placeholder="（默认不显示）"></label>
    ${
      sym.models.length
        ? `<label>型号 <select id="p-model">${sym.models
            .map((m) => `<option ${m === p.model ? "selected" : ""}>${m}</option>`)
            .join("")}</select></label>`
        : ""
    }
    ${
      sym.category === "passive"
        ? `<label>值 <input id="p-value" value="${p.value ?? ""}"></label>`
        : ""
    }
    <label>旋转 <select id="p-rot">${[0, 90, 180, 270]
      .map((r) => `<option value="${r}" ${r === p.rot ? "selected" : ""}>${r}°</option>`)
      .join("")}</select></label>
    <p class="muted">位置 ${p.at.x}, ${p.at.y} mm · ${sym.standard}</p>
  `;

  const bind = (id: string, apply: (v: string) => void): void => {
    const inp = panel.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    inp?.addEventListener("change", () => {
      hooks.commit();
      apply(inp.value);
      repaint();
    });
  };
  bind("p-ref", (v) => (p.ref = v.trim() || p.ref));
  bind("p-alias", (v) => (v.trim() ? (p.alias = v.trim()) : delete p.alias));
  bind("p-model", (v) => (p.model = v));
  bind("p-value", (v) => (p.value = v));
  bind("p-rot", (v) => (p.rot = Number(v) as Part["rot"]));
}

// ---------------------------------------------------------------- 撤销 / 重做

function undo(): void {
  const prev = past.pop();
  if (!prev) return;
  future.push(snapshot());
  Object.assign(doc, JSON.parse(prev) as Doc);
  repaint();
}
function redo(): void {
  const next = future.pop();
  if (!next) return;
  past.push(snapshot());
  Object.assign(doc, JSON.parse(next) as Doc);
  repaint();
}

// ---------------------------------------------------------------- 工具栏

$("#btnUndo").addEventListener("click", undo);
$("#btnRedo").addEventListener("click", redo);
$("#btnNew").addEventListener("click", () => {
  hooks.commit();
  Object.assign(doc, emptyDoc());
  repaint();
});
$("#btnSave").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${doc.name}.design.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
$("#btnPreview").addEventListener("click", () => void previewPng());

/** 预览 = 可保存的截图（D-008） */
async function previewPng(): Promise<void> {
  const dlg = $<HTMLDialogElement>("#preview");
  const box = $("#previewImg");
  const bg = "#ffffff";
  const w = canvas.clientWidth || 1200;
  const h = canvas.clientHeight || 800;

  const clone = canvas.cloneNode(true) as SVGSVGElement;
  clone.querySelector(".grid")?.remove();
  for (const n of clone.querySelectorAll(".pins")) n.remove();
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", `${w}`);
  clone.setAttribute("height", `${h}`);
  clone.insertAdjacentHTML("afterbegin", `<rect width="100%" height="100%" fill="${bg}"/>`);

  const svgText = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("截图失败：SVG 里有外部引用？"));
      img.src = url;
    });
    const k = 2; // 2× 像素比
    const cv = document.createElement("canvas");
    cv.width = w * k;
    cv.height = h * k;
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error("canvas 不可用");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
    if (!blob) throw new Error("toBlob 失败");
    const pngUrl = URL.createObjectURL(blob);
    box.innerHTML = `<img src="${pngUrl}" alt="预览">`;
    $<HTMLButtonElement>("#previewSave").onclick = () => {
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = `${doc.name}.png`;
      a.click();
    };
    dlg.showModal();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- 启动

async function main(): Promise<void> {
  table = await loadSymbols();
  await loadAllArt(table);
  for (const sym of Object.values(table.symbols)) artMap.set(sym.file, await loadArt(sym));
  hooks = makeHooks(table);

  // 首屏演示：一个电阻 + 一个电容
  enterPlace("resistor", table, hooks, { x: 20, y: 20 });
  commitPlace(mode as Extract<Mode, { kind: "place" }>, hooks);
  enterPlace("capacitor", table, hooks, { x: 20, y: 40 });
  commitPlace(mode as Extract<Mode, { kind: "place" }>, hooks);
  hooks.setMode({ kind: "view" });
  hooks.status("r 电阻 · c 电容 · 空格 元件库 · w 画线 · q 删除 · m 移动 · d 复制 · esc 退出 · 中键平移/滚轮缩放");
  repaint();
}

void main();

export { mmToScreen };
