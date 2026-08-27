FROM node:22-bookworm-slim AS runner

# Install structural system dependencies and build tools for node-gyp
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    openssh-client \
    curl \
    ca-certificates \
    unzip \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Bun via the official shell script
RUN curl -fsSL https://bun.sh/install | bash

# Ensure Bun is available to root during the build phase
ENV PATH="/root/.bun/bin:${PATH}"

# Modify the existing node user/group (1000:1000) to 'piweb'
RUN usermod -l piweb node && \
    groupmod -n piweb node && \
    usermod -d /home/piweb -m piweb

# Create paths, copy binary, and fix permissions
RUN mkdir -p /home/piweb/.bun/bin && \
    cp /root/.bun/bin/bun /home/piweb/.bun/bin/bun && \
    chown -R piweb:piweb /home/piweb/.bun

RUN mkdir -p /app/.pi-web

# Switch user context for runtime safety
USER piweb
WORKDIR /home/piweb

# Ensure pathing and environments match the new user space
ENV PATH="/home/piweb/.bun/bin:${PATH}"
ENV PI_CODING_AGENT_DIR="/home/piweb/.pi-web"

# Install the official pi-web bundle via Bun
RUN bun install -g @jmfederico/pi-web

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["pi-web"]

USER root

# Install Docker dependencies for host-level tool execution if needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io \
    netcat-openbsd \
    net-tools \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*

# `docker compose` CLI plugin — Debian's `docker.io` package above is the
# engine/CLI only, it does NOT bundle the compose plugin (that's a
# Docker-Inc-maintained package, not in Debian's own repos without adding
# Docker's own apt repo). Installed here as a pinned, checksum-verified
# static binary instead (same curl-based pattern this Dockerfile already
# uses for Bun above), avoiding the extra apt-repo/GPG-key surface area a
# `docker-compose-plugin` .deb install would need. Placed under piweb's own
# `~/.docker/cli-plugins/` (not a system-wide path) since `piweb`, not
# root, is who actually runs `docker`/`docker compose` in this container
# (confirmed live 2026-08-13: `docker`'s own CLI plugin discovery searches
# `$HOME/.docker/cli-plugins/` for the invoking user).
#
# Confirmed missing before this fix — `docker compose version` failed with
# "docker: 'compose' is not a docker command" despite the socket/CLI both
# being usable, which sent one real interactive session down a ~200-tool-
# call dead end trying (and failing) to find another way to redeploy a
# container from inside itself — see
# docs/testing-changes-in-interactive-sessions.md for the full postmortem.
RUN mkdir -p /home/piweb/.docker/cli-plugins \
    && curl -fsSL -o /home/piweb/.docker/cli-plugins/docker-compose \
        https://github.com/docker/compose/releases/download/v5.4.0/docker-compose-linux-x86_64 \
    && echo "837fd1d35bf6a494f41b5b5988269a7be79de337cf1a1a6ff0e45ab51bb4e9be  /home/piweb/.docker/cli-plugins/docker-compose" | sha256sum -c - \
    && chmod +x /home/piweb/.docker/cli-plugins/docker-compose \
    && chown -R piweb:piweb /home/piweb/.docker

# Seed-once model config (litellm provider) - JSON format for pi-web
COPY models.seed.json.tmpl /app/.pi-web/models.seed.json.tmpl
COPY settings.seed.json /app/.pi-web/settings.seed.json
# Seed-once pi-continue extension config: synthesis/handoff originally had
# to be pinned to the fast medium-moe model (qwen3.6-35b, formerly named
# "coder") instead of the slow big-moe default (laguna-118B, formerly named
# "planner"), because big-moe used to blow past pi-continue's default
# synthesisTimeoutMs and fail the handoff. Even on medium-moe, large
# (~65k+ token) handoff contexts can burn 140s+ just on prompt processing
# before generation even starts, so synthesisTimeoutMs is raised to 300s to
# leave headroom.
#
# summarizerModel points at "big-moe-continue-json", NOT the plain "big-moe"
# role: big-moe (laguna) is a thinking model that reliably prepends prose
# before the JSON, which fails pi-continue's strict JSON.parse() regardless
# of timeout. "big-moe-continue-json" is a scoped litellm route (see
# docker/litellm/config.yaml) that forces a full json_schema response_format
# matching pi-continue's artifact shape, so the parseable "content" channel
# comes back as clean, schema-exact JSON every time — empirically verified
# on this backend (2026-08-03) before being adopted here; the timeout
# blow-past that originally ruled out big-moe was solved by this fix
# turning out to also run fast in practice (~19s in testing), not by the
# timeout increase alone. A same-shape "medium-moe-continue-json" route
# also exists (backed by qwen3.6-35b) as a known-good fallback if a future
# big-moe backend swap regresses this. pi-continue reads its config from
# $PI_CODING_AGENT_DIR/extensions/pi-continue.json (NOT the npm:pi-continue
# block in settings.json), so it needs its own seed here.
COPY pi-continue.seed.json /app/.pi-web/pi-continue.seed.json

# pi-continue-companion: our own PI WEB plugin (not user-editable via the UI),
# baked into the image and always-synced (not seed-once) on every container
# start so a stale on-disk copy from a previous image never lingers. See
# docker-entrypoint.sh for the sync step.
COPY plugins/pi-continue-companion /app/.pi-web/plugins-seed/pi-continue-companion

# perf-metrics: our own PI WEB plugin (not user-editable via the UI), same
# always-sync policy as pi-continue-companion above — actively-developed code
# baked into the image, a container restart must always pick up the latest
# build. Paired with pi-web-perf-metrics-proxy (docker/docker-compose.yml)
# which runs the zero-dependency backend proxy (perf-server.js) as its own
# containerized service — no manual background process needed.
COPY plugins/perf-metrics /app/.pi-web/plugins-seed/perf-metrics

# pi-web-factory-prompts: our own pi-coding-agent EXTENSION (a different
# mechanism from the PI WEB plugin above -- see plugins/pi-web-factory-prompts/
# index.ts's header comment for the distinction). Gives pi-web-factory agent
# sessions a true per-role system prompt via the before_agent_start hook
# (M-069). Baked into the image and always-synced (not seed-once) on every
# container start, same reasoning as pi-continue-companion above. Lands at
# $PI_CODING_AGENT_DIR/extensions/pi-web-factory-prompts/index.ts, one of
# pi-coding-agent's own auto-discovered global extension locations
# (~/.pi/agent/extensions/*/index.ts, here rooted at PI_CODING_AGENT_DIR
# instead of the default ~/.pi/agent -- see docker-entrypoint.sh) -- no
# settings.json packages: entry needed, unlike npm:pi-continue.
COPY plugins/pi-web-factory-prompts /app/.pi-web/extensions-seed/pi-web-factory-prompts

# pi-web-factory: our own control-plane CLI (chains/, modules/, cli.ts) that
# drives pi-web sessions over its own REST/WebSocket API to run deterministic,
# multi-step agentic Workflows (M-068). Baked into the image and
# always-synced (not seed-once) on every container start, same reasoning as
# the plugin/extension syncs above — actively-developed code, a container
# restart must always pick up the latest build, never a stale copy from a
# previous image. Landed OUTSIDE $CONFIG_ROOT/.pi-web (it's a standalone
# tool, not pi-web/pi-coding-agent config) at a fixed path a triggering
# Skill's bash tool can reference directly (see M-072) regardless of which
# project a session targets. Dependencies (bun.lock: yaml, zod) installed
# once here at build time with a frozen lockfile, baked into the seeded
# copy, so the always-sync step in docker-entrypoint.sh is a pure file copy
# — no network access needed at container start. factory.db (the trace
# database) deliberately does NOT live under this synced directory — see
# cli.ts's PI_WEB_FACTORY_DB_PATH doc comment and this Dockerfile's ENV
# below; a `rm -rf` on every restart would otherwise destroy real
# accumulated observability history.
COPY pi-web-factory /app/.pi-web/pi-web-factory-seed
RUN cd /app/.pi-web/pi-web-factory-seed && bun install --frozen-lockfile

# pi-web-factory Agent Skills (M-072, M-086): let any pi-web session trigger
# a Workflow Run itself, either via natural language (the general
# `pi-web-factory` skill) or SSSF-style shorthand (`/skill:plan-build-review
# <task>` etc. — one skill per Workflow, pi's native `/skill:<name>` command
# mechanism, confirmed live). Pi's Skills mechanism auto-loads
# $PI_CODING_AGENT_DIR/skills/<name>/SKILL.md into every session's system
# prompt — unlike the CLI code above, this DOES belong under $CONFIG_ROOT
# (exactly the kind of pi-coding-agent config that mechanism expects), but
# still baked into the image and always-synced rather than placed on the
# host's bind-mounted $PI_CODING_AGENT_DIR by hand, so it stays git-tracked
# and never drifts from what's committed. Copies the WHOLE skills/ directory
# (not one hardcoded name) so adding a new skill later is a new subdirectory,
# not a Dockerfile edit.
COPY skills /app/.pi-web/skills-seed

# Points cli.ts's trace db at a path under $PI_CODING_AGENT_DIR (bind-mounted
# from the host, so it survives both container restarts AND image rebuilds),
# rather than its local-dev default (co-located with cli.ts itself, which
# docker-entrypoint.sh's always-sync step `rm -rf`s on every start).
ENV PI_WEB_FACTORY_DB_PATH="/home/piweb/.pi-web/pi-web-factory-data/factory.db"

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# GitHub App credential helper (M-134, same mechanism as dsh-deploy/
# oh-my-pi-deploy, adapted: no gh CLI in this image at all, so only the git
# credential.helper + URL-rewrite piece applies - no background gh-auth
# refresh loop needed here). Own small package.json/node_modules tree,
# since pi-web-factory's own package.json (yaml, zod) is an unrelated
# dependency set. Plain `npm ci` - node:22-bookworm-slim ships npm already.
COPY credential-helper /app/credential-helper
RUN cd /app/credential-helper && npm ci --omit=dev && chmod +x github-app-git-credential-helper.mjs

# Give piweb ownership of the seed directory so it can install packages there
RUN chown -R piweb:piweb /app/.pi-web

USER piweb
