// Quản lý và lưu trữ file cho Kho tài liệu (thao tác đĩa + validate).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { BizError } from "./service.ts";
import * as repo from "./repo.ts";
import type { FileRecord } from "../shared/types.ts";

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export const EXT_TO_MIME: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

/** Lấy đường dẫn thư mục upload; đọc env mỗi lần gọi để test có thể đổi. */
export function uploadDir(): string {
  const dir = process.env.UPLOAD_DIR ?? join(dirname(process.env.DB_FILE ?? "data/ba-copilot.db"), "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Làm sạch tên file, loại bỏ đường dẫn, dấu nháy và ký tự điều khiển. */
export function cleanName(name: string): string {
  if (typeof name !== "string") throw new BizError("Tên file không hợp lệ");
  let s = name.replace(/^.*[/\\]/, "").replace(/[/\\]/g, "");
  s = s.replace(/["']/g, "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (s === "." || s === "..") throw new BizError("Tên file không hợp lệ");
  s = s.slice(0, 150).trim();
  if (!s) throw new BizError("Tên file không được để trống");
  return s;
}

/** Kiểm tra chữ ký (magic bytes) của file theo đuôi. */
export function checkSignature(ext: string, buf: Buffer): boolean {
  const e = ext.toLowerCase();
  if (e === ".docx" || e === ".xlsx" || e === ".pptx") {
    if (buf.length < 2 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new BizError(`Nội dung file không đúng định dạng ${ext} (thiếu chữ ký PK)`);
    }
    return true;
  }
  if (e === ".pdf") {
    if (buf.length < 4 || buf.toString("ascii", 0, 4) !== "%PDF") {
      throw new BizError("Nội dung file không đúng định dạng .pdf (thiếu chữ ký %PDF)");
    }
    return true;
  }
  if (e === ".png") {
    if (buf.length < 4 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      throw new BizError("Nội dung file không đúng định dạng .png (thiếu chữ ký PNG)");
    }
    return true;
  }
  if (e === ".jpg" || e === ".jpeg") {
    if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
      throw new BizError("Nội dung file không đúng định dạng JPEG (thiếu chữ ký JFIF)");
    }
    return true;
  }
  // Các đuôi còn lại (.txt, .md, .csv) bỏ qua kiểm tra chữ ký nhị phân
  return true;
}

/** Resolve và kiểm tra an toàn đường dẫn file nằm trong uploadDir (chống path traversal). */
function resolveSafePath(storedName: string): string {
  const root = resolve(uploadDir());
  const target = resolve(root, storedName);
  if (!target.startsWith(root + sep) && target !== root) {
    throw new BizError("Đường dẫn file không hợp lệ (path traversal)");
  }
  return target;
}

export function saveFileToDisk(id: string, ext: string, buf: Buffer): string {
  const storedName = `${id}${ext}`;
  const target = resolveSafePath(storedName);
  writeFileSync(target, buf);
  return storedName;
}

export function readFileFromDisk(storedName: string): Buffer | null {
  const target = resolveSafePath(storedName);
  if (!existsSync(target)) return null;
  return readFileSync(target);
}

export function removeFileFromDisk(storedName: string): void {
  const target = resolveSafePath(storedName);
  if (existsSync(target)) {
    try {
      unlinkSync(target);
    } catch {
      // bỏ qua lỗi nếu không xóa được
    }
  }
}

/** Lưu buffer vào đĩa và ghi DB dòng FileRecord (dùng chung cho upload và export). */
export function saveBuffer(
  projectId: string,
  moduleId: string | null,
  name: string,
  buf: Buffer,
  source: "upload" | "export",
): FileRecord {
  const cName = cleanName(name);
  const ext = extname(cName).toLowerCase();
  if (!EXT_TO_MIME[ext]) {
    throw new BizError(`Định dạng file không được hỗ trợ: ${ext || "(không có đuôi)"}`);
  }
  if (!buf || buf.length === 0) {
    throw new BizError("Nội dung file rỗng");
  }
  if (buf.length > MAX_FILE_BYTES) {
    throw new BizError("Kích thước file vượt quá giới hạn 10MB");
  }
  checkSignature(ext, buf);

  const id = randomUUID();
  const storedName = saveFileToDisk(id, ext, buf);
  const mime = EXT_TO_MIME[ext];
  return repo.createFile({
    id,
    projectId,
    moduleId,
    name: cName,
    storedName,
    mime,
    size: buf.length,
    source,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Tự động lưu bản xuất Word/Excel vào Kho tài liệu.
 * Quy ước: mỗi module chỉ giữ bản xuất MỚI NHẤT cho mỗi loại file.
 * Nếu đã có bản export cùng (project, module, tên file) thì xóa bản cũ (dòng DB + file trên đĩa) rồi lưu bản mới.
 * Bọc toàn bộ trong try/catch: nếu lưu vào kho thất bại thì console.error rồi bỏ qua,
 * TUYỆT ĐỐI không làm hỏng việc tải file về của người dùng.
 */
export function saveExport(
  projectId: string,
  moduleId: string,
  name: string,
  buf: Buffer,
  _mime?: string,
): FileRecord | null {
  try {
    const cName = cleanName(name);
    // Kiểm tra nếu đã có bản export cùng (project, module, tên file) thì xóa bản cũ
    const old = repo.findExportFile(projectId, moduleId, cName);
    if (old) {
      removeFileFromDisk(old.storedName);
      repo.deleteFileRow(old.id);
    }
    return saveBuffer(projectId, moduleId, cName, buf, "export");
  } catch (err) {
    console.error("Lỗi khi tự lưu file xuất vào kho tài liệu:", err);
    return null;
  }
}

