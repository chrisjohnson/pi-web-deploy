---
name: pi-web-factory
description: Use when the user asks to run, trigger, kick off, or delegate an automated multi-step coding task without naming a specific Workflow shape — e.g. "run the pipeline for X", "have pi-web-factory build this", "plan and build this and review it", "implement this and get it tested" — as a separate, tracked Workflow Run rather than doing the work yourself in this conversation. If the user already knows which shape they want, they can also use /skill:plan-build-review, /skill:bounded-build-review, or /skill:plan-build-test directly — this skill exists for the open-ended "just run something" case.
---

# pi-web-factory: trigger a Workflow Run

pi-web-factory is a deterministic control plane for AI coding agent sessions: it
drives Workflows (fixed sequences of Steps — plan/build/review/test) against a
target project, each Step a bounded, typed turn with its own model, write
allowlist, and acceptance checks. Triggering one here starts a REAL, separate
pi-web session — not something that happens inside this conversation.

Each Workflow also has its own dedicated skill (`/skill:plan-build-review <task>`,
`/skill:bounded-build-review <task>`, `/skill:plan-build-test <task>`) for a user
who already knows exactly which shape they want — SSSF-style shorthand, one
command per Workflow. This skill is the fallback for open-ended requests where the
shape isn't named explicitly.

Don't volunteer this capability or explain it unprompted. Only act when the
user's request clearly matches "run an automated workflow" (see the
`description` above for trigger phrasing). If it's ambiguous whether they want
you to just do the work directly vs. delegate it to a tracked Workflow Run, ask
which they mean — don't guess. The same standard applies to WHICH Workflow to
delegate to (a separate ambiguity from do-it-yourself-vs-delegate): if the list
below doesn't clearly single out one Workflow for the request, ask the user
rather than guessing.

## Available Workflows

This list is not hand-maintained here — it changes as Workflow variants ship.
Before picking one, run, via your own bash tool:

```
bun $HOME/pi-web-factory/cli.ts --list-workflows
```

This prints every registered Workflow name plus a one-sentence "when to pick
it" description, exits 0 immediately, and performs no run — always run it
fresh rather than relying on a remembered list, since a new variant may have
shipped since you last checked.

## How to trigger one

1. **Project path** (`--project`): your own session's cwd IS the target project
   in the expected flow (you're triggering this from inside a session already
   working in that project). Use `pwd` if you need to confirm it. Only ask the
   user for a different path if they explicitly name a different project.
2. **Workflow** (`--workflow`): pick from `--list-workflows`' output based on
   what the user actually asked for. Default to `plan-build-review` if nothing
   about the request suggests otherwise.
3. **Prompt**: the user's own task description, verbatim or lightly cleaned up
   — don't paraphrase away specifics they gave you.
4. Run, via your own bash tool:
   ```
   bun $HOME/pi-web-factory/cli.ts --project <path> --workflow <name> "<prompt>"
   ```
   This mints a fresh pi-web session in its own git worktree and runs the
   Workflow against it — takes real time (multiple agent turns), the command
   won't return until it's done or fails.
5. **Relay the real result back to the user in this conversation** — don't
   just dump raw CLI stdout. The command prints a status line ending in a
   `link=http://...` deep-link that opens the actual resulting session/project/
   workspace in pi-web's browser UI; always include that link. Summarize
   success/failure/blocked-on-human plainly (the CLI's own status word —
   `SUCCESS`, `BLOCKED-ON-HUMAN`, `FAILED`, `GATE-FAILED`, `LOOP-EXHAUSTED`,
   `UNPARSEABLE`, `PERMISSIONS-VIOLATION` — is already precise; use it, don't
   invent your own summary language for it).
6. If the result is `BLOCKED-ON-HUMAN`: tell the user the agent asked a
   question and is waiting — point them at the deep-link to answer it there,
   then mention they (or you, later) can resume with the same command plus
   `--session-id <the printed id>`.

## What NOT to do

- Don't archive, delete, or otherwise modify the resulting pi-web session
  yourself afterward — it's a real, durable session the user may want to
  revisit, not scratch state you created and own the way a test does.
- Don't invent a `--project`/`--workflow` combination `--list-workflows`
  doesn't support — if genuinely nothing fits, say so rather than forcing a
  mismatched Workflow onto the request.
