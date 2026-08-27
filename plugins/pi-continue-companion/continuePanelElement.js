import { CONTINUE_ROOT, listContinueHandoffs, readContinueHandoff } from "./continueDiscovery.js";
import { parseContinueHandoff } from "./continueHandoffParser.js";

export const continuePanelTagName = "pi-web-continue-companion-panel";

export function defineContinuePanelElement() {
  if (!customElements.get(continuePanelTagName)) {
    customElements.define(continuePanelTagName, PiWebContinueCompanionPanel);
  }
}

/**
 * Read-only viewer for pi-continue's persisted handoff files: a list of
 * past-session handoffs in this workspace (one row per
 * `.pi/continue/<sessionId>.md` file), and a detail view rendering the
 * selected handoff's parsed sections as distinct card-like groups instead
 * of a flat markdown dump.
 *
 * Structure mirrors the bundled relays plugin's panel element: region-scoped
 * rendering (toolbar / list / viewer are persistent regions, each re-rendered
 * independently) and a scanToken so a stale async response for a previous
 * workspace or selection never overwrites newer state.
 */
class PiWebContinueCompanionPanel extends HTMLElement {
  contextValue;
  listing;
  selectedPath;
  handoffContent;
  scanToken = 0;

  root;
  toolbar;
  list;
  viewer;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      ${panelStyles()}
      <section class="toolbar" hidden></section>
      <nav class="handoff-list" aria-label="Handoffs" hidden></nav>
      <section class="viewer"><div class="empty">Select a workspace.</div></section>
    `;
    this.toolbar = requiredRegion(this.root, ".toolbar");
    this.list = requiredRegion(this.root, "nav.handoff-list");
    this.viewer = requiredRegion(this.root, ".viewer");

    this.toolbar.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-refresh]") : null;
      if (button !== null) this.refresh();
    });

    this.list.addEventListener("click", (event) => {
      const row = event.target instanceof Element ? event.target.closest("button[data-handoff-path]") : null;
      if (row === null) return;
      const path = row.getAttribute("data-handoff-path");
      const context = this.contextValue;
      if (context !== undefined && path !== null) void this.openHandoff(context, path);
    });
  }

  set context(value) {
    const previousKey = this.contextValue === undefined ? undefined : contextKey(this.contextValue);
    const nextKey = value === undefined ? undefined : contextKey(value);
    this.contextValue = value;
    if (previousKey === nextKey) return;
    if (value === undefined) {
      this.resetScanState();
      this.renderAll();
      return;
    }
    void this.scan(value, this.selectedPath);
  }

  async scan(context, preferredPath) {
    const token = ++this.scanToken;
    this.resetScanState();
    this.renderAll();
    const listing = await listContinueHandoffs(context.files);
    if (!this.isCurrentScan(context, token)) return;
    this.listing = listing;
    this.renderToolbar();
    this.renderList();

    const handoff =
      listing.kind === "loaded"
        ? (listing.handoffs.find((candidate) => candidate.path === preferredPath) ?? listing.handoffs[0])
        : undefined;
    if (handoff === undefined) {
      this.renderViewer();
      return;
    }
    await this.loadHandoffContent(context, token, handoff.path);
  }

  async openHandoff(context, path) {
    const token = ++this.scanToken;
    this.selectedPath = path;
    this.updateActiveRow();
    this.viewer.scrollTop = 0;
    await this.loadHandoffContent(context, token, path);
  }

  async loadHandoffContent(context, token, path) {
    this.selectedPath = path;
    this.handoffContent = undefined;
    this.updateActiveRow();
    this.renderViewer();
    const content = await readContinueHandoff(context.files, path);
    if (!this.isCurrentScan(context, token)) return;
    this.handoffContent = content;
    this.renderViewer();
  }

  refresh() {
    const context = this.contextValue;
    if (context === undefined) return;
    void this.scan(context, this.selectedPath);
  }

  resetScanState() {
    this.listing = undefined;
    this.selectedPath = undefined;
    this.handoffContent = undefined;
  }

  isCurrentScan(context, token) {
    return (
      token === this.scanToken && this.contextValue !== undefined && contextKey(this.contextValue) === contextKey(context)
    );
  }

  renderAll() {
    this.renderToolbar();
    this.renderList();
    this.renderViewer();
  }

  renderToolbar() {
    if (this.contextValue === undefined) {
      this.toolbar.hidden = true;
      this.toolbar.replaceChildren();
      return;
    }
    this.toolbar.hidden = false;
    this.toolbar.innerHTML = `
      <strong>Continue Handoffs</strong>
      <span class="toolbar-actions">
        <button class="icon-button" data-refresh aria-label="Refresh" title="Refresh">${refreshIconSvg()}</button>
      </span>
    `;
  }

  renderList() {
    const listing = this.listing;
    if (listing?.kind !== "loaded" || listing.handoffs.length === 0) {
      this.list.hidden = true;
      this.list.replaceChildren();
      return;
    }
    this.list.hidden = false;
    this.list.innerHTML = listing.handoffs
      .map((handoff) => {
        const active = handoff.path === this.selectedPath;
        const mtime = formatMtime(handoff.modifiedAt);
        return `
          <button class="handoff-row${active ? " active" : ""}" data-handoff-path="${escapeAttr(handoff.path)}"${active ? ' aria-current="true"' : ""}>
            <span class="handoff-label" title="${escapeAttr(handoff.name)}">${escapeHtml(handoff.sessionLabel)}</span>
            <span class="handoff-mtime muted">${escapeHtml(mtime)}</span>
          </button>
        `;
      })
      .join("");
  }

  updateActiveRow() {
    for (const row of this.list.querySelectorAll("button[data-handoff-path]")) {
      const active = row.getAttribute("data-handoff-path") === this.selectedPath;
      row.classList.toggle("active", active);
      if (active) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
  }

  renderViewer() {
    if (this.contextValue === undefined) {
      this.viewer.innerHTML = `<div class="empty">Select a workspace.</div>`;
      return;
    }
    this.viewer.innerHTML = this.renderViewerContent();
  }

  renderViewerContent() {
    const listing = this.listing;
    if (listing === undefined) return `<p class="muted">Scanning ${escapeHtml(CONTINUE_ROOT)}…</p>`;
    if (listing.kind === "unavailable") return renderErrorState("Could not scan workspace handoffs.", listing.detail);
    if (listing.kind === "missing" || listing.handoffs.length === 0) return renderEmptyState();
    return this.renderSelectedHandoff();
  }

  renderSelectedHandoff() {
    const path = this.selectedPath;
    const content = this.handoffContent;
    if (path === undefined) return `<p class="muted">Select a handoff.</p>`;
    if (content === undefined) return `<p class="muted">Loading handoff…</p>`;
    if (content.kind === "unavailable") return renderErrorState("Could not read this handoff.", content.detail);
    if (content.kind === "missing") {
      return `<div class="empty-state"><strong>This handoff no longer exists.</strong><p>Click Refresh to rescan ${escapeHtml(CONTINUE_ROOT)}.</p></div>`;
    }
    if (content.binary) {
      return `<div class="empty-state"><strong>Binary file</strong><p>This handoff file is not readable as text.</p></div>`;
    }
    const truncation = content.truncated
      ? `<div class="status info">This handoff is truncated — only the beginning is shown.</div>`
      : "";
    const brief = parseContinueHandoff(content.content);
    return `${truncation}${renderBrief(brief)}`;
  }
}

function renderBrief(brief) {
  const header = `
    <div class="brief-header">
      ${brief.task.length > 0 ? `<div class="brief-field"><span class="brief-field-label">Task</span><p>${escapeHtml(brief.task)}</p></div>` : ""}
      ${brief.doneWhen.length > 0 ? `<div class="brief-field"><span class="brief-field-label">Done When</span><p>${escapeHtml(brief.doneWhen)}</p></div>` : ""}
    </div>
  `;

  const groups = [
    renderGroup("Forbid", "danger", brief.forbid, renderForbidEntry),
    renderGroup("Established", "success", brief.established, renderEstablishedEntry),
    renderGroup("Learned", "accent", brief.learned, renderLearnedEntry),
    renderGroup("Open", "warning", brief.open, renderOpenEntry),
    renderGroup("Next", "accent", brief.next, renderNextEntry),
  ].join("");

  if (
    brief.task.length === 0 &&
    brief.doneWhen.length === 0 &&
    brief.forbid.length === 0 &&
    brief.established.length === 0 &&
    brief.learned.length === 0 &&
    brief.open.length === 0 &&
    brief.next.length === 0
  ) {
    return `<div class="empty-state"><strong>This handoff has no recognizable sections.</strong><p>The file may not be in pi-continue's expected format.</p></div>`;
  }

  return `${header}<div class="brief-groups">${groups}</div>`;
}

function renderGroup(title, tone, entries, renderEntry) {
  if (entries.length === 0) return "";
  return `
    <section class="brief-group tone-${tone}">
      <h4>${escapeHtml(title)} <span class="muted">(${entries.length})</span></h4>
      <ul>
        ${entries.map((entry) => `<li>${renderEntry(entry)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function renderForbidEntry(entry) {
  return `
    <div class="entry-primary">${escapeHtml(entry.rule)}</div>
    ${entry.source.length > 0 ? `<div class="entry-meta muted">source: ${escapeHtml(entry.source)}</div>` : ""}
  `;
}

function renderEstablishedEntry(entry) {
  const meta = [
    entry.evidence.length > 0 ? `evidence: ${escapeHtml(entry.evidence)}` : "",
    entry.basis.length > 0 ? `basis: ${escapeHtml(entry.basis)}` : "",
    entry.reopen.length > 0 ? `reopen: ${escapeHtml(entry.reopen)}` : "",
  ].filter((part) => part.length > 0);
  return `
    <div class="entry-primary">${escapeHtml(entry.claim)}</div>
    ${meta.length > 0 ? `<div class="entry-meta muted">${meta.join(" · ")}</div>` : ""}
  `;
}

function renderLearnedEntry(entry) {
  return `
    <div class="entry-primary">${escapeHtml(entry.lesson)}</div>
    ${entry.source.length > 0 ? `<div class="entry-meta muted">source: ${escapeHtml(entry.source)}</div>` : ""}
  `;
}

function renderOpenEntry(entry) {
  return `
    <div class="entry-primary">${escapeHtml(entry.question)}</div>
    ${entry.verifies.length > 0 ? `<div class="entry-meta muted">verifies: ${escapeHtml(entry.verifies)}</div>` : ""}
  `;
}

function renderNextEntry(entry) {
  return `
    <div class="entry-primary">${escapeHtml(entry.action)}</div>
    ${entry.outcome.length > 0 ? `<div class="entry-meta muted">→ ${escapeHtml(entry.outcome)}</div>` : ""}
  `;
}

function requiredRegion(root, selector) {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`pi-continue-companion panel shell is missing ${selector}`);
  return element;
}

function refreshIconSvg() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 6v5h-5"></path>
      <path d="M4 18v-5h5"></path>
      <path d="M18.2 9A7 7 0 0 0 6.1 6.8L4 9"></path>
      <path d="M5.8 15a7 7 0 0 0 12.1 2.2L20 15"></path>
    </svg>
  `;
}

function contextKey(context) {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}

function formatMtime(modifiedAt) {
  if (modifiedAt === undefined) return "unknown time";
  const time = Date.parse(modifiedAt);
  if (Number.isNaN(time)) return "unknown time";
  try {
    return new Date(time).toLocaleString();
  } catch {
    return "unknown time";
  }
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <strong>No pi-continue handoffs in this workspace.</strong>
      <p>Handoffs are written to <code>${escapeHtml(CONTINUE_ROOT)}/&lt;session&gt;.md</code> by pi-continue's save/compact/resume flow. This workspace has none yet.</p>
    </div>
  `;
}

function renderErrorState(message, detail) {
  return `<div class="status error"><strong>${escapeHtml(message)}</strong><pre>${escapeHtml(detail ?? "")}</pre></div>`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function panelStyles() {
  return `
    <style>
      :host { display: contents; }
      .toolbar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
      .toolbar[hidden], .handoff-list[hidden] { display: none; }
      .toolbar-actions { display: inline-flex; align-items: center; flex-wrap: nowrap; justify-content: flex-end; gap: 8px; min-width: 0; }
      .handoff-list { flex: 0 0 auto; display: flex; flex-wrap: nowrap; gap: 6px; padding: 8px 12px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; }
      .handoff-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; flex: 0 0 auto; white-space: nowrap; font-size: 12px; padding: 4px 10px; }
      .handoff-row.active { border-color: var(--pi-accent-border); background: var(--pi-accent); color: var(--pi-bg); }
      .handoff-row.active .handoff-mtime { color: inherit; opacity: 0.75; }
      .handoff-label { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
      .handoff-mtime { font-size: 11px; }
      .viewer { flex: 1 1 auto; box-sizing: border-box; display: grid; align-content: start; gap: 12px; min-height: 0; overflow: auto; padding: 12px; }
      .viewer > * { box-sizing: border-box; min-width: 0; max-width: 100%; }
      button { border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); font: inherit; cursor: pointer; padding: 6px 10px; }
      button.icon-button { flex: 0 0 auto; display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; }
      button.icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
      code, pre { border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      code { padding: 2px 5px; }
      pre { margin: 0; overflow: auto; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .muted { color: var(--pi-muted); }
      .empty { padding: 16px; color: var(--pi-muted); }
      .empty-state { border: 1px dashed var(--pi-border-muted); border-radius: 8px; color: var(--pi-muted); padding: 12px; }
      .empty-state p { margin: 6px 0 0; }
      .status { border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; }
      .status.info { border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
      .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
      .brief-header { display: grid; gap: 8px; border: 1px solid var(--pi-border-muted); border-radius: 8px; padding: 10px 12px; background: var(--pi-bg-overlay-soft); }
      .brief-field-label { display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--pi-muted); margin-bottom: 2px; }
      .brief-field p { margin: 0; line-height: 1.4; overflow-wrap: anywhere; }
      .brief-groups { display: grid; gap: 10px; }
      .brief-group { border: 1px solid var(--pi-border-muted); border-radius: 8px; padding: 10px 12px; }
      .brief-group h4 { margin: 0 0 8px; font-size: 13px; }
      .brief-group ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
      .brief-group li { border: 1px solid var(--pi-border-muted); border-radius: 6px; padding: 8px 10px; background: var(--pi-bg); }
      .entry-primary { line-height: 1.4; overflow-wrap: anywhere; }
      .entry-meta { font-size: 11px; margin-top: 4px; overflow-wrap: anywhere; }
      .brief-group.tone-danger { border-left: 3px solid var(--pi-danger); }
      .brief-group.tone-success { border-left: 3px solid var(--pi-success); }
      .brief-group.tone-warning { border-left: 3px solid var(--pi-warning); }
      .brief-group.tone-accent { border-left: 3px solid var(--pi-accent); }
    </style>
  `;
}
