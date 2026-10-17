// Thước đo đánh giá hoàn thiện cây giao diện theo Li et al. 2020, mục 5.2 (bản nới lỏng: cây BA Copilot không có
// tọa độ khung bao nên hai node "khớp" khi cùng loại component – đúng như phép đo nới lỏng ở mục 6 của bài báo).
//  - Layout Tree Edit Distance: khoảng cách sửa cây tối ưu (Zhang & Shasha 1989), chi phí mỗi phép sửa quy ra
//    giây theo Keystroke-Level Model (Card, Moran & Newell 1980).
//  - Parent-Child Pair Retrieval: precision / recall / F1 trên tập (đa tập) cặp (loại cha, loại con).
import type { UINode } from "../shared/design.ts";

/** Toán tử KLM (giây): M nghĩ, P trỏ chuột, B nhấn hoặc nhả nút chuột. */
export const KLM = { M: 1.35, P: 1.1, B: 0.1 };
/**
 * Chi phí phép sửa (giây):
 *  - Chèn: M + P·B (nhấn giữ phần tử trên bảng công cụ) + P·B (kéo thả lên canvas) + P·B·B (kéo góc chỉnh kích thước)
 *  - Đổi loại: M + P·B·B (chuột phải vào phần tử) + P·B·B (chọn loại mới)
 *  - Xóa: tối thiểu (bài báo: người thiết kế có thể bỏ qua phần tử thừa) = một lần nhấn B
 */
export const EDIT_COST = {
  insert: KLM.M + 3 * KLM.P + 4 * KLM.B,
  relabel: KLM.M + 2 * KLM.P + 4 * KLM.B,
  delete: KLM.B,
};

/** Khoảng cách sửa cây Zhang–Shasha: chi phí biến cây dự đoán `a` thành cây đúng `b`. */
export function treeEditDistance(a: UINode, b: UINode, cost = EDIT_COST): number {
  const A = postorder(a), B = postorder(b);
  const kA = keyroots(A), kB = keyroots(B);
  const td: number[][] = Array.from({ length: A.labels.length }, () => new Array(B.labels.length).fill(0));
  for (const i of kA)
    for (const j of kB) {
      const li = A.lml[i], lj = B.lml[j];
      const m = i - li + 2, n = j - lj + 2;
      const fd: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
      for (let x = 1; x < m; x++) fd[x][0] = fd[x - 1][0] + cost.delete;
      for (let y = 1; y < n; y++) fd[0][y] = fd[0][y - 1] + cost.insert;
      for (let x = 1; x < m; x++)
        for (let y = 1; y < n; y++) {
          const ia = li + x - 1, jb = lj + y - 1;
          if (A.lml[ia] === li && B.lml[jb] === lj) {
            fd[x][y] = Math.min(fd[x - 1][y] + cost.delete, fd[x][y - 1] + cost.insert, fd[x - 1][y - 1] + (A.labels[ia] === B.labels[jb] ? 0 : cost.relabel));
            td[ia][jb] = fd[x][y];
          } else {
            const p = A.lml[ia] - li, q = B.lml[jb] - lj;
            fd[x][y] = Math.min(fd[x - 1][y] + cost.delete, fd[x][y - 1] + cost.insert, fd[p][q] + td[ia][jb]);
          }
        }
    }
  return td[A.labels.length - 1][B.labels.length - 1];
}

function postorder(t: UINode) {
  const labels: string[] = [];
  const lml: number[] = []; // chỉ số lá trái nhất của cây con tại mỗi node (theo hậu tự)
  const rec = (n: UINode): number => {
    let first = -1;
    for (const c of n.children ?? []) {
      const l = rec(c);
      if (first < 0) first = l;
    }
    labels.push(n.type);
    const idx = labels.length - 1;
    lml.push(first < 0 ? idx : first);
    return lml[idx];
  };
  rec(t);
  return { labels, lml };
}

function keyroots(t: { lml: number[] }): number[] {
  const seen = new Map<number, number>();
  t.lml.forEach((l, i) => seen.set(l, i)); // node cao nhất (hậu tự lớn nhất) có cùng lá trái nhất
  return [...seen.values()].sort((x, y) => x - y);
}

/** Đa tập cặp "loại cha>loại con". */
export function pairs(t: UINode): Map<string, number> {
  const m = new Map<string, number>();
  const rec = (n: UINode) => {
    for (const c of n.children ?? []) {
      const k = `${n.type}>${c.type}`;
      m.set(k, (m.get(k) ?? 0) + 1);
      rec(c);
    }
  };
  rec(t);
  return m;
}

export function pairPRF(pred: UINode, truth: UINode): { p: number; r: number; f1: number } {
  const P = pairs(pred), T = pairs(truth);
  let hit = 0, np = 0, nt = 0;
  for (const v of P.values()) np += v;
  for (const v of T.values()) nt += v;
  for (const [k, v] of P) hit += Math.min(v, T.get(k) ?? 0);
  const p = np ? hit / np : 0, r = nt ? hit / nt : 0;
  return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
}
