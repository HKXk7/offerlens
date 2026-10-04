-- OfferLens 评测回归平台 · SQLite schema (v1)
--
-- 设计要点（面试会被问，所以写在这里）：
--  1. 单进程 Node + SQLite(WAL)。批量运行引擎是一个内存队列 + 一个 worker，
--     不跨进程并发写——SQLite 的写锁在并发 worker 下会坑死人。
--  2. 全文不落库。trace 的输入输出落在 JSONL 文件里，库里只存 digest / 索引字段。
--     这样"一键删除我的数据"是一条 DELETE，而不是几 GB 的 VACUUM。
--  3. result 的主键是 (run_id, case_id, run_index) —— 断点续跑的幂等基础。
--     run_index 是 pass^k 的前提，缺了它就没法区分同一 case 的多次运行。
--  4. 别人的简历永远只进 user_feedback 的会话引用，永远不进 eval_case。

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ================================================================
-- 一、评测集侧
-- ================================================================

CREATE TABLE IF NOT EXISTS dataset (
  id         TEXT NOT NULL,
  version    TEXT NOT NULL,
  seed       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS resume (
  id               TEXT PRIMARY KEY,
  anon_id          TEXT NOT NULL,
  headline         TEXT NOT NULL,
  -- rich | thin | career_change | incomplete
  experience_level TEXT NOT NULL
    CHECK (experience_level IN ('rich', 'thin', 'career_change', 'incomplete')),
  major_related    INTEGER NOT NULL DEFAULT 1,
  -- [{ "seg_id": "S01", "text": "..." }]  段 ID 是锚点的唯一标识
  segments_json    TEXT NOT NULL,
  skills_json      TEXT NOT NULL DEFAULT '[]',
  profile_json     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS jd (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  company_type   TEXT NOT NULL DEFAULT '',
  -- app | platform | data | business
  category       TEXT NOT NULL CHECK (category IN ('app', 'platform', 'data', 'business')),
  -- intern | junior | senior
  level          TEXT NOT NULL CHECK (level IN ('intern', 'junior', 'senior')),
  raw            TEXT NOT NULL,
  hard_req_json  TEXT NOT NULL,
  soft_req_json  TEXT NOT NULL DEFAULT '[]',
  source         TEXT NOT NULL DEFAULT 'synthetic'
);

CREATE TABLE IF NOT EXISTS eval_case (
  id               TEXT PRIMARY KEY,
  dataset_id       TEXT NOT NULL,
  dataset_version  TEXT NOT NULL,
  resume_id        TEXT NOT NULL REFERENCES resume (id),
  jd_id            TEXT NOT NULL REFERENCES jd (id),
  category         TEXT NOT NULL,
  experience_level TEXT NOT NULL,
  level            TEXT NOT NULL,
  is_hard_negative INTEGER NOT NULL DEFAULT 0,
  is_golden        INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (dataset_id, dataset_version) REFERENCES dataset (id, version)
);

CREATE INDEX IF NOT EXISTS idx_case_dataset ON eval_case (dataset_id, dataset_version);
CREATE INDEX IF NOT EXISTS idx_case_slice   ON eval_case (category, experience_level);

-- ================================================================
-- 二、运行侧
-- ================================================================

CREATE TABLE IF NOT EXISTS eval_run (
  id              TEXT PRIMARY KEY,
  dataset_id      TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  params_json     TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'paused', 'done', 'failed', 'cancelled')),
  -- 预算熔断：花到 budget_limit 就停，这个字段必须落库而不是只放内存
  budget_limit_usd REAL NOT NULL DEFAULT 0,
  spent_usd        REAL NOT NULL DEFAULT 0,
  seed             INTEGER NOT NULL DEFAULT 42,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (dataset_id, dataset_version) REFERENCES dataset (id, version)
);

CREATE INDEX IF NOT EXISTS idx_run_status ON eval_run (status);

CREATE TABLE IF NOT EXISTS result (
  run_id        TEXT NOT NULL REFERENCES eval_run (id) ON DELETE CASCADE,
  case_id       TEXT NOT NULL REFERENCES eval_case (id),
  run_index     INTEGER NOT NULL DEFAULT 0,
  output_json   TEXT,
  scores_json   TEXT NOT NULL DEFAULT '{}',
  latency_ms    INTEGER,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  error_type    TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  cached        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  -- 幂等主键：重跑时 INSERT OR IGNORE 即可跳过已完成的组合
  PRIMARY KEY (run_id, case_id, run_index)
);

CREATE INDEX IF NOT EXISTS idx_result_case ON result (case_id);

-- 结果哈希缓存：cache_key = hash(model + prompt_version + params + case_id + dataset_version)
CREATE TABLE IF NOT EXISTS result_cache (
  cache_key   TEXT PRIMARY KEY,
  output_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- ================================================================
-- 三、轨迹侧
-- ================================================================

CREATE TABLE IF NOT EXISTS trace (
  trace_id     TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES eval_run (id) ON DELETE CASCADE,
  case_id      TEXT NOT NULL,
  run_index    INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'aborted')),
  steps_count  INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  error_type   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (run_id, case_id, run_index)
);

CREATE TABLE IF NOT EXISTS step (
  span_id       TEXT PRIMARY KEY,
  trace_id      TEXT NOT NULL REFERENCES trace (trace_id) ON DELETE CASCADE,
  parent_id     TEXT,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  retry_of      TEXT,
  error         TEXT,
  -- 放 input_digest / output_digest / anchor_seg_ids / model 等，不放全文
  attrs_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_step_trace ON step (trace_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_step_name  ON step (trace_id, name);

-- ================================================================
-- 四、评分、比较、校准
-- ================================================================

CREATE TABLE IF NOT EXISTS score (
  case_id     TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  run_index   INTEGER NOT NULL DEFAULT 0,
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  -- rule | judge | human  —— 三种来源必须能区分，否则没法算 judge 与人的一致率
  method      TEXT NOT NULL CHECK (method IN ('rule', 'judge', 'human')),
  judge_model TEXT,
  reason      TEXT,
  PRIMARY KEY (case_id, run_id, run_index, metric, method)
);

CREATE INDEX IF NOT EXISTS idx_score_metric ON score (run_id, metric, method);

CREATE TABLE IF NOT EXISTS compare_result (
  base_run_id  TEXT NOT NULL,
  cand_run_id  TEXT NOT NULL,
  metric       TEXT NOT NULL,
  base_value   REAL NOT NULL,
  cand_value   REAL NOT NULL,
  delta        REAL NOT NULL,
  mcnemar_b    INTEGER,
  mcnemar_c    INTEGER,
  mcnemar_p    REAL,
  bootstrap_lo REAL,
  bootstrap_hi REAL,
  significant  INTEGER,
  -- 切片下钻：overall / category / experience_level / level
  slice_key    TEXT NOT NULL DEFAULT 'overall',
  slice_value  TEXT NOT NULL DEFAULT 'all',
  PRIMARY KEY (base_run_id, cand_run_id, metric, slice_key, slice_value)
);

-- 检测器校准表：40 条双人盲抽检的落库形态。
-- rule_unsourced 是规则判定，human_unsourced 是人工判定，两者一比就得到 precision/recall/F1。
CREATE TABLE IF NOT EXISTS audit (
  audit_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id     TEXT NOT NULL,
  case_id           TEXT NOT NULL,
  entity_raw        TEXT NOT NULL,
  entity_normalized TEXT NOT NULL,
  entity_kind       TEXT NOT NULL CHECK (entity_kind IN ('number', 'tech', 'org', 'project')),
  rule_unsourced    INTEGER NOT NULL,
  human_unsourced   INTEGER,
  exempted          INTEGER NOT NULL DEFAULT 0,
  reviewer          TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_case ON audit (case_id);

-- ================================================================
-- 五、真实用户侧（与评测集严格隔离）
-- ================================================================

-- 这张表永远不存简历正文，也永远不被 eval_case / score 读取。
-- 它只回答"有没有人在用、反馈是不是正向的"，不参与任何量化结论。
CREATE TABLE IF NOT EXISTS user_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  suggestion_id TEXT NOT NULL,
  adopted       INTEGER,
  helpful       INTEGER,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_suggestion ON user_feedback (suggestion_id);
