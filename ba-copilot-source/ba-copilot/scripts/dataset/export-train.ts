// Xuất bộ mẫu "bổ sung UI" sang dạng huấn luyện Transformer: cây ĐẦY ĐỦ đã mã hóa + chỉ số (tiền tự) các node bị bỏ.
// Python dựng lại cây thiếu bằng cách bỏ các node này (kèm cây con) – đúng như partialTree của mẫu.
// Dùng: npx tsx scripts/dataset/export-train.ts → data/dataset/tf/{train,val,test}.jsonl
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UINode, walk } from "../../shared/design.ts";
import { encodeTree } from "../../shared/transformer.ts";
import type { Sample } from "./build-samples.ts";

const root = join(import.meta.dirname, "..", "..");
const dir = join(root, "data", "dataset");
const out: Record<string, string[]> = { train: [], val: [], test: [] };
for (const l of readFileSync(join(dir, "samples.jsonl"), "utf8").split("\n")) {
  if (!l.trim()) continue;
  const s = JSON.parse(l) as Sample;
  const order: string[] = [];
  walk(s.completedTree, (n: UINode) => order.push(n.id));
  const removed = s.acceptedPatch.map((p) => order.indexOf((p as { node: UINode }).node.id));
  out[s.split].push(JSON.stringify({ id: s.id, rootId: s.rootId, kind: s.kind, trap: s.trap, tree: encodeTree(s.completedTree), drop: removed }));
}
mkdirSync(join(dir, "tf"), { recursive: true });
for (const [k, v] of Object.entries(out)) writeFileSync(join(dir, "tf", `${k}.jsonl`), v.join("\n") + "\n");
console.log(Object.entries(out).map(([k, v]) => `${k}: ${v.length}`).join(" · "));
