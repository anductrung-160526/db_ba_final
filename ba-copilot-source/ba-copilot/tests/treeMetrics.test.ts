import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTree } from "../shared/design.ts";
import { EDIT_COST, pairPRF, treeEditDistance } from "../scripts/tree-metrics.ts";

const T = (x: unknown) => normalizeTree(x);
const form = (...kids: string[]) => T({ id: "page", type: "Page", props: { title: "x" }, children: [{ id: "f", type: "Form", props: {}, children: kids.map((type, i) => ({ id: `k${i}`, type, props: { label: "a", text: "a" } })) }] });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("khoảng cách sửa cây Zhang–Shasha với chi phí KLM", () => {
  close(treeEditDistance(form("Input", "Button"), form("Input", "Button")), 0);
  close(treeEditDistance(form("Input"), form("Input", "Button")), EDIT_COST.insert); // thiếu nút → chèn 1
  close(treeEditDistance(form("Input", "Button", "Link"), form("Input", "Button")), EDIT_COST.delete); // thừa → xóa 1
  close(treeEditDistance(form("Input", "Text"), form("Input", "Button")), Math.min(EDIT_COST.relabel, EDIT_COST.insert + EDIT_COST.delete)); // sai loại
  close(treeEditDistance(form(), form("Input", "Input", "Button")), 3 * EDIT_COST.insert);
  // giữ thứ tự: chèn ở giữa
  close(treeEditDistance(form("Input", "Button"), form("Input", "Input", "Button")), EDIT_COST.insert);
  // ví dụ kinh điển của Zhang & Shasha (chi phí đơn vị): f(d(a c(b)) e) → f(c(d(a b)) e) = 2
  const unit = { insert: 1, delete: 1, relabel: 1 };
  const N = (type: string, ...children: object[]) => ({ id: Math.random().toString(36), type, props: {}, children });
  const a = N("f", N("d", N("a"), N("c", N("b"))), N("e"));
  const b = N("f", N("c", N("d", N("a"), N("b"))), N("e"));
  assert.equal(treeEditDistance(a as never, b as never, unit), 2);
});

test("F1 theo cặp cha–con", () => {
  const r = pairPRF(form("Input", "Button"), form("Input", "Input", "Button"));
  // dự đoán: Page>Form, Form>Input, Form>Button (3 cặp, đều đúng); cây đúng có 4 cặp
  close(r.p, 1);
  close(r.r, 3 / 4);
  close(r.f1, (2 * 1 * 0.75) / 1.75);
  close(pairPRF(form("Input"), form("Input")).f1, 1);
});
