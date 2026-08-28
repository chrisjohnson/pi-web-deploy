# AGENTS.md — pi-web-deploy

## What this repo is

Builds and publishes the container images for `pi-web` (a browser-based coding-agent UI)
with this repo's own `pi-web-factory` multi-agent workflow orchestrator baked in, plus a
separate `pi-web-session-watcher` image. See `README.md` for the full layout and what
each piece actually does. This repo is vendored into `local-ai-machine` as a read-only
Nix flake input — see that repo's own `AGENTS.md` "Component deploy mechanism" section
for how the pin gets bumped.

## Deploy mechanism

Two images, published by this repo's own CI (`.github/workflows/build.yml`) to GHCR on
every push:

- `ghcr.io/chrisjohnson/pi-web-deploy` — the main image (root `Dockerfile`), used by both
  the `jmfederico-pi-web` and `pi-web-factory-orchestrator` services in
  `docker-compose.yml` (same image, two independently-restartable processes).
- `ghcr.io/chrisjohnson/pi-web-deploy-session-watcher` — the watcher image
  (`session-watcher/Dockerfile`).

`docker-compose.yml` at this repo's root owns the service structure (image, volumes,
environment keys); `local-ai-machine`'s own `docker/docker-compose.yml` supplies
machine-specific values via its own `.env`, and pulls this file in via an `include:` that
points at a stable symlink `local-ai-machine`'s `configuration.nix` activation script
maintains — always resolving to whatever Nix store path is currently pinned by that
repo's `flake.nix` `pi-web-deploy` input. Nix's role here is purely vendoring the compose
YAML text; the container images themselves are ordinary OCI pulls from GHCR, independent
of the Nix pin. Bumping the pin is `deploy.sh --update-input pi-web-deploy` in
`local-ai-machine`, then a normal deploy switch. The image tag is controlled separately
via `PI_WEB_DEPLOY_TAG` in `local-ai-machine`'s `docker/.env` (empty defaults to
`:latest`).

`PI_WEB_FACTORY_STEP_TIMEOUT_MS` must stay in sync between the `jmfederico-pi-web` and
`pi-web-factory-orchestrator` services — see `docker-compose.yml`'s comment on that
variable for the 2026-08-13 incident where the two drifted and a reconciliation sweep
force-failed a genuinely in-progress review step. `PI_WEB_WATCHER_*` variables configure
the session-watcher (base URL, session IDs to watch, cwd, poll interval, cooldown) — see
`session-watcher/app/config.py` for defaults and the "how to add a session to watch"
procedure.

## Credentials

`dsh`, `oh-my-pi`, and `pi-web` (the three agent-tool wrappers across this repo's sibling
split repos) all share **one** GitHub App installation for their own git write operations
— i.e. PRs/pushes performed *by the tool itself* while it's running (for this repo,
concretely: `pi-web-factory`'s `modules/worktree.ts` pushing/PR-ing code an agent session
wrote). Configured via `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` (not secrets — real
values live on `local-ai-machine`'s M-131 board card) plus a private key file at
`GITHUB_APP_PRIVATE_KEY_HOST_PATH` (`/home/chris/.secrets/github-app-agent-key.pem` on the
box, mounted read-only into the container, never committed anywhere). Permissions:
Contents/PRs/Actions/Workflows/Pages read-write, Metadata read-only (mandatory baseline).

This repo's own `credential-helper/` (`github-app-token.mjs`, wrapped by
`github-app-git-credential-helper.mjs`) mints a fresh installation access token per
invocation — never cached to disk, valid ~1h per GitHub's own non-configurable
installation-token lifetime (verified by reading the source: `mintInstallationToken()`
calls `createAppAuth` fresh every call). `docker-entrypoint.sh` wires it up as git's
`credential.helper` and adds `insteadOf` rewrites so SSH-style `git@github.com:` /
`ssh://git@github.com/` remotes resolve through it too, since the helper only applies to
HTTPS remotes. Unlike `dsh-deploy`/`oh-my-pi-deploy`, this image has no `gh` CLI at all —
only the git credential-helper piece applies here, no background `gh`-auth refresh loop.

**This App credential is separate from whatever credential a human/agent session pushing
changes to this repo's own source uses** — that's just normal `gh auth` / git push from
wherever the session happens to be working, unrelated to the mechanism above.

## Git workflow

**Direct pushes to `main` are explicitly authorized in this repo** — no PR workflow, no
worktree-branch requirement, same as `local-ai-machine` itself. CI
(`.github/workflows/build.yml`) runs the test suites and, on success, builds and pushes
both images on every push to any branch (tagged `latest` only on the default branch).

This repo also carries its own `.fleet/board/` — same claim/signal/decision-log
discipline as `local-ai-machine`'s fleet conventions (see the fleet AGENTS.md binding for
the full rules).

## If the standard deploy/CI path itself is broken, or is repeatedly getting in the way

Sidestepping it is a legitimate thing to do — but flag it and confirm with Chris first
rather than silently improvising a different mechanism, same as `local-ai-machine`'s own
rule.

## Hard stops — explicit human confirmation, no exceptions

**Archiving or deleting any pi-web session** (either running pi-web instance, either via
its API or its UI) **that wasn't created by the current agent, in the current task,
purely for disposable scratch/test purposes.** A pi-web session can hold hours of real,
in-progress work — unlike a model swap, this is not cheaply reversible. Confirmed safe by
construction, no confirmation needed each time: a session the agent itself started via
`POST /sessions` in the same task, at a `cwd` the agent itself created solely for that
test (e.g. a scratch dir under a project-specific prefix it minted), archived+deleted
before the task ends. Everything else — including any session at a real project's own
working directory, or any session the agent did not itself start in the current task —
needs Chris's explicit go-ahead first, every time, even if it looks empty/stale/scratch-
like. (Confirmed 2026-08-04: no real session was touched building `pi-web-factory` —
every archive/delete call that session was scoped to a scratch cwd the agent minted
itself — but the review that confirmed it should have been the default, not a
retroactive check.)
