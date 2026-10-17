// So sánh Transformer với n-gram trên cùng các tập kiểm tra, theo đúng thiết lập của Li et al. 2020 (mục 5):
//  Cây "đang thiết kế dở" = 10/50/80% node đầu theo thứ tự BFS hoặc DFS (hai luồng thiết kế của bài báo).
//  1) 3 thước đo của bài báo (mục 5.2, bản nới lỏng chỉ xét loại vì cây không có tọa độ):
//     - Next-element accuracy (Top-1, kèm Top-3): đoán loại node kế tiếp theo thứ tự duyệt.
//     - Parent-child pair F1: so cây mô hình TỰ HOÀN THIỆN với cây đúng.
//     - Layout tree edit distance (Zhang–Shasha, chi phí KLM-GOMS, giây): công sức sửa cây hoàn thiện thành cây đúng.
//     Mốc so sánh "Không gợi ý" = giữ nguyên cây dở (BA tự thêm mọi thứ).
//  2) Bổ sung riêng cho tính năng của nhóm: tìm phần tử bị thiếu (xóa 1 node) → Hit@1/Hit@3.
//  3) Báo động giả trên cây hoàn chỉnh và độ trễ suy luận.
// Dùng: npm run eval-transformer -- [--tf model/next-transformer.json] [--limit 1500] [--limit-complete 500] [--write-ngram]
//   --write-ngram: ghi n-gram huấn luyện trên cùng dữ liệu vào model/next-component.json (mô hình dự phòng của app)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findParent, isContainer, UINode } from "../shared/design.ts";
import { countTree, emptyModel, END, NGramModel, prob, rankTypes, ROOT, START, TF_ADD_MIN } from "../shared/nextComponent.ts";
import { loadTransformer, predictSlots, propsForSubtype, subtypeOf, TransformerModel } from "../shared/transformer.ts";
import { rng } from "./build-next-model.ts";
import { EDIT_COST, pairPRF, treeEditDistance } from "./tree-metrics.ts";

const root = join(import.meta.dirname, "..");
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};
const dir = join(root, "data", "corpus", "tf");
const limit = Number(arg("--limit", "1500"));
const readRaw = (f: string) =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { source: string; tree: UINode })
    : [];

function bfs(t: UINode): UINode[] {
  const out: UINode[] = [];
  const q = [...(t.children ?? [])];
  while (q.length) {
    const n = q.shift()!;
    out.push(n);
    q.push(...(n.children ?? []));
  }
  return out;
}

/** Bản sao cây chỉ gồm các node trong `keep` (gốc luôn giữ). */
function prune(n: UINode, keep: Set<string>): UINode {
  return { ...n, children: isContainer(n.type) ? (n.children ?? []).filter((c) => keep.has(c.id)).map((c) => prune(c, keep)) : undefined };
}

const top = <T,>(a: T[], k: number) => a.slice(0, k);

/** Thứ tự tiền tự DFS (bỏ gốc). */
function dfs(t: UINode): UINode[] {
  const out: UINode[] = [];
  const rec = (n: UINode) => (n.children ?? []).forEach((c) => (out.push(c), rec(c)));
  rec(t);
  return out;
}
const ORDERS = { BFS: bfs, DFS: dfs };

/** Cây dở theo bài báo: k node đầu theo thứ tự duyệt (luôn đóng theo tổ tiên vì cha đứng trước con). */
function partialOf(t: UINode, order: UINode[], f: number) {
  const k = Math.min(order.length - 1, Math.max(1, Math.floor(order.length * f)));
  const keep = new Set(order.slice(0, k).map((n) => n.id));
  return { k, keep, partial: prune(t, keep) };
}

function evalMasked(trees: UINode[], orderFn: (t: UINode) => UINode[], f: number, ng: NGramModel, tf: TransformerModel | null) {
  const r = { n: 0, ng1: 0, ng3: 0, tf1: 0, tf3: 0, tfSub: 0 };
  for (const t of trees) {
    const order = orderFn(t);
    if (order.length < 2) continue;
    const { k, keep, partial } = partialOf(t, order, f);
    const target = order[k];
    const parent = findParent(t, target.id)!;
    // BFS và DFS đều giữ đủ các anh liền trước của node kế tiếp → node kế tiếp nằm ở cuối các con của cha
    const pk = (parent.children ?? []).filter((c) => keep.has(c.id));
    const ctx = { g: findParent(t, parent.id)?.type ?? ROOT, p: parent.type, s: pk.length ? pk[pk.length - 1].type : START };
    const ngTop = rankTypes(ng, ctx, 3).map((x) => x.type);
    r.n++;
    r.ng1 += +(ngTop[0] === target.type);
    r.ng3 += +ngTop.includes(target.type);
    if (tf) {
      const slot = predictSlots(tf, partial, 1).find((s) => s.parentId === parent.id && s.index === pk.length);
      const tfTop = top(slot?.types ?? [], 3).map((x) => x.type);
      r.tf1 += +(tfTop[0] === target.type);
      r.tf3 += +tfTop.includes(target.type);
      r.tfSub += +(tfTop[0] === target.type && slot!.types[0].sub === subtypeOf(target));
    }
  }
  return r;
}

// ------------------------------------------------------------------ hoàn thiện cây (cho F1 và Edit distance)
const MAX_NODES = 100;
const MAX_CHILDREN = 30;
let uid = 0;
const count = (t: UINode): number => 1 + (t.children ?? []).reduce((a, c) => a + count(c), 0);

/** N-gram: với từng container (kể cả container mới sinh), thêm loại có xác suất cao nhất ở cuối cho tới khi <END> thắng. */
function completeNgram(partial: UINode, ng: NGramModel): UINode {
  const t = structuredClone(partial);
  let total = count(t);
  const q: { n: UINode; g: string }[] = [{ n: t, g: ROOT }];
  while (q.length) {
    const { n, g } = q.shift()!;
    if (!isContainer(n.type)) continue;
    n.children ??= [];
    while (total < MAX_NODES && n.children.length < MAX_CHILDREN) {
      const ctx = { g, p: n.type, s: n.children.length ? n.children[n.children.length - 1].type : START };
      const best = rankTypes(ng, ctx, 1)[0];
      if (!best || prob(ng, ctx, END) >= best.p) break;
      const c = { id: `ng${uid++}`, type: best.type, props: {}, ...(isContainer(best.type) ? { children: [] } : {}) } as UINode;
      n.children.push(c);
      total++;
    }
    for (const c of n.children) q.push({ n: c, g: n.type });
  }
  return t;
}

/** Transformer: mỗi vòng chèn đồng thời phần tử có xác suất cao nhất vào mọi ô mà P(thiếu) ≥ 0,5, lặp tới khi hết. */
function completeTf(partial: UINode, tf: TransformerModel, maxRounds = 12): UINode {
  const t = structuredClone(partial);
  const byId = new Map<string, UINode>();
  const index = (n: UINode) => (byId.set(n.id, n), (n.children ?? []).forEach(index));
  for (let round = 0; round < maxRounds; round++) {
    let total = count(t);
    if (total >= MAX_NODES) break;
    byId.clear();
    index(t);
    const ins = predictSlots(tf, t, 1).filter((s) => s.pMissing >= 0.5 && s.types.length).sort((a, b) => b.index - a.index);
    if (!ins.length) break;
    for (const s of ins) {
      const parent = byId.get(s.parentId)!;
      if (total >= MAX_NODES || (parent.children ?? []).length >= MAX_CHILDREN) continue;
      const ty = s.types[0];
      const c = { id: `tf${uid++}`, type: ty.type, props: propsForSubtype(ty.type, ty.sub), ...(isContainer(ty.type) ? { children: [] } : {}) } as UINode;
      (parent.children ??= []).splice(s.index, 0, c);
      total++;
    }
  }
  return t;
}

function evalComplete(trees: UINode[], orderFn: (t: UINode) => UINode[], f: number, ng: NGramModel, tf: TransformerModel | null) {
  const z = () => ({ f1: 0, edit: 0 });
  const r = { n: 0, none: z(), ng: z(), tf: z() };
  const add = (acc: { f1: number; edit: number }, pred: UINode, truth: UINode) => {
    acc.f1 += pairPRF(pred, truth).f1;
    acc.edit += treeEditDistance(pred, truth);
  };
  for (const t of trees) {
    const order = orderFn(t);
    if (order.length < 2) continue;
    const { partial } = partialOf(t, order, f);
    r.n++;
    add(r.none, partial, t);
    add(r.ng, completeNgram(partial, ng), t);
    if (tf) add(r.tf, completeTf(partial, tf), t);
  }
  return r;
}

function evalMissing(trees: UINode[], ng: NGramModel, tf: TransformerModel | null, seed = 5) {
  const rand = rng(seed);
  const r = { n: 0, ng1: 0, ng3: 0, tf1: 0, tf3: 0, tfSlot1: 0, tfDetect: 0 };
  for (const t of trees) {
    const nodes = bfs(t);
    if (nodes.length < 3) continue;
    const x = nodes[Math.floor(rand() * nodes.length)];
    const parent = findParent(t, x.id)!;
    const index = (parent.children ?? []).findIndex((c) => c.id === x.id);
    const drop = new Set(bfs(x).map((n) => n.id).concat(x.id));
    const keep = new Set(nodes.filter((n) => !drop.has(n.id)).map((n) => n.id));
    const partial = prune(t, keep);
    const hit = (c: { parentId: string; index: number; type: string }) => c.parentId === parent.id && c.index === index && c.type === x.type;
    r.n++;
    // n-gram: chấm mọi khe (container, vị trí) bằng P(loại | ông, cha, anh liền trước)
    const ngC: { parentId: string; index: number; type: string; s: number }[] = [];
    const walkC = (n: UINode, g: string) => {
      if (!isContainer(n.type)) return;
      const kids = n.children ?? [];
      for (let j = 0; j <= kids.length; j++) {
        const ctx = { g, p: n.type, s: j ? kids[j - 1].type : START };
        for (const c of rankTypes(ng, ctx, 3)) ngC.push({ parentId: n.id, index: j, type: c.type, s: prob(ng, ctx, c.type) });
      }
      kids.forEach((c) => walkC(c, n.type));
    };
    walkC(partial, ROOT);
    ngC.sort((a, b) => b.s - a.s);
    r.ng1 += +top(ngC, 1).some(hit);
    r.ng3 += +top(ngC, 3).some(hit);
    if (tf) {
      const slots = predictSlots(tf, partial, 1);
      const cands = slots.flatMap((s) => top(s.types, 3).map((ty) => ({ parentId: s.parentId, index: s.index, type: ty.type, s: s.pMissing * ty.p }))).sort((a, b) => b.s - a.s);
      r.tf1 += +top(cands, 1).some(hit);
      r.tf3 += +top(cands, 3).some(hit);
      r.tfSlot1 += +(cands[0]?.parentId === parent.id && cands[0]?.index === index);
      r.tfDetect += +cands.some((c) => c.s >= TF_ADD_MIN && hit(c));
    }
  }
  return r;
}

function falseAlarm(trees: UINode[], tf: TransformerModel) {
  let n = 0, alarm = 0, ms = 0, tokens = 0;
  for (const t of trees) {
    const t0 = performance.now();
    const slots = predictSlots(tf, t, 1);
    ms += performance.now() - t0;
    tokens += slots.length;
    n++;
    alarm += +slots.some((s) => s.pMissing * s.types[0].p >= TF_ADD_MIN);
  }
  return { n, rate: alarm / Math.max(n, 1), msPerTree: ms / Math.max(n, 1), slotsPerTree: tokens / Math.max(n, 1) };
}

// ------------------------------------------------------------------ chạy
const W: Record<string, number> = { websight: 1, internal: 5, synthetic: 2, learned: 5 };
const ng = emptyModel();
for (const r of readRaw(join(dir, "train.raw.jsonl"))) countTree(ng, r.tree, W[r.source] ?? 1, r.source);
if (process.argv.includes("--write-ngram")) writeFileSync(join(root, "model", "next-component.json"), JSON.stringify(ng));
const tfFile = arg("--tf", join(root, "model", "next-transformer.json"));
const tf = existsSync(tfFile) ? loadTransformer(JSON.parse(readFileSync(tfFile, "utf8"))) : null;
const sets = Object.fromEntries(["wi", "synth"].map((k) => [k, readRaw(join(dir, `${k}.raw.jsonl`)).map((r) => r.tree).slice(0, limit)]));
const pct = (x: number, n: number) => `${((100 * x) / Math.max(n, 1)).toFixed(1)}%`;
const NAMES: Record<string, string> = { wi: "WebSight + nội bộ", synth: "Nghiệp vụ tổng hợp" };
const csv = ["experiment,set,setting,n,ngram_top1,ngram_top3,tf_top1,tf_top3,extra"];
const report: Record<string, unknown> = { ngramTrees: ng.meta.trees, transformer: tf?.meta ?? null };

console.log(`N-gram (cùng dữ liệu): ${ng.meta.trees} cây · Transformer: ${tf ? `${tf.meta.params} tham số, ${tf.meta.trees} cây` : "chưa có"}\n`);
const limitComplete = Number(arg("--limit-complete", "500"));
const f1 = (x: number, n: number) => `${((100 * x) / Math.max(n, 1)).toFixed(1)}`;
const sec = (x: number, n: number) => (x / Math.max(n, 1)).toFixed(1);
console.log(`## 1. Thước đo của Li et al. 2020 (bản nới lỏng theo loại) – F1 (%), Next (%), Edit (giây KLM; chèn ${EDIT_COST.insert.toFixed(2)} s, đổi loại ${EDIT_COST.relabel.toFixed(2)} s, xóa ${EDIT_COST.delete.toFixed(2)} s)\n`);
for (const [k, trees] of Object.entries(sets)) {
  if (!trees.length) continue;
  const sub = trees.slice(0, limitComplete);
  for (const [oname, ofn] of Object.entries(ORDERS)) {
    console.log(`### ${NAMES[k]} – luồng ${oname} (Next: ${trees.length} cây, F1/Edit: ${sub.length} cây)\n`);
    console.log(`| Mô hình | ${[0.1, 0.5, 0.8].map((f) => `${oname} ${f * 100}% F1 | Next | Next Top-3 | Edit`).join(" | ")} |\n|---|${"---|---|---|---|".repeat(3)}`);
    const rows: Record<string, string[]> = { "Không gợi ý (giữ cây dở)": [], "N-gram": [], Transformer: [] };
    for (const f of [0.1, 0.5, 0.8]) {
      const m = evalMasked(trees, ofn, f, ng, tf);
      const c = evalComplete(sub, ofn, f, ng, tf);
      rows["Không gợi ý (giữ cây dở)"].push(f1(c.none.f1, c.n), "–", "–", sec(c.none.edit, c.n));
      rows["N-gram"].push(f1(c.ng.f1, c.n), f1(m.ng1, m.n), f1(m.ng3, m.n), sec(c.ng.edit, c.n));
      rows.Transformer.push(f1(c.tf.f1, c.n), f1(m.tf1, m.n), f1(m.tf3, m.n), sec(c.tf.edit, c.n));
      csv.push(`paper,${k},${oname}${f},${c.n},${m.ng1 / m.n},${m.ng3 / m.n},${m.tf1 / m.n},${m.tf3 / m.n},none_f1=${c.none.f1 / c.n};ng_f1=${c.ng.f1 / c.n};tf_f1=${c.tf.f1 / c.n};none_edit=${c.none.edit / c.n};ng_edit=${c.ng.edit / c.n};tf_edit=${c.tf.edit / c.n}`);
      report[`paper_${k}_${oname}_${f}`] = { masked: m, complete: c };
    }
    for (const [name, v] of Object.entries(rows)) console.log(`| ${name} | ${v.join(" | ")} |`);
    console.log("");
  }
}
console.log("\n## 2. Tìm phần tử bị thiếu (xóa 1 node, xếp hạng mọi vị trí × loại)\n");
console.log("| Tập | n | N-gram Hit@1 | N-gram Hit@3 | Transformer Hit@1 | Transformer Hit@3 | Đúng vị trí (Top-1) | Được gợi ý ở ngưỡng app |\n|---|---|---|---|---|---|---|---|");
for (const [k, trees] of Object.entries(sets)) {
  if (!trees.length) continue;
  const r = evalMissing(trees, ng, tf);
  console.log(`| ${NAMES[k]} | ${r.n} | ${pct(r.ng1, r.n)} | ${pct(r.ng3, r.n)} | ${pct(r.tf1, r.n)} | ${pct(r.tf3, r.n)} | ${pct(r.tfSlot1, r.n)} | ${pct(r.tfDetect, r.n)} |`);
  csv.push(`missing,${k},1node,${r.n},${r.ng1 / r.n},${r.ng3 / r.n},${r.tf1 / r.n},${r.tf3 / r.n},${r.tfDetect / r.n}`);
  report[`missing_${k}`] = r;
}
if (tf) {
  console.log("\n## 3. Báo động giả trên cây hoàn chỉnh & độ trễ\n");
  console.log("| Tập | n | Có gợi ý thêm (ngưỡng " + TF_ADD_MIN + ") | ms / cây | Số ô / cây |\n|---|---|---|---|---|");
  for (const [k, trees] of Object.entries(sets)) {
    if (!trees.length) continue;
    const r = falseAlarm(trees, tf);
    console.log(`| ${NAMES[k]} | ${r.n} | ${(r.rate * 100).toFixed(1)}% | ${r.msPerTree.toFixed(1)} | ${r.slotsPerTree.toFixed(0)} |`);
    csv.push(`false_alarm,${k},complete,${r.n},,,,,${r.rate}`);
    report[`alarm_${k}`] = r;
  }
}
mkdirSync(join(root, "analysis"), { recursive: true });
writeFileSync(join(root, "analysis", "eval-transformer.csv"), csv.join("\n") + "\n");
writeFileSync(join(root, "analysis", "eval-transformer.json"), JSON.stringify(report, null, 1));
console.log("\n→ analysis/eval-transformer.csv, analysis/eval-transformer.json");
