#!/usr/bin/env python3
"""生成示例/模板电路（frontend/public/examples/*.design.json）。

手写 JSON 的坐标极容易差 2.5 mm，"引脚看起来在线上、网表却多出孤立节点"。
所以模板用脚本**算**出来：放元件 → 查 symbols.json 得到引脚世界坐标 → 正交连线。

用法：./tools/make-templates.py [--check]
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SYMBOLS = ROOT / "symbols/symbols.json"
OUTDIR = ROOT / "frontend/public/examples"


def load_symbols() -> dict:
    return json.loads(SYMBOLS.read_text(encoding="utf-8"))["symbols"]


SYMS = load_symbols()


def world(pin_at: dict, at: tuple[float, float], rot: int = 0, mirror: str = "none") -> tuple[float, float]:
    x, y = pin_at["x"], pin_at["y"]
    if mirror == "x":
        x = -x
    if mirror == "y":
        y = -y
    a = math.radians(rot)
    return (round(math.cos(a) * x - math.sin(a) * y + at[0], 3), round(math.sin(a) * x + math.cos(a) * y + at[1], 3))


class Doc:
    def __init__(self, name: str):
        self.name = name
        self.parts: list[dict] = []
        self.wires: list[dict] = []
        self.n = 0

    def part(self, ref: str, symbol: str, at: tuple[float, float], rot: int = 0, mirror: str = "none",
             value: str | None = None, model: str | None = None, alias: str | None = None) -> dict:
        self.n += 1
        p = {"id": f"p{self.n}", "ref": ref, "symbol": symbol, "at": {"x": at[0], "y": at[1]},
             "rot": rot, "mirror": mirror}
        if value is not None:
            p["value"] = value
        if model is not None:
            p["model"] = model
        if alias is not None:
            p["alias"] = alias
        self.parts.append(p)
        return p

    def pin(self, part: dict, pin_id: str) -> tuple[float, float]:
        sym = SYMS[part["symbol"]]
        spec = next(p["at"] for p in sym["pins"] if p["id"] == pin_id)
        return world(spec, (part["at"]["x"], part["at"]["y"]), part["rot"], part["mirror"])

    def all_pins(self) -> list[tuple[float, float]]:
        pts: list[tuple[float, float]] = []
        for part in self.parts:
            for pin in SYMS[part["symbol"]]["pins"]:
                pts.append(self.pin(part, pin["id"]))
        return pts

    @staticmethod
    def _seg_hits_point(a, b, p, skip: set) -> bool:
        """线段是否穿过点 p（不含端点）"""
        if p in skip:
            return False
        ax, ay = a
        bx, by = b
        px, py = p
        if abs(ay - by) < 1e-6 and abs(py - ay) < 1e-6:
            return min(ax, bx) + 1e-6 < px < max(ax, bx) - 1e-6
        if abs(ax - bx) < 1e-6 and abs(px - ax) < 1e-6:
            return min(ay, by) + 1e-6 < py < max(ay, by) - 1e-6
        return False

    def wire(self, a: tuple[float, float], b: tuple[float, float]) -> None:
        """正交连线：先水平后垂直。

        必须避开其它引脚 —— 后端把"引脚落在导线上"判为相连（真实原理图确实如此），
        所以模板的连线不能从无关引脚上穿过去，否则会凭空短路。
        """
        ax, ay = a
        bx, by = b
        if abs(ax - bx) < 1e-6 or abs(ay - by) < 1e-6:
            self._check(a, b)
            self._seg((ax, ay), (bx, by))
            return
        # 两条候选路线，选不穿过无关引脚的那条
        routes = [
            [((ax, ay), (bx, ay)), ((bx, ay), (bx, by))],  # 先横后竖
            [((ax, ay), (ax, by)), ((ax, by), (bx, by))],  # 先竖后横
        ]
        pins = self.all_pins()
        skip = {a, b}
        best = None
        for route in routes:
            hits = sum(1 for s0 in route for p in pins if self._seg_hits_point(s0[0], s0[1], p, skip))
            if best is None or hits < best[0]:
                best = (hits, route)
        assert best is not None
        if best[0] > 0:
            print(f"  ! 警告：{a}→{b} 的连线穿过了 {best[0]} 个无关引脚（会短路）", file=sys.stderr)
        for s0 in best[1]:
            self._seg(*s0)

    def _check(self, a, b) -> None:
        pins = self.all_pins()
        skip = {a, b}
        hits = [p for p in pins if self._seg_hits_point(a, b, p, skip)]
        if hits:
            print(f"  ! 警告：{a}→{b} 的直线穿过引脚 {hits}（会短路）", file=sys.stderr)

    def _seg(self, a, b) -> None:
        if abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) < 1e-6:
            return
        self.n += 1
        self.wires.append({"id": f"w{self.n}", "points": [{"x": a[0], "y": a[1]}, {"x": b[0], "y": b[1]}]})

    def to_json(self) -> dict:
        return {"version": 1, "name": self.name, "parts": self.parts, "wires": self.wires, "nextId": self.n + 1}


# ---------------------------------------------------------------- 模板 1：同相放大

def noninverting() -> Doc:
    """同相放大：OUT 经 R1 反馈到 IN−，IN− 经 R2 到地，增益 = 1 + R1/R2。"""
    d = Doc("同相放大（非反相）")
    op = d.part("U1", "opamp", (0, 0), model="OP07A")        # IN+(-15,-5) IN-(-15,5) OUT(15,0) V+(0,-12.5) V-(0,12.5)
    inp = d.part("IN1", "node-in", (-45, -5))                # 引脚在符号右侧 → world (-32.5,-5)
    out = d.part("OUT1", "node-out", (60, 0))                # 引脚 (47.5,0)
    rf = d.part("R1", "resistor", (-5, -25), value="100k")   # 引脚 (-17.5,-25)/(7.5,-25)
    rg = d.part("R2", "resistor", (-30, 17.5), rot=90, value="10k")  # 引脚 (-30,5)/(-30,30)
    vcc = d.part("VCC1", "vcc", (0, -45))                    # 引脚 (0,-32.5)
    vee = d.part("VEE1", "vee", (40, 40))                    # 引脚 (40,27.5)；不旋转，符号内文字才不会倒
    gnd = d.part("GND1", "earth", (-30, 42.5))               # 引脚 (-30,30)

    # 输入 → IN+
    d.wire(d.pin(inp, "IN"), d.pin(op, "IN+"))
    # 反馈：OUT → R1 → IN−
    d.wire(d.pin(op, "OUT"), d.pin(rf, "2"))
    d.wire(d.pin(rf, "1"), d.pin(op, "IN-"))
    # IN− → R2 → 地
    d.wire(d.pin(op, "IN-"), d.pin(rg, "1"))
    # （R2 的下端 (-30,30) 与地的引脚重合）
    # 输出
    d.wire(d.pin(op, "OUT"), d.pin(out, "OUT"))
    # 电源：V+ 向上到 VCC；V− 向下再向右到 VEE
    d.wire(d.pin(op, "V+"), d.pin(vcc, "VCC"))
    d.wire(d.pin(op, "V-"), (0, 27.5))
    d.wire((0, 27.5), d.pin(vee, "VEE"))
    return d


# ---------------------------------------------------------------- 模板 2：共射前级

def common_emitter() -> Doc:
    """固定偏置共射：IN —Cin— B，Rb 从 VCC 到 B，Rc 从 VCC 到 C，Re 从 E 到地，C 经 Cout 到 OUT。"""
    d = Doc("共射前级（NPN）")
    q = d.part("Q1", "npn", (0, 0), model="BC549C")          # B(-12.5,0) C(2.5,-12.5) E(2.5,12.5)
    rc = d.part("R1", "resistor", (2.5, -25), rot=90, value="10k")    # 引脚 (2.5,-37.5)/(2.5,-12.5)
    re = d.part("R2", "resistor", (2.5, 25), rot=90, value="1k")      # 引脚 (2.5,12.5)/(2.5,37.5)
    rb = d.part("R3", "resistor", (-12.5, -25), rot=90, value="470k") # 引脚 (-12.5,-37.5)/(-12.5,-12.5)
    cin = d.part("C1", "capacitor", (-37.5, 0), value="47n")          # 引脚 (-50,0)/(-25,0)
    cout = d.part("C2", "capacitor", (17.5, -12.5), value="1u")       # 引脚 (5,-12.5)/(30,-12.5)
    inp = d.part("IN1", "node-in", (-62.5, 0))  # 引脚在右侧 → world (-50,0) = Cin.1
    out = d.part("OUT1", "node-out", (42.5, -12.5))
    vcc = d.part("VCC1", "vcc", (2.5, -50))                  # 引脚 (2.5,-37.5)
    gnd = d.part("GND1", "earth", (2.5, 50))                 # 引脚 (2.5,37.5)

    d.wire(d.pin(inp, "IN"), d.pin(cin, "1"))
    d.wire(d.pin(cin, "2"), d.pin(q, "B"))
    d.wire(d.pin(q, "B"), d.pin(rb, "2"))
    d.wire(d.pin(rb, "1"), d.pin(vcc, "VCC"))
    # 集电极：Q1.C 与 Rc 底端重合；Rc 顶端与 VCC 重合 —— 不需要额外导线
    d.wire(d.pin(q, "C"), d.pin(cout, "1"))
    d.wire(d.pin(cout, "2"), d.pin(out, "OUT"))
    # 发射极：E 与 Re 底端重合；Re 顶端与地重合
    return d


# ---------------------------------------------------------------- 模板 3：二极管削波

def diode_clip() -> Doc:
    """非对称削波：R1 串联，两只二极管**反向并联到地**（D1=1N4148 硬削、D2=1N34A 软削）。"""
    d = Doc("二极管削波（非对称）")
    inp = d.part("IN1", "node-in", (-45, 0))           # 引脚在符号右侧 → world (-32.5,0) = R1.1
    out = d.part("OUT1", "node-out", (60, 0))         # 引脚 (47.5,0)
    rs = d.part("R1", "resistor", (-20, 0), value="10k")   # 引脚 (-32.5,0)/(-7.5,0)
    # rot 90 → A 在下、K 在上；rot 270 → K 在下、A 在上（正好反并联）
    d1 = d.part("D1", "diode", (20, 15), rot=90, model="1N4148")
    d2 = d.part("D2", "diode", (35, 15), rot=270, model="1N34A")
    gnd = d.part("GND1", "earth", (20, 40))           # 引脚 (20,27.5)

    d.wire(d.pin(inp, "IN"), d.pin(rs, "1"))
    d.wire(d.pin(rs, "2"), d.pin(out, "OUT"))
    d.wire((20, 0), d.pin(d1, "A"))          # 削波节点 → D1 阳极
    d.wire((35, 0), d.pin(d2, "K"))          # 削波节点 → D2 阴极
    d.wire(d.pin(d2, "A"), d.pin(gnd, "GND"))  # D2 阳极 → 地
    # D1 阴极 = (20,27.5) 与地的引脚重合（同一接地点）
    return d


TEMPLATES = {
    "noninverting": noninverting,
    "common-emitter": common_emitter,
    "diode-clip": diode_clip,
}


def main() -> int:
    OUTDIR.mkdir(parents=True, exist_ok=True)
    check = "--check" in sys.argv
    bad = 0
    for name, build in TEMPLATES.items():
        doc = build()
        text = json.dumps(doc.to_json(), ensure_ascii=False, indent=2) + "\n"
        path = OUTDIR / f"{name}.design.json"
        if check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                print(f"✗ {path.name} 已过期：跑 ./tools/make-templates.py", file=sys.stderr)
                bad += 1
            else:
                print(f"✓ {path.name}")
        else:
            path.write_text(text, encoding="utf-8")
            print(f"✓ {path.name}（{len(doc.parts)} 元件 / {len(doc.wires)} 导线）")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
