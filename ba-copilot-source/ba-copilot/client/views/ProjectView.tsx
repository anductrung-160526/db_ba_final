import React, { useEffect, useState } from "react";
import { get, post, del } from "../api.ts";
import { Btn, Empty, Field, Modal, StatusBadge, useUI } from "../components/ui.tsx";
import { FilesTab } from "./FilesTab.tsx";

const SAMPLE = `- As a Khách hàng, I want đăng nhập bằng email và mật khẩu, so that tôi mua hàng nhanh hơn.
- As a Khách hàng, I want đăng ký tài khoản mới.
- Cho phép quản trị viên quản lý sản phẩm (tìm kiếm, thêm, sửa, xóa).`;

export function ProjectView({ id, tab, initialModuleId }: { id: string; tab: string; initialModuleId?: string | null }) {
  const { run, toast } = useUI();
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [req, setReq] = useState("");
  const load = () => get(`/api/projects/${id}`).then(setData).catch((e) => toast(e.message, "err"));
  useEffect(() => {
    load();
  }, [id]);

  const create = async () => {
    const m = await run("Đang tạo module", () => post(`/api/projects/${id}/modules`, { name, requirementInput: req }));
    if (m) window.location.hash = `#/m/${m.id}/design`;
  };

  if (!data) return <div className="page muted">Đang tải…</div>;
  return (
    <div className="page">
      <div className="crumbs">
        <a href="#/">Dự án</a> / <span>{data.name}</span>
      </div>
      <div className="page-head">
        <div>
          <h1>{data.name}</h1>
          <p className="muted">{data.description || "Không có mô tả"}</p>
        </div>
        {tab === "modules" && (
          <Btn kind="primary" onClick={() => setOpen(true)} data-testid="new-module">
            + Module mới
          </Btn>
        )}
      </div>

      {/* Tab nav cấp dự án */}
      <nav className="tabs" role="tablist" style={{ marginBottom: 20 }}>
        <a
          href={`#/p/${id}/modules`}
          role="tab"
          aria-selected={tab === "modules"}
          className={`tab ${tab === "modules" ? "active" : ""}`}
          data-testid="tab-modules"
        >
          Module ({data.modules?.length ?? 0})
        </a>
        <a
          href={`#/p/${id}/files`}
          role="tab"
          aria-selected={tab === "files"}
          className={`tab ${tab === "files" ? "active" : ""}`}
          data-testid="tab-files"
        >
          📁 Kho tài liệu
        </a>
      </nav>

      {/* Nội dung tab */}
      {tab === "files" ? (
        <FilesTab projectId={id} initialModuleId={initialModuleId ?? null} />
      ) : (
        <>
          {data.modules.length === 0 ? (
            <Empty title="Chưa có module">Module là một nhóm chức năng (VD: Xác thực, Quản lý sản phẩm). Tạo module rồi prompt để AI thiết kế màn hình.</Empty>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Màn hình</th>
                  <th>Tài liệu</th>
                  <th>Test case</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.modules.map((m: any) => (
                  <tr key={m.id}>
                    <td>
                      <a href={`#/m/${m.id}/design`} className="strong">
                        {m.name}
                      </a>
                    </td>
                    <td>{m.screenCount}</td>
                    <td>
                      <StatusBadge status={m.docsStatus} />
                    </td>
                    <td>
                      <StatusBadge status={m.testsStatus} />
                    </td>
                    <td className="right">
                      <button
                        className="link-danger"
                        onClick={async () => {
                          if (!confirm(`Xóa module "${m.name}"?`)) return;
                          await run("Đang xóa", () => del(`/api/modules/${m.id}`));
                          load();
                        }}
                      >
                        Xóa
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {open && (
        <Modal
          title="Module mới"
          wide
          onClose={() => setOpen(false)}
          footer={
            <>
              <Btn onClick={() => setOpen(false)}>Hủy</Btn>
              <Btn kind="primary" disabled={!name.trim()} onClick={create} data-testid="create-module">
                Tạo module
              </Btn>
            </>
          }
        >
          <Field label="Tên module">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Xác thực người dùng" />
          </Field>
          <Field label="Yêu cầu nghiệp vụ / User story (không bắt buộc)" hint="Dán user story hoặc danh sách chức năng ở dạng tự do. AI dùng làm bối cảnh khi thiết kế và viết tài liệu.">
            <textarea rows={7} value={req} onChange={(e) => setReq(e.target.value)} placeholder={SAMPLE} />
          </Field>
          <button className="link" onClick={() => setReq(SAMPLE)}>
            Dùng ví dụ mẫu
          </button>
        </Modal>
      )}
    </div>
  );
}

