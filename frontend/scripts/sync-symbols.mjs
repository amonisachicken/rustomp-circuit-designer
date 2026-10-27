// 把符号素材与清单同步到 frontend/public/symbols/（构建产物要能直接静态访问）。
// 为什么复制而不是引用上级目录：Vite 只能服务 root 内的文件，跨目录要么 @fs（仅 dev）
// 要么插件，两边行为不一致。复制一次最简单、dev/build 完全一致。
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = join(root, "symbols/symbols.json");
const out = join(root, "frontend/public/symbols");

mkdirSync(out, { recursive: true });
// 清掉上一轮的副本（删掉的符号不能留在 public 里）
for (const f of readdirSync(out)) {
  if (f.endsWith(".svg")) rmSync(join(out, f));
}
const data = JSON.parse(readFileSync(manifest, "utf8"));

// 按清单里登记的来源复制（主 kit + assets/gb4728-ext），再把路径改写成文件名
let n = 0;
for (const sym of Object.values(data.symbols)) {
  const src = join(root, sym.file);
  const base = sym.file.split("/").pop();
  cpSync(src, join(out, base));
  sym.file = base;
  n++;
}
writeFileSync(join(out, "symbols.json"), JSON.stringify(data, null, 2) + "\n");
console.log(`✓ 同步 ${n} 个符号 → frontend/public/symbols/`);
