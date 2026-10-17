// Đọc màn gốc của bộ dữ liệu "bổ sung UI" (dataset/roots/*.json) và ghép với ma trận phủ (dataset/matrix.json).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { UINode } from "../../shared/design.ts";

const dir = () => process.env.DATASET_DIR ?? join(import.meta.dirname, "..", "..", "dataset");

interface Matrix { id: string; batch: string; group: string; screenKind: string; domain: string; permission: string; layout: string }
export interface RootItem extends Matrix {
  requirement: { title: string; actor: string; description: string; permissions: string[]; rules?: string[] };
  tree: UINode;
  notes?: string;
  file: string;
}

export function loadRoots(): { items: RootItem[]; version: string } {
  const d = dir();
  if (!existsSync(join(d, "matrix.json"))) return { items: [], version: "" };
  const matrix = new Map((JSON.parse(readFileSync(join(d, "matrix.json"), "utf8")) as Matrix[]).map((m) => [m.id, m]));
  const items: RootItem[] = [];
  const hash = createHash("sha1");
  const rd = join(d, "roots");
  for (const f of existsSync(rd) ? readdirSync(rd).filter((x) => x.endsWith(".json")).sort() : []) {
    const text = readFileSync(join(rd, f), "utf8");
    hash.update(text);
    for (const r of JSON.parse(text) as Omit<RootItem, "file">[]) {
      const m = matrix.get(r.id);
      if (m) items.push({ ...m, ...r, file: f });
    }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, version: hash.digest("hex").slice(0, 10) };
}
