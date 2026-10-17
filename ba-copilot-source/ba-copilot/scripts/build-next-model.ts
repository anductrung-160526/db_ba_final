// "Huấn luyện" mô hình gợi ý thành phần = đếm tần suất từ các file JSONL ({source, tree}).
// Dùng: npm run build-model -- --in data/corpus/internal.jsonl,data/corpus/websight.jsonl
//         [--out model/next-component.json] [--weights websight=1,internal=3]
//         [--holdout 0.1 --seed 42 --holdout-out data/corpus/holdout.jsonl] [--limit 30000]
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeTree, validateTree, UINode } from "../shared/design.ts";
import { countTree, emptyModel } from "../shared/nextComponent.ts";

const root = join(import.meta.dirname, "..");
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};

export function readCorpus(files: string[]): { source: string; tree: UINode }[] {
  const out: { source: string; tree: UINode }[] = [];
  for (const f of files)
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        out.push({ source: String(row.source ?? "unknown"), tree: row.tree });
      } catch {
        /* bỏ dòng hỏng */
      }
    }
  return out;
}

/** Bộ sinh số giả ngẫu nhiên có seed (mulberry32) để tách holdout lặp lại được. */
export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chuẩn hóa + kiểm tra; trả cây hợp lệ hoặc null. */
export function cleanTree(raw: unknown): UINode | null {
  try {
    const t = normalizeTree(raw);
    return validateTree(t).ok ? t : null;
  } catch {
    return null;
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith("build-next-model.ts")) {
  const files = arg("--in", join(root, "data", "corpus", "internal.jsonl")).split(",").filter(Boolean);
  const out = arg("--out", join(root, "model", "next-component.json"));
  const weights = Object.fromEntries(arg("--weights", "websight=1,internal=3").split(",").map((kv) => [kv.split("=")[0], Number(kv.split("=")[1]) || 1]));
  const holdout = Number(arg("--holdout", "0"));
  const rand = rng(Number(arg("--seed", "42")));
  const limit = Number(arg("--limit", "0"));
  const holdoutOut = arg("--holdout-out", join(root, "data", "corpus", "holdout.jsonl"));

  const model = emptyModel();
  const held: string[] = [];
  let dropped = 0;
  let used = 0;
  for (const { source, tree } of readCorpus(files)) {
    if (limit && used >= limit) break;
    const t = cleanTree(tree);
    if (!t) {
      dropped++;
      continue;
    }
    if (holdout && rand() < holdout) {
      held.push(JSON.stringify({ source, tree: t }));
      continue;
    }
    countTree(model, t, weights[source] ?? 1, source);
    used++;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(model));
  if (held.length) {
    mkdirSync(dirname(holdoutOut), { recursive: true });
    writeFileSync(holdoutOut, held.join("\n") + "\n");
  }
  const top = Object.entries(model.counts.tri)
    .map(([k, row]) => [k, Object.values(row).reduce((a, b) => a + b, 0)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log(`Cây dùng để đếm: ${used} (theo nguồn ${JSON.stringify(model.meta.sources)}), bỏ ${dropped} cây lỗi, holdout ${held.length}`);
  console.log(`Số sự kiện (có trọng số): ${model.meta.events}`);
  console.log("Top 10 ngữ cảnh (ông|cha|anh trước):");
  for (const [k, n] of top) console.log(`  ${k.padEnd(36)} ${n}`);
  console.log(`→ ${out} (${(statSync(out).size / 1024).toFixed(1)} KB)`);
}
