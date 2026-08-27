/**
 * detailView.ts: a TICKET's detail page (M-103 — this page conceptually
 * became a ticket detail page, not a bare run detail page; see this
 * module's own header comment below for the full reasoning) — a
 * Gantt-style Step timeline for whichever ATTEMPT (Workflow Run) is
 * currently shown, defaulting to the ticket's latest. Idle/paused gaps
 * between Steps are compressed to a fixed width (gantt.ts's
 * `computeGanttLayout`) — only each Step's own real duration is drawn
 * proportionally.
 *
 * ── M-103: ticket-level, full detail per attempt ──────────────────────────
 * Chris, explicit: multiple attempts at the same job should be
 * inspectable via a small pair of subtle arrow icons, and each attempt
 * shown is FULL detail, never summarized — "you're flipping through
 * complete runs and inspecting them." This view fetches
 * `GET /api/tickets/:ticketId` once (every linked run's COMPLETE summary,
 * steps included — server.ts's `ticketsToApi`/`/api/tickets/:ticketId`
 * route), keeps the whole attempt history in memory, and re-renders the
 * SAME full Gantt-timeline/Step-detail-panel UI a bare run detail page
 * always had, just pointed at whichever attempt's index the human has
 * navigated to (`shownIndex`, 0 = latest). Live polling (the run-status
 * poll + the events cursor-poll) only ever targets the LATEST attempt
 * (`allRuns[0]`) — an older, terminal attempt has nothing left to poll for
 * and its data never changes underneath a human inspecting it.
 *
 * `main.ts`'s router passes `ticketId` plus an optional `initialAdwId`
 * (from `?attempt=<adwId>`, e.g. a grid card that was mid-paged when
 * clicked through) — when present, the view opens showing THAT attempt
 * instead of defaulting to latest, so navigating from the grid never
 * surprises a human by silently resetting their place.
 *
 * While the LATEST attempt's status is "running", polls
 * `/api/runs/:adwId/events?since=` to (a) discover which Step is currently
 * active (an events-derived signal, more precise than just "the phases row
 * with status=running" alone — an agent_start/tool_call/log event arriving
 * for a phase is direct evidence of live activity) and (b) collect
 * `tool_call` events nested (via `parent_id`) under that Step, rendered as
 * a simple timestamped list in the Step's expanded detail panel.
 */

import {
  fetchEventsSince,
  fetchRunDetail,
  fetchTicketDetail,
  fetchWorkflows,
  type EventRecord,
  type RunSummary,
  type WorkflowStepMeta,
} from "./api";
import { attemptNavHtml, moveAttemptIndex, type AttemptNavDirection } from "./attemptNav";
import { computeGanttLayout, MIN_BAR_WIDTH_PX, type GanttLayout } from "./gantt";
import {
  escapeHtml,
  formatClockTime,
  formatCost,
  formatDateTime,
  formatDuration,
  formatMs,
  formatTokens,
} from "./format";
import { roleMiniPalette } from "./roleColor";
import { stepBarStyle } from "./stepBarStyle";
import { runTitle } from "./runTitle";
import type { Step, StepArtifact } from "./api";

const RUN_POLL_INTERVAL_MS = 3000;
const EVENTS_POLL_INTERVAL_MS = 2000;
/** A Step counts as "actively live" if an event touched it within this window — keeps the pulse honest (not stuck highlighted forever off stale data). */
const ACTIVITY_WINDOW_MS = 15000;
/** `.timeline-wrap`'s own CSS padding (style.css) on each side — subtracted from the container's clientWidth to get the real available width for the track itself (M-105 item 11). Kept in lockstep with style.css's `.timeline-wrap { padding: 18px; }` by hand — no DOM measurement of computed style is done here since the wrap element doesn't exist yet on the very first render. */
const TIMELINE_WRAP_PADDING_PX = 18;
/** Conservative fallback width (M-105 item 11) used only when `this.container` genuinely reports 0 (e.g. a detached/not-yet-laid-out container, or a non-browser test environment with no real layout engine) — a run still gets a sane, fits-most-screens scale rather than gantt.ts's own div-by-near-zero MIN_PIXELS_PER_SECOND floor collapsing every bar to its minimum width. */
const FALLBACK_TIMELINE_WIDTH_PX = 640;
/** Floor for the derived track width itself (distinct from gantt.ts's own per-bar MIN_BAR_WIDTH_PX floor) — guards against a genuinely tiny/collapsed container producing a degenerate near-zero layout budget. */
const MIN_TIMELINE_WIDTH_PX = 240;

export class DetailView {
  private container: HTMLElement;
  private ticketId: string;
  private initialAdwId: string | undefined;
  private runPollHandle: ReturnType<typeof setInterval> | null = null;
  private eventsPollHandle: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  /** The ticket's full attempt history, most recent first — index 0 is always latest. Populated by the initial `/api/tickets/:ticketId` fetch; refreshed only for index 0 (the latest attempt), while it's still running (see refreshLatestRun). */
  private allRuns: RunSummary[] = [];
  private ticketTitle: string | null = null;
  private shownIndex = 0;
  private loadError: string | null = null;

  private events: EventRecord[] = [];
  private eventsCursor = 0;
  private lastEventAtByPhase: Map<string, number> = new Map();
  /** M-117: which run's (`adwId`) events have already had their initial fetch kicked off — guards `updateEventsPolling` from re-fetching on every poll/render tick for a run whose events are already loaded (or loading), while still guaranteeing every shown run gets fetched at least once, regardless of status. Reset (implicitly, by pointing at a different adwId) whenever `onAttemptNavClick` clears `this.events`. */
  private eventsFetchedForAdwId: string | null = null;
  /**
   * M-105 items 3/8: which Step's detail is currently shown at the bottom of
   * the page. Pre-M-105 this was `expandedPhaseId`, click-toggled (null =
   * nothing shown). Now driven by HOVER (item 3 — mousing over a Step's bar
   * switches the panel live, no click needed) and defaults to the currently
   * ACTIVE Step on load (item 8), falling back to the last Step in sequence
   * if nothing is active — this view never shows a blank panel once at
   * least one Step exists, matching item 8's "as though the user had
   * already hovered it" framing (a human opening the page mid-run should
   * see exactly what they'd see if they'd immediately hovered the live bar).
   */
  private displayedPhaseId: string | null = null;
  /** True once `displayedPhaseId` has been explicitly set by a real hover — after that point, this view stops auto-re-picking it on every poll tick (item 8 is a LOAD-time default only; once a human has hovered something, their choice sticks until they hover elsewhere, even if a different Step becomes active). */
  private hasHovered = false;

  /** Every loaded Workflow's step title/summary metadata (M-105 items 5/6), fetched once — see api.ts's `fetchWorkflows` / server.ts's `/api/workflows` doc comments. Best-effort: a fetch failure here degrades to showing the raw step keyword instead of a friendly title, never blocks the rest of the page. */
  private workflowStepsByKey: Map<string, WorkflowStepMeta> = new Map();

  /**
   * M-105 item 10 (reopened — the CSS `scrollbar-gutter` fix alone wasn't
   * enough): Chris's real complaint was text SELECTION getting destroyed a
   * few seconds into reading/copying from the page — traced to `render()`
   * doing an unconditional `this.container.innerHTML = ...` full teardown
   * on every poll tick, even when the freshly-fetched data was byte-for-
   * byte identical to what was already on screen (the overwhelmingly common
   * case for a page that polls every 2-3s but a run/its Steps only
   * meaningfully change far less often than that). `lastRenderKey` is a
   * cheap serialized snapshot of every field `render()`'s OUTPUT actually
   * depends on (deliberately excluding `Date.now()`-derived values like the
   * live duration clock / a still-running bar's growing width — those
   * genuinely should keep advancing on a live run, see `render()`'s own
   * "always re-render while genuinely live" branch) — when a poll tick
   * recomputes an identical key, `render()` returns immediately without
   * touching the DOM at all, so an in-progress text selection anywhere in
   * the (untouched) subtree survives completely intact.
   */
  private lastRenderKey: string | null = null;

  /**
   * M-105 item 10 (reopened): the initial-prompt box is genuinely STATIC
   * for a given run/attempt — a run's `request` text never changes once
   * the run has started. Rather than re-emitting `.run-prompt-text` as part
   * of the same `innerHTML` string `render()` rewrites on every tick (which
   * would tear it down and rebuild it even under the `lastRenderKey`
   * skip-check above, since IT'S the mechanism the skip-check bypasses),
   * it's built into its OWN persistent DOM node exactly once per run
   * identity (`promptRenderedForAdwId`, below) and never touched again for
   * that same run — so a human's text selection inside the prompt survives
   * not just an unchanged-data poll tick (covered by `lastRenderKey`) but
   * even a genuinely-live run's OTHER sections re-rendering around it.
   */
  private promptEl: HTMLElement | null = null;
  /** Which run's `adwId` `promptEl`'s current content belongs to — `renderPromptIfNeeded` only touches the DOM when this no longer matches the currently-shown run (a fresh run/attempt, including via attempt-nav paging), never on a same-run re-render. */
  private promptRenderedForAdwId: string | null = null;

  constructor(container: HTMLElement, ticketId: string, initialAdwId?: string) {
    this.container = container;
    this.ticketId = ticketId;
    this.initialAdwId = initialAdwId;
  }

  async start(): Promise<void> {
    await Promise.all([this.loadTicket(), this.loadWorkflowMeta()]);
    this.runPollHandle = setInterval(() => {
      void this.refreshLatestRun();
    }, RUN_POLL_INTERVAL_MS);
  }

  /**
   * M-105 items 5/6: fetches every loaded Workflow's step title/summary
   * once and indexes it by `${adwName}::${stepName}` for O(1) lookup during
   * render (`metaFor`, below). A run's `adwName` can record
   * MULTIPLE workflow names joined by `" + "` (tracer.ts's `sessionStart` —
   * an edge case for a run attached under more than one workflow name), so
   * every name in that joined string gets its own index entries, not just
   * the first.
   */
  private async loadWorkflowMeta(): Promise<void> {
    try {
      const workflows = await fetchWorkflows();
      for (const workflow of workflows) {
        for (const step of workflow.steps) {
          this.workflowStepsByKey.set(`${workflow.name}::${step.name}`, step);
        }
      }
    } catch {
      // best-effort — a fetch failure here just means titles/summaries fall
      // back to the raw step keyword / no summary shown; never blocks the
      // rest of the page (steps/timeline/status are the load-bearing data).
    }
    if (this.disposed) return;
    this.render();
  }

  /** Resolves a Step's workflow-authored metadata by the CURRENT run's `adwName` (which can be a `" + "`-joined list of workflow names — tracer.ts's own `sessionStart` doc comment) plus the Step's own short `name` keyword. Returns `undefined` if never found (a step from an unregistered/removed workflow, or the `/api/workflows` fetch failed) — callers fall back to the raw keyword. */
  private metaFor(step: Step): WorkflowStepMeta | undefined {
    const run = this.currentRun();
    const adwNames = run?.adwName ? run.adwName.split(" + ") : [];
    for (const name of adwNames) {
      const meta = this.workflowStepsByKey.get(`${name}::${step.name}`);
      if (meta) return meta;
    }
    return undefined;
  }

  stop(): void {
    this.disposed = true;
    if (this.runPollHandle) clearInterval(this.runPollHandle);
    if (this.eventsPollHandle) clearInterval(this.eventsPollHandle);
  }

  private async loadTicket(): Promise<void> {
    try {
      const detail = await fetchTicketDetail(this.ticketId);
      this.allRuns = detail.runs;
      this.ticketTitle = detail.title;
      if (this.initialAdwId) {
        const idx = detail.runs.findIndex((r) => r.adwId === this.initialAdwId);
        this.shownIndex = idx >= 0 ? idx : 0;
      }
    } catch (error) {
      if (this.disposed) return;
      this.loadError = error instanceof Error ? error.message : String(error);
      this.render();
      return;
    }
    if (this.disposed) return;
    this.updateEventsPolling();
    this.render();
  }

  /** Re-fetches ONLY the latest attempt (index 0) — called on the run-status poll tick. An older, already-terminal attempt the human has paged to is never re-fetched; there's nothing new to learn about it. */
  private async refreshLatestRun(): Promise<void> {
    const latest = this.allRuns[0];
    if (!latest) return;
    let detail: Awaited<ReturnType<typeof fetchRunDetail>>;
    try {
      detail = await fetchRunDetail(latest.adwId);
    } catch (error) {
      if (this.disposed) return;
      this.loadError = error instanceof Error ? error.message : String(error);
      this.render();
      return;
    }
    if (this.disposed) return;
    this.allRuns[0] = { ...detail.run, steps: detail.steps };
    this.updateEventsPolling();
    this.render();
  }

  private updateEventsPolling(): void {
    // Recurring events polling (the interval) only ever targets the LATEST
    // attempt, and only while it's actually running AND the human is
    // currently looking at it (shownIndex === 0) — an older attempt has no
    // live events left to poll for, and there's no point polling events for
    // the latest attempt while the human isn't even looking at it right now
    // (it'll pick back up the moment they page back to it, via the
    // render()/onAttemptNavClick path re-calling this).
    const latest = this.allRuns[0];
    const isRunning = this.shownIndex === 0 && latest?.status === "running";
    if (isRunning && !this.eventsPollHandle) {
      this.eventsPollHandle = setInterval(() => {
        void this.refreshEvents();
      }, EVENTS_POLL_INTERVAL_MS);
    } else if (!isRunning && this.eventsPollHandle) {
      clearInterval(this.eventsPollHandle);
      this.eventsPollHandle = null;
    }

    // M-117: regardless of the run's status, the CURRENTLY SHOWN run's
    // events must be fetched at least once — the trace db keeps a
    // completed run's events intact (confirmed directly against the live
    // orchestrator, see the M-117 card's decision log), so a terminal
    // run's event history is just as real as a running one's. Bug this
    // fixes: the old code only ever called `refreshEvents()` from inside
    // the `isRunning` branch above, so a run that was ALREADY terminal by
    // the time this view loaded it (or one paged to via attempt-nav) never
    // got its events fetched at all — the panel stayed permanently empty
    // even though the API had full data. `eventsFetchedForAdwId` guards
    // this from re-firing on every poll/render tick once the currently
    // shown run's events are loaded (or a fetch for it is in flight).
    const shown = this.currentRun();
    if (shown && this.eventsFetchedForAdwId !== shown.adwId) {
      this.eventsFetchedForAdwId = shown.adwId;
      void this.refreshEvents(shown.adwId);
    }
  }

  /** Fetches events for `adwId` (defaults to the currently shown run) since `this.eventsCursor` and appends them. Best-effort — a transient failure shouldn't blank the page, and simply leaves `eventsFetchedForAdwId` set so a broken run doesn't get hammered with retries on every poll tick (it'll retry on the next genuine run change, e.g. attempt-nav or a fresh page load). */
  private async refreshEvents(adwId?: string): Promise<void> {
    const targetAdwId = adwId ?? this.currentRun()?.adwId;
    if (!targetAdwId) return;
    let newEvents: EventRecord[];
    try {
      newEvents = await fetchEventsSince(targetAdwId, this.eventsCursor);
    } catch {
      return; // events polling is best-effort — a transient failure shouldn't blank the page
    }
    if (this.disposed || newEvents.length === 0) return;

    for (const evt of newEvents) {
      this.events.push(evt);
      this.eventsCursor = Math.max(this.eventsCursor, evt.rowid);
      if (evt.phaseId) {
        const tsMs = evt.endedAt ? Date.parse(evt.endedAt) : evt.startedAt ? Date.parse(evt.startedAt) : Date.now();
        const prev = this.lastEventAtByPhase.get(evt.phaseId) ?? 0;
        this.lastEventAtByPhase.set(evt.phaseId, Math.max(prev, tsMs));
      }
    }
    this.render();
  }

  private async onAttemptNavClick(direction: AttemptNavDirection): Promise<void> {
    this.shownIndex = moveAttemptIndex(this.shownIndex, direction, this.allRuns.length);
    // Switching away from/to the latest attempt changes whether live events
    // polling should be active — and switching TO an attempt this view has
    // never shown before means its own events list needs a clean slate
    // (events belong to one specific adwId, never shared across attempts).
    this.events = [];
    this.eventsCursor = 0;
    this.lastEventAtByPhase.clear();
    // M-117: this attempt's events haven't been fetched yet under this
    // fresh, cleared-out `this.events` state — clearing this lets
    // `updateEventsPolling` (called below) fetch them regardless of this
    // attempt's status, same as a fresh page load would.
    this.eventsFetchedForAdwId = null;
    // Paging to a different attempt is conceptually a fresh page load for
    // the detail panel too — re-apply item 8's "default to the active Step"
    // logic for whichever attempt is now shown, rather than carrying over a
    // hover choice that pointed at a Step from a DIFFERENT attempt (a stale
    // phaseId from attempt 2/3 has no meaning once looking at attempt 1/3).
    this.displayedPhaseId = null;
    this.hasHovered = false;
    this.updateEventsPolling();
    this.render();
  }

  private currentRun(): RunSummary | undefined {
    return this.allRuns[this.shownIndex];
  }

  private activePhaseIds(nowMs: number): Set<string> {
    const active = new Set<string>();
    const run = this.currentRun();
    if (!run || run.status !== "running" || this.shownIndex !== 0) return active;
    for (const step of run.steps) {
      if (step.status === "running") active.add(step.phaseId);
    }
    for (const [phaseId, lastMs] of this.lastEventAtByPhase) {
      if (nowMs - lastMs <= ACTIVITY_WINDOW_MS) active.add(phaseId);
    }
    return active;
  }

  private toolCallsFor(phaseId: string): EventRecord[] {
    return this.events.filter((e) => e.phaseId === phaseId && e.type === "tool_call");
  }

  private otherEventsFor(phaseId: string): EventRecord[] {
    return this.events.filter((e) => e.phaseId === phaseId && e.type !== "tool_call" && e.type !== "phase_start" && e.type !== "phase_end");
  }

  /**
   * M-105 item 8: picks which Step's detail panel shows by default, before
   * any real hover has happened — an ACTIVE Step (per `activePhaseIds`) if
   * one exists ("as though we moused over it already"), otherwise the LAST
   * Step in sequence (the most recently-relevant one for a finished run —
   * an empty/blank panel on a page that clearly has Step data is worse than
   * showing the final Step's outcome by default). Returns `null` only when
   * there are genuinely no Steps yet.
   */
  private defaultPhaseId(steps: Step[], active: Set<string>): string | null {
    if (active.size > 0) {
      // Prefer the step-sequence order (steps are already seq-ordered by the
      // API) so a run with more than one simultaneously-"active" phase (a
      // brief overlap window) picks the same one deterministically.
      const firstActive = steps.find((s) => active.has(s.phaseId));
      if (firstActive) return firstActive.phaseId;
    }
    return steps.length > 0 ? steps[steps.length - 1]!.phaseId : null;
  }

  /**
   * M-105 item 11: the real available width (px) for the Gantt track itself
   * — `this.container`'s own `clientWidth` (the outer view container, which
   * `.timeline-wrap` fills edge-to-edge — see `main.ts`'s mount) minus
   * `.timeline-wrap`'s own CSS padding on both sides. Read fresh on every
   * render (not cached) so a browser window resize is reflected the next
   * time this run's live poll re-renders the page, without needing a
   * dedicated resize listener.
   */
  private timelineWidthPx(): number {
    const raw = this.container.clientWidth;
    if (!raw) return FALLBACK_TIMELINE_WIDTH_PX;
    return Math.max(MIN_TIMELINE_WIDTH_PX, raw - TIMELINE_WRAP_PADDING_PX * 2);
  }

  /**
   * M-105 item 10 (reopened): a cheap, order-sensitive serialization of
   * every field this render actually depends on for its OUTPUT — everything
   * EXCEPT `Date.now()`-derived values (a running Step's live-growing bar
   * width, the ticking duration text), which are handled by the separate
   * "always re-render while genuinely live" check in `render()` itself
   * rather than folded in here (folding them in would defeat the whole
   * point — the key would never repeat on a live run, and this skip-check
   * would never fire when it's needed most: an already-finished run a human
   * is quietly reading/selecting text from, which still gets polled every
   * `RUN_POLL_INTERVAL_MS` even though nothing about it will ever change
   * again).
   *
   * `timelineWidthPx()` IS included, deliberately — M-105 item 11's
   * width-fit Gantt scale is recomputed from the container's live
   * `clientWidth` on every render; without it in the key, a browser window
   * resize (or even just layout not having fully settled the very first
   * time this ran) would get permanently locked in at whatever width the
   * FIRST render happened to observe, since every later poll tick would
   * see identical run/step data and skip re-rendering — silently freezing
   * the Gantt scale stale forever. Including it costs nothing on a finished
   * run (the container isn't resizing) and correctly forces a fresh
   * `computeGanttLayout` call whenever it does.
   */
  private renderKey(run: RunSummary): string {
    return JSON.stringify([
      this.loadError,
      this.shownIndex,
      this.allRuns.length,
      run.adwId,
      run.status,
      run.startedAt,
      run.endedAt,
      run.totalTokens,
      run.totalCost,
      run.projectCwd,
      this.displayedPhaseId,
      this.hasHovered,
      run.steps.map((s) => [s.phaseId, s.status, s.startedAt, s.endedAt, s.attempt, s.retries, s.inputTokens, s.outputTokens, s.cachedTokens, s.outputSummary, s.error]),
      this.events.length,
      Array.from(this.lastEventAtByPhase.entries()),
      this.timelineWidthPx(),
    ]);
  }

  /**
   * M-105 item 10 (reopened): builds/updates the persistent `.run-prompt`
   * box exactly once per run identity (`adwId`) — never touched again for
   * the SAME run, even across many subsequent `render()` calls (whether
   * skipped entirely by the `renderKey` check above, or genuinely
   * re-running other sections while a run is live). Only a real run change
   * (a fresh ticket load, or paging to a different attempt via
   * `onAttemptNavClick`, both of which reset `promptRenderedForAdwId`
   * implicitly by pointing `run` at a different `adwId`) rebuilds this
   * node's content — so a human's in-progress text selection inside the
   * prompt is preserved not just across unchanged-data poll ticks, but
   * across a genuinely-live run's OTHER sections re-rendering around it.
   */
  private renderPromptIfNeeded(run: RunSummary): HTMLElement | null {
    if (!run.request) {
      this.promptEl = null;
      this.promptRenderedForAdwId = null;
      return null;
    }
    if (this.promptEl && this.promptRenderedForAdwId === run.adwId) {
      return this.promptEl;
    }
    const el = document.createElement("div");
    el.className = "run-prompt";
    el.innerHTML = `<h3>initial prompt</h3><pre class="run-prompt-text">${escapeHtml(run.request)}</pre>`;
    this.promptEl = el;
    this.promptRenderedForAdwId = run.adwId;
    return el;
  }

  private render(): void {
    if (this.loadError) {
      this.container.innerHTML = `<a class="back-link" href="#/">&larr; all runs</a><div class="error-banner">Failed to load ticket ${escapeHtml(this.ticketId)}: ${escapeHtml(this.loadError)}</div>`;
      return;
    }
    const run = this.currentRun();
    if (!run) {
      this.container.innerHTML = `<a class="back-link" href="#/">&larr; all runs</a><div class="loading">Loading ticket…</div>`;
      return;
    }

    const { steps } = run;
    const nowMs = Date.now();
    const active = this.activePhaseIds(nowMs);

    // M-105 item 8: until a human has actually hovered a Step, keep the
    // displayed panel pinned to "whichever Step is active right now" — this
    // re-evaluates on EVERY render (not just the first), so the panel
    // naturally follows a live run from Step to Step exactly as if the
    // human were continuously re-hovering the currently-active bar, until
    // they take manual control by hovering something themselves.
    if (!this.hasHovered) {
      this.displayedPhaseId = this.defaultPhaseId(steps, active);
    } else if (this.displayedPhaseId && !steps.some((s) => s.phaseId === this.displayedPhaseId)) {
      // Defensive: the hovered Step no longer exists in this render's Step
      // list (shouldn't normally happen — Steps don't disappear mid-run —
      // but a paged-to-different-attempt edge case is already handled by
      // onAttemptNavClick resetting hasHovered, so this only guards a
      // genuinely unexpected mismatch from ever rendering a blank panel).
      this.displayedPhaseId = this.defaultPhaseId(steps, active);
    }

    // M-105 item 10 (reopened): a genuinely LIVE run (this attempt, still
    // running) must keep re-rendering every tick regardless of the
    // `renderKey` comparison below — its duration text and any
    // still-running Step's bar width both advance purely off `Date.now()`,
    // not off any field the key captures, so skipping would visibly freeze
    // the clock/bar. For every OTHER case (a finished run, or an older
    // attempt being paged through) — the actual case behind Chris's
    // selection-loss complaint — an identical key means this render would
    // produce byte-identical output to what's already on screen, so the
    // whole DOM rewrite (and the text-selection/scrollbar-flicker it
    // causes) is skipped outright.
    const isLive = run.status === "running" && this.shownIndex === 0;
    const key = this.renderKey(run);
    if (!isLive && this.lastRenderKey === key) {
      return;
    }
    this.lastRenderKey = key;

    const layout = computeGanttLayout(steps, nowMs, this.timelineWidthPx());
    const title = this.ticketTitle ?? runTitle(run);
    const nav = attemptNavHtml(this.ticketId, this.shownIndex, this.allRuns.length);

    this.container.innerHTML = `
      <a class="back-link" href="#/">&larr; all runs</a>
      <div class="run-detail-header">
        <div class="run-card-top run-card-top-${run.status ?? "queued"}">
          <div class="run-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          <span class="status-pill status-${run.status ?? "queued"}"><span class="status-dot"></span>${escapeHtml(run.status ?? "unknown")}</span>
        </div>
        <div class="run-detail-header-body">
          ${nav ? `<div class="run-meta">${nav}</div>` : ""}
          <div class="run-meta">
            <span>ticket ${escapeHtml(this.ticketId)}</span>
            <span>adwId ${escapeHtml(run.adwId)}</span>
            <span>started ${formatDateTime(run.startedAt)}</span>
            <span>${formatTokens(run.totalTokens)} tokens</span>
            <span>${formatCost(run.totalCost)}</span>
            ${run.projectCwd ? `<span title="${escapeHtml(run.projectCwd)}">${escapeHtml(run.projectCwd)}</span>` : ""}
            ${isLive ? `<span class="live-indicator"><span class="status-dot"></span>LIVE — polling for updates</span>` : ""}
          </div>
          ${this.failedRunArtifactsHtml(run)}
          <div class="run-prompt-slot"></div>
        </div>
      </div>

      <div class="timeline-wrap">
        <div class="timeline-heading-row">
          <h2>Steps</h2>
          <div class="timeline-duration">${formatDuration(run.startedAt, run.endedAt, nowMs)}</div>
        </div>
        <div class="timeline-note">Each Step's bar is drawn to scale (fit to the page width — ${layout.pixelsPerSecond.toFixed(1)}px/s for this run, min width ${String(MIN_BAR_WIDTH_PX)}px). Idle/paused time between Steps is compressed to a fixed gap and NOT drawn to scale. Hover a Step to see its details below.</div>
        <div class="timeline-track" style="width:${String(layout.totalWidth)}px">
          ${layout.steps.map((sl) => this.stepRowHtml(sl.step, sl, active)).join("")}
        </div>
        ${this.displayedPhaseId ? this.stepDetailHtml(this.displayedPhaseId, active) : ""}
      </div>
    `;

    // M-105 item 10 (reopened): the prompt box is a PERSISTENT DOM node
    // (built/reused by `renderPromptIfNeeded`, never re-created for the
    // same run) — swapped into the placeholder slot the innerHTML rewrite
    // above just created, rather than being part of that rewritten string
    // itself. The node's identity (and any live text selection inside it)
    // survives this: `Node.replaceWith` MOVES an existing, already-built
    // element into place, it does not clone/recreate it — the very same
    // `<pre>` (and any Range/Selection anchored inside it) that existed
    // before this render call still exists, just reparented.
    const promptSlot = this.container.querySelector<HTMLElement>(".run-prompt-slot");
    const promptEl = this.renderPromptIfNeeded(run);
    if (promptSlot && promptEl) {
      promptSlot.replaceWith(promptEl);
    } else if (promptSlot) {
      promptSlot.remove();
    }

    // M-105 item 3: hovering a Step's bar switches the detail panel below
    // LIVE, no click required — `mouseenter` (not `mouseover`, which would
    // re-fire on every child-element boundary crossing inside the bar; this
    // bar has no children, but `mouseenter` is the correct semantic choice
    // regardless: "entered this element," fires once per hover, not per
    // descendant transition). Keyboard/touch users still get equivalent
    // access via `focus` (the bar is a real interactive element — see its
    // `tabindex`/`title` attributes below), since hover has no touch/
    // keyboard equivalent otherwise.
    this.container.querySelectorAll<HTMLElement>("[data-step-hover]").forEach((el) => {
      const activate = (): void => {
        const phaseId = el.dataset["stepHover"];
        if (!phaseId || phaseId === this.displayedPhaseId) return;
        this.displayedPhaseId = phaseId;
        this.hasHovered = true;
        this.render();
      };
      el.addEventListener("mouseenter", activate);
      el.addEventListener("focus", activate);
    });
    this.container.querySelectorAll<HTMLButtonElement>("[data-attempt-nav-dir]").forEach((btn) => {
      btn.addEventListener("click", () => {
        void this.onAttemptNavClick(btn.dataset["attemptNavDir"] as AttemptNavDirection);
      });
    });
  }

  private stepRowHtml(step: Step, sl: { x: number; width: number }, active: Set<string>): string {
    // `active` (events-derived "truly live right now") takes precedence over
    // the phases row's own `status` for the pulsing-glow treatment — a Step
    // can sit at status=running while actually stalled; `stepBarStyle`'s
    // "running" branch is reserved for genuine live activity here.
    const isActive = active.has(step.phaseId);
    const bar = stepBarStyle(step.role, isActive ? "running" : step.status);
    const label = step.name ?? step.phaseId;
    const isDisplayed = step.phaseId === this.displayedPhaseId;
    return `
      <div class="timeline-row">
        <div class="step-bar${bar.isActive ? " step-active" : ""}${isDisplayed ? " step-displayed" : ""}"
             style="left:${String(sl.x)}px; width:${String(sl.width)}px; ${bar.style}"
             data-step-hover="${escapeHtml(step.phaseId)}"
             tabindex="0"
             title="${escapeHtml(label)} — ${escapeHtml(step.status ?? "unknown")}">
          ${escapeHtml(label)}
        </div>
      </div>
    `;
  }

  private stepDetailHtml(phaseId: string, active: Set<string>): string {
    const step = this.currentRun()?.steps.find((s) => s.phaseId === phaseId);
    if (!step) return "";
    const nowMs = Date.now();
    const toolCalls = this.toolCallsFor(phaseId);
    const others = this.otherEventsFor(phaseId);
    const isActive = active.has(phaseId);
    const meta = this.metaFor(step);

    // M-105 item 5: the workflow-authored human-friendly title (e.g.
    // "Construct a Plan") replaces the OLD redundant "plan (black) / plan
    // (purple pill)" pair this panel used to lead with — falls back to the
    // raw step keyword when a Workflow hasn't authored a title yet (every
    // pre-M-105 YAML, until edited) or the /api/workflows fetch failed, so
    // this never renders blank.
    const displayTitle = meta?.title ?? step.name ?? step.phaseId;

    // M-105 item 3: the panel's own background/border come from this Step's
    // Role mini-palette (`roleMiniPalette` — palette.ts's generated tokens),
    // not a flat page-background box — `surfaceLight` reads as "this
    // panel belongs to this role" without competing with the (still role-
    // colored) Gantt bars above it for visual weight.
    const palette = roleMiniPalette(step.role);
    const panelStyle = palette
      ? `background:${palette.surfaceLight}; border-color:${palette.border};`
      : "";

    // M-105 item 7: `step.attempt` is a trace-db column that defaults to 0
    // (schema.ts) — most notably for `code` steps, which never go through
    // run.ts's agent retry loop at all and so never get a real attempt
    // number written. Display-only 1-index fix here (the safest minimal fix
    // per the card): whatever the stored value is, a human never sees
    // "attempt 0" — "no retries yet" reads as attempt 1, not attempt 0.
    const displayAttempt = step.attempt + 1;

    return `
      <div class="step-detail-panel" style="${panelStyle}">
        ${
          isActive
            ? `<div class="step-detail-live"><span class="live-indicator"><span class="status-dot"></span>active now</span></div>`
            : ""
        }
        <dl class="step-detail-grid">
          <dt>title</dt><dd>${escapeHtml(displayTitle)}</dd>
          ${meta?.summary ? `<dt>summary</dt><dd>${escapeHtml(meta.summary)}</dd>` : ""}
          <dt>kind</dt><dd>${escapeHtml(step.kind ?? "—")}</dd>
          <dt>status</dt><dd>${escapeHtml(step.status ?? "unknown")}</dd>
          <dt>attempt</dt><dd>${String(displayAttempt)}${step.retries ? ` (retries: ${String(step.retries)})` : ""}</dd>
          <dt>duration</dt><dd>${formatDuration(step.startedAt, step.endedAt, nowMs)}</dd>
          <dt>tokens</dt><dd>in ${formatTokens(step.inputTokens)} / out ${formatTokens(step.outputTokens)} / cached ${formatTokens(step.cachedTokens)}</dd>
          ${step.outputSummary ? `<dt>result</dt><dd>${escapeHtml(step.outputSummary)}</dd>` : ""}
          ${step.error ? `<dt>error</dt><dd>${escapeHtml(step.error)}</dd>` : ""}
          ${step.artifact ? `<dt>artifact</dt><dd>${this.stepArtifactHtml(step.artifact)}</dd>` : ""}
        </dl>
        ${
          toolCalls.length > 0 || others.length > 0
            ? `<div><strong style="font-size:12.5px;color:var(--text-dim)">nested events (tool calls, etc. — via events.parent_id)</strong>
                <ul class="tool-call-list">
                  ${[...toolCalls, ...others]
                    .sort((a, b) => a.rowid - b.rowid)
                    .map((e) => this.eventLineHtml(e))
                    .join("")}
                </ul>
              </div>`
            : `<div style="color:var(--text-dim);font-size:12px">${step.status === "running" ? "no tool-call events observed yet" : "no nested events recorded for this Step"}</div>`
        }
      </div>
    `;
  }

  /** M-121: a completed Step's real output (branch/commit/PR), rendered inline in that Step's own detail panel. */
  private stepArtifactHtml(artifact: StepArtifact): string {
    const parts: string[] = [];
    if (artifact.branch) parts.push(`branch <code>${escapeHtml(artifact.branch)}</code>`);
    if (artifact.commitSha) parts.push(`commit <code>${escapeHtml(artifact.commitSha.slice(0, 12))}</code>`);
    if (artifact.prUrl) parts.push(`<a href="${escapeHtml(artifact.prUrl)}" target="_blank" rel="noopener">PR</a>`);
    return parts.length > 0 ? parts.join(" · ") : "(no branch/commit captured)";
  }

  /**
   * M-121: on a FAILED run, a dedicated summary of every Step that DID
   * reach success, with its captured artifact — placed right after the
   * header, visible regardless of which Step panel a human happens to be
   * hovering. This is the direct answer to the card's own motivating
   * incident: a `build` Step's real pushed work must stay visible even
   * though a LATER `review` Step's timeout failed the whole run. Renders
   * nothing for a non-failed run, or a failed run where no Step ever
   * reached success (nothing to show).
   */
  private failedRunArtifactsHtml(run: RunSummary): string {
    if (run.status !== "fail") return "";
    const withArtifacts = run.steps.filter((s) => s.artifact && (s.artifact.branch || s.artifact.commitSha || s.artifact.prUrl));
    if (withArtifacts.length === 0) return "";
    return `
      <div class="run-artifacts-banner">
        <strong>Earlier Steps' real output (preserved despite this run's failure):</strong>
        <ul>
          ${withArtifacts
            .map((s) => `<li><span class="run-artifacts-step">${escapeHtml(s.name ?? s.phaseId)}</span>: ${this.stepArtifactHtml(s.artifact as StepArtifact)}</li>`)
            .join("")}
        </ul>
      </div>
    `;
  }

  private eventLineHtml(e: EventRecord): string {
    const durationTxt = e.startedAt && e.endedAt ? ` (${formatMs(Math.max(0, Date.parse(e.endedAt) - Date.parse(e.startedAt)))})` : "";
    const payloadTxt = e.payload && typeof e.payload === "object" ? JSON.stringify(e.payload) : String(e.payload ?? "");
    return `
      <li>
        <span class="tool-call-time">${formatClockTime(e.startedAt)}</span>
        <span class="tool-call-name">${escapeHtml(e.type ?? "event")}${e.name ? `:${escapeHtml(e.name)}` : ""}</span>
        <span class="tool-call-payload" title="${escapeHtml(payloadTxt)}">${escapeHtml(payloadTxt)}${durationTxt}</span>
      </li>
    `;
  }
}

export type { GanttLayout };
