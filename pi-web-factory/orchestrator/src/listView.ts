/**
 * listView.ts: main page — a responsive, live-updating GRID of condensed
 * run cards (spec section 3), replacing the old plain vertical list.
 * Clicking a card still navigates to a detail page, unchanged in spirit.
 *
 * ── cards are TICKET-level, not run-level ──────────────────────────────────
 * Chris, explicit: multiple attempts at "conceptually the same job" should
 * merge into ONE card, showing the latest attempt by default, with a small
 * pair of subtle arrow icons to page through earlier attempts inline,
 * without leaving the grid. `GET /api/tickets` (server.ts) is this view's
 * data source now, not `/api/runs` directly — each ticket carries its own
 * `latestRun` (the exact same `RunSummary` shape a run card always rendered,
 * steps included) plus `runCount`. Clicking a card navigates to
 * `#/tickets/:ticketId` (DetailView, now a TICKET detail page — see that
 * file's own header comment), not `#/runs/:adwId` directly; the arrow-nav
 * still lets a human flip through every attempt's FULL detail (not a
 * summarized view — Chris's own words: "you're flipping through complete
 * runs and inspecting them") right here on the grid card too, via
 * `TicketCardController`'s own on-demand fetch of `/api/tickets/:ticketId`.
 *
 * ── polling architecture / performance decisions ────────────────────────
 * ONE poll of `/api/tickets` every `POLL_INTERVAL_MS` drives the whole
 * grid's summary data (unchanged pattern from the old `/api/runs` poll,
 * just re-pointed at the ticket-level endpoint) — enough to update status
 * pills, sort order, and dim/tint a card the moment its latest run
 * transitions to success/fail.
 *
 * Each card whose latest run's `status === "running"` additionally gets its
 * own `RunningCardController`, which polls `/api/runs/:adwId` (steps +
 * status) on its own short interval — bounded to exactly the
 * currently-running subset, never one poll per card across the whole grid.
 * A run's mini-Gantt needs each Step's `status`/`startedAt`/`endedAt`, which
 * only changes via the `phases` table (not the `events` stream) — so
 * `/api/runs/:adwId` is the right endpoint here, not
 * `/api/runs/:adwId/events?since=` (that cursor-poll is what DetailView uses
 * for the nested tool-call list, which the condensed grid card deliberately
 * does NOT show — the spec asks for a mini TIMELINE here, not the full
 * nested-event drill-down, which stays on the detail page).
 *
 * ── render diffing strategy ──────────────────────────────────────────────
 * Chosen approach, documented per the spec's explicit ask: on every
 * `/api/tickets` tick, the grid's outer HTML (card shells + `run-grid`
 * container) is rebuilt via one `innerHTML` write — but a completed
 * (success/fail) card's own inner content is a static string produced once
 * and cached, so re-running the outer render is cheap string concatenation,
 * not re-computing Gantt layouts or role lookups for cards that can no
 * longer change. A RUNNING card's inner HTML (including its mini-Gantt) is
 * only recomputed by its OWN `RunningCardController` on ITS OWN poll tick
 * (via a targeted `innerHTML` write scoped to that one card element), never
 * by the outer grid refresh — so a grid of e.g. 30 finished + 3 running
 * cards only ever does real work for those 3 on their own cadence, not 30 on
 * every outer tick. This was judged simpler and plenty fast for the
 * realistic scale here (a handful to a few dozen concurrent/recent tickets)
 * versus a full VDOM-style keyed diff, which would add real complexity for
 * a page that, per the spec, must stay CPU-light — the extra diffing
 * machinery itself has a cost. If real-world card counts grow into the
 * hundreds, a keyed/windowed approach would be the next step (see also the
 * "cap live mini-Gantt cards" fallback the spec explicitly allows, applied
 * below via `MAX_LIVE_MINI_GANTT_CARDS`).
 *
 * Animations (the pulsing glow on running cards) are pure CSS
 * `@keyframes`/class toggles (`style.css`'s `.run-card-running`) — never
 * JS-driven inline-style-per-frame or `requestAnimationFrame`.
 */

import { fetchRunDetail, fetchRuns, fetchTicketDetail, fetchTickets, type RunSummary, type Step, type TicketSummary } from "./api";
import { escapeHtml, formatCost, formatDateTime, formatDuration, formatTokens } from "./format";
import { miniGanttHtml } from "./miniGantt";
import { runTitle } from "./runTitle";
import { sortTickets } from "./sortRuns";
import { attemptNavHtml, moveAttemptIndex, type AttemptNavDirection } from "./attemptNav";

const POLL_INTERVAL_MS = 4000;
/** Running cards poll their own Steps a bit faster than the outer grid summary poll, so the mini-Gantt visibly grows/updates while a run is active. */
const RUNNING_CARD_POLL_INTERVAL_MS = 2500;

/**
 * Explicit, documented performance fallback (spec section 3: "pagination or
 * a similar fallback is acceptable if the full real-time-grid approach
 * doesn't perform well"). Tested locally against ~24 seeded runs (several
 * running) via headless Chrome — CPU stayed low and rendering felt smooth
 * at that scale, so this cap is set generously above what was actually
 * tested, as a circuit breaker against a pathological number of
 * simultaneously-running Workflow Runs rather than a routinely-hit limit.
 * Cards beyond this count still show full summary info (status, timing,
 * tokens) — they just fall back to a static "N Steps, no live preview"
 * notice instead of a live per-card Gantt+poll controller.
 */
const MAX_LIVE_MINI_GANTT_CARDS = 24;

function statusPill(status: string | null): string {
  const cls = status ? `status-${status}` : "status-queued";
  return `<span class="status-pill ${cls}"><span class="status-dot"></span>${escapeHtml(status ?? "unknown")}</span>`;
}

function runCardStatusClass(status: string | null): string {
  if (status === "running") return "run-card-running";
  if (status === "success") return "run-card-success";
  if (status === "fail") return "run-card-fail";
  return "";
}

function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join("/")}`;
}

function runMetaHtml(run: RunSummary, nowMs: number): string {
  return `
    <div class="run-meta">
      <span>started ${formatDateTime(run.startedAt)}</span>
      <span>duration ${formatDuration(run.startedAt, run.endedAt, nowMs)}</span>
      <span>${formatTokens(run.totalTokens)} tokens</span>
      <span>${formatCost(run.totalCost)}</span>
      ${run.projectCwd ? `<span title="${escapeHtml(run.projectCwd)}">${escapeHtml(shortenPath(run.projectCwd))}</span>` : ""}
    </div>
  `;
}

/** Card shell shared by both running and finished cards — everything except the mini-Gantt body, which callers fill in (live for running, static/omitted for finished). `nav` is the attempt-paging arrow control (empty string for a single-attempt ticket — see attemptNav.ts). */
function runCardShellOpenHtml(run: RunSummary, nowMs: number, nav: string): string {
  const title = runTitle(run);
  return `
    <div class="run-card-top">
      <div class="run-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      ${statusPill(run.status)}
    </div>
    ${runMetaHtml(run, nowMs)}
    ${nav}
  `;
}

/**
 * Fully static HTML for a card that can no longer change (success/fail) —
 * computed once, then reused verbatim on every outer grid re-render until
 * the underlying run data itself changes (it won't, once terminal).
 *
 * Includes the mini-Gantt: `run.steps` now arrives pre-batched on every
 * `/api/runs`/`/api/tickets` list response, so ALL cards show their
 * timeline inline, not just running ones.
 */
function finishedCardHtml(run: RunSummary, nowMs: number, nav: string): string {
  const gantt = `<div class="mini-gantt">${miniGanttHtml(run.steps, nowMs)}</div>`;
  return `${runCardShellOpenHtml(run, nowMs, nav)}${gantt}`;
}

function cardOuterHtml(ticketId: string, run: RunSummary, innerHtml: string): string {
  const cls = runCardStatusClass(run.status);
  // Links to the TICKET detail page — not the bare run — carrying
  // the currently-shown attempt as `?attempt=<adwId>` so clicking through
  // opens the SAME attempt the card was displaying, not silently resetting
  // to latest (found while wiring this up: without threading the attempt
  // through, paging to attempt 1/3 on the grid then clicking through would
  // surprisingly land on attempt 3/3's detail instead).
  const href = `#/tickets/${encodeURIComponent(ticketId)}?attempt=${encodeURIComponent(run.adwId)}`;
  return `
    <a class="run-card ${cls}" href="${href}" data-ticket-id="${escapeHtml(ticketId)}">
      ${innerHtml}
    </a>
  `;
}

function filterBarHtml(allProjects: string[], selected: string | null): string {
  const options = [
    `<option value=""${selected ? "" : " selected"}>All projects</option>`,
    ...allProjects.map(
      (p) => `<option value="${escapeHtml(p)}"${p === selected ? " selected" : ""}>${escapeHtml(shortenPath(p))}</option>`,
    ),
  ].join("");
  return `
    <div class="run-filter-bar">
      <label for="project-filter">Project</label>
      <select id="project-filter" class="project-filter-select">${options}</select>
    </div>
  `;
}

/**
 * Owns exactly one currently-`running` card's own poll cycle
 * (`/api/runs/:adwId`, steps + status) and re-renders just that card's DOM
 * node in place — never touches the rest of the grid.
 *
 * IMPORTANT: `.innerHTML =` on the OUTER grid container (`ListView.refresh`,
 * every `POLL_INTERVAL_MS`) always parses and replaces the ENTIRE subtree —
 * browsers never diff/reuse existing nodes on an innerHTML write, even when
 * the resulting markup is textually identical. That means the placeholder
 * `<a data-live-card="1">` element THIS controller was originally bound to
 * gets detached from the document on every single outer tick, including
 * ticks where this exact run is still running and "unchanged" from the
 * controller's perspective. A first version of this code kept the same
 * controller instance alive but never re-pointed `cardEl` at the fresh
 * placeholder the next outer render created — confirmed live (headless
 * Chrome, `--virtual-time-budget` spanning 3 outer ticks): the card
 * rendered correctly once, then went back to a completely empty
 * placeholder forever, while the orphaned controller kept ticking against
 * a detached node no one could see. `rebindCardEl` is `ListView`'s fix:
 * called on EVERY outer tick for every still-live controller (not just
 * newly-created ones), it retargets `cardEl` to the fresh node and
 * immediately re-renders into it so there's no visible blank gap, while
 * leaving the controller's own poll interval running uninterrupted (no
 * wasted extra `/api/runs/:adwId` calls from tearing down and recreating).
 *
 * ── attempt-nav lives here too ────────────────────────────────────────────
 * A running card's ticket may still have earlier, terminal attempts (a
 * manual retry under the same `--ticket-id`, or a future automated one) —
 * the arrow control is wired up the same way a finished card's is (see
 * `TicketCardController`), fetching the ticket's full history on demand
 * only when a human actually clicks an arrow, never on every poll tick.
 */
class RunningCardController {
  private cardEl: HTMLElement;
  private ticketId: string;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private steps: Step[] = [];
  private latestRun: RunSummary;
  private runCount: number;
  /** Cached full attempt history (most recent first) — fetched lazily, only once a human interacts with the arrows. */
  private allRuns: RunSummary[] | null = null;
  private shownIndex = 0;

  constructor(cardEl: HTMLElement, ticketId: string, run: RunSummary, runCount: number) {
    this.cardEl = cardEl;
    this.ticketId = ticketId;
    this.latestRun = run;
    this.runCount = runCount;
    // `run.steps` already arrived batched on the outer /api/tickets poll —
    // seed with it so the first paint shows the real (if slightly stale)
    // Gantt immediately, instead of an empty "no Steps yet" flash while the
    // first per-card `/api/runs/:adwId` fetch is still in flight.
    this.steps = run.steps;
  }

  start(): void {
    this.renderCurrent();
    void this.refresh();
    this.pollHandle = setInterval(() => {
      void this.refresh();
    }, RUNNING_CARD_POLL_INTERVAL_MS);
  }

  stop(): void {
    this.disposed = true;
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  /** Re-points this controller at a freshly-rendered DOM node (see class doc comment) and immediately repaints it — the outer grid re-creates every card element on each of ITS OWN poll ticks, so a still-running controller must be re-bound every time, not just once at creation. */
  rebindCardEl(cardEl: HTMLElement): void {
    this.cardEl = cardEl;
    this.wireAttemptNav();
    this.renderCurrent();
  }

  private async refresh(): Promise<void> {
    try {
      const detail = await fetchRunDetail(this.latestRun.adwId);
      if (this.disposed) return;
      this.latestRun = detail.run;
      this.steps = detail.steps;
      // If the human is currently viewing the LATEST attempt (index 0,
      // the default), keep the live-updating steps flowing into what's
      // shown. If they've paged to an older attempt, this poll still
      // refreshes `latestRun`/`steps` for when they page back to 0, but
      // the currently-DISPLAYED attempt (an older, terminal one) never
      // changes underneath them mid-inspection.
      if (this.allRuns && this.shownIndex === 0) {
        this.allRuns[0] = { ...detail.run, steps: detail.steps };
      }
    } catch {
      // best-effort — a transient failure just skips this tick, the shell
      // (status pill/meta) still reflects the last-known-good outer grid poll
      return;
    }
    if (this.disposed) return;
    this.renderCurrent();
  }

  private displayedRun(): RunSummary {
    if (this.allRuns) return this.allRuns[this.shownIndex] ?? this.latestRun;
    return this.latestRun;
  }

  private async ensureAllRunsLoaded(): Promise<void> {
    if (this.allRuns) return;
    try {
      const detail = await fetchTicketDetail(this.ticketId);
      this.allRuns = detail.runs;
      this.runCount = detail.runs.length;
    } catch {
      // best-effort — arrows silently no-op if this fails; the card still
      // shows the latest attempt correctly regardless.
    }
  }

  private wireAttemptNav(): void {
    this.cardEl.querySelectorAll<HTMLButtonElement>("[data-attempt-nav-dir]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.onAttemptNavClick(btn.dataset["attemptNavDir"] as AttemptNavDirection);
      });
    });
  }

  private async onAttemptNavClick(direction: AttemptNavDirection): Promise<void> {
    await this.ensureAllRunsLoaded();
    if (this.disposed || !this.allRuns) return;
    this.shownIndex = moveAttemptIndex(this.shownIndex, direction, this.allRuns.length);
    this.renderCurrent();
  }

  private renderCurrent(): void {
    const nowMs = Date.now();
    const displayed = this.displayedRun();
    const isLatest = this.shownIndex === 0;
    const shownSteps = isLatest ? this.steps : displayed.steps;
    const nav = attemptNavHtml(this.ticketId, this.shownIndex, this.runCount);
    const shell = runCardShellOpenHtml(displayed, nowMs, nav);
    const gantt = `<div class="mini-gantt">${miniGanttHtml(shownSteps, nowMs)}</div>`;
    this.cardEl.className = `run-card ${runCardStatusClass(displayed.status)}`;
    this.cardEl.innerHTML = `${shell}${gantt}`;
    this.cardEl.setAttribute("href", `#/tickets/${encodeURIComponent(this.ticketId)}?attempt=${encodeURIComponent(displayed.adwId)}`);
    this.wireAttemptNav();
  }
}

/**
 * Owns one FINISHED (non-running) ticket card's attempt-nav interaction —
 * the finished-card counterpart to `RunningCardController`, but with no
 * polling of its own (a finished ticket's latest attempt can't change) —
 * only fetches `/api/tickets/:ticketId` lazily, on the human's first arrow
 * click, exactly like the running controller does.
 */
class TicketCardController {
  private cardEl: HTMLElement;
  private ticketId: string;
  private latestRun: RunSummary;
  private runCount: number;
  private allRuns: RunSummary[] | null = null;
  private shownIndex = 0;

  constructor(cardEl: HTMLElement, ticketId: string, run: RunSummary, runCount: number) {
    this.cardEl = cardEl;
    this.ticketId = ticketId;
    this.latestRun = run;
    this.runCount = runCount;
  }

  /** Re-binds to a freshly-rendered card element after an outer grid re-render (same reasoning as RunningCardController.rebindCardEl) — only needed for cards a human has already interacted with (has non-default `shownIndex` or a cached `allRuns`); ListView only keeps controllers alive across ticks for tickets it still needs to track, see ListView.refresh. */
  rebindCardEl(cardEl: HTMLElement): void {
    this.cardEl = cardEl;
    this.wireAttemptNav();
    this.render();
  }

  render(): void {
    const nowMs = Date.now();
    const displayed = this.allRuns ? (this.allRuns[this.shownIndex] ?? this.latestRun) : this.latestRun;
    const nav = attemptNavHtml(this.ticketId, this.shownIndex, this.runCount);
    this.cardEl.className = `run-card ${runCardStatusClass(displayed.status)}`;
    this.cardEl.innerHTML = finishedCardHtml(displayed, nowMs, nav);
    this.cardEl.setAttribute("href", `#/tickets/${encodeURIComponent(this.ticketId)}?attempt=${encodeURIComponent(displayed.adwId)}`);
    this.wireAttemptNav();
  }

  private wireAttemptNav(): void {
    this.cardEl.querySelectorAll<HTMLButtonElement>("[data-attempt-nav-dir]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.onAttemptNavClick(btn.dataset["attemptNavDir"] as AttemptNavDirection);
      });
    });
  }

  private async onAttemptNavClick(direction: AttemptNavDirection): Promise<void> {
    if (!this.allRuns) {
      try {
        const detail = await fetchTicketDetail(this.ticketId);
        this.allRuns = detail.runs;
        this.runCount = detail.runs.length;
      } catch {
        return; // best-effort — arrows silently no-op on failure
      }
    }
    this.shownIndex = moveAttemptIndex(this.shownIndex, direction, this.allRuns.length);
    this.render();
  }
}

export class ListView {
  private container: HTMLElement;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** Selected project filter (`projectRoot` match), or `null` for "All projects" — owned by `main.ts`'s hash router, mirrored here so polling refreshes can keep using it without re-parsing the hash every tick. */
  private selectedProject: string | null;
  /** Distinct known `projectRoot` values, derived once from an unfiltered fetch, populates the `<select>`'s options regardless of which project is currently selected. */
  private allProjects: string[] = [];
  /** One controller per currently-running ticket card, keyed by ticketId. */
  private runningControllers: Map<string, RunningCardController> = new Map();
  /** One controller per FINISHED ticket card that has had its attempt-nav interacted with (or simply exists on the current page — see refresh() for the exact lifetime rule), keyed by ticketId. */
  private finishedControllers: Map<string, TicketCardController> = new Map();
  /**
   * Same bug class/fix pattern as `detailView.ts`'s `renderKey()` (see
   * that file's own doc comment for the full reasoning) —
   * `refresh()`'s unconditional `this.container.innerHTML = ...`
   * on the OUTER grid destroys hover state (and any other transient DOM
   * state) on every `POLL_INTERVAL_MS` tick, even when the freshly-polled
   * `/api/tickets` data is byte-identical to what's already rendered, since
   * browsers never diff/reuse nodes on an innerHTML write. `refreshKey()`
   * below is a cheap snapshot of every field the outer render's OWN output
   * actually depends on (ticket identity/order, status, and everything
   * `runCardStatusClass`/the placeholder shells key off) — deliberately
   * EXCLUDING anything `Date.now()`-derived (a running card's ticking
   * duration lives entirely inside its own `RunningCardController`'s
   * independently-polled inner re-render, untouched by this outer skip).
   * `refresh()` returns immediately, touching nothing, when a poll tick's
   * key matches the last one — this is what lets hover state (and any other
   * transient per-card DOM/CSS state) survive across unchanged-data poll
   * cycles instead of being torn down and rebuilt every 4s regardless.
   */
  private lastRefreshKey: string | null = null;

  constructor(container: HTMLElement, initialProject: string | null = null) {
    this.container = container;
    this.selectedProject = initialProject;
  }

  async start(): Promise<void> {
    await this.loadProjectOptions();
    await this.refresh();
    this.pollHandle = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.disposed = true;
    if (this.pollHandle) clearInterval(this.pollHandle);
    for (const controller of this.runningControllers.values()) controller.stop();
    this.runningControllers.clear();
    this.finishedControllers.clear();
  }

  private async loadProjectOptions(): Promise<void> {
    try {
      // Reuses /api/runs (not /api/tickets) purely because it's already the
      // full flat list of every projectCwd ever seen — same distinct-project
      // derivation this view always did, unaffected by the ticket grouping.
      const allRuns = await fetchRuns();
      const distinct = new Set<string>();
      for (const r of allRuns) {
        // projectRoot (worktree-suffix-stripped), NOT projectCwd — every
        // run's projectCwd is its own unique worktree path (M-071), so
        // grouping by it would put every single run in its own "project".
        if (r.projectRoot) distinct.add(r.projectRoot);
      }
      this.allProjects = [...distinct].sort();
    } catch {
      // best-effort — if this fails, the filter bar just shows "All projects"
      // only; the main refresh() below will surface any real fetch problem.
      this.allProjects = [];
    }
  }

  /**
   * See the `lastRefreshKey` field doc comment above for the full rationale.
   * Deliberately mirrors only what the OUTER grid's own render output
   * depends on — a live running card's Steps/duration are NOT included
   * here, since those are entirely owned by that card's own
   * `RunningCardController` inner poll loop, which keeps re-rendering on its
   * own cadence regardless of whether this outer key is unchanged.
   */
  private refreshKey(sorted: readonly TicketSummary[], liveEligibleIds: Set<string>): string {
    return JSON.stringify([
      this.selectedProject,
      sorted.map((t) => [
        t.ticketId,
        t.runCount,
        t.latestRun?.adwId,
        t.latestRun?.status,
        t.latestRun?.startedAt,
        t.latestRun?.endedAt,
        liveEligibleIds.has(t.ticketId),
      ]),
    ]);
  }

  private onFilterChange(value: string): void {
    // Write the new selection into the URL hash (not local state) so
    // `main.ts`'s router owns it — reload/bookmark/back-button all keep
    // working, and this view is simply re-constructed with the new value.
    window.location.hash = value ? `#/?project=${encodeURIComponent(value)}` : "#/";
  }

  private async refresh(): Promise<void> {
    let tickets: TicketSummary[];
    try {
      tickets = await fetchTickets(this.selectedProject);
    } catch (error) {
      if (this.disposed) return;
      for (const controller of this.runningControllers.values()) controller.stop();
      this.runningControllers.clear();
      this.finishedControllers.clear();
      // Not gated by `lastRefreshKey` (an error state always redraws) — but
      // reset it here so a SUBSEQUENT successful fetch doesn't wrongly think
      // its data is unchanged from some earlier pre-error render and skip
      // rebuilding out of this error state.
      this.lastRefreshKey = null;
      this.container.innerHTML = `<div class="error-banner">Failed to load runs: ${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</div>`;
      return;
    }
    if (this.disposed) return;

    // Defensive: a ticket with no linked runs at all (server.ts's own
    // doc comment — shouldn't happen in practice) has nothing to render as
    // a card; exclude rather than crash on a null latestRun.
    const withRuns = tickets.filter((t): t is TicketSummary & { latestRun: RunSummary } => t.latestRun !== null);

    const nowMs = Date.now();
    const sorted = sortTickets(withRuns);
    const filterBar = filterBarHtml(this.allProjects, this.selectedProject);

    if (sorted.length === 0) {
      for (const controller of this.runningControllers.values()) controller.stop();
      this.runningControllers.clear();
      this.finishedControllers.clear();
      const emptyHtml = `<div class="empty-state">${
        this.selectedProject ? "No Workflow Runs recorded for this project." : "No Workflow Runs recorded yet."
      }</div>`;
      // Same reasoning as the error branch above — always redraws, but reset
      // the key so the next tick that finds real tickets again doesn't skip.
      this.lastRefreshKey = null;
      this.container.innerHTML = `${filterBar}${emptyHtml}`;
      this.wireFilterSelect();
      return;
    }

    // Which currently-visible tickets are eligible for a live mini-Gantt
    // controller — latest run status running, capped at
    // MAX_LIVE_MINI_GANTT_CARDS (see that const's doc comment for the
    // fallback rationale). The cap applies in current sort order, i.e. the
    // oldest-started running runs (already first per sortTickets) win the
    // live slots.
    const liveEligibleIds = new Set(
      sorted
        .filter((t) => t.latestRun.status === "running")
        .slice(0, MAX_LIVE_MINI_GANTT_CARDS)
        .map((t) => t.ticketId),
    );

    // Skip the whole outer rebuild (and the hover-destroying
    // innerHTML write it implies) when this tick's polled ticket-list data
    // is unchanged from what's already on screen — see `lastRefreshKey`'s
    // own doc comment above for the full mechanism/rationale. Each
    // still-live `RunningCardController`'s OWN inner poll loop is completely
    // untouched by this early return — it keeps re-rendering its one card on
    // its own cadence regardless, so a genuinely-running card still ticks
    // visibly even while the outer grid skips rebuilding around it.
    const key = this.refreshKey(sorted, liveEligibleIds);
    if (this.lastRefreshKey === key) {
      return;
    }
    this.lastRefreshKey = key;

    this.container.innerHTML = `${filterBar}<div class="run-grid">${sorted
      .map((ticket) => {
        if (liveEligibleIds.has(ticket.ticketId)) {
          // Placeholder shell — the RunningCardController wired up below
          // fills this in immediately and owns it from then on.
          return `<a class="run-card run-card-running" href="#/tickets/${encodeURIComponent(ticket.ticketId)}" data-ticket-id="${escapeHtml(ticket.ticketId)}" data-live-card="1"></a>`;
        }
        if (ticket.latestRun.status === "running") {
          // Over the live cap — still a real running card (status pill,
          // pulsing glow) with its Gantt from the last outer-grid poll, it
          // just doesn't get its OWN faster per-card poll cycle on top of
          // that, and no attempt-nav wiring (a card this far down the "too
          // many running" overflow isn't worth the interaction either).
          const nav = ticket.runCount > 1 ? attemptNavHtml(ticket.ticketId, 0, ticket.runCount) : "";
          return cardOuterHtml(
            ticket.ticketId,
            ticket.latestRun,
            `${finishedCardHtml(ticket.latestRun, nowMs, nav)}<div class="mini-gantt-note">not live-updating (too many concurrent runs)</div>`,
          );
        }
        // Finished card placeholder — TicketCardController (below) owns
        // rendering so its attempt-nav clicks work without a full outer
        // grid re-render forcing a reset back to the latest attempt.
        return `<a class="run-card" href="#/tickets/${encodeURIComponent(ticket.ticketId)}" data-ticket-id="${escapeHtml(ticket.ticketId)}" data-finished-card="1"></a>`;
      })
      .join("")}</div>`;

    this.wireFilterSelect();

    // Tear down running controllers for tickets no longer running/visible.
    // For every still-live ticket, REBIND the existing controller (if any)
    // to the fresh DOM node this very innerHTML write just created — never
    // skip an already-existing controller silently, or it keeps updating a
    // node that's no longer attached to the document (see
    // RunningCardController's class doc comment for the real bug this
    // fixes, confirmed live). Only construct a genuinely NEW controller
    // (and start its own independent poll cycle) for a ticket that wasn't
    // already being tracked.
    const stillLive = new Set(liveEligibleIds);
    for (const [ticketId, controller] of this.runningControllers) {
      if (!stillLive.has(ticketId)) {
        controller.stop();
        this.runningControllers.delete(ticketId);
      }
    }
    for (const ticket of sorted) {
      if (!liveEligibleIds.has(ticket.ticketId)) continue;
      const cardEl = this.container.querySelector<HTMLElement>(`[data-ticket-id="${cssEscape(ticket.ticketId)}"][data-live-card="1"]`);
      if (!cardEl) continue;
      const existing = this.runningControllers.get(ticket.ticketId);
      if (existing) {
        existing.rebindCardEl(cardEl);
        continue;
      }
      const controller = new RunningCardController(cardEl, ticket.ticketId, ticket.latestRun, ticket.runCount);
      this.runningControllers.set(ticket.ticketId, controller);
      controller.start();
    }

    // Finished cards — every ticket visible this tick whose latest run
    // isn't running gets a TicketCardController, rebound (or newly
    // constructed) exactly like the running case above, so an
    // already-paged-to-an-older-attempt card doesn't silently reset to
    // latest on the next outer poll tick.
    const stillFinishedIds = new Set(sorted.filter((t) => t.latestRun.status !== "running").map((t) => t.ticketId));
    for (const [ticketId, controller] of this.finishedControllers) {
      void controller;
      if (!stillFinishedIds.has(ticketId)) this.finishedControllers.delete(ticketId);
    }
    for (const ticket of sorted) {
      if (ticket.latestRun.status === "running") continue;
      const cardEl = this.container.querySelector<HTMLElement>(`[data-ticket-id="${cssEscape(ticket.ticketId)}"][data-finished-card="1"]`);
      if (!cardEl) continue;
      const existing = this.finishedControllers.get(ticket.ticketId);
      if (existing) {
        existing.rebindCardEl(cardEl);
        continue;
      }
      const controller = new TicketCardController(cardEl, ticket.ticketId, ticket.latestRun, ticket.runCount);
      this.finishedControllers.set(ticket.ticketId, controller);
      controller.render();
    }
  }

  private wireFilterSelect(): void {
    const select = this.container.querySelector<HTMLSelectElement>("#project-filter");
    select?.addEventListener("change", () => {
      this.onFilterChange(select.value);
    });
  }
}

/** Minimal `CSS.escape` fallback for the `data-ticket-id` attribute selector above — ticket ids are plain identifiers in practice, but this avoids relying on a DOM global that may not exist in every test/runtime context. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
