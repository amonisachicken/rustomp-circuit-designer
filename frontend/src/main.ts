// 入口：装配画布、键盘/鼠标、元件库、属性面板、撤销重做、预览截图。
// 交互规则见 docs/03 §3（D-009：模态编辑，无拖放）。

import { backend, type NetlistResult, type SimResult } from "./backend";
import { drawWaveform } from "./plot";
import {
  VALUE_UNITS,
  UNIT_LABEL,
  emptyDoc,
  joinValue,
  normalizeWires,
  snap,
  splitValue,
  type Doc,
  type Part,
} from "./model";
import { loadAllArt, loadArt, loadSymbols, type SymText, type SymbolTable } from "./symbols";
import { fitView, hitTest, mmToScreen, render, screenToMm, type View } from "./render";
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
const artMap = new Map<string, { viewBox: string; inner: string; texts: SymText[] }>();

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

// ---------------------------------------------------------------- 网表（后端生成）

let netlist: NetlistResult | null = null;
let netlistError: string | null = null;
let refreshTimer: number | undefined;
/** 防止"刷新网表 → 重画 → 又触发刷新"的循环 */
let suppressSchedule = false;

/** 文档变了就防抖刷新网表预览（状态栏/网表面板用） */
function scheduleNetlist(): void {
  if (suppressSchedule) return;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshNetlist(), 300);
}

async function refreshNetlist(): Promise<void> {
  try {
    netlist = await backend.netlist(doc);
    netlistError = null;
  } catch (e) {
    netlist = null;
    netlistError = e instanceof Error ? e.message : String(e);
  }
  renderNetlist();
  suppressSchedule = true;
  repaint();
  suppressSchedule = false;
}

function renderNetlist(): void {
  const pane = $<HTMLElement>("#netlistPane");
  const text = $("#netlistText");
  const lints = $("#netlistLints");
  if (netlistError) {
    text.textContent = `后端未连接：${netlistError}\n\n先启动后端：cd backend && cargo run`;
    lints.innerHTML = `<span class="err">✗ 无法生成网表</span>`;
    return;
  }
  if (!netlist) {
    text.textContent = "（还没生成）";
    lints.textContent = "";
    return;
  }
  text.textContent = netlist.cir;
  const errs = netlist.lints.filter((l) => l.level === "error");
  const warns = netlist.lints.filter((l) => l.level === "warn");
  lints.innerHTML = [
    errs.length ? `<span class="err">✗ ${errs.length} error</span>` : `<span class="ok">✓ 无 error</span>`,
    warns.length ? `<span class="warn">! ${warns.length} warn</span>` : "",
  ]
    .filter(Boolean)
    .join(" &#183; ");
  if (errs.length) {
    const list = errs.map((e) => `· ${e.msg}`).join("\n");
    pane.dataset["errors"] = list;
  } else {
    delete pane.dataset["errors"];
  }
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
    dangling: (netlist?.dangling ?? []).map((d) => ({
      at: d.at,
      label: `${d.ref}.${d.pin} 悬空`,
    })),
    wirePreview: mode.kind === "wire" && mode.from ? { from: mode.from, to: orthoPoint(mode.from, hoverMm) } : null,
  });
  $("#mode").textContent = modeLabel(mode);
  canvas.style.cursor = cursorFor(mode);
  $("#stats").textContent = `${doc.parts.length} 元件 · ${doc.wires.length} 导线`;
  $("#pos").textContent = `${hoverMm.x.toFixed(1)}, ${hoverMm.y.toFixed(1)} mm`;
  scheduleNetlist();
}

// ---------------------------------------------------------------- 键盘

window.addEventListener("keydown", (ev) => {
  if ((ev.target as HTMLElement)?.matches?.("input, textarea, select")) return;

  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    undo();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "y") {
    ev.preventDefault();
    redo();
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
    case "g":
      enterPlace("earth", table, hooks, hoverMm);
      return;
    case "h":
      ev.preventDefault();
      $<HTMLDialogElement>("#help").showModal();
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

  // hover 高亮：把"当前 2×2 格内可点中的目标"标出来（不然用户不知道命中区多大）
  if (mode.kind === "view" || mode.kind === "delete") {
    const h = hitTest(doc, table, hoverMm);
    const key = `${h.partId ?? ""}|${h.wireId ?? ""}`;
    if (key !== hoverKey) {
      hoverKey = key;
      for (const n of canvas.querySelectorAll(".hovered")) n.classList.remove("hovered");
      if (h.partId) canvas.querySelector(`[data-part-id="${h.partId}"]`)?.classList.add("hovered");
      if (h.wireId) canvas.querySelector(`[data-wire-id="${h.wireId}"]`)?.classList.add("hovered");
    }
  }

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
  // 命中区 = 以鼠标为心 2×2 格（5 mm）的方框：细线/小符号也点得中
  const hit = hitTest(doc, table, at);
  const partId = hit.partId;
  const wireId = hit.wireId;

  // 双击检测：不依赖 DOM 的 dblclick（重画会把节点换掉，浏览器可能不发 dblclick）
  const now = performance.now();
  if (partId && lastClick.id === partId && now - lastClick.t < 400) {
    lastClick = { id: null, t: 0 };
    selectedId = partId;
    selectPart(partId, true);
    repaint();
    ev.preventDefault();
    return;
  }
  lastClick = { id: partId, t: now };

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
        // 合并重合部分 + 接续直导线（docs/03 §7.5）
        const before = doc.wires.length;
        doc.wires = normalizeWires(doc.wires);
        if (doc.wires.length !== before) repaint();
        hooks.setMode({ ...mode, from: next });
      }
      return;
    }
    case "delete":
      deleteAt(doc, partId, wireId, hooks);
      // 删除一段后，同一行上原本被它间接连着的线段不该再合并 —— 归一化只是收尾
      doc.wires = normalizeWires(doc.wires);
      repaint();
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

let hoverKey = "";

/** 双击检测状态（见 pointerdown 里的注释） */
let lastClick: { id: string | null; t: number } = { id: null, t: 0 };

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
      VALUE_UNITS[p.symbol]
        ? (() => {
            const units = VALUE_UNITS[p.symbol]!;
            const { num, unit } = splitValue(p.value, units);
            const opts = units
              .map((u) => `<option value="${u}" ${u === unit ? "selected" : ""}>${UNIT_LABEL[u] ?? u}</option>`)
              .join("");
            return `<label>数值 <input id="p-num" type="number" step="any" inputmode="decimal" value="${num}" placeholder="例如 10">
              <select id="p-unit" ${units.length === 1 ? "disabled" : ""}>${opts}</select></label>`;
          })()
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

  // 数值：文本框（数字）+ 单位下拉 → 组装成 SPICE 写法（"10k" / "100n" / "9"）
  if (VALUE_UNITS[p.symbol]) {
    const units = VALUE_UNITS[p.symbol]!;
    const numEl = panel.querySelector<HTMLInputElement>("#p-num");
    const unitEl = panel.querySelector<HTMLSelectElement>("#p-unit");
    const apply2 = (): void => {
      hooks.commit();
      p.value = joinValue(numEl?.value ?? "", unitEl?.value ?? units[0] ?? "");
      repaint();
    };
    numEl?.addEventListener("change", apply2);
    unitEl?.addEventListener("change", apply2);
  }
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

$("#btnNetlist").addEventListener("click", async () => {
  await refreshNetlist();
  if (!netlist) {
    $("#hint").textContent = `生成失败：${netlistError ?? "未知错误"}`;
    return;
  }
  const errs = netlist.lints.filter((l) => l.level === "error");
  if (errs.length) {
    $("#netlistPane").hidden = false;
    $("#hint").textContent = `有 ${errs.length} 个 error，先修好再导出：${errs[0]?.msg ?? ""}`;
    return;
  }
  const url = URL.createObjectURL(new Blob([netlist.cir], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${doc.name}.cir`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  $("#hint").textContent = `已导出 ${doc.name}.cir（${netlist.lints.length} 条提示）`;
});

// ---------------------------------------------------------------- 仿真

$("#btnSim").addEventListener("click", () => {
  const dlg = $<HTMLDialogElement>("#sim");
  $("#simStatus").textContent = "";
  $("#simLog").textContent = "";
  dlg.showModal();
  void runSim();
});
$("#simRun").addEventListener("click", () => void runSim());
$("#simClose").addEventListener("click", () => $<HTMLDialogElement>("#sim").close());

async function runSim(): Promise<void> {
  const status = $("#simStatus");
  const amp = Number($<HTMLInputElement>("#simAmp").value) || 0.2;
  const freq = Number($<HTMLInputElement>("#simFreq").value) || 1000;
  const stop = Number($<HTMLInputElement>("#simStop").value) || 10;
  status.textContent = "运行中…";
  try {
    const r: SimResult = await backend.simulate(doc, { amp, freq, stop_ms: stop });
    drawWaveform($<SVGSVGElement>("#simPlot"), {
      t: r.t,
      vin: r.vin,
      vout: r.vout,
      labelIn: r.ports.in ?? "in",
      labelOut: r.ports.out ?? "out",
    });
    // 说清"INPUT/OUTPUT 封装"的语义：源注入 in 网、探针看 out 网（仅仿真，不进交付网表）
    const hasSrc = doc.parts.some((p) => p.symbol === "voltage-source");
    $("#simSemantics").textContent =
      `源：${hasSrc ? "图纸自带的 voltage-source" : `自动注入 SIN(0 ${amp} V, ${freq} Hz) → ${r.ports.in ?? "?"}`}` +
      ` · 探针：v(${r.ports.in ?? "?"}) / v(${r.ports.out ?? "?"})` +
      `（只用于仿真，不写进交付的 .cir）`;
    const maxOut = r.vout.length ? Math.max(...r.vout.map(Math.abs)) : 0;
    const thd = r.thd === null ? "—" : `${(r.thd * 100).toFixed(2)}%`;
    status.textContent =
      `${r.t.length} 点 · ${stop} ms · ${freq} Hz · |out|max = ${maxOut.toFixed(3)} V · THD = ${thd}`;
    $("#simLog").textContent = r.log || "（无输出）";
  } catch (e) {
    status.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
    $("#simLog").textContent = String(e);
  }
}

$("#helpClose").addEventListener("click", () => $<HTMLDialogElement>("#help").close());

$("#btnCodegen").addEventListener("click", async () => {
  $("#hint").textContent = "生成代码中…";
  try {
    const r = await backend.codegen(doc);
    const url = URL.createObjectURL(new Blob([r.code], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.name}.circuit.rs`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    $("#hint").textContent = `已生成 Rust 电路（未知量 ${r.unknowns ?? "?"}，节点 ${r.ports.join("/")}）`;
  } catch (e) {
    $("#hint").textContent = `生成代码失败：${e instanceof Error ? e.message : String(e)}`;
  }
});

$("#btnNetlistToggle").addEventListener("click", () => {
  const pane = $<HTMLElement>("#netlistPane");
  pane.hidden = !pane.hidden;
  if (!pane.hidden) void refreshNetlist();
});
$("#netlistClose").addEventListener("click", () => ($("#netlistPane").hidden = true));

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

/** `?load=<name>` 载入 frontend/public/examples/<name>.design.json（示例电路） */
async function loadExample(name: string): Promise<boolean> {
  try {
    // no-store：示例会被改（模板重生成），别让浏览器缓存住旧版本
    const res = await fetch(`examples/${name}.design.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    Object.assign(doc, JSON.parse(text) as Doc);
    doc.wires = normalizeWires(doc.wires);
    doc.nextId = Math.max(doc.nextId ?? 1, doc.parts.length + doc.wires.length + 1);
    return true;
  } catch (e) {
    $("#hint").textContent = `载入示例失败：${e instanceof Error ? e.message : e}`;
    return false;
  }
}

async function main(): Promise<void> {
  table = await loadSymbols();
  await loadAllArt(table);
  for (const sym of Object.values(table.symbols)) artMap.set(sym.file, await loadArt(sym));
  hooks = makeHooks(table);

  const q = new URLSearchParams(location.search);
  const example = q.get("load");
  if (example) {
    await loadExample(example);
  } else {
    // 首屏演示：一个电阻 + 一个电容
    enterPlace("resistor", table, hooks, { x: 20, y: 20 });
    commitPlace(mode as Extract<Mode, { kind: "place" }>, hooks);
    enterPlace("capacitor", table, hooks, { x: 20, y: 40 });
    commitPlace(mode as Extract<Mode, { kind: "place" }>, hooks);
  }
  hooks.setMode({ kind: "view" });
  view = fitView(doc, table, { w: canvas.clientWidth || 1200, h: canvas.clientHeight || 800 });
  repaint();
  hooks.status("r 电阻 · c 电容 · 空格 元件库 · w 画线 · q 删除 · m 移动 · d 复制 · esc 退出 · 中键平移/滚轮缩放");
  repaint();

  // 冒烟测试：?selftest=1 —— 验证"2×2 格命中区"与"双击开属性"
  if (q.has("selftest")) {
    const r = doc.parts.find((p) => p.symbol === "resistor");
    // 取最右边那条导线（中点不会被某个元件的包围盒盖住）
    const wire = [...doc.wires].sort((a, b) => Math.max(b.points[1].x, b.points[0].x) - Math.max(a.points[1].x, a.points[0].x))[0];
    const results: string[] = [];
    if (r && wire) {
      const sym = table.symbols[r.symbol]!;
      const center = { x: r.at.x, y: r.at.y };
      // ① 命中区：离元件中心 4 mm（>2 格？2 格=5mm，故 4mm 内应命中）
      const near = hitTest(doc, table, { x: center.x, y: center.y + 4 });
      results.push(`hit4mm=${near.partId === r.id}`);
      // ② 命中区外：离中心 8 mm 应落空
      const far = hitTest(doc, table, { x: center.x, y: center.y + 12 });
      results.push(`miss12mm=${far.partId !== r.id}`);
      // ③ 导线也算命中
      const mid = { x: (wire.points[0].x + wire.points[1].x) / 2, y: (wire.points[0].y + wire.points[1].y) / 2 };
      // 往下偏 4 mm（避开元件的包围盒，仍在 2×2 格命中区内）
      const w = hitTest(doc, table, { x: mid.x, y: mid.y - 4 });
      results.push(`wire4mm=${w.wireId === wire.id}`);
      // ④ 双击开属性（真实指针事件，坐标换算到屏幕）
      const p0 = mmToScreen(center, view);
      const rect = canvas.getBoundingClientRect();
      const opt = { clientX: rect.left + p0.x, clientY: rect.top + p0.y, bubbles: true, button: 0 };
      canvas.dispatchEvent(new PointerEvent("pointerdown", opt));
      canvas.dispatchEvent(new PointerEvent("pointerup", opt));
      canvas.dispatchEvent(new PointerEvent("pointerdown", opt));
      const props = document.querySelector<HTMLElement>("#props");
      results.push(`dblclick-props=${!!props && !props.hidden && !!props.querySelector("#p-ref")}`);

      // ⑤ 自动接续直导线：(0,0)-(10,0) + (10,0)-(20,0) → 一条
      const join = normalizeWires([
        { id: "wa", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
        { id: "wb", points: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
      ]);
      results.push(`join=${join.length === 1 && join[0]!.points[1].x === 20}`);

      // ⑥ 合并重合部分：(0,0)-(20,0) + (5,0)-(30,0) → (0,0)-(30,0)
      const overlap = normalizeWires([
        { id: "wc", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
        { id: "wd", points: [{ x: 5, y: 0 }, { x: 30, y: 0 }] },
      ]);
      results.push(`merge=${overlap.length === 1 && overlap[0]!.points[1].x === 30}`);

      // ⑦ 不同行不合并（十字交叉保留两根）
      const cross = normalizeWires([
        { id: "we", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
        { id: "wf", points: [{ x: 10, y: -10 }, { x: 10, y: 10 }] },
      ]);
      results.push(`cross=${cross.length === 2}`);

      // ⑧ 删除即"两锚点之间"：三段接成一条后删掉 → 0 段
      const three = normalizeWires([
        { id: "wg", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
        { id: "wh", points: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
        { id: "wi", points: [{ x: 20, y: 0 }, { x: 30, y: 0 }] },
      ]);
      const afterDelete = three.filter((w) => w.id !== three[0]!.id);
      results.push(`delete-span=${three.length === 1 && afterDelete.length === 0}`);
      void sym;
    }
    // ⑨ 符号自带文字被抠出来（V+/V−、In/Out、C/B/E），且不再留在图里
    const inArt = artMap.get(table.symbols["node-in"]!.file);
    results.push(`texts-extracted=${(inArt?.texts.length ?? 0) > 0 && !inArt?.inner.includes("<text")}`);

    // ⑩ g 放接地点 / h 打开帮助
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
    results.push(`key-g=${mode.kind === "place" && mode.symbol === "earth"}`);
    mode = { kind: "view" };
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    results.push(`key-h=${$<HTMLDialogElement>("#help").open}`);
    $<HTMLDialogElement>("#help").close();

    // ⑪ 数值单位：拆/装往返 + 单位换算
    const sp = splitValue("4.7u", VALUE_UNITS["capacitor"]!);
    results.push(`value-split=${sp.num === "4.7" && sp.unit === "u"}`);
    results.push(`value-join=${joinValue("10", "k") === "10k" && joinValue("470", "Ω") === "470" && joinValue("9", "V") === "9"}`);
    const legacy = splitValue("47m", VALUE_UNITS["capacitor"]!);
    results.push(`value-legacy=${legacy.num === "47" && legacy.unit === "n"}`);

    // ⑫ ⌘/Ctrl+Y 重做（先撤销一次再重做回来）
    const n0 = doc.parts.length;
    enterPlace("resistor", table, hooks, { x: 0, y: 200 });
    commitPlace(mode as unknown as Extract<Mode, { kind: "place" }>, hooks);
    hooks.setMode({ kind: "view" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    const afterUndo = doc.parts.length;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", metaKey: true, bubbles: true }));
    results.push(`redo-ctrl-y=${afterUndo === n0 && doc.parts.length === n0 + 1}`);

    const ok = results.every((x) => x.endsWith("=true"));
    $("#hint").textContent = `SELFTEST ${ok ? "ok" : "FAIL"} ${results.join(" ")}`;
  }

  // 调试开关：?sim=1 直接打开仿真弹窗（方便截图/排查）
  if (q.has("sim")) {
    $<HTMLDialogElement>("#sim").showModal();
    void runSim();
  }
}

void main();

export { mmToScreen };
