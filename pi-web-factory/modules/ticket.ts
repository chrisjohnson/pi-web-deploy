/**
 * ticket.ts: the `tickets` table's mint/attach logic (M-103) — the grouping
 * anchor that lets multiple Workflow Run attempts at "conceptually the same
 * job" (a manual retry, or a future automated one) roll up under one card in
 * the orchestrator instead of showing as N unrelated-looking runs.
 *
 * ── Ticket id shape ────────────────────────────────────────────────────────
 * Deliberately NOT tied to this codebase's own `adw_<hex>` shape (`tracer.ts`'s
 * `newId`/`cli.ts`'s adwId minting) — a ticket id must also be able to hold an
 * EXTERNAL id (e.g. `.fleet`'s `M-103`/`K-042.1` shapes) when one is passed
 * explicitly. When no external id is given (the common "just run something"
 * case), this module mints `ticket_<hex>` — visually distinct from `adw_<hex>`
 * so the two id spaces never collide and are easy to tell apart at a glance in
 * the DB/orchestrator.
 *
 * ── `file_path` is a pure reference field ─────────────────────────────────
 * Per the M-103 card (Chris, verbatim): "the 'fleet ticket' file itself
 * doesn't even need to be read by the fleet orchestrator or anything." This
 * module NEVER opens/parses/watches `tickets.file_path` — it only ever WRITES
 * a caller-supplied path (or leaves it NULL) so a human can jump from a
 * ticket row to its source file. `mintOrAttachTicket` doesn't even accept a
 * `filePath` parameter today (no caller has an external file to pass yet);
 * the column exists in schema.ts for whenever a future `.fleet`-lite queue
 * integration wants to set it directly via a raw UPDATE — deliberately not
 * over-built ahead of that need.
 *
 * ── Every run belongs to exactly one ticket, always ───────────────────────
 * `mintOrAttachTicket` is the ONLY entry point a runner (`cli.ts` today; any
 * future ticket-queue worker) needs: pass an explicit `ticketId` to ATTACH
 * this run to an existing ticket (creating a row for it if the id is novel —
 * matches a human-provided external id that doesn't have a ticket row yet),
 * or omit it to MINT a fresh internal ticket for this run. Either way, the
 * caller gets back a real `ticket_id` to store on the run's own `sessions`
 * row (`Tracer.sessionStart`'s new `ticketId` option) — no run is ever
 * created without one.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export interface Ticket {
  ticketId: string;
  filePath: string | null;
  createdAt: string | null;
  title: string | null;
  latestRunAdwId: string | null;
}

interface TicketRow {
  ticket_id: string;
  file_path: string | null;
  created_at: string | null;
  title: string | null;
  latest_run_adw_id: string | null;
}

function rowToTicket(row: TicketRow): Ticket {
  return {
    ticketId: row.ticket_id,
    filePath: row.file_path,
    createdAt: row.created_at,
    title: row.title,
    latestRunAdwId: row.latest_run_adw_id,
  };
}

/** Mints a fresh internal ticket id — `ticket_<12 lowercase hex chars>`, mirroring tracer.ts's `adw_<hex>` shape closely enough to read as "the same kind of id" while staying visually distinct (the `ticket_` prefix), never colliding with an adwId or an external id like `M-103`. */
export function mintInternalTicketId(): string {
  return `ticket_${randomBytes(6).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Looks up one ticket row by id, or `undefined` if it doesn't exist yet.
 */
export function getTicket(db: Database, ticketId: string): Ticket | undefined {
  const row = db
    .query<TicketRow, [string]>(
      "SELECT ticket_id, file_path, created_at, title, latest_run_adw_id FROM tickets WHERE ticket_id = ?",
    )
    .get(ticketId);
  return row ? rowToTicket(row) : undefined;
}

/**
 * Ensures a run belongs to exactly one ticket, per the module header's "every
 * run belongs to exactly one ticket, always" rule:
 *   - `explicitTicketId` given, already exists -> attach to it (no title
 *     change — the ticket's title stays whatever its FIRST linked run set).
 *   - `explicitTicketId` given, doesn't exist yet -> create it now (covers a
 *     human/external id, e.g. a `.fleet` board id, that doesn't have a ticket
 *     row yet — the id itself is the source of truth, this just backs it with
 *     a row), titled from `taskPrompt` since this is effectively its first
 *     linked run.
 *   - `explicitTicketId` omitted -> mint a fresh internal ticket
 *     (`mintInternalTicketId`), titled from `taskPrompt`.
 *
 * Returns the resolved `ticket_id` — the caller (`cli.ts`/`runWorkflow`)
 * threads this into `Tracer.sessionStart`'s `ticketId` option so the new
 * run's `sessions` row is linked from the moment it's created.
 *
 * Deliberately takes a raw `Database` handle (not `Tracer` itself) — kept
 * framework-thin, same layering `roles.ts`/`workflowDef.ts` use relative to
 * `tracer.ts` (a plain data/lookup module, not the write-path class).
 * `Tracer` owns wiring this into `sessionStart`.
 */
export function mintOrAttachTicket(
  db: Database,
  opts: { explicitTicketId?: string; taskPrompt: string; deriveTitleFromPrompt: (prompt: string) => string },
): string {
  const ticketId = opts.explicitTicketId ?? mintInternalTicketId();
  const existing = getTicket(db, ticketId);
  if (existing) return ticketId;

  const title = opts.deriveTitleFromPrompt(opts.taskPrompt);
  db.run(
    `INSERT INTO tickets (ticket_id, file_path, created_at, title, latest_run_adw_id)
     VALUES (?, NULL, ?, ?, NULL)`,
    [ticketId, nowIso(), title],
  );
  return ticketId;
}

/** Updates a ticket's denormalized "latest run" pointer — called once a run is known to be linked to a ticket (Tracer.sessionStart), so the orchestrator's ticket-level grid can show a ticket's latest attempt without an aggregate query over `sessions` on every list fetch (schema.ts's own doc comment on `latest_run_adw_id`). */
export function setTicketLatestRun(db: Database, ticketId: string, adwId: string): void {
  db.run("UPDATE tickets SET latest_run_adw_id = ? WHERE ticket_id = ?", [adwId, ticketId]);
}

/** Every run linked to a ticket, most recent first (by started_at) — the ticket's full attempt history, used by both the orchestrator's per-ticket run list and (Phase 3) the evidence stack handed to the retry-decision Role. */
export interface TicketRunRow {
  adwId: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  title: string | null;
}

interface RunForTicketRow {
  adw_id: string;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
}

export function runsForTicket(db: Database, ticketId: string): TicketRunRow[] {
  const rows = db
    .query<RunForTicketRow, [string]>(
      `SELECT adw_id, status, started_at, ended_at, title FROM sessions
       WHERE ticket_id = ? ORDER BY started_at DESC, adw_id DESC`,
    )
    .all(ticketId);
  return rows.map((r) => ({ adwId: r.adw_id, status: r.status, startedAt: r.started_at, endedAt: r.ended_at, title: r.title }));
}
