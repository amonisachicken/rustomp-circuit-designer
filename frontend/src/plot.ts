// 波形图（SVG）：多曲线、线性/对数横轴、自动缩放。
//
// 复用给「示波器」（OUT 元件）与「仿真结果」两处；纯函数，不持有状态。

export interface Trace {
  name: string;
  x: number[];
  y: number[];
}

export interface PlotOpts {
  xLabel?: string;
  yLabel?: string;
  /** AC 分析：横轴取 log10，纵轴用 dB */
  logX?: boolean;
  db?: boolean;
  colors?: string[];
}

const PAD = { l: 52, r: 12, t: 12, b: 26 };
const DEFAULT_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#a855f7", "#f59e0b"];

/** 把若干条曲线画进 svg（按客户区尺寸自适应） */
export function drawTraces(svg: SVGSVGElement, traces: Trace[], opts: PlotOpts = {}): void {
  const NS = "http://www.w3.org/2000/svg";
  const w = svg.clientWidth || 720;
  const h = svg.clientHeight || 260;
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const mk = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
    document.createElementNS(NS, tag);

  const tfx = (v: number): number => (opts.logX ? Math.log10(Math.max(v, 1e-9)) : v);
  const tfy = (v: number): number => (opts.db ? 20 * Math.log10(Math.max(Math.abs(v), 1e-12)) : v);

  const usable = traces.filter((t) => t.x.length && t.y.length);
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const t of usable) {
    for (let i = 0; i < t.x.length; i++) {
      const x = tfx(t.x[i]!);
      const y = tfy(t.y[i]!);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
  }
  if (!Number.isFinite(xMin)) {
    const t = mk("text");
    t.setAttribute("x", `${w / 2}`);
    t.setAttribute("y", `${h / 2}`);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("class", "plot-empty");
    t.textContent = "没有数据";
    svg.append(t);
    return;
  }
  if (xMax - xMin < 1e-12) { xMax += 1; xMin -= 1; }
  const ySpan = Math.max(yMax - yMin, 1e-6);
  yMin -= ySpan * 0.08;
  yMax += ySpan * 0.08;

  const px = (x: number) => PAD.l + ((x - xMin) / (xMax - xMin)) * (w - PAD.l - PAD.r);
  const py = (y: number) => PAD.t + (1 - (y - yMin) / (yMax - yMin)) * (h - PAD.t - PAD.b);

  const bg = mk("rect");
  bg.setAttribute("x", `${PAD.l}`); bg.setAttribute("y", `${PAD.t}`);
  bg.setAttribute("width", `${w - PAD.l - PAD.r}`); bg.setAttribute("height", `${h - PAD.t - PAD.b}`);
  bg.setAttribute("class", "plot-bg");
  svg.append(bg);

  const grid = mk("g");
  grid.setAttribute("class", "plot-grid");
  const fmtX = (v: number) => (opts.logX ? `${(10 ** v).toPrecision(3)}` : v.toPrecision(3));
  const fmtY = (v: number) => (opts.db ? `${v.toFixed(1)}` : v.toPrecision(3));
  for (let i = 0; i <= 5; i++) {
    const xx = PAD.l + ((w - PAD.l - PAD.r) * i) / 5;
    const l = mk("line");
    l.setAttribute("x1", `${xx}`); l.setAttribute("y1", `${PAD.t}`);
    l.setAttribute("x2", `${xx}`); l.setAttribute("y2", `${h - PAD.b}`);
    grid.append(l);
    const t = mk("text");
    t.setAttribute("x", `${xx}`); t.setAttribute("y", `${h - PAD.b + 14}`);
    t.setAttribute("text-anchor", "middle");
    t.textContent = fmtX(xMin + ((xMax - xMin) * i) / 5);
    grid.append(t);
  }
  for (let i = 0; i <= 4; i++) {
    const yy = PAD.t + ((h - PAD.t - PAD.b) * i) / 4;
    const l = mk("line");
    l.setAttribute("x1", `${PAD.l}`); l.setAttribute("y1", `${yy}`);
    l.setAttribute("x2", `${w - PAD.r}`); l.setAttribute("y2", `${yy}`);
    grid.append(l);
    const t = mk("text");
    t.setAttribute("x", `${PAD.l - 6}`); t.setAttribute("y", `${yy + 3}`);
    t.setAttribute("text-anchor", "end");
    t.textContent = fmtY(yMax - ((yMax - yMin) * i) / 4);
    grid.append(t);
  }
  svg.append(grid);

  // 轴标题
  const xl = mk("text");
  xl.setAttribute("x", `${w - PAD.r}`); xl.setAttribute("y", `${h - 4}`);
  xl.setAttribute("text-anchor", "end"); xl.setAttribute("class", "plot-axis");
  xl.textContent = opts.xLabel ?? "";
  svg.append(xl);
  const yl = mk("text");
  yl.setAttribute("x", `2`); yl.setAttribute("y", `${PAD.t + 10}`);
  yl.setAttribute("class", "plot-axis");
  yl.textContent = opts.yLabel ?? "";
  svg.append(yl);

  const colors = opts.colors ?? DEFAULT_COLORS;
  usable.forEach((t, i) => {
    const d = t.x
      .map((xv, k) => {
        const X = px(tfx(xv));
        const Y = py(tfy(t.y[k]!));
        return `${k === 0 ? "M" : "L"}${X.toFixed(2)} ${Y.toFixed(2)}`;
      })
      .join(" ");
    const p = mk("path");
    p.setAttribute("d", d);
    p.setAttribute("class", "trace");
    p.setAttribute("stroke", colors[i % colors.length]!);
    svg.append(p);
  });

  // 图例
  const legend = mk("g");
  legend.setAttribute("class", "plot-legend");
  usable.forEach((t, i) => {
    const x0 = PAD.l + 6 + i * 96;
    const l = mk("line");
    l.setAttribute("x1", `${x0}`); l.setAttribute("y1", `${PAD.t + 10}`);
    l.setAttribute("x2", `${x0 + 14}`); l.setAttribute("y2", `${PAD.t + 10}`);
    l.setAttribute("stroke", colors[i % colors.length]!);
    l.setAttribute("stroke-width", "1.8");
    legend.append(l);
    const tx = mk("text");
    tx.setAttribute("x", `${x0 + 18}`); tx.setAttribute("y", `${PAD.t + 13}`);
    tx.textContent = t.name;
    legend.append(tx);
  });
  svg.append(legend);
}
