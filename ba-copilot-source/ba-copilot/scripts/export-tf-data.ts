// Xuất dữ liệu huấn luyện Transformer: mỗi cây → dạng mã hóa [loại, loại con, con?] bằng CHÍNH hàm encodeTree
// mà server dùng khi suy luận, để Python và TypeScript nhìn cây giống hệt nhau.
// Tách tập kiểm tra:
//   - wi    : data/corpus/holdout.jsonl (WebSight + nội bộ, giữ nguyên để so với n-gram đã báo cáo)
//   - synth : 10% cây nghiệp vụ tổng hợp
// Màn hình được BA duyệt trong DB (model_learned_trees) được thêm vào tập huấn luyện với trọng số cao.
// Dùng: npm run export-tf-data -- [--db data/ba-copilot.db] [--out data/corpus/tf]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { UINode } from "../shared/design.ts";
import { encodeTree } from "../shared/transformer.ts";
import { cleanTree, readCorpus, rng } from "./build-next-model.ts";

const root = join(import.meta.dirname, "..");
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};
const corpus = join(root, "data", "corpus");
const outDir = arg("--out", join(corpus, "tf"));
const WEIGHT: Record<string, number> = { websight: 1, internal: 5, synthetic: 2, learned: 5 };

const sig = (t: UINode) => JSON.stringify(t);
const rows = { train: [] as string[], wi: [] as string[], synth: [] as string[] };
// bản cây gốc (UINode) song song để đánh giá n-gram/Transformer bằng TypeScript trên cùng tập
const raw: Record<string, string[]> = { train: [], wi: [], synth: [] };
const enc = (src: string, t: UINode) => JSON.stringify({ src, w: WEIGHT[src] ?? 1, tree: encodeTree(t) });
const push = (k: keyof typeof rows, src: string, t: UINode) => {
  rows[k].push(enc(src, t));
  raw[k].push(JSON.stringify({ source: src, tree: t }));
};

// 1) WebSight + nội bộ: holdout cũ là tập kiểm tra
const holdFile = join(corpus, "holdout.jsonl");
const held = existsSync(holdFile) ? readCorpus([holdFile]).map((r) => ({ ...r, tree: cleanTree(r.tree) })).filter((r) => r.tree) : [];
const heldSigs = new Set(held.map((r) => sig(r.tree!)));
for (const r of held) push("wi", r.source, r.tree!);
for (const f of ["websight.jsonl", "internal.jsonl"]) {
  if (!existsSync(join(corpus, f))) continue;
  for (const r of readCorpus([join(corpus, f)])) {
    const t = cleanTree(r.tree);
    if (t && !heldSigs.has(sig(t))) push("train", r.source, t);
  }
}

// 2) Tổng hợp
const rand = rng(11);
if (existsSync(join(corpus, "synthetic.jsonl")))
  for (const r of readCorpus([join(corpus, "synthetic.jsonl")])) {
    const t = cleanTree(r.tree);
    if (t) push(rand() < 0.1 ? "synth" : "train", "synthetic", t);
  }

// 3) Màn được BA duyệt
const dbFile = arg("--db", process.env.DB_FILE ?? join(root, "data", "ba-copilot.db"));
let learned = 0;
if (existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    for (const r of db.prepare("SELECT tree FROM model_learned_trees").all() as { tree: string }[]) {
      const t = cleanTree(JSON.parse(r.tree));
      if (t) push("train", "learned", t), learned++;
    }
  } catch {
    /* DB cũ chưa có bảng */
  }
  db.close();
}

mkdirSync(outDir, { recursive: true });
for (const [k, v] of Object.entries(rows)) writeFileSync(join(outDir, `${k}.jsonl`), v.join("\n") + "\n");
for (const [k, v] of Object.entries(raw)) writeFileSync(join(outDir, `${k}.raw.jsonl`), v.join("\n") + "\n");
console.log(`Huấn luyện ${rows.train.length} cây (trong đó ${learned} màn đã duyệt) · kiểm tra: wi ${rows.wi.length}, synth ${rows.synth.length} → ${outDir}`);
