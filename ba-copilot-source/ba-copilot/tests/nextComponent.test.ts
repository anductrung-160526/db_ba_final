import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTree, UINode, ALL_TYPES } from "../shared/design.ts";
import {
  allProb,
  baselinePredict,
  countTree,
  emptyModel,
  END,
  mergeModels,
  predictNext,
  prob,
  ruleFindings,
  START,
  suggest,
  surprisal,
} from "../shared/nextComponent.ts";

const T = (x: unknown) => normalizeTree(x);

// Mẫu "đúng": Form gồm 2 Input rồi Button
const loginLike = () =>
  T({
    id: "page",
    type: "Page",
    props: { title: "Đăng nhập" },
    children: [
      {
        id: "form",
        type: "Form",
        props: {},
        children: [
          { id: "e", type: "Input", props: { label: "Email", name: "email", inputType: "email", required: true } },
          { id: "p", type: "Input", props: { label: "Mật khẩu", name: "password", inputType: "password", minLength: 8, required: true } },
          { id: "b", type: "Button", props: { label: "Đăng nhập", action: "login" } },
        ],
      },
    ],
  });

function trained(n = 10) {
  const m = emptyModel();
  for (let i = 0; i < n; i++) countTree(m, loginLike());
  return m;
}

test("đếm: sự kiện cha–con và <END> được ghi đủ 3 mức ngữ cảnh", () => {
  const m = countTree(emptyModel(), loginLike());
  assert.equal(m.counts.tri[`Page|Form|Input`]?.Input, 1);
  assert.equal(m.counts.tri[`Page|Form|Input`]?.Button, 1);
  assert.equal(m.counts.bi[`Form|Button`]?.[END], 1);
  assert.equal(m.counts.uni.Form?.Input, 2);
  assert.equal(m.meta.trees, 1);
  // Page: <START>→Form, Form→<END>; Form: 3 con + <END>
  assert.equal(m.meta.events, 6);
});

test("trọng số và gộp mô hình", () => {
  const a = countTree(emptyModel(), loginLike(), 3);
  assert.equal(a.counts.uni.Form?.Input, 6);
  const b = mergeModels(emptyModel(), a, 2);
  assert.equal(b.counts.uni.Form?.Input, 12);
});

test("xác suất: không bao giờ bằng 0, tổng mức chung = 1, backoff khi thiếu dữ liệu", () => {
  const m = trained();
  for (const t of ALL_TYPES) assert.ok(prob(m, { g: "Modal", p: "Sidebar", s: "Pagination" }, t) > 0);
  const total = [...ALL_TYPES, END].reduce((s, x) => s + allProb(m, x), 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  // ngữ cảnh đầy đủ có dữ liệu → dùng tri
  assert.equal(prob(m, { g: "Page", p: "Form", s: "Input" }, "Input"), 0.5);
  // ông lạ → lùi về bi, nhân 0.4
  assert.equal(prob(m, { g: "Card", p: "Form", s: "Input" }, "Input"), 0.4 * 0.5);
});

test("predictNext: Form có 2 Input → Button nằm trong top-3", () => {
  const m = trained();
  const partial = T({ id: "page", type: "Page", props: { title: "x" }, children: [{ id: "f", type: "Form", props: {}, children: [{ id: "a", type: "Input", props: { label: "A" } }, { id: "b", type: "Input", props: { label: "B" } }] }] });
  const top = predictNext(m, partial, "f", 3).map((x) => x.type);
  assert.ok(top.includes("Button"), top.join());
  assert.ok(!top.includes(END));
  assert.deepEqual(predictNext(m, partial, "a"), []); // lá không có con
});

test("surprisal: Pagination trong Form lạ hơn Input trong Form", () => {
  const m = trained();
  const t = T({ id: "page", type: "Page", props: { title: "x" }, children: [{ id: "f", type: "Form", props: {}, children: [{ id: "i", type: "Input", props: { label: "A" } }, { id: "pg", type: "Pagination", props: {} }] }] });
  assert.ok(surprisal(m, t, "pg") > surprisal(m, t, "i"));
  assert.equal(surprisal(m, t, "page"), 0);
});

test("baseline = loại phổ biến nhất", () => {
  assert.equal(baselinePredict(trained()), "Input");
});

// ------------------------------------------------------------------ luật R1–R7
const page = (...children: unknown[]) => T({ id: "page", type: "Page", props: { title: "x" }, children });
const codes = (t: UINode, ctx = {}) => ruleFindings(t, ctx).map((f) => f.code);

test("R1 trường thiếu name / thiếu required khi ghi bắt buộc", () => {
  assert.ok(codes(page({ id: "a", type: "Input", props: { label: "Họ tên *", name: "ho_ten" } })).includes("R1"));
  assert.ok(codes(page({ id: "a", type: "Input", props: { label: "Ghi chú" } })).includes("R1"));
  assert.ok(!codes(page({ id: "a", type: "Input", props: { label: "Họ tên *", name: "ho_ten", required: true } })).includes("R1"));
});

test("R2 email / mật khẩu sai kiểu", () => {
  assert.ok(codes(page({ id: "a", type: "Input", props: { label: "Email", name: "e" } })).includes("R2"));
  assert.ok(codes(page({ id: "a", type: "Input", props: { label: "Mật khẩu", name: "p", inputType: "password" } })).includes("R2"));
  assert.ok(!codes(page({ id: "a", type: "Input", props: { label: "Email", name: "e", inputType: "email" } })).includes("R2"));
});

test("R3 Form không có nút", () => {
  assert.ok(codes(page({ id: "f", type: "Form", props: {}, children: [{ id: "a", type: "Input", props: { label: "A", name: "a" } }] })).includes("R3"));
  assert.ok(!codes(loginLike()).includes("R3"));
});

test("R4 nút không có hành động", () => {
  assert.ok(codes(page({ id: "b", type: "Button", props: { label: "OK" } })).includes("R4"));
  assert.ok(!codes(page({ id: "b", type: "Button", props: { label: "OK", action: "ok" } })).includes("R4"));
});

test("R5 bảng thiếu cột", () => {
  assert.ok(codes(page({ id: "t", type: "Table", props: { columns: [] } })).includes("R5"));
  assert.ok(!codes(page({ id: "t", type: "Table", props: { columns: ["Tên"] } })).includes("R5"));
});

test("R7 bình luận đang mở", () => {
  assert.ok(codes(loginLike(), { openAnnotationNodeIds: ["b"] }).includes("R7"));
  assert.ok(!codes(loginLike()).includes("R7"));
});

// ------------------------------------------------------------------ suggest
test("suggest: giới hạn trong vùng chọn, cây rỗng, vùng rỗng, k", () => {
  const m = trained();
  const t = page(
    { id: "f", type: "Form", props: {}, children: [{ id: "a", type: "Input", props: { label: "A", name: "a" } }, { id: "b2", type: "Input", props: { label: "B", name: "b" } }] },
    { id: "other", type: "Button", props: { label: "X" } },
  );
  const all = suggest(m, t, { k: 10 });
  assert.ok(all.length > 0);
  assert.ok(all.some((s) => s.targetNodeId === "other")); // R4 ngoài form
  const inForm = suggest(m, t, { selectedIds: ["f"], k: 10 });
  assert.ok(inForm.every((s) => ["f", "a", "b2"].includes(s.targetNodeId)));
  // form thiếu nút: R3 đề xuất nút, gợi ý n-gram "Thêm Button" trùng ý bị gộp
  assert.ok(inForm.some((s) => s.kind === "fix" && /chưa có nút/.test(s.title)));
  assert.ok(!inForm.some((s) => s.kind === "add" && s.title.includes("Button")));
  assert.equal(suggest(m, t, { k: 2 }).length, 2);
  assert.deepEqual(suggest(m, t, { selectedIds: [] , k: 10 }).length, all.length);
  const only = page();
  assert.ok(Array.isArray(suggest(m, only)));
  for (const s of all) {
    assert.ok(s.confidence >= 0 && s.confidence <= 1);
    assert.ok(s.fixPrompt.length > 0);
  }
});

test("suggest: < 50 ms cho cây 120 node", () => {
  const m = trained(50);
  const kids = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, type: "Card", props: {}, children: [{ id: `i${i}`, type: "Input", props: { label: `T${i}` } }, { id: `t${i}`, type: "Text", props: { text: "x" } }] }));
  const t = page(...kids);
  const t0 = performance.now();
  suggest(m, t);
  assert.ok(performance.now() - t0 < 50);
  assert.equal(START, "<START>");
});

test("câu gợi ý theo ngữ cảnh: nhãn nút và trường thiếu", async () => {
  const { addPrompt, submitLabel } = await import("../shared/nextComponent.ts");
  const login = page({ id: "f", type: "Form", props: {}, children: [{ id: "e", type: "Input", props: { label: "Email" } }, { id: "p", type: "Input", props: { label: "Mật khẩu" } }] });
  assert.equal(submitLabel(login, login.children![0]).label, "Đăng nhập");
  assert.match(addPrompt(login, login.children![0], "Button"), /Thêm nút "Đăng nhập"/);
  const reg = page({ id: "f", type: "Form", props: {}, children: [{ id: "e", type: "Input", props: { label: "Email" } }, { id: "p", type: "Input", props: { label: "Mật khẩu" } }, { id: "c", type: "Input", props: { label: "Xác nhận mật khẩu" } }] });
  assert.equal(submitLabel(reg, reg.children![0]).label, "Đăng ký");
  const onlyEmail = page({ id: "f", type: "Form", props: {}, children: [{ id: "e", type: "Input", props: { label: "Email" } }] });
  assert.match(addPrompt(onlyEmail, onlyEmail.children![0], "Input"), /Thêm trường "Mật khẩu"/);
  const search = page({ id: "f", type: "Form", props: {}, children: [{ id: "k", type: "Input", props: { label: "Tìm kiếm sản phẩm" } }] });
  assert.match(addPrompt(search, search.children![0], "Button"), /"Tìm kiếm"/);
  // gợi ý "add" có lý do nêu ngữ cảnh n-gram
  // container Card (không phải Form) nên R3 không bắt → gợi ý n-gram "Thêm Button" hiện ra
  const m2 = emptyModel();
  for (let i = 0; i < 10; i++) countTree(m2, T({ id: "page", type: "Page", props: { title: "x" }, children: [{ id: "c", type: "Card", props: {}, children: [{ id: "e", type: "Input", props: { label: "Email", name: "email" } }, { id: "p", type: "Input", props: { label: "Mật khẩu", name: "password" } }, { id: "b", type: "Button", props: { label: "Đăng nhập", action: "login" } }] }] }));
  const s = suggest(m2, page({ id: "f2", type: "Card", props: {}, children: [{ id: "a", type: "Input", props: { label: "Email", name: "e", inputType: "email" } }, { id: "b", type: "Input", props: { label: "Mật khẩu", name: "p", inputType: "password", minLength: 8 } }] }), { selectedIds: ["f2"], k: 10 }).find((x) => x.kind === "add" && x.title.includes("Button"));
  assert.ok(s && /Sau Input trong Card/.test(s.reason) && /"Đăng nhập"/.test(s.fixPrompt), JSON.stringify(s));
});

test("R8/R9 bắt thiếu sót nhỏ của trường nhập", () => {
  const t = page({ id: "f", type: "Form", props: {}, children: [{ id: "a", type: "Input", props: { label: "Họ tên", name: "ho_ten" } }, { id: "b", type: "Button", props: { label: "Lưu", action: "save" } }] });
  assert.ok(codes(t).includes("R8") && codes(t).includes("R9"));
  assert.ok(!codes(page({ id: "a", type: "Input", props: { label: "X", name: "x", placeholder: "p", maxLength: 10 } })).some((c) => c === "R8" || c === "R9"));
});

test("Mock hiểu được câu gợi ý: áp dụng gợi ý không sinh 'Ghi chú BA'", async () => {
  const { mockScreen, mockEditOps } = await import("../server/ai/mock.ts");
  const { applyPatch } = await import("../shared/patch.ts");
  const m = trained();
  for (const p of ["Danh sách đơn hàng có lọc theo trạng thái, bảng cột Mã đơn, Khách hàng", "Màn hình thêm nhân viên gồm họ tên, email, ngày sinh", "Màn hình đăng nhập bằng email và mật khẩu"]) {
    const t = mockScreen(p, "");
    for (const s of suggest(m, t, { k: 10 })) {
      const { ops } = mockEditOps(t, [s.targetNodeId], s.fixPrompt);
      const after = applyPatch(t, ops, { selectedIds: [s.targetNodeId] });
      assert.ok(!JSON.stringify(after).includes("Ghi chú BA"), `${p} :: ${s.fixPrompt}`);
    }
  }
  const t = mockScreen("Danh sách đơn hàng có lọc theo trạng thái, bảng cột Mã đơn, Khách hàng", "");
  const table = t.children!.find((c) => c.type === "Table")!;
  const ops = mockEditOps(t, [table.id], "Thêm thao tác xem, sửa, xóa").ops;
  assert.ok(ops.every((o) => o.op === "update"), JSON.stringify(ops)); // không bị hiểu thành "xóa"
});
