import React, { useCallback, useEffect, useState } from "react";
import { get, patch } from "../api.ts";
import type { ModuleDetail } from "../../shared/types.ts";
import { Btn, Modal, StatusBadge, useUI } from "../components/ui.tsx";
import { DesignTab } from "./DesignTab.tsx";
import { DocsTab } from "./DocsTab.tsx";
import { TestsTab } from "./TestsTab.tsx";
import { TraceTab } from "./TraceTab.tsx";
import { LogsTab } from "./LogsTab.tsx";

const TABS = [
  { key: "design", label: "1. Thiết kế" },
  { key: "docs", label: "2. Tài liệu" },
  { key: "tests", label: "3. Test case" },
  { key: "trace", label: "4. Truy vết" },
  { key: "logs", label: "Nhật ký AI" },
];

export function ModuleView({ id, tab }: { id: string; tab: string }) {
  const { toast, run } = useUI();
  const [m, setM] = useState<ModuleDetail | null>(null);
  const [editReq, setEditReq] = useState(false);
  const [reqText, setReqText] = useState("");
  const reload = useCallback(() => get<ModuleDetail>(`/api/modules/${id}`).then(setM).catch((e) => toast(e.message, "err")), [id]);
  useEffect(() => {
    reload();
  }, [reload]);

  if (!m) return <div className="page muted">Đang tải…</div>;
  const approvedScreens = m.screens.filter((s) => s.status === "approved").length;
  const step = (key: string) => {
    if (key === "design") return m.screens.length ? (approvedScreens ? `${approvedScreens}/${m.screens.length} đã duyệt` : `${m.screens.length} màn hình`) : "Chưa có";
    if (key === "docs") return m.docsStatus;
    if (key === "tests") return m.testsStatus;
    return "";
  };

  return (
    <div className="module">
      <div className="module-head">
        <div className="crumbs">
          <a href="#/">Dự án</a> / <a href={`#/p/${m.projectId}`}>{m.project.name}</a> / <span>{m.name}</span>
        </div>
        <div className="module-title-row">
          <h1>{m.name}</h1>
          <Btn
            size="sm"
            kind="ghost"
            onClick={() => {
              setReqText(m.requirementInput);
              setEditReq(true);
            }}
          >
            Yêu cầu nghiệp vụ {m.requirementInput ? "✓" : "(trống)"}
          </Btn>
          {/* Link nhanh tới Kho tài liệu của module này */}
          <a href={`#/p/${m.projectId}/files/${m.id}`} className="btn btn-ghost btn-sm" data-testid="module-files-link">
            📁 Kho tài liệu
          </a>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => {
            const st = step(t.key);
            return (
              <a key={t.key} href={`#/m/${id}/${t.key}`} role="tab" aria-selected={tab === t.key} className={`tab ${tab === t.key ? "active" : ""}`} data-testid={`tab-${t.key}`}>
                {t.label}
                {st && (["none", "draft", "approved", "outdated"].includes(st) ? <StatusBadge status={st} /> : <span className="tab-note">{st}</span>)}
              </a>
            );
          })}
        </nav>
      </div>
      <div className="module-body">
        {tab === "design" && <DesignTab m={m} reload={reload} />}
        {tab === "docs" && <DocsTab m={m} reload={reload} />}
        {tab === "tests" && <TestsTab m={m} reload={reload} />}
        {tab === "trace" && <TraceTab m={m} />}
        {tab === "logs" && <LogsTab moduleId={m.id} />}
      </div>
      {editReq && (
        <Modal
          title="Yêu cầu nghiệp vụ / User story"
          wide
          onClose={() => setEditReq(false)}
          footer={
            <>
              <Btn onClick={() => setEditReq(false)}>Hủy</Btn>
              <Btn
                kind="primary"
                onClick={async () => {
                  await run("Đang lưu", () => patch(`/api/modules/${id}`, { requirementInput: reqText }));
                  setEditReq(false);
                  reload();
                }}
              >
                Lưu
              </Btn>
            </>
          }
        >
          <p className="muted small">AI dùng nội dung này làm bối cảnh khi sinh màn hình, Use Case và SRS. Có thể dán user story, function list hoặc mô tả tự do.</p>
          <textarea rows={14} value={reqText} onChange={(e) => setReqText(e.target.value)} />
        </Modal>
      )}
    </div>
  );
}
