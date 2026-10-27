// 波形图（SVG）：双通道、自动缩放、毫秒横轴。
//
// 纯函数式：给数据画一张图，不持有状态。样式走 class（style.css）。

export interface Series {
  t: number[]; // ms
  vin: number[];
  vout: number[];
  labelIn?: string;
  labelOut?: string;
}

const PAD = { l: 46, r: 10, t: 10, b: 24 };

/** 把波形画进一个 svg（按客户区尺寸自适应） */
export function drawWaveform(svg: SVGSVGElement, s: Series): void {
  const NS = "http://www.w3.org/2000/svg";
  const w = svg.clientWidth || 720;
  const h = svg.clientHeight || 240;
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const tMax = s.t.length ? s.t[s.t.length - 1]! : 1;
  const all = [...s.vin, ...s.vout];
  let vMax = all.length ? Math.max(...all) : 1;
  let vMin = all.length ? Math.min(...all) : 0;
  // 给上下留 10% 余量；全零时给个最小尺度
  const span = Math.max(vMax - vMin, 1e-3);
  vMax += span * 0.1;
  vMin -= span * 0.1;

  const x = (t: number) => PAD.l + (t / (tMax || 1)) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - vMin) / (vMax - vMin || 1)) * (h - PAD.t - PAD.b);

  const mk = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
    document.createElementNS(NS, tag);

  // 背景与边框
  const bg = mk("rect");
  bg.setAttribute("x", `${PAD.l}`);
  bg.setAttribute("y", `${PAD.t}`);
  bg.setAttribute("width", `${w - PAD.l - PAD.r}`);
  bg.setAttribute("height", `${h - PAD.t - PAD.b}`);
  bg.setAttribute("class", "plot-bg");
  svg.append(bg);

  // 网格与刻度（5×4）
  const g = mk("g");
  g.setAttribute("class", "plot-grid");
  for (let i = 0; i <= 5; i++) {
    const xx = PAD.l + ((w - PAD.l - PAD.r) * i) / 5;
    const line = mk("line");
    line.setAttribute("x1", `${xx}`);
    line.setAttribute("y1", `${PAD.t}`);
    line.setAttribute("x2", `${xx}`);
    line.setAttribute("y2", `${h - PAD.b}`);
    g.append(line);

    const label = mk("text");
    label.setAttribute("x", `${xx}`);
    label.setAttribute("y", `${h - PAD.b + 14}`);
    label.setAttribute("text-anchor", "middle");
    label.textContent = `${((tMax * i) / 5).toFixed(2)}`;
    g.append(label);
  }
  for (let i = 0; i <= 4; i++) {
    const yy = PAD.t + ((h - PAD.t - PAD.b) * i) / 4;
    const line = mk("line");
    line.setAttribute("x1", `${PAD.l}`);
    line.setAttribute("y1", `${yy}`);
    line.setAttribute("x2", `${w - PAD.r}`);
    line.setAttribute("y2", `${yy}`);
    g.append(line);

    const label = mk("text");
    label.setAttribute("x", `${PAD.l - 6}`);
    label.setAttribute("y", `${yy + 3}`);
    label.setAttribute("text-anchor", "end");
    label.textContent = `${(vMax - ((vMax - vMin) * i) / 4).toFixed(3)}`;
    g.append(label);
  }
  svg.append(g);

  // 零线（有负半周时更直观）
  if (vMin < 0 && vMax > 0) {
    const zero = mk("line");
    zero.setAttribute("x1", `${PAD.l}`);
    zero.setAttribute("y1", `${y(0)}`);
    zero.setAttribute("x2", `${w - PAD.r}`);
    zero.setAttribute("y2", `${y(0)}`);
    zero.setAttribute("class", "plot-zero");
    svg.append(zero);
  }

  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(s.t[i] ?? 0).toFixed(2)} ${y(v).toFixed(2)}`).join(" ");

  if (s.vin.length) {
    const p = mk("path");
    p.setAttribute("d", path(s.vin));
    p.setAttribute("class", "trace-in");
    svg.append(p);
  }
  if (s.vout.length) {
    const p = mk("path");
    p.setAttribute("d", path(s.vout));
    p.setAttribute("class", "trace-out");
    svg.append(p);
  }

  // 图例
  const legend = mk("g");
  legend.setAttribute("class", "plot-legend");
  const item = (dx: number, cls: string, text: string) => {
    const l = mk("line");
    l.setAttribute("x1", `${PAD.l + dx}`);
    l.setAttribute("y1", `${PAD.t + 12}`);
    l.setAttribute("x2", `${PAD.l + dx + 16}`);
    l.setAttribute("y2", `${PAD.t + 12}`);
    l.setAttribute("class", cls);
    legend.append(l);
    const t = mk("text");
    t.setAttribute("x", `${PAD.l + dx + 20}`);
    t.setAttribute("y", `${PAD.t + 15}`);
    t.textContent = text;
    legend.append(t);
  };
  item(6, "trace-in", s.labelIn ?? "in");
  item(86, "trace-out", s.labelOut ?? "out");
  svg.append(legend);
}
