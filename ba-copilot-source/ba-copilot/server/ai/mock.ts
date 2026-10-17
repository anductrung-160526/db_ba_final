// Bộ sinh rule-based (chế độ Mock): chạy khi không có API key, dùng cho demo/test tự động
// và làm "baseline" để so sánh với LLM trong chương thực nghiệm.

import { ALL_TYPES, findNode, findParent, isContainer, newId, normalizeTree, UINode, walk } from "../../shared/design.ts";
import type { PatchOp } from "../../shared/patch.ts";
import type { DesignModel, ScreenModel, FieldSpec } from "../../shared/extract.ts";
import type { AltFlow, Requirement, SequenceDiagram, SrsDoc, TestCase, UseCase, FlowStep } from "../../shared/types.ts";

// ------------------------------------------------------------------ Screens
const has = (s: string, re: RegExp) => re.test(s.toLowerCase());

function entityFrom(prompt: string, fallback: string): string {
  const m = prompt.match(/(?:quản lý|danh sách|thêm|tạo|chỉnh sửa|form|màn hình)\s+([\p{L}\d ]{2,40}?)(?:[,.;:\n]|$| gồm| có| với| cho)/iu);
  const e = (m?.[1] ?? fallback).trim();
  return e.charAt(0).toUpperCase() + e.slice(1);
}

/**
 * Sinh màn hình ở chế độ Mock.
 * - Prompt mô tả cụ thể các thành phần (trường, nút, bảng...) → dựng ĐÚNG những gì được mô tả (mockFromPrompt),
 *   nên prompt thiếu gì thì màn thiếu cái đó – tab "Gợi ý" sẽ phát hiện.
 * - Prompt chỉ nêu loại màn (vd "đăng nhập", "dashboard") hoặc mode "template" → dùng khuôn mẫu đầy đủ.
 */
export function mockScreen(prompt: string, name: string, opts: { mode?: "auto" | "template" } = {}): UINode {
  if (opts.mode !== "template") {
    const built = mockFromPrompt(prompt, name);
    if (built) return built;
  }
  return mockTemplate(prompt, name);
}

// ------------------------------------------------------------------ Dựng màn từ prompt
interface Part {
  at: number; // vị trí xuất hiện trong prompt để giữ thứ tự
  node: { id?: string; type: string; props: Record<string, unknown> };
}

const ACTIONS: [RegExp, string][] = [
  [/đăng nhập/, "login"], [/đăng ký/, "register"], [/lưu/, "save"], [/hủy|huỷ/, "cancel"], [/tìm/, "search"],
  [/xóa|xoá/, "delete"], [/thêm/, "create"], [/cập nhật/, "update"], [/gửi/, "submit"], [/duyệt/, "approve"],
  [/từ chối/, "reject"], [/xuất/, "export"], [/thanh toán|đặt hàng/, "checkout"], [/quay lại/, "back"],
];
const actionOf = (label: string) => ACTIONS.find(([re]) => re.test(label.toLowerCase()))?.[1] ?? "click";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const splitList = (s: string) => s.split(/\s*(?:,|;|\/)\s*|\s+(?:và|hoặc)\s+/).map((x) => x.replace(/["“”']/g, "").trim()).filter((x) => x && x.length <= 40);

export function mockFromPrompt(prompt: string, name: string): UINode | null {
  const text = prompt.trim();
  const p = text.toLowerCase();
  const fields: Part[] = [];
  const tools: Part[] = []; // tìm kiếm / bộ lọc trên thanh công cụ
  const buttons: Part[] = [];
  const links: Part[] = [];
  const at = (re: RegExp) => p.search(re);
  // phần mô tả cột bảng / bộ lọc / chỉ số không phải trường nhập ("cột Mã, Họ tên" ≠ form có Mã, Họ tên)
  const blank = (s: string) => s.replace(/(cột|lọc theo|chỉ số)\s+[^.;\n]+?(?=$|[.;\n]|,\s*(?:thao tác|nút|phân trang|có|xuất|bảng|khoảng)\b)/giu, (m) => " ".repeat(m.length));
  const pf = blank(p);
  const fieldRes: { re: RegExp; node: { type: string; props: Record<string, unknown> } }[] = [];
  const field = (re: RegExp, type: string, props: Record<string, unknown>) => {
    const i = pf.search(re);
    if (i < 0) return;
    const base: Record<string, unknown> = { ...props, name: slugName(String(props.label)) };
    if (type === "Input" || type === "Textarea") base.placeholder ??= `Nhập ${String(props.label).toLowerCase()}`;
    const node = { type, props: base };
    fieldRes.push({ re, node });
    fields.push({ at: i, node });
  };
  /** Ràng buộc chỉ áp cho trường được nhắc cùng mệnh đề ("Họ tên và email bắt buộc"); không nhắc trường nào → áp cho tất cả. */
  const constrain = () => {
    for (const seg of p.split(/[.;,()\n]/)) {
      const req = /bắt buộc/.test(seg);
      const max = seg.match(/tối đa\s+(\d+)\s*ký tự/)?.[1];
      const min = seg.match(/tối thiểu\s+(\d+)\s*ký tự/)?.[1];
      if (!req && !max && !min) continue;
      const named = fieldRes.filter((f) => f.re.test(seg));
      const targets = named.length ? named : fieldRes.filter((f) => !(min && !max && !req) || f.node.props.inputType === "password");
      for (const { node } of targets) {
        if (req && node.type !== "Checkbox") node.props.required = true;
        if (max && (node.type === "Input" || node.type === "Textarea") && node.props.inputType !== "password") node.props.maxLength = Number(max);
        if (min && node.type === "Input") node.props.minLength = Number(min);
      }
    }
  };

  field(/email/, "Input", { label: "Email", inputType: "email" });
  field(/xác nhận mật khẩu/, "Input", { label: "Xác nhận mật khẩu", inputType: "password" });
  field(/mật khẩu (cũ|hiện tại)/, "Input", { label: "Mật khẩu hiện tại", inputType: "password" });
  field(/mật khẩu mới/, "Input", { label: "Mật khẩu mới", inputType: "password" });
  if (!/mật khẩu (cũ|hiện tại|mới)/.test(p)) field(/(?<!quên |xác nhận )mật khẩu|password/, "Input", { label: "Mật khẩu", inputType: "password" });
  field(/họ (và )?tên|tên đầy đủ/, "Input", { label: "Họ và tên" });
  field(/số điện thoại|sđt/, "Input", { label: "Số điện thoại", inputType: "tel" });
  field(/địa chỉ(?! email)/, "Input", { label: "Địa chỉ" });
  field(/ngày sinh/, "DatePicker", { label: "Ngày sinh" });
  field(/ngày hiệu lực/, "DatePicker", { label: "Ngày hiệu lực" });
  field(/giới tính/, "Radio", { label: "Giới tính", options: ["Nam", "Nữ", "Khác"] });
  field(/giá( bán)?\b/, "Input", { label: "Giá bán", inputType: "number" });
  field(/số lượng|tồn kho/, "Input", { label: "Số lượng", inputType: "number" });
  field(/(?<!\p{L})mã(?!\p{L})(?! số)/u, "Input", { label: "Mã" });
  field(/danh mục/, "Select", { label: "Danh mục", options: ["Loại 1", "Loại 2", "Loại 3"] });
  field(/người phụ trách/, "Select", { label: "Người phụ trách", options: ["Chưa phân công"] });
  field(/mô tả/, "Textarea", { label: "Mô tả" });
  field(/ghi chú/, "Textarea", { label: "Ghi chú" });
  field(/ghi nhớ đăng nhập/, "Checkbox", { label: "Ghi nhớ đăng nhập" });
  field(/đồng ý|điều khoản/, "Checkbox", { label: "Tôi đồng ý với điều khoản sử dụng" });
  const tenX = blank(text).match(/(?<![Hh]ọ )\btên\s+([\p{L}]+(?:\s[\p{L}]+)?)/u);
  if (tenX && !/^(đăng|tài khoản)/i.test(tenX[1])) field(new RegExp(`tên\\s+${tenX[1].toLowerCase()}`), "Input", { label: `Tên ${tenX[1].toLowerCase()}` });

  constrain();

  // thanh công cụ của màn danh sách
  const isList = /\bbảng\b|danh sách/.test(p) && !/^màn hình (đăng|quên)/.test(p);
  const iSearch = at(/tìm kiếm|tra cứu/);
  if (iSearch >= 0 && (isList || !fields.length)) tools.push({ at: iSearch, node: { type: "Input", props: { label: "Tìm kiếm", name: "keyword", placeholder: "Nhập từ khóa..." } } });
  for (const m of p.matchAll(/lọc theo\s+([^,.;\n]+)/g)) for (const f of splitList(m[1]))
    tools.push({ at: m.index!, node: { type: "Select", props: { label: cap(f), name: slugName(f), options: ["Tất cả"] } } });
  if (/khoảng thời gian|từ ngày/.test(p)) {
    const i = at(/khoảng thời gian|từ ngày/);
    tools.push({ at: i, node: { type: "DatePicker", props: { label: "Từ ngày", name: "from_date" } } }, { at: i + 1, node: { type: "DatePicker", props: { label: "Đến ngày", name: "to_date" } } });
  }

  // nút: "nút Lưu và Hủy", "nút duyệt và từ chối", "nút thêm mới", "xuất Excel"
  for (const m of text.matchAll(/nút\s+([^.;:\n]+?)(?=$|[.;:\n]|,\s*(?:có|bảng|phân trang|link|liên kết)\b)/giu))
    for (const lb of splitList(m[1].replace(/\s+(vào|ở|bên|phía|cuối|dưới|trên).*$/i, ""))) buttons.push({ at: m.index!, node: { type: "Button", props: { label: cap(lb) } } });
  if (/xuất excel/.test(p) && !buttons.some((b) => /xuất/i.test(String(b.node.props.label)))) buttons.push({ at: at(/xuất excel/), node: { type: "Button", props: { label: "Xuất Excel" } } });

  // liên kết
  if (/quên mật khẩu/.test(p) && !/^màn hình quên|^quên/.test(p)) links.push({ at: at(/quên mật khẩu/), node: { type: "Link", props: { text: "Quên mật khẩu?", navigateTo: "Quên mật khẩu" } } });
  if (/(link|liên kết)\s+đăng ký|đăng ký tài khoản/.test(p) && /đăng nhập/.test(p)) links.push({ at: at(/đăng ký/), node: { type: "Link", props: { text: "Đăng ký tài khoản", navigateTo: "Đăng ký" } } });

  const hasTable = isList;
  // trên màn danh sách, trường trùng với bộ lọc là bộ lọc chứ không phải form
  if (isList) for (let i = fields.length - 1; i >= 0; i--) if (tools.some((t) => slugName(String(t.node.props.label)) === slugName(String(fields[i].node.props.label)))) fields.splice(i, 1);
  const stats = p.match(/chỉ số\s+([^.;\n]+?)(?:\s+và\s+bảng|[.;\n]|$)/)?.[1];
  const count = fields.length + tools.length + buttons.length + links.length + (hasTable ? 1 : 0) + (stats ? 1 : 0);
  if (count < 2) return null; // prompt quá chung → dùng khuôn mẫu

  const intent = /đăng nhập/.test(p) && fields.some((f) => /mật khẩu/i.test(String(f.node.props.label))) && !/đăng ký tài khoản:|xác nhận mật khẩu/.test(p) ? "login" : /đăng ký/.test(p) && fields.length ? "register" : "";
  const title = name || cap(text.split(/[:,.]|\s+(?:có|gồm|với|bằng)\s+/)[0].replace(/^(màn hình|form|trang)\s+/i, "")).slice(0, 60);
  const byAt = (a: Part, b: Part) => a.at - b.at;
  const btn = (b: Part) => {
    const lb = String(b.node.props.label);
    const action = actionOf(lb);
    return { id: action === "click" ? undefined : `btn_${action}`, type: "Button", props: { label: lb, variant: /hủy|huỷ|quay lại|từ chối/i.test(lb) ? "secondary" : "primary", action } };
  };
  const formBtns = buttons.filter((b) => !(hasTable && /thêm|xuất/i.test(String(b.node.props.label))));
  const toolBtns = buttons.filter((b) => !formBtns.includes(b));
  const children: unknown[] = [{ type: "Heading", props: { text: title, level: 1 } }];

  if (stats) children.push({ type: "Row", props: { gap: 12 }, children: splitList(stats).map((l) => ({ type: "Stat", props: { label: cap(l), value: "0" } })) });
  if (tools.length || toolBtns.length)
    children.push({ type: "Row", props: { gap: 8, align: "between" }, children: [...tools.sort(byAt).map((t) => t.node), ...toolBtns.map(btn)] });
  if (fields.length) {
    const formKids = [...fields.sort(byAt).map((f) => f.node), ...(formBtns.length > 1 ? [{ type: "Row", props: { gap: 8, align: "end" }, children: formBtns.map(btn) }] : formBtns.map(btn))];
    children.push({ id: intent ? `${intent}_form` : undefined, type: "Form", props: { submitAction: intent || "save" }, children: formKids });
  } else if (formBtns.length && !hasTable) children.push({ type: "Row", props: { gap: 8 }, children: formBtns.map(btn) });
  if (hasTable) {
    const cols = text.match(/cột\s+([^.;\n]+?)(?=$|[.;\n]|,\s*(?:thao tác|nút|phân trang|có|xuất)\b)/i)?.[1]; // giữ chữ hoa của BA ("Mã NV")
    const acts = p.match(/(xem\/sửa\/xóa|sửa\/xóa|sửa và xóa)/)?.[1];
    children.push({ type: "Table", props: { columns: [...(cols ? splitList(cols).map(cap) : ["Mã", "Tên", "Trạng thái"]), ...(acts ? ["Thao tác"] : [])], rows: [], ...(acts ? { rowActions: splitList(acts).map(cap) } : {}) } });
    if (hasTable && formBtns.length && fields.length === 0) children.push({ type: "Row", props: { gap: 8 }, children: formBtns.map(btn) });
  }
  if (/phân trang/.test(p)) children.push({ type: "Pagination", props: { pages: 5 } });
  if (links.length) children.push({ type: "Row", props: { align: "between" }, children: links.sort(byAt).map((l) => l.node) });
  return normalizeTree({ id: "page", type: "Page", props: { title }, children });
}

function slugName(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "field";
}

/** Khuôn mẫu đầy đủ theo loại màn (hành vi cũ của chế độ Mock). */
export function mockTemplate(prompt: string, name: string): UINode {
  const p = prompt.toLowerCase();
  let tree: unknown;
  if (has(p, /đăng nhập|login|sign in/)) {
    tree = {
      id: "page",
      type: "Page",
      props: { title: name || "Đăng nhập" },
      children: [
        {
          id: "login_card",
          type: "Card",
          props: { title: "Đăng nhập hệ thống" },
          children: [
            {
              id: "login_form",
              type: "Form",
              props: { submitAction: "login" },
              children: [
                { id: "email", type: "Input", props: { label: "Email", name: "email", inputType: "email", placeholder: "ban@congty.vn", required: true, maxLength: 100 } },
                { id: "password", type: "Input", props: { label: "Mật khẩu", name: "password", inputType: "password", placeholder: "Tối thiểu 8 ký tự", required: true, minLength: 8, maxLength: 32 } },
                { id: "remember", type: "Checkbox", props: { label: "Ghi nhớ đăng nhập", name: "remember" } },
                { id: "btn_login", type: "Button", props: { label: "Đăng nhập", variant: "primary", action: "login", navigateTo: "Trang chủ" } },
              ],
            },
            {
              id: "login_links",
              type: "Row",
              props: { align: "between" },
              children: [
                { id: "link_forgot", type: "Link", props: { text: "Quên mật khẩu?", navigateTo: "Quên mật khẩu" } },
                { id: "link_register", type: "Link", props: { text: "Đăng ký tài khoản", navigateTo: "Đăng ký" } },
              ],
            },
          ],
        },
      ],
    };
  } else if (has(p, /đăng ký|register|sign up/)) {
    tree = {
      id: "page",
      type: "Page",
      props: { title: name || "Đăng ký" },
      children: [
        {
          id: "reg_card",
          type: "Card",
          props: { title: "Tạo tài khoản" },
          children: [
            {
              id: "reg_form",
              type: "Form",
              props: { submitAction: "register" },
              children: [
                { id: "fullname", type: "Input", props: { label: "Họ và tên", name: "full_name", required: true, maxLength: 50 } },
                { id: "reg_email", type: "Input", props: { label: "Email", name: "email", inputType: "email", required: true } },
                { id: "phone", type: "Input", props: { label: "Số điện thoại", name: "phone", inputType: "tel", pattern: "^0\\d{9}$" } },
                { id: "reg_password", type: "Input", props: { label: "Mật khẩu", name: "password", inputType: "password", required: true, minLength: 8 } },
                { id: "agree", type: "Checkbox", props: { label: "Tôi đồng ý với điều khoản sử dụng", name: "agree" } },
                { id: "btn_register", type: "Button", props: { label: "Đăng ký", variant: "primary", action: "register", navigateTo: "Đăng nhập" } },
              ],
            },
          ],
        },
      ],
    };
  } else if (has(p, /quản lý|danh sách|list|tra cứu|tìm kiếm/)) {
    const ent = entityFrom(prompt, name || "dữ liệu");
    tree = {
      id: "page",
      type: "Page",
      props: { title: name || `Quản lý ${ent}` },
      children: [
        { id: "header", type: "Header", props: { title: `Quản lý ${ent}` } },
        {
          id: "toolbar",
          type: "Row",
          props: { gap: 12, align: "between" },
          children: [
            {
              id: "filters",
              type: "Row",
              props: { gap: 8 },
              children: [
                { id: "search", type: "Input", props: { label: "Tìm kiếm", name: "keyword", placeholder: `Tên ${ent.toLowerCase()}...`, maxLength: 100 } },
                { id: "status_filter", type: "Select", props: { label: "Trạng thái", name: "status", options: ["Tất cả", "Hoạt động", "Ngừng hoạt động"] } },
              ],
            },
            { id: "btn_add", type: "Button", props: { label: "Thêm mới", variant: "primary", action: "create", navigateTo: `Thêm ${ent.toLowerCase()}` } },
          ],
        },
        {
          id: "table",
          type: "Table",
          props: {
            columns: ["Mã", "Tên", "Trạng thái", "Ngày tạo"],
            rows: [
              ["001", `${ent} A`, "Hoạt động", "01/10/2026"],
              ["002", `${ent} B`, "Ngừng hoạt động", "05/10/2026"],
            ],
            rowActions: ["Xem", "Sửa", "Xóa"],
          },
        },
        { id: "pagination", type: "Pagination", props: { pages: 5 } },
      ],
    };
  } else if (has(p, /thêm|tạo|form|nhập|chỉnh sửa|cập nhật/)) {
    const ent = entityFrom(prompt, name || "bản ghi");
    tree = {
      id: "page",
      type: "Page",
      props: { title: name || `Thêm ${ent.toLowerCase()}` },
      children: [
        { id: "header", type: "Header", props: { title: `Thêm ${ent.toLowerCase()}` } },
        {
          id: "main_form",
          type: "Form",
          props: { title: `Thông tin ${ent.toLowerCase()}`, submitAction: "save" },
          children: [
            { id: "f_name", type: "Input", props: { label: `Tên ${ent.toLowerCase()}`, name: "name", required: true, maxLength: 100 } },
            { id: "f_category", type: "Select", props: { label: "Danh mục", name: "category", options: ["Loại 1", "Loại 2", "Loại 3"], required: true } },
            { id: "f_date", type: "DatePicker", props: { label: "Ngày hiệu lực", name: "effective_date" } },
            { id: "f_desc", type: "Textarea", props: { label: "Mô tả", name: "description", maxLength: 500 } },
            {
              id: "form_actions",
              type: "Row",
              props: { gap: 8, align: "end" },
              children: [
                { id: "btn_cancel", type: "Button", props: { label: "Hủy", variant: "secondary", action: "cancel", navigateTo: `Quản lý ${ent.toLowerCase()}` } },
                { id: "btn_save", type: "Button", props: { label: "Lưu", variant: "primary", action: "save", navigateTo: `Quản lý ${ent.toLowerCase()}` } },
              ],
            },
          ],
        },
      ],
    };
  } else {
    tree = {
      id: "page",
      type: "Page",
      props: { title: name || "Trang chủ" },
      children: [
        { id: "header", type: "Header", props: { title: name || "Tổng quan" } },
        {
          id: "stats",
          type: "Row",
          props: { gap: 12 },
          children: [
            { id: "stat_1", type: "Stat", props: { label: "Tổng số", value: "1.250" } },
            { id: "stat_2", type: "Stat", props: { label: "Đang xử lý", value: "36" } },
            { id: "stat_3", type: "Stat", props: { label: "Hoàn thành", value: "1.180" } },
          ],
        },
        {
          id: "recent",
          type: "Section",
          props: { title: "Hoạt động gần đây" },
          children: [{ id: "recent_table", type: "Table", props: { columns: ["Thời gian", "Nội dung", "Người thực hiện"], rows: [["08:30", "Tạo mới bản ghi", "BA"]] } }],
        },
      ],
    };
  }
  return normalizeTree(tree);
}

// ------------------------------------------------------------------ Edit
export function mockEditOps(tree: UINode, selectedIds: string[], instruction: string): { ops: PatchOp[]; summary: string } {
  // vị trí chèn do gợi ý Transformer ghi: ", ngay sau Input "Email"" / ", ngay trước Button "Lưu""
  const posRef = instruction.match(/,?\s*ngay (sau|trước)\s+[\p{L}]+\s+["“]([^"”]+)["”]/u);
  const text = (posRef ? instruction.replace(posRef[0], "") : instruction).trim();
  const low = text.toLowerCase();
  const targets = selectedIds.length ? selectedIds : [tree.id];
  const ops: PatchOp[] = [];
  const quoted = text.match(/["“”']([^"“”']+)["“”']/)?.[1];

  // chỉ hiểu là đổi chữ khi có "thành" (vd "Đổi chữ thành X"); "sang" thường là đổi bố cục/kiểu
  const rename = /kiểu|inputType|navigateTo|bố cục/i.test(text) ? null : text.match(/(?:đổi|sửa|thay)[^\n]*?thành\s*["“]?([^"”\n]+?)["”]?\s*$/im);
  const setType = text.match(/kiểu\s+(email|password|number|tel|text)\b/i)?.[1];
  const minLen = text.match(/tối thiểu\s+(\d+)\s*ký tự/i)?.[1];
  const addButton = text.match(/thêm\s+(?:nút|button)\s*["“]?([^"”\n,.]+)["”]?/i);
  const addField = /\((?!Input\))[A-Z]\w+\)|ô (tích|chọn|nhập nhiều)/.test(text) ? null : text.match(/thêm\s+(?:ô|trường|field)(?:\s+nhập)?\s*["“]?([^"”\n,.(]+?)["”]?(?=\s*[(,.]|\s+vào|$)/i);
  // "Thêm bộ lọc (Select) "Khách hàng"", "Thêm phân trang (Pagination)", "Thêm Select vào Row"
  const addCols = text.match(/thêm\s+(?:các\s+)?cột\s+["“]?([^"”\n.]+?)["”]?(?=\s+vào|\s*[.]|$)/i)?.[1];
  const addRowActs = text.match(/thêm\s+(?:các\s+)?thao tác\s+([^\n.]+?)(?=\s+vào|\s+cho|\s*[.]|$)/i)?.[1];
  const addRange = /thêm[^.\n]*(khoảng thời gian|từ ngày)/i.test(text);
  const addType = addButton || addField || addCols || addRowActs || addRange ? null : addTypeOf(text);
  const isAdd = /^\s*(thêm|bổ sung)\b/i.test(text);

  for (const id of targets) {
    const n = findNode(tree, id);
    if (!n) continue;
    if (rename) {
      const leaf = firstTextNode(n);
      if (leaf) {
        const key = leaf.props.label !== undefined ? "label" : leaf.props.text !== undefined ? "text" : "title";
        ops.push({ op: "update", id: leaf.id, props: { [key]: rename[1].trim() } });
      }
    }
    if (addButton) {
      // đọc "variant primary" / "action login" nếu prompt có ghi (vd từ gợi ý thành phần)
      const variant = text.match(/variant\s+(primary|secondary|danger|ghost)/i)?.[1] ?? "secondary";
      const label = cap((quoted ?? addButton[1]).replace(/\s+(vào|ở|bên|cho)\s.*$/i, "").trim());
      const action = text.match(/action\s+([a-z_]+)/i)?.[1] ?? (actionOf(label) !== "click" ? actionOf(label) : undefined);
      insertNear(n, { type: "Button", props: { label, variant, ...(action ? { action } : {}) } });
    }
    const table = n.type === "Table" ? n : (isContainer(n.type) ? (n.children ?? []).find((c) => c.type === "Table") : null) ?? (findParent(tree, n.id)?.children ?? []).find((c) => c.type === "Table");
    if ((addCols || addRowActs) && table) {
      const cols = [...((table.props.columns as string[] | undefined) ?? [])];
      const acts = addRowActs ? splitList(addRowActs).map(cap) : [];
      if (addCols) cols.splice(cols.includes("Thao tác") ? cols.indexOf("Thao tác") : cols.length, 0, ...splitList(addCols).map(cap));
      if (acts.length && !cols.includes("Thao tác")) cols.push("Thao tác");
      ops.push({ op: "update", id: table.id, props: { columns: cols, ...(acts.length ? { rowActions: acts } : {}) } });
    }
    if (addRange) {
      insertNear(n, { type: "DatePicker", props: { label: "Từ ngày", name: "from_date" } });
      insertNear(n, { type: "DatePicker", props: { label: "Đến ngày", name: "to_date" } });
    }
    if (addType) {
      const node = defaultNode(addType, quoted ?? labelAfterAlias(text, addType));
      // phân trang đặt ngay sau bảng nếu có
      const table = addType === "Pagination" ? (isContainer(n.type) ? n.children ?? [] : []).find((c) => c.type === "Table") ?? (n.type === "Table" ? n : null) : null;
      if (table) {
        const parent = findParent(tree, table.id)!;
        ops.push({ op: "insert", parentId: parent.id, index: (parent.children ?? []).indexOf(table) + 1, node: { id: newId(), ...node } });
      } else insertNear(n, node);
    }
    if (addField) {
      const label = cap((quoted ?? addField[1]).replace(/\s+(vào|ở|bên|cho)\s.*$/i, "").trim());
      const search = /tìm kiếm/i.test(label);
      insertNear(n, { type: "Input", props: { label, name: search ? "keyword" : snake(label), placeholder: search ? "Nhập từ khóa..." : `Nhập ${label.toLowerCase()}`, ...(setType ? { inputType: setType } : {}), ...(minLen ? { minLength: Number(minLen) } : {}), ...(/bắt buộc/.test(low) ? { required: true } : {}) } });
    }
    if (!isAdd && /\b(xóa|xoá|bỏ|loại bỏ)\b/.test(low) && !addButton && !addField && !addType && !rename && n.id !== tree.id) ops.push({ op: "remove", id: n.id });
    const placeholder = text.match(/placeholder\s+["“]([^"”]+)["”]/i)?.[1];
    const maxLen = text.match(/tối đa\s+(\d+)\s*ký tự/i)?.[1];
    if ((placeholder || maxLen) && !addField) walk(n, (d) => {
      if (d.type === "Input" || d.type === "Textarea") ops.push({ op: "update", id: d.id, props: { ...(placeholder ? { placeholder } : {}), ...(maxLen ? { maxLength: Number(maxLen) } : {}) } });
    });
    if ((setType || minLen) && !addField) walk(n, (d) => {
      if (d.type === "Input") ops.push({ op: "update", id: d.id, props: { ...(setType ? { inputType: setType } : {}), ...(minLen ? { minLength: Number(minLen) } : {}) } });
    });
    if (/bổ sung name/i.test(text)) walk(n, (d) => {
      if (["Input", "Textarea", "Select", "DatePicker", "Checkbox", "Radio"].includes(d.type) && !d.props.name) ops.push({ op: "update", id: d.id, props: { name: snake(String(d.props.label ?? d.id)) } });
    });
    if (/bổ sung action/i.test(text)) walk(n, (d) => {
      if (d.type === "Button" && !d.props.action && !d.props.navigateTo) ops.push({ op: "update", id: d.id, props: { action: snake(String(d.props.label ?? "click")) } });
    });
    if (/bắt buộc/.test(low) && !addField) walk(n, (d) => {
      if (["Input", "Textarea", "Select", "DatePicker", "Radio"].includes(d.type)) ops.push({ op: "update", id: d.id, props: { required: true } });
    });
    if (/màu đỏ|nguy hiểm|danger|cảnh báo/.test(low)) walk(n, (d) => {
      if (d.type === "Button") ops.push({ op: "update", id: d.id, props: { variant: "danger" } });
      if (d.type === "Badge" || d.type === "Alert") ops.push({ op: "update", id: d.id, props: { tone: "danger" } });
    });
    if (/nổi bật|primary|nút chính/.test(low)) walk(n, (d) => {
      if (d.type === "Button") ops.push({ op: "update", id: d.id, props: { variant: "primary" } });
    });
  }
  if (!ops.length) {
    const anchor = findNode(tree, targets[0]) ?? tree;
    insertNear(anchor, { type: "Alert", props: { text: `Ghi chú BA: ${text.slice(0, 160)}`, tone: "info" } });
  }
  return { ops, summary: `Áp dụng ${ops.length} thay đổi (chế độ rule-based)` };

  function insertNear(n: UINode, node: { type: string; props: Record<string, unknown> }) {
    const full = { id: newId(), ...node };
    if (isContainer(n.type)) {
      const kids = n.children ?? [];
      const ref = posRef ? kids.findIndex((c) => String(c.props.label ?? c.props.text ?? c.props.title ?? c.props.alt ?? c.props.name ?? "").slice(0, 40) === posRef[2]) : -1;
      ops.push({ op: "insert", parentId: n.id, ...(ref >= 0 ? { index: ref + (posRef![1] === "sau" ? 1 : 0) } : {}), node: full });
    }
    else {
      const parent = findParent(tree, n.id);
      if (!parent) return;
      const idx = (parent.children ?? []).findIndex((c) => c.id === n.id);
      ops.push({ op: "insert", parentId: parent.id, index: idx + 1, node: full });
    }
  }
}

const TYPE_ALIASES: [RegExp, string][] = [
  [/phân trang/i, "Pagination"], [/bộ lọc|ô chọn(?! ngày)|dropdown|danh sách chọn/i, "Select"], [/ô chọn ngày|chọn ngày|lịch/i, "DatePicker"],
  [/ô nhập nhiều dòng|textarea/i, "Textarea"], [/ô tích|checkbox/i, "Checkbox"], [/tiêu đề/i, "Heading"], [/đoạn mô tả|đoạn văn/i, "Text"],
  [/\blink\b|liên kết/i, "Link"], [/chỉ số/i, "Stat"], [/\bbảng\b/i, "Table"], [/thông báo/i, "Alert"], [/nhãn trạng thái|badge/i, "Badge"], [/hình ảnh|ảnh/i, "Image"],
];

/** Loại component được yêu cầu thêm: ưu tiên tên loại trong ngoặc/viết thẳng, sau đó từ khóa tiếng Việt. */
function addTypeOf(text: string): string | null {
  if (!/\bthêm\b/i.test(text)) return null;
  const named = text.match(/\(([A-Z][A-Za-z]+)\)/)?.[1] ?? text.match(/thêm\s+(?:một\s+)?([A-Z][A-Za-z]+)\b/)?.[1];
  if (named && ALL_TYPES.includes(named) && named !== "Page") return named;
  return TYPE_ALIASES.find(([re]) => re.test(text))?.[1] ?? null;
}

/** Nhãn viết liền sau từ khóa loại: "bộ lọc khách hàng" → "Khách hàng". */
function labelAfterAlias(text: string, type: string): string | undefined {
  const re = TYPE_ALIASES.find(([, t]) => t === type)?.[0];
  const m = re && text.match(new RegExp(`(?:${re.source})\\s+(?:theo\\s+)?([\\p{L}\\d ]+?)(?=\\s+(?:vào|ở|cho|bên|phía|ngay)\\b|\\s*[(,.]|$)`, "iu"));
  const lb = m?.[1]?.trim();
  return lb && lb.length <= 40 ? cap(lb) : undefined;
}

function defaultNode(type: string, label?: string): { type: string; props: Record<string, unknown> } {
  const lb = label?.trim();
  const name = lb ? snake(lb) : undefined;
  switch (type) {
    case "Select": return { type, props: { label: lb ?? "Loại", name: name ?? "loai", options: ["Tất cả"] } };
    case "DatePicker": return { type, props: { label: lb ?? "Ngày", name: name ?? "ngay" } };
    case "Textarea": return { type, props: { label: lb ?? "Mô tả", name: name ?? "mo_ta", placeholder: `Nhập ${(lb ?? "mô tả").toLowerCase()}` } };
    case "Input": return { type, props: { label: lb ?? "Trường mới", name: name ?? "truong_moi", placeholder: `Nhập ${(lb ?? "giá trị").toLowerCase()}` } };
    case "Checkbox": return { type, props: { label: lb ?? "Lựa chọn", name: name ?? "lua_chon" } };
    case "Radio": return { type, props: { label: lb ?? "Lựa chọn", name: name ?? "lua_chon", options: ["Có", "Không"] } };
    case "Pagination": return { type, props: { pages: 5 } };
    case "Stat": return { type, props: { label: lb ?? "Chỉ số", value: "0" } };
    case "Heading": return { type, props: { text: lb ?? "Tiêu đề", level: 2 } };
    case "Text": return { type, props: { text: lb ?? "Mô tả ngắn cho người dùng." } };
    case "Link": return { type, props: { text: lb ?? "Xem thêm" } };
    case "Table": return { type, props: { columns: ["Mã", "Tên", "Trạng thái"], rows: [] } };
    case "Alert": return { type, props: { text: lb ?? "Thông báo", tone: "info" } };
    case "Badge": return { type, props: { text: lb ?? "Mới" } };
    case "Image": return { type, props: { alt: lb ?? "Hình ảnh" } };
    case "Button": return { type, props: { label: lb ?? "Nút mới", variant: "secondary" } };
    default: return { type, props: lb ? { title: lb } : {}, ...(isContainer(type) ? { children: [] } : {}) } as { type: string; props: Record<string, unknown> };
  }
}

function snake(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "field";
}

function firstTextNode(n: UINode): UINode | null {
  let found: UINode | null = null;
  walk(n, (d) => {
    if (!found && (typeof d.props.label === "string" || typeof d.props.text === "string" || (typeof d.props.title === "string" && d.type !== "Page"))) found = d;
  });
  return found;
}

// ------------------------------------------------------------------ Docs
const SUBMIT_WORDS = /^(lưu|gửi|xác nhận|submit|cập nhật|hoàn tất|tiếp tục)$/i;

export function mockActors(requirementInput: string): string[] {
  const actors = new Set<string>();
  for (const m of requirementInput.matchAll(/(?:as an?|là)\s+([\p{L} ]{2,30}?)(?:,|\s+i want|\s+tôi muốn|\s+muốn)/giu)) actors.add(cap(m[1].trim()));
  if (/quản trị|admin/i.test(requirementInput)) actors.add("Quản trị viên");
  if (!actors.size) actors.add("Người dùng");
  return [...actors];
}


export interface MockUcResult {
  useCases: UseCase[];
  requirements: Requirement[];
}

export function mockUseCases(model: DesignModel, requirementInput: string): MockUcResult {
  const actors = mockActors(requirementInput);
  const primary = actors[0];
  const useCases: UseCase[] = [];
  const requirements: Requirement[] = [];
  let uc = 0;
  let fr = 0;
  const ucCode = () => `UC-${String(++uc).padStart(2, "0")}`;
  const frCode = () => `FR-${String(++fr).padStart(2, "0")}`;

  for (const s of model.screens) {
    const mainActions = s.actions.filter((a) => a.variant !== "secondary" && a.variant !== "ghost" && !/hủy|quay lại|cancel/i.test(a.label));
    for (const a of mainActions) {
      const fields = a.formId ? s.fields.filter((f) => s.forms.find((fm) => fm.nodeId === a.formId)?.fieldIds.includes(f.nodeId)) : [];
      const name = SUBMIT_WORDS.test(a.label) ? s.title : a.label === "Thêm mới" ? `Mở màn hình thêm mới (${s.title})` : a.label;
      useCases.push(buildFormUC(ucCode(), name, primary, s, a.nodeId, a.label, a.navigateTo, fields));
    }
    for (const d of s.displays.filter((x) => x.kind === "Table")) {
      const code = ucCode();
      const searchFields = s.fields.filter((f) => !s.forms.some((fm) => fm.fieldIds.includes(f.nodeId)));
      const steps: FlowStep[] = [
        { no: 1, actor: primary, text: `Mở màn hình "${s.title}"`, screenId: s.screenId },
        { no: 2, actor: "Hệ thống", text: `Hiển thị bảng dữ liệu gồm các cột: ${d.columns.join(", ")}`, screenId: s.screenId, nodeId: d.nodeId },
      ];
      if (searchFields.length)
        steps.push({ no: 3, actor: primary, text: `Nhập/chọn điều kiện lọc: ${searchFields.map((f) => f.label).join(", ")}`, screenId: s.screenId, nodeId: searchFields[0].nodeId }, { no: 4, actor: "Hệ thống", text: "Lọc và hiển thị kết quả phù hợp", screenId: s.screenId, nodeId: d.nodeId });
      useCases.push({
        code,
        name: `Xem danh sách – ${s.title}`,
        actors: [primary],
        description: `${primary} xem và tra cứu dữ liệu trên màn hình ${s.title}.`,
        trigger: `${primary} truy cập màn hình ${s.title}`,
        preconditions: [`${primary} đã đăng nhập hệ thống`],
        postconditions: ["Danh sách dữ liệu được hiển thị theo điều kiện lọc"],
        mainFlow: steps,
        altFlows: d.rowActions.map((ra, i) => ({ code: `A${i + 1}`, name: `${ra} một dòng dữ liệu`, branchFrom: 2, steps: [`${primary} chọn "${ra}" tại một dòng`, `Hệ thống thực hiện chức năng ${ra.toLowerCase()}`] })),
        exceptions: [{ code: "E1", name: "Không có dữ liệu phù hợp", branchFrom: steps.length, steps: ["Hệ thống hiển thị thông báo \"Không tìm thấy dữ liệu\""] }],
        businessRules: [],
        screenIds: [s.screenId],
        assumptions: d.rowActions.length ? [`Chưa có thiết kế chi tiết cho các thao tác ${d.rowActions.join(", ")} – cần BA xác nhận`] : [],
      });
    }
  }

  for (const u of useCases) {
    requirements.push({ code: frCode(), type: "FR", statement: `Hệ thống phải cho phép ${u.actors.join(", ")} thực hiện "${u.name}".`, priority: "High", useCaseCodes: [u.code], source: `Màn hình ${u.screenIds.join(", ")}`, isAssumption: false });
    for (const br of u.businessRules) requirements.push({ code: frCode(), type: "FR", statement: `Hệ thống phải kiểm tra: ${br}.`, priority: "Medium", useCaseCodes: [u.code], source: "Ràng buộc trường dữ liệu trên thiết kế", isAssumption: false });
  }
  let nfr = 0;
  const nfrCode = () => `NFR-${String(++nfr).padStart(2, "0")}`;
  requirements.push({ code: nfrCode(), type: "NFR", statement: "Thời gian phản hồi của các thao tác chính không vượt quá 2 giây với 100 người dùng đồng thời.", priority: "Medium", useCaseCodes: useCases.map((u) => u.code), source: "Gợi ý mặc định", isAssumption: true });
  if (model.screens.some((s) => s.fields.some((f) => f.inputType === "password")))
    requirements.push({ code: nfrCode(), type: "NFR", statement: "Mật khẩu phải được lưu dưới dạng băm (bcrypt/argon2), không lưu bản rõ.", priority: "High", useCaseCodes: useCases.filter((u) => model.screens.some((s) => u.screenIds.includes(s.screenId) && s.fields.some((f) => f.inputType === "password"))).map((u) => u.code), source: "Suy ra từ trường mật khẩu", isAssumption: true });
  return { useCases, requirements };

  function buildFormUC(code: string, name: string, actor: string, s: ScreenModel, actionId: string, actionLabel: string, navigateTo: string, fields: FieldSpec[]): UseCase {
    const steps: FlowStep[] = [{ no: 1, actor, text: `Mở màn hình "${s.title}"`, screenId: s.screenId }];
    if (fields.length) {
      steps.push({ no: 2, actor: "Hệ thống", text: `Hiển thị biểu mẫu gồm: ${fields.map((f) => f.label).join(", ")}`, screenId: s.screenId });
      steps.push({ no: 3, actor, text: `Nhập thông tin ${fields.map((f) => f.label).join(", ")}`, screenId: s.screenId, nodeId: fields[0].nodeId });
    }
    steps.push({ no: steps.length + 1, actor, text: `Nhấn nút "${actionLabel}"`, screenId: s.screenId, nodeId: actionId });
    if (fields.length) steps.push({ no: steps.length + 1, actor: "Hệ thống", text: "Kiểm tra tính hợp lệ của dữ liệu nhập" });
    steps.push({ no: steps.length + 1, actor: "Hệ thống", text: navigateTo ? `Xử lý yêu cầu và chuyển tới màn hình "${navigateTo}"` : "Xử lý yêu cầu và hiển thị thông báo thành công" });
    const validateStep = steps.find((x) => x.text.startsWith("Kiểm tra"))?.no ?? steps.length;
    const exceptions: AltFlow[] = [];
    const req = fields.filter((f) => f.required);
    if (req.length) exceptions.push({ code: `E${exceptions.length + 1}`, name: "Bỏ trống trường bắt buộc", branchFrom: validateStep, steps: [`Hệ thống báo lỗi tại các trường bắt buộc: ${req.map((f) => f.label).join(", ")}`, "Quay lại bước nhập thông tin"] });
    const constrained = fields.filter((f) => f.constraints.length);
    if (constrained.length) exceptions.push({ code: `E${exceptions.length + 1}`, name: "Dữ liệu không đúng định dạng/giới hạn", branchFrom: validateStep, steps: [`Hệ thống báo lỗi định dạng tại: ${constrained.map((f) => f.label).join(", ")}`, "Quay lại bước nhập thông tin"] });
    exceptions.push({ code: `E${exceptions.length + 1}`, name: "Lỗi hệ thống khi xử lý", branchFrom: steps.length, steps: ["Hệ thống hiển thị thông báo lỗi và giữ nguyên dữ liệu đã nhập"] });
    const altFlows: AltFlow[] = s.links.map((l, i) => ({ code: `A${i + 1}`, name: l.text, branchFrom: Math.min(3, steps.length), steps: [`${actor} chọn "${l.text}"`, l.navigateTo ? `Hệ thống chuyển tới màn hình "${l.navigateTo}"` : "Hệ thống xử lý liên kết"] }));
    const cancel = s.actions.find((a) => /hủy|cancel|quay lại/i.test(a.label));
    if (cancel) altFlows.push({ code: `A${altFlows.length + 1}`, name: `Nhấn "${cancel.label}"`, branchFrom: Math.min(3, steps.length), steps: [`${actor} nhấn "${cancel.label}"`, `Hệ thống hủy thao tác${cancel.navigateTo ? ` và quay về "${cancel.navigateTo}"` : ""}`] });
    const businessRules = fields.flatMap((f) => [...(f.required ? [`${f.label} là bắt buộc`] : []), ...f.constraints.map((c) => `${f.label}: ${c}`)]);
    return {
      code,
      name,
      actors: [actor],
      description: `${actor} thực hiện "${name}" trên màn hình ${s.title}.`,
      trigger: `${actor} nhấn "${actionLabel}"`,
      preconditions: [/đăng nhập|đăng ký|login|register/i.test(`${name} ${s.title} ${actionLabel} ${s.actions.find((x) => x.nodeId === actionId)?.action ?? ""}`) ? `${actor} chưa đăng nhập` : `${actor} đã đăng nhập hệ thống`],
      postconditions: [navigateTo ? `Hệ thống hiển thị màn hình "${navigateTo}"` : "Dữ liệu được lưu thành công"],
      mainFlow: steps,
      altFlows,
      exceptions,
      businessRules,
      screenIds: [s.screenId],
      assumptions: [`Quy tắc xử lý phía máy chủ cho "${actionLabel}" chưa thể hiện trên thiết kế – cần BA xác nhận`],
    };
  }
}

export function mockSrs(moduleName: string, requirementInput: string, model: DesignModel, ucs: UseCase[], reqs: Requirement[]): SrsDoc {
  const actors = [...new Set(ucs.flatMap((u) => u.actors))];
  const frs = reqs.filter((r) => r.type === "FR");
  const nfrs = reqs.filter((r) => r.type === "NFR");
  const fields = model.screens.flatMap((s) => s.fields.map((f) => ({ ...f, screen: s.title })));
  return {
    sections: [
      { key: "intro", title: "1. Giới thiệu", content: `### 1.1 Mục đích\nTài liệu đặc tả yêu cầu phần mềm (SRS) cho module **${moduleName}**, được sinh tự động từ thiết kế giao diện đã duyệt và cần BA rà soát.\n\n### 1.2 Phạm vi\n${requirementInput.trim() || "Phạm vi được xác định theo các màn hình đã thiết kế."}\n\n### 1.3 Tài liệu tham chiếu\n- ISO/IEC/IEEE 29148:2018 – Requirements engineering\n- Đặc tả Use Case của module` },
      { key: "overview", title: "2. Mô tả tổng quan", content: `### 2.1 Tác nhân\n${actors.map((a) => `- ${a}`).join("\n")}\n\n### 2.2 Danh sách màn hình\n${model.screens.map((s) => `- ${s.title}`).join("\n")}\n\n### 2.3 Điều hướng\n${model.navigation.length ? model.navigation.map((n) => `- ${n.from} → ${n.to} (qua "${n.via}")`).join("\n") : "- Chưa có liên kết điều hướng"}` },
      { key: "functional", title: "3. Yêu cầu chức năng", content: `| Mã | Yêu cầu | Ưu tiên | Use Case |\n| --- | --- | --- | --- |\n${frs.map((r) => `| ${r.code} | ${r.statement} | ${r.priority} | ${r.useCaseCodes.join(", ")} |`).join("\n")}` },
      { key: "nonfunctional", title: "4. Yêu cầu phi chức năng", content: `${nfrs.map((r) => `- **${r.code}**: ${r.statement}${r.isAssumption ? " _(Giả định – cần xác nhận)_" : ""}`).join("\n") || "- Chưa xác định"}` },
      { key: "interfaces", title: "5. Giao diện người dùng", content: model.screens.map((s) => `### ${s.title}\n- Trường dữ liệu: ${s.fields.map((f) => f.label).join(", ") || "không có"}\n- Thao tác: ${s.actions.map((a) => a.label).join(", ") || "không có"}`).join("\n\n") },
      { key: "data", title: "6. Từ điển dữ liệu", content: `| Màn hình | Trường | Kiểu | Bắt buộc | Ràng buộc |\n| --- | --- | --- | --- | --- |\n${fields.map((f) => `| ${f.screen} | ${f.label} | ${f.inputType} | ${f.required ? "Có" : "Không"} | ${f.constraints.join("; ") || "-"} |`).join("\n")}` },
      { key: "assumptions", title: "7. Giả định và vấn đề mở", content: [...new Set(ucs.flatMap((u) => u.assumptions))].map((a) => `- ${a}`).join("\n") || "- Không có" },
    ],
  };
}

export function mockSequence(uc: UseCase, screenTitle: (id: string) => string): SequenceDiagram {
  const actor = uc.actors[0] ?? "Người dùng";
  const ui = uc.screenIds[0] ? screenTitle(uc.screenIds[0]) : "Giao diện";
  const lines = ["sequenceDiagram", "  autonumber", `  actor A as ${safe(actor)}`, `  participant UI as ${safe(ui)}`, "  participant API as Máy chủ API", "  participant DB as Cơ sở dữ liệu"];
  for (const s of uc.mainFlow) {
    if (s.actor === "Hệ thống") {
      if (/kiểm tra/i.test(s.text)) lines.push(`  UI->>API: Gửi yêu cầu`, `  API->>API: ${safe(s.text)}`);
      else if (/xử lý|lưu|lọc/i.test(s.text)) lines.push(`  API->>DB: Truy vấn/cập nhật dữ liệu`, `  DB-->>API: Kết quả`, `  API-->>UI: Phản hồi`, `  UI-->>A: ${safe(s.text)}`);
      else lines.push(`  UI-->>A: ${safe(s.text)}`);
    } else lines.push(`  A->>UI: ${safe(s.text)}`);
  }
  if (uc.exceptions.length) {
    lines.push(`  alt ${safe(uc.exceptions[0].name)}`);
    for (const st of uc.exceptions[0].steps) lines.push(`    UI-->>A: ${safe(st)}`);
    lines.push("  end");
  }
  return { useCaseCode: uc.code, title: `${uc.code} – ${uc.name}`, mermaid: lines.join("\n") };
}

/** Mermaid không chấp nhận một số ký tự trong nhãn. */
export function safe(s: string): string {
  return s.replace(/[;#:]/g, " ").replace(/"/g, "'").replace(/\s+/g, " ").trim().slice(0, 90);
}

export function mockTests(ucs: UseCase[], reqs: Requirement[], model: DesignModel): TestCase[] {
  const tests: TestCase[] = [];
  let n = 0;
  const code = () => `TC-${String(++n).padStart(3, "0")}`;
  const fieldsById = new Map(model.screens.flatMap((s) => s.fields.map((f) => [f.nodeId, f] as const)));
  for (const u of ucs) {
    const ucReqs = reqs.filter((r) => r.type === "FR" && r.useCaseCodes.includes(u.code));
    const mainReq = ucReqs.slice(0, 1).map((r) => r.code);
    const pre = u.preconditions.join("; ");
    const ucFields = model.screens.filter((s) => u.screenIds.includes(s.screenId)).flatMap((s) => s.fields);
    const sample = ucFields.map((f) => `${f.label} = ${sampleValue(f)}`).join("; ");
    tests.push({ code: code(), title: `${u.name} – luồng chính thành công`, type: "Positive", priority: "High", useCaseCode: u.code, flowRef: "main", requirementCodes: mainReq, preconditions: pre, testData: sample || "-", steps: u.mainFlow.filter((s) => s.actor !== "Hệ thống").map((s) => s.text), expected: u.postconditions.join("; ") });
    for (const a of u.altFlows) tests.push({ code: code(), title: `${u.name} – ${a.name}`, type: "Positive", priority: "Medium", useCaseCode: u.code, flowRef: a.code, requirementCodes: mainReq, preconditions: pre, testData: "-", steps: a.steps.filter((s) => !s.startsWith("Hệ thống")), expected: a.steps.filter((s) => s.startsWith("Hệ thống")).join("; ") || "Hệ thống xử lý đúng luồng thay thế" });
    for (const e of u.exceptions) {
      const rules = ucReqs.filter((r) => r.statement.includes("kiểm tra"));
      const ruleReqs = (/bắt buộc/i.test(e.name) ? rules.filter((r) => r.statement.includes("bắt buộc")) : /định dạng/i.test(e.name) ? rules.filter((r) => !r.statement.includes("bắt buộc")) : []).map((r) => r.code);
      tests.push({ code: code(), title: `${u.name} – ${e.name}`, type: "Negative", priority: "High", useCaseCode: u.code, flowRef: e.code, requirementCodes: ruleReqs.length ? ruleReqs : mainReq, preconditions: pre, testData: /bắt buộc/i.test(e.name) ? "Để trống các trường bắt buộc" : /định dạng/i.test(e.name) ? "Nhập dữ liệu sai định dạng/vượt giới hạn" : "Giả lập lỗi máy chủ", steps: [...u.mainFlow.filter((s) => s.actor !== "Hệ thống").map((s) => s.text)], expected: e.steps.join("; ") });
    }
    // Giá trị biên cho trường có minLength/maxLength
    for (const f of ucFields) {
      const field = fieldsById.get(f.nodeId) ?? f;
      const min = num(field.constraints, "minLength");
      const max = num(field.constraints, "maxLength");
      const brCode = ucReqs.find((r) => r.statement.includes(field.label) && r.statement.includes("Length"))?.code;
      const refs = brCode ? [brCode] : mainReq;
      if (min !== null) {
        tests.push({ code: code(), title: `${field.label} – độ dài ${min - 1} ký tự (dưới biên)`, type: "Boundary", priority: "Medium", useCaseCode: u.code, flowRef: u.exceptions.find((e) => /định dạng/i.test(e.name))?.code ?? "main", requirementCodes: refs, preconditions: pre, testData: `${field.label} có ${min - 1} ký tự`, steps: [`Nhập ${field.label} có ${min - 1} ký tự`, "Gửi biểu mẫu"], expected: `Hệ thống báo lỗi: ${field.label} tối thiểu ${min} ký tự` });
        tests.push({ code: code(), title: `${field.label} – độ dài ${min} ký tự (đúng biên)`, type: "Boundary", priority: "Medium", useCaseCode: u.code, flowRef: "main", requirementCodes: refs, preconditions: pre, testData: `${field.label} có ${min} ký tự`, steps: [`Nhập ${field.label} có ${min} ký tự`, "Gửi biểu mẫu"], expected: "Hệ thống chấp nhận giá trị" });
      }
      if (max !== null) {
        tests.push({ code: code(), title: `${field.label} – độ dài ${max + 1} ký tự (vượt biên)`, type: "Boundary", priority: "Medium", useCaseCode: u.code, flowRef: u.exceptions.find((e) => /định dạng/i.test(e.name))?.code ?? "main", requirementCodes: refs, preconditions: pre, testData: `${field.label} có ${max + 1} ký tự`, steps: [`Nhập ${field.label} có ${max + 1} ký tự`, "Gửi biểu mẫu"], expected: `Hệ thống chặn/báo lỗi: ${field.label} tối đa ${max} ký tự` });
      }
    }
  }
  return tests;
}

function num(constraints: string[], key: string): number | null {
  const c = constraints.find((x) => x.startsWith(`${key}=`));
  return c ? Number(c.split("=")[1]) : null;
}

function sampleValue(f: FieldSpec): string {
  if (f.inputType === "email") return "ba.test@congty.vn";
  if (f.inputType === "password") return "MatKhau@123";
  if (f.inputType === "tel") return "0912345678";
  if (f.inputType === "number") return "10";
  if (f.inputType === "date") return "15/10/2026";
  if (f.options?.length) return f.options[0];
  if (f.kind === "Checkbox") return "Đã tích";
  return `${f.label} mẫu`;
}
