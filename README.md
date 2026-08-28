# pi-web-deploy

Builds and publishes the container images that run [`pi-web`](https://github.com/jmfederico/pi-web)
(a browser-based coding-agent UI) plus this repo's own multi-agent workflow orchestrator
(`pi-web-factory`) and session-continuation watcher (`pi-web-session-watcher`), for
deployment into [`local-ai-machine`](https://github.com/chrisjohnson/local-ai-machine).

## What's here

### `jmfederico-pi-web` image (`Dockerfile`)

A `node:22-bookworm-slim` image that installs the `@jmfederico/pi-web` bundle globally via
Bun, runs as a non-root `piweb` user, and bakes in everything this repo adds on top of
stock pi-web:

- **`pi-web-factory/`** — a deterministic control-plane CLI (`cli.ts`, `chains/`,
  `modules/`) that drives pi-web sessions over its own REST/WebSocket API to run fixed,
  multi-step agentic Workflows (e.g. `plan → build → review`, `plan → build → test`,
  `build → loop{review, build}`). Each Step is a bounded, typed turn with its own model,
  file-write allowlist, and acceptance checks — see `pi-web-factory/factory.config.yaml`
  for the Role registry and `pi-web-factory/workflows/*.yaml` for the Workflow
  definitions. Synced into the image at a fixed path (`~/pi-web-factory`) on every
  container start so a running container always has the latest build, not a stale copy
  baked in at image-build time.
- **`pi-web-factory/orchestrator/`** — a small read-only web UI over `pi-web-factory`'s
  trace database, served by the `pi-web-factory-orchestrator` service (below) as an
  independently-restartable process, not bolted onto the main pi-web container.
- **`skills/`** — Agent Skills (`SKILL.md` files) that let any pi-web session trigger a
  Workflow Run itself: the general `pi-web-factory` skill (natural-language routing) plus
  one dedicated `/skill:<name>` shorthand per Workflow (`plan-build-review`,
  `bounded-build-review`, `plan-build-test`).
- **`plugins/`** — pi-web UI plugins (`pi-continue-companion`, `perf-metrics`) and a
  pi-coding-agent extension (`pi-web-factory-prompts`, giving each Workflow Role its own
  system prompt via pi-web's `before_agent_start` hook). Plugins and extensions are
  always re-synced from the image into the container's config directory on every
  restart — they're actively-developed code, never left stale.
- **`credential-helper/`** — mints the git credentials pi-web-factory's own worktree
  operations (`modules/worktree.ts`) use to push/PR against real repos (details below).

`docker-entrypoint.sh` seeds pi-web's model config and settings once on first start
(substituting the litellm master key into `models.seed.json.tmpl`), always re-syncs the
plugins/extensions/skills/CLI code described above, and — if `GITHUB_APP_ID` is set —
configures git's `credential.helper` plus an `insteadOf` rewrite so SSH-style
`git@github.com:` remotes resolve through the credential helper instead.

### `pi-web-session-watcher` image (`session-watcher/`)

A small Python/`asyncio` service (`session-watcher/Dockerfile`, `python:3.11-slim`) that
polls a manually-configured list of real, live pi-web interactive chat sessions and
auto-sends a continuation message when it detects pi-web's own internal 5-minute
idle-timeout aborting a request that was still legitimately generating — so a stall
doesn't just sit there until a human notices and types "keep going".

It distinguishes this from a deliberate user Stop-button click by matching on the
session transcript's own shape (`session-watcher/app/detect.py`): a timeout-abort is
`stopReason == "error"` with empty content and an abort/timeout-flavored
`errorMessage`; an explicit stop is `stopReason == "aborted"`. Only the first pattern
ever triggers an auto-continue — firing on an explicit stop would fight the user. Each
configured session is polled, detected, and cooldown-rate-limited fully independently
(`session-watcher/app/watcher.py`), so one session's cooldown never blocks another's.

Watching a session is opt-in, not automatic: session IDs go in
`PI_WEB_WATCHER_SESSION_IDS` (comma-separated). If unset, it falls back to a single
built-in default session ID (`session-watcher/app/config.py`'s `DEFAULT_SESSION_ID`) —
existing single-session deployments keep working with no config change, but nothing new
is watched without an explicit opt-in.

## How it's deployed

CI (`.github/workflows/build.yml`) runs the test suites, then builds and pushes two
images to GHCR on every push to any branch (tagged `latest` only on the default branch):

- `ghcr.io/chrisjohnson/pi-web-deploy` — built from this repo's root `Dockerfile`; used
  by both the `jmfederico-pi-web` and `pi-web-factory-orchestrator` services (same
  image, two independently-restartable processes — see `docker-compose.yml`'s header
  comment).
- `ghcr.io/chrisjohnson/pi-web-deploy-session-watcher` — built from
  `session-watcher/Dockerfile`.

`docker-compose.yml` at this repo's root defines all three services (`jmfederico-pi-web`,
`pi-web-factory-orchestrator`, `pi-web-session-watcher`). This repo owns the service
*structure* (image, volumes, environment keys); `local-ai-machine`'s own
`docker/docker-compose.yml` supplies the machine-specific *values* via its own `.env` and
pulls this file in via:

```yaml
include:
  - path: /etc/local-ai-machine-components/pi-web-deploy/docker-compose.yml
```

That path is a stable symlink that `local-ai-machine`'s `configuration.nix` activation
script (`linkComponentCompose`) maintains, always pointing at whichever Nix store path is
currently pinned by `local-ai-machine`'s `flake.nix` `pi-web-deploy` input. This repo is
vendored as a plain, read-only, non-flake source tree — Nix's only role is vendoring the
compose YAML text; the actual container images are ordinary OCI pulls from GHCR,
unrelated to the Nix pin. Bumping the pin is `deploy.sh --update-input pi-web-deploy` in
`local-ai-machine`, followed by a normal deploy switch. The image tag itself is
controlled independently, via `PI_WEB_DEPLOY_TAG` in `local-ai-machine`'s `docker/.env`
(empty defaults to `:latest`).

Key environment variables `local-ai-machine` supplies (see `docker-compose.yml` for the
full, commented list):

- `PI_WEB_HOME_DIR` — durable, bind-mounted config/session state for pi-web (models,
  settings, extensions, and `pi-web-factory`'s trace database all live under here).
- `PI_WEB_FACTORY_STEP_TIMEOUT_MS` — shared between the `jmfederico-pi-web` and
  `pi-web-factory-orchestrator` services; must stay in sync between the two (see
  `docker-compose.yml`'s comment on this variable for the 2026-08-13 incident where they
  drifted and a reconciliation sweep force-failed an in-progress review step).
- `PI_WEB_WATCHER_*` — session-watcher configuration (base URL, session IDs to watch,
  `cwd`, poll interval, cooldown).

## Credentials

See `AGENTS.md` for how the GitHub App credential this repo's own tools use (via
`credential-helper/`) works, and how it differs from the credential a human/agent session
uses when pushing changes to this repo's *own* source.

## Relationship to `local-ai-machine`

`pi-web-deploy` is one of several repos split out of `local-ai-machine`'s former
monolithic repo (alongside `dsh-deploy`, `oh-my-pi-deploy`, and
`strix-halo-r9700-llm-builds`). `local-ai-machine` still owns the actual box, the
including compose file, and every machine-specific value; this repo owns the pi-web
image build, the `pi-web-factory` workflow orchestrator, and the session-watcher —
independently versioned, tested, and released via its own CI.
