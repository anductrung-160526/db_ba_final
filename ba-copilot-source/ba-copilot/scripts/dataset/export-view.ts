// Xuất bộ mẫu để xem: dataset/export/{samples.jsonl.gz, samples.csv, roots.csv, preview.html, stats.json}.
// preview.html là trang độc lập (mở bằng trình duyệt), hiện ngẫu nhiên tối đa 400 mẫu, cân bằng theo kiểu.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import * as esbuild from "esbuild";
import type { UINode } from "../../shared/design.ts";
import type { Sample } from "./build-samples.ts";
import { rng } from "../build-next-model.ts";

const root = join(import.meta.dirname, "..", "..");
const src = join(root, "data", "dataset");
const out = join(root, "dataset", "export");
mkdirSync(out, { recursive: true });
const text = readFileSync(join(src, "samples.jsonl"), "utf8");
const samples = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Sample);
writeFileSync(join(out, "samples.jsonl.gz"), gzipSync(text));
copyFileSync(join(src, "stats.json"), join(out, "stats.json"));

const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const size = (n: UINode): number => 1 + (n.children ?? []).reduce((a, c) => a + size(c), 0);
const lbl = (n: UINode) => `${n.type}${n.props.label ?? n.props.text ?? n.props.title ? ` "${String(n.props.label ?? n.props.text ?? n.props.title)}"` : ""}`;
const rows = [["id", "rootId", "split", "kind", "trap", "group", "screenKind", "domain", "permission", "layout", "requirement", "actor", "missing", "targetContainerId", "partialNodes", "completeNodes"].join(",")];
for (const s of samples)
  rows.push([s.id, s.rootId, s.split, s.kind, s.trap, s.meta.group, s.meta.screenKind, s.meta.domain, s.meta.permission, s.meta.layout, s.requirement.title, s.requirement.actor,
    s.acceptedPatch.map((p) => `${lbl((p as { node: UINode }).node)} → ${(p as { parentId: string }).parentId}[${(p as { index: number }).index}]`).join(" | "), s.targetContainerId ?? "", size(s.partialTree), size(s.completedTree)].map(q).join(","));
writeFileSync(join(out, "samples.csv"), "\ufeff" + rows.join("\n") + "\n");
const seen = new Set<string>();
const rr = [["rootId", "group", "screenKind", "domain", "permission", "layout", "title", "actor", "nodes", "samples"].join(",")];
for (const s of samples) if (!seen.has(s.rootId)) {
  seen.add(s.rootId);
  rr.push([s.rootId, s.meta.group, s.meta.screenKind, s.meta.domain, s.meta.permission, s.meta.layout, s.requirement.title, s.requirement.actor, size(s.completedTree), samples.filter((x) => x.rootId === s.rootId).length].map(q).join(","));
}
writeFileSync(join(out, "roots.csv"), "\ufeff" + rr.join("\n") + "\n");

// trang xem trước
const r = rng(3);
const byKind = new Map<string, Sample[]>();
for (const s of samples) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
const pick = [...byKind.values()].flatMap((arr) => arr.map((s) => [r(), s] as const).sort((a, b) => a[0] - b[0]).slice(0, 100).map((x) => x[1])).sort((a, b) => a.id.localeCompare(b.id));
const js = await esbuild.build({ entryPoints: [join(import.meta.dirname, "preview-entry.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
const css = readFileSync(join(root, "client", "styles.css"), "utf8");
const page = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bộ dữ liệu bổ sung UI</title>
<style>${css}
body{background:#f5f6f8;margin:0;font-family:Inter,system-ui,sans-serif}.pv{padding:16px;max-width:1500px;margin:auto}.pv-bar{display:flex;gap:10px;align-items:center;position:sticky;top:0;background:#f5f6f8;padding:8px 0;z-index:5}
.pv-bar button,.pv-bar select{padding:4px 10px}.pv-req{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:12px 16px;margin:8px 0}.pv-req h2{margin:6px 0;font-size:18px}.pv-req p{margin:4px 0}
.pv-tags{display:flex;gap:6px;flex-wrap:wrap}.pv-tags span{font-size:11px;background:#f2f4f7;border-radius:999px;padding:2px 8px}.pv-ans{color:#b42318}.pv-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pv-cols h3{font-size:14px;margin:6px 0}.pv-screen{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:12px;overflow:auto;max-height:80vh}@media(max-width:900px){.pv-cols{grid-template-columns:1fr}}</style></head>
<body><div id="root"></div><script>const SAMPLES=${JSON.stringify(pick).replace(/</g, "\\u003c")};</script><script>${js.outputFiles[0].text}</script></body></html>`;
writeFileSync(join(out, "preview.html"), page);
console.log(`→ dataset/export: samples.jsonl.gz (${samples.length} mẫu), samples.csv, roots.csv (${seen.size} màn), preview.html (${pick.length} mẫu), stats.json`);
