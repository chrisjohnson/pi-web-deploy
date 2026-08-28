/**
 * main.ts: tiny hash-router entrypoint. The detail route is ticket-level,
 * not run-level. Routes:
 *   `#/`                                -> ListView (all tickets)
 *   `#/tickets/:ticketId`               -> DetailView (a ticket's attempt
 *                                          history, defaulting to latest)
 *   `#/tickets/:ticketId?attempt=<id>`  -> DetailView, opened directly on
 *                                          that specific attempt (e.g. a
 *                                          grid card that was mid-paged when
 *                                          clicked through — see
 *                                          listView.ts's `cardOuterHtml`)
 *
 * A hash router (not the History API) keeps this genuinely dependency-free —
 * no server-side route fallback needed, `Bun.serve`'s single `"/"` HTML
 * route is the only page ever served, and the hash never leaves the client.
 */

import { DetailView } from "./detailView";
import { ListView } from "./listView";

const appEl = document.getElementById("app");
if (!appEl) throw new Error("missing #app root element");

let currentView: { stop(): void } | null = null;

function renderHeader(): string {
  return `
    <header class="top-bar">
      <div>
        <h1>pi-web-factory</h1>
        <div class="subtitle">Workflow Run orchestrator</div>
      </div>
    </header>
  `;
}

function route(): void {
  currentView?.stop();
  currentView = null;

  const hash = window.location.hash || "#/";
  // `#/tickets/:ticketId` (detail) vs `#/` or `#/?project=<cwd>` (list,
  // optionally filtered) — the `?query` part, if present, lives after the
  // hash's own path segment, so split it off before matching the detail
  // route.
  const [hashPath, hashQuery] = hash.split("?");
  const detailMatch = /^#\/tickets\/([^/]+)$/.exec(hashPath ?? hash);

  appEl!.innerHTML = `${renderHeader()}<div id="view-root"></div>`;
  const viewRoot = document.getElementById("view-root");
  if (!viewRoot) return;

  if (detailMatch && detailMatch[1]) {
    const ticketId = decodeURIComponent(detailMatch[1]);
    const initialAdwId = new URLSearchParams(hashQuery ?? "").get("attempt") ?? undefined;
    viewRoot.innerHTML = `<div class="loading">Loading ticket…</div>`;
    const view = new DetailView(viewRoot, ticketId, initialAdwId);
    currentView = view;
    void view.start();
    return;
  }

  const project = new URLSearchParams(hashQuery ?? "").get("project");
  viewRoot.innerHTML = `<div class="loading">Loading runs…</div>`;
  const view = new ListView(viewRoot, project);
  currentView = view;
  void view.start();
}

window.addEventListener("hashchange", route);
route();
