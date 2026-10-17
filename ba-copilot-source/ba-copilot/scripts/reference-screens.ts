// 30 màn tham chiếu do nhóm thiết kế thủ công, mô phỏng màn của các sản phẩm thật (thương mại điện tử, HR, quản lý
// dự án, CRM, báo cáo...). Độc lập với bộ sinh tổng hợp (scripts/build-synthetic.ts): cấu trúc đa dạng hơn
// (Sidebar, Card, Section, Modal, List, Badge, Avatar...) và không dùng trong huấn luyện.
// Dùng cho scripts/eval-reference.ts.
import { normalizeTree, UINode } from "../shared/design.ts";

type P = Record<string, unknown>;
let n = 0;
const N = (type: string, props: P = {}, ...children: object[]) => ({ id: `r${++n}`, type, props, ...(children.length ? { children } : {}) });
const C = (type: string, props: P, ...children: object[]) => ({ id: `r${++n}`, type, props, children }); // container (có thể rỗng)
const page = (title: string, ...children: object[]) => C("Page", { title }, ...children);
const h = (text: string, level = 1) => N("Heading", { text, level });
const tx = (text: string) => N("Text", { text });
const inp = (label: string, inputType = "text", extra: P = {}) => N("Input", { label, name: label, inputType, placeholder: `Nhập ${label.toLowerCase()}`, ...extra });
const btn = (label: string, variant = "primary", action = "submit") => N("Button", { label, variant, action });
const link = (text: string) => N("Link", { text, navigateTo: text });
const sel = (label: string) => N("Select", { label, name: label, options: ["Tất cả"] });
const date = (label: string) => N("DatePicker", { label, name: label });
const area = (label: string) => N("Textarea", { label, name: label });
const chk = (label: string) => N("Checkbox", { label, name: label });
const table = (columns: string[], rowActions?: string[]) => N("Table", { columns, rows: [], ...(rowActions ? { rowActions } : {}) });
const stat = (label: string) => N("Stat", { label, value: "0" });
const row = (...c: object[]) => C("Row", { gap: 8 }, ...c);
const form = (...c: object[]) => C("Form", {}, ...c);
const card = (title: string, ...c: object[]) => C("Card", { title }, ...c);
const section = (title: string, ...c: object[]) => C("Section", { title }, ...c);
const nav = () => C("Sidebar", {}, link("Tổng quan"), link("Đơn hàng"), link("Sản phẩm"), link("Khách hàng"), link("Báo cáo"));
const withNav = (title: string, ...content: object[]) => page(title, nav(), C("Column", {}, ...content));

export const REFERENCE_SCREENS: { name: string; tree: UINode }[] = [
  ["Đăng nhập", page("Đăng nhập", card("Đăng nhập", h("Chào mừng trở lại", 2), tx("Đăng nhập để tiếp tục"), form(inp("Email", "email"), inp("Mật khẩu", "password"), row(chk("Ghi nhớ đăng nhập"), link("Quên mật khẩu?")), btn("Đăng nhập")), N("Divider"), btn("Đăng nhập với Google", "secondary", "oauth"), row(tx("Chưa có tài khoản?"), link("Đăng ký"))))],
  ["Đăng ký", page("Đăng ký", card("Tạo tài khoản", form(inp("Họ và tên"), inp("Email", "email"), inp("Số điện thoại", "tel"), inp("Mật khẩu", "password"), inp("Xác nhận mật khẩu", "password"), chk("Tôi đồng ý với điều khoản sử dụng"), btn("Đăng ký")), row(tx("Đã có tài khoản?"), link("Đăng nhập"))))],
  ["Quên mật khẩu", page("Quên mật khẩu", card("Quên mật khẩu", tx("Nhập email để nhận liên kết đặt lại mật khẩu"), form(inp("Email", "email"), btn("Gửi liên kết")), link("Quay lại đăng nhập")))],
  ["Đặt lại mật khẩu", page("Đặt lại mật khẩu", card("Đặt lại mật khẩu", form(inp("Mật khẩu mới", "password"), inp("Xác nhận mật khẩu", "password"), btn("Cập nhật mật khẩu"))))],
  ["Xác thực OTP", page("Xác thực OTP", card("Xác thực", tx("Mã OTP đã được gửi tới số điện thoại của bạn"), form(inp("Mã OTP", "number"), btn("Xác nhận")), link("Gửi lại mã")))],
  ["Hồ sơ cá nhân", withNav("Hồ sơ", h("Hồ sơ cá nhân"), row(N("Avatar", { name: "Nguyễn An" }), C("Column", {}, h("Nguyễn An", 2), tx("Nhân viên kinh doanh"))), form(inp("Họ và tên"), inp("Email", "email"), inp("Số điện thoại", "tel"), date("Ngày sinh"), N("Radio", { label: "Giới tính", name: "gt", options: ["Nam", "Nữ"] }), inp("Địa chỉ"), row(btn("Lưu"), btn("Hủy", "secondary", "cancel"))))],
  ["Đổi mật khẩu", withNav("Đổi mật khẩu", h("Đổi mật khẩu"), form(inp("Mật khẩu hiện tại", "password"), inp("Mật khẩu mới", "password"), inp("Xác nhận mật khẩu mới", "password"), row(btn("Đổi mật khẩu"), btn("Hủy", "secondary", "cancel"))))],
  ["Cài đặt thông báo", withNav("Cài đặt", h("Cài đặt thông báo"), section("Email", chk("Đơn hàng mới"), chk("Đơn hàng bị hủy"), chk("Báo cáo tuần")), section("Ứng dụng", chk("Tin nhắn mới"), chk("Nhắc việc")), btn("Lưu thay đổi"))],
  ["Danh sách sản phẩm", withNav("Sản phẩm", C("Header", {}, h("Sản phẩm"), btn("Thêm sản phẩm", "primary", "create")), row(inp("Tìm kiếm sản phẩm"), sel("Danh mục"), sel("Trạng thái")), table(["Ảnh", "Tên sản phẩm", "SKU", "Giá", "Tồn kho", "Trạng thái"], ["Sửa", "Xóa"]), N("Pagination", { pages: 10 }))],
  ["Thêm sản phẩm", withNav("Thêm sản phẩm", h("Thêm sản phẩm"), card("Thông tin chung", form(inp("Tên sản phẩm"), inp("Mã SKU"), sel("Danh mục"), inp("Giá bán", "number"), inp("Số lượng", "number"), area("Mô tả"), chk("Hiển thị trên cửa hàng"), row(btn("Lưu"), btn("Hủy", "secondary", "cancel")))))],
  ["Chi tiết đơn hàng", withNav("Đơn hàng #1024", C("Header", {}, h("Đơn hàng #1024"), N("Badge", { text: "Đang giao", tone: "info" })), section("Khách hàng", tx("Trần Bình"), tx("0901 234 567"), tx("12 Lê Lợi, Q1")), table(["Sản phẩm", "Số lượng", "Đơn giá", "Thành tiền"]), row(stat("Tạm tính"), stat("Phí giao hàng"), stat("Tổng cộng")), row(btn("In hóa đơn", "secondary", "print"), btn("Hủy đơn", "danger", "cancel_order")))],
  ["Danh sách đơn hàng", withNav("Đơn hàng", h("Đơn hàng"), row(inp("Tìm mã đơn"), sel("Trạng thái"), date("Từ ngày"), date("Đến ngày"), btn("Xuất Excel", "secondary", "export")), table(["Mã đơn", "Khách hàng", "Ngày đặt", "Tổng tiền", "Trạng thái"], ["Xem"]), N("Pagination", { pages: 5 }))],
  ["Dashboard bán hàng", withNav("Tổng quan", h("Tổng quan"), row(stat("Doanh thu hôm nay"), stat("Đơn hàng mới"), stat("Khách hàng mới"), stat("Tỷ lệ chuyển đổi")), row(card("Doanh thu 7 ngày", N("Image", { alt: "Biểu đồ doanh thu" })), card("Sản phẩm bán chạy", C("List", {}, tx("Áo thun"), tx("Quần jean"), tx("Giày thể thao")))), section("Đơn hàng gần đây", table(["Mã đơn", "Khách hàng", "Tổng tiền", "Trạng thái"])))],
  ["Danh sách khách hàng", withNav("Khách hàng", C("Header", {}, h("Khách hàng"), btn("Thêm khách hàng", "primary", "create")), row(inp("Tìm theo tên, SĐT"), sel("Hạng thành viên")), table(["Họ tên", "Số điện thoại", "Email", "Hạng", "Tổng chi tiêu"], ["Xem", "Sửa"]), N("Pagination", { pages: 8 }))],
  ["Thêm khách hàng", withNav("Thêm khách hàng", h("Thêm khách hàng"), form(inp("Họ và tên"), inp("Số điện thoại", "tel"), inp("Email", "email"), date("Ngày sinh"), inp("Địa chỉ"), sel("Hạng thành viên"), area("Ghi chú"), row(btn("Lưu"), btn("Hủy", "secondary", "cancel"))))],
  ["Giỏ hàng", page("Giỏ hàng", h("Giỏ hàng của bạn"), table(["Sản phẩm", "Đơn giá", "Số lượng", "Thành tiền"], ["Xóa"]), row(stat("Tạm tính"), stat("Tổng cộng")), row(link("Tiếp tục mua sắm"), btn("Thanh toán", "primary", "checkout")))],
  ["Thanh toán", page("Thanh toán", h("Thanh toán"), section("Địa chỉ giao hàng", form(inp("Họ và tên"), inp("Số điện thoại", "tel"), inp("Địa chỉ"))), section("Phương thức thanh toán", N("Radio", { label: "Phương thức", name: "pt", options: ["COD", "Chuyển khoản", "Ví điện tử"] })), section("Tóm tắt đơn hàng", table(["Sản phẩm", "Số lượng", "Thành tiền"]), stat("Tổng thanh toán")), btn("Đặt hàng", "primary", "checkout"))],
  ["Danh sách nhân viên", withNav("Nhân viên", C("Header", {}, h("Nhân viên"), btn("Thêm nhân viên", "primary", "create")), row(inp("Tìm kiếm"), sel("Phòng ban"), sel("Chức vụ")), table(["Mã NV", "Họ tên", "Phòng ban", "Chức vụ", "Trạng thái"], ["Xem", "Sửa", "Xóa"]), N("Pagination", { pages: 4 }))],
  ["Tạo đơn nghỉ phép", withNav("Nghỉ phép", h("Tạo đơn nghỉ phép"), N("Alert", { text: "Bạn còn 8 ngày phép năm", tone: "info" }), form(sel("Loại nghỉ"), date("Từ ngày"), date("Đến ngày"), area("Lý do"), sel("Người duyệt"), row(btn("Gửi đơn"), btn("Hủy", "secondary", "cancel"))))],
  ["Duyệt đơn nghỉ phép", withNav("Duyệt đơn", h("Đơn chờ duyệt"), row(sel("Phòng ban"), date("Từ ngày")), table(["Nhân viên", "Loại nghỉ", "Từ ngày", "Đến ngày", "Lý do"], ["Xem"]), row(btn("Duyệt", "primary", "approve"), btn("Từ chối", "danger", "reject")), N("Pagination", { pages: 3 }))],
  ["Danh sách dự án", withNav("Dự án", C("Header", {}, h("Dự án"), btn("Tạo dự án", "primary", "create")), row(inp("Tìm dự án"), sel("Trạng thái")), C("List", {}, card("Website bán hàng", tx("Hạn: 30/11"), N("Badge", { text: "Đang làm" })), card("App giao hàng", tx("Hạn: 15/12"), N("Badge", { text: "Mới" })), card("Hệ thống HR", tx("Hạn: 01/10"), N("Badge", { text: "Hoàn thành" }))))],
  ["Tạo công việc", withNav("Bảng công việc", h("Bảng công việc"), C("Modal", { title: "Tạo công việc" }, form(inp("Tiêu đề"), area("Mô tả"), sel("Người phụ trách"), date("Hạn hoàn thành"), sel("Độ ưu tiên"), row(btn("Tạo", "primary", "create"), btn("Hủy", "secondary", "cancel")))))],
  ["Chi tiết công việc", withNav("Công việc", C("Header", {}, h("Thiết kế màn đăng nhập"), N("Badge", { text: "Đang làm" })), section("Mô tả", tx("Thiết kế màn đăng nhập theo hướng dẫn thương hiệu")), section("Bình luận", C("List", {}, row(N("Avatar", { name: "An" }), tx("Đã xong bản nháp")), row(N("Avatar", { name: "Bình" }), tx("Cần chỉnh màu nút")))), form(area("Viết bình luận"), btn("Gửi")))],
  ["Báo cáo doanh thu", withNav("Báo cáo", h("Báo cáo doanh thu"), row(date("Từ ngày"), date("Đến ngày"), sel("Chi nhánh"), btn("Xem báo cáo", "primary", "search")), row(stat("Doanh thu"), stat("Lợi nhuận"), stat("Số đơn")), N("Image", { alt: "Biểu đồ doanh thu theo ngày" }), table(["Ngày", "Doanh thu", "Số đơn", "Lợi nhuận"]))],
  ["Liên hệ hỗ trợ", page("Hỗ trợ", h("Liên hệ hỗ trợ"), tx("Đội ngũ hỗ trợ phản hồi trong 24 giờ"), form(inp("Email", "email"), sel("Chủ đề"), area("Nội dung"), btn("Gửi yêu cầu")), section("Thông tin khác", tx("Hotline: 1900 1234"), link("Câu hỏi thường gặp")))],
  ["Tìm kiếm tài liệu", withNav("Tài liệu", h("Thư viện tài liệu"), row(inp("Từ khóa"), sel("Loại tài liệu"), btn("Tìm kiếm", "primary", "search")), C("List", {}, card("Quy trình bán hàng", tx("Cập nhật 01/10"), link("Tải xuống")), card("Chính sách đổi trả", tx("Cập nhật 15/09"), link("Tải xuống"))), N("Pagination", { pages: 6 }))],
  ["Quản lý người dùng", withNav("Người dùng", C("Header", {}, h("Người dùng"), btn("Mời người dùng", "primary", "create")), table(["Họ tên", "Email", "Vai trò", "Trạng thái"], ["Phân quyền", "Khóa"]), C("Modal", { title: "Phân quyền" }, chk("Xem báo cáo"), chk("Quản lý đơn hàng"), chk("Quản lý sản phẩm"), row(btn("Lưu"), btn("Hủy", "secondary", "cancel"))))],
  ["Thông báo", withNav("Thông báo", C("Header", {}, h("Thông báo"), btn("Đánh dấu đã đọc", "secondary", "mark_read")), C("List", {}, row(N("Badge", { text: "Mới" }), tx("Đơn #1024 đã giao thành công"), link("Xem")), row(N("Badge", { text: "Mới" }), tx("Khách hàng Trần Bình để lại đánh giá"), link("Xem")), row(tx("Báo cáo tuần đã sẵn sàng"), link("Xem"))))],
  ["Phiếu nhập kho", withNav("Nhập kho", h("Tạo phiếu nhập"), form(sel("Nhà cung cấp"), date("Ngày nhập"), sel("Kho")), table(["Sản phẩm", "Số lượng", "Đơn giá", "Thành tiền"], ["Xóa"]), btn("Thêm dòng", "secondary", "add_row"), row(btn("Lưu phiếu"), btn("Hủy", "secondary", "cancel")))],
  ["Trang chủ hệ thống", page("Trang chủ", C("Header", {}, h("BA Shop Admin"), row(inp("Tìm kiếm nhanh"), N("Avatar", { name: "Admin" }))), nav(), C("Column", {}, h("Xin chào, Admin", 2), row(card("Đơn chờ xử lý", stat("Số đơn"), link("Xem tất cả")), card("Sắp hết hàng", stat("Sản phẩm"), link("Xem tất cả")))))],
].map(([name, raw]) => ({ name: name as string, tree: normalizeTree(raw) }));
