// Tab "Kho tài liệu" ở cấp dự án – hiển thị, upload, tải về và xóa file.

import React, { useEffect, useRef, useState } from "react";
import { get, post, del } from "../api.ts";
import type { FileRecord } from "../../shared/types.ts";
import { Btn, Empty, Field, Modal, useUI } from "../components/ui.tsx";

const ALLOWED_EXTS = [".docx", ".xlsx", ".pptx", ".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md", ".csv"];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Định dạng dung lượng file thân thiện người dùng. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Định dạng ngày giờ ngắn gọn. */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Biểu tượng icon theo loại file. */
function FileIcon({ mime }: { mime: string }) {
  if (mime.includes("wordprocessingml") || mime.includes("docx")) return <>📄</>;
  if (mime.includes("spreadsheetml") || mime.includes("xlsx")) return <>📊</>;
  if (mime.includes("presentationml") || mime.includes("pptx")) return <>📑</>;
  if (mime.includes("pdf")) return <>📕</>;
  if (mime.startsWith("image/")) return <>🖼️</>;
  return <>📎</>;
}

/** Tải file về trình duyệt qua `/api/files/:id/download`. */
function downloadFile(id: string, name: string) {
  fetch(`/api/files/${id}/download`)
    .then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? `Lỗi ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    })
    .catch((e) => alert(e.message));
}

export function FilesTab({ projectId, initialModuleId }: { projectId: string; initialModuleId?: string | null }) {
  const { run, toast } = useUI();
  const [files, setFiles] = useState<FileRecord[] | null>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  // Lấy danh sách file của dự án
  const load = () =>
    get<FileRecord[]>(`/api/projects/${projectId}/files`)
      .then(setFiles)
      .catch((e) => toast(e.message, "err"));

  useEffect(() => {
    load();
  }, [projectId]);

  // Scroll tới và làm nổi bật hàng file thuộc module được chỉ định (từ link trong ModuleView)
  useEffect(() => {
    if (!initialModuleId || !files) return;
    // Tìm section element có id tương ứng rồi scroll vào
    const el = document.getElementById(`files-module-${initialModuleId}`);
    if (el) {
      setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }
  }, [files, initialModuleId]);

  /** Xử lý xác nhận tải lên trong Modal */
  const handleConfirmUpload = async () => {
    if (!file) {
      toast("Vui lòng chọn một file để tải lên", "err");
      return;
    }

    // Kiểm tra đuôi file (chữ thường, có dấu chấm)
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
    if (!ALLOWED_EXTS.includes(ext)) {
      toast(`Định dạng file không được hỗ trợ (${ext || "không có đuôi"}). Chỉ chấp nhận: ${ALLOWED_EXTS.join(", ")}`, "err");
      return;
    }

    // Kiểm tra dung lượng file
    if (file.size > MAX_FILE_BYTES) {
      toast("Kích thước file vượt quá giới hạn 10MB", "err");
      return;
    }
    if (file.size === 0) {
      toast("Nội dung file rỗng", "err");
      return;
    }

    // Đọc file base64 bằng FileReader và await xong trước khi gửi API
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = reader.result as string;
          const base64 = res.includes(",") ? res.split(",")[1] : res;
          resolve(base64);
        };
        reader.onerror = () => reject(new Error("Lỗi khi đọc file"));
        reader.readAsDataURL(file);
      });

      const res = await run(`Đang tải lên "${file.name}"…`, () =>
        post(`/api/projects/${projectId}/files`, {
          name: file.name,
          contentBase64,
        })
      );

      // Nếu có lỗi, run() đã toast lỗi và trả undefined -> giữ modal mở
      if (!res) return;

      toast(`Đã tải lên "${file.name}" thành công`, "ok");
      setOpen(false);
      setFile(null);
      load();
    } catch (err: any) {
      toast(`Lỗi đọc file: ${err.message}`, "err");
    }
  };

  /** Xóa một file sau khi xác nhận. */
  const handleDelete = async (f: FileRecord) => {
    if (!confirm(`Xóa file "${f.name}"?`)) return;
    await run("Đang xóa…", () => del(`/api/files/${f.id}`));
    toast("Đã xóa", "ok");
    load();
  };

  if (!files) return <div className="page muted">Đang tải…</div>;

  // Phân nhóm: xuất tự động (export) và upload thủ công (upload)
  const exports = files.filter((f) => f.source === "export");
  const uploads = files.filter((f) => f.source === "upload");

  return (
    <div className="page">
      {/* Thanh tiêu đề */}
      <div className="page-head">
        <div>
          <h1>Kho tài liệu</h1>
          <p className="muted">
            {files.length} file · Bao gồm bản xuất Word/Excel và tài liệu tải lên thủ công
          </p>
        </div>
        <Btn
          kind="primary"
          onClick={() => {
            setFile(null);
            setOpen(true);
          }}
          data-testid="upload-btn"
        >
          + Tải lên
        </Btn>
      </div>

      {files.length === 0 ? (
        <Empty title="Kho chưa có tài liệu nào">
          Tải file lên thủ công hoặc xuất Word/Excel từ tab "2. Tài liệu" / "3. Test case" của từng
          module – server sẽ tự lưu bản mới nhất vào đây.
        </Empty>
      ) : (
        <>
          {/* Nhóm: Xuất tự động – section riêng cho từng module nếu có initialModuleId */}
          {exports.length > 0 && (
            <section id={initialModuleId ? `files-module-${initialModuleId}` : undefined}
              style={initialModuleId && exports.some((f) => f.moduleId === initialModuleId)
                ? { outline: "2px solid var(--accent)", outlineOffset: 4, borderRadius: "var(--radius)", padding: "4px 0" }
                : undefined}>
              <h2 style={{ marginTop: 24 }}>
                Bản xuất tự động{" "}
                <span className="muted small">({exports.length})</span>
              </h2>
              <FileTable files={exports} onDelete={handleDelete} highlightModuleId={initialModuleId ?? null} />
            </section>
          )}

          {/* Nhóm: Tải lên thủ công */}
          {uploads.length > 0 && (
            <section id={!initialModuleId || exports.some((f) => f.moduleId === initialModuleId) ? undefined : `files-module-${initialModuleId}`}
              style={initialModuleId && !exports.some((f) => f.moduleId === initialModuleId) && uploads.some((f) => f.moduleId === initialModuleId)
                ? { outline: "2px solid var(--accent)", outlineOffset: 4, borderRadius: "var(--radius)", padding: "4px 0" }
                : undefined}>
              <h2 style={{ marginTop: exports.length ? 32 : 24 }}>
                Tải lên thủ công{" "}
                <span className="muted small">({uploads.length})</span>
              </h2>
              <FileTable files={uploads} onDelete={handleDelete} highlightModuleId={initialModuleId ?? null} />
            </section>
          )}
        </>
      )}

      {open && (
        <Modal
          title="Tải tài liệu lên"
          onClose={() => {
            setOpen(false);
            setFile(null);
          }}
          footer={
            <>
              <Btn
                onClick={() => {
                  setOpen(false);
                  setFile(null);
                }}
              >
                Hủy
              </Btn>
              <Btn
                kind="primary"
                disabled={!file}
                onClick={handleConfirmUpload}
                data-testid="confirm-upload"
              >
                Xác nhận
              </Btn>
            </>
          }
        >
          <Field
            label="Chọn file từ máy tính"
            hint="Định dạng hỗ trợ: .docx, .xlsx, .pptx, .pdf, .png, .jpg, .jpeg, .txt, .md, .csv (tối đa 10MB)"
          >
            <input
              type="file"
              accept=".docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.txt,.md,.csv"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
              }}
              data-testid="file-input"
            />
          </Field>
          {file && (
            <div className="muted small" style={{ marginTop: 8 }}>
              Đã chọn: <strong>{file.name}</strong> ({fmtSize(file.size)})
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/** Bảng danh sách file có nút tải về và xóa. */
function FileTable({
  files,
  onDelete,
  highlightModuleId,
}: {
  files: FileRecord[];
  onDelete: (f: FileRecord) => void;
  highlightModuleId?: string | null;
}) {
  return (
    <table className="tbl" data-testid="files-table">
      <thead>
        <tr>
          <th style={{ width: 32 }} />
          <th>Tên file</th>
          <th>Kích thước</th>
          <th>Ngày lưu</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {files.map((f) => (
          <tr key={f.id}
            style={highlightModuleId && f.moduleId === highlightModuleId
              ? { background: "var(--accent-soft)" }
              : undefined}>
            <td className="muted" style={{ fontSize: 18, textAlign: "center" }}>
              <FileIcon mime={f.mime} />
            </td>
            <td>
              {/* Nhấn tên file → tải về */}
              <button
                className="link"
                onClick={() => downloadFile(f.id, f.name)}
                data-testid={`dl-${f.id}`}
                title="Tải về"
              >
                {f.name}
              </button>
            </td>
            <td className="muted small nowrap">{fmtSize(f.size)}</td>
            <td className="muted small nowrap">{fmtDate(f.createdAt)}</td>
            <td className="right nowrap">
              <Btn
                size="sm"
                onClick={() => downloadFile(f.id, f.name)}
                data-testid={`dl-btn-${f.id}`}
              >
                ⤓ Tải về
              </Btn>{" "}
              <button
                className="link-danger"
                onClick={() => onDelete(f)}
                data-testid={`del-${f.id}`}
              >
                Xóa
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
