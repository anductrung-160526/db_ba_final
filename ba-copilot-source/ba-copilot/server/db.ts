// Lưu trữ: SQLite tích hợp sẵn trong Node (node:sqlite) – không cần cài DB riêng.
// Cấu trúc bảng tương ứng data model trong kế hoạch; có thể chuyển sang PostgreSQL sau.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let db: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, requirement_input TEXT NOT NULL DEFAULT '',
  docs_status TEXT NOT NULL DEFAULT 'none', tests_status TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY, module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', current_version_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS screen_versions (
  id TEXT PRIMARY KEY, screen_id TEXT NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '',
  selected_ids TEXT NOT NULL DEFAULT '[]', changed_ids TEXT NOT NULL DEFAULT '[]', rejected TEXT NOT NULL DEFAULT '[]',
  tree TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY, screen_id TEXT NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL, node_ids TEXT NOT NULL, bbox TEXT, comment TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'BA', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS use_cases (
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE, code TEXT NOT NULL, ord INTEGER NOT NULL,
  data TEXT NOT NULL, PRIMARY KEY (module_id, code)
);
CREATE TABLE IF NOT EXISTS requirements (
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE, code TEXT NOT NULL, ord INTEGER NOT NULL,
  data TEXT NOT NULL, PRIMARY KEY (module_id, code)
);
CREATE TABLE IF NOT EXISTS srs (
  module_id TEXT PRIMARY KEY REFERENCES modules(id) ON DELETE CASCADE, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sequences (
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE, use_case_code TEXT NOT NULL, ord INTEGER NOT NULL,
  data TEXT NOT NULL, PRIMARY KEY (module_id, use_case_code)
);
CREATE TABLE IF NOT EXISTS test_cases (
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE, code TEXT NOT NULL, ord INTEGER NOT NULL,
  data TEXT NOT NULL, PRIMARY KEY (module_id, code)
);
CREATE TABLE IF NOT EXISTS prompt_runs (
  id TEXT PRIMARY KEY, module_id TEXT, type TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  input TEXT NOT NULL, output TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestion_events (
  id TEXT PRIMARY KEY, screen_id TEXT NOT NULL, version_id TEXT, suggestion_kind TEXT NOT NULL,
  target_node_id TEXT, title TEXT NOT NULL, confidence REAL NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('shown','applied','dismissed')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_learned_trees (
  version_id TEXT PRIMARY KEY, screen_id TEXT NOT NULL, tree TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sugg_screen ON suggestion_events(screen_id);
CREATE INDEX IF NOT EXISTS idx_modules_project ON modules(project_id);
CREATE INDEX IF NOT EXISTS idx_screens_module ON screens(module_id);
CREATE INDEX IF NOT EXISTS idx_versions_screen ON screen_versions(screen_id);
CREATE INDEX IF NOT EXISTS idx_ann_screen ON annotations(screen_id);
CREATE INDEX IF NOT EXISTS idx_runs_module ON prompt_runs(module_id);
`;

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database chưa được mở");
  return db;
}

export function tx<T>(fn: () => T): T {
  const d = getDb();
  d.exec("BEGIN");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
