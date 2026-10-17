// Kiểm thử tích hợp cho Kho tài liệu (upload, download, validation, chống path traversal).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db.ts";
import { createApp } from "../server/app.ts";

let server: Server;
let base = "";
let tmpUploadDir = "";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, data: data as any };
}

before(async () => {
  tmpUploadDir = mkdtempSync(join(tmpdir(), "ba-test-uploads-"));
  process.env.UPLOAD_DIR = tmpUploadDir;
  openDb(":memory:");
  server = createApp({ publicDir: process.cwd() + "/public" });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  if (tmpUploadDir && existsSync(tmpUploadDir)) {
    try {
      rmSync(tmpUploadDir, { recursive: true, force: true });
    } catch {}
  }
  delete process.env.UPLOAD_DIR;
});

test("kho tài liệu: upload docx hợp lệ -> liệt kê -> tải xuống -> xóa -> 404", async () => {
  // 1. Tạo dự án
  const p = await api("POST", "/api/projects", { name: "Dự án test kho tài liệu" });
  assert.equal(p.status, 200);
  const projectId = p.data.id;

  // 2. Upload file docx hợp lệ (chữ ký PK)
  const fakeDocxContent = Buffer.from("PK\x03\x04Hello Word Document");
  const uploadRes = await api("POST", `/api/projects/${projectId}/files`, {
    name: "Tai_Lieu_SRS.docx",
    contentBase64: fakeDocxContent.toString("base64"),
  });
  assert.equal(uploadRes.status, 200, JSON.stringify(uploadRes.data));
  assert.equal(uploadRes.data.name, "Tai_Lieu_SRS.docx");
  assert.equal(uploadRes.data.mime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(uploadRes.data.size, fakeDocxContent.length);
  assert.equal(uploadRes.data.source, "upload");
  const fileId = uploadRes.data.id;

  // 3. Liệt kê danh sách file của dự án
  const listRes = await api("GET", `/api/projects/${projectId}/files`);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.data.length, 1);
  assert.equal(listRes.data[0].id, fileId);

  // 4. Tải xuống đúng nội dung
  const dlRes = await api("GET", `/api/files/${fileId}/download`);
  assert.equal(dlRes.status, 200);
  assert.equal(Buffer.compare(dlRes.data, fakeDocxContent), 0);

  // 5. Xóa file
  const delRes = await api("DELETE", `/api/files/${fileId}`);
  assert.equal(delRes.status, 200);

  // 6. Tải lại ra 404
  const dlAgain = await api("GET", `/api/files/${fileId}/download`);
  assert.equal(dlAgain.status, 404);

  // Danh sách cũng rỗng
  const listEmpty = await api("GET", `/api/projects/${projectId}/files`);
  assert.equal(listEmpty.data.length, 0);
});

test("kho tài liệu: từ chối đuôi không cho phép (.exe)", async () => {
  const p = await api("POST", "/api/projects", { name: "Dự án test đuôi exe" });
  const fakeExe = Buffer.from("MZ\x90\x00malicious-program");
  const res = await api("POST", `/api/projects/${p.data.id}/files`, {
    name: "tool.exe",
    contentBase64: fakeExe.toString("base64"),
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /không được hỗ trợ/);
});

test("kho tài liệu: từ chối file vượt quá 10MB", async () => {
  const p = await api("POST", "/api/projects", { name: "Dự án test size lớn" });
  const bigBuf = Buffer.alloc(10 * 1024 * 1024 + 10);
  bigBuf[0] = 0x50; // 'P'
  bigBuf[1] = 0x4b; // 'K'
  const res = await api("POST", `/api/projects/${p.data.id}/files`, {
    name: "giant.docx",
    contentBase64: bigBuf.toString("base64"),
  });
  assert.ok(res.status === 400 || res.status === 413, `Status was ${res.status}`);
  assert.match(res.data.error, /10MB|quá lớn/);
});

test("kho tài liệu: từ chối chữ ký sai (tên .pdf nhưng nội dung không phải PDF)", async () => {
  const p = await api("POST", "/api/projects", { name: "Dự án test signature" });
  const fakePdf = Buffer.from("THIS IS NOT A VALID PDF FILE");
  const res = await api("POST", `/api/projects/${p.data.id}/files`, {
    name: "gia_mao.pdf",
    contentBase64: fakePdf.toString("base64"),
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /chữ ký %PDF/);
});

test("kho tài liệu: từ chối moduleId của dự án khác", async () => {
  const p1 = await api("POST", "/api/projects", { name: "Dự án 1" });
  const p2 = await api("POST", "/api/projects", { name: "Dự án 2" });
  const m2 = await api("POST", `/api/projects/${p2.data.id}/modules`, { name: "Module của D2" });

  const fakePdf = Buffer.from("%PDF-1.4\nvalid pdf content");
  const res = await api("POST", `/api/projects/${p1.data.id}/files`, {
    name: "tai_lieu.pdf",
    moduleId: m2.data.id,
    contentBase64: fakePdf.toString("base64"),
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Module không thuộc dự án/);
});

test("kho tài liệu: tên file chứa '../' bị làm sạch và không ghi ra ngoài uploadDir", async () => {
  const p = await api("POST", "/api/projects", { name: "Dự án test path traversal" });
  const fakeDocx = Buffer.from("PK\x03\x04safe content");
  const res = await api("POST", `/api/projects/${p.data.id}/files`, {
    name: "../../../etc/passwd.docx",
    contentBase64: fakeDocx.toString("base64"),
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.name, "passwd.docx");
  assert.ok(!res.data.name.includes("/"));
  assert.ok(!res.data.name.includes("\\"));
  assert.ok(!res.data.name.includes(".."));

  const dl = await api("GET", `/api/files/${res.data.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(Buffer.compare(dl.data, fakeDocx), 0);
});

test("tự lưu bản xuất Word/Excel vào kho tài liệu và thay thế bản cũ", async () => {
  // 1. Tạo dự án -> module -> màn hình -> duyệt màn hình -> sinh tài liệu -> duyệt tài liệu -> sinh test
  const p = await api("POST", "/api/projects", { name: "Dự án xuất file tự lưu" });
  assert.equal(p.status, 200);
  const pid = p.data.id;

  const m = await api("POST", `/api/projects/${pid}/modules`, {
    name: "Quản lý kho",
    requirementInput: "As a Thủ kho, I want kiểm kê hàng hóa",
  });
  assert.equal(m.status, 200);
  const mid = m.data.id;

  const s = await api("POST", `/api/modules/${mid}/screens`, {
    prompt: "Màn hình kiểm kê hàng hóa gồm bảng danh sách và nút Lưu",
    name: "Kiểm kê",
  });
  assert.equal(s.status, 200);
  const sid = s.data.screen.id;

  // Duyệt màn hình
  await api("POST", `/api/screens/${sid}/approve`, {});

  // Sinh tài liệu và duyệt tài liệu
  const docsRes = await api("POST", `/api/modules/${mid}/docs/generate`);
  assert.equal(docsRes.status, 200);
  await api("POST", `/api/modules/${mid}/docs/approve`, {});

  // Sinh test
  const testRes = await api("POST", `/api/modules/${mid}/tests/generate`);
  assert.equal(testRes.status, 200);

  // 2. Gọi export/docx -> GET /api/projects/:id/files phải có đúng 1 file source "export", moduleId đúng, tên kết thúc .docx, tải xuống ra nội dung giống file export trả về
  const docxExport1 = await api("GET", `/api/modules/${mid}/export/docx`);
  assert.equal(docxExport1.status, 200);
  assert.ok(docxExport1.data instanceof Buffer);

  const filesAfterDocx1 = await api("GET", `/api/projects/${pid}/files`);
  assert.equal(filesAfterDocx1.status, 200);
  const exportDocs1 = filesAfterDocx1.data.filter((f: any) => f.source === "export");
  assert.equal(exportDocs1.length, 1);
  assert.equal(exportDocs1[0].moduleId, mid);
  assert.ok(exportDocs1[0].name.endsWith(".docx"));

  const dlDocx1 = await api("GET", `/api/files/${exportDocs1[0].id}/download`);
  assert.equal(dlDocx1.status, 200);
  assert.equal(Buffer.compare(dlDocx1.data, docxExport1.data), 0);

  // 3. Gọi export/docx lần 2 -> vẫn đúng 1 file docx (bản cũ bị thay thế)
  const docxExport2 = await api("GET", `/api/modules/${mid}/export/docx`);
  assert.equal(docxExport2.status, 200);

  const filesAfterDocx2 = await api("GET", `/api/projects/${pid}/files`);
  assert.equal(filesAfterDocx2.status, 200);
  const exportDocs2 = filesAfterDocx2.data.filter((f: any) => f.source === "export" && f.name.endsWith(".docx"));
  assert.equal(exportDocs2.length, 1);

  // 4. Gọi export/xlsx -> có thêm 1 file .xlsx (tổng 2 file export)
  const xlsxExport = await api("GET", `/api/modules/${mid}/export/xlsx`);
  assert.equal(xlsxExport.status, 200);

  const filesAfterXlsx = await api("GET", `/api/projects/${pid}/files`);
  assert.equal(filesAfterXlsx.status, 200);
  const allExports = filesAfterXlsx.data.filter((f: any) => f.source === "export");
  assert.equal(allExports.length, 2);
  assert.ok(allExports.some((f: any) => f.name.endsWith(".xlsx")));
  assert.ok(allExports.some((f: any) => f.name.endsWith(".docx")));

  // 5. Xóa module hoặc xóa file không làm hỏng export lần sau
  // Xóa 1 file export
  const fileToDelete = allExports[0];
  const delRes = await api("DELETE", `/api/files/${fileToDelete.id}`);
  assert.equal(delRes.status, 200);

  // Xuất lại file đó -> vẫn thành công
  const docxExportAgain = await api("GET", `/api/modules/${mid}/export/docx`);
  assert.equal(docxExportAgain.status, 200);

  // Xóa module
  const delModRes = await api("DELETE", `/api/modules/${mid}`);
  assert.equal(delModRes.status, 200);

  // Tạo module mới trong cùng dự án, làm luồng và xuất tiếp
  const mNew = await api("POST", `/api/projects/${pid}/modules`, { name: "Module mới" });
  assert.equal(mNew.status, 200);
  const sNew = await api("POST", `/api/modules/${mNew.data.id}/screens`, { prompt: "Màn hình mới", name: "Màn hình 1" });
  await api("POST", `/api/screens/${sNew.data.screen.id}/approve`, {});
  await api("POST", `/api/modules/${mNew.data.id}/docs/generate`);
  const docxNew = await api("GET", `/api/modules/${mNew.data.id}/export/docx`);
  assert.equal(docxNew.status, 200);
});

