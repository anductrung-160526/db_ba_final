import type { UINode } from "./design.ts";

export type ScreenStatus = "draft" | "approved";
export type DocStatus = "none" | "draft" | "approved" | "outdated";

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface Module {
  id: string;
  projectId: string;
  name: string;
  requirementInput: string;
  docsStatus: DocStatus;
  testsStatus: DocStatus;
  createdAt: string;
}

export interface Screen {
  id: string;
  moduleId: string;
  name: string;
  status: ScreenStatus;
  currentVersionId: string | null;
  createdAt: string;
}

export interface ScreenVersion {
  id: string;
  screenId: string;
  number: number;
  kind: "generate" | "edit" | "revert";
  prompt: string;
  scope: "global" | "region" | "";
  selectedIds: string[];
  changedIds: string[];
  rejected: { reason: string }[];
  tree: UINode;
  createdAt: string;
}

export interface Annotation {
  id: string;
  screenId: string;
  versionId: string;
  nodeIds: string[];
  bbox: { x: number; y: number; w: number; h: number } | null;
  comment: string;
  author: string;
  status: "open" | "sent" | "resolved";
  createdAt: string;
}

export interface FlowStep {
  no: number;
  actor: string; // tên actor hoặc "Hệ thống"
  text: string;
  screenId?: string;
  nodeId?: string;
}

export interface AltFlow {
  code: string; // vd A1, E1
  name: string;
  branchFrom: number; // bước của main flow
  steps: string[];
}

export interface UseCase {
  code: string; // UC-01
  name: string;
  actors: string[];
  description: string;
  trigger: string;
  preconditions: string[];
  postconditions: string[];
  mainFlow: FlowStep[];
  altFlows: AltFlow[];
  exceptions: AltFlow[];
  businessRules: string[];
  screenIds: string[];
  assumptions: string[];
}

export interface Requirement {
  code: string; // FR-01, NFR-01
  type: "FR" | "NFR";
  statement: string;
  priority: "High" | "Medium" | "Low";
  useCaseCodes: string[];
  source: string; // màn hình/node hoặc prompt nguồn
  isAssumption: boolean;
}

export interface SrsSection {
  key: string;
  title: string;
  content: string; // markdown đơn giản
}

export interface SrsDoc {
  sections: SrsSection[];
}

export interface SequenceDiagram {
  useCaseCode: string;
  title: string;
  mermaid: string;
}

export interface TestCase {
  code: string; // TC-01
  title: string;
  type: "Positive" | "Negative" | "Boundary";
  priority: "High" | "Medium" | "Low";
  useCaseCode: string;
  flowRef: string; // "main" | "A1" | "E1" ...
  requirementCodes: string[];
  preconditions: string;
  testData: string;
  steps: string[];
  expected: string;
}

export interface DocBundle {
  useCases: UseCase[];
  requirements: Requirement[];
  srs: SrsDoc | null;
  sequences: SequenceDiagram[];
}

export interface PromptRun {
  id: string;
  moduleId: string | null;
  type: string;
  provider: string;
  model: string;
  input: string;
  output: string;
  ok: boolean;
  error: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  createdAt: string;
}

export interface ScreenWithTree extends Screen {
  tree: UINode | null;
  versionNumber: number;
}

export interface ModuleDetail extends Module {
  project: Project;
  screens: ScreenWithTree[];
  annotations: Annotation[];
  docs: DocBundle;
  tests: TestCase[];
}

export interface FileRecord {
  id: string;
  projectId: string;
  moduleId: string | null;
  name: string;
  mime: string;
  size: number;
  source: "upload" | "export";
  createdAt: string;
}

