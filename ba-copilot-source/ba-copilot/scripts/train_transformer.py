"""Huấn luyện Transformer gợi ý phần tử còn thiếu trong cây giao diện (xem shared/transformer.ts để biết biểu diễn).

Dữ liệu: data/corpus/tf/{train,wi,synth}.jsonl do `npm run export-tf-data` xuất.
Mỗi bước, một cây đầy đủ bị "làm hỏng" ngẫu nhiên theo 3 kiểu, mô phỏng màn BA đang làm dở:
  - giữ nguyên (15%)             → mọi ô phải dự đoán "không thiếu"
  - xóa ngẫu nhiên (40%)          → mỗi node bị xóa (kèm cây con) với xác suất 5–35%: thiếu ở giữa hoặc cuối
  - cắt theo BFS (45%)            → giữ 5–95% node đầu theo BFS như cách đánh giá của Li et al. 2020
Nhãn của mỗi token: loại (+ loại con) của phần tử bị xóa đầu tiên ngay trước nó (token "</>" = cuối container).

Chạy (CPU là đủ, ~10–20 phút):
  pip install torch
  python scripts/train_transformer.py --epochs 12 --out model/next-transformer.json
Kết quả: model/next-transformer.json (trọng số base64, đọc bằng shared/transformer.ts) + analysis/train-transformer.json
"""
import argparse
import base64
import json
import math
import os
import random
import time

import torch
import torch.nn as nn
import torch.nn.functional as F

N_TYPES = 28          # ALL_TYPES
CLOSE = N_TYPES       # token "</>"
TYPES = ["Page", "Header", "Sidebar", "Section", "Card", "Row", "Column", "Form", "List", "Modal", "Heading", "Text", "Button", "Link",
         "Input", "Textarea", "Select", "Checkbox", "Radio", "DatePicker", "Table", "Image", "Badge", "Alert", "Stat", "Avatar", "Divider", "Pagination"]
SUBTYPES = ["-", "email", "password", "search", "phone", "number", "name", "text", "submit", "cancel", "create", "delete", "icon", "other", "auth", "remember", "agree"]


def kids(n):
    return n[2] if len(n) > 2 else None


def linearize(tree, keep, max_depth):
    """Duỗi cây đã bỏ các node không thuộc `keep` (tập id(node)). Trả tok_type, tok_sub, depth, tgt_type, tgt_sub.
    tgt_type: 0 = không thiếu, 1 + chỉ số loại nếu thiếu; tgt_sub: -100 nếu không thiếu."""
    tt, ts, td, gt, gs = [], [], [], [], []

    def emit(t, s, d, miss):
        tt.append(t); ts.append(s); td.append(min(d, max_depth - 1))
        gt.append(0 if miss is None else 1 + miss[0]); gs.append(-100 if miss is None else miss[1])

    def rec(n, d, miss):
        emit(n[0], n[1], d, miss)
        ch = kids(n)
        if ch is None:
            return
        pending = None
        for c in ch:
            if id(c) not in keep:
                if pending is None:
                    pending = c
                continue
            rec(c, d + 1, pending)
            pending = None
        emit(CLOSE, 0, d, pending)

    rec(tree, 0, None)
    return tt, ts, td, gt, gs


def all_nodes_bfs(tree):
    out, q = [], [tree]
    while q:
        n = q.pop(0)
        out.append(n)
        q.extend(kids(n) or [])
    return out


def preorder(tree):
    out = [tree]
    for c in kids(tree) or []:
        out.extend(preorder(c))
    return out


def fixed_keep(tree, drop):
    """keep = mọi node trừ các node trong `drop` (chỉ số tiền tự) và cây con của chúng – đúng partialTree của mẫu."""
    nodes = preorder(tree)
    gone = set()
    for i in drop:
        for m in all_nodes_bfs(nodes[i]):
            gone.add(id(m))
    return {id(n) for n in nodes} - gone


@torch.no_grad()
def eval_samples(model, items, max_len, max_depth):
    """Trên bộ mẫu: với mẫu thiếu, token của ô bị bỏ (đầu tiên) phải đoán đúng loại (Top-1/Top-3);
    với mẫu đủ, không ô nào có P(thiếu) ≥ 0,5 (báo động giả)."""
    model.eval()
    r = {"missing": 0, "top1": 0, "top3": 0, "complete": 0, "alarm": 0}
    for it in items:
        tree, drop = it["tree"], it["drop"]
        tt, ts, td, gt, gs = linearize(tree, fixed_keep(tree, drop), max_depth)
        if len(tt) > max_len:
            continue
        T, S, D, _, _, P = batchify([(tt, ts, td, gt, gs)], max_len)
        _, lg = model(T, S, D, P)
        pr = lg[0].softmax(-1)
        if not drop:
            r["complete"] += 1
            r["alarm"] += int((1 - pr[:, 0]).max().item() >= 0.5)
            continue
        target_type = preorder(tree)[min(drop)][0]
        idx = [i for i, g in enumerate(gt) if g == 1 + target_type]
        if not idx:
            continue
        top = lg[0, idx[0], 1:].topk(3).indices.tolist()
        r["missing"] += 1
        r["top1"] += int(top[0] == target_type)
        r["top3"] += int(target_type in top)
    model.train()
    m = max(r["missing"], 1)
    return {"n_missing": r["missing"], "top1": r["top1"] / m, "top3": r["top3"] / m, "n_complete": r["complete"], "alarm": r["alarm"] / max(r["complete"], 1)}


def corrupt(tree, rnd):
    nodes = all_nodes_bfs(tree)
    keep = {id(n) for n in nodes}
    mode = rnd.random()
    if mode < 0.15 or len(nodes) < 2:
        return keep
    if mode < 0.55:
        p = rnd.uniform(0.05, 0.35)
        removed = [n for n in nodes[1:] if rnd.random() < p] or [rnd.choice(nodes[1:])]
        drop = set()
        for n in removed:
            for m in all_nodes_bfs(n):
                drop.add(id(m))
        return keep - drop
    k = max(1, int(len(nodes) * rnd.uniform(0.05, 0.95)))
    return {id(n) for n in nodes[:k]}


class Layer(nn.Module):
    def __init__(self, d, heads, ff, drop):
        super().__init__()
        self.h = heads
        self.ln1, self.ln2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.qkv, self.out = nn.Linear(d, 3 * d), nn.Linear(d, d)
        self.ff1, self.ff2 = nn.Linear(d, ff), nn.Linear(ff, d)
        self.drop = nn.Dropout(drop)

    def forward(self, x, pad):
        B, N, D = x.shape
        q, k, v = self.qkv(self.ln1(x)).split(D, dim=-1)
        sh = lambda t: t.view(B, N, self.h, D // self.h).transpose(1, 2)
        att = (sh(q) @ sh(k).transpose(-1, -2)) / math.sqrt(D // self.h)
        att = att.masked_fill(pad[:, None, None, :], float("-inf")).softmax(-1)
        o = (att @ sh(v)).transpose(1, 2).reshape(B, N, D)
        x = x + self.drop(self.out(o))
        return x + self.drop(self.ff2(F.gelu(self.ff1(self.ln2(x)), approximate="tanh")))


class TreeTransformer(nn.Module):
    def __init__(self, d, heads, layers, ff, max_len, max_depth, drop=0.1):
        super().__init__()
        self.emb_type = nn.Embedding(N_TYPES + 1, d)
        self.emb_sub = nn.Embedding(len(SUBTYPES), d)
        self.emb_depth = nn.Embedding(max_depth, d)
        self.emb_pos = nn.Embedding(max_len, d)
        self.layers = nn.ModuleList([Layer(d, heads, ff, drop) for _ in range(layers)])
        self.ln_f = nn.LayerNorm(d)
        self.head_type = nn.Linear(d, N_TYPES + 1)
        self.emb_cond = nn.Embedding(N_TYPES, d)
        self.head_sub = nn.Linear(d, len(SUBTYPES))
        self.drop = nn.Dropout(drop)

    def forward(self, t, s, dpt, pad):
        pos = torch.arange(t.shape[1], device=t.device)[None]
        x = self.drop(self.emb_type(t) + self.emb_sub(s) + self.emb_depth(dpt) + self.emb_pos(pos))
        for l in self.layers:
            x = l(x, pad)
        h = self.ln_f(x)
        return h, self.head_type(h)

    def sub_logits(self, h, type_idx):
        return self.head_sub(h + self.emb_cond(type_idx))


def batchify(seqs, max_len):
    seqs = [tuple(a[:max_len] for a in s) for s in seqs]
    n = max(len(s[0]) for s in seqs)
    pad = lambda a, v: a + [v] * (n - len(a))
    T = torch.tensor([pad(s[0], 0) for s in seqs])
    S = torch.tensor([pad(s[1], 0) for s in seqs])
    D = torch.tensor([pad(s[2], 0) for s in seqs])
    GT = torch.tensor([pad(s[3], -100) for s in seqs])
    GS = torch.tensor([pad(s[4], -100) for s in seqs])
    P = torch.tensor([[False] * len(s[0]) + [True] * (n - len(s[0])) for s in seqs])
    return T, S, D, GT, GS, P


def load(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path, encoding="utf8") if l.strip()]


@torch.no_grad()
def eval_masked(model, trees, fraction, max_len, max_depth):
    """Giao thức của Li et al. 2020 / eval-next: giữ `fraction` node đầu BFS, đoán loại node BFS kế tiếp tại token "</>" của cha."""
    model.eval()
    n = top1 = top3 = 0
    for tree in trees:
        nodes = all_nodes_bfs(tree)
        if len(nodes) < 3:
            continue
        k = min(len(nodes) - 1, max(2, int(len(nodes) * fraction)))
        keep = {id(x) for x in nodes[:k]}
        target = nodes[k]
        parent = next(p for p in nodes[:k] if any(c is target for c in (kids(p) or [])))
        tt, ts, td, gt, gs = linearize(tree, keep, max_depth)
        # vị trí token "</>" của cha: duỗi lại để tìm
        idx = close_index(tree, keep, parent)
        if idx >= max_len:
            continue
        T, S, D, _, _, P = batchify([(tt, ts, td, gt, gs)], max_len)
        _, logits = model(T, S, D, P)
        pr = logits[0, idx, 1:].clone()
        pr[0] = -1e9  # không đoán Page
        top = pr.topk(3).indices.tolist()
        n += 1
        top1 += top[0] == target[0]
        top3 += target[0] in top
    model.train()
    return {"fraction": fraction, "n": n, "top1": top1 / max(n, 1), "top3": top3 / max(n, 1)}


def close_index(tree, keep, parent):
    i = [0]
    found = [-1]

    def rec(n):
        i[0] += 1
        ch = kids(n)
        if ch is None:
            return
        for c in ch:
            if id(c) in keep:
                rec(c)
        if n is parent:
            found[0] = i[0]
        i[0] += 1

    rec(tree)
    return found[0]


def export(model, cfg, meta, path):
    tensors = {}
    for name, p in model.state_dict().items():
        a = p.detach().cpu().float().contiguous().numpy()
        tensors[name] = {"shape": list(a.shape), "b64": base64.b64encode(a.astype("<f4").tobytes()).decode()}
    json.dump({"config": cfg, "types": TYPES + ["</>"], "subtypes": SUBTYPES, "meta": meta, "tensors": tensors}, open(path, "w"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/corpus/tf")
    ap.add_argument("--out", default="model/next-transformer.json")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--d", type=int, default=96)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--layers", type=int, default=4)
    ap.add_argument("--ff", type=int, default=384)
    ap.add_argument("--max-len", type=int, default=192)
    ap.add_argument("--max-depth", type=int, default=12)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--limit", type=int, default=0, help="chỉ dùng N cây đầu (chạy thử)")
    ap.add_argument("--parity-out", default="model/next-transformer.parity.json")
    ap.add_argument("--samples", default="", help="thư mục bộ mẫu bổ sung UI (data/dataset/tf): học từ cặp màn thiếu → phần bổ sung")
    ap.add_argument("--augment", type=float, default=0.5, help="(--samples) xác suất làm hỏng ngẫu nhiên cây đầy đủ của mẫu thay cho mẫu cố định")
    a = ap.parse_args()
    torch.manual_seed(a.seed)
    torch.set_num_threads(a.threads)
    rnd = random.Random(a.seed)

    if a.samples:
        train = load(f"{a.samples}/train.jsonl")
        val = load(f"{a.samples}/val.jsonl")
        tests = {}
        pool = [(r["tree"], r["drop"]) for r in train]
    else:
        train = load(f"{a.data}/train.jsonl")
        if a.limit:
            random.Random(1).shuffle(train)
            train = train[:a.limit]
        tests = {k: [r["tree"] for r in load(f"{a.data}/{k}.jsonl")] for k in ("wi", "synth")}
        pool = [(r["tree"], None) for r in train for _ in range(int(r.get("w", 1)))]
    cfg = {"d": a.d, "heads": a.heads, "layers": a.layers, "ff": a.ff, "maxLen": a.max_len, "maxDepth": a.max_depth}
    model = TreeTransformer(a.d, a.heads, a.layers, a.ff, a.max_len, a.max_depth)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"{len(train)} cây ({len(pool)} sau trọng số) · {n_params:,} tham số · cfg {cfg}")
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    steps = a.epochs * math.ceil(len(pool) / a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=steps, pct_start=0.05)
    history = []
    t0 = time.time()
    for ep in range(a.epochs):
        rnd.shuffle(pool)
        # gom cây cùng độ dài vào một batch cho nhanh
        chunks = [pool[i:i + a.batch * 50] for i in range(0, len(pool), a.batch * 50)]
        tot, cnt = 0.0, 0
        for ch in chunks:
            seqs = [linearize(t, fixed_keep(t, d) if d is not None and rnd.random() >= a.augment else corrupt(t, rnd), a.max_depth) for t, d in ch]
            seqs.sort(key=lambda s: len(s[0]))
            batches = [seqs[i:i + a.batch] for i in range(0, len(seqs), a.batch)]
            rnd.shuffle(batches)
            for b in batches:
                T, S, D, GT, GS, P = batchify(b, a.max_len)
                h, logits = model(T, S, D, P)
                loss = F.cross_entropy(logits.reshape(-1, logits.shape[-1]), GT.reshape(-1), ignore_index=-100)
                m = GS >= 0
                if m.any():
                    sl = model.sub_logits(h[m], GT[m] - 1)
                    loss = loss + 0.5 * F.cross_entropy(sl, GS[m])
                opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
                sched.step()
                tot += loss.item(); cnt += 1
        if a.samples:
            v = eval_samples(model, val, a.max_len, a.max_depth)
            history.append({"epoch": ep + 1, "loss": tot / cnt, **v})
            print(f"epoch {ep + 1}/{a.epochs} loss {tot / cnt:.4f} · val: Top-1 {v['top1']:.3f} Top-3 {v['top3']:.3f} (n={v['n_missing']}) · báo động giả {v['alarm']:.3f} (n={v['n_complete']}) · {time.time() - t0:.0f}s", flush=True)
        else:
            res = {k: eval_masked(model, v[:800], 0.5, a.max_len, a.max_depth) for k, v in tests.items() if v}
            history.append({"epoch": ep + 1, "loss": tot / cnt, **{k: round(r["top3"], 4) for k, r in res.items()}})
            print(f"epoch {ep + 1}/{a.epochs} loss {tot / cnt:.4f} · top-3@50% " + " ".join(f"{k} {r['top3']:.3f}" for k, r in res.items()) + f" · {time.time() - t0:.0f}s", flush=True)

    model.eval()
    if a.samples:
        final = {"val": eval_samples(model, val, a.max_len, a.max_depth)}
        meta = {"builtAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "trees": len({r["rootId"] for r in train}), "samples": len(train), "params": n_params, "epochs": a.epochs,
                "sources": {"ui-completion-dataset": len(train)}, "augment": a.augment}
        parity_trees = [r["tree"] for r in val[:3]]
    else:
        final = {k: [eval_masked(model, v, f, a.max_len, a.max_depth) for f in (0.1, 0.5, 0.8)] for k, v in tests.items() if v}
        meta = {"builtAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "trees": len(train), "params": n_params, "epochs": a.epochs,
                "sources": {s: sum(1 for r in train if r["src"] == s) for s in sorted({r["src"] for r in train})}}
        parity_trees = (tests.get("synth") or tests.get("wi"))[:3]
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    export(model, cfg, meta, a.out)
    os.makedirs("analysis", exist_ok=True)
    json.dump({"meta": meta, "config": cfg, "history": history, "final": final}, open("analysis/train-transformer.json", "w"), indent=1)
    # mẫu đối chiếu số học Python ↔ TypeScript (tests/transformer.test.ts)
    parity = []
    model.eval()
    with torch.no_grad():
        for tree in parity_trees:
            tt, ts, td, gt, gs = linearize(tree, {id(n) for n in all_nodes_bfs(tree)}, a.max_depth)
            T, S, D, _, _, P = batchify([(tt, ts, td, gt, gs)], a.max_len)
            _, lg = model(T, S, D, P)
            parity.append({"tree": tree, "logits": [round(x, 5) for x in lg[0].reshape(-1).tolist()]})
    json.dump(parity, open(a.parity_out, "w"))
    print(json.dumps(final, indent=1))
    print(f"→ {a.out} ({os.path.getsize(a.out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
