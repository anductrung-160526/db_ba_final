// Ma trận phủ cho bộ dữ liệu "bổ sung UI": phân bổ 670 màn gốc theo nhóm màn × loại màn × miền nghiệp vụ ×
// quyền người dùng × kiểu bố cục, cân bằng và lặp lại được (seed cố định). 670 màn × ~15 mẫu ≈ 10 nghìn mẫu.
// 50 màn đầu (cân bằng 10/nhóm) là đợt thử; thêm màn không làm đổi các màn trước (vòng xoay độc lập với tổng số).
// Dùng: npx tsx scripts/dataset/matrix.ts → dataset/matrix.json
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rng } from "../build-next-model.ts";

export const GROUPS: Record<string, string[]> = {
  auth: ["Đăng nhập", "Đăng ký tài khoản", "Quên mật khẩu", "Đặt lại mật khẩu", "Xác thực OTP", "Đổi mật khẩu", "Hồ sơ cá nhân", "Cài đặt tài khoản"],
  list: ["Danh sách có tìm kiếm, lọc, phân trang", "Báo cáo dạng bảng", "Kết quả tra cứu", "Tổng quan (chỉ số + bảng)"],
  form: ["Tạo mới", "Chỉnh sửa", "Xem chi tiết", "Biểu mẫu nhiều phần", "Bước trong quy trình nhiều bước"],
  approval: ["Hàng chờ phê duyệt", "Chi tiết hồ sơ cần duyệt", "Màn theo vai trò (người tạo / người duyệt)"],
  state: ["Danh sách rỗng", "Thông báo lỗi", "Hộp thoại xác nhận", "Thông báo thành công", "Không có quyền truy cập"],
};
export const DOMAINS = ["Bán hàng (sản phẩm, đơn hàng)", "Khách hàng (CRM)", "Nhân sự", "Nghỉ phép & chấm công", "Kho hàng", "Tài chính & hóa đơn", "Dự án & công việc", "Đào tạo & khóa học", "Y tế & lịch hẹn", "Bất động sản & hợp đồng thuê", "Hỗ trợ khách hàng (ticket)", "Quản trị hệ thống & người dùng"];
export const PERMISSIONS = ["Toàn quyền (xem, thêm, sửa, xóa)", "Chỉ xem", "Chỉ được tạo mới, không sửa/xóa", "Chỉ được duyệt/từ chối", "Chỉ thao tác trên bản ghi của chính mình"];
export const LAYOUTS = ["Trang đơn", "Sidebar điều hướng + nội dung", "Thẻ (Card) ở giữa", "Hộp thoại (Modal) trên trang", "Hai cột", "Thanh tiêu đề có nút + nội dung"];

export interface Assignment {
  id: string;
  batch: "pilot" | "main";
  group: string;
  screenKind: string;
  domain: string;
  permission: string;
  layout: string;
}

export function buildMatrix(total = 670, pilot = 50, seed = 20261018): Assignment[] {
  const r = rng(seed);
  const groups = Object.keys(GROUPS);
  const out: Assignment[] = [];
  // xoay vòng có xáo trộn để mỗi thuộc tính phủ đều
  const cyc = <T,>(arr: T[]) => {
    let pool: T[] = [];
    return () => {
      if (!pool.length) pool = [...arr].sort(() => r() - 0.5);
      return pool.pop()!;
    };
  };
  const nextDomain = cyc(DOMAINS), nextLayout = cyc(LAYOUTS), nextPerm = cyc(PERMISSIONS);
  const kindCyc = Object.fromEntries(groups.map((g) => [g, cyc(GROUPS[g])]));
  for (let i = 0; i < total; i++) {
    const group = groups[i % groups.length];
    let permission = nextPerm();
    if (group === "auth") permission = "Người dùng thao tác trên tài khoản của chính mình";
    if (group === "approval" && /Toàn quyền|Chỉ được tạo/.test(permission)) permission = "Chỉ được duyệt/từ chối";
    let layout = nextLayout();
    out.push({ id: `R${String(i + 1).padStart(3, "0")}`, batch: i < pilot ? "pilot" : "main", group, screenKind: kindCyc[group](), domain: nextDomain(), permission, layout });
  }
  return out;
}

if (process.argv[1]?.endsWith("matrix.ts")) {
  const m = buildMatrix();
  writeFileSync(join(import.meta.dirname, "..", "..", "dataset", "matrix.json"), JSON.stringify(m, null, 1));
  const count = (k: keyof Assignment) => Object.entries(m.reduce((a, x) => ((a[x[k]] = (a[x[k]] ?? 0) + 1), a), {} as Record<string, number>));
  console.log(`${m.length} màn gốc (${m.filter((x) => x.batch === "pilot").length} đợt thử)`);
  for (const k of ["group", "domain", "permission", "layout"] as const) console.log(k, count(k).map(([a, b]) => `${a}: ${b}`).join(" · "));
}
