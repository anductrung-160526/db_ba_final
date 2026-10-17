// Trang xem trước bộ mẫu: mỗi mẫu hiện yêu cầu, màn thiếu (đầu vào) và màn đầy đủ (đáp án), phần bị thiếu được tô.
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Renderer } from "../../client/components/Renderer.tsx";
import type { UINode } from "../../shared/design.ts";

interface S {
  id: string; split: string; kind: string; trap: boolean;
  meta: { group: string; screenKind: string; domain: string; permission: string; layout: string };
  requirement: { title: string; actor: string; description: string; permissions: string[]; rules?: string[] };
  partialTree: UINode; completedTree: UINode; targetContainerId: string | null;
  acceptedPatch: { parentId: string; index: number; node: UINode }[];
}
declare const SAMPLES: S[];
const KIND: Record<string, string> = { missing_one: "Thiếu 1 phần tử", missing_group: "Thiếu 1 cụm", missing_pair: "Thiếu 1 cặp", complete: "Màn đủ (đáp án rỗng)" };
const label = (n: UINode) => `${n.type}${n.props.label ?? n.props.text ?? n.props.title ? ` "${String(n.props.label ?? n.props.text ?? n.props.title).slice(0, 40)}"` : ""}`;

function App() {
  const [i, setI] = useState(0);
  const [kind, setKind] = useState("");
  const list = useMemo(() => SAMPLES.filter((s) => !kind || s.kind === kind || (kind === "trap" && s.trap)), [kind]);
  const s = list[Math.min(i, list.length - 1)];
  const missing = new Set(s?.acceptedPatch.flatMap((p) => { const ids: string[] = []; const w = (n: UINode) => { ids.push(n.id); (n.children ?? []).forEach(w); }; w(p.node); return ids; }) ?? []);
  const css = [...missing].map((id) => `.pv-full [data-node-id="${id}"]{outline:2px dashed #e11d48;outline-offset:2px;background:#fff1f2}`).join("");
  return (
    <div className="pv">
      <style>{css}</style>
      <div className="pv-bar">
        <b>Bộ dữ liệu "bổ sung UI" – xem trước {SAMPLES.length} mẫu</b>
        <select value={kind} onChange={(e) => (setKind(e.target.value), setI(0))}>
          <option value="">Tất cả kiểu</option>
          {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="trap">Mẫu bẫy (màn giới hạn quyền, đáp án rỗng)</option>
        </select>
        <button onClick={() => setI(Math.max(0, i - 1))}>←</button>
        <span>{list.length ? `${Math.min(i, list.length - 1) + 1}/${list.length}` : "0"}</span>
        <button onClick={() => setI(Math.min(list.length - 1, i + 1))}>→</button>
      </div>
      {s && (
        <>
          <div className="pv-req">
            <div className="pv-tags">{[s.id, s.split, KIND[s.kind] + (s.trap ? " · bẫy" : ""), s.meta.group, s.meta.screenKind, s.meta.domain, s.meta.layout].map((t) => <span key={t}>{t}</span>)}</div>
            <h2>{s.requirement.title}</h2>
            <p><b>Người dùng:</b> {s.requirement.actor} · <b>Quyền:</b> {s.requirement.permissions.join("; ")}</p>
            <p>{s.requirement.description}</p>
            <p className="pv-ans"><b>Đáp án (acceptedPatch):</b> {s.acceptedPatch.length ? s.acceptedPatch.map((p) => `chèn ${label(p.node)} vào "${p.parentId}" tại vị trí ${p.index}`).join("; ") : "không cần bổ sung gì"}</p>
          </div>
          <div className="pv-cols">
            <div><h3>Đầu vào: màn thiếu (partialTree)</h3><div className="pv-screen"><Renderer node={s.partialTree} /></div></div>
            <div className="pv-full"><h3>Đáp án: màn đầy đủ (completedTree) – phần thiếu tô đỏ</h3><div className="pv-screen"><Renderer node={s.completedTree} /></div></div>
          </div>
        </>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
