// 入口：装配画布、键盘/鼠标、元件库、属性面板、撤销重做、预览截图。
// 交互规则见 docs/03 §3（D-009：模态编辑，无拖放）。

import { backend, type AnalysisKind, type NetlistResult, type SimParams, type SimResult } from "./backend";
import { drawTraces } from "./plot";
import {
  VALUE_UNITS,
  UNIT_LABEL,
  emptyDoc,
  joinValue,
  normalizeWires,
  snap,
  splitValue,
  trimWireBetweenPins,
  wireJunctions,
  type Doc,
  type Part,
} from "./model";
import { loadAllArt, loadArt, loadSymbols, type SymText, type SymbolTable } from "./symbols";
import { fitView, hitTest, mmToScreen, render, screenToMm, type View } from "./render";
import {
  cancel,
  commitPlace,
  commitWire,
  copyAttrs,
  cursorFor,
  deleteAt,
  dropAt,
  enterPlace,
  modeLabel,
  orthoPoint,
  pickUp,
  toggleMirror,
  toggleRotate,
  trimWiresUnderParts,
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

  // 查看模式下按住左键拖动 → 平移视野（任意位置都能拖）
  if (viewDrag) {
    const dx = ev.clientX - viewDrag.last.x;
    const dy = ev.clientY - viewDrag.last.y;
    if (dx || dy) {
      if (Math.abs(dx) + Math.abs(dy) > 2) viewDrag.moved = true;
      view = { ...view, pan: { x: view.pan.x + dx, y: view.pan.y + dy } };
      viewDrag.last = { x: ev.clientX, y: ev.clientY };
      repaint();
      return;
    }
  }

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
    const part = doc.parts.find((p) => p.id === partId);
    // OUT 元件兼作示波器、测试点兼作电压表（双击即打开对应"仪表"）
    if (part?.symbol === "node-out" || part?.symbol === "test-point") {
      void openInstrument(part);
    } else {
      selectPart(partId, true);
    }
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
        // 语法糖：导线从头尾跨过两脚元件时，剪掉两脚之间那段（D-021）
        const trimmed = trimWiresUnderParts(doc, table);
        // 合并重合部分 + 接续直导线（docs/03 §7.5）
        const before = doc.wires.length;
        doc.wires = normalizeWires(doc.wires);
        if (trimmed || doc.wires.length !== before) repaint();
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
      // 复制连数值/型号/别名/仪表参数一起带走（D-022）
      enterPlace(src.symbol, table, hooks, at, copyAttrs(src));
      const m = mode as unknown as Extract<Mode, { kind: "place" }>;
      hooks.setMode({ ...m, rot: src.rot, mirror: src.mirror });
      const carried = [src.value, src.model].filter(Boolean).join(" / ");
      hooks.status(`复制 ${src.ref}${carried ? `（${carried}）` : ""}：点击落点（ctrl+r 旋转，esc 退出）`);
      return;
    }
    case "move": {
      if (!mode.partId) return;
      dropAt(mode, at, hooks);
      hooks.setMode({ kind: "view" });
      return;
    }
    default: {
      // 查看模式：先只记下起点。**拖动就平移**，没拖动才当点击选中（pointerup 里判定）
      viewDrag = { last: { x: ev.clientX, y: ev.clientY }, moved: false, pid: partId, wid: wireId };
    }
  }
});

let hoverKey = "";

/** 查看模式下按住左键：拖动 = 平移视野；没拖动 = 选中（在 pointerup 决定） */
let viewDrag: { last: { x: number; y: number }; moved: boolean; pid: string | null; wid: string | null } | null = null;

/** 双击检测状态（见 pointerdown 里的注释） */
let lastClick: { id: string | null; t: number } = { id: null, t: 0 };

// ---------------------------------------------------------------- 平移 / 缩放

let panning: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 1) return;
  panning = { x: ev.clientX, y: ev.clientY };
  ev.preventDefault();
});
window.addEventListener("pointerup", (ev) => {
  panning = null;
  if (viewDrag) {
    const d = viewDrag;
    viewDrag = null;
    if (!d.moved) {
      // 单击：选中元素（或点空白处取消选择）
      selectedId = d.pid ?? d.wid ?? null;
      if (d.pid) selectPart(d.pid, false);
      else $("#props").hidden = true;
      repaint();
    }
    void ev;
  }
});
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
    ${
      p.symbol === "node-in"
        ? `<div class="row"><label>幅值</label><input id="p-amp" type="number" step="0.05" value="${p.amp ?? 0.2}"> V</div>
           <div class="row"><label>频率</label><input id="p-freq" type="number" step="100" value="${p.freq ?? 1000}"> Hz</div>
           <p class="muted" style="font-size:11px">IN 元件兼作波形发生器（只用于仿真）</p>`
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
  const ampEl = panel.querySelector<HTMLInputElement>("#p-amp");
  const freqEl = panel.querySelector<HTMLInputElement>("#p-freq");
  const applySignal = (): void => {
    hooks.commit();
    if (ampEl) p.amp = Number(ampEl.value);
    if (freqEl) p.freq = Number(freqEl.value);
    repaint();
  };
  ampEl?.addEventListener("change", applySignal);
  freqEl?.addEventListener("change", applySignal);
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

// ---------------------------------------------------------------- 命名 / 保存 / 导入导出

const nameInput = $<HTMLInputElement>("#docName");
nameInput.addEventListener("input", () => {
  doc.name = nameInput.value.trim() || "未命名电路";
});

/** 保存：写服务端缓存 + **清空撤销/重做**（同 breadspice 的"保存布局"） */
$("#btnSave").addEventListener("click", async () => {
  try {
    const r = await backend.save(doc.name, doc);
    past.length = 0;
    future.length = 0;
    $("#hint").textContent = `已保存到服务端：${r.file}（${(r.bytes / 1024).toFixed(1)} KB，撤销记录已清空）`;
  } catch (e) {
    $("#hint").textContent = `保存失败：${e instanceof Error ? e.message : String(e)}`;
  }
});

/** 导出布局：下载 .design.json */
$("#btnExport").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${doc.name}.design.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  $("#hint").textContent = `已导出 ${doc.name}.design.json`;
});

/** 导入布局：读本地文件 → 替换文档 → 清空历史（名字取自文件名） */
$("#btnImport").addEventListener("click", () => $<HTMLInputElement>("#importFile").click());
$<HTMLInputElement>("#importFile").addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const loaded = JSON.parse(await file.text()) as Doc;
    if (!Array.isArray(loaded.parts) || !Array.isArray(loaded.wires)) {
      throw new Error("不是有效的设计文件（缺少 parts / wires）");
    }
    Object.assign(doc, loaded);
    doc.wires = normalizeWires(doc.wires);
    // 老图纸可能在两脚元件下面留着导线（= 短路 R/C/D）；导入时按 D-021 清掉
    trimWiresUnderParts(doc, table);
    doc.wires = normalizeWires(doc.wires);
    doc.name = loaded.name || file.name.replace(/\.design\.json$|\.json$/i, "") || "未命名电路";
    doc.nextId = Math.max(doc.nextId ?? 1, doc.parts.length + doc.wires.length + 1);
    past.length = 0;
    future.length = 0;
    nameInput.value = doc.name;
    selectedId = null;
    $("#props").hidden = true;
    view = fitView(doc, table, { w: canvas.clientWidth || 1200, h: canvas.clientHeight || 800 });
    hooks.setMode({ kind: "view" });
    repaint();
    $("#hint").textContent = `已导入 ${file.name}（${doc.parts.length} 元件 / ${doc.wires.length} 导线）`;
  } catch (e) {
    $("#hint").textContent = `导入失败：${e instanceof Error ? e.message : String(e)}`;
  }
});

$("#btnUndo").addEventListener("click", undo);
$("#btnRedo").addEventListener("click", redo);
$("#btnNew").addEventListener("click", () => {
  hooks.commit();
  Object.assign(doc, emptyDoc());
  nameInput.value = doc.name;
  repaint();
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

// ---------------------------------------------------------------- 仿真（复用 breadspice 的核心）

/** 上一次仿真结果（示波器 / 电压表都读它） */
let lastSim: SimResult | null = null;

/** 双击 OUT / 测试点：网络表可能还没拉到，先补一次再开仪表 */
async function openInstrument(part: Part): Promise<void> {
  if (!netlist) await refreshNetlist();
  const net = netOfPin(part.ref, part.symbol === "node-out" ? "OUT" : "TP");
  if (!net) {
    $("#hint").textContent = `${part.ref} 还没接到电路上（找不到它的网络）`;
    return;
  }
  // 测试点与 OUT 都是"当前节点示波器"，只是标题不同
  openScope(net, part.symbol === "test-point" ? part.ref : undefined);
}

/** 某个元件的某个引脚落在哪个网络上（用后端返回的 nets 反查） */
function netOfPin(ref: string, pin: string): string | null {
  const hit = netlist?.nets.find((n) => n.pins.includes(`${ref}.${pin}`));
  return hit?.name ?? null;
}

/** 自动探针：所有测试点（电压表用）；端口由后端自己加 */
function testPointNets(): string[] {
  const out: string[] = [];
  for (const p of doc.parts) {
    if (p.symbol !== "test-point") continue;
    const n = netOfPin(p.ref, "TP");
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function readSimParams(): { analysis: AnalysisKind; params: SimParams } {
  const analysis = $<HTMLSelectElement>("#simAnalysis").value as AnalysisKind;
  const num = (id: string, dflt: number): number => Number($<HTMLInputElement>(id).value) || dflt;
  if (analysis === "ac") {
    return {
      analysis,
      params: {
        // AC 的激励幅度也取自 IN（默认 1 V RMS）
        amp: doc.parts.find((p) => p.symbol === "node-in")?.amp ?? 1,
        sweep: ($<HTMLSelectElement>("#simAcSweep").value as "dec" | "oct" | "lin") ?? "dec",
        points: num("#simAcPoints", 100),
        f_start: num("#simAcStart", 10),
        f_stop: num("#simAcStop", 100000),
      },
    };
  }
  // 激励参数来自 IN 元件（兼作波形发生器），弹窗只管"怎么跑"
  const src = doc.parts.find((p) => p.symbol === "node-in");
  return {
    analysis: "tran",
    params: {
      amp: src?.amp ?? 0.2,
      freq: src?.freq ?? 1000,
      step: num("#simStep", 1e-5),
      start: num("#simStart", 0),
      duration: num("#simDuration", 0.02),
    },
  };
}

$("#btnSim").addEventListener("click", () => {
  const dlg = $<HTMLDialogElement>("#sim");
  $("#simStatus").textContent = "";
  $("#simLog").textContent = "";
  syncSimFields();
  dlg.showModal();
  void runSim();
});
$("#simRun").addEventListener("click", () => void runSim());
$("#simStop").addEventListener("click", () => void backend.stop());
$("#simClose").addEventListener("click", () => $<HTMLDialogElement>("#sim").close());
/** 按分析类型显示对应的参数组 */
function syncSimFields(): void {
  const a = $<HTMLSelectElement>("#simAnalysis").value;
  $<HTMLElement>("#simTranFields").hidden = a !== "tran";
  $<HTMLElement>("#simAcFields").hidden = a !== "ac";
}
$("#simAnalysis").addEventListener("change", syncSimFields);
syncSimFields();

async function runSim(): Promise<void> {
  const status = $("#simStatus");
  const { analysis, params } = readSimParams();
  status.textContent = "运行中…（可点停止）";
  try {
    const r = await backend.simulate(doc, analysis, params, testPointNets());
    lastSim = r;
    drawTraces($<SVGSVGElement>("#simPlot"), r.traces, {
      logX: analysis === "ac",
      db: analysis === "ac",
      xLabel: analysis === "ac" ? "频率 Hz" : "时间 s",
      yLabel: analysis === "ac" ? "幅度 dB" : "电压 V",
    });
    const ports = netlist?.ports ?? { in: null, out: null };
    $("#simSemantics").textContent =
      analysis === "ac"
        ? `AC 扫描：激励 v(${ports.in ?? "?"}) = 1 V RMS（IN 元件兼作波形发生器）· 探针 ${r.traces.map((t) => t.name).join(" / ")}`
        : `瞬态：激励 SIN(${params.amp} V, ${params.freq} Hz) @ v(${ports.in ?? "?"}) · 探针 ${r.traces.map((t) => t.name).join(" / ")}`;
    const thd = r.thd === null ? "—" : `${(r.thd * 100).toFixed(2)}%`;
    status.textContent =
      analysis === "tran"
        ? `${r.traces[0]?.x.length ?? 0} 点 · ${(params.duration ?? 0) * 1000} ms · THD = ${thd}`
        : `${r.traces[0]?.x.length ?? 0} 点 · ${params.f_start}–${params.f_stop} Hz`;
    $("#simLog").textContent = r.log || "（无输出）";
  } catch (e) {
    status.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
    $("#simLog").textContent = String(e);
  }
}

// ---------------------------------------------------------------- 示波器（OUT 元件）/ 电压表（测试点）

/** 双击 OUT 元件 → 示波器：看该网络（+ 输入做对照）的波形 */
function openScope(net: string, label?: string): void {
  const dlg = $<HTMLDialogElement>("#scope");
  $("#scopeTitle").textContent = `${label ?? "OUT"} · 示波器（v(${net})）`;
  if (!lastSim) {
    $("#scopeStatus").textContent = "还没有仿真结果 —— 先点顶栏「仿真」";
    drawTraces($<SVGSVGElement>("#scopePlot"), []);
  } else {
    const want = new Set([`v(${net.toLowerCase()})`]);
    const vin = netlist?.ports.in ? `v(${netlist.ports.in.toLowerCase()})` : null;
    if (vin) want.add(vin);
    const traces = lastSim.traces.filter((t) => want.has(t.name));
    drawTraces($<SVGSVGElement>("#scopePlot"), traces, {
      logX: lastSim.analysis === "ac",
      db: lastSim.analysis === "ac",
      xLabel: lastSim.analysis === "ac" ? "频率 Hz" : "时间 s",
      yLabel: lastSim.analysis === "ac" ? "幅度 dB" : "电压 V",
    });
    const kind = lastSim.analysis === "ac" ? "交流分析" : "瞬态分析";
    $("#scopeStatus").textContent = `${label ? `${label} · ` : ""}v(${net}) · ${kind}`;
  }
  $<HTMLButtonElement>("#scopeFft").dataset["net"] = net;
  dlg.showModal();
}

$("#scopeClose").addEventListener("click", () => $<HTMLDialogElement>("#scope").close());

$("#scopeFft").addEventListener("click", () => void runFft());

async function runFft(): Promise<void> {
  const net = $<HTMLButtonElement>("#scopeFft").dataset["net"] ?? "";
  if (!lastSim) return;
  const t = lastSim.traces.find((tr) => tr.name === `v(${net.toLowerCase()})`);
  if (!t) return;
  try {
    const { f, db } = await backend.fft(t.x, t.y, 20000);
    drawTraces($<SVGSVGElement>("#scopePlot"), [{ name: `FFT v(${net})`, x: f, y: db.map((d) => 10 ** (d / 20)) }], {
      logX: true,
      db: true,
      xLabel: "频率 Hz",
      yLabel: "幅度 dB",
    });
    $("#scopeStatus").textContent = `频谱：v(${net})（对数频率轴，1 V RMS = 0 dB）`;
  } catch (e) {
    $("#scopeStatus").textContent = `FFT 失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

$("#helpClose").addEventListener("click", () => $<HTMLDialogElement>("#help").close());
// 顶栏「?」：与按 h 同一个入口
$("#btnHelp").addEventListener("click", () => $<HTMLDialogElement>("#help").showModal());

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

/** 启动时读回上次保存的设计（服务端缓存）；成功返回 true */
async function restoreLast(): Promise<boolean> {
  try {
    const last = await backend.last();
    if (!last) return false;
    const loaded = last.doc as Doc;
    if (!Array.isArray(loaded.parts) || !Array.isArray(loaded.wires)) return false;
    Object.assign(doc, loaded);
    doc.wires = normalizeWires(doc.wires);
    // 老图纸可能在两脚元件下面留着导线（= 短路 R/C/D）；载入时按 D-021 清掉
    trimWiresUnderParts(doc, table);
    doc.wires = normalizeWires(doc.wires);
    doc.name = last.name || "未命名电路";
    doc.nextId = Math.max(doc.nextId ?? 1, doc.parts.length + doc.wires.length + 1);
    hooks.status(`已恢复上次保存的布局：${last.file}`);
    return true;
  } catch {
    return false; // 后端没起 / 读不到 → 安静地当作首次启动
  }
}

/** `?load=<name>` 载入 frontend/public/examples/<name>.design.json（示例电路） */
async function loadExample(name: string): Promise<boolean> {
  try {
    // no-store：示例会被改（模板重生成），别让浏览器缓存住旧版本
    const res = await fetch(`examples/${name}.design.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    Object.assign(doc, JSON.parse(text) as Doc);
    doc.wires = normalizeWires(doc.wires);
    trimWiresUnderParts(doc, table);
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
  // 启动时自动恢复"上次保存"的布局（同 breadspice 的 initProject）
  const restored = example || q.has("fresh") ? false : await restoreLast();
  if (example) {
    await loadExample(example);
  } else if (!restored) {
    // 首屏演示：一个电阻 + 一个电容
    enterPlace("resistor", table, hooks, { x: 20, y: 20 });
    commitPlace(mode as Extract<Mode, { kind: "place" }>, hooks);
    enterPlace("capacitor", table, hooks, { x: 20, y: 40 });
    commitPlace(mode as Extract<Mode, { kind: "place" }>, hooks);
  }
  hooks.setMode({ kind: "view" });
  nameInput.value = doc.name;
  syncSimFields();
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

    // ⑬ 顶栏「?」按钮
    $<HTMLDialogElement>("#help").close();
    $<HTMLButtonElement>("#btnHelp").click();
    results.push(`btn-help=${$<HTMLDialogElement>("#help").open}`);
    $<HTMLDialogElement>("#help").close();

    // ⑭ IN 节点是 OUT 的水平镜像（引脚在右侧 → 从库里拿出来方向就对）
    const pinIn = table.symbols["node-in"]!.pins[0]!.at;
    const pinOut = table.symbols["node-out"]!.pins[0]!.at;
    results.push(`in-mirrored=${pinIn.x > 0 && pinOut.x < 0}`);

    // ⑮ 命名框同步 + 保存（服务端缓存）后清空撤销/重做
    const nameEl = $<HTMLInputElement>("#docName");
    results.push(`docname-sync=${nameEl.value === doc.name}`);
    results.push(
      `toolbar-buttons=${!!$("#btnImport") && !!$("#btnExport") && !!$("#btnSave") && !!$("#docName")}`,
    );
    // 制造一步历史，然后模拟保存成功后的清空
    hooks.commit();
    const hadHistory = past.length > 0;
    past.length = 0;
    future.length = 0;
    results.push(`save-clears-history=${hadHistory && past.length === 0 && future.length === 0}`);

    // ⑯ 仿真 → 示波器（OUT）/ 电压表（测试点）链路
    let simOk: string | boolean = false;
    try {
      await refreshNetlist();
      const r = await backend.simulate(
        doc,
        "tran",
        { amp: 0.2, freq: 1000, step: 1e-5, start: 0, duration: 0.02 },
        testPointNets(),
      );
      lastSim = r;
      const hasOut = r.traces.some((t) => t.name === "v(out)");
      const scopePart = doc.parts.find((p) => p.symbol === "node-out");
      const scopeNet = scopePart ? netOfPin(scopePart.ref, "OUT") : null;
      if (scopeNet) openScope(scopeNet);
      const scopeTraces = document.querySelectorAll("#scopePlot path.trace").length;
      $<HTMLDialogElement>("#scope").close();
      // 测试点也应开成示波器（同一套仪表）
      const tp = doc.parts.find((p) => p.symbol === "test-point");
      const tpNet = tp ? netOfPin(tp.ref, "TP") : null;
      let tpTraces = 0;
      if (tp && tpNet) {
        openScope(tpNet, tp.ref);
        tpTraces = document.querySelectorAll("#scopePlot path.trace").length;
        $<HTMLDialogElement>("#scope").close();
      }
      simOk =
        hasOut && scopeTraces >= 1 && tpTraces >= 1
          ? true
          : `out=${hasOut} outTraces=${scopeTraces} tpTraces=${tpTraces} tp=${tp?.ref},${tpNet}`;
    } catch (e) {
      simOk = e instanceof Error ? e.message : String(e);
    }
    results.push(`sim-scope=${simOk}`);

    // ⑰ 查看模式下拖动 = 平移视野（且不改变选中）
    const panBefore = { ...view.pan };
    const rect = canvas.getBoundingClientRect();
    const at = (dx: number, dy: number) => ({
      clientX: rect.left + 40 + dx,
      clientY: rect.top + 40 + dy,
      bubbles: true,
      button: 0,
      pointerId: 1,
    });
    canvas.dispatchEvent(new PointerEvent("pointerdown", at(0, 0)));
    canvas.dispatchEvent(new PointerEvent("pointermove", at(30, 20)));
    window.dispatchEvent(new PointerEvent("pointerup", at(30, 20)));
    const panMoved = view.pan.x === panBefore.x + 30 && view.pan.y === panBefore.y + 20;
    // 单击（不拖）仍能选中元件
    const r1 = doc.parts.find((p) => p.symbol === "resistor");
    const r1Pos = mmToScreen(r1!.at, view);
    const clickAt = { clientX: rect.left + r1Pos.x, clientY: rect.top + r1Pos.y, bubbles: true, button: 0 };
    canvas.dispatchEvent(new PointerEvent("pointerdown", clickAt));
    window.dispatchEvent(new PointerEvent("pointerup", clickAt));
    const clickSelects = selectedId === r1!.id;
    results.push(`view-drag-pan=${panMoved && clickSelects}`);

    // ⑱ 导线连接点黑点（D-021）：T 型/分支有，交叉与拐角无
    const tJ = wireJunctions([
      { id: "ja", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
      { id: "jb", points: [{ x: 10, y: 0 }, { x: 10, y: 20 }] },
    ]);
    results.push(`junction-t=${tJ.length === 1 && tJ[0]!.x === 10 && tJ[0]!.y === 0}`);
    const xJ = wireJunctions([
      { id: "jc", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
      { id: "jd", points: [{ x: 10, y: -10 }, { x: 10, y: 10 }] },
    ]);
    results.push(`junction-cross=${xJ.length === 0}`);
    const lJ = wireJunctions([
      { id: "je", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
      { id: "jf", points: [{ x: 20, y: 0 }, { x: 20, y: 20 }] },
    ]);
    results.push(`junction-corner=${lJ.length === 0}`);

    // ⑲ 语法糖：两脚落在同一直导线上 → 剪掉两脚之间那段（D-021）
    const tdoc = emptyDoc("trim");
    tdoc.wires = [{ id: "wt", points: [{ x: 0, y: 0 }, { x: 30, y: 0 }] }];
    tdoc.parts.push({
      id: "pt",
      ref: "R99",
      symbol: "resistor",
      at: { x: 15, y: 0 },
      rot: 0,
      mirror: "none",
      value: "10k",
    });
    // 电阻引脚 = at ± 12.5 mm → 2.5 / 27.5；导线 0…30 → 留下 0…2.5 与 27.5…30
    const trimChanged = trimWiresUnderParts(tdoc, table);
    const spans = tdoc.wires
      .map((w) => `${Math.min(w.points[0].x, w.points[1].x)}..${Math.max(w.points[0].x, w.points[1].x)}`)
      .sort()
      .join(",");
    results.push(`trim-keep-ends=${trimChanged && tdoc.wires.length === 2 && spans === "0..2.5,27.5..30"}`);
    // 导线正好从一脚跨到另一脚 → 整根删掉（这里是纯函数，不依赖符号表）
    const exact = emptyDoc("trim-exact");
    exact.wires = [{ id: "wex", points: [{ x: 2.5, y: 0 }, { x: 27.5, y: 0 }] }];
    const exactChanged = trimWireBetweenPins(exact, { x: 2.5, y: 0 }, { x: 27.5, y: 0 });
    results.push(`trim-exact=${exactChanged && exact.wires.length === 0}`);

    // ㉑ 多脚器件的共线引脚同样适用（D-021 扩展）
    const potDoc = emptyDoc("trim-pot");
    potDoc.wires = [{ id: "wp", points: [{ x: -20, y: 0 }, { x: 20, y: 0 }] }];
    potDoc.parts.push({
      id: "pp",
      ref: "P1",
      symbol: "potentiometer",
      at: { x: 0, y: 0 },
      rot: 0,
      mirror: "none",
      value: "500k",
    });
    const potSpans = trimWiresUnderParts(potDoc, table)
      ? potDoc.wires
          .map((w) => `${Math.min(w.points[0].x, w.points[1].x)}..${Math.max(w.points[0].x, w.points[1].x)}`)
          .sort()
          .join(",")
      : "";
    results.push(`trim-multi-pot=${potSpans === "-20..-12.5,12.5..20"}`);

    // npn 的 C/E 共线（x=2.5，y=∓12.5）→ 竖向导线要剪
    const bjtDoc = emptyDoc("trim-bjt");
    bjtDoc.wires = [{ id: "wq", points: [{ x: 2.5, y: -30 }, { x: 2.5, y: 30 }] }];
    bjtDoc.parts.push({
      id: "qb",
      ref: "Q1",
      symbol: "npn",
      at: { x: 0, y: 0 },
      rot: 0,
      mirror: "none",
      model: "BC549C",
    });
    results.push(`trim-multi-bjt=${trimWiresUnderParts(bjtDoc, table) && bjtDoc.wires.length === 2}`);

    // 运放的 IN+/IN− 共线（x=-15，y=∓5）
    const opDoc = emptyDoc("trim-opamp");
    opDoc.wires = [{ id: "wu", points: [{ x: -15, y: -20 }, { x: -15, y: 20 }] }];
    opDoc.parts.push({
      id: "uo",
      ref: "U1",
      symbol: "opamp",
      at: { x: 0, y: 0 },
      rot: 0,
      mirror: "none",
      model: "OP07A",
    });
    results.push(`trim-multi-opamp=${trimWiresUnderParts(opDoc, table) && opDoc.wires.length === 2}`);

    // ㉒ T 型接点继续画成十字：归一化不得吃掉交点（D-023）
    const crossDoc = emptyDoc("cross-continue");
    crossDoc.wires = [
      { id: "xh", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
      { id: "xv1", points: [{ x: 10, y: 0 }, { x: 10, y: -10 }] },
      { id: "xv2", points: [{ x: 10, y: 0 }, { x: 10, y: 10 }] },
    ];
    crossDoc.wires = normalizeWires(crossDoc.wires);
    const crossJ = wireJunctions(crossDoc.wires);
    results.push(
      `junction-cross-continued=${crossDoc.wires.length === 3 && crossJ.length === 1 && crossJ[0]!.x === 10 && crossJ[0]!.y === 0}`,
    );

    // ⑳ d 复制：数值与型号一起带走（D-022）
    // 先等 450 ms，避开双击检测窗口（⑰ 刚点过同一个电阻，否则会被当成双击开属性）
    await new Promise((r) => setTimeout(r, 450));
    const rect2 = canvas.getBoundingClientRect();
    const evAt = (p: { x: number; y: number }) => {
      const s = mmToScreen(p, view);
      return { clientX: rect2.left + s.x, clientY: rect2.top + s.y, bubbles: true, button: 0, pointerId: 1 };
    };
    const copyByD = (src: Part, to: { x: number; y: number }): Part => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
      canvas.dispatchEvent(new PointerEvent("pointerdown", evAt(src.at)));
      canvas.dispatchEvent(new PointerEvent("pointerup", evAt(src.at)));
      canvas.dispatchEvent(new PointerEvent("pointermove", evAt(to)));
      canvas.dispatchEvent(new PointerEvent("pointerdown", evAt(to)));
      hooks.setMode({ kind: "view" });
      return doc.parts[doc.parts.length - 1]!;
    };
    const rSrc = doc.parts.find((p) => p.symbol === "resistor")!;
    rSrc.value = "4.7k";
    const rCopy = copyByD(rSrc, { x: -40, y: 240 });
    results.push(`copy-value=${rCopy.ref !== rSrc.ref && rCopy.symbol === "resistor" && rCopy.value === "4.7k"}`);

    enterPlace("diode", table, hooks, { x: 20, y: 240 });
    commitPlace(mode as unknown as Extract<Mode, { kind: "place" }>, hooks);
    hooks.setMode({ kind: "view" });
    const dSrc = doc.parts[doc.parts.length - 1]!;
    dSrc.model = "1N34A";
    const dCopy = copyByD(dSrc, { x: 45, y: 240 });
    results.push(`copy-model=${dCopy.ref !== dSrc.ref && dCopy.symbol === "diode" && dCopy.model === "1N34A"}`);

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
