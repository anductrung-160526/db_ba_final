// Đánh giá mô hình gợi ý thành phần (phục vụ phần Method).
//  1) Che bớt cây (theo Li et al. 2020): giữ 10/50/80% node đầu theo BFS, đoán loại node kế tiếp → Top-1/Top-3, so baseline.
//  2) Phát lại lịch sử phiên bản trong DB: node BA thật sự thêm có nằm trong top-3 gợi ý của container cha không.
//  3) Đường cong bão hòa: đếm với 1k/5k/10k/20k/30k cây (giới hạn bởi dữ liệu có), đo Top-3 ở mức 50%.
// Dùng: npm run eval-next -- --model model/next-component.json --test data/corpus/holdout.jsonl
//         [--train data/corpus/internal.jsonl,...] [--db data/ba-copilot.db] [--sec-per-insert 6]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { diffTrees, findNode, findParent, UINode } from "../shared/design.ts";
import { countTree, Ctx, emptyModel, END, NGramModel, rankTypes, ROOT, START } from "../shared/nextComponent.ts";
import { cleanTree, readCorpus } from "./build-next-model.ts";

const root = join(import.meta.dirname, "..");
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};
const FRACTIONS = [0.1, 0.5, 0.8];

/** Ngữ cảnh của node trong cây gốc: (loại ông, loại cha, loại anh em liền trước). */
function ctxOf(tree: UINode, n: UINode): Ctx | null {
  const p = findParent(tree, n.id);
  if (!p) return null;
  const kids = p.children ?? [];
  const i = kids.findIndex((c) => c.id === n.id);
  return { g: findParent(tree, p.id)?.type ?? ROOT, p: p.type, s: i > 0 ? kids[i - 1].type : START };
}

function bfs(tree: UINode): UINode[] {
  const out: UINode[] = [];
  const q = [...(tree.children ?? [])];
  while (q.length) {
    const n = q.shift()!;
    out.push(n);
    q.push(...(n.children ?? []));
  }
  return out;
}

function topTypes(model: NGramModel, k: number): string[] {
  return Object.entries(model.counts.all)
    .filter(([x]) => x !== END && x !== "Page")
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([x]) => x);
}

export function evalMasked(model: NGramModel, trees: UINode[], fraction: number) {
  let n = 0, top1 = 0, top3 = 0, base1 = 0, base3 = 0;
  const b3 = topTypes(model, 3);
  for (const t of trees) {
    const order = bfs(t);
    if (order.length < 2) continue;
    const keep = Math.min(order.length - 1, Math.max(1, Math.floor(order.length * fraction)));
    const target = order[keep];
    const ctx = ctxOf(t, target);
    if (!ctx) continue;
    const pred = rankTypes(model, ctx, 3).map((x) => x.type);
    n++;
    if (pred[0] === target.type) top1++;
    if (pred.includes(target.type)) top3++;
    if (b3[0] === target.type) base1++;
    if (b3.includes(target.type)) base3++;
  }
  const r = (x: number) => (n ? x / n : 0);
  return { fraction, n, top1: r(top1), top3: r(top3), baseTop1: r(base1), baseTop3: r(base3) };
}

/** Phát lại lịch sử: với mỗi node được thêm giữa 2 phiên bản liên tiếp, kiểm tra top-3 tại container cha (theo cây cũ). */
export function evalReplay(model: NGramModel, dbFile: string) {
  if (!existsSync(dbFile)) return { n: 0, top3: 0, note: `không có DB ${dbFile}` };
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const rows = db.prepare("SELECT screen_id, number, tree FROM screen_versions ORDER BY screen_id, number").all() as { screen_id: string; tree: string }[];
  let n = 0, hit = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].screen_id !== rows[i - 1].screen_id) continue;
    const a = JSON.parse(rows[i - 1].tree) as UINode;
    const b = JSON.parse(rows[i].tree) as UINode;
    for (const id of diffTrees(a, b).added) {
      const parentNew = findParent(b, id);
      const node = findNode(b, id);
      const parentOld = parentNew ? findNode(a, parentNew.id) : null;
      if (!node || !parentOld) continue; // cha cũng mới thêm → bỏ
      const kids = parentOld.children ?? [];
      const ctx = { g: findParent(a, parentOld.id)?.type ?? ROOT, p: parentOld.type, s: kids.length ? kids[kids.length - 1].type : START };
      n++;
      if (rankTypes(model, ctx, 3).some((x) => x.type === node.type)) hit++;
    }
  }
  db.close();
  return { n, top3: n ? hit / n : 0, note: "" };
}

if (process.argv[1]?.endsWith("eval-next.ts")) {
  const model = JSON.parse(readFileSync(arg("--model", join(root, "model", "next-component.json")), "utf8")) as NGramModel;
  const testFile = arg("--test", join(root, "data", "corpus", "holdout.jsonl"));
  const secPerInsert = Number(arg("--sec-per-insert", "6"));
  const test = existsSync(testFile) ? readCorpus([testFile]).map((r) => cleanTree(r.tree)).filter((t): t is UINode => !!t) : [];

  const csv: string[] = ["experiment,setting,n,top1,top3,baseline_top1,baseline_top3"];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`\n## 1. Che bớt cây (holdout: ${test.length} cây, ${testFile})\n`);
  console.log("| Đã có | n | Top-1 | Top-3 | Baseline Top-1 | Baseline Top-3 |\n|---|---|---|---|---|---|");
  const masked = FRACTIONS.map((f) => evalMasked(model, test, f));
  for (const r of masked) {
    console.log(`| ${r.fraction * 100}% | ${r.n} | ${pct(r.top1)} | ${pct(r.top3)} | ${pct(r.baseTop1)} | ${pct(r.baseTop3)} |`);
    csv.push(`masked,${r.fraction},${r.n},${r.top1.toFixed(4)},${r.top3.toFixed(4)},${r.baseTop1.toFixed(4)},${r.baseTop3.toFixed(4)}`);
  }

  const dbFile = arg("--db", process.env.DB_FILE ?? join(root, "data", "ba-copilot.db"));
  const rep = evalReplay(model, dbFile);
  console.log(`\n## 2. Phát lại lịch sử phiên bản (${dbFile})\n`);
  console.log(rep.n ? `Node được thêm: ${rep.n} · nằm trong Top-3 gợi ý: ${pct(rep.top3)}` : `Chưa có dữ liệu (${rep.note || "không có node được thêm"})`);
  csv.push(`replay,db,${rep.n},,${rep.top3.toFixed(4)},,`);

  const trainFiles = arg("--train", "").split(",").filter(Boolean);
  if (trainFiles.length) {
    // bỏ các cây trùng với tập test để tránh rò rỉ dữ liệu
    const sig = (t: UINode) => JSON.stringify(t);
    const testSigs = new Set(test.map(sig));
    const train = readCorpus(trainFiles).map((r) => cleanTree(r.tree)).filter((t): t is UINode => !!t && !testSigs.has(sig(t)));
    console.log(`\n## 3. Đường cong bão hòa (Top-3 ở mức 50%, train tối đa ${train.length} cây)\n`);
    console.log("| Số cây | Top-3 |\n|---|---|");
    for (const size of [1000, 5000, 10000, 20000, 30000, train.length].filter((s, i, a) => s <= train.length && a.indexOf(s) === i)) {
      const m = emptyModel();
      for (const t of train.slice(0, size)) countTree(m, t);
      const r = evalMasked(m, test, 0.5);
      console.log(`| ${size} | ${pct(r.top3)} |`);
      csv.push(`saturation,${size},${r.n},${r.top1.toFixed(4)},${r.top3.toFixed(4)},,`);
    }
  }

  // Quy đổi công sức (KLM-GOMS, Card et al. 1980): mỗi phần tử thêm đúng nhờ gợi ý tiết kiệm ~secPerInsert giây
  const r50 = masked[1];
  const saved = r50.top3 * 100 * secPerInsert;
  console.log(`\n## 4. Quy đổi công sức (KLM-GOMS)\n`);
  console.log(`Giả định ${secPerInsert} s cho mỗi thao tác chèn phần tử thủ công. Với Top-3 = ${pct(r50.top3)} ở mức 50%,`);
  console.log(`cứ 100 lần chèn phần tử, gợi ý giúp tiết kiệm ≈ ${saved.toFixed(0)} s (${(saved / 60).toFixed(1)} phút).`);
  csv.push(`klm,sec_per_100_inserts,100,,${saved.toFixed(1)},,`);

  mkdirSync(join(root, "analysis"), { recursive: true });
  writeFileSync(join(root, "analysis", "eval-next.csv"), csv.join("\n") + "\n");
  console.log(`\n→ analysis/eval-next.csv`);
}

