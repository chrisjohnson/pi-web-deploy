/**
 * Unit tests for schema.ts's `runMigrations` — the real fix for a
 * production incident: `CREATE TABLE IF NOT EXISTS phases (...)` (this
 * file's own `SCHEMA` constant) is a no-op against an ALREADY-EXISTING
 * `phases` table, so it can never retroactively add a column to a real,
 * already-populated db. Confirmed live 2026-08-17 against the actual
 * production db on local-ai-machine: `PRAGMA table_info(phases)` showed no
 * `artifact_json` column despite `SCHEMA` already declaring it.
 *
 * Every test here deliberately builds an OLD-SHAPE `phases` table by hand
 * (mirroring the schema before `artifact_json` was added) — the exact gap
 * that let the original bug ship unnoticed: every other test in this
 * codebase's suite constructs a brand-new db via `SCHEMA`'s own `CREATE
 * TABLE IF NOT EXISTS`, which genuinely creates the column fresh every
 * time and so never exercises the "upgrading an existing db" path at all.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./schema.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-schema-migrations-test-"));
  dbPath = join(dir, "factory.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The shape of `phases` before `artifact_json` was added — every column BEFORE it, hand-built to mirror a real, already-deployed production db. */
function createOldShapePhasesTable(db: Database): void {
  db.run(`
    CREATE TABLE phases (
      phase_id      TEXT PRIMARY KEY,
      adw_id        TEXT,
      seq           INTEGER,
      name TEXT, kind TEXT, owner TEXT, description TEXT,
      status        TEXT DEFAULT 'fail',
      attempt       INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
      error         TEXT,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      output_summary TEXT,
      started_at    TEXT, ended_at TEXT
    )
  `);
}

describe("runMigrations", () => {
  test("adds phases.artifact_json to a db whose phases table predates that column", () => {
    const db = new Database(dbPath, { create: true });
    createOldShapePhasesTable(db);

    const before = db.query<{ name: string }, []>("PRAGMA table_info(phases)").all();
    expect(before.map((c) => c.name)).not.toContain("artifact_json");

    runMigrations(db);

    const after = db.query<{ name: string }, []>("PRAGMA table_info(phases)").all();
    expect(after.map((c) => c.name)).toContain("artifact_json");
    db.close();
  });

  test("a migrated old-shape phases table accepts a real INSERT/UPDATE against artifact_json — not just a schema-level presence check", () => {
    const db = new Database(dbPath, { create: true });
    createOldShapePhasesTable(db);
    runMigrations(db);

    db.run(
      `INSERT INTO phases (phase_id, adw_id, seq, name, kind, owner, description, status)
       VALUES ('phase_1', 'adw_1', 1, 'build', 'agent', 'build', '', 'success')`,
    );
    db.run(`UPDATE phases SET artifact_json=? WHERE phase_id=?`, [
      JSON.stringify({ branch: "pi-web-factory/adw_1", commitSha: "abc123", prUrl: null }),
      "phase_1",
    ]);

    const row = db.query<{ artifact_json: string | null }, []>("SELECT artifact_json FROM phases WHERE phase_id='phase_1'").get();
    expect(JSON.parse(row?.artifact_json ?? "{}")).toMatchObject({ commitSha: "abc123" });
    db.close();
  });

  test("is idempotent — calling it twice against the same db does not throw (safe to run on every process startup, not just once)", () => {
    const db = new Database(dbPath, { create: true });
    createOldShapePhasesTable(db);

    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(phases)").all();
    // Still exactly one artifact_json column — a naive re-run that didn't
    // check first would either throw ("duplicate column name") or, worse,
    // silently succeed with unexpected behavior; this proves the real
    // guard (hasColumn) actually prevents a second ALTER TABLE from firing.
    expect(cols.filter((c) => c.name === "artifact_json").length).toBe(1);
    db.close();
  });

  test("a genuinely fresh db (column already present via SCHEMA's own CREATE TABLE) is also a safe no-op", () => {
    const db = new Database(dbPath, { create: true });
    db.run(`
      CREATE TABLE phases (
        phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER,
        name TEXT, kind TEXT, owner TEXT, description TEXT,
        status TEXT DEFAULT 'fail', attempt INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
        error TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
        output_summary TEXT, artifact_json TEXT, started_at TEXT, ended_at TEXT
      )
    `);

    expect(() => runMigrations(db)).not.toThrow();
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(phases)").all();
    expect(cols.filter((c) => c.name === "artifact_json").length).toBe(1);
    db.close();
  });
});
