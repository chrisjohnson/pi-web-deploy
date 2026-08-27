# pi-web-perf-metrics

Factory dev repo for the PI WEB performance metrics plugin.

A zero-dependency Prometheus proxy backend and a PI WEB workspace panel that
renders live GPU/CPU charts using uPlot.

## Factory Tasks

| # | Task | Deliverable |
|---|------|-------------|
| 1 | Backend proxy server | `perf-server.js` |
| 2 | Plugin structure + uPlot assets | `package.json`, `uPlot.iife.min.js`, `uPlot.min.css`, `assets/icon.svg` |
| 3 | Custom web element | `perf-metrics-panel.js` |
| 4 | Plugin entry point | `pi-web-plugin.js` |
| 5 | Deploy + validate end-to-end | deployment script, validated plugin |

## Deployment

- Backend: `node ~/perf-metrics/perf-server.js` (port 3457)
- Plugin: `~/.pi-web/plugins/perf-metrics/`
- Plugin manifest: `~/.pi-web/plugins/manifest.json`

## Full Specification

See: `/home/piweb/.pi-web/pi-web-performance-plan.md`
