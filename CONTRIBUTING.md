# Contributing

## Git workflow

Direct pushes to `main` are the established convention for this repo — no PR
requirement, no worktree-branch convention. Push straight to `main`; CI
(`.github/workflows/build.yml`) runs the test suites on every push and, on success,
builds and publishes both images to GHCR.

## What does/doesn't need confirmation before you act

See `AGENTS.md` for the full rules, in particular its "Hard stops" section — most
importantly, **never archive or delete a pi-web session you didn't start yourself in the
current task** without Chris's explicit go-ahead first, even if it looks empty or stale.
A pi-web session can represent hours of real, in-progress work.

## Fleet board

This repo has its own `.fleet/board/` (`backlog/`, `now/`, `blocked/`, `done/`),
following `local-ai-machine`'s own fleet conventions — claim a card before working it,
leave signals as you go, and never move a card to `done/` without a one-line decision-log
entry explaining why.
