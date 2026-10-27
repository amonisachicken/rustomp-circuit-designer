// 把符号素材与清单同步到 frontend/public/symbols/（构建产物要能直接静态访问）。
// 为什么复制而不是引用上级目录：Vite 只能服务 root 内的文件，跨目录要么 @fs（仅 dev）
// 要么插件，两边行为不一致。复制一次最简单、dev/build 完全一致。
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = join(root, "assets/gb4728-symbols-kit/symbols");
const manifest = join(root, "symbols/symbols.json");
const out = join(root, "frontend/public/symbols");

mkdirSync(out, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (!f.endsWith(".svg")) continue;
  cpSync(join(src, f), join(out, f));
  n++;
}

// 把清单里的 file 路径改写为"相对 public/symbols"（前端只需文件名）
const data = JSON.parse(readFileSync(manifest, "utf8"));
for (const [slug, sym] of Object.entries(data.symbols)) {
  sym.file = sym.file.split("/").pop();
}
writeFileSync(join(out, "symbols.json"), JSON.stringify(data, null, 2) + "\n");
console.log(`✓ 同步 ${n} 个符号 → frontend/public/symbols/`);
