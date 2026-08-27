---
name: plan-build-test
description: Trigger the pi-web-factory "plan-build-test" Workflow Run (plan agent, then build agent, then the project's own real test command runs as a mechanical gate — no second agent's judgment call). Use via the explicit /skill:plan-build-test <task> command, or when the user wants a code-based acceptance check instead of an agent review — "make sure the tests pass", "TDD this". Requires the target project to have a .pi-web-factory.yaml declaring its test command.
---

# /skill:plan-build-test

Triggers a real, separate pi-web-factory Workflow Run — not something that happens
inside this conversation. Starts a fresh pi-web session in its own git worktree and
runs `plan → build → test` against it, where the last step is a REAL command (e.g.
`go test ./...`, `bun test`), not another agent's judgment.

## What the args are

Whatever text follows `/skill:plan-build-test` (or, if triggered by natural
language instead of the literal command, the user's own task description) IS the
task prompt — pass it through, don't paraphrase away specifics.

## How to trigger it

1. **Project path**: your own session's `cwd` (confirm with `pwd` if unsure) is the
   target project — this is the expected flow, triggering from inside a session
   already working in that project. Only use a different path if the user
   explicitly names one.
2. **Check the project has `.pi-web-factory.yaml`** at its repo root declaring a
   `test` command first — if it doesn't, tell the user plainly rather than
   guessing a command or silently falling back to a different Workflow.
3. Run, via your own bash tool:
   ```
   bun $HOME/pi-web-factory/cli.ts --project <path> --workflow plan-build-test "<task>"
   ```
   This takes real time (multiple real agent turns plus a real test run) — the
   command won't return until it's done or fails.
4. **Relay the real result back to the user in this conversation** — don't dump
   raw CLI stdout. The command prints a status line ending in a
   `link=http://...` deep-link that opens the actual session/project/workspace in
   pi-web's browser UI; always include that link. Use the CLI's own status word
   plainly (`SUCCESS`, `BLOCKED-ON-HUMAN`, `FAILED`, `GATE-FAILED`,
   `PERMISSIONS-VIOLATION`, `UNPARSEABLE`) rather than inventing your own summary
   language for it.
5. If `GATE-FAILED`: the real test command failed — relay which check failed and
   why, from the CLI's own printed reason, not a generic "tests failed."
6. If `PERMISSIONS-VIOLATION`: this means a Step tried to write outside its
   allowed paths (already rolled back automatically) — tell the user plainly
   which file(s) and which Step, not just that "something went wrong."
7. If `BLOCKED-ON-HUMAN`: the agent asked a question and is waiting — point the
   user at the deep-link to answer it there, then mention they can resume with
   `--session-id <the printed id>`.

## What NOT to do

Don't archive, delete, or otherwise modify the resulting pi-web session yourself
afterward — it's a real, durable session the user may want to revisit.
