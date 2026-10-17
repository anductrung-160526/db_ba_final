// Đánh giá trên 30 màn tham chiếu thiết kế thủ công (scripts/reference-screens.ts) – không dùng khi huấn luyện.
//  1) Phát hiện phần tử thiếu (leave-one-out): lần lượt bỏ TỪNG node của mỗi màn, mô hình phải chỉ đúng vị trí + loại.
//  2) Gợi ý thừa: chạy tab Gợi ý (hàm suggest của app) trên màn hoàn chỉnh.
//  3) Màn "prompt thiếu": mỗi màn bỏ ngẫu nhiên 2 phần tử, 3 lần → chạy suggest như trên app, đo
//     - độ liên quan: % gợi ý "Thêm" trúng phần tử bị bỏ, % phần tử bị bỏ được gợi ý;
//     - độ đa dạng: số gợi ý khác nhau, entropy (bit), tỷ trọng gợi ý phổ biến nhất, độ trùng Jaccard trung bình
//       giữa các màn (càng thấp càng đa dạng), tỷ lệ câu prompt khác nhau.
// Dùng: npm run eval-reference -- [--tf model/next-transformer.json] [--md analysis/eval-reference.md]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findParent, isContainer, UINode } from "../shared/design.ts";
import { countTree, emptyModel, NGramModel, prob, rankTypes, ROOT, START, suggest, Suggestion, TF_ADD_MIN } from "../shared/nextComponent.ts";
import { loadTransformer, predictSlots, TransformerModel } from "../shared/transformer.ts";
import { rng } from "./build-next-model.ts";
import { REFERENCE_SCREENS } from "./reference-screens.ts";

const root = join(import.meta.dirname, "..");
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};
const out: string[] = [];
const log = (s = "") => (console.log(s), out.push(s));

// ------------------------------------------------------------------ mô hình
const W: Record<string, number> = { websight: 1, internal: 5, synthetic: 2, learned: 5 };
const ng = emptyModel();
const trainRaw = join(root, "data", "corpus", "tf", "train.raw.jsonl");
if (existsSync(trainRaw))
  for (const l of readFileSync(trainRaw, "utf8").split("\n")) if (l.trim()) {
    const r = JSON.parse(l);
    countTree(ng, r.tree, W[r.source] ?? 1, r.source);
  }
else Object.assign(ng, JSON.parse(readFileSync(join(root, "model", "next-component.json"), "utf8")));
const tf: TransformerModel = loadTransformer(JSON.parse(readFileSync(arg("--tf", join(root, "model", "next-transformer.json")), "utf8")));

// ------------------------------------------------------------------ tiện ích
const all = (t: UINode): UINode[] => (t.children ?? []).flatMap((c) => [c, ...all(c)]);
function without(t: UINode, ids: Set<string>): UINode {
  return { ...t, children: isContainer(t.type) ? (t.children ?? []).filter((c) => !ids.has(c.id)).map((c) => without(c, ids)) : undefined };
}
const pct = (x: number, n: number) => `${((100 * x) / Math.max(n, 1)).toFixed(1)}%`;

function ngramCandidates(partial: UINode) {
  const c: { parentId: string; index: number; type: string; s: number }[] = [];
  const walkC = (n: UINode, g: string) => {
    if (!isContainer(n.type)) return;
    const kids = n.children ?? [];
    for (let j = 0; j <= kids.length; j++) {
      const ctx = { g, p: n.type, s: j ? kids[j - 1].type : START };
      for (const x of rankTypes(ng, ctx, 3)) c.push({ parentId: n.id, index: j, type: x.type, s: prob(ng, ctx, x.type) });
    }
    kids.forEach((k) => walkC(k, n.type));
  };
  walkC(partial, ROOT);
  return c.sort((a, b) => b.s - a.s);
}
function tfCandidates(partial: UINode) {
  return predictSlots(tf, partial, 1)
    .flatMap((s) => s.types.slice(0, 3).map((t) => ({ parentId: s.parentId, index: s.index, type: t.type, s: s.pMissing * t.p })))
    .sort((a, b) => b.s - a.s);
}

/** Loại của gợi ý "Thêm" đọc từ id: n-gram add:<container>:<type>, Transformer add:<container>:<index>:<type>:<sub>. */
function addInfo(s: Suggestion): { container: string; type: string; key: string } | null {
  if (s.kind !== "add") return null;
  const p = s.id.split(":");
  return p.length >= 5 ? { container: p[1], type: p[3], key: `Thêm ${p[3]}${p[4] !== "-" ? `:${p[4]}` : ""}` } : { container: p[1], type: p[2], key: `Thêm ${p[2]}` };
}
const keyOf = (s: Suggestion) => addInfo(s)?.key ?? (s.kind === "fix" ? `Sửa ${s.reason.replace("Luật ", "")}` : "Xem lại");

// ------------------------------------------------------------------ 1) leave-one-out
log(`# Đánh giá trên ${REFERENCE_SCREENS.length} màn tham chiếu (thiết kế thủ công, không dùng khi huấn luyện)\n`);
{
  const r = { n: 0, ng1: 0, ng3: 0, tf1: 0, tf3: 0, tfSlot: 0, tfApp: 0 };
  const byType: Record<string, { n: number; hit: number }> = {};
  for (const { tree } of REFERENCE_SCREENS)
    for (const x of all(tree)) {
      const parent = findParent(tree, x.id)!;
      const index = parent.children!.findIndex((c) => c.id === x.id);
      const partial = without(tree, new Set([x.id]));
      const hit = (c: { parentId: string; index: number; type: string }) => c.parentId === parent.id && c.index === index && c.type === x.type;
      const ngc = ngramCandidates(partial), tfc = tfCandidates(partial);
      r.n++;
      r.ng1 += +ngc.slice(0, 1).some(hit);
      r.ng3 += +ngc.slice(0, 3).some(hit);
      r.tf1 += +tfc.slice(0, 1).some(hit);
      r.tf3 += +tfc.slice(0, 3).some(hit);
      r.tfSlot += +(tfc[0]?.parentId === parent.id && tfc[0]?.index === index);
      r.tfApp += +tfc.some((c) => c.s >= TF_ADD_MIN && hit(c));
      byType[x.type] ??= { n: 0, hit: 0 };
      byType[x.type].n++;
      byType[x.type].hit += +tfc.slice(0, 3).some(hit);
    }
  log("## 1. Phát hiện phần tử thiếu – bỏ lần lượt từng node (leave-one-out)\n");
  log(`| n | N-gram Hit@1 | N-gram Hit@3 | Transformer Hit@1 | Transformer Hit@3 | Đúng vị trí (Top-1) | Được gợi ý ở ngưỡng app (${TF_ADD_MIN}) |\n|---|---|---|---|---|---|---|`);
  log(`| ${r.n} | ${pct(r.ng1, r.n)} | ${pct(r.ng3, r.n)} | ${pct(r.tf1, r.n)} | ${pct(r.tf3, r.n)} | ${pct(r.tfSlot, r.n)} | ${pct(r.tfApp, r.n)} |\n`);
  log("Transformer Hit@3 theo loại phần tử bị bỏ (≥ 5 lần):\n");
  log("| Loại | n | Hit@3 |\n|---|---|---|");
  for (const [t, v] of Object.entries(byType).filter(([, v]) => v.n >= 5).sort((a, b) => b[1].n - a[1].n)) log(`| ${t} | ${v.n} | ${pct(v.hit, v.n)} |`);
  log("");
}

// ------------------------------------------------------------------ 2) gợi ý thừa trên màn hoàn chỉnh
{
  log("## 2. Gợi ý \"Thêm\" trên màn hoàn chỉnh (gợi ý thừa)\n");
  let screens = 0, total = 0;
  const lines: string[] = [];
  for (const { name, tree } of REFERENCE_SCREENS) {
    const adds = suggest(tf, tree, { k: 10 }).filter((s) => s.kind === "add");
    if (adds.length) screens++, (total += adds.length), lines.push(`- ${name}: ${adds.map((s) => s.title).join("; ")}`);
  }
  log(`${screens}/${REFERENCE_SCREENS.length} màn hoàn chỉnh (${pct(screens, REFERENCE_SCREENS.length)}) vẫn có gợi ý "Thêm" (tổng ${total} gợi ý):\n`);
  lines.forEach((l) => log(l));
  log("");
}

// ------------------------------------------------------------------ 3) màn thiếu: liên quan + đa dạng
{
  const rand = rng(2024);
  const runs: { name: string; removed: UINode[]; partial: UINode; parentOf: Map<string, string> }[] = [];
  for (const { name, tree } of REFERENCE_SCREENS)
    for (let v = 0; v < 3; v++) {
      const cands = all(tree).filter((x) => !isContainer(x.type) && x.type !== "Heading" && x.type !== "Text");
      const removed: UINode[] = [];
      while (removed.length < 2 && cands.length) removed.push(cands.splice(Math.floor(rand() * cands.length), 1)[0]);
      const parentOf = new Map(removed.map((x) => [x.id, findParent(tree, x.id)!.id]));
      runs.push({ name, removed, partial: without(tree, new Set(removed.map((x) => x.id))), parentOf });
    }

  const stats = (label: string, model: NGramModel | TransformerModel) => {
    const perScreen: Set<string>[] = [];
    const freq = new Map<string, number>();
    const freqAdd = new Map<string, number>();
    const prompts = new Set<string>();
    let total = 0, adds = 0, relevant = 0, recalled = 0, removedN = 0;
    for (const r of runs) {
      const sug = suggest(model, r.partial, { k: 5 });
      const keys = new Set<string>();
      for (const s of sug) {
        const k = keyOf(s);
        keys.add(k);
        freq.set(k, (freq.get(k) ?? 0) + 1);
        prompts.add(s.fixPrompt);
        total++;
        const a = addInfo(s);
        if (a) {
          adds++;
          freqAdd.set(k, (freqAdd.get(k) ?? 0) + 1);
          relevant += +r.removed.some((x) => x.type === a.type && r.parentOf.get(x.id) === a.container);
        }
      }
      for (const x of r.removed) {
        removedN++;
        recalled += +sug.some((s) => {
          const a = addInfo(s);
          return a && a.type === x.type && r.parentOf.get(x.id) === a.container;
        });
      }
      perScreen.push(keys);
    }
    const entropy = (m: Map<string, number>) => {
      const n = [...m.values()].reduce((a, b) => a + b, 0);
      return [...m.values()].reduce((h, c) => h - (c / n) * Math.log2(c / n), 0);
    };
    let jac = 0, pairs = 0;
    for (let i = 0; i < perScreen.length; i++)
      for (let j = i + 1; j < perScreen.length; j++) {
        if (runs[i].name === runs[j].name) continue; // chỉ so giữa các màn khác nhau
        const a = perScreen[i], b = perScreen[j];
        const inter = [...a].filter((x) => b.has(x)).length;
        const uni = new Set([...a, ...b]).size;
        if (uni) (jac += inter / uni), pairs++;
      }
    const topShare = (m: Map<string, number>, n: number) => Math.max(0, ...m.values()) / Math.max(n, 1);
    return {
      label, total, adds, relevant, recalled, removedN,
      uniqAll: freq.size, uniqAdd: freqAdd.size, hAll: entropy(freq), hAdd: entropy(freqAdd),
      topAll: topShare(freq, total), topAdd: topShare(freqAdd, adds), jaccard: jac / Math.max(pairs, 1), prompts: prompts.size,
      top: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      topAddList: [...freqAdd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    };
  };
  const a = stats("N-gram", ng), b = stats("Transformer", tf);
  log(`## 3. Màn "prompt thiếu" (${runs.length} lượt = ${REFERENCE_SCREENS.length} màn × 3, mỗi lượt bỏ 2 phần tử) – chạy tab Gợi ý như trên app (k = 5)\n`);
  log("### Độ liên quan\n");
  log("| Mô hình | Gợi ý \"Thêm\" | Trúng phần tử bị bỏ (precision) | Phần tử bị bỏ được gợi ý (recall) |\n|---|---|---|---|");
  for (const s of [a, b]) log(`| ${s.label} | ${s.adds} | ${pct(s.relevant, s.adds)} | ${pct(s.recalled, s.removedN)} |`);
  log("\n### Độ đa dạng\n");
  log("| Mô hình | Tổng gợi ý | Loại gợi ý khác nhau (tất cả / chỉ Thêm) | Entropy bit (tất cả / Thêm) | Tỷ trọng gợi ý phổ biến nhất (tất cả / Thêm) | Jaccard trung bình giữa 2 màn khác nhau ↓ | Câu prompt khác nhau |\n|---|---|---|---|---|---|---|");
  for (const s of [a, b])
    log(`| ${s.label} | ${s.total} | ${s.uniqAll} / ${s.uniqAdd} | ${s.hAll.toFixed(2)} / ${s.hAdd.toFixed(2)} | ${pct(s.topAll * s.total, s.total)} / ${pct(s.topAdd * s.adds, s.adds)} | ${s.jaccard.toFixed(3)} | ${s.prompts} (${pct(s.prompts, s.total)}) |`);
  for (const s of [a, b]) {
    log(`\n${s.label} – 5 gợi ý xuất hiện nhiều nhất: ${s.top.map(([k, c]) => `${k} (${c})`).join(", ")}`);
    log(`${s.label} – các gợi ý "Thêm": ${s.topAddList.map(([k, c]) => `${k} (${c})`).join(", ") || "(không có)"}`);
  }
}

const md = arg("--md", join(root, "analysis", "eval-reference.md"));
mkdirSync(dirname(md), { recursive: true });
writeFileSync(md, out.join("\n") + "\n");
console.log(`\n→ ${md}`);
