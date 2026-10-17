// Kiểm tra màn gốc: cây hợp lệ theo schema của app, id snake_case duy nhất, kích thước, quy tắc quyền (cảnh báo).
// Dùng: npx tsx scripts/dataset/validate-roots.ts dataset/roots/*.json
import { readFileSync } from "node:fs";
import { isContainer, UINode, validateTree, walk } from "../../shared/design.ts";

export interface RootRecord {
  id: string;
  requirement: { title: string; actor: string; description: string; permissions: string[]; rules?: string[] };
  tree: UINode;
  notes?: string;
}

export function checkRoot(r: RootRecord, permission = ""): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (!r.id || !r.requirement?.title || !r.requirement?.description || !Array.isArray(r.requirement?.permissions)) errors.push("thiếu id/requirement.title/description/permissions");
  if (!r.tree) return { errors: [...errors, "thiếu tree"], warnings };
  const v = validateTree(r.tree);
  errors.push(...v.errors);
  let n = 0;
  const labels: string[] = [];
  walk(r.tree, (x) => {
    n++;
    if (!/^[a-z][a-z0-9_]*$/.test(x.id)) errors.push(`id không phải snake_case: ${x.id}`);
    if (isContainer(x.type) && !(x.children ?? []).length) errors.push(`${x.type} ${x.id} rỗng`);
    if (x.type === "Button") labels.push(String(x.props.label ?? "").toLowerCase());
    if (x.type === "Table") labels.push(...((x.props.rowActions as string[]) ?? []).map((s) => s.toLowerCase()));
    if (["Input", "Textarea", "Select", "DatePicker", "Checkbox", "Radio"].includes(x.type) && !x.props.name) errors.push(`${x.type} ${x.id} thiếu name`);
  });
  if (n < 10 || n > 70) errors.push(`kích thước ${n} node (cần 10–70)`);
  const perm = `${permission} ${r.requirement?.permissions?.join(" ")}`.toLowerCase();
  if (/chỉ xem/.test(perm) && labels.some((l) => /^(thêm|tạo|sửa|xóa|xoá|chỉnh sửa|lưu)/.test(l) && !/bộ lọc|tìm kiếm/.test(l))) warnings.push("màn 'chỉ xem' có nút thêm/sửa/xóa/lưu");
  if (/chỉ được tạo/.test(perm) && labels.some((l) => /^(sửa|xóa|xoá)/.test(l))) warnings.push("màn 'chỉ tạo' có sửa/xóa");
  return { errors, warnings };
}

if (process.argv[1]?.endsWith("validate-roots.ts")) {
  const matrix = JSON.parse(readFileSync(new URL("../../dataset/matrix.json", import.meta.url), "utf8")) as { id: string; permission: string }[];
  const perm = new Map(matrix.map((m) => [m.id, m.permission]));
  let bad = 0, total = 0;
  for (const f of process.argv.slice(2)) {
    for (const r of JSON.parse(readFileSync(f, "utf8")) as RootRecord[]) {
      total++;
      const { errors, warnings } = checkRoot(r, perm.get(r.id));
      if (errors.length) bad++;
      if (errors.length || warnings.length) console.log(`${r.id}: ${[...errors.map((e) => "LỖI " + e), ...warnings.map((w) => "CẢNH BÁO " + w)].join(" | ")}`);
    }
  }
  console.log(`${total} màn, ${bad} màn lỗi`);
  process.exit(bad ? 1 : 0);
}
