---
name: bounded-build-review
description: Trigger the pi-web-factory "bounded-build-review" Workflow Run (build agent, then a review/build correction loop, up to 3 rounds, until approved). Use via the explicit /skill:bounded-build-review <task> command, or when the user's natural-language request wants correction rounds baked in — "keep fixing it until it's right", something finicky/security-sensitive, or an explicit ask for a review loop.
---

# /skill:bounded-build-review

Triggers a real, separate pi-web-factory Workflow Run — not something that happens
inside this conversation. Starts a fresh pi-web session in its own git worktree and
runs `build → loop{review, build} until approved` (max 3 rounds) against it.

## What the args are

Whatever text follows `/skill:bounded-build-review` (or, if triggered by natural
language instead of the literal command, the user's own task description) IS the
task prompt — pass it through, don't paraphrase away specifics.

## How to trigger it

1. **Project path**: your own session's `cwd` (confirm with `pwd` if unsure) is the
   target project — this is the expected flow, triggering from inside a session
   already working in that project. Only use a different path if the user
   explicitly names one.
2. Run, via your own bash tool:
   ```
   bun $HOME/pi-web-factory/cli.ts --project <path> --workflow bounded-build-review "<task>"
   ```
   This takes real time (multiple real agent turns, possibly several correction
   rounds) — the command won't return until it's done or fails.
3. **Relay the real result back to the user in this conversation** — don't dump
   raw CLI stdout. The command prints a status line ending in a
   `link=http://...` deep-link that opens the actual session/project/workspace in
   pi-web's browser UI; always include that link. Use the CLI's own status word
   plainly (`SUCCESS`, `BLOCKED-ON-HUMAN`, `FAILED`, `LOOP-EXHAUSTED`,
   `PERMISSIONS-VIOLATION`, `UNPARSEABLE`) rather than inventing your own summary
   language for it.
4. If `LOOP-EXHAUSTED`: the review never approved within 3 rounds — tell the user
   plainly, and mention the deep-link shows exactly what each round's review found
   blocking, so they can judge whether it's close or genuinely off track.
5. If `PERMISSIONS-VIOLATION`: this means a Step tried to write outside its
   allowed paths (already rolled back automatically) — tell the user plainly
   which file(s) and which Step, not just that "something went wrong."
6. If `BLOCKED-ON-HUMAN`: the agent asked a question and is waiting — point the
   user at the deep-link to answer it there, then mention they can resume with
   `--session-id <the printed id>`.

## What NOT to do

Don't archive, delete, or otherwise modify the resulting pi-web session yourself
afterward — it's a real, durable session the user may want to revisit.
