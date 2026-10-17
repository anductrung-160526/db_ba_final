import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeTree, ALL_TYPES } from "../shared/design.ts";
import { encodeTree, encTokens, forward, linearize, loadTransformer, predictSlots, SUBTYPES, subtypeOf, TOKEN_TYPES, TransformerModel } from "../shared/transformer.ts";
import { suggest } from "../shared/nextComponent.ts";

const T = (x: unknown) => normalizeTree(x);
const root = join(import.meta.dirname, "..");
const login = () =>
  T({ id: "page", type: "Page", props: { title: "Đăng nhập" }, children: [{ id: "f", type: "Form", props: {}, children: [{ id: "e", type: "Input", props: { label: "Email", inputType: "email" } }, { id: "p", type: "Input", props: { label: "Mật khẩu", inputType: "password" } }] }] });

/** Mô hình nhỏ trọng số ngẫu nhiên (seed cố định) để kiểm tra phần tính toán không cần file đã huấn luyện. */
function tiny(): TransformerModel {
  let seed = 3;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 0.4;
  const cfg = { d: 8, heads: 2, layers: 2, ff: 16, maxLen: 16, maxDepth: 6 };
  const shapes: Record<string, number[]> = {
    "emb_type.weight": [TOKEN_TYPES.length, 8], "emb_sub.weight": [SUBTYPES.length, 8], "emb_depth.weight": [6, 8], "emb_pos.weight": [16, 8],
    "ln_f.weight": [8], "ln_f.bias": [8], "head_type.weight": [TOKEN_TYPES.length, 8], "head_type.bias": [TOKEN_TYPES.length],
    "emb_cond.weight": [ALL_TYPES.length, 8], "head_sub.weight": [SUBTYPES.length, 8], "head_sub.bias": [SUBTYPES.length],
  };
  for (const l of [0, 1]) Object.assign(shapes, { [`layers.${l}.ln1.weight`]: [8], [`layers.${l}.ln1.bias`]: [8], [`layers.${l}.ln2.weight`]: [8], [`layers.${l}.ln2.bias`]: [8], [`layers.${l}.qkv.weight`]: [24, 8], [`layers.${l}.qkv.bias`]: [24], [`layers.${l}.out.weight`]: [8, 8], [`layers.${l}.out.bias`]: [8], [`layers.${l}.ff1.weight`]: [16, 8], [`layers.${l}.ff1.bias`]: [16], [`layers.${l}.ff2.weight`]: [8, 16], [`layers.${l}.ff2.bias`]: [8] });
  const tensors = Object.fromEntries(Object.entries(shapes).map(([k, sh]) => {
    const a = new Float32Array(sh.reduce((x, y) => x * y, 1)).map((_, i) => (k.includes("ln") && k.endsWith("weight") ? 1 : r()));
    return [k, { shape: sh, b64: Buffer.from(a.buffer).toString("base64") }];
  }));
  return loadTransformer({ config: cfg, types: [...TOKEN_TYPES], subtypes: [...SUBTYPES], meta: { trees: 1 }, tensors });
}

test("loại con mang nghĩa", () => {
  assert.equal(subtypeOf(T({ id: "a", type: "Input", props: { label: "Mật khẩu" } })), "password");
  assert.equal(subtypeOf(T({ id: "a", type: "Input", props: { label: "Tìm kiếm" } })), "search");
  assert.equal(subtypeOf(T({ id: "a", type: "Button", props: { label: "Hủy" } })), "cancel");
  assert.equal(subtypeOf(T({ id: "a", type: "Button", props: { label: "Thêm mới" } })), "create");
  assert.equal(subtypeOf(T({ id: "a", type: "Button", props: { label: "LOGIN" } })), "submit");
  assert.equal(subtypeOf(T({ id: "a", type: "Link", props: { text: "Quên mật khẩu?" } })), "auth");
  assert.equal(subtypeOf(T({ id: "a", type: "Heading", props: { text: "X" } })), "-");
});

test("duỗi cây: token đóng cho container, mỗi token hỏi một ô trống", () => {
  const toks = linearize(login(), 12);
  assert.deepEqual(toks.map((t) => TOKEN_TYPES[t.type]), ["Page", "Form", "Input", "Input", "</>", "</>"]);
  assert.deepEqual(toks.map((t) => t.slot && `${t.slot.parentId}:${t.slot.index}`), [null, "page:0", "f:0", "f:1", "f:2", "page:1"]);
  assert.deepEqual(encTokens(encodeTree(login()), 12).map((t) => [t.type, t.sub, t.depth]), toks.map((t) => [t.type, t.sub, t.depth]));
});

test("suy luận: xác suất hợp lệ, cây dài hơn maxLen chia cửa sổ không lỗi", () => {
  const m = tiny();
  const slots = predictSlots(m, login());
  assert.equal(slots.length, 5);
  for (const s of slots) {
    assert.ok(s.pMissing >= 0 && s.pMissing <= 1);
    assert.ok(Math.abs(s.types.reduce((a, b) => a + b.p, 0) - 1) < 0.05); // trừ Page
    assert.ok(SUBTYPES.includes(s.types[0].sub));
  }
  const big = T({ id: "page", type: "Page", props: { title: "x" }, children: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, type: "Card", props: {}, children: [{ id: `t${i}`, type: "Text", props: { text: "x" } }] })) });
  const many = predictSlots(m, big);
  assert.equal(many.length, 20 * 3 + 1);
  assert.ok(many.every((s) => Number.isFinite(s.pMissing)));
  assert.ok(Array.isArray(suggest(m, login(), { k: 10 })));
});

const MODEL = join(root, "model", "next-transformer.json");
test("mô hình đã huấn luyện: khớp số học với PyTorch và gợi ý hợp lý", { skip: !existsSync(MODEL) }, () => {
  const m = loadTransformer(JSON.parse(readFileSync(MODEL, "utf8")));
  const parityFile = join(root, "model", "next-transformer.parity.json");
  if (existsSync(parityFile))
    for (const p of JSON.parse(readFileSync(parityFile, "utf8")) as { tree: never; logits: number[] }[]) {
      const { type } = forward(m, encTokens(p.tree, m.config.maxDepth));
      const diff = Math.max(...p.logits.map((x, i) => Math.abs(x - type[i])));
      assert.ok(diff < 2e-3, `lệch ${diff}`);
    }
  // form đăng nhập thiếu nút → gợi ý nút "Đăng nhập" ở cuối form
  const s = suggest(m, login(), { k: 10 });
  assert.ok(s.some((x) => /"Đăng nhập"/.test(x.fixPrompt)), JSON.stringify(s.map((x) => x.title)));
  const t0 = performance.now();
  const kids = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, type: "Card", props: {}, children: [{ id: `i${i}`, type: "Input", props: { label: `T${i}` } }, { id: `t${i}`, type: "Text", props: { text: "x" } }] }));
  suggest(m, T({ id: "page", type: "Page", props: { title: "x" }, children: kids }));
  assert.ok(performance.now() - t0 < 400, "suy luận cây 120 node < 400 ms");
});
