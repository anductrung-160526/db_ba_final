// Sinh cây màn hình nghiệp vụ tổng hợp (đầy đủ, đúng quy ước) để bù phần WebSight không có:
// bảng + phân trang, thanh lọc, form thêm/sửa có nút Lưu/Hủy, dashboard chỉ số...
// Mỗi cây = mockScreen(prompt) với prompt ghép ngẫu nhiên từ các mẫu bên dưới (seed cố định).
// Dùng: npm run build-synthetic -- [--n 4000] [--seed 7] [--out data/corpus/synthetic.jsonl]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mockScreen } from "../server/ai/mock.ts";
import { rng } from "./build-next-model.ts";

const root = join(import.meta.dirname, "..");
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};

interface Domain {
  name: string;
  fields: string[];
  cols: string[];
  filters: string[];
}
const DOMAINS: Domain[] = [
  { name: "sản phẩm", fields: ["tên sản phẩm", "mã", "danh mục", "giá bán", "số lượng", "mô tả", "ngày hiệu lực"], cols: ["Mã SP", "Tên sản phẩm", "Danh mục", "Giá bán", "Tồn kho", "Trạng thái"], filters: ["danh mục", "trạng thái"] },
  { name: "nhân viên", fields: ["họ tên", "email", "số điện thoại", "ngày sinh", "giới tính", "địa chỉ", "người phụ trách"], cols: ["Mã NV", "Họ tên", "Email", "Phòng ban", "Chức vụ", "Trạng thái"], filters: ["phòng ban", "chức vụ", "trạng thái"] },
  { name: "khách hàng", fields: ["họ tên", "email", "số điện thoại", "địa chỉ", "ghi chú"], cols: ["Mã KH", "Họ tên", "Email", "Số điện thoại", "Hạng"], filters: ["hạng", "khu vực"] },
  { name: "đơn hàng", fields: ["tên khách hàng", "số lượng", "ngày hiệu lực", "địa chỉ", "ghi chú"], cols: ["Mã đơn", "Khách hàng", "Ngày đặt", "Tổng tiền", "Trạng thái"], filters: ["trạng thái", "khách hàng"] },
  { name: "nhà cung cấp", fields: ["tên nhà cung cấp", "email", "số điện thoại", "địa chỉ", "mô tả"], cols: ["Mã NCC", "Tên", "Liên hệ", "Trạng thái"], filters: ["trạng thái"] },
  { name: "hợp đồng", fields: ["tên hợp đồng", "mã", "ngày hiệu lực", "người phụ trách", "giá bán", "ghi chú"], cols: ["Số HĐ", "Đối tác", "Ngày ký", "Giá trị", "Trạng thái"], filters: ["trạng thái", "người phụ trách"] },
  { name: "dự án", fields: ["tên dự án", "mã", "người phụ trách", "ngày hiệu lực", "mô tả"], cols: ["Mã DA", "Tên dự án", "Phụ trách", "Tiến độ", "Trạng thái"], filters: ["trạng thái", "người phụ trách"] },
  { name: "công việc", fields: ["tên công việc", "người phụ trách", "ngày hiệu lực", "danh mục", "mô tả"], cols: ["Công việc", "Người làm", "Hạn", "Ưu tiên", "Trạng thái"], filters: ["trạng thái", "ưu tiên"] },
  { name: "phiếu nhập", fields: ["mã", "tên nhà cung cấp", "số lượng", "giá bán", "ngày hiệu lực", "ghi chú"], cols: ["Số phiếu", "Nhà cung cấp", "Ngày nhập", "Tổng tiền"], filters: ["kho", "trạng thái"] },
  { name: "khóa học", fields: ["tên khóa học", "mã", "danh mục", "giá bán", "ngày hiệu lực", "mô tả"], cols: ["Mã KH", "Tên khóa học", "Giảng viên", "Học phí", "Trạng thái"], filters: ["danh mục", "giảng viên"] },
  { name: "tài sản", fields: ["tên tài sản", "mã", "danh mục", "người phụ trách", "ngày hiệu lực", "ghi chú"], cols: ["Mã TS", "Tên tài sản", "Loại", "Người dùng", "Tình trạng"], filters: ["loại", "tình trạng"] },
  { name: "yêu cầu nghỉ phép", fields: ["họ tên", "ngày hiệu lực", "danh mục", "mô tả"], cols: ["Nhân viên", "Từ ngày", "Đến ngày", "Loại", "Trạng thái"], filters: ["trạng thái", "loại"] },
];
const ACTS = ["xem/sửa/xóa", "sửa/xóa", "xem"];
const STATS = ["doanh thu", "đơn hàng mới", "khách hàng mới", "tỷ lệ chuyển đổi", "tồn kho", "công việc quá hạn", "nhân viên mới"];

export function synthPrompts(n: number, seed: number): string[] {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const subset = <T,>(a: T[], min: number, max: number) => {
    const k = min + Math.floor(r() * (max - min + 1));
    const idx = a.map((_, i) => i).sort(() => r() - 0.5).slice(0, k).sort((x, y) => x - y);
    return idx.map((i) => a[i]);
  };
  const yes = (p: number) => r() < p;
  const out: string[] = [];
  while (out.length < n) {
    const d = pick(DOMAINS);
    const kind = r();
    if (kind < 0.32) {
      const parts = [`Danh sách ${d.name}`];
      const tools: string[] = [];
      if (yes(0.85)) tools.push("tìm kiếm");
      if (yes(0.7)) tools.push(`lọc theo ${subset(d.filters, 1, 2).join(" và ")}`);
      if (yes(0.25)) tools.push("khoảng thời gian");
      if (tools.length) parts.push(`có ${tools.join(", ")}`);
      parts.push(`bảng cột ${subset(d.cols, 3, 5).join(", ")}`);
      if (yes(0.8)) parts.push(`thao tác ${pick(ACTS)}`);
      const btn = [yes(0.85) ? "Thêm mới" : "", yes(0.3) ? "xuất Excel" : ""].filter(Boolean);
      if (btn.length) parts.push(`nút ${btn.join(" và ")}`);
      if (yes(0.9)) parts.push("phân trang");
      out.push(parts.join(", "));
    } else if (kind < 0.62) {
      const verb = yes(0.65) ? "thêm" : "cập nhật";
      const fs = subset(d.fields, 3, Math.min(6, d.fields.length));
      const req = fs.slice(0, 1 + Math.floor(r() * 2)).join(" và ");
      const extra = yes(0.4) ? `, ${fs[0]} tối đa 100 ký tự` : "";
      const btn = verb === "thêm" ? pick(["Lưu và Hủy", "Lưu và Hủy", "Lưu", "Lưu và Quay lại"]) : pick(["Cập nhật và Hủy", "Cập nhật"]);
      out.push(`Màn hình ${verb} ${d.name} gồm ${fs.join(", ")}. ${req} bắt buộc${extra}. Nút ${btn}`);
    } else if (kind < 0.72) {
      out.push(`Tra cứu ${d.name} theo ${pick(d.filters)} và khoảng thời gian, nút Tìm kiếm, bảng cột ${subset(d.cols, 3, 5).join(", ")}${yes(0.8) ? ", phân trang" : ""}`);
    } else if (kind < 0.8) {
      out.push(`Danh sách ${d.name} chờ duyệt, bảng cột ${subset(d.cols, 3, 5).join(", ")}, thao tác xem, nút Duyệt và Từ chối${yes(0.8) ? ", phân trang" : ""}`);
    } else if (kind < 0.88) {
      out.push(`Trang tổng quan có chỉ số ${subset(STATS, 3, 4).join(", ")} và bảng ${d.name} gần đây cột ${subset(d.cols, 3, 4).join(", ")}${yes(0.6) ? ", phân trang" : ""}`);
    } else {
      out.push(
        pick([
          `Màn hình đăng nhập bằng email và mật khẩu (bắt buộc, mật khẩu tối thiểu 8 ký tự)${yes(0.6) ? ", ghi nhớ đăng nhập" : ""}, nút Đăng nhập${yes(0.7) ? ", có quên mật khẩu" : ""}${yes(0.5) ? " và link đăng ký" : ""}`,
          `Màn hình đăng ký tài khoản gồm họ tên, email, ${yes(0.6) ? "số điện thoại, " : ""}mật khẩu, xác nhận mật khẩu${yes(0.5) ? ", đồng ý điều khoản" : ""}. Tất cả bắt buộc, mật khẩu tối thiểu 8 ký tự. Nút Đăng ký`,
          `Màn hình đổi mật khẩu gồm mật khẩu cũ, mật khẩu mới, xác nhận mật khẩu. Tất cả bắt buộc, tối thiểu 8 ký tự. Nút ${pick(["Đổi mật khẩu", "Lưu và Hủy"])}`,
          `Màn hình hồ sơ cá nhân gồm ${subset(["họ tên", "email", "số điện thoại", "ngày sinh", "giới tính", "địa chỉ"], 3, 6).join(", ")}. Họ tên bắt buộc. Nút Cập nhật`,
          `Màn hình gửi yêu cầu hỗ trợ gồm email, danh mục, mô tả${yes(0.4) ? ", ghi chú" : ""}. Email và mô tả bắt buộc. Nút Gửi`,
        ]),
      );
    }
  }
  return out;
}

if (process.argv[1]?.endsWith("build-synthetic.ts")) {
  const n = Number(arg("--n", "4000"));
  const out = arg("--out", join(root, "data", "corpus", "synthetic.jsonl"));
  const sig = (t: { type: string; props: Record<string, unknown>; children?: unknown[] }): string =>
    t.type + JSON.stringify([t.props.label ?? t.props.text ?? "", t.props.inputType ?? ""]) + (t.children ? "(" + (t.children as never[]).map(sig).join(",") + ")" : "");
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of synthPrompts(n, Number(arg("--seed", "7")))) {
    const tree = mockScreen(p, "");
    const s = sig(tree as never);
    if (seen.has(s)) continue;
    seen.add(s);
    lines.push(JSON.stringify({ source: "synthetic", prompt: p, tree }));
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`Sinh ${lines.length} cây tổng hợp (khác nhau) → ${out}`);
}
