// Transformer cho cây giao diện (theo Li et al. 2020, "Auto Completion of User Interface Layout Design
// Using Transformer-Based Tree Decoders", arXiv:2001.05308), chạy suy luận thuần TypeScript – không cần thư viện ngoài.
//
// Biểu diễn (mục 4.1–4.2 của bài báo, điều chỉnh cho dữ liệu không có tọa độ):
//  - Cây được duỗi theo thứ tự tiền tự DFS, mỗi container có thêm token đóng "</>" sau con cuối (Vanilla decoder).
//  - Mỗi token = tổng các embedding thuộc tính (Eq. 5): loại component + loại con (email, password, submit...)
//    + độ sâu + vị trí. Bài báo dùng embedding tọa độ khung bao; cây của BA Copilot không có tọa độ nên thay bằng
//    loại con (ngữ nghĩa) và độ sâu.
//  - Khác bài báo: chú ý hai chiều (không che tương lai) vì cây BA đang sửa không phải là tiền tố DFS – phần tử
//    thiếu có thể nằm giữa form. Mỗi token dự đoán "phần tử còn thiếu ngay TRƯỚC nó"; token "</>" dự đoán
//    "phần tử còn thiếu ở CUỐI container". Lớp 0 = không thiếu gì.
import { ALL_TYPES, isContainer, UINode } from "./design.ts";

export const CLOSE = "</>";
export const TOKEN_TYPES: readonly string[] = [...ALL_TYPES, CLOSE];
export const SUBTYPES = ["-", "email", "password", "search", "phone", "number", "name", "text", "submit", "cancel", "create", "delete", "icon", "other", "auth", "remember", "agree"] as const;
export type Subtype = (typeof SUBTYPES)[number];

const TYPE_IDX = new Map(TOKEN_TYPES.map((t, i) => [t, i]));
const SUB_IDX = new Map<string, number>(SUBTYPES.map((s, i) => [s, i]));

/** Loại con mang nghĩa của một node – dùng chung cho xuất dữ liệu huấn luyện và suy luận. */
export function subtypeOf(n: UINode): Subtype {
  const p = n.props ?? {};
  const txt = `${p.label ?? ""} ${p.text ?? ""} ${p.name ?? ""} ${p.placeholder ?? ""}`.toLowerCase();
  switch (n.type) {
    case "Input": {
      const it = String(p.inputType ?? "");
      if (it === "password" || /mật khẩu|password|passwd|pwd/.test(txt)) return "password";
      if (it === "email" || /e-?mail/.test(txt)) return "email";
      if (/tìm kiếm|tra cứu|từ khóa|search|keyword/.test(txt)) return "search";
      if (it === "tel" || /điện thoại|sđt|phone|mobile/.test(txt)) return "phone";
      if (it === "number" || /giá|số lượng|tồn kho|amount|price|qty|quantity/.test(txt)) return "number";
      if (/tên|name|user/.test(txt)) return "name";
      return "text";
    }
    case "Button": {
      const s = `${txt} ${p.action ?? ""}`;
      if (p.icon) return "icon";
      if (/hủy|huỷ|quay lại|đóng|bỏ qua|từ chối|cancel|back|close|dismiss|skip|not now|reject/.test(s)) return "cancel";
      if (/xóa|xoá|delete|remove/.test(s)) return "delete";
      if (/thêm|tạo mới|^\s*\+|\badd\b|\bnew\b|\bcreate\b/.test(s) && !/account|tài khoản/.test(s)) return "create";
      if (/tìm kiếm|tra cứu|search/.test(s)) return "search";
      if (/lưu|gửi|xác nhận|cập nhật|đăng nhập|đăng ký|tiếp tục|hoàn tất|đặt hàng|thanh toán|đổi mật khẩu|duyệt|save|submit|send|log ?in|sign ?(in|up)|register|confirm|continue|next|done|\bok\b|apply|update|login|checkout/.test(s)) return "submit";
      return "other";
    }
    case "Link":
      return /quên|đăng ký|đăng nhập|forgot|sign ?up|register|log ?in|account/.test(txt) ? "auth" : "other";
    case "Checkbox":
      return /ghi nhớ|remember|keep me/.test(txt) ? "remember" : /đồng ý|điều khoản|agree|terms|accept/.test(txt) ? "agree" : "other";
    default:
      return "-";
  }
}

/** Props tối thiểu để một node mới mang đúng loại con (dùng khi mô hình tự hoàn thiện cây lúc đánh giá). */
export function propsForSubtype(type: string, sub: Subtype): Record<string, unknown> {
  const m: Partial<Record<Subtype, Record<string, unknown>>> = {
    email: { label: "Email", inputType: "email" }, password: { label: "Mật khẩu", inputType: "password" }, search: { label: "Tìm kiếm" },
    phone: { label: "Số điện thoại", inputType: "tel" }, number: { label: "Số lượng", inputType: "number" }, name: { label: "Tên" },
    submit: { label: "Lưu" }, cancel: { label: "Hủy" }, create: { label: "Thêm mới" }, delete: { label: "Xóa" }, icon: { label: "icon", icon: true },
    auth: { text: "Đăng ký" }, remember: { label: "Ghi nhớ đăng nhập" }, agree: { label: "Đồng ý điều khoản" },
  };
  return { ...(m[sub] ?? { label: type }) };
}

/** Cây mã hóa gọn để xuất dữ liệu huấn luyện: [loại, loại con, con?] (container luôn có mảng con). */
export type EncNode = [number, number] | [number, number, EncNode[]];
export function encodeTree(n: UINode): EncNode {
  const t = TYPE_IDX.get(n.type)!;
  const s = SUB_IDX.get(subtypeOf(n))!;
  return isContainer(n.type) ? [t, s, (n.children ?? []).map(encodeTree)] : [t, s];
}

export interface Token {
  type: number;
  sub: number;
  depth: number;
  /** Ô trống mà token này hỏi: chèn vào container `parentId` tại vị trí `index`. Gốc không có ô. */
  slot: { parentId: string; index: number } | null;
  nodeId: string;
  close: boolean;
}

export function linearize(tree: UINode, maxDepth: number): Token[] {
  const out: Token[] = [];
  const rec = (n: UINode, depth: number, slot: Token["slot"]) => {
    const d = Math.min(depth, maxDepth - 1);
    out.push({ type: TYPE_IDX.get(n.type)!, sub: SUB_IDX.get(subtypeOf(n))!, depth: d, slot, nodeId: n.id, close: false });
    if (!isContainer(n.type)) return;
    const kids = n.children ?? [];
    kids.forEach((c, i) => rec(c, depth + 1, { parentId: n.id, index: i }));
    out.push({ type: TYPE_IDX.get(CLOSE)!, sub: 0, depth: d, slot: { parentId: n.id, index: kids.length }, nodeId: n.id, close: true });
  };
  rec(tree, 0, null);
  return out;
}

/** Token từ cây đã mã hóa (dùng để đối chiếu số học với Python trong test). */
export function encTokens(enc: EncNode, maxDepth: number): Token[] {
  const out: Token[] = [];
  const rec = (n: EncNode, depth: number) => {
    const d = Math.min(depth, maxDepth - 1);
    out.push({ type: n[0], sub: n[1], depth: d, slot: null, nodeId: "", close: false });
    if (n.length < 3) return;
    for (const c of n[2]!) rec(c, depth + 1);
    out.push({ type: TYPE_IDX.get(CLOSE)!, sub: 0, depth: d, slot: null, nodeId: "", close: true });
  };
  rec(enc, 0);
  return out;
}

// ------------------------------------------------------------------ trọng số & suy luận
export interface TransformerConfig {
  d: number;
  heads: number;
  layers: number;
  ff: number;
  maxLen: number;
  maxDepth: number;
}
interface Tensor {
  shape: number[];
  data: Float32Array;
}
export interface TransformerModel {
  config: TransformerConfig;
  meta: Record<string, unknown>;
  t: Record<string, Tensor>;
}

/** File JSON do scripts/train_transformer.py xuất: { config, types, subtypes, meta, tensors: {tên: {shape, b64}} }. */
export function loadTransformer(json: {
  config: TransformerConfig;
  types: string[];
  subtypes: string[];
  meta?: Record<string, unknown>;
  tensors: Record<string, { shape: number[]; b64: string }>;
}): TransformerModel {
  if (json.types.join() !== TOKEN_TYPES.join() || json.subtypes.join() !== SUBTYPES.join()) throw new Error("Từ vựng của mô hình Transformer không khớp với mã nguồn – cần huấn luyện lại");
  const t: Record<string, Tensor> = {};
  for (const [name, v] of Object.entries(json.tensors)) {
    const bin = typeof Buffer !== "undefined" ? Buffer.from(v.b64, "base64") : Uint8Array.from(atob(v.b64), (c) => c.charCodeAt(0));
    const data = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    t[name] = { shape: v.shape, data };
  }
  return { config: json.config, meta: json.meta ?? {}, t };
}

/** y[N×out] = x[N×in] · Wᵀ + b (W dạng [out, in] như PyTorch nn.Linear). */
function linear(x: Float32Array, n: number, W: Tensor, b: Tensor): Float32Array {
  const [out, inn] = W.shape;
  const y = new Float32Array(n * out);
  const w = W.data;
  for (let i = 0; i < n; i++) {
    const xo = i * inn;
    for (let o = 0; o < out; o++) {
      let s = b.data[o];
      const wo = o * inn;
      for (let k = 0; k < inn; k++) s += x[xo + k] * w[wo + k];
      y[i * out + o] = s;
    }
  }
  return y;
}

function layerNorm(x: Float32Array, n: number, d: number, g: Tensor, b: Tensor): Float32Array {
  const y = new Float32Array(n * d);
  for (let i = 0; i < n; i++) {
    let mean = 0;
    for (let k = 0; k < d; k++) mean += x[i * d + k];
    mean /= d;
    let v = 0;
    for (let k = 0; k < d; k++) v += (x[i * d + k] - mean) ** 2;
    const inv = 1 / Math.sqrt(v / d + 1e-5);
    for (let k = 0; k < d; k++) y[i * d + k] = (x[i * d + k] - mean) * inv * g.data[k] + b.data[k];
  }
  return y;
}

const GELU_C = Math.sqrt(2 / Math.PI);
const gelu = (x: number) => 0.5 * x * (1 + Math.tanh(GELU_C * (x + 0.044715 * x * x * x)));

/**
 * Lan truyền xuôi cho một chuỗi token (độ dài ≤ maxLen). Trả trạng thái ẩn cuối [n×d] và logits loại [n×(1+28)].
 * Loại con được dự đoán có điều kiện theo loại (subLogits) để không ghép nhầm kiểu "Button: password".
 */
export function forward(m: TransformerModel, toks: Token[]): { hidden: Float32Array; type: Float32Array } {
  const { d, heads, layers } = m.config;
  const n = toks.length;
  const t = m.t;
  let x: Float32Array = new Float32Array(n * d);
  for (let i = 0; i < n; i++) {
    const a = toks[i];
    for (let k = 0; k < d; k++)
      x[i * d + k] = t["emb_type.weight"].data[a.type * d + k] + t["emb_sub.weight"].data[a.sub * d + k] + t["emb_depth.weight"].data[a.depth * d + k] + t["emb_pos.weight"].data[i * d + k];
  }
  const hd = d / heads;
  const scale = 1 / Math.sqrt(hd);
  const att = new Float32Array(n);
  for (let l = 0; l < layers; l++) {
    const p = `layers.${l}.`;
    const h = layerNorm(x, n, d, t[p + "ln1.weight"], t[p + "ln1.bias"]);
    const qkv = linear(h, n, t[p + "qkv.weight"], t[p + "qkv.bias"]);
    const o = new Float32Array(n * d);
    for (let hh = 0; hh < heads; hh++) {
      const qo = hh * hd, ko = d + hh * hd, vo = 2 * d + hh * hd;
      for (let i = 0; i < n; i++) {
        let mx = -Infinity;
        for (let j = 0; j < n; j++) {
          let s = 0;
          for (let k = 0; k < hd; k++) s += qkv[i * 3 * d + qo + k] * qkv[j * 3 * d + ko + k];
          s *= scale;
          att[j] = s;
          if (s > mx) mx = s;
        }
        let sum = 0;
        for (let j = 0; j < n; j++) sum += att[j] = Math.exp(att[j] - mx);
        for (let k = 0; k < hd; k++) {
          let s = 0;
          for (let j = 0; j < n; j++) s += att[j] * qkv[j * 3 * d + vo + k];
          o[i * d + qo + k] = s / sum;
        }
      }
    }
    const proj = linear(o, n, t[p + "out.weight"], t[p + "out.bias"]);
    for (let i = 0; i < n * d; i++) x[i] += proj[i];
    const h2 = layerNorm(x, n, d, t[p + "ln2.weight"], t[p + "ln2.bias"]);
    const f1 = linear(h2, n, t[p + "ff1.weight"], t[p + "ff1.bias"]);
    for (let i = 0; i < f1.length; i++) f1[i] = gelu(f1[i]);
    const f2 = linear(f1, n, t[p + "ff2.weight"], t[p + "ff2.bias"]);
    for (let i = 0; i < n * d; i++) x[i] += f2[i];
  }
  x = layerNorm(x, n, d, t["ln_f.weight"], t["ln_f.bias"]);
  return { hidden: x, type: linear(x, n, t["head_type.weight"], t["head_type.bias"]) };
}

/** Logits loại con cho một trạng thái ẩn h[d] khi biết loại (chỉ số trong ALL_TYPES): W·(h + E_cond[loại]) + b. */
export function subLogits(m: TransformerModel, h: Float32Array, typeIdx: number): Float32Array {
  const d = m.config.d;
  const cond = m.t["emb_cond.weight"].data;
  const x = new Float32Array(d);
  for (let k = 0; k < d; k++) x[k] = h[k] + cond[typeIdx * d + k];
  return linear(x, 1, m.t["head_sub.weight"], m.t["head_sub.bias"]);
}

function softmax(a: Float32Array, off: number, len: number): number[] {
  let mx = -Infinity;
  for (let i = 0; i < len; i++) mx = Math.max(mx, a[off + i]);
  const e = Array.from({ length: len }, (_, i) => Math.exp(a[off + i] - mx));
  const s = e.reduce((x, y) => x + y, 0);
  return e.map((v) => v / s);
}

export interface SlotPrediction {
  parentId: string;
  index: number;
  /** Xác suất có phần tử còn thiếu tại ô này = 1 − P(không thiếu). */
  pMissing: number;
  /** Phân phối loại (đã chuẩn hóa trong điều kiện "có thiếu"), giảm dần; loại con dự đoán theo từng loại. */
  types: { type: string; p: number; sub: Subtype }[];
}

/**
 * Dự đoán mọi ô trống của cây trong MỘT lượt suy luận (cây lớn hơn maxLen được chia cửa sổ trượt chồng nửa).
 * `topTypes`: số loại hàng đầu cần tính loại con.
 */
export function predictSlots(m: TransformerModel, tree: UINode, topTypes = 3): SlotPrediction[] {
  const toks = linearize(tree, m.config.maxDepth);
  const { maxLen: L, d } = m.config;
  const nT = TOKEN_TYPES.length; // = 1 + 28 lớp đầu ra (lớp 0 = không thiếu)
  const typeLogits = new Float32Array(toks.length * nT);
  const hidden = new Float32Array(toks.length * d);
  const step = Math.max(1, Math.floor(L / 2));
  for (let start = 0; ; start += step) {
    const win = toks.slice(start, start + L);
    const r = forward(m, win);
    // mỗi token lấy kết quả từ cửa sổ mà nó nằm ở nửa giữa (đủ ngữ cảnh hai phía)
    const from = start === 0 ? 0 : Math.floor(L / 4);
    const last = start + L >= toks.length;
    const to = last ? win.length : Math.floor((3 * L) / 4);
    for (let i = from; i < to; i++) {
      typeLogits.set(r.type.subarray(i * nT, (i + 1) * nT), (start + i) * nT);
      hidden.set(r.hidden.subarray(i * d, (i + 1) * d), (start + i) * d);
    }
    if (last) break;
  }
  const out: SlotPrediction[] = [];
  toks.forEach((tk, i) => {
    if (!tk.slot) return;
    const pt = softmax(typeLogits, i * nT, nT);
    const pMissing = 1 - pt[0];
    const ranked = ALL_TYPES.map((type, j) => ({ type, j, p: pt[j + 1] / Math.max(pMissing, 1e-9) }))
      .filter((x) => x.type !== "Page")
      .sort((a, b) => b.p - a.p);
    const h = hidden.subarray(i * d, (i + 1) * d);
    const types = ranked.map((x, r) => {
      if (r >= topTypes) return { type: x.type, p: x.p, sub: "-" as Subtype };
      const ps = subLogits(m, h, x.j);
      let best = 0;
      for (let k = 1; k < ps.length; k++) if (ps[k] > ps[best]) best = k;
      return { type: x.type, p: x.p, sub: SUBTYPES[best] };
    });
    out.push({ parentId: tk.slot.parentId, index: tk.slot.index, pMissing, types });
  });
  return out;
}
