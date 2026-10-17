import { randomUUID } from "node:crypto";
import { getDb, tx } from "./db.ts";
import type { UINode } from "../shared/design.ts";
import type {
  Annotation,
  DocBundle,
  DocStatus,
  Module,
  ModuleDetail,
  Project,
  PromptRun,
  Requirement,
  Screen,
  ScreenVersion,
  ScreenWithTree,
  SequenceDiagram,
  SrsDoc,
  TestCase,
  UseCase,
} from "../shared/types.ts";

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const uid = () => randomUUID();
const J = (s: string | null | undefined, fallback: any = null) => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ---------- Projects ----------
const toProject = (r: Row): Project => ({ id: r.id, name: r.name, description: r.description, createdAt: r.created_at });

export function listProjects(): (Project & { moduleCount: number })[] {
  return getDb()
    .prepare(`SELECT p.*, (SELECT COUNT(*) FROM modules m WHERE m.project_id = p.id) AS module_count FROM projects p ORDER BY created_at DESC`)
    .all()
    .map((r: Row) => ({ ...toProject(r), moduleCount: Number(r.module_count) }));
}

export function createProject(name: string, description = ""): Project {
  const p: Project = { id: uid(), name, description, createdAt: now() };
  getDb().prepare("INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)").run(p.id, p.name, p.description, p.createdAt);
  return p;
}

export function getProject(id: string): Project | null {
  const r = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  return r ? toProject(r) : null;
}

export function deleteProject(id: string): void {
  getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
}

// ---------- Modules ----------
const toModule = (r: Row): Module => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  requirementInput: r.requirement_input,
  docsStatus: r.docs_status,
  testsStatus: r.tests_status,
  createdAt: r.created_at,
});

export function listModules(projectId: string): (Module & { screenCount: number })[] {
  return getDb()
    .prepare(`SELECT m.*, (SELECT COUNT(*) FROM screens s WHERE s.module_id = m.id) AS screen_count FROM modules m WHERE project_id = ? ORDER BY created_at`)
    .all(projectId)
    .map((r: Row) => ({ ...toModule(r), screenCount: Number(r.screen_count) }));
}

export function createModule(projectId: string, name: string, requirementInput = ""): Module {
  const m: Module = { id: uid(), projectId, name, requirementInput, docsStatus: "none", testsStatus: "none", createdAt: now() };
  getDb()
    .prepare("INSERT INTO modules (id, project_id, name, requirement_input, docs_status, tests_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(m.id, m.projectId, m.name, m.requirementInput, m.docsStatus, m.testsStatus, m.createdAt);
  return m;
}

export function getModule(id: string): Module | null {
  const r = getDb().prepare("SELECT * FROM modules WHERE id = ?").get(id) as Row | undefined;
  return r ? toModule(r) : null;
}

export function updateModule(id: string, patch: Partial<Pick<Module, "name" | "requirementInput" | "docsStatus" | "testsStatus">>): void {
  const cols: string[] = [];
  const vals: any[] = [];
  if (patch.name !== undefined) (cols.push("name = ?"), vals.push(patch.name));
  if (patch.requirementInput !== undefined) (cols.push("requirement_input = ?"), vals.push(patch.requirementInput));
  if (patch.docsStatus !== undefined) (cols.push("docs_status = ?"), vals.push(patch.docsStatus));
  if (patch.testsStatus !== undefined) (cols.push("tests_status = ?"), vals.push(patch.testsStatus));
  if (!cols.length) return;
  getDb().prepare(`UPDATE modules SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function deleteModule(id: string): void {
  getDb().prepare("DELETE FROM modules WHERE id = ?").run(id);
}

/** BR-02: thiết kế đã duyệt bị thay đổi → tài liệu và test hiện có chuyển Outdated. */
export function markOutdated(moduleId: string): void {
  const m = getModule(moduleId);
  if (!m) return;
  updateModule(moduleId, {
    docsStatus: m.docsStatus === "none" ? "none" : "outdated",
    testsStatus: m.testsStatus === "none" ? "none" : "outdated",
  });
}

// ---------- Screens & versions ----------
const toScreen = (r: Row): Screen => ({
  id: r.id,
  moduleId: r.module_id,
  name: r.name,
  status: r.status,
  currentVersionId: r.current_version_id,
  createdAt: r.created_at,
});

const toVersion = (r: Row): ScreenVersion => ({
  id: r.id,
  screenId: r.screen_id,
  number: Number(r.number),
  kind: r.kind,
  prompt: r.prompt,
  scope: r.scope,
  selectedIds: J(r.selected_ids, []),
  changedIds: J(r.changed_ids, []),
  rejected: J(r.rejected, []),
  tree: J(r.tree),
  createdAt: r.created_at,
});

export function getScreen(id: string): Screen | null {
  const r = getDb().prepare("SELECT * FROM screens WHERE id = ?").get(id) as Row | undefined;
  return r ? toScreen(r) : null;
}

export function listScreens(moduleId: string): ScreenWithTree[] {
  const rows = getDb()
    .prepare(
      `SELECT s.*, v.tree AS tree, v.number AS vnum FROM screens s LEFT JOIN screen_versions v ON v.id = s.current_version_id
       WHERE s.module_id = ? ORDER BY s.created_at`,
    )
    .all(moduleId) as Row[];
  return rows.map((r) => ({ ...toScreen(r), tree: J(r.tree), versionNumber: Number(r.vnum ?? 0) }));
}

export function createScreen(moduleId: string, name: string): Screen {
  const s: Screen = { id: uid(), moduleId, name, status: "draft", currentVersionId: null, createdAt: now() };
  getDb().prepare("INSERT INTO screens (id, module_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)").run(s.id, s.moduleId, s.name, s.status, s.createdAt);
  return s;
}

export function updateScreen(id: string, patch: Partial<Pick<Screen, "name" | "status" | "currentVersionId">>): void {
  const cols: string[] = [];
  const vals: any[] = [];
  if (patch.name !== undefined) (cols.push("name = ?"), vals.push(patch.name));
  if (patch.status !== undefined) (cols.push("status = ?"), vals.push(patch.status));
  if (patch.currentVersionId !== undefined) (cols.push("current_version_id = ?"), vals.push(patch.currentVersionId));
  if (!cols.length) return;
  getDb().prepare(`UPDATE screens SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function deleteScreen(id: string): void {
  getDb().prepare("DELETE FROM screens WHERE id = ?").run(id);
}

export function addVersion(
  screenId: string,
  v: { kind: ScreenVersion["kind"]; prompt: string; scope?: ScreenVersion["scope"]; selectedIds?: string[]; changedIds?: string[]; rejected?: { reason: string }[]; tree: UINode },
): ScreenVersion {
  return tx(() => {
    const max = getDb().prepare("SELECT COALESCE(MAX(number), 0) AS n FROM screen_versions WHERE screen_id = ?").get(screenId) as Row;
    const ver: ScreenVersion = {
      id: uid(),
      screenId,
      number: Number(max.n) + 1,
      kind: v.kind,
      prompt: v.prompt,
      scope: v.scope ?? "",
      selectedIds: v.selectedIds ?? [],
      changedIds: v.changedIds ?? [],
      rejected: v.rejected ?? [],
      tree: v.tree,
      createdAt: now(),
    };
    getDb()
      .prepare(
        "INSERT INTO screen_versions (id, screen_id, number, kind, prompt, scope, selected_ids, changed_ids, rejected, tree, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ver.id, screenId, ver.number, ver.kind, ver.prompt, ver.scope, JSON.stringify(ver.selectedIds), JSON.stringify(ver.changedIds), JSON.stringify(ver.rejected), JSON.stringify(ver.tree), ver.createdAt);
    getDb().prepare("UPDATE screens SET current_version_id = ? WHERE id = ?").run(ver.id, screenId);
    return ver;
  });
}

export function listVersions(screenId: string): ScreenVersion[] {
  return (getDb().prepare("SELECT * FROM screen_versions WHERE screen_id = ? ORDER BY number DESC").all(screenId) as Row[]).map(toVersion);
}

export function getVersion(id: string): ScreenVersion | null {
  const r = getDb().prepare("SELECT * FROM screen_versions WHERE id = ?").get(id) as Row | undefined;
  return r ? toVersion(r) : null;
}

// ---------- Annotations ----------
const toAnnotation = (r: Row): Annotation => ({
  id: r.id,
  screenId: r.screen_id,
  versionId: r.version_id,
  nodeIds: J(r.node_ids, []),
  bbox: J(r.bbox),
  comment: r.comment,
  author: r.author,
  status: r.status,
  createdAt: r.created_at,
});

export function listAnnotationsForModule(moduleId: string): Annotation[] {
  return (
    getDb()
      .prepare("SELECT a.* FROM annotations a JOIN screens s ON s.id = a.screen_id WHERE s.module_id = ? ORDER BY a.created_at")
      .all(moduleId) as Row[]
  ).map(toAnnotation);
}

export function getAnnotations(ids: string[]): Annotation[] {
  if (!ids.length) return [];
  const q = ids.map(() => "?").join(",");
  return (getDb().prepare(`SELECT * FROM annotations WHERE id IN (${q})`).all(...ids) as Row[]).map(toAnnotation);
}

export function createAnnotation(a: Omit<Annotation, "id" | "createdAt" | "status">): Annotation {
  const ann: Annotation = { ...a, id: uid(), status: "open", createdAt: now() };
  getDb()
    .prepare("INSERT INTO annotations (id, screen_id, version_id, node_ids, bbox, comment, author, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(ann.id, ann.screenId, ann.versionId, JSON.stringify(ann.nodeIds), JSON.stringify(ann.bbox), ann.comment, ann.author, ann.status, ann.createdAt);
  return ann;
}

export function setAnnotationStatus(ids: string[], status: Annotation["status"]): void {
  const st = getDb().prepare("UPDATE annotations SET status = ? WHERE id = ?");
  for (const id of ids) st.run(status, id);
}

export function getAnnotation(id: string): Annotation | null {
  return getAnnotations([id])[0] ?? null;
}

export function deleteAnnotation(id: string): void {
  getDb().prepare("DELETE FROM annotations WHERE id = ?").run(id);
}

// ---------- Docs ----------
function listData<T>(table: string, moduleId: string): T[] {
  return (getDb().prepare(`SELECT data FROM ${table} WHERE module_id = ? ORDER BY ord`).all(moduleId) as Row[]).map((r) => J(r.data));
}

export function getDocs(moduleId: string): DocBundle {
  const srsRow = getDb().prepare("SELECT data FROM srs WHERE module_id = ?").get(moduleId) as Row | undefined;
  return {
    useCases: listData<UseCase>("use_cases", moduleId),
    requirements: listData<Requirement>("requirements", moduleId),
    srs: srsRow ? (J(srsRow.data) as SrsDoc) : null,
    sequences: listData<SequenceDiagram>("sequences", moduleId),
  };
}

export function saveUseCasesAndRequirements(moduleId: string, ucs: UseCase[], reqs: Requirement[]): void {
  tx(() => {
    const d = getDb();
    d.prepare("DELETE FROM use_cases WHERE module_id = ?").run(moduleId);
    d.prepare("DELETE FROM requirements WHERE module_id = ?").run(moduleId);
    const iu = d.prepare("INSERT INTO use_cases (module_id, code, ord, data) VALUES (?, ?, ?, ?)");
    ucs.forEach((u, i) => iu.run(moduleId, u.code, i, JSON.stringify(u)));
    const ir = d.prepare("INSERT INTO requirements (module_id, code, ord, data) VALUES (?, ?, ?, ?)");
    reqs.forEach((r, i) => ir.run(moduleId, r.code, i, JSON.stringify(r)));
  });
}

export function saveUseCase(moduleId: string, uc: UseCase): void {
  const d = getDb();
  const ex = d.prepare("SELECT ord FROM use_cases WHERE module_id = ? AND code = ?").get(moduleId, uc.code) as Row | undefined;
  if (ex) d.prepare("UPDATE use_cases SET data = ? WHERE module_id = ? AND code = ?").run(JSON.stringify(uc), moduleId, uc.code);
  else {
    const m = d.prepare("SELECT COALESCE(MAX(ord), -1) AS o FROM use_cases WHERE module_id = ?").get(moduleId) as Row;
    d.prepare("INSERT INTO use_cases (module_id, code, ord, data) VALUES (?, ?, ?, ?)").run(moduleId, uc.code, Number(m.o) + 1, JSON.stringify(uc));
  }
}

export function saveRequirements(moduleId: string, reqs: Requirement[]): void {
  tx(() => {
    const d = getDb();
    d.prepare("DELETE FROM requirements WHERE module_id = ?").run(moduleId);
    const ir = d.prepare("INSERT INTO requirements (module_id, code, ord, data) VALUES (?, ?, ?, ?)");
    reqs.forEach((r, i) => ir.run(moduleId, r.code, i, JSON.stringify(r)));
  });
}

export function saveSrs(moduleId: string, srs: SrsDoc): void {
  getDb().prepare("INSERT INTO srs (module_id, data) VALUES (?, ?) ON CONFLICT(module_id) DO UPDATE SET data = excluded.data").run(moduleId, JSON.stringify(srs));
}

export function saveSequences(moduleId: string, seqs: SequenceDiagram[]): void {
  tx(() => {
    const d = getDb();
    d.prepare("DELETE FROM sequences WHERE module_id = ?").run(moduleId);
    const st = d.prepare("INSERT INTO sequences (module_id, use_case_code, ord, data) VALUES (?, ?, ?, ?)");
    seqs.forEach((s, i) => st.run(moduleId, s.useCaseCode, i, JSON.stringify(s)));
  });
}

export function saveSequence(moduleId: string, seq: SequenceDiagram): void {
  const d = getDb();
  const ex = d.prepare("SELECT ord FROM sequences WHERE module_id = ? AND use_case_code = ?").get(moduleId, seq.useCaseCode) as Row | undefined;
  if (ex) d.prepare("UPDATE sequences SET data = ? WHERE module_id = ? AND use_case_code = ?").run(JSON.stringify(seq), moduleId, seq.useCaseCode);
  else {
    const m = d.prepare("SELECT COALESCE(MAX(ord), -1) AS o FROM sequences WHERE module_id = ?").get(moduleId) as Row;
    d.prepare("INSERT INTO sequences (module_id, use_case_code, ord, data) VALUES (?, ?, ?, ?)").run(moduleId, seq.useCaseCode, Number(m.o) + 1, JSON.stringify(seq));
  }
}

export function getTests(moduleId: string): TestCase[] {
  return listData<TestCase>("test_cases", moduleId);
}

export function saveTests(moduleId: string, tests: TestCase[]): void {
  tx(() => {
    const d = getDb();
    d.prepare("DELETE FROM test_cases WHERE module_id = ?").run(moduleId);
    const st = d.prepare("INSERT INTO test_cases (module_id, code, ord, data) VALUES (?, ?, ?, ?)");
    tests.forEach((t, i) => st.run(moduleId, t.code, i, JSON.stringify(t)));
  });
}

export function getModuleDetail(id: string): ModuleDetail | null {
  const m = getModule(id);
  if (!m) return null;
  const project = getProject(m.projectId)!;
  return {
    ...m,
    project,
    screens: listScreens(id),
    annotations: listAnnotationsForModule(id),
    docs: getDocs(id),
    tests: getTests(id),
  };
}

// ---------- Prompt runs (log phục vụ đánh giá thực nghiệm) ----------
export function logRun(r: Omit<PromptRun, "id" | "createdAt">): PromptRun {
  const run: PromptRun = { ...r, id: uid(), createdAt: now() };
  getDb()
    .prepare(
      "INSERT INTO prompt_runs (id, module_id, type, provider, model, input, output, ok, error, input_tokens, output_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(run.id, run.moduleId, run.type, run.provider, run.model, run.input, run.output, run.ok ? 1 : 0, run.error, run.inputTokens, run.outputTokens, run.latencyMs, run.createdAt);
  return run;
}

export function listRuns(moduleId: string): PromptRun[] {
  return (getDb().prepare("SELECT * FROM prompt_runs WHERE module_id = ? ORDER BY created_at DESC LIMIT 200").all(moduleId) as Row[]).map((r) => ({
    id: r.id,
    moduleId: r.module_id,
    type: r.type,
    provider: r.provider,
    model: r.model,
    input: r.input,
    output: r.output,
    ok: Boolean(r.ok),
    error: r.error,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    latencyMs: Number(r.latency_ms),
    createdAt: r.created_at,
  }));
}

export function setDocStatus(moduleId: string, status: DocStatus): void {
  updateModule(moduleId, { docsStatus: status });
}

/** Số lần gọi Claude thật từ đầu ngày (UTC) – dùng cho giới hạn MAX_AI_CALLS_PER_DAY. */
export function countClaudeRunsToday(): number {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM prompt_runs WHERE provider = 'claude' AND created_at >= ?").get(start.toISOString()) as Row;
  return Number(r.n);
}

// ---------- Gợi ý thành phần (log Áp dụng / Bỏ qua để đo tỷ lệ chấp nhận) ----------
export interface SuggestionEvent {
  screenId: string;
  versionId: string | null;
  kind: string;
  targetNodeId: string | null;
  title: string;
  confidence: number;
  action: "shown" | "applied" | "dismissed";
}

export function logSuggestionEvent(e: SuggestionEvent): void {
  getDb()
    .prepare("INSERT INTO suggestion_events (id, screen_id, version_id, suggestion_kind, target_node_id, title, confidence, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(uid(), e.screenId, e.versionId, e.kind, e.targetNodeId, e.title, e.confidence, e.action, now());
}

export function suggestionStats(moduleId: string): { shown: number; applied: number; dismissed: number; acceptanceRate: number; byKind: Record<string, { shown: number; applied: number }> } {
  const rows = getDb()
    .prepare(
      `SELECT e.suggestion_kind AS kind, e.action AS action, COUNT(*) AS n FROM suggestion_events e JOIN screens s ON s.id = e.screen_id
       WHERE s.module_id = ? GROUP BY e.suggestion_kind, e.action`,
    )
    .all(moduleId) as Row[];
  const t = { shown: 0, applied: 0, dismissed: 0 };
  const byKind: Record<string, { shown: number; applied: number }> = {};
  for (const r of rows) {
    const n = Number(r.n);
    t[r.action as keyof typeof t] += n;
    const k = (byKind[r.kind] ??= { shown: 0, applied: 0 });
    if (r.action === "shown") k.shown += n;
    if (r.action === "applied") k.applied += n;
  }
  return { ...t, acceptanceRate: t.shown ? t.applied / t.shown : 0, byKind };
}
