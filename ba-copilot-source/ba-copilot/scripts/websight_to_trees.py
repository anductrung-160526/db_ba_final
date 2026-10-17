"""Tải mẫu WebSight (HuggingFaceM4/WebSight, v0.2) bằng streaming và chuyển HTML sang cây UINode
của BA Copilot (28 loại component). Chỉ lấy HTML, không tải ảnh.

Cài:   pip install datasets beautifulsoup4
Chạy:  python scripts/websight_to_trees.py --n 30000 --out data/corpus/websight.jsonl
       python scripts/websight_to_trees.py --html-dir thu_muc_html --out data/corpus/admin.jsonl --source admin
Sau đó: npm run build-model -- --in data/corpus/internal.jsonl,data/corpus/websight.jsonl
"""
import argparse
import json
import os
import re
import sys

from bs4 import BeautifulSoup, NavigableString, Tag

SKIP = {"script", "style", "svg", "noscript", "meta", "link", "head", "iframe", "path", "br"}
CONTAINERS = {"Page", "Header", "Sidebar", "Section", "Card", "Row", "Column", "Form", "List", "Modal"}
_counter = [0]


def nid(prefix):
    _counter[0] += 1
    return f"{prefix}_{_counter[0]}"


def text_of(el, limit=60):
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True))[:limit]


def classes(el):
    return set(el.get("class") or [])


def label_for(el, soup):
    if el.get("id"):
        lb = soup.find("label", attrs={"for": el["id"]})
        if lb:
            return text_of(lb)
    parent_label = el.find_parent("label")
    if parent_label:
        return text_of(parent_label)
    return el.get("placeholder") or el.get("aria-label") or el.get("name") or "Trường nhập"


def leaf(el, soup):
    """Trả node lá hoặc None. Không xử lý container."""
    tag = el.name
    if tag == "input":
        t = (el.get("type") or "text").lower()
        if t in ("hidden",):
            return None
        if t in ("submit", "button"):
            return {"id": nid("btn"), "type": "Button", "props": {"label": el.get("value") or "Gửi", "action": "submit"}}
        if t == "checkbox":
            return {"id": nid("chk"), "type": "Checkbox", "props": {"label": label_for(el, soup), "name": el.get("name") or ""}}
        if t == "date":
            return {"id": nid("date"), "type": "DatePicker", "props": {"label": label_for(el, soup), "name": el.get("name") or ""}}
        props = {"label": label_for(el, soup), "name": el.get("name") or "", "inputType": t if t in ("email", "password", "number", "tel") else "text"}
        if el.has_attr("required"):
            props["required"] = True
        for a, k in (("minlength", "minLength"), ("maxlength", "maxLength"), ("pattern", "pattern")):
            if el.get(a):
                props[k] = el.get(a)
        if el.get("placeholder"):
            props["placeholder"] = el.get("placeholder")
        return {"id": nid("in"), "type": "Input", "props": props}
    if tag == "textarea":
        return {"id": nid("ta"), "type": "Textarea", "props": {"label": label_for(el, soup), "name": el.get("name") or ""}}
    if tag == "select":
        opts = [text_of(o, 40) for o in el.find_all("option")][:20]
        return {"id": nid("sel"), "type": "Select", "props": {"label": label_for(el, soup), "name": el.get("name") or "", "options": opts}}
    if tag == "button":
        return {"id": nid("btn"), "type": "Button", "props": {"label": text_of(el, 40) or "Nút", "action": el.get("type") or "click"}}
    if tag == "a":
        return {"id": nid("lnk"), "type": "Link", "props": {"text": text_of(el, 40) or "Liên kết", "navigateTo": el.get("href") or ""}}
    if tag == "table":
        cols = [text_of(th, 30) for th in el.find_all("th")][:12]
        return {"id": nid("tbl"), "type": "Table", "props": {"columns": cols}}
    if tag in ("h1", "h2", "h3"):
        return {"id": nid("h"), "type": "Heading", "props": {"text": text_of(el), "level": int(tag[1])}}
    if tag in ("h4", "h5", "h6", "p", "span", "blockquote") and text_of(el):
        # chỉ coi là Text nếu không chứa phần tử tương tác
        if not el.find(["a", "button", "input", "select", "textarea", "form"]):
            return {"id": nid("txt"), "type": "Text", "props": {"text": text_of(el)}}
    if tag == "img":
        return {"id": nid("img"), "type": "Image", "props": {"alt": el.get("alt") or "Ảnh"}}
    if tag == "hr":
        return {"id": nid("hr"), "type": "Divider", "props": {}}
    return None


def container_type(el):
    tag, cls = el.name, classes(el)
    if tag == "form":
        return "Form"
    if tag == "header":
        return "Header"
    if tag in ("nav", "aside"):
        return "Sidebar"
    if tag in ("section", "main", "article"):
        return "Section"
    if tag in ("ul", "ol") and len(el.find_all("li", recursive=False)) >= 3:
        return "List"
    if tag in ("div", "li", "footer"):
        if "rounded" in " ".join(cls) and any(c.startswith("shadow") or c == "border" for c in cls):
            return "Card"
        if "flex" in cls and "flex-col" not in cls:
            return "Row"
        if "flex-col" in cls or "grid" in cls:
            return "Column"
    return None


def convert(el, soup):
    """Trả danh sách node (một phần tử bị bỏ sẽ đưa con của nó lên cha)."""
    if isinstance(el, NavigableString) or not isinstance(el, Tag) or el.name in SKIP:
        return []
    lf = leaf(el, soup)
    if lf:
        return [lf]
    kids = []
    for c in el.children:
        kids.extend(convert(c, soup))
    ct = container_type(el)
    if ct and kids:
        props = {"title": text_of(el.find(["h1", "h2", "h3"]), 40)} if ct in ("Card", "Section") and el.find(["h1", "h2", "h3"]) else {}
        return [{"id": nid(ct.lower()), "type": ct, "props": props, "children": kids}]
    return kids


def stats(node, depth=1):
    n, d = 1, depth
    for c in node.get("children", []):
        cn, cd = stats(c, depth + 1)
        n += cn
        d = max(d, cd)
    return n, d


def html_to_tree(html):
    _counter[0] = 0
    soup = BeautifulSoup(html, "html.parser")
    title = text_of(soup.title, 60) if soup.title else "Trang"
    body = soup.body or soup
    kids = []
    for c in body.children:
        kids.extend(convert(c, soup))
    tree = {"id": "page", "type": "Page", "props": {"title": title or "Trang"}, "children": kids}
    n, d = stats(tree)
    return tree if 3 <= n <= 120 and d <= 8 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=30000)
    ap.add_argument("--out", default="data/corpus/websight.jsonl")
    ap.add_argument("--config", default="v0.2")
    ap.add_argument("--html-dir", help="Chuyển các file .html trong thư mục (vd mẫu admin) thay vì tải WebSight")
    ap.add_argument("--source", default="websight")
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)

    if a.html_dir:
        rows = (open(os.path.join(a.html_dir, f), encoding="utf-8", errors="ignore").read() for f in sorted(os.listdir(a.html_dir)) if f.endswith(".html"))
    else:
        from datasets import load_dataset

        ds = load_dataset("HuggingFaceM4/WebSight", a.config, split="train", streaming=True)
        first = next(iter(ds))
        print("Các cột:", list(first.keys()), file=sys.stderr)
        col = "text" if "text" in first else next(k for k, v in first.items() if isinstance(v, str) and "<html" in v.lower())
        rows = (r[col] for r in ds)

    kept = seen = 0
    with open(a.out, "w", encoding="utf-8") as f:
        for html in rows:
            seen += 1
            try:
                tree = html_to_tree(html)
            except Exception:
                tree = None
            if tree:
                f.write(json.dumps({"source": a.source, "tree": tree}, ensure_ascii=False) + "\n")
                kept += 1
            if seen % 1000 == 0:
                print(f"đã đọc {seen}, giữ {kept}", file=sys.stderr)
            if kept >= a.n:
                break
    print(f"Xong: đọc {seen} trang, giữ {kept} cây → {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
