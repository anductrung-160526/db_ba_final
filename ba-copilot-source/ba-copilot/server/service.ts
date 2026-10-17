// Tầng nghiệp vụ: áp dụng quy tắc BR-01..BR-04 và điều phối pipeline AI.

import * as repo from "./repo.ts";
import * as ai from "./ai/pipelines.ts";
import { applyPatch } from "../shared/patch.ts";
import { collectIds, diffTrees, topMostIds, validateTree } from "../shared/design.ts";
import { extractModel, DesignModel } from "../shared/extract.ts";
import { buildTrace } from "../shared/trace.ts";
import type { Requirement, SequenceDiagram, UseCase } from "../shared/types.ts";
import { suggest } from "../shared/nextComponent.ts";
import { getPredictor, learnFromScreen } from "./nextModel.ts";

export class BizError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function mustModule(id: string) {
  const m = repo.getModule(id);
  if (!m) throw new BizError("Không tìm thấy module", 404);
  return m;
}

function mustScreen(id: string) {
  const s = repo.getScreen(id);
  if (!s) throw new BizError("Không tìm thấy màn hình", 404);
  return s;
}

// ------------------------------------------------------------- Design Studio
export async function createScreenFromPrompt(moduleId: string, prompt: string, name: string) {
  const m = mustModule(moduleId);
  if (!prompt.trim()) throw new BizError("Prompt không được để trống");
  const others = repo.listScreens(moduleId).map((s) => s.name);
  const result = await ai.generateScreen({ moduleId, prompt, name: name.trim(), requirementInput: m.requirementInput, otherScreens: others });
  const screen = repo.createScreen(moduleId, result.name);
  const version = repo.addVersion(screen.id, { kind: "generate", prompt, tree: result.tree });
  return { screen: repo.getScreen(screen.id), version };
}

export async function editScreenWithPrompt(screenId: string, input: { prompt: string; nodeIds: string[]; annotationIds: string[] }) {
  const screen = mustScreen(screenId);
  if (!screen.currentVersionId) throw new BizError("Màn hình chưa có phiên bản");
  const current = repo.getVersion(screen.currentVersionId)!;
  const annotations = repo.getAnnotations(input.annotationIds).filter((a) => a.screenId === screenId);
  if (!input.prompt.trim() && !annotations.length) throw new BizError("Cần nhập yêu cầu sửa hoặc chọn ít nhất một bình luận");

  // Vùng sửa = vùng đang chọn ∪ vùng của các bình luận được gửi (chỉ giữ node còn tồn tại)
  const idSet = new Set(collectIds(current.tree));
  const exists = (id: string) => idSet.has(id);
  const selected = topMostIds(current.tree, [...new Set([...input.nodeIds, ...annotations.flatMap((a) => a.nodeIds)])].filter(exists));

  const { ops, summary } = await ai.editScreen({
    moduleId: screen.moduleId,
    tree: current.tree,
    selectedIds: selected,
    instruction: input.prompt,
    comments: annotations.map((a) => ({ comment: a.comment, nodeIds: a.nodeIds })),
  });
  const result = applyPatch(current.tree, ops, { selectedIds: selected });
  const valid = validateTree(result.tree);
  if (!valid.ok) throw new BizError(`Kết quả sửa không hợp lệ: ${valid.errors.slice(0, 3).join("; ")}`);
  const diff = diffTrees(current.tree, result.tree);
  const changed = [...new Set([...diff.added, ...diff.changed])];
  if (!changed.length && !diff.removed.length) {
    return { version: null, summary: summary || "Không có thay đổi nào được áp dụng", rejected: result.rejected.map((r) => ({ reason: r.reason })), diff };
  }
  const version = repo.addVersion(screenId, {
    kind: "edit",
    prompt: [input.prompt, ...annotations.map((a) => `[Bình luận] ${a.comment}`)].filter(Boolean).join("\n"),
    scope: selected.length ? "region" : "global",
    selectedIds: selected,
    changedIds: changed,
    rejected: result.rejected.map((r) => ({ reason: r.reason })),
    tree: result.tree,
  });
  if (annotations.length) repo.setAnnotationStatus(annotations.map((a) => a.id), "sent");
  if (screen.status === "approved") {
    repo.updateScreen(screenId, { status: "draft" });
    repo.markOutdated(screen.moduleId); // BR-02
  }
  return { version, summary, rejected: version.rejected, diff };
}

export function revertScreen(screenId: string, versionId: string) {
  const screen = mustScreen(screenId);
  const target = repo.getVersion(versionId);
  if (!target || target.screenId !== screenId) throw new BizError("Phiên bản không hợp lệ");
  const current = screen.currentVersionId ? repo.getVersion(screen.currentVersionId) : null;
  const diff = current ? diffTrees(current.tree, target.tree) : { added: [], changed: [], removed: [] };
  const version = repo.addVersion(screenId, { kind: "revert", prompt: `Khôi phục phiên bản v${target.number}`, changedIds: [...diff.added, ...diff.changed], tree: target.tree });
  if (screen.status === "approved") {
    repo.updateScreen(screenId, { status: "draft" });
    repo.markOutdated(screen.moduleId);
  }
  return version;
}

export function setScreenApproval(screenId: string, approved: boolean) {
  const screen = mustScreen(screenId);
  repo.updateScreen(screenId, { status: approved ? "approved" : "draft" });
  if (!approved) repo.markOutdated(screen.moduleId);
  // Màn được duyệt là mẫu tốt → mô hình gợi ý học thêm
  if (approved && screen.currentVersionId) {
    const v = repo.getVersion(screen.currentVersionId);
    if (v) learnFromScreen(screenId, v.id, v.tree);
  }
  return repo.getScreen(screenId);
}

// ------------------------------------------------------------- Gợi ý thành phần tiếp theo
export function screenSuggestions(screenId: string, nodeIds: string[]) {
  const screen = mustScreen(screenId);
  if (!screen.currentVersionId) throw new BizError("Màn hình chưa có phiên bản");
  const v = repo.getVersion(screen.currentVersionId)!;
  const openAnnotationNodeIds = repo
    .listAnnotationsForModule(screen.moduleId)
    .filter((a) => a.screenId === screenId && a.status === "open")
    .flatMap((a) => a.nodeIds);
  const { model, info } = getPredictor();
  const suggestions = suggest(model, v.tree, { selectedIds: nodeIds, openAnnotationNodeIds, k: 5 });
  return { suggestions, versionId: v.id, model: info };
}

// ------------------------------------------------------------- Docs
function approvedModel(moduleId: string): DesignModel {
  const screens = repo.listScreens(moduleId).filter((s) => s.status === "approved" && s.tree);
  if (!screens.length) throw new BizError("BR-01: Cần ít nhất một màn hình ở trạng thái Đã duyệt trước khi sinh tài liệu");
  return extractModel(screens.map((s) => ({ id: s.id, name: s.name, tree: s.tree! })));
}

export function getDesignModel(moduleId: string): DesignModel {
  mustModule(moduleId);
  const screens = repo.listScreens(moduleId).filter((s) => s.tree);
  return extractModel(screens.map((s) => ({ id: s.id, name: s.name, tree: s.tree! })));
}

export async function generateDocs(moduleId: string) {
  const m = mustModule(moduleId);
  const model = approvedModel(moduleId);
  const { useCases, requirements } = await ai.generateUseCases({ moduleId, moduleName: m.name, requirementInput: m.requirementInput, model });
  repo.saveUseCasesAndRequirements(moduleId, useCases, requirements);
  const [srs, sequences] = await Promise.all([
    ai.generateSrs({ moduleId, moduleName: m.name, requirementInput: m.requirementInput, model, useCases, requirements }),
    ai.generateSequences({ moduleId, useCases, model }),
  ]);
  repo.saveSrs(moduleId, srs);
  repo.saveSequences(moduleId, sequences);
  repo.updateModule(moduleId, { docsStatus: "draft", testsStatus: m.testsStatus === "none" ? "none" : "outdated" });
  return repo.getDocs(moduleId);
}

export async function refineDoc(moduleId: string, target: string, instruction: string) {
  const m = mustModule(moduleId);
  if (!instruction.trim()) throw new BizError("Nhập yêu cầu chỉnh");
  const docs = repo.getDocs(moduleId);
  const model = getDesignModel(moduleId);
  if (target.startsWith("SEQ:")) {
    const code = target.slice(4);
    const seq = docs.sequences.find((s) => s.useCaseCode === code);
    if (!seq) throw new BizError("Không tìm thấy sơ đồ");
    const next: SequenceDiagram = await ai.refineSequence({ moduleId, seq, instruction, uc: docs.useCases.find((u) => u.code === code) });
    repo.saveSequence(moduleId, next);
  } else if (target.startsWith("SRS:")) {
    const key = target.slice(4);
    if (!docs.srs) throw new BizError("Chưa có SRS");
    const section = docs.srs.sections.find((s) => s.key === key);
    if (!section) throw new BizError("Không tìm thấy mục SRS");
    const next = await ai.refineSrsSection({ moduleId, section, instruction, context: `Module ${m.name}. UC: ${docs.useCases.map((u) => `${u.code} ${u.name}`).join("; ")}` });
    repo.saveSrs(moduleId, { sections: docs.srs.sections.map((s) => (s.key === key ? next : s)) });
  } else {
    const uc = docs.useCases.find((u) => u.code === target);
    if (!uc) throw new BizError("Không tìm thấy Use Case");
    const next: UseCase = await ai.refineUseCase({ moduleId, uc, instruction, model });
    repo.saveUseCase(moduleId, next);
  }
  if (m.docsStatus === "approved") repo.updateModule(moduleId, { docsStatus: "draft" });
  if (m.testsStatus !== "none") repo.updateModule(moduleId, { testsStatus: "outdated" });
  return repo.getDocs(moduleId);
}

export function updateRequirements(moduleId: string, reqs: Requirement[]) {
  mustModule(moduleId);
  repo.saveRequirements(moduleId, reqs);
  return repo.getDocs(moduleId);
}

export function approveDocs(moduleId: string, approved: boolean) {
  const m = mustModule(moduleId);
  if (m.docsStatus === "none") throw new BizError("Chưa có tài liệu để duyệt");
  repo.updateModule(moduleId, { docsStatus: approved ? "approved" : "draft" });
  return repo.getModule(moduleId);
}

// ------------------------------------------------------------- Tests
export async function generateTests(moduleId: string) {
  const m = mustModule(moduleId);
  if (m.docsStatus !== "approved") throw new BizError("Cần duyệt tài liệu (Approved) trước khi sinh test case");
  const docs = repo.getDocs(moduleId);
  const model = getDesignModel(moduleId);
  const tests = await ai.generateTests({ moduleId, useCases: docs.useCases, requirements: docs.requirements, model });
  repo.saveTests(moduleId, tests);
  repo.updateModule(moduleId, { testsStatus: "draft" });
  return tests;
}

export function trace(moduleId: string) {
  mustModule(moduleId);
  const docs = repo.getDocs(moduleId);
  const tests = repo.getTests(moduleId);
  const screens = repo.listScreens(moduleId).map((s) => ({ id: s.id, name: s.name }));
  return { ...buildTrace(docs.useCases, docs.requirements, tests), screens, useCases: docs.useCases.map((u) => ({ code: u.code, name: u.name, screenIds: u.screenIds })) };
}
