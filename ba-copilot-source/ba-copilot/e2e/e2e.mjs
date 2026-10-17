// E2E: chạy trình duyệt thật qua toàn bộ luồng BA bằng giao diện (chế độ Mock, DB tạm).
// Dùng: npm run e2e   (tự khởi động server ở cổng 3199)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.E2E_PORT ?? "3199";
const BASE = process.env.E2E_BASE ?? `http://localhost:${PORT}`;
const SHOTS = "e2e/screenshots";
mkdirSync(SHOTS, { recursive: true });

let server;
if (!process.env.E2E_BASE) {
  const db = join(tmpdir(), `ba-e2e-${Date.now()}.db`);
  server = spawn("npx", ["tsx", "server/index.ts"], { env: { ...process.env, PORT, DB_FILE: db, AI_MODE: "mock" }, stdio: "inherit", detached: true });
  process.on("exit", () => {
    try {
      process.kill(-server.pid);
    } catch {}
    rmSync(db, { force: true });
  });
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${BASE}/api/settings`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("dialog", (d) => d.accept());

let step = 0;
const shot = async (name) => page.screenshot({ path: `${SHOTS}/${String(++step).padStart(2, "0")}-${name}.png` });
const check = (cond, msg) => {
  if (!cond) throw new Error("E2E thất bại: " + msg);
  console.log("  ✓ " + msg);
};

try {
  await page.goto(BASE);
  await page.getByTestId("new-project").click();
  await page.getByPlaceholder("VD: Hệ thống bán hàng online").fill("Cửa hàng online");
  await page.getByTestId("create-project").click();
  await page.getByTestId("new-module").click();
  await page.getByPlaceholder("VD: Xác thực người dùng").fill("Xác thực");
  await page.getByText("Dùng ví dụ mẫu").click();
  await page.getByTestId("create-module").click();
  await page.waitForURL(/#\/m\/.+\/design/);
  check(true, "tạo dự án và module");

  // Sinh 2 màn hình
  await page.getByTestId("new-screen").click();
  await page.getByTestId("screen-name").fill("Đăng nhập");
  await page.getByTestId("screen-prompt").fill("Màn hình đăng nhập bằng email và mật khẩu, nút Đăng nhập, có quên mật khẩu và link đăng ký");
  await page.getByTestId("generate-screen").click();
  await page.locator('[data-node-id="btn_login"]').waitFor();
  check(true, "AI sinh màn hình Đăng nhập");
  await page.getByTestId("new-screen").click();
  await page.getByTestId("screen-name").fill("Trang chủ");
  await page.getByTestId("screen-prompt").fill("Trang chủ tổng quan cho khách hàng");
  await page.getByTestId("generate-screen").click();
  await page.locator('[data-node-id="stats"]').waitFor();
  await page.locator(".screen-item", { hasText: "Đăng nhập" }).click();
  await page.locator('[data-node-id="btn_login"]').waitFor();
  await shot("design-generated");

  // Khoanh vùng bằng click
  await page.locator('[data-node-id="btn_login"]').click();
  check((await page.getByTestId("selection").innerText()).includes("Đăng nhập"), "chọn phần tử bằng click");
  await page.getByTestId("comment-input").fill('Đổi chữ thành "Vào hệ thống"');
  await page.getByTestId("add-comment").click();
  await page.locator(".pin").first().waitFor();
  check(await page.getByTestId("ann-check").first().isChecked(), "bình luận mới được tick sẵn để gửi vào prompt");
  await shot("annotated");

  // Khoanh vùng bằng kéo khung quanh ô mật khẩu
  await page.getByTestId("mode-region").click();
  const pwd = await page.locator('[data-node-id="password"]').boundingBox();
  await page.mouse.move(pwd.x - 6, pwd.y - 6);
  await page.mouse.down();
  await page.mouse.move(pwd.x + pwd.width + 6, pwd.y + pwd.height + 6, { steps: 8 });
  await page.mouse.up();
  const sel = await page.getByTestId("selection").innerText();
  check(sel.includes("Mật khẩu") && !sel.includes("Vào hệ thống"), "kéo khung chọn đúng ô Mật khẩu (thay vùng chọn cũ)");

  // Gửi bình luận + vùng chọn hiện tại → AI sửa
  await page.getByTestId("mode-select").click();
  await page.locator('[data-node-id="btn_login"]').click();
  await page.getByTestId("apply-edit").click();
  await page.locator('[data-node-id="btn_login"]', { hasText: "Vào hệ thống" }).waitFor();
  check(true, "gửi bình luận vào prompt → AI sửa đúng vùng");
  await page.waitForTimeout(300);
  await shot("edited-region");

  // Prompt sửa thêm nút trong form
  await page.locator('[data-node-id="login_form"]').click({ position: { x: 5, y: 5 } });
  await page.getByTestId("edit-prompt").fill('Thêm nút "Đăng nhập bằng Google"');
  await page.getByTestId("apply-edit").click();
  await page.getByText("Đăng nhập bằng Google").first().waitFor();
  check(true, "prompt sửa thêm phần tử trong vùng");
  await page.getByTestId("versions-tab").click();
  check((await page.locator(".ver").count()) === 3, "lịch sử có 3 phiên bản");
  await shot("versions");

  // Duyệt cả 2 màn hình
  await page.getByTestId("approve-screen").click();
  await page.locator(".screen-item", { hasText: "Trang chủ" }).click();
  await page.getByTestId("approve-screen").click();
  await page.waitForTimeout(300);

  // Tài liệu
  await page.getByTestId("tab-docs").click();
  await page.getByTestId("generate-docs").click();
  await page.locator(".paper h2").first().waitFor();
  check((await page.locator(".doc-nav button").count()) >= 2, "sinh danh sách Use Case");
  await shot("docs-uc");
  await page.getByTestId("docs-srs").click();
  await page.locator(".paper .md").waitFor();
  await shot("docs-srs");
  await page.getByTestId("docs-seq").click();
  await page.locator(".mermaid-svg svg").waitFor({ timeout: 15000 });
  check(true, "render sequence diagram bằng Mermaid");
  await shot("docs-sequence");
  await page.getByTestId("refine-input").fill("Thêm bước ghi log đăng nhập");
  await page.getByTestId("refine-btn").click();
  await page.waitForTimeout(500);
  await page.getByTestId("approve-docs").click();
  await page.waitForTimeout(300);
  const dl1 = page.waitForEvent("download");
  await page.getByTestId("export-docx").click();
  check((await dl1).suggestedFilename().endsWith(".docx"), "xuất file Word");

  // Test case
  await page.getByTestId("tab-tests").click();
  await page.getByTestId("generate-tests").click();
  await page.locator(".tbl-tests tbody tr").first().waitFor();
  const n = await page.locator(".tbl-tests tbody tr").count();
  check(n > 5, `sinh ${n} test case`);
  await page.locator(".tbl-tests tbody tr").first().click();
  await shot("tests");
  const dl2 = page.waitForEvent("download");
  await page.getByTestId("export-xlsx").click();
  check((await dl2).suggestedFilename().endsWith(".xlsx"), "xuất file Excel");

  // Truy vết
  await page.getByTestId("tab-trace").click();
  await page.getByTestId("cov-flow").waitFor();
  check((await page.getByTestId("cov-flow").innerText()).includes("100%"), "100% luồng UC có test");
  await shot("trace");

  // BR-02
  await page.getByTestId("tab-design").click();
  await page.locator(".screen-item", { hasText: "Đăng nhập" }).click();
  await page.locator('[data-node-id="remember"]').click();
  await page.getByTestId("edit-prompt").fill("Đổi chữ thành Lưu phiên đăng nhập");
  await page.getByTestId("apply-edit").click();
  await page.locator('[data-node-id="remember"]', { hasText: "Lưu phiên đăng nhập" }).waitFor();
  await page.getByTestId("tab-docs").getByText("Lỗi thời").waitFor({ timeout: 5000 });
  check(true, "BR-02: sửa thiết kế đã duyệt → tài liệu Lỗi thời");
  await page.getByTestId("tab-logs").click();
  await page.locator(".tbl tbody tr").first().waitFor();
  await shot("logs");

  check(errors.length === 0, "không có lỗi JavaScript trên trang" + (errors.length ? ": " + errors.join(" | ") : ""));
  console.log(`\nE2E OK – ảnh chụp trong ${SHOTS}/`);
} catch (e) {
  await shot("FAILED");
  console.error(e.message, errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  process.exit();
}
