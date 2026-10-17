// Design Studio: prompt sinh màn hình, khoanh vùng (click / kéo khung), bình luận theo vùng,
// gửi bình luận vào prompt, prompt sửa theo vùng, lịch sử phiên bản, xem thử prototype.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { get, post, patch, del, download } from "../api.ts";
import type { Annotation, ModuleDetail, ScreenVersion } from "../../shared/types.ts";
import type { Suggestion } from "../../shared/nextComponent.ts";
import { findNode, nodeLabel, topMostIds, UINode } from "../../shared/design.ts";
import { Renderer } from "../components/Renderer.tsx";
import { Badge, Btn, Empty, Field, Modal, StatusBadge, fmtTime, useUI } from "../components/ui.tsx";

type Mode = "select" | "region" | "prototype";
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TEMPLATES = [
  { name: "Đăng nhập", prompt: "Màn hình đăng nhập bằng email và mật khẩu, có ghi nhớ đăng nhập, quên mật khẩu và link đăng ký." },
  { name: "Quản lý sản phẩm", prompt: "Màn hình quản lý sản phẩm: tìm kiếm theo tên, lọc theo danh mục và trạng thái, bảng danh sách có sửa/xóa, nút thêm mới, phân trang." },
  { name: "Thêm sản phẩm", prompt: "Form thêm sản phẩm: tên, mã SKU, danh mục, giá bán, số lượng tồn, mô tả, ảnh; nút Lưu và Hủy." },
  { name: "Trang chủ", prompt: "Dashboard tổng quan cho quản trị viên: các chỉ số doanh thu, đơn hàng, khách hàng mới và bảng đơn hàng gần đây." },
];

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();

export function DesignTab({ m, reload }: { m: ModuleDetail; reload: () => Promise<unknown> }) {
  const { run, toast } = useUI();
  const [screenId, setScreenId] = useState<string | null>(m.screens[0]?.id ?? null);
  const [mode, setMode] = useState<Mode>("select");
  const [selected, setSelected] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [versions, setVersions] = useState<ScreenVersion[]>([]);
  const [viewVersion, setViewVersion] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [comment, setComment] = useState("");
  const [prompt, setPrompt] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<"edit" | "versions" | "layers" | "suggest">("edit");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggMeta, setSuggMeta] = useState<{ versionId: string; kind: string; trees: number; learned: number } | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [suggHover, setSuggHover] = useState<string | null>(null);
  const shownRef = useRef<Set<string>>(new Set());
  const fromSuggestion = useRef(false);
  const [newScreen, setNewScreen] = useState<{ name: string; prompt: string } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // giữ screenId hợp lệ khi danh sách thay đổi
  useEffect(() => {
    if (!m.screens.find((s) => s.id === screenId)) setScreenId(m.screens[0]?.id ?? null);
  }, [m.screens, screenId]);

  const screen = m.screens.find((s) => s.id === screenId) ?? null;
  const loadVersions = useCallback(() => {
    if (!screenId) return setVersions([]);
    return get<ScreenVersion[]>(`/api/screens/${screenId}/versions`).then(setVersions).catch(() => {});
  }, [screenId]);
  useEffect(() => {
    loadVersions();
    setSelected([]);
    setViewVersion(null);
    setChecked(new Set());
  }, [screenId]);

  const latest = versions[0];
  const previewing = viewVersion ? versions.find((v) => v.id === viewVersion) ?? null : null;
  const tree: UINode | null = previewing?.tree ?? screen?.tree ?? null;
  const changedIds = useMemo(() => (showChanges && !previewing && latest && latest.id === screen?.currentVersionId ? latest.changedIds : previewing?.changedIds ?? []), [showChanges, previewing, latest, screen]);
  const annotations = m.annotations.filter((a) => a.screenId === screenId);
  const openAnns = annotations.filter((a) => a.status !== "resolved");

  // ------------------------------------------------ đo vị trí các node để vẽ lớp phủ
  const rectOf = useCallback((id: string): Rect | null => {
    const el = contentRef.current?.querySelector(`[data-node-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    const f = frameRef.current?.getBoundingClientRect();
    if (!el || !f) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - f.left, y: r.top - f.top, w: r.width, h: r.height };
  }, []);

  const measure = useCallback(() => {
    const ids = new Set<string>([...selected, ...changedIds, ...(hover ? [hover] : []), ...(suggHover ? [suggHover] : []), ...openAnns.flatMap((a) => a.nodeIds.slice(0, 1))]);
    const next: Record<string, Rect> = {};
    for (const id of ids) {
      const r = rectOf(id);
      if (r) next[id] = r;
    }
    setRects(next);
  }, [selected, changedIds, hover, suggHover, openAnns.map((a) => a.id + a.nodeIds[0]).join(), rectOf]);

  useLayoutEffect(() => {
    measure();
  }, [measure, tree]);
  useEffect(() => {
    const ro = new ResizeObserver(() => measure());
    if (contentRef.current) ro.observe(contentRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // ------------------------------------------------ gợi ý thành phần tiếp theo (debounce 300 ms)
  const selKey = selected.join(",");
  useEffect(() => {
    if (!screen?.currentVersionId) return setSuggestions([]);
    const t = setTimeout(() => {
      get<{ suggestions: Suggestion[]; versionId: string; model: { kind: string; trees: number; learned: number } }>(`/api/screens/${screen.id}/suggestions?nodeIds=${encodeURIComponent(selKey)}`)
        .then((r) => {
          setSuggestions(r.suggestions);
          setSuggMeta({ versionId: r.versionId, ...r.model });
        })
        .catch(() => setSuggestions([]));
    }, 300);
    return () => clearTimeout(t);
  }, [screen?.id, screen?.currentVersionId, screen?.status, selKey, m.annotations.length]);

  const visibleSuggestions = suggestions.filter((s) => !dismissed.has(s.id));
  const logSugg = (s: Suggestion, action: "shown" | "applied" | "dismissed") =>
    screen && post("/api/suggestions/events", { screenId: screen.id, versionId: suggMeta?.versionId, kind: s.kind, targetNodeId: s.targetNodeId, title: s.title, confidence: s.confidence, action }).catch(() => {});

  // ghi "shown" một lần cho mỗi gợi ý của mỗi phiên bản khi tab Gợi ý đang mở
  useEffect(() => {
    if (panel !== "suggest") return;
    for (const s of visibleSuggestions) {
      const key = `${suggMeta?.versionId}:${s.id}`;
      if (shownRef.current.has(key)) continue;
      shownRef.current.add(key);
      logSugg(s, "shown");
    }
  }, [panel, visibleSuggestions.map((s) => s.id).join()]);

  const applySuggestion = (s: Suggestion) => {
    logSugg(s, "applied");
    setSelected([s.targetNodeId]);
    setPrompt(s.fixPrompt);
    fromSuggestion.current = true;
    setPanel("edit");
    setSuggHover(null);
    toast("Đã khoanh vùng và điền sẵn prompt – kiểm tra rồi bấm “Sửa vùng đã khoanh”", "info");
  };
  const dismissSuggestion = (s: Suggestion) => {
    setDismissed((d) => new Set([...d, s.id]));
    logSugg(s, "dismissed");
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) setSelected([]);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ------------------------------------------------ tương tác canvas
  const nodeFromEvent = (e: React.MouseEvent) => (e.target as HTMLElement).closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;

  const onCanvasClick = (e: React.MouseEvent) => {
    if (mode !== "select") return;
    e.preventDefault();
    const id = nodeFromEvent(e);
    if (!id) return setSelected([]);
    if (e.shiftKey || e.metaKey || e.ctrlKey) setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    else setSelected([id]);
  };

  const framePoint = (e: React.MouseEvent) => {
    const f = frameRef.current!.getBoundingClientRect();
    return { x: e.clientX - f.left, y: e.clientY - f.top };
  };
  const onOverlayDown = (e: React.MouseEvent) => {
    if (mode !== "region") return;
    const p = framePoint(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onOverlayMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const p = framePoint(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const onOverlayUp = () => {
    if (!drag || !tree) return setDrag(null);
    const box = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
    setDrag(null);
    if (box.w < 6 || box.h < 6) return;
    const inside: string[] = [];
    let smallestContainer: { id: string; area: number } | null = null;
    contentRef.current?.querySelectorAll("[data-node-id]").forEach((el) => {
      const id = el.getAttribute("data-node-id")!;
      const r = rectOf(id);
      if (!r || r.w === 0) return;
      if (r.x >= box.x - 2 && r.y >= box.y - 2 && r.x + r.w <= box.x + box.w + 2 && r.y + r.h <= box.y + box.h + 2) inside.push(id);
      if (r.x <= box.x && r.y <= box.y && r.x + r.w >= box.x + box.w && r.y + r.h >= box.y + box.h) {
        const area = r.w * r.h;
        if (!smallestContainer || area < smallestContainer.area) smallestContainer = { id, area };
      }
    });
    const picked = inside.length ? topMostIds(tree, inside) : smallestContainer ? [(smallestContainer as { id: string }).id] : [];
    setSelected(picked);
    if (picked.length) setMode("select");
  };

  const onNavigate = (target: string) => {
    const t = norm(target);
    const found = m.screens.find((s) => norm(s.name) === t || norm(String(s.tree?.props.title ?? "")) === t);
    if (found) {
      setScreenId(found.id);
      toast(`→ ${found.name}`, "info");
    } else {
      toast(`Chưa có màn hình "${target}". Tạo mới để hoàn thiện luồng.`, "info");
      setNewScreen({ name: target, prompt: `Màn hình ${target}` });
    }
  };

  // ------------------------------------------------ hành động
  const createScreen = async () => {
    if (!newScreen) return;
    const r = await run("AI đang thiết kế màn hình…", () => post(`/api/modules/${m.id}/screens`, newScreen));
    if (r) {
      setNewScreen(null);
      await reload();
      setScreenId(r.screen.id);
      toast("Đã tạo màn hình", "ok");
    }
  };

  const unionBox = (ids: string[]): Rect | null => {
    const rs = ids.map((id) => rectOf(id)).filter(Boolean) as Rect[];
    if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.x));
    const y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
  };

  const addComment = async () => {
    if (!screen || !comment.trim()) return;
    const a = await run("Đang lưu bình luận", () => post<Annotation>(`/api/screens/${screen.id}/annotations`, { nodeIds: selected, comment, bbox: unionBox(selected) }));
    if (a) {
      setComment("");
      setChecked((c) => new Set([...c, a.id]));
      await reload();
    }
  };

  const applyEdit = async () => {
    if (!screen) return;
    const ids = [...checked].filter((id) => annotations.some((a) => a.id === id));
    if (!prompt.trim() && !ids.length) return toast("Nhập yêu cầu sửa hoặc tick bình luận để gửi vào prompt", "err");
    const label = selected.length || ids.length ? "AI đang sửa vùng đã khoanh…" : "AI đang sửa toàn màn hình…";
    const r = await run(label, () => post(`/api/screens/${screen.id}/edit`, { prompt, nodeIds: selected, annotationIds: ids }));
    if (!r) return;
    if (r.version) toast(`v${r.version.number}: ${r.summary || "Đã cập nhật thiết kế"}`, "ok");
    else toast(r.summary, "info");
    if (r.rejected?.length) toast(`${r.rejected.length} thao tác ngoài vùng khoanh đã bị chặn`, "err");
    setPrompt("");
    setChecked(new Set());
    setShowChanges(true);
    // sửa xong theo gợi ý → bỏ vùng chọn và mở lại tab Gợi ý để thấy phần tử tiếp theo cần sửa
    if (fromSuggestion.current && r.version) {
      fromSuggestion.current = false;
      setSelected([]);
      setPanel("suggest");
    }
    await reload();
    await loadVersions();
  };

  const approve = async (approved: boolean) => {
    if (!screen) return;
    if (!approved && m.docsStatus !== "none" && !confirm("Bỏ duyệt sẽ chuyển tài liệu và test hiện có sang Lỗi thời. Tiếp tục?")) return;
    await run("Đang cập nhật", () => post(`/api/screens/${screen.id}/approve`, { approved }));
    await reload();
    toast(approved ? "Đã duyệt thiết kế – có thể sinh tài liệu" : "Đã chuyển về bản nháp", "ok");
  };

  const revert = async (v: ScreenVersion) => {
    if (!screen) return;
    await run("Đang khôi phục", () => post(`/api/screens/${screen.id}/revert`, { versionId: v.id }));
    setViewVersion(null);
    await reload();
    await loadVersions();
    toast(`Đã khôi phục v${v.number} thành phiên bản mới`, "ok");
  };

  const selectedNodes = tree ? selected.map((id) => findNode(tree, id)).filter(Boolean) as UINode[] : [];

  // ------------------------------------------------ render
  return (
    <div className="studio">
      {/* Cột trái: màn hình + cây thành phần */}
      <aside className="studio-left">
        <div className="side-head">
          <span>Màn hình ({m.screens.length})</span>
          <Btn size="sm" kind="primary" onClick={() => setNewScreen({ name: "", prompt: "" })} data-testid="new-screen">
            + Mới
          </Btn>
        </div>
        <div className="screen-list">
          {m.screens.map((s) => (
            <button key={s.id} className={`screen-item ${s.id === screenId ? "active" : ""}`} onClick={() => setScreenId(s.id)}>
              <span className="screen-name">{s.name}</span>
              <span className="screen-meta">
                v{s.versionNumber} <StatusBadge status={s.status} />
              </span>
            </button>
          ))}
          {!m.screens.length && <div className="muted small pad">Chưa có màn hình. Bấm "+ Mới" và mô tả màn hình bằng prompt.</div>}
        </div>
      </aside>

      {/* Canvas */}
      <section className="studio-center">
        {!screen || !tree ? (
          <Empty title="Bắt đầu bằng một prompt">
            Mô tả màn hình cần thiết kế, AI sẽ dựng giao diện. Sau đó khoanh vùng, bình luận và prompt để sửa.
            <div className="tpl-row">
              {TEMPLATES.map((t) => (
                <button key={t.name} className="chip" onClick={() => setNewScreen(t)}>
                  {t.name}
                </button>
              ))}
            </div>
          </Empty>
        ) : (
          <>
            <div className="toolbar">
              <div className="seg" role="group" aria-label="Chế độ">
                <button className={mode === "select" ? "on" : ""} onClick={() => setMode("select")} title="Click để chọn phần tử, Shift+click để chọn nhiều" data-testid="mode-select">
                  ⌖ Chọn
                </button>
                <button className={mode === "region" ? "on" : ""} onClick={() => setMode("region")} title="Kéo khung để khoanh vùng" data-testid="mode-region">
                  ⬚ Khoanh vùng
                </button>
                <button className={mode === "prototype" ? "on" : ""} onClick={() => { setMode("prototype"); setSelected([]); }} title="Bấm nút/link để chuyển màn hình">
                  ▶ Xem thử
                </button>
              </div>
              <label className="check-inline">
                <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} /> Tô thay đổi
              </label>
              <div className="spacer" />
              <StatusBadge status={screen.status} />
              {screen.status === "approved" ? (
                <Btn size="sm" onClick={() => approve(false)}>
                  Bỏ duyệt
                </Btn>
              ) : (
                <Btn size="sm" kind="primary" onClick={() => approve(true)} data-testid="approve-screen">
                  ✓ Duyệt thiết kế
                </Btn>
              )}
              <details className="menu">
                <summary className="btn btn-ghost btn-sm">⋯</summary>
                <div className="menu-pop">
                  <button
                    onClick={async () => {
                      const name = window.prompt("Tên màn hình", screen.name);
                      if (name) {
                        await run("Đang lưu", () => patch(`/api/screens/${screen.id}`, { name }));
                        reload();
                      }
                    }}
                  >
                    Đổi tên
                  </button>
                  <button onClick={() => run("Đang xuất", () => download(`/api/screens/${screen.id}/export/json`))}>Xuất JSON</button>
                  <button
                    className="danger"
                    onClick={async () => {
                      if (!confirm(`Xóa màn hình "${screen.name}"?`)) return;
                      await run("Đang xóa", () => del(`/api/screens/${screen.id}`));
                      reload();
                    }}
                  >
                    Xóa màn hình
                  </button>
                </div>
              </details>
            </div>
            {previewing && (
              <div className="preview-banner">
                Đang xem <strong>v{previewing.number}</strong> ({fmtTime(previewing.createdAt)}) – chỉ đọc.
                <Btn size="sm" kind="primary" onClick={() => revert(previewing)}>
                  Khôi phục phiên bản này
                </Btn>
                <Btn size="sm" onClick={() => setViewVersion(null)}>
                  Về bản hiện tại
                </Btn>
              </div>
            )}
            <div className="canvas-scroll">
              <div className={`canvas-frame mode-${mode}`} ref={frameRef}>
                <div className="browser-bar">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span className="url">{screen.name}</span>
                </div>
                <div
                  className="canvas-content"
                  ref={contentRef}
                  onClick={mode === "prototype" ? undefined : onCanvasClick}
                  onMouseMove={(e) => mode === "select" && setHover(nodeFromEvent(e))}
                  onMouseLeave={() => setHover(null)}
                  data-testid="canvas"
                >
                  <Renderer node={tree} onNavigate={mode === "prototype" ? onNavigate : undefined} />
                </div>
                <div className={`overlay ${mode === "region" ? "capture" : ""}`} onMouseDown={onOverlayDown} onMouseMove={onOverlayMove} onMouseUp={onOverlayUp} onMouseLeave={onOverlayUp}>
                  {mode !== "prototype" &&
                    changedIds.map((id) => rects[id] && <div key={`c-${id}`} className="ov ov-changed" style={box(rects[id])} />)}
                  {hover && !selected.includes(hover) && rects[hover] && mode === "select" && (
                    <div className="ov ov-hover" style={box(rects[hover])}>
                      <span className="ov-tag">{tree && findNode(tree, hover) ? nodeLabel(findNode(tree, hover)!) : hover}</span>
                    </div>
                  )}
                  {selected.map((id) => rects[id] && <div key={`s-${id}`} className="ov ov-selected" style={box(rects[id])} />)}
                  {suggHover && rects[suggHover] && <div className="ov ov-suggest" style={box(rects[suggHover])} />}
                  {mode !== "prototype" &&
                    openAnns.map((a, i) => {
                      const r = rects[a.nodeIds[0]] ?? a.bbox;
                      if (!r) return null;
                      return (
                        <button
                          key={a.id}
                          className={`pin pin-${a.status}`}
                          style={{ left: r.x + r.w - 10, top: r.y - 10 }}
                          title={a.comment}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(a.nodeIds);
                            setPanel("edit");
                          }}
                        >
                          {annotations.indexOf(a) + 1}
                        </button>
                      );
                    })}
                  {drag && <div className="ov ov-drag" style={box({ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) })} />}
                </div>
              </div>
            </div>
            <div className="hint muted small">
              {mode === "select" && "Click để chọn phần tử · Shift+click chọn nhiều · Esc bỏ chọn"}
              {mode === "region" && "Kéo chuột để khoanh vùng – các phần tử nằm trọn trong khung sẽ được chọn"}
              {mode === "prototype" && "Bấm nút/liên kết có điều hướng để chuyển màn hình như prototype"}
            </div>
          </>
        )}
      </section>

      {/* Cột phải: bình luận + prompt sửa + phiên bản */}
      {screen && tree && (
        <aside className="studio-right">
          <div className="seg seg-full">
            <button className={panel === "edit" ? "on" : ""} onClick={() => setPanel("edit")}>
              Sửa {openAnns.length ? `(${openAnns.length})` : ""}
            </button>
            <button className={panel === "layers" ? "on" : ""} onClick={() => setPanel("layers")}>
              Thành phần
            </button>
            <button className={panel === "versions" ? "on" : ""} onClick={() => setPanel("versions")} data-testid="versions-tab">
              Phiên bản ({versions.length})
            </button>
            <button className={panel === "suggest" ? "on" : ""} onClick={() => setPanel("suggest")} data-testid="suggest-tab">
              Gợi ý {visibleSuggestions.length ? `(${visibleSuggestions.length})` : ""}
            </button>
          </div>

          {panel === "suggest" && (
            <div className="panel-body" data-testid="suggest-panel">
              <div className="muted small">
                {selected.length ? `Gợi ý cho vùng đang chọn (${selected.length} phần tử)` : "Gợi ý cho toàn màn hình – khoanh vùng để thu hẹp"}
              </div>
              {visibleSuggestions.map((s) => (
                <div key={s.id} className={`sugg sugg-${s.kind}`} onMouseEnter={() => setSuggHover(s.targetNodeId)} onMouseLeave={() => setSuggHover(null)} data-testid="suggestion">
                  <div className="sugg-head">
                    <Badge tone={s.kind === "add" ? "blue" : s.kind === "fix" ? "amber" : "violet"}>{s.kind === "add" ? "Thêm" : s.kind === "fix" ? "Sửa" : "Xem lại"}</Badge>
                    <span className="sugg-title">{s.title}</span>
                  </div>
                  <div className="muted small">{s.reason}</div>
                  <div className="sugg-conf" title={`Độ tin cậy ${Math.round(s.confidence * 100)}%`}>
                    <span style={{ width: `${Math.round(s.confidence * 100)}%` }} />
                  </div>
                  <div className="sugg-actions">
                    <Btn size="sm" kind="primary" disabled={!!previewing} onClick={() => applySuggestion(s)} data-testid="apply-suggestion">
                      Áp dụng
                    </Btn>
                    <Btn size="sm" kind="ghost" onClick={() => dismissSuggestion(s)}>
                      Bỏ qua
                    </Btn>
                    <span className="muted small right">{Math.round(s.confidence * 100)}%</span>
                  </div>
                </div>
              ))}
              {!visibleSuggestions.length && <div className="muted small pad">Chưa có gợi ý cho vùng này.</div>}
              {suggMeta && <div className="muted small sugg-foot">{suggMeta.kind === "transformer" ? "Transformer" : "N-gram"} · học từ {suggMeta.trees.toLocaleString("vi-VN")} màn hình{suggMeta.learned ? ` + ${suggMeta.learned} màn đã duyệt` : ""}</div>}
            </div>
          )}

          {panel === "edit" && (
            <div className="panel-body">
              <div className="box">
                <div className="box-title">Vùng đang chọn</div>
                {selectedNodes.length ? (
                  <div className="sel-list" data-testid="selection">
                    {selectedNodes.map((n) => (
                      <span key={n.id} className="chip chip-sel">
                        {nodeLabel(n)}
                        <button onClick={() => setSelected((s) => s.filter((x) => x !== n.id))} aria-label="Bỏ">
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="muted small">Chưa khoanh vùng – yêu cầu sửa sẽ áp dụng cho toàn màn hình.</div>
                )}
              </div>

              <div className="box">
                <div className="box-title">Bình luận vào vùng</div>
                <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={selected.length ? "VD: Đổi chữ thành “Vào hệ thống”" : "Chọn vùng trên canvas rồi ghi bình luận…"} data-testid="comment-input" />
                <Btn size="sm" disabled={!comment.trim()} onClick={addComment} data-testid="add-comment">
                  + Thêm bình luận
                </Btn>
              </div>

              <div className="box">
                <div className="box-title">
                  Bình luận ({annotations.length}) <span className="muted small">– tick để gửi vào prompt</span>
                </div>
                <div className="ann-list">
                  {annotations.map((a, i) => (
                    <div key={a.id} className={`ann ann-${a.status}`}>
                      <label className="ann-check">
                        <input
                          type="checkbox"
                          disabled={a.status === "resolved"}
                          checked={checked.has(a.id)}
                          onChange={(e) =>
                            setChecked((c) => {
                              const n = new Set(c);
                              e.target.checked ? n.add(a.id) : n.delete(a.id);
                              return n;
                            })
                          }
                          data-testid="ann-check"
                        />
                        <span className="pin-num">{i + 1}</span>
                      </label>
                      <div className="ann-main" onClick={() => setSelected(a.nodeIds.filter((id) => tree && findNode(tree, id)))}>
                        <div className="ann-text">{a.comment}</div>
                        <div className="muted small">
                          {a.nodeIds.length ? a.nodeIds.map((id) => (tree && findNode(tree, id) ? nodeLabel(findNode(tree, id)!) : `${id} (đã xóa)`)).join(", ") : "Toàn màn hình"} · {a.author} · {fmtTime(a.createdAt)}
                        </div>
                      </div>
                      <div className="ann-actions">
                        <StatusBadge status={a.status} />
                        {a.status !== "resolved" ? (
                          <button className="link small" onClick={async () => { await patch(`/api/annotations/${a.id}`, { status: "resolved" }); reload(); }}>
                            Xong
                          </button>
                        ) : (
                          <button className="link small" onClick={async () => { await patch(`/api/annotations/${a.id}`, { status: "open" }); reload(); }}>
                            Mở lại
                          </button>
                        )}
                        <button className="link-danger small" onClick={async () => { await del(`/api/annotations/${a.id}`); reload(); }}>
                          Xóa
                        </button>
                      </div>
                    </div>
                  ))}
                  {!annotations.length && <div className="muted small">Chưa có bình luận.</div>}
                </div>
              </div>

              <div className="box box-accent">
                <div className="box-title">Prompt sửa thiết kế</div>
                <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={selected.length ? "VD: Thêm nút “Đăng nhập bằng Google” bên dưới" : "VD: Chuyển bố cục sang 2 cột"} data-testid="edit-prompt" />
                <div className="muted small">
                  Gửi: {selected.length ? `${selected.length} vùng` : "toàn màn hình"} · {checked.size} bình luận{prompt.trim() ? " · 1 yêu cầu" : ""}
                </div>
                <Btn kind="primary" disabled={!!previewing || (!prompt.trim() && !checked.size)} onClick={applyEdit} data-testid="apply-edit">
                  {selected.length ? "✦ Sửa vùng đã khoanh" : "✦ Sửa toàn màn hình"}
                </Btn>
              </div>
            </div>
          )}

          {panel === "layers" && (
            <div className="panel-body">
              <div className="layers">
                <LayerTree node={tree} selected={selected} onPick={(id, multi) => setSelected((s) => (multi ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]))} />
              </div>
              {selectedNodes.length === 1 && (
                <div className="box">
                  <div className="box-title">Thuộc tính – {selectedNodes[0].id}</div>
                  <pre className="code small">{JSON.stringify(selectedNodes[0].props, null, 2)}</pre>
                </div>
              )}
            </div>
          )}

          {panel === "versions" && (
            <div className="panel-body">
              {versions.map((v) => (
                <div key={v.id} className={`ver ${v.id === screen.currentVersionId ? "ver-current" : ""} ${viewVersion === v.id ? "ver-view" : ""}`}>
                  <div className="ver-head">
                    <strong>v{v.number}</strong>
                    <Badge tone={v.kind === "generate" ? "blue" : v.kind === "revert" ? "amber" : "violet"}>{v.kind === "generate" ? "Sinh mới" : v.kind === "revert" ? "Khôi phục" : v.scope === "region" ? "Sửa theo vùng" : "Sửa toàn màn hình"}</Badge>
                    {v.id === screen.currentVersionId && <Badge tone="green">Hiện tại</Badge>}
                    <span className="muted small right">{fmtTime(v.createdAt)}</span>
                  </div>
                  <div className="ver-prompt">{v.prompt || "—"}</div>
                  <div className="muted small">
                    {v.changedIds.length} phần tử thay đổi{v.selectedIds.length ? ` · vùng: ${v.selectedIds.join(", ")}` : ""}
                    {v.rejected.length ? ` · ${v.rejected.length} thao tác bị chặn` : ""}
                  </div>
                  {v.id !== screen.currentVersionId && (
                    <div className="ver-actions">
                      <button className="link small" onClick={() => setViewVersion(v.id)}>
                        Xem
                      </button>
                      <button className="link small" onClick={() => revert(v)}>
                        Khôi phục
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </aside>
      )}

      {newScreen && (
        <Modal
          title="Màn hình mới"
          wide
          onClose={() => setNewScreen(null)}
          footer={
            <>
              <Btn onClick={() => setNewScreen(null)}>Hủy</Btn>
              <Btn kind="primary" disabled={!newScreen.prompt.trim()} onClick={createScreen} data-testid="generate-screen">
                ✦ Sinh thiết kế
              </Btn>
            </>
          }
        >
          <Field label="Tên màn hình (dùng cho điều hướng giữa các màn hình)">
            <input value={newScreen.name} onChange={(e) => setNewScreen({ ...newScreen, name: e.target.value })} placeholder="VD: Đăng nhập" data-testid="screen-name" />
          </Field>
          <Field label="Prompt mô tả màn hình" hint="Mô tả mục đích, các trường dữ liệu, nút bấm, ràng buộc, điều hướng…">
            <textarea rows={6} value={newScreen.prompt} onChange={(e) => setNewScreen({ ...newScreen, prompt: e.target.value })} data-testid="screen-prompt" />
          </Field>
          <div className="tpl-row">
            <span className="muted small">Mẫu nhanh:</span>
            {TEMPLATES.map((t) => (
              <button key={t.name} className="chip" onClick={() => setNewScreen(t)}>
                {t.name}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

const box = (r: Rect): React.CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });

function LayerTree({ node, selected, onPick, depth = 0 }: { node: UINode; selected: string[]; onPick: (id: string, multi: boolean) => void; depth?: number }) {
  return (
    <>
      <button className={`layer ${selected.includes(node.id) ? "on" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={(e) => onPick(node.id, e.shiftKey || e.metaKey || e.ctrlKey)}>
        <span className="layer-type">{node.type}</span> <span className="muted">{nodeLabel(node).replace(node.type, "").trim()}</span>
      </button>
      {(node.children ?? []).map((c) => (
        <LayerTree key={c.id} node={c} selected={selected} onPick={onPick} depth={depth + 1} />
      ))}
    </>
  );
}

