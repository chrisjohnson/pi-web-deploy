/**
 * Trace db schema: a TS/bun:sqlite port of upstream SSSF's seven-table schema
 * (`adws/adw_modules/tracer.py`'s `SCHEMA` constant — the ground-truth live
 * schema, not the narrative summary in `references/observability.md`).
 *
 * One deliberate deviation from upstream, required by our design (see
 * pi-web-adw-design.md §3.1): `sessions` gains `project_cwd TEXT`. Upstream
 * SSSF is one db per target repo, so it never needs to record which project a
 * run targeted — pi-web-factory is one shared db across N projects, so every
 * session row must say which `cwd` it ran against.
 *
 * WAL mode, per observability.md's "WAL pragmas" section — open on every
 * connection, writer and reader alike.
 *
 * ── Terminology migration (pi-web-adw-design.md §7) ────────────────────────
 * §7 formalizes new vocabulary: "Workflow Run" (was "session"/"chain run"),
 * "Step" (was "phase"), "Role" (was "owner"/"agent identity"). §7.3 leaves
 * the exact identifier characters to the implementer, with a recommendation:
 * keep the physical SQL table/column names stable (`sessions`, `phases`,
 * `owner`) and do the rename at the TypeScript level only. This module
 * follows that recommendation — lower risk (no destructive `ALTER TABLE`,
 * no need to touch every raw SQL string across the codebase and its tests)
 * — so:
 *   - SQL table names stay `sessions`/`phases`; the SQL column stays `owner`.
 *   - TS-facing types/fields are named `WorkflowRun`/`Step`/`role` (see
 *     tracer.ts) — the rename is entirely in how TypeScript code refers to
 *     these tables and columns, never in the schema strings below.
 * A few columns are nullable / additive, no migration of existing rows
 * required:
 *   - `sessions.title` — a Workflow Run's title (§7.3), derived from the
 *     prompt or a ticket title.
 *   - `phases.input_tokens` / `output_tokens` / `cached_tokens` — per-Step
 *     token usage (§7.3: "today's schema only accumulates tokens at the
 *     [Workflow Run] level... needs new columns on the steps table").
 *   - `phases.output_summary` — a Step's short outcome summary (§7.3: "an
 *     agent step's envelope `summary`, a code step's gate result headline").
 *
 * ── `tickets` table + `sessions.ticket_id` ─────────────────────────────────
 * The `tickets` table is the grouping anchor for "conceptually the
 * same job, retried N times" (a ticket has many runs/`sessions` rows, always
 * exactly one ticket per run, no run without a ticket — see
 * `modules/ticket.ts`). `ticket_id` is a plain string, deliberately NOT
 * shaped like this codebase's own `adw_<hex>` ids, so it can hold either an
 * externally-minted id (e.g. a `.fleet` board id) or an
 * internally-minted one (`ticket_<hex>`, mirroring `adw_<hex>` but visually
 * distinct so the two id spaces never collide). `file_path` is a pure
 * reference field — never opened/parsed/watched by any code in this
 * codebase, see `modules/ticket.ts`'s header comment. `sessions.ticket_id`
 * is additive/nullable at the SQL level (existing rows keep NULL, no
 * migration needed) even though every NEW run always sets it — see
 * `modules/ticket.ts`'s `mintOrAttachTicket`.
 *
 * ── `phases.artifact_json` ─ a completed Step's real output ─────────────────
 * Written by `modules/tracer.ts`'s `Tracer.stepArtifact` the moment an
 * `agent` Step (`workflow.ts`'s `runAgentStep`) reaches a terminal SUCCESS
 * outcome ─ not just at run end ─ specifically so a LATER Step's failure can
 * never erase visibility into what an EARLIER Step actually accomplished (a
 * real incident: a `build` Step pushed real commits, then the following
 * `review` Step hit a `waitForCompletion` timeout and failed the whole run,
 * with nothing in the run's own record pointing back at the build's real
 * work). Holds a small JSON object ─ `{branch, commitSha, prUrl}` ─ never
 * raw trace events. `prUrl` is null until a future auto-PR Step
 * populates it; the shape is deliberately forward-compatible with that
 * rather than needing a second migration once one does.
 *
 * **This one is NOT purely additive at the SQL level** — unlike every prior
 * column added to this file (`sessions.title`, `phases.output_summary`,
 * etc.), `CREATE TABLE IF NOT EXISTS phases (...)` is a genuine no-op
 * against an ALREADY-EXISTING `phases` table (confirmed directly against
 * the real production db on 2026-08-17: `PRAGMA table_info(phases)` showed
 * no `artifact_json` column despite this file already declaring it in the
 * `CREATE TABLE IF NOT EXISTS` block — SQLite's `IF NOT EXISTS` guards the
 * whole `CREATE TABLE` statement, not each individual column, so it never
 * adds a column to a table that already exists). Every prior column
 * addition above happened to ship alongside a genuinely fresh deploy or
 * got lucky; this one was caught live before it broke `Tracer.phaseUpsert`
 * (called on essentially every `phase_start`/`phase_end`/`agent_end` event,
 * not just the new artifact-capture path) against the real, already-
 * populated prod db. `runMigrations` (below) is the real fix: a small,
 * idempotent `ALTER TABLE ... ADD COLUMN` runner, applied once at every
 * `Tracer` construction, that actually adds a column SQLite's own `CREATE
 * TABLE IF NOT EXISTS` cannot add retroactively. There's still no separate
 * migration-runner/versioning table in this codebase — `runMigrations`
 * checks `PRAGMA table_info` directly and no-ops if the column is already
 * present, which is safe to call unconditionally on every startup.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  ticket_id           TEXT PRIMARY KEY,  -- external (e.g. a .fleet board id) or internal ("ticket_<hex>") — see module header
  file_path           TEXT,              -- nullable: pure reference to an external ticket file (e.g. a .fleet board path); never read/parsed by this codebase
  created_at          TEXT,
  title               TEXT,              -- derived (deriveTitleFromPrompt) from the FIRST linked run's prompt
  latest_run_adw_id    TEXT               -- denormalized fast-path for "this ticket's latest run" (avoids an aggregate query over sessions on every list fetch)
);
CREATE TABLE IF NOT EXISTS sessions (
  adw_id        TEXT PRIMARY KEY,
  adw_name      TEXT,                -- ADW script(s) run, e.g. "adw_plan + adw_build_test"
  project_cwd   TEXT,                -- DEVIATION FROM UPSTREAM: which project this run targeted (abs path) — required since one db spans N projects, unlike upstream's per-repo db
  title         TEXT,                -- Workflow Run title — derived from the prompt or a ticket's title
  request       TEXT,
  status        TEXT,                -- running | success | fail
  engineer      TEXT,
  started_at    TEXT, ended_at TEXT,
  total_tokens  INTEGER DEFAULT 0, total_cost REAL DEFAULT 0,
  archived      INTEGER DEFAULT 0,   -- review triage, set by the UI; never by a run
  ticket_id     TEXT REFERENCES tickets  -- every run belongs to exactly one ticket (additive/nullable at the SQL level; every NEW run always sets it — see modules/ticket.ts)
);
CREATE TABLE IF NOT EXISTS phases (
  phase_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  seq           INTEGER,
  name TEXT, kind TEXT, owner TEXT, description TEXT,
  status        TEXT DEFAULT 'fail', -- success must be earned
  attempt       INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
  error         TEXT,
  input_tokens  INTEGER,             -- per-Step token usage, nullable (code steps never populate)
  output_tokens INTEGER,
  cached_tokens INTEGER,
  output_summary TEXT,               -- short outcome summary (agent step's envelope summary, or a code step's gate headline)
  artifact_json TEXT,                -- {branch, commitSha, prUrl} for a completed Step's real output — see module header
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  parent_id     TEXT,                -- span nesting
  type          TEXT,                -- phase_start | agent_start | tool_call | handoff
                                      -- | gate_pass | gate_fail | log | agent_end
                                      -- | phase_end | error
  name          TEXT,
  payload_json  TEXT,
  tokens        INTEGER,
  started_at    TEXT, ended_at TEXT  -- ended_at set only on events that span time
);
CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id   TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  agent         TEXT,
  output_type   TEXT,                -- name of the envelope schema it parsed against
  payload_json  TEXT,
  valid         INTEGER,
  attempt       INTEGER,
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS gate_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  attempt       INTEGER,
  gate          TEXT,
  passed        INTEGER,
  violations_json TEXT,              -- derived: the failed checks, as "item: note"
  checks_json   TEXT,                -- [{item, ok, note}] — everything the gate looked at
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS processes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  kind          TEXT,                -- 'adw' (the workflow process) | 'agent' (a coding-agent child)
  name          TEXT,                -- '' for the adw, the agent name for a child
  pid           INTEGER,
  command       TEXT,                -- what the pid WAS; pids get recycled, so verify before killing
  started_at    TEXT, ended_at TEXT  -- ended_at NULL = believed alive
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  adw_id        TEXT REFERENCES sessions,
  agent         TEXT,
  coding_agent  TEXT, model TEXT, color TEXT,
  session_id    TEXT,
  context_tokens  INTEGER,           -- window occupancy after the agent's last turn
  context_window  INTEGER,           -- the model's ceiling; 0/NULL = unknown
  created_at    TEXT, last_used_at TEXT,
  PRIMARY KEY (adw_id, agent)
);
`;

/** Pragmas required on every connection — writer and reader alike. */
export const PRAGMAS = [
  "PRAGMA journal_mode=WAL;",
  "PRAGMA synchronous=NORMAL;",
  "PRAGMA busy_timeout=5000;",
];

/**
 * Real, idempotent column migrations — the actual fix for the gap
 * `CREATE TABLE IF NOT EXISTS` leaves open (see this file's module header,
 * "This one is NOT purely additive" section, for the full incident this was
 * caught from). No separate migration-runner/versioning table exists
 * anywhere in this codebase; this function IS that mechanism, minimal on
 * purpose: for each `{table, column, ddlType}` entry, check `PRAGMA
 * table_info(<table>)` for the column and run `ALTER TABLE ... ADD COLUMN`
 * only if it's missing. Safe to call unconditionally on every `Tracer`
 * construction (a brand-new db already has the column from `SCHEMA` above,
 * so every check below is a no-op there too) — there is no "run once"
 * semantics to get wrong.
 *
 * Add a new entry here, not a new column directly in `SCHEMA` above, for
 * every FUTURE column added to an existing table — `SCHEMA`'s `CREATE TABLE
 * IF NOT EXISTS` only ever matters for a genuinely fresh db file; any
 * column that needs to reach an EXISTING db (which in practice means every
 * column added after this codebase's first production deploy) needs a
 * corresponding entry here too, or it silently never lands on a real,
 * already-populated db — exactly the bug this migration mechanism fixes.
 */
const MIGRATIONS: Array<{ table: string; column: string; ddlType: string }> = [
  { table: "phases", column: "artifact_json", ddlType: "TEXT" },
];

/**
 * bun:sqlite's own row-shape generic requires a caller-supplied type for
 * `.all()` — narrowed to just the one column this function reads, not the
 * full `PRAGMA table_info` row shape (name/type/notnull/dflt_value/pk),
 * since that's all `hasColumn` below actually needs.
 */
interface TableInfoRow {
  name: string;
}

/**
 * Minimal shape `runMigrations` needs from a db handle — matches
 * `bun:sqlite`'s `Database` for the two zero-parameter-bind calls this
 * module makes (`PRAGMA table_info(...)` / `ALTER TABLE ...`, neither ever
 * takes bind params here), typed narrowly here rather than importing the
 * concrete `Database` type, so this module stays free of a `bun:sqlite`
 * import (kept purely as a schema/DDL-string module, per its own
 * established scope — the concrete db handle is `tracer.ts`'s concern).
 */
export interface MigratableDb {
  query<T>(sql: string): { all(): T[] };
  run(sql: string): void;
}

/** True if `table` already has `column`, per a live `PRAGMA table_info` read against `db`. */
function hasColumn(db: MigratableDb, table: string, column: string): boolean {
  const rows = db.query<TableInfoRow>(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

/**
 * Applies every entry in `MIGRATIONS` that `db`'s current `phases` table
 * (or whichever table the entry names) is missing — see `MIGRATIONS`'s own
 * doc comment for the full reasoning and how to extend this for a future
 * column. Called once per `Tracer` construction (`tracer.ts`), immediately
 * after `SCHEMA` is applied and before any other DB operation — so every
 * later `phaseUpsert`/`stepArtifact` call always sees the real column
 * present, whether this is a brand-new db (SCHEMA already created it, this
 * is a no-op) or an existing production db missing a column SCHEMA's own
 * `CREATE TABLE IF NOT EXISTS` could never retroactively add.
 */
export function runMigrations(db: MigratableDb): void {
  for (const { table, column, ddlType } of MIGRATIONS) {
    if (!hasColumn(db, table, column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
    }
  }
}

/**
 * Applies `SCHEMA` then `runMigrations` to an ALREADY-OPEN, writable `db`
 * handle — the one place both real callers that need "this db file's
 * schema is fully current" should go through, so the two steps can never
 * be applied out of order or have one forgotten.
 *
 * Filed directly from a production incident: `Tracer`'s constructor called
 * both steps correctly, but `orchestrator/server.ts` opened its OWN raw
 * `bun:sqlite` handles and only ran `SCHEMA` (not `runMigrations`, and only
 * `SCHEMA` was only run inside an `if (!existsSync(DB_PATH))` bootstrap
 * block — a no-op against the real, already-existing production db, so the
 * orchestrator process never got the `artifact_json` column at all). Every
 * `/api/...` route reading `phases.artifact_json` 500'd in production as a
 * direct result. `ensureSchemaCurrent` is the fix: ONE function both
 * `Tracer`'s constructor (which keeps its own open handle) and `server.ts`'s
 * bootstrap (which opens a brief writable handle, calls this, then closes
 * it, before its own readonly handle opens) call — no third call site can
 * silently drift out of sync with either step again.
 *
 * `db` must be a writable handle — `SCHEMA`'s `CREATE TABLE`/`runMigrations`'s
 * `ALTER TABLE` both fail against a readonly one, by design (bun:sqlite
 * throws on any write attempt against a `{ readonly: true }` handle) — this
 * is deliberately called BEFORE any readonly handle in this codebase ever
 * opens the same file, never after.
 */
export function ensureSchemaCurrent(db: MigratableDb): void {
  db.run(SCHEMA);
  runMigrations(db);
}
