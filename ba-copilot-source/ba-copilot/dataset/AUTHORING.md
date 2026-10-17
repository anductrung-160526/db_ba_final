# Hướng dẫn soạn màn gốc (bộ dữ liệu "bổ sung UI")

Mỗi màn gốc là một màn **hoàn chỉnh, đúng nghiệp vụ** mà BA sẽ duyệt. Các mẫu "thiếu" được sinh tự động từ màn gốc,
nên màn gốc phải đủ mọi thứ cần có và không có thứ thừa.

## Định dạng một bản ghi (file `dataset/roots/<batch>-<nhóm>.json` là một mảng)
```json
{
  "id": "R001",
  "requirement": {
    "title": "Quên mật khẩu – cổng quản lý dự án",
    "actor": "Thành viên dự án",
    "description": "2–4 câu mô tả mục đích màn, dữ liệu hiển thị/nhập, hành động và kết quả.",
    "permissions": ["Chỉ thao tác trên tài khoản của chính mình"],
    "rules": ["Email bắt buộc, đúng định dạng", "Không tiết lộ email có tồn tại hay không"]
  },
  "tree": { "id": "page", "type": "Page", "props": { "title": "..." }, "children": [ ... ] },
  "notes": "ghi chú nếu đã điều chỉnh tổ hợp trong ma trận"
}
```
Các trường `group, screenKind, domain, permission, layout` lấy đúng từ `dataset/matrix.json` (script tự ghép theo id, không cần chép).

## Component (chỉ dùng 28 loại này)
Container (có `children`): Page (gốc duy nhất, props.title), Header, Sidebar, Section {title?}, Card {title?}, Row {gap?, align?}, Column, Form {title?, submitAction?}, List, Modal {title, open?}.
Lá: Heading {text, level 1–3}, Text {text, tone?}, Button {label, variant: primary|secondary|danger|ghost, action}, Link {text, navigateTo?},
Input {label, name, placeholder?, inputType: text|email|password|number|tel, required?, minLength?, maxLength?, min?, max?},
Textarea {label, name, placeholder?, required?, maxLength?}, Select {label, name, options[], required?}, Checkbox {label, name},
Radio {label, name, options[]}, DatePicker {label, name, required?}, Table {columns[], rows?, rowActions?}, Image {alt},
Badge {text, tone?}, Alert {text, tone: info|success|warning|danger}, Stat {label, value}, Avatar {name}, Divider {}, Pagination {pages?}.

## Quy tắc
1. **Đúng yêu cầu và quyền.** "Chỉ xem" ⇒ không có nút/thao tác thêm, sửa, xóa; "Chỉ được tạo" ⇒ không có sửa/xóa;
   "Chỉ được duyệt/từ chối" ⇒ có Duyệt/Từ chối, không có thêm/sửa dữ liệu nghiệp vụ. Ghi điều này vào `permissions`.
2. **Hoàn chỉnh như sản phẩm thật:** form có nút gửi (và Hủy khi hợp lý), trường bắt buộc có `required`, ô nhập có `name`;
   danh sách có tìm kiếm/lọc phù hợp và phân trang khi dữ liệu nhiều; bảng có cột thật của miền nghiệp vụ;
   trạng thái rỗng/lỗi có thông điệp + hành động tiếp theo; hộp thoại xác nhận có nút xác nhận và hủy.
3. **Không thừa:** không thêm phần tử trang trí vô nghĩa, không thêm chức năng ngoài yêu cầu.
4. **Bố cục theo cột `layout`** của ma trận, nhưng tự nhiên; đa dạng cách nhóm (Section, Card, Row, Column, Header…).
   Không lặp một khuôn cố định giữa các màn.
5. **id** dạng snake_case, ổn định, duy nhất trong màn, có nghĩa (vd `login_form`, `btn_submit`, `filter_status`).
6. Toàn bộ chữ hiển thị **tiếng Việt**, cụ thể theo miền (không dùng "Trường 1", "Lorem ipsum").
7. Kích thước 10–70 node. Mỗi container có ít nhất 1 con.
8. Nếu tổ hợp trong ma trận vô lý (vd "Chỉ xem" + "Tạo mới"), điều chỉnh sang cách hiểu hợp lý nhất
   (vd màn xem lại trước khi gửi) và ghi vào `notes`.

Kiểm tra: `npx tsx scripts/dataset/validate-roots.ts dataset/roots/<file>.json`
