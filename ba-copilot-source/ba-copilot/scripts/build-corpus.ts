// Sinh corpus nội bộ cho mô hình gợi ý thành phần: ~150 màn hình nghiệp vụ.
// Mặc định dùng bộ sinh rule-based (mockScreen). Thêm --llm để gọi Claude thật (cần ANTHROPIC_API_KEY).
// Dùng: npm run build-corpus -- [--llm] [--out data/corpus/internal.jsonl]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mockScreen } from "../server/ai/mock.ts";

const root = join(import.meta.dirname, "..");
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};
const useLlm = process.argv.includes("--llm");
const out = arg("--out", join(root, "data", "corpus", "internal.jsonl"));

const DOMAINS = ["sản phẩm", "đơn hàng", "khách hàng", "nhân viên", "kho hàng", "nhà cung cấp", "hóa đơn", "hợp đồng", "phiếu nhập", "khuyến mãi", "danh mục", "báo cáo doanh thu", "yêu cầu nghỉ phép", "dự án", "công việc", "tài sản", "ca làm việc", "phiếu bảo hành", "lịch hẹn", "khóa học"];
const SHAPES = [
  (d: string) => `Màn hình quản lý ${d}: tìm kiếm, lọc theo trạng thái, bảng danh sách có sửa/xóa, nút thêm mới, phân trang.`,
  (d: string) => `Form thêm ${d}: các trường thông tin chính, ngày hiệu lực, ghi chú; nút Lưu và Hủy.`,
  (d: string) => `Form chỉnh sửa ${d} với các trường bắt buộc và nút Cập nhật.`,
  (d: string) => `Danh sách ${d} chờ phê duyệt, có nút duyệt và từ chối.`,
  (d: string) => `Tra cứu ${d} theo mã và khoảng thời gian, hiển thị bảng kết quả.`,
  (d: string) => `Danh sách ${d} có tìm kiếm theo tên và xuất Excel.`,
  (d: string) => `Tạo ${d} mới gồm thông tin chung, người phụ trách và mô tả.`,
];
const SINGLE = [
  "Màn hình đăng nhập bằng email và mật khẩu, có ghi nhớ đăng nhập và quên mật khẩu.",
  "Màn hình đăng ký tài khoản: họ tên, email, số điện thoại, mật khẩu, xác nhận mật khẩu.",
  "Màn hình quên mật khẩu: nhập email để nhận liên kết đặt lại.",
  "Dashboard tổng quan cho quản trị viên: chỉ số doanh thu, đơn hàng, khách hàng mới và bảng đơn gần đây.",
  "Trang hồ sơ cá nhân: ảnh đại diện, thông tin liên hệ, nút cập nhật.",
  "Trang cài đặt hệ thống: ngôn ngữ, múi giờ, thông báo email.",
  "Giỏ hàng: bảng sản phẩm đã chọn, số lượng, tổng tiền, nút thanh toán.",
  "Màn hình thanh toán: địa chỉ giao hàng, phương thức thanh toán, nút đặt hàng.",
];
const prompts = [...SINGLE, ...DOMAINS.flatMap((d) => SHAPES.map((f) => f(d)))].slice(0, 150);

let generate: ((p: string, name: string) => Promise<unknown>) | null = null;
if (useLlm) {
  const envFile = join(root, ".env");
  if (existsSync(envFile))
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  const { openDb } = await import("../server/db.ts");
  const ai = await import("../server/ai/pipelines.ts");
  openDb(process.env.DB_FILE ?? join(root, "data", "ba-copilot.db"));
  generate = async (prompt, name) => (await ai.generateScreen({ moduleId: "", prompt, name, requirementInput: "", otherScreens: [] })).tree;
}

mkdirSync(dirname(out), { recursive: true });
const lines: string[] = [];
for (const [i, p] of prompts.entries()) {
  const name = p.split(":")[0].replace(/^(Màn hình|Form|Trang)\s+/i, "").slice(0, 40);
  try {
    const tree = generate ? await generate(p, name) : mockScreen(p, name, { mode: "template" });
    lines.push(JSON.stringify({ source: "internal", prompt: p, tree }));
  } catch (e) {
    console.warn(`Bỏ qua prompt ${i}: ${(e as Error).message}`);
  }
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(`Đã ghi ${lines.length} cây (${useLlm ? "Claude" : "rule-based"}) → ${out}`);
