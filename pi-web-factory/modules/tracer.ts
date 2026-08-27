/**
 * Tracer: the write path into the shared trace db.
 *
 * TS/bun:sqlite port of upstream SSSF's `adws/adw_modules/tracer.py`. Every
 * event lands in `events`, and the ten event types additionally touch the
 * table observability.md describes for them:
 *   - phase_start  -> upserts a `phases` row (status "running")
 *   - phase_end    -> upserts the same `phases` row with the resolved status
 *   - agent_start  -> upserts an `agent_sessions` row for the agent
 *   - agent_end    -> adds usage/cost to `sessions`, refreshes `agent_sessions`
 *                     context occupancy
 *   - gate_pass / gate_fail -> also writes a `gate_results` row (mirrors the
 *     event payload, per observability.md: "the gate_results table and the
 *     event stream are equivalent sources")
 *   - handoff, tool_call, log, error -> `events` only
 *
 * `parent_id` nests spans exactly as upstream: the caller passes the parent
 * event's id (e.g. an `agent_start` event id as the `parent_id` for the
 * `tool_call` events that happen inside that agent's turn).
 *
 * ── Terminology migration (M-074, pi-web-adw-design.md §7) ────────────────
 * Per schema.ts's header comment, this module renames its TS-facing surface
 * to the new vocabulary while the underlying SQL (`sessions`/`phases`
 * tables, the `owner` column) stays exactly as it was:
 *   - `WorkflowRun` is the new TS name for what this module used to call a
 *     "session" (still the `sessions` SQL table underneath).
 *   - `Step` is the new TS name for what this module used to call a "phase"
 *     (still the `phases` SQL table underneath) — `StepKind`/`StepStatus`
 *     replace `PhaseKind`/`PhaseStatus`, narrowed to `'agent' | 'code'`
 *     (`'engineer'` dropped — confirmed unused anywhere in this codebase).
 *   - `role` is the new TS field/parameter name for what this module used to
 *     call `owner` — `phaseUpsert`'s options object and `Tracer`'s other
 *     public methods now take `role`, and write it into the SQL `owner`
 *     column internally. The raw JSON `payload` object accepted by
 *     `event()`/written by callers (including out-of-scope `chains/
 *     planBuildTest.ts`) still uses the key `"owner"` — that's a wire-format
 *     convention for the event payload blob, not a TS type, and is left
 *     alone here; `_upsertPhaseFromEvent` reads `payload["owner"]` and
 *     threads it into the new `role` field.
 *   - New optional write support: `phaseUpsert` (and `event()`'s
 *     `phase_end`/`agent_end` side effects) can now also set
 *     `input_tokens`/`output_tokens`/`cached_tokens`/`output_summary` on a
 *     Step — additive, `sessions.total_tokens` accumulation is unchanged.
 */

import { Database } from "bun:sqlite";
import { PRAGMAS, ensureSchemaCurrent } from "./schema.ts";
import { mintOrAttachTicket, setTicketLatestRun } from "./ticket.ts";
import type { StepArtifact } from "./stepArtifact.ts";

export type EventType =
  | "phase_start"
  | "agent_start"
  | "tool_call"
  | "handoff"
  | "gate_pass"
  | "gate_fail"
  | "log"
  | "agent_end"
  | "phase_end"
  | "error";

/** A Step's kind (§7.1: agentic step vs code step). `'engineer'` dropped — never constructed anywhere in this codebase (confirmed via grep, M-074). */
export type StepKind = "agent" | "code";
export type StepStatus = "queued" | "running" | "success" | "fail";
export type WorkflowRunStatus = "running" | "success" | "fail";

/** @deprecated Old name for {@link StepKind}, kept as an alias during the M-074 migration window. Prefer StepKind. */
export type PhaseKind = StepKind;
/** @deprecated Old name for {@link StepStatus}. Prefer StepStatus. */
export type PhaseStatus = StepStatus;
/** @deprecated Old name for {@link WorkflowRunStatus}. Prefer WorkflowRunStatus. */
export type SessionStatus = WorkflowRunStatus;

/**
 * TS-level row shape for one `sessions` row (§7.1: "Workflow Run" — one
 * execution of a single, top-level, open-ended prompt). The SQL table
 * backing this is still named `sessions` — see module header.
 */
export interface WorkflowRun {
  adwId: string;
  adwName: string | null;
  projectCwd: string | null;
  title: string | null;
  request: string | null;
  status: WorkflowRunStatus;
  engineer: string | null;
  startedAt: string | null;
  endedAt: string | null;
  totalTokens: number;
  totalCost: number;
  archived: boolean;
  /** M-103: the ticket this run is linked to — every run has exactly one, always (see ticket.ts). */
  ticketId: string | null;
}

/**
 * TS-level row shape for one `phases` row (§7.1: "Step" — one unit of work
 * inside a Workflow, agentic or code). The SQL table backing this is still
 * named `phases`, and its `role` field is still the SQL `owner` column —
 * see module header.
 */
export interface Step {
  phaseId: string;
  adwId: string;
  seq: number;
  name: string;
  kind: StepKind;
  role: string;
  description: string;
  status: StepStatus;
  attempt: number;
  retries: number;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  outputSummary: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface EventRecord {
  adwId: string;
  phaseId?: string;
  type: EventType;
  name?: string;
  payload?: Record<string, unknown>;
  parentId?: string;
  tokens?: number | null;
  /** Set both for events that span real elapsed time (tool_call). */
  startedAt?: string;
  endedAt?: string;
}

export interface GateCheck {
  item: string;
  ok: boolean;
  note?: string;
}

export interface GateReport {
  checks: GateCheck[];
}

export interface AgentSessionInfo {
  adwId: string;
  agent: string;
  codingAgent?: string;
  model?: string;
  color?: string;
  sessionId?: string;
  contextTokens?: number;
  contextWindow?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  // 12 hex chars, matching upstream's `new_id(12)` shape closely enough for
  // uniqueness purposes — not required to be byte-identical to Python's impl.
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

/** Cap applied to a title derived from a task prompt — short enough to read as an actual title (a card heading, a browser tab), not a second copy of the full prompt (that's what `sessions.request` is for). */
const TITLE_CAP = 72;

/**
 * Derives a short, human-readable title from a Workflow Run's task prompt —
 * no model call, just a deterministic string operation, so it's free and
 * instant to compute at Workflow Run start. Takes the prompt's first
 * sentence (up to the first `.`/`!`/`?` followed by whitespace, or the
 * first newline, whichever comes first) as the most likely "the actual
 * ask" boundary, then hard-caps to `TITLE_CAP` chars with an ellipsis if
 * still too long. Falls back to a hard truncation of the whole prompt if it
 * has no sentence/line boundary within a reasonable window (e.g. one long
 * run-on clause) — always returns a non-empty string for any non-empty
 * input.
 */
export function deriveTitleFromPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return "(no task description)";

  const firstLine = trimmed.split("\n")[0] ?? trimmed;
  const sentenceMatch = /^(.*?[.!?])(\s|$)/.exec(firstLine);
  const candidate = (sentenceMatch?.[1] ?? firstLine).trim();

  if (candidate.length <= TITLE_CAP) return candidate;
  return `${candidate.slice(0, TITLE_CAP - 1).trimEnd()}…`;
}

export class Tracer {
  readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    for (const pragma of PRAGMAS) this.db.run(pragma);
    // schema.ts's ensureSchemaCurrent: applies SCHEMA (CREATE TABLE IF NOT
    // EXISTS — a no-op against an already-existing table) THEN runMigrations
    // (the real fix for a db file that predates a given column — see
    // schema.ts's module header for the full incident this was caught
    // from). Must run before any other method on this instance can touch
    // the db, so every phaseUpsert/stepArtifact call this instance ever
    // makes sees the real, fully-current column set. Also called by
    // orchestrator/server.ts's own bootstrap (a different writable handle,
    // opened/closed before that process's readonly handle) — see that
    // file's own comment; `ensureSchemaCurrent` is the one shared place
    // both call sites go through so they can't drift out of sync again.
    ensureSchemaCurrent(this.db);
  }

  close(): void {
    this.db.close();
  }

  // ── sessions ────────────────────────────────────────────────────────────

  /**
   * `opts.ticketId`/`opts.taskPromptForTicket` (M-103): every run belongs to
   * exactly one ticket, always — mints a fresh internal ticket
   * (`ticket.ts`'s `mintOrAttachTicket`) when `ticketId` is omitted, or
   * attaches to (creating if novel) the given id when one is passed. Needs
   * `taskPromptForTicket` alongside `ticketId` (rather than deriving it from
   * `sessionRequest`, called separately/later by callers) so a BRAND NEW
   * ticket's title can be set from the very first call that creates its row —
   * callers that don't care about tickets (none should exist going forward,
   * but existing tests that only exercise unrelated Tracer methods) can omit
   * both and get NULL, same as any other optional column.
   */
  sessionStart(
    adwId: string,
    opts: { engineer?: string; projectCwd?: string; adwName?: string; ticketId?: string; taskPromptForTicket?: string } = {},
  ): void {
    const resolvedTicketId =
      opts.ticketId !== undefined || opts.taskPromptForTicket !== undefined
        ? mintOrAttachTicket(this.db, {
            explicitTicketId: opts.ticketId,
            taskPrompt: opts.taskPromptForTicket ?? "",
            deriveTitleFromPrompt,
          })
        : null;

    this.db.run(
      `INSERT INTO sessions (adw_id, status, engineer, project_cwd, started_at, ticket_id)
       VALUES (?, 'running', ?, ?, ?, ?)
       ON CONFLICT(adw_id) DO UPDATE SET status='running'`,
      [adwId, opts.engineer ?? null, opts.projectCwd ?? null, nowIso(), resolvedTicketId],
    );
    if (resolvedTicketId) setTicketLatestRun(this.db, resolvedTicketId, adwId);

    if (!opts.adwName) return;
    const row = this.db
      .query<{ adw_name: string | null }, [string]>("SELECT adw_name FROM sessions WHERE adw_id=?")
      .get(adwId);
    const names = row?.adw_name ? row.adw_name.split(" + ") : [];
    if (!names.includes(opts.adwName)) {
      names.push(opts.adwName);
      this.db.run("UPDATE sessions SET adw_name=? WHERE adw_id=?", [names.join(" + "), adwId]);
    }
  }

  /**
   * Stores the run's COMPLETE original task prompt, untruncated — the
   * orchestrator's detail page displays this in full (2026-08-05 redesign:
   * "the ticket should also include the complete initial prompt"). A prior
   * version capped this at 500 chars, silently discarding the rest of any
   * real, detailed prompt before it ever reached storage — found while
   * wiring up that display and fixed here, since no truncation at the UI
   * layer can recover data this method never persisted. `request` is a
   * plain SQLite TEXT column (schema.ts) with no meaningful size ceiling
   * for a local trace db.
   */
  sessionRequest(adwId: string, request: string): void {
    this.db.run("UPDATE sessions SET request=? WHERE adw_id=?", [request, adwId]);
  }

  /**
   * Sets a Workflow Run's title (M-074: `sessions.title`).
   */
  sessionSetTitle(adwId: string, title: string): void {
    this.db.run("UPDATE sessions SET title=? WHERE adw_id=?", [title.slice(0, 500), adwId]);
  }

  sessionFinish(adwId: string, ok: boolean): void {
    this.db.run("UPDATE sessions SET status=?, ended_at=? WHERE adw_id=?", [
      ok ? "success" : "fail",
      nowIso(),
      adwId,
    ]);
    this.processesEndAll(adwId);
  }

  sessionAddUsage(adwId: string, tokens: number, cost: number): void {
    this.db.run(
      "UPDATE sessions SET total_tokens=total_tokens+?, total_cost=total_cost+? WHERE adw_id=?",
      [tokens, cost, adwId],
    );
  }

  // ── processes ───────────────────────────────────────────────────────────

  processStart(adwId: string, kind: "adw" | "agent", name: string, pid: number, command: string): void {
    this.db.run(
      `INSERT INTO processes (adw_id, kind, name, pid, command, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [adwId, kind, name, pid, command.slice(0, 500), nowIso()],
    );
  }

  processEnd(adwId: string, pid: number): void {
    this.db.run(
      `UPDATE processes SET ended_at=? WHERE id = (
         SELECT id FROM processes WHERE adw_id=? AND pid=? AND ended_at IS NULL
         ORDER BY id DESC LIMIT 1)`,
      [nowIso(), adwId, pid],
    );
  }

  processesEndAll(adwId: string): void {
    this.db.run("UPDATE processes SET ended_at=? WHERE adw_id=? AND ended_at IS NULL", [
      nowIso(),
      adwId,
    ]);
  }

  // ── phases ──────────────────────────────────────────────────────────────

  maxPhaseSeq(adwId: string): number {
    const row = this.db
      .query<{ "MAX(seq)": number | null }, [string]>("SELECT MAX(seq) FROM phases WHERE adw_id = ?")
      .get(adwId);
    return row?.["MAX(seq)"] ?? 0;
  }

  /**
   * Upserts a Step row (`phases` table underneath — see module header).
   * `role` is the new TS-facing name for what the SQL column still calls
   * `owner`; it's written into that column here, at this one boundary.
   *
   * `inputTokens`/`outputTokens`/`cachedTokens`/`outputSummary` are the
   * M-074 additions — all optional. `artifactJson` is the M-121 addition
   * (a completed Step's real output — branch/commit/PR — see schema.ts's
   * module header). All optional. When omitted on an UPDATE (the
   * conflict-branch), the existing column value is preserved via
   * `COALESCE(excluded.x, phases.x)` rather than being clobbered back to
   * NULL, since `phase_start` and `phase_end` both upsert the same row and
   * only `phase_end` (via run.ts) has the data to set them.
   */
  phaseUpsert(phase: {
    phaseId: string;
    adwId: string;
    seq: number;
    name: string;
    kind: StepKind;
    role: string;
    description: string;
    status: StepStatus;
    attempt?: number;
    retries?: number;
    error?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedTokens?: number | null;
    outputSummary?: string | null;
    artifactJson?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO phases (phase_id, adw_id, seq, name, kind, owner, description,
         status, attempt, retries, error, started_at, ended_at,
         input_tokens, output_tokens, cached_tokens, output_summary, artifact_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(phase_id) DO UPDATE SET status=excluded.status,
         attempt=excluded.attempt, error=excluded.error, ended_at=excluded.ended_at,
         input_tokens=COALESCE(excluded.input_tokens, phases.input_tokens),
         output_tokens=COALESCE(excluded.output_tokens, phases.output_tokens),
         cached_tokens=COALESCE(excluded.cached_tokens, phases.cached_tokens),
         output_summary=COALESCE(excluded.output_summary, phases.output_summary),
         artifact_json=COALESCE(excluded.artifact_json, phases.artifact_json)`,
      [
        phase.phaseId,
        phase.adwId,
        phase.seq,
        phase.name,
        phase.kind,
        phase.role,
        phase.description,
        phase.status,
        phase.attempt ?? 0,
        phase.retries ?? 0,
        phase.error ?? null,
        phase.startedAt ?? null,
        phase.endedAt ?? null,
        phase.inputTokens ?? null,
        phase.outputTokens ?? null,
        phase.cachedTokens ?? null,
        phase.outputSummary ?? null,
        phase.artifactJson ?? null,
      ],
    );
  }

  /**
   * M-121: sets an ALREADY-EXISTING Step row's `artifact_json` directly, by
   * `phaseId` — a targeted single-column write, not a full `phaseUpsert`
   * (which needs the row's other required fields in hand; this call site,
   * `workflow.ts`'s `runAgentStep`, only has the artifact at hand at the
   * moment a Step reaches SUCCESS, well after its own `phaseUpsert` calls
   * already ran via `run.ts`'s `phase_start`/`phase_end` events). A no-op
   * (silently) if `phaseId` doesn't exist yet — defensive only, shouldn't
   * happen given the call site always runs after that Step's own
   * `phase_end`.
   */
  stepArtifact(phaseId: string, artifact: StepArtifact): void {
    this.db.run("UPDATE phases SET artifact_json=? WHERE phase_id=?", [JSON.stringify(artifact), phaseId]);
  }

  // ── envelopes / gates / agent sessions ─────────────────────────────────

  envelopeRow(opts: {
    adwId: string;
    phaseId: string;
    agent: string;
    outputType: string;
    payloadJson: string;
    valid: boolean;
    attempt: number;
  }): void {
    this.db.run(
      `INSERT INTO envelopes (envelope_id, adw_id, phase_id, agent, output_type,
         payload_json, valid, attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        newId("env"),
        opts.adwId,
        opts.phaseId,
        opts.agent,
        opts.outputType,
        opts.payloadJson,
        opts.valid ? 1 : 0,
        opts.attempt,
        nowIso(),
      ],
    );
  }

  gateRow(opts: { adwId: string; phaseId: string; gate: string; attempt: number; report: GateReport }): void {
    const violations = opts.report.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.item}: ${c.note || "failed"}`);
    const passed = violations.length === 0;
    this.db.run(
      `INSERT INTO gate_results (adw_id, phase_id, attempt, gate, passed,
         violations_json, checks_json, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [
        opts.adwId,
        opts.phaseId,
        opts.attempt,
        opts.gate,
        passed ? 1 : 0,
        JSON.stringify(violations),
        JSON.stringify(opts.report.checks),
        nowIso(),
      ],
    );
  }

  agentSessionRow(info: AgentSessionInfo): void {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO agent_sessions (adw_id, agent, coding_agent, model, color,
         session_id, context_tokens, context_window, created_at, last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(adw_id, agent) DO UPDATE SET model=excluded.model,
         color=excluded.color, session_id=excluded.session_id,
         context_tokens=excluded.context_tokens,
         context_window=excluded.context_window,
         last_used_at=excluded.last_used_at`,
      [
        info.adwId,
        info.agent,
        info.codingAgent ?? null,
        info.model ?? null,
        info.color ?? null,
        info.sessionId ?? null,
        info.contextTokens ?? 0,
        info.contextWindow ?? 0,
        ts,
        ts,
      ],
    );
  }

  // ── events (the ten types) ─────────────────────────────────────────────

  /**
   * Records one event of any of the ten types into `events`, plus whatever
   * side-table write that type implies (see module docstring). Returns the
   * new event's id, so callers can pass it as `parentId` for nested spans
   * (e.g. tool_call events nested under the agent_start that spawned them).
   */
  event(record: EventRecord): string {
    const eventId = newId("evt");
    const ts = nowIso();
    const payloadJson = JSON.stringify(record.payload ?? {});
    this.db.run(
      `INSERT INTO events (event_id, adw_id, phase_id, parent_id, type, name,
         payload_json, tokens, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        eventId,
        record.adwId,
        record.phaseId ?? "",
        record.parentId ?? "",
        record.type,
        record.name ?? "",
        payloadJson,
        record.tokens ?? null,
        record.startedAt ?? ts,
        record.endedAt ?? null,
      ],
    );

    this._sideEffects(eventId, record);
    return eventId;
  }

  private _sideEffects(eventId: string, record: EventRecord): void {
    const payload = record.payload ?? {};
    switch (record.type) {
      case "phase_start": {
        this._upsertPhaseFromEvent(record, "running", payload);
        break;
      }
      case "phase_end": {
        const status = (payload["status"] as StepStatus | undefined) ?? "fail";
        this._upsertPhaseFromEvent(record, status, payload);
        break;
      }
      case "agent_start": {
        if (record.phaseId) {
          this.agentSessionRow({
            adwId: record.adwId,
            agent: record.name ?? (payload["agent"] as string) ?? "",
            codingAgent: payload["coding_agent"] as string | undefined,
            model: payload["model"] as string | undefined,
            color: payload["color"] as string | undefined,
            sessionId: payload["session_id"] as string | undefined,
          });
        }
        break;
      }
      case "agent_end": {
        // M-074: usage is already carried verbatim in payload_json (below),
        // but is now ALSO threaded into per-Step token columns — additive,
        // not a replacement for the existing sessions.total_tokens
        // accumulation (`sessionAddUsage`, unchanged).
        const usage = (payload["usage"] as Record<string, unknown> | undefined) ?? {};
        const cost = (payload["cost"] as number | undefined) ?? 0;
        const tokens = (payload["tokens"] as number | undefined) ?? record.tokens ?? 0;
        this.sessionAddUsage(record.adwId, tokens ?? 0, cost ?? 0);
        if (record.name || payload["agent"]) {
          this.agentSessionRow({
            adwId: record.adwId,
            agent: record.name ?? (payload["agent"] as string) ?? "",
            contextTokens: payload["context_tokens"] as number | undefined,
            contextWindow: payload["context_window"] as number | undefined,
            sessionId: payload["session_id"] as string | undefined,
          });
        }
        if (record.phaseId) {
          const inputTokens = usage["input"] as number | undefined;
          const outputTokens = usage["output"] as number | undefined;
          const cachedTokens = usage["cached"] as number | undefined;
          const outputSummary = payload["outputSummary"] as string | undefined;
          if (
            inputTokens !== undefined ||
            outputTokens !== undefined ||
            cachedTokens !== undefined ||
            outputSummary !== undefined
          ) {
            const existing = this.db
              .query<
                { seq: number; kind: StepKind; owner: string; description: string; name: string; status: StepStatus },
                [string]
              >("SELECT seq, kind, owner, description, name, status FROM phases WHERE phase_id=?")
              .get(record.phaseId);
            this.phaseUpsert({
              phaseId: record.phaseId,
              adwId: record.adwId,
              seq: existing?.seq ?? this.maxPhaseSeq(record.adwId) + 1,
              name: existing?.name ?? record.name ?? "",
              kind: existing?.kind ?? "agent",
              role: existing?.owner ?? "",
              description: existing?.description ?? "",
              // Preserve the row's actual current status rather than asserting
              // "running" — this upsert's only job is attaching token/summary
              // data to an existing Step row. `run.ts` happens to always emit
              // agent_end before phase_end today, so this never manifested, but
              // hardcoding "running" here would silently clobber a terminal
              // status back to non-terminal for any future caller (e.g. M-076's
              // generic interpreter) that orders events differently. Unlike
              // token/summary columns, `status` has no COALESCE protection in
              // the upsert SQL itself, so it must be supplied correctly here.
              status: existing?.status ?? "running",
              inputTokens: inputTokens ?? null,
              outputTokens: outputTokens ?? null,
              cachedTokens: cachedTokens ?? null,
              outputSummary: outputSummary ?? null,
            });
          }
        }
        void usage; // usage breakdown is preserved verbatim in payload_json; not further decomposed here
        break;
      }
      case "gate_pass":
      case "gate_fail": {
        const checks = (payload["checks"] as GateCheck[] | undefined) ?? [];
        const attempt = (payload["attempt"] as number | undefined) ?? 0;
        this.gateRow({
          adwId: record.adwId,
          phaseId: record.phaseId ?? "",
          gate: record.name ?? "",
          attempt,
          report: { checks },
        });
        break;
      }
      case "handoff":
      case "tool_call":
      case "log":
      case "error":
        // events-table-only types — no side table beyond the events row itself.
        break;
    }
    void eventId;
  }

  private _upsertPhaseFromEvent(
    record: EventRecord,
    status: StepStatus,
    payload: Record<string, unknown>,
  ): void {
    if (!record.phaseId) return;
    const existing = this.db
      .query<{ seq: number }, [string]>("SELECT seq FROM phases WHERE phase_id=?")
      .get(record.phaseId);
    const seq = existing?.seq ?? this.maxPhaseSeq(record.adwId) + 1;
    // `payload["owner"]` is the event-payload wire-format key (still written
    // by callers, e.g. chains/planBuildTest.ts's `payload: {kind, owner,
    // description}`) — read here and threaded into the new `role` field.
    this.phaseUpsert({
      phaseId: record.phaseId,
      adwId: record.adwId,
      seq,
      name: record.name ?? (payload["name"] as string) ?? "",
      kind: (payload["kind"] as StepKind | undefined) ?? "agent",
      role: (payload["owner"] as string | undefined) ?? "",
      description: (payload["description"] as string | undefined) ?? "",
      status,
      attempt: payload["attempt"] as number | undefined,
      error: payload["error"] as string | undefined,
      startedAt: status === "running" ? (record.startedAt ?? nowIso()) : undefined,
      endedAt: status !== "running" ? nowIso() : undefined,
      // M-074: a phase_end event can carry its own outputSummary directly in
      // payload (the natural path for code steps, e.g. planBuildTest.ts's
      // test phase, which never emits an agent_end event) — agent steps'
      // summary is threaded in separately via agent_end (above).
      outputSummary: payload["outputSummary"] as string | undefined,
    });
  }
}
