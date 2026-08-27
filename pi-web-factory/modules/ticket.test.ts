/**
 * Unit tests for ticket.ts's mint/attach/lookup logic, in isolation from
 * Tracer — exercises the module's own functions directly against a scratch
 * bun:sqlite db carrying just the `tickets`/`sessions` tables it needs.
 * Tracer.sessionStart's own wiring of this module is covered separately in
 * tracer.test.ts's "Tracer — M-103 ticket wiring" describe block.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { SCHEMA, PRAGMAS } from "./schema.ts";
import { getTicket, mintInternalTicketId, mintOrAttachTicket, runsForTicket, setTicketLatestRun } from "./ticket.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  for (const pragma of PRAGMAS) db.run(pragma);
  db.run(SCHEMA);
});

const deriveTitle = (prompt: string): string => prompt.trim().slice(0, 40) || "(no task description)";

describe("mintInternalTicketId", () => {
  test("mints a ticket_<12 hex chars> id, visually distinct from an adw_<hex> id", () => {
    const id = mintInternalTicketId();
    expect(id).toMatch(/^ticket_[0-9a-f]{12}$/);
  });

  test("mints a fresh id on every call — never reuses one", () => {
    const ids = new Set(Array.from({ length: 20 }, () => mintInternalTicketId()));
    expect(ids.size).toBe(20);
  });
});

describe("mintOrAttachTicket", () => {
  test("with no explicit ticketId, mints a fresh internal ticket row titled from the prompt", () => {
    const ticketId = mintOrAttachTicket(db, { taskPrompt: "fix the login bug", deriveTitleFromPrompt: deriveTitle });
    expect(ticketId).toMatch(/^ticket_[0-9a-f]{12}$/);

    const ticket = getTicket(db, ticketId);
    expect(ticket).toBeDefined();
    expect(ticket?.title).toBe("fix the login bug");
    expect(ticket?.filePath).toBeNull();
    expect(ticket?.latestRunAdwId).toBeNull(); // setTicketLatestRun is a separate step, not this function's job
  });

  test("with an explicit ticketId that doesn't exist yet, creates it (covers an external id like a .fleet board id)", () => {
    const ticketId = mintOrAttachTicket(db, {
      explicitTicketId: "M-103",
      taskPrompt: "workflow retries",
      deriveTitleFromPrompt: deriveTitle,
    });
    expect(ticketId).toBe("M-103");
    expect(getTicket(db, "M-103")?.title).toBe("workflow retries");
  });

  test("with an explicit ticketId that ALREADY exists, attaches without touching the existing title", () => {
    mintOrAttachTicket(db, { explicitTicketId: "M-200", taskPrompt: "original prompt", deriveTitleFromPrompt: deriveTitle });
    const secondCall = mintOrAttachTicket(db, {
      explicitTicketId: "M-200",
      taskPrompt: "a totally different retry prompt",
      deriveTitleFromPrompt: deriveTitle,
    });
    expect(secondCall).toBe("M-200");
    expect(getTicket(db, "M-200")?.title).toBe("original prompt");
  });

  test("two calls with no explicit ticketId mint two DIFFERENT tickets — omitting the id never accidentally reuses one", () => {
    const first = mintOrAttachTicket(db, { taskPrompt: "task A", deriveTitleFromPrompt: deriveTitle });
    const second = mintOrAttachTicket(db, { taskPrompt: "task B", deriveTitleFromPrompt: deriveTitle });
    expect(first).not.toBe(second);
  });
});

describe("getTicket", () => {
  test("returns undefined for an id with no row", () => {
    expect(getTicket(db, "ticket_doesnotexist")).toBeUndefined();
  });
});

describe("setTicketLatestRun / runsForTicket", () => {
  test("setTicketLatestRun updates the denormalized latest_run_adw_id column", () => {
    const ticketId = mintOrAttachTicket(db, { taskPrompt: "task", deriveTitleFromPrompt: deriveTitle });
    setTicketLatestRun(db, ticketId, "adw_run1");
    expect(getTicket(db, ticketId)?.latestRunAdwId).toBe("adw_run1");
    setTicketLatestRun(db, ticketId, "adw_run2");
    expect(getTicket(db, ticketId)?.latestRunAdwId).toBe("adw_run2");
  });

  test("runsForTicket returns every linked session, most recent first", () => {
    const ticketId = mintOrAttachTicket(db, { taskPrompt: "task", deriveTitleFromPrompt: deriveTitle });
    db.run(
      "INSERT INTO sessions (adw_id, status, started_at, title, ticket_id) VALUES (?,?,?,?,?)",
      ["adw_run1", "fail", "2026-01-01T00:00:00.000Z", "attempt 1", ticketId],
    );
    db.run(
      "INSERT INTO sessions (adw_id, status, started_at, title, ticket_id) VALUES (?,?,?,?,?)",
      ["adw_run2", "running", "2026-01-01T01:00:00.000Z", "attempt 2", ticketId],
    );
    // A run against a DIFFERENT ticket must never show up here.
    const otherTicketId = mintOrAttachTicket(db, { taskPrompt: "unrelated task", deriveTitleFromPrompt: deriveTitle });
    db.run(
      "INSERT INTO sessions (adw_id, status, started_at, title, ticket_id) VALUES (?,?,?,?,?)",
      ["adw_other", "success", "2026-01-01T02:00:00.000Z", "unrelated", otherTicketId],
    );

    const runs = runsForTicket(db, ticketId);
    expect(runs.map((r) => r.adwId)).toEqual(["adw_run2", "adw_run1"]);
    expect(runs[0]?.status).toBe("running");
    expect(runs[1]?.status).toBe("fail");
  });

  test("runsForTicket returns an empty array for a ticket with no linked runs", () => {
    const ticketId = mintOrAttachTicket(db, { taskPrompt: "lonely ticket", deriveTitleFromPrompt: deriveTitle });
    expect(runsForTicket(db, ticketId)).toEqual([]);
  });
});
