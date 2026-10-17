// Kiểm thử tích hợp: chạy server thật (DB trong bộ nhớ) và đi trọn luồng nghiệp vụ.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import JSZip from "jszip";

let server: Server;
let base = "";
let fakeClaude: Server;
const claudeCalls: any[] = [];
let tmpUploadDir = "";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data: data as any };
}

before(async () => {
  tmpUploadDir = mkdtempSync(join(tmpdir(), "ba-test-api-uploads-"));
  process.env.UPLOAD_DIR = tmpUploadDir;
  delete process.env.ANTHROPIC_API_KEY;
  openDb(":memory:");
  server = createApp({ publicDir: process.cwd() + "/public" });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  fakeClaude?.close();
  if (tmpUploadDir && existsSync(tmpUploadDir)) {
    try {
      rmSync(tmpUploadDir, { recursive: true, force: true });
    } catch {}
  }
  delete process.env.UPLOAD_DIR;
});

test("luồng end-to-end (mock): dự án → màn hình → khoanh vùng + bình luận → sửa → duyệt → tài liệu → test → xuất file", async () => {
  const p = await api("POST", "/api/projects", { name: "Luận án demo" });
  assert.equal(p.status, 200);
  const m = await api("POST", `/api/projects/${p.data.id}/modules`, { name: "Xác thực", requirementInput: "As a Khách hàng, I want đăng nhập để mua hàng" });
  const mid = m.data.id;

  const s = await api("POST", `/api/modules/${mid}/screens`, { prompt: "Màn hình đăng nhập bằng email và mật khẩu (bắt buộc, mật khẩu tối thiểu 8 ký tự, email tối đa 100 ký tự), nút Đăng nhập", name: "Đăng nhập" });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const sid = s.data.screen.id;

  // BR-01: chưa duyệt thì không sinh tài liệu
  const early = await api("POST", `/api/modules/${mid}/docs/generate`);
  assert.equal(early.status, 400);
  assert.match(early.data.error, /BR-01/);

  // Khoanh vùng nút đăng nhập + bình luận
  const ann = await api("POST", `/api/screens/${sid}/annotations`, { nodeIds: ["btn_login"], comment: 'Đổi chữ thành "Vào hệ thống"', bbox: { x: 1, y: 2, w: 3, h: 4 } });
  assert.equal(ann.status, 200);
  const edit = await api("POST", `/api/screens/${sid}/edit`, { prompt: "", nodeIds: [], annotationIds: [ann.data.id] });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(edit.data.version.scope, "region");
  assert.deepEqual(edit.data.version.selectedIds, ["btn_login"]);

  let detail = await api("GET", `/api/modules/${mid}`);
  const btn = JSON.stringify(detail.data.screens[0].tree);
  assert.ok(btn.includes("Vào hệ thống"));
  assert.equal(detail.data.annotations[0].status, "sent");

  // Phiên bản + khôi phục
  const versions = await api("GET", `/api/screens/${sid}/versions`);
  assert.equal(versions.data.length, 2);
  const rv = await api("POST", `/api/screens/${sid}/revert`, { versionId: versions.data[1].id });
  assert.equal(rv.data.number, 3);

  await api("POST", `/api/screens/${sid}/approve`, {});
  const docs = await api("POST", `/api/modules/${mid}/docs/generate`);
  assert.equal(docs.status, 200, JSON.stringify(docs.data));
  assert.ok(docs.data.useCases.length >= 1);
  assert.ok(docs.data.srs.sections.length === 7);
  assert.equal(docs.data.sequences.length, docs.data.useCases.length);

  // Test case cần tài liệu đã duyệt
  assert.equal((await api("POST", `/api/modules/${mid}/tests/generate`)).status, 400);
  const uc = docs.data.useCases[0].code;
  const ref = await api("POST", `/api/modules/${mid}/docs/refine`, { target: uc, instruction: "Bổ sung khóa tài khoản sau 5 lần sai" });
  assert.equal(ref.status, 200);
  await api("POST", `/api/modules/${mid}/docs/approve`, {});
  const tests = await api("POST", `/api/modules/${mid}/tests/generate`);
  assert.equal(tests.status, 200, JSON.stringify(tests.data));
  assert.ok(tests.data.length > 3);

  const tr = await api("GET", `/api/modules/${mid}/trace`);
  assert.equal(tr.data.coverage.flowsWithTests, tr.data.coverage.flowsTotal);

  // BR-02: sửa thiết kế đã duyệt → tài liệu, test chuyển Outdated
  await api("POST", `/api/screens/${sid}/edit`, { prompt: 'Thêm nút "Đăng nhập bằng Google"', nodeIds: ["login_form"], annotationIds: [] });
  detail = await api("GET", `/api/modules/${mid}`);
  assert.equal(detail.data.docsStatus, "outdated");
  assert.equal(detail.data.testsStatus, "outdated");
  assert.equal(detail.data.screens[0].status, "draft");

  const docx = await api("GET", `/api/modules/${mid}/export/docx`);
  assert.equal(docx.status, 200);
  const dz = await JSZip.loadAsync(docx.data);
  assert.ok((await dz.file("word/document.xml")!.async("string")).includes(uc));
  const xlsx = await api("GET", `/api/modules/${mid}/export/xlsx`);
  const xz = await JSZip.loadAsync(xlsx.data);
  assert.ok((await xz.file("xl/worksheets/sheet1.xml")!.async("string")).includes("TC-001"));

  const runs = await api("GET", `/api/modules/${mid}/runs`);
  assert.ok(runs.data.length >= 6);
});

test("đường gọi Claude thật: tool use, tự sửa khi kết quả sai schema, ghi log token", async () => {
  // Giả lập Claude API: lần 1 trả cây sai (gốc không phải Page), lần 2 trả đúng
  fakeClaude = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    claudeCalls.push({ headers: req.headers, body: parsed });
    const good = claudeCalls.length > 1;
    const tree = good
      ? { id: "page", type: "Page", props: { title: "Từ Claude" }, children: [{ id: "h", type: "Heading", props: { text: "Xin chào" } }] }
      : { id: "card", type: "Card", props: {} };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "tool_use", id: `tu_${claudeCalls.length}`, name: "submit_screen", input: { name: "Chào", tree } }], usage: { input_tokens: 100, output_tokens: 50 } }));
  });
  await new Promise<void>((r) => fakeClaude.listen(0, r));
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(fakeClaude.address() as AddressInfo).port}`;
  try {
    const p = await api("POST", "/api/projects", { name: "P2" });
    const m = await api("POST", `/api/projects/${p.data.id}/modules`, { name: "M2" });
    const s = await api("POST", `/api/modules/${m.data.id}/screens`, { prompt: "Trang chào", name: "" });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.screen.name, "Chào");
    assert.equal(claudeCalls.length, 2);
    assert.equal(claudeCalls[0].headers["x-api-key"], "sk-test");
    assert.deepEqual(claudeCalls[0].body.tool_choice, { type: "tool", name: "submit_screen" });
    const second = claudeCalls[1].body.messages.at(-1).content[0];
    assert.equal(second.type, "tool_result");
    assert.equal(second.is_error, true);
    const runs = await api("GET", `/api/modules/${m.data.id}/runs`);
    assert.equal(runs.data[0].provider, "claude");
    assert.equal(runs.data[0].inputTokens, 200);
    assert.match(runs.data[0].error, /tự sửa/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
  }
});

test("gợi ý thành phần: lấy gợi ý, ghi event, thống kê, học khi duyệt", async () => {
  const p = await api("POST", "/api/projects", { name: "Gợi ý" });
  const m = await api("POST", `/api/projects/${p.data.id}/modules`, { name: "Sản phẩm" });
  const s = await api("POST", `/api/modules/${m.data.id}/screens`, { prompt: "Form thêm sản phẩm: tên, giá; nút Lưu", name: "Thêm sản phẩm" });
  const sid = s.data.screen.id;
  const r = await api("GET", `/api/screens/${sid}/suggestions`);
  assert.equal(r.status, 200);
  assert.ok(r.data.suggestions.length >= 1);
  assert.ok(r.data.model.trees >= 1);
  const first = r.data.suggestions[0];
  const region = await api("GET", `/api/screens/${sid}/suggestions?nodeIds=${encodeURIComponent(first.targetNodeId)}`);
  assert.equal(region.status, 200);

  for (const action of ["shown", "shown", "applied", "dismissed"])
    assert.equal((await api("POST", "/api/suggestions/events", { screenId: sid, versionId: r.data.versionId, kind: first.kind, targetNodeId: first.targetNodeId, title: first.title, confidence: first.confidence, action })).status, 200);
  assert.equal((await api("POST", "/api/suggestions/events", { screenId: sid, action: "bad" })).status, 400);
  const st = await api("GET", `/api/modules/${m.data.id}/suggestion-stats`);
  assert.equal(st.data.shown, 2);
  assert.equal(st.data.applied, 1);
  assert.equal(st.data.acceptanceRate, 0.5);

  const before = r.data.model.learned;
  await api("POST", `/api/screens/${sid}/approve`, { approved: true });
  await api("POST", `/api/screens/${sid}/approve`, { approved: true }); // duyệt lại cùng phiên bản → không học trùng
  const after = await api("GET", `/api/screens/${sid}/suggestions`);
  assert.equal(after.data.model.learned, before + 1);
});
