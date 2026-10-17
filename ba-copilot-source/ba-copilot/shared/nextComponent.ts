// Gợi ý thành phần UI tiếp theo: mô hình n-gram trên cây (stupid backoff) + bộ luật thiếu sót.
// Đặt bài toán theo Li et al. (2020, arXiv:2001.05308): hoàn thiện cây giao diện đang dựng dở,
// dự đoán con kế tiếp dựa vào cha, anh em liền trước và ông. "Huấn luyện" = đếm tần suất.

import { ALL_TYPES, findNode, findParent, isContainer, nodeLabel, regionIds, UINode, walk } from "./design.ts";
import { predictSlots, Subtype, TransformerModel } from "./transformer.ts";

export const END = "<END>";
export const START = "<START>";
export const ROOT = "<ROOT>";
export const MIN_COUNT = 5;
export const BACKOFF = 0.4;
export const ADD_MIN_P = 0.15;
export const SURPRISAL_REVIEW = 6;
/** Container bố cục thường được đặt tự do – không đánh dấu "Xem lại". */
const LAYOUT_TYPES = new Set(["Card", "Section", "Row", "Column", "Header", "Sidebar"]);
const OUTCOMES = [...ALL_TYPES, END];
const CONTROL_TYPES = new Set(["Stat", "Input", "Textarea", "Select", "DatePicker", "Checkbox", "Radio", "Button", "Link"]);

type Table = Record<string, Record<string, number>>;

export interface NGramModel {
  version: 1;
  counts: { tri: Table; bi: Table; uni: Table; all: Record<string, number> };
  meta: { trees: number; events: number; sources: Record<string, number>; builtAt: string };
}

export function emptyModel(): NGramModel {
  return { version: 1, counts: { tri: {}, bi: {}, uni: {}, all: {} }, meta: { trees: 0, events: 0, sources: {}, builtAt: new Date().toISOString() } };
}

const add = (t: Table, key: string, x: string, w: number) => {
  const row = (t[key] ??= {});
  row[x] = (row[x] ?? 0) + w;
};
const sum = (row: Record<string, number> | undefined) => (row ? Object.values(row).reduce((a, b) => a + b, 0) : 0);

/** Ngữ cảnh của một vị trí con: (loại ông, loại cha, loại anh em liền trước). */
export interface Ctx {
  g: string;
  p: string;
  s: string;
}

/** Cộng dồn số đếm của một cây vào mô hình (có trọng số). */
export function countTree(model: NGramModel, tree: UINode, weight = 1, source = "unknown"): NGramModel {
  const { tri, bi, uni, all } = model.counts;
  const emit = (c: Ctx, x: string) => {
    add(tri, `${c.g}|${c.p}|${c.s}`, x, weight);
    add(bi, `${c.p}|${c.s}`, x, weight);
    add(uni, c.p, x, weight);
    all[x] = (all[x] ?? 0) + weight;
    model.meta.events += weight;
  };
  walk(tree, (n, parent) => {
    if (!isContainer(n.type)) return;
    const g = parent?.type ?? ROOT;
    let s = START;
    for (const c of n.children ?? []) {
      emit({ g, p: n.type, s }, c.type);
      s = c.type;
    }
    emit({ g, p: n.type, s }, END);
  });
  model.meta.trees += 1;
  model.meta.sources[source] = (model.meta.sources[source] ?? 0) + 1;
  return model;
}

/** Gộp b vào a (trọng số wb). Trả về a. */
export function mergeModels(a: NGramModel, b: NGramModel, wb = 1): NGramModel {
  for (const k of ["tri", "bi", "uni"] as const) for (const [key, row] of Object.entries(b.counts[k])) for (const [x, c] of Object.entries(row)) add(a.counts[k], key, x, c * wb);
  for (const [x, c] of Object.entries(b.counts.all)) a.counts.all[x] = (a.counts.all[x] ?? 0) + c * wb;
  a.meta.trees += b.meta.trees;
  a.meta.events += b.meta.events * wb;
  for (const [s, n] of Object.entries(b.meta.sources)) a.meta.sources[s] = (a.meta.sources[s] ?? 0) + n;
  return a;
}

/** Xác suất mức chung, làm mượt Laplace (+1) trên 28 loại + <END> – không bao giờ bằng 0. */
export function allProb(model: NGramModel, x: string): number {
  return ((model.counts.all[x] ?? 0) + 1) / (sum(model.counts.all) + OUTCOMES.length);
}

/** Điểm stupid backoff (Brants et al. 2007): dùng ngữ cảnh dài nhất có đủ dữ liệu, lùi dần ×0.4. */
export function prob(model: NGramModel, ctx: Ctx, x: string): number {
  const levels: Record<string, number>[] = [model.counts.tri[`${ctx.g}|${ctx.p}|${ctx.s}`], model.counts.bi[`${ctx.p}|${ctx.s}`], model.counts.uni[ctx.p]];
  let factor = 1;
  for (const row of levels) {
    const total = sum(row);
    if (total >= MIN_COUNT && row[x]) return factor * (row[x] / total);
    factor *= BACKOFF;
  }
  return factor * allProb(model, x);
}

/** Ngữ cảnh để đoán con kế tiếp ở cuối một container. */
export function ctxForAppend(tree: UINode, containerId: string): Ctx | null {
  const n = findNode(tree, containerId);
  if (!n || !isContainer(n.type)) return null;
  const kids = n.children ?? [];
  return { g: findParent(tree, n.id)?.type ?? ROOT, p: n.type, s: kids.length ? kids[kids.length - 1].type : START };
}

/** Top-k loại component có thể thêm vào cuối container (bỏ <END>). */
export function predictNext(model: NGramModel, tree: UINode, containerId: string, k = 5): { type: string; p: number }[] {
  const ctx = ctxForAppend(tree, containerId);
  if (!ctx) return [];
  return rankTypes(model, ctx, k);
}

export function rankTypes(model: NGramModel, ctx: Ctx, k = 5): { type: string; p: number }[] {
  return ALL_TYPES.filter((t) => t !== "Page")
    .map((type) => ({ type, p: prob(model, ctx, type) }))
    .sort((a, b) => b.p - a.p)
    .slice(0, k);
}

/** Độ "lạ" của node trong ngữ cảnh: −log2 P(loại thực tế | ngữ cảnh). Node gốc trả 0. */
export function surprisal(model: NGramModel, tree: UINode, nodeId: string): number {
  const parent = findParent(tree, nodeId);
  const n = findNode(tree, nodeId);
  if (!parent || !n) return 0;
  const kids = parent.children ?? [];
  const i = kids.findIndex((c) => c.id === nodeId);
  const ctx = { g: findParent(tree, parent.id)?.type ?? ROOT, p: parent.type, s: i > 0 ? kids[i - 1].type : START };
  return -Math.log2(prob(model, ctx, n.type));
}

/** Baseline cho đánh giá: luôn đoán loại phổ biến nhất. */
export function baselinePredict(model: NGramModel): string {
  let best = "Text";
  let bestC = -1;
  for (const [x, c] of Object.entries(model.counts.all)) if (x !== END && c > bestC) (best = x), (bestC = c);
  return best;
}

// ------------------------------------------------------------------ Bộ luật thiếu sót
export interface Finding {
  nodeId: string;
  code: string;
  message: string;
  severity: 1 | 2 | 3;
  fixPrompt: string;
}

export interface RuleCtx {
  openAnnotationNodeIds?: string[];
}

type Rule = (tree: UINode, ctx: RuleCtx) => Finding[];

const FIELD_TYPES = ["Input", "Textarea", "Select", "DatePicker"];
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();
const label = (n: UINode) => String(n.props.label ?? n.props.text ?? "");

const each = (tree: UINode, fn: (n: UINode) => Finding | Finding[] | null | undefined): Finding[] => {
  const out: Finding[] = [];
  walk(tree, (n) => {
    const r = fn(n);
    if (Array.isArray(r)) out.push(...r);
    else if (r) out.push(r);
  });
  return out;
};

export const RULES: Rule[] = [
  // R1 trường nhập thiếu name / thiếu required khi nhãn ghi bắt buộc
  (t) =>
    each(t, (n) => {
      if (!FIELD_TYPES.includes(n.type)) return null;
      const lb = label(n);
      if (/bắt buộc|\*/i.test(lb) && !n.props.required)
        return { nodeId: n.id, code: "R1", message: `"${lb}" ghi bắt buộc nhưng chưa đặt required`, severity: 2, fixPrompt: `Đặt trường "${lb}" là bắt buộc.` };
      if (!n.props.name) return { nodeId: n.id, code: "R1", message: `Trường "${lb}" chưa có name`, severity: 1, fixPrompt: `Bổ sung name (snake_case) cho trường "${lb}".` };
      return null;
    }),
  // R2 email / mật khẩu sai kiểu hoặc thiếu ràng buộc
  (t) =>
    each(t, (n) => {
      if (n.type !== "Input") return null;
      const lb = label(n);
      if (/email/i.test(lb) && n.props.inputType !== "email")
        return { nodeId: n.id, code: "R2", message: `"${lb}" nên dùng inputType email`, severity: 2, fixPrompt: `Đặt trường "${lb}" kiểu email, bắt buộc.` };
      if (/mật khẩu|password/i.test(lb) && (n.props.inputType !== "password" || n.props.minLength === undefined))
        return { nodeId: n.id, code: "R2", message: `"${lb}" cần inputType password và minLength`, severity: 2, fixPrompt: `Đặt trường "${lb}" kiểu password, bắt buộc, tối thiểu 8 ký tự.` };
      return null;
    }),
  // R3 Form không có nút gửi
  (t) =>
    each(t, (n) => {
      if (n.type !== "Form") return null;
      let hasBtn = false;
      walk(n, (d) => (hasBtn ||= d.type === "Button"));
      if (hasBtn) return null;
      const b = submitLabel(t, n);
      return { nodeId: n.id, code: "R3", message: "Form chưa có nút gửi", severity: 3, fixPrompt: `Thêm nút "${b.label}" (variant primary, action ${b.action}) vào cuối form này.` };
    }),
  // R4 nút không có hành động
  (t) =>
    each(t, (n) =>
      n.type === "Button" && !n.props.action && !n.props.navigateTo
        ? { nodeId: n.id, code: "R4", message: `Nút "${label(n)}" chưa có action/navigateTo`, severity: 1, fixPrompt: `Bổ sung action cho nút "${label(n)}".` }
        : null,
    ),
  // R5 bảng thiếu cột
  (t) =>
    each(t, (n) =>
      n.type === "Table" && (!Array.isArray(n.props.columns) || !(n.props.columns as unknown[]).length)
        ? { nodeId: n.id, code: "R5", message: "Bảng chưa có cột", severity: 2, fixPrompt: "Bổ sung danh sách cột cho bảng này." }
        : null,
    ),
  // R8 trường nhập chưa có placeholder hướng dẫn
  (t) =>
    each(t, (n) => {
      if ((n.type !== "Input" && n.type !== "Textarea") || n.props.placeholder) return null;
      const lb = label(n);
      return { nodeId: n.id, code: "R8", message: `Trường "${lb}" chưa có placeholder`, severity: 1, fixPrompt: `Thêm placeholder "Nhập ${lb.toLowerCase()}" cho trường "${lb}".` };
    }),
  // R9 ô nhập chữ chưa giới hạn độ dài
  (t) =>
    each(t, (n) => {
      if (n.type !== "Input" || n.props.maxLength !== undefined) return null;
      if (/tìm kiếm|search|keyword/i.test(`${n.props.label ?? ""} ${n.props.name ?? ""}`)) return null; // ô tìm kiếm không cần
      const kind = String(n.props.inputType ?? "text");
      if (!["text", "email", "tel", "password"].includes(kind)) return null;
      const max = kind === "password" ? 32 : kind === "tel" ? 15 : 100;
      return { nodeId: n.id, code: "R9", message: `Trường "${label(n)}" chưa giới hạn độ dài`, severity: 1, fixPrompt: `Đặt trường "${label(n)}" tối đa ${max} ký tự.` };
    }),
  // R7 node còn bình luận chưa xử lý
  (t, ctx) => {
    const open = new Set(ctx.openAnnotationNodeIds ?? []);
    return each(t, (n) => (open.has(n.id) ? { nodeId: n.id, code: "R7", message: `${nodeLabel(n)} còn bình luận chưa xử lý`, severity: 2, fixPrompt: "Xử lý bình luận đang mở của phần tử này." } : null));
  },
];

export function ruleFindings(tree: UINode, ctx: RuleCtx = {}): Finding[] {
  return RULES.flatMap((r) => r(tree, ctx));
}

// ------------------------------------------------------------------ Xếp hạng gợi ý
export interface Suggestion {
  id: string;
  kind: "add" | "fix" | "review";
  targetNodeId: string;
  title: string;
  reason: string;
  confidence: number;
  fixPrompt: string;
}

export interface SuggestOptions extends RuleCtx {
  selectedIds?: string[];
  k?: number;
}

// ------------------------------------------------------------------ Câu gợi ý theo ngữ cảnh
const has = (texts: string[], re: RegExp) => texts.some((t) => re.test(t));

/** Gom chữ trong container và tiêu đề màn để đoán mục đích (đăng nhập, đăng ký, tìm kiếm...). */
function contextTexts(tree: UINode, container: UINode): string[] {
  const out = [String(tree.props.title ?? ""), String(container.props.title ?? "")];
  walk(container, (d) => out.push(String(d.props.label ?? d.props.text ?? d.props.title ?? "")));
  return out.map((t) => t.toLowerCase());
}

/** Nhãn nút gửi phù hợp với mục đích của form. */
export function submitLabel(tree: UINode, container: UINode): { label: string; action: string } {
  const t = contextTexts(tree, container);
  const pw = has(t, /mật khẩu|password/);
  if (has(t, /đổi mật khẩu|mật khẩu (cũ|hiện tại)/)) return { label: "Đổi mật khẩu", action: "change_password" };
  if (has(t, /xác nhận mật khẩu|đăng ký|register|sign up/)) return { label: "Đăng ký", action: "register" };
  if (has(t, /quên mật khẩu|đặt lại/) && !has(t, /^mật khẩu$/)) return { label: "Gửi liên kết", action: "send_reset" };
  if (pw && has(t, /email|tên đăng nhập|username|tài khoản/)) return { label: "Đăng nhập", action: "login" };
  if (has(t, /tìm kiếm|tra cứu|search|lọc/)) return { label: "Tìm kiếm", action: "search" };
  if (has(t, /thanh toán|checkout/)) return { label: "Đặt hàng", action: "checkout" };
  if (has(t, /chỉnh sửa|cập nhật/)) return { label: "Cập nhật", action: "update" };
  if (has(t, /^gửi|yêu cầu|phản hồi|liên hệ|góp ý/)) return { label: "Gửi", action: "submit" };
  return { label: "Lưu", action: "save" };
}

/** Trường còn thiếu hợp lý nhất cho form. */
function missingField(tree: UINode, container: UINode): { label: string; extra: string } {
  const t = contextTexts(tree, container);
  if (has(t, /email/) && !has(t, /mật khẩu|password/) && !has(t, /quên/)) return { label: "Mật khẩu", extra: "bắt buộc, kiểu password, tối thiểu 8 ký tự" };
  if (has(t, /^mật khẩu/) && has(t, /đăng ký/) && !has(t, /xác nhận mật khẩu/)) return { label: "Xác nhận mật khẩu", extra: "bắt buộc, kiểu password" };
  if (has(t, /tìm kiếm|tra cứu/)) return { label: "Từ khóa", extra: "không bắt buộc" };
  return { label: "Ghi chú", extra: "không bắt buộc" };
}

/** Câu prompt cụ thể cho gợi ý "Thêm <type>" vào container (dùng thẳng cho "Sửa vùng đã khoanh"). */
export function addPrompt(tree: UINode, container: UINode, type: string): string {
  const where = nodeLabel(container);
  const kids = container.children ?? [];
  switch (type) {
    case "Button": {
      if (container.type === "Form" || kids.some((k) => FIELD_TYPES.includes(k.type))) {
        const b = submitLabel(tree, container);
        return `Thêm nút "${b.label}" (variant primary, action ${b.action}) vào cuối ${where}.`;
      }
      const parent = findParent(tree, container.id);
      if ((parent?.children ?? []).some((c) => c.type === "Table")) return `Thêm nút "Thêm mới" (variant primary, action create) vào cuối ${where}.`;
      return `Thêm nút "Xem chi tiết" (variant secondary) vào cuối ${where}.`;
    }
    case "Input": {
      const f = missingField(tree, container);
      return `Thêm trường "${f.label}" (${f.extra}) vào cuối ${where}.`;
    }
    case "Link":
      return has(contextTexts(tree, container), /mật khẩu|password/) ? `Thêm link "Quên mật khẩu?" vào cuối ${where}.` : `Thêm một Link điều hướng phù hợp vào cuối ${where}.`;
    case "Select": {
      // thanh lọc cạnh bảng: gợi ý lọc theo cột chưa có bộ lọc
      const table = (findParent(tree, container.id)?.children ?? []).find((c) => c.type === "Table");
      const have = new Set(kids.map((k) => String(k.props.label ?? "").toLowerCase()));
      const col = ((table?.props.columns as string[] | undefined) ?? []).find((c) => !have.has(c.toLowerCase()) && !/^(mã|thao tác|stt)|tiền|giá|số lượng|ngày/i.test(c));
      return col ? `Thêm bộ lọc (Select) "${col}" vào cuối ${where}.` : `Thêm ô chọn (Select) "Loại" vào cuối ${where}.`;
    }
    case "DatePicker":
      return `Thêm ô chọn ngày (DatePicker) "${kids.some((k) => k.type === "DatePicker") ? "Đến ngày" : container.type === "Row" ? "Từ ngày" : "Ngày"}" vào cuối ${where}.`;
    case "Textarea":
      return `Thêm ô nhập nhiều dòng (Textarea) "${kids.some((k) => /mô tả/i.test(String(k.props.label ?? ""))) ? "Ghi chú" : "Mô tả"}" vào cuối ${where}.`;
    case "Stat":
      return `Thêm chỉ số (Stat) "${kids.some((k) => /doanh thu/i.test(String(k.props.label ?? ""))) ? "Tỷ lệ chuyển đổi" : "Tổng số"}" vào cuối ${where}.`;
    case "Pagination":
      return `Thêm phân trang (Pagination) ngay sau bảng trong ${where}.`;
    case "Heading":
      return `Thêm tiêu đề (Heading) mô tả nội dung của ${where}.`;
    case "Text":
      return `Thêm đoạn mô tả ngắn (Text) hướng dẫn người dùng trong ${where}.`;
    case "Checkbox":
      return has(contextTexts(tree, container), /mật khẩu/) ? `Thêm ô tích "Ghi nhớ đăng nhập" vào ${where}.` : `Thêm ô tích (Checkbox) phù hợp vào ${where}.`;
    default:
      return `Thêm ${type} vào cuối ${where}.`;
  }
}

/** Mô tả ngữ cảnh n-gram cho người đọc: "Sau Input trong Form". */
function ctxText(ctx: Ctx | null): string {
  if (!ctx) return "";
  return ctx.s === START ? `Đầu ${ctx.p}` : `Sau ${ctx.s} trong ${ctx.p}`;
}

// ------------------------------------------------------------------ Gợi ý từ Transformer
/**
 * Ngưỡng điểm = P(thiếu tại ô) × P(loại | thiếu) để hiện gợi ý "Thêm" (chọn theo scripts/eval-transformer.ts:
 * ở 0,3 trên màn nghiệp vụ hoàn chỉnh chỉ ~9% có gợi ý thừa, vẫn bắt ~54% phần tử bị xóa đúng vị trí + loại).
 * Khi BA đã khoanh vùng (chủ động hỏi) dùng ngưỡng thấp hơn.
 */
export const TF_ADD_MIN = 0.3;
export const TF_ADD_MIN_REGION = 0.15;

/** Cụm vị trí cho câu prompt: "vào cuối Form" / "vào Form, ngay sau Input "Email"" / "vào Form, ngay trước Button "Lưu"". */
function positionPhrase(container: UINode, index: number): { prompt: string; short: string } {
  const kids = container.children ?? [];
  const where = nodeLabel(container);
  if (index >= kids.length) return { prompt: `vào cuối ${where}`, short: `vào cuối ${where}` };
  if (index > 0) return { prompt: `vào ${where}, ngay sau ${nodeLabel(kids[index - 1])}`, short: `sau ${nodeLabel(kids[index - 1])}` };
  return { prompt: `vào ${where}, ngay trước ${nodeLabel(kids[0])}`, short: `trước ${nodeLabel(kids[0])}` };
}

const SUB_VI: Partial<Record<Subtype, string>> = {
  email: "email", password: "mật khẩu", search: "tìm kiếm", phone: "số điện thoại", number: "số", name: "tên",
  submit: "gửi", cancel: "hủy", create: "thêm mới", delete: "xóa", auth: "tài khoản", remember: "ghi nhớ", agree: "đồng ý",
};

/** Câu prompt "Thêm …" cụ thể theo loại + loại con mà Transformer dự đoán, kèm vị trí chèn. Null nếu phần tử đó đã có. */
export function typedAddPrompt(tree: UINode, container: UINode, type: string, sub: Subtype, index: number): string | null {
  const kids = container.children ?? [];
  const labels = kids.map((k) => String(k.props.label ?? k.props.text ?? "").toLowerCase());
  const hasLabel = (re: RegExp) => labels.some((l) => re.test(l));
  const pos = positionPhrase(container, index).prompt;
  const ctx = contextTexts(tree, container);
  switch (`${type}:${sub}`) {
    case "Input:email":
      return hasLabel(/email/) ? null : `Thêm trường "Email" (kiểu email, bắt buộc) ${pos}.`;
    case "Input:password":
      if (hasLabel(/xác nhận mật khẩu/) || (hasLabel(/mật khẩu/) && !has(ctx, /đăng ký|register|mật khẩu mới/))) return null;
      return hasLabel(/mật khẩu/) ? `Thêm trường "Xác nhận mật khẩu" (bắt buộc, kiểu password) ${pos}.` : `Thêm trường "Mật khẩu" (bắt buộc, kiểu password, tối thiểu 8 ký tự) ${pos}.`;
    case "Input:search":
      return hasLabel(/tìm kiếm|từ khóa/) ? null : `Thêm ô tìm kiếm (Input) "Tìm kiếm" ${pos}.`;
    case "Input:phone":
      return hasLabel(/điện thoại/) ? null : `Thêm trường "Số điện thoại" (kiểu tel) ${pos}.`;
    case "Input:number":
      return `Thêm trường "${hasLabel(/số lượng/) ? "Đơn giá" : "Số lượng"}" (kiểu number) ${pos}.`;
    case "Input:text":
      // form đăng nhập/đổi mật khẩu không cần thêm ô văn bản chung chung
      if (has(ctx, /mật khẩu|password/)) return null;
      break;
    case "Input:name":
      return hasLabel(/tên/) ? null : `Thêm trường "Họ và tên" (bắt buộc) ${pos}.`;
    case "Button:submit": {
      if (kids.some((k) => k.type === "Button" && /primary/.test(String(k.props.variant ?? "")))) return null;
      const b = submitLabel(tree, container);
      return `Thêm nút "${b.label}" (variant primary, action ${b.action}) ${pos}.`;
    }
    case "Button:cancel":
      return hasLabel(/hủy|huỷ|quay lại/) ? null : `Thêm nút "Hủy" (variant secondary, action cancel) ${pos}.`;
    case "Button:create":
      return hasLabel(/thêm/) ? null : `Thêm nút "Thêm mới" (variant primary, action create) ${pos}.`;
    case "Button:delete":
      return `Thêm nút "Xóa" (variant danger, action delete) ${pos}.`;
    case "Button:search":
      return hasLabel(/tìm/) ? null : `Thêm nút "Tìm kiếm" (variant primary, action search) ${pos}.`;
    case "Link:auth":
      if (has(ctx, /mật khẩu|password/) && !hasLabel(/quên/)) return `Thêm link "Quên mật khẩu?" ${pos}.`;
      return hasLabel(/đăng ký/) ? null : `Thêm link "Đăng ký tài khoản" ${pos}.`;
    case "Checkbox:remember":
      return hasLabel(/ghi nhớ/) ? null : `Thêm ô tích "Ghi nhớ đăng nhập" ${pos}.`;
    case "Checkbox:agree":
      return hasLabel(/đồng ý|điều khoản/) ? null : `Thêm ô tích "Tôi đồng ý với điều khoản sử dụng" ${pos}.`;
  }
  if (type === "Pagination" && (kids.some((k) => k.type === "Pagination") || !kids.some((k) => k.type === "Table"))) return null;
  // còn lại: dùng câu theo loại, thay "vào cuối X" bằng vị trí thật
  const base = addPrompt(tree, container, type);
  return index >= kids.length ? base : base.replace(new RegExp(`(vào cuối|vào|trong|ngay sau bảng trong|mô tả nội dung của) ${nodeLabel(container).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`), `${pos}.`);
}

function transformerAdds(m: TransformerModel, tree: UINode, inScope: (id: string) => boolean, min: number): Suggestion[] {
  const out: Suggestion[] = [];
  for (const s of predictSlots(m, tree)) {
    const container = findNode(tree, s.parentId);
    if (!container || !inScope(container.id) || container.type === "Table") continue;
    for (const t of s.types.slice(0, 2)) {
      const score = s.pMissing * t.p;
      if (score < min || LAYOUT_TYPES.has(t.type)) continue;
      const prompt = typedAddPrompt(tree, container, t.type, t.sub, s.index);
      if (!prompt) continue;
      const pos = positionPhrase(container, s.index);
      const what = SUB_VI[t.sub] ? `${t.type} (${SUB_VI[t.sub]})` : t.type;
      out.push({
        id: `add:${container.id}:${s.index}:${t.type}:${t.sub}`,
        kind: "add",
        targetNodeId: container.id,
        title: `Thêm ${what} ${pos.short}`,
        reason: `Transformer: ${Math.round(s.pMissing * 100)}% còn thiếu phần tử tại đây · ${Math.round(t.p * 100)}% là ${what}`,
        confidence: Math.min(1, score),
        fixPrompt: prompt,
      });
    }
  }
  return out;
}

const isTransformer = (m: NGramModel | TransformerModel): m is TransformerModel => "config" in m && "t" in m;

export function suggest(model: NGramModel | TransformerModel, tree: UINode, opts: SuggestOptions = {}): Suggestion[] {
  const k = opts.k ?? 5;
  const scope = opts.selectedIds?.length ? regionIds(tree, opts.selectedIds) : null;
  const inScope = (id: string) => !scope || scope.has(id);
  const out: Suggestion[] = isTransformer(model) ? transformerAdds(model, tree, inScope, scope ? TF_ADD_MIN_REGION : TF_ADD_MIN) : [];

  if (!isTransformer(model)) walk(tree, (n) => {
    if (!inScope(n.id) || !isContainer(n.type)) return;
    const last = n.children?.at(-1)?.type;
    const where = nodeLabel(n);
    for (const { type, p } of predictNext(model, tree, n.id, 5).filter((x) => x.p >= ADD_MIN_P && (x.type !== last || x.p >= 0.3) && !LAYOUT_TYPES.has(x.type)).slice(0, 2)) {
      out.push({
        id: `add:${n.id}:${type}`,
        kind: "add",
        targetNodeId: n.id,
        title: `Thêm ${type} vào ${where}`,
        reason: `${ctxText(ctxForAppend(tree, n.id))}: ${Math.round(p * 100)}% trường hợp tương tự là ${type}`,
        confidence: Math.min(1, p),
        fixPrompt: addPrompt(tree, n, type),
      });
    }
  });

  for (const f of ruleFindings(tree, opts)) {
    if (!inScope(f.nodeId)) continue;
    out.push({
      id: `fix:${f.nodeId}:${f.code}`,
      kind: "fix",
      targetNodeId: f.nodeId,
      title: f.message,
      reason: `Luật ${f.code}`,
      confidence: f.code === "R8" || f.code === "R9" ? 0.3 : 0.3 + 0.2 * f.severity, // thiếu sót nhỏ xếp sau gợi ý thêm phần tử
      fixPrompt: f.fixPrompt,
    });
  }

  // "Xem lại" dựa trên độ lạ n-gram – Transformer chỉ dự đoán phần tử còn thiếu nên bỏ qua
  if (!isTransformer(model)) walk(tree, (n, parent) => {
    if (!parent || !inScope(n.id) || LAYOUT_TYPES.has(n.type) || isContainer(n.type)) return;
    // ô nhập/bộ lọc/nút trong Row, Form là bố cục hợp lệ của BA (thanh công cụ, form) – dữ liệu web ít gặp nhưng không sai
    if (CONTROL_TYPES.has(n.type) && (parent.type === "Row" || parent.type === "Form")) return;
    if (n.type === "Alert" && /^Ghi chú BA/.test(String(n.props.text ?? ""))) return;
    const s = surprisal(model, tree, n.id);
    if (s < SURPRISAL_REVIEW) return;
    out.push({
      id: `review:${n.id}`,
      kind: "review",
      targetNodeId: n.id,
      title: `Xem lại ${nodeLabel(n)} trong ${nodeLabel(parent)}`,
      reason: `Hiếm gặp trong ngữ cảnh này (${s.toFixed(1)} bit)`,
      confidence: Math.min(1, s / 12) * 0.6,
      // đề xuất cụ thể để Mock/Claude làm được; prompt chỉ điền sẵn, BA tự quyết định có gửi hay không
      fixPrompt: `Xóa ${nodeLabel(n)} khỏi ${nodeLabel(parent)}.`,
    });
  });

  const seen = new Set<string>();
  return out
    .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    // R3 đã đề xuất thêm nút cho form → bỏ gợi ý n-gram "Thêm Button" trùng ý
    .filter((s) => !(s.kind === "add" && s.title.startsWith("Thêm Button") && s.fixPrompt.includes("vào cuối") && out.some((o) => o.kind === "fix" && o.targetNodeId === s.targetNodeId && /chưa có nút/.test(o.title))))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, k);
}
