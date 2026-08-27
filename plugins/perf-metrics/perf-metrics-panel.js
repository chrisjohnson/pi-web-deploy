// perf-metrics-panel.js
// Custom web element that renders realtime performance charts via uPlot,
// fetching data from the backend proxy (perf-server.js on port 3457).

// Import uPlot as an ES module. The IIFE is modified to export uPlot.
import uPlot from "./uPlot.iife.min.js";

// ---------------------------------------------------------------------------
// Chart configuration
// ---------------------------------------------------------------------------

/**
 * Default chart specifications. Each entry defines one uPlot line chart.
 *
 * @typedef {Object} ChartSpec
 * @property {string} name   - Unique identifier (used for DOM element IDs)
 * @property {string} metric - PromQL metric name (sent as query param)
 * @property {string} label  - Human-readable label displayed on the chart
 * @property {string} color  - Line color (hex)
 */

const defaultCharts = [
  {
    name: "amdgpu_busy",
    metric: "node_amdgpu_busy_percent",
    label: "AMD GPU Busy %",
    color: "#22c55e",
  },
  {
    name: "cpu_freq",
    metric: "avg(node_cpu_frequency_avg_hertz) by (instance)",
    label: "CPU Freq (MHz)",
    color: "#3b82f6",
  },
  {
    name: "amdgpu_vram",
    metric: "node_amdgpu_vram_used_bytes",
    label: "AMD GPU VRAM (MB)",
    color: "#f97316",
  },
  {
    name: "amdgpu_gtt",
    metric: "node_amdgpu_gtt_used_bytes",
    label: "AMD GPU GTT (MB)",
    color: "#ef4444",
  },
];

// ---------------------------------------------------------------------------
// Backend proxy URL — overridden if backendUrl attribute is set
// ---------------------------------------------------------------------------

// Derived from the browser's own current hostname, not a hardcoded value —
// 172.18.0.1 (the docker bridge gateway) is only reachable from inside the
// docker network, never from a real browser on the LAN. Whatever host the
// browser used to reach PI WEB itself (LAN IP, mDNS name, localhost) is
// exactly the host that also has port 3457 published, so this always
// resolves correctly regardless of how PI WEB is accessed.
const DEFAULT_BACKEND = `http://${window.location.hostname}:3457`;

// ---------------------------------------------------------------------------
// Custom Element: <perf-metrics-panel>
// ---------------------------------------------------------------------------

class PerfMetricsPanel extends HTMLElement {
  constructor() {
    super();
    this.backendUrl = DEFAULT_BACKEND;
    this._charts = new Map(); // name -> { u, data }
    this._shadow = null;
  }

  // ---- Lifecycle --------------------------------------------------------

  connectedCallback() {
    // Create shadow DOM
    this._shadow = this.attachShadow({ mode: "open" });

    // Inject uPlot stylesheet inline (cannot import CSS as module script)
    const uplotStyle = document.createElement("style");
    uplotStyle.textContent = `/* uPlot base styles */
.uplot, .uplot *, .uplot *::before, .uplot *::after {box-sizing: border-box;}
.uplot {font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; line-height: 1.5; width: min-content;}
.u-title {text-align: center; font-size: 18px; font-weight: bold;}
.u-wrap {position: relative; user-select: none;}
.u-over, .u-under {position: absolute;}
.u-under {overflow: hidden;}
.uplot canvas {display: block; position: relative; width: 100%; height: 100%;}
.u-axis {position: absolute;}
.u-legend {font-size: 14px; margin: auto; text-align: center;}
.u-inline {display: block;}
.u-inline * {display: inline-block;}
.u-inline tr {margin-right: 16px;}
.u-legend th {font-weight: 600;}
.u-legend th > * {vertical-align: middle; display: inline-block;}
.u-legend .u-marker {width: 1em; height: 1em; margin-right: 4px; background-clip: padding-box !important;}
.u-inline.u-live th::after {content: ":"; vertical-align: middle;}
.u-inline:not(.u-live) .u-value {display: none;}
.u-series > * {padding: 4px;}
.u-series th {cursor: pointer;}
.u-legend .u-off > * {opacity: 0.3;}
.u-select {background: rgba(0,0,0,0.07); position: absolute; pointer-events: none;}
.u-cursor-x, .u-cursor-y {position: absolute; left: 0; top: 0; pointer-events: none; will-change: transform;}
.u-hz .u-cursor-x, .u-vt .u-cursor-y {height: 100%; border-right: 1px dashed #607D8B;}
.u-hz .u-cursor-y, .u-vt .u-cursor-x {width: 100%; border-bottom: 1px dashed #607D8B;}
.u-cursor-pt {position: absolute; top: 0; left: 0; border-radius: 50%; border: 0 solid; pointer-events: none; will-change: transform; background-clip: padding-box !important;}
.u-axis.u-off, .u-select.u-off, .u-cursor-x.u-off, .u-cursor-y.u-off, .u-cursor-pt.u-off {display: none;}`;
    this._shadow.appendChild(uplotStyle);

    // Inject styles for the panel
    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block;
        padding: 8px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 12px;
        color: #1f2937;
      }
      .chart-container {
        margin-bottom: 12px;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        overflow: hidden;
      }
      .chart-title {
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 600;
        background: #f9fafb;
        border-bottom: 1px solid #e5e7eb;
        display: flex;
        justify-content: space-between;
      }
      .chart-title .metric-name {
        color: #6b7280;
        font-weight: 400;
      }
      #status {
        padding: 8px;
        text-align: center;
        color: #6b7280;
        font-size: 12px;
      }
      .loading { color: #6b7280; }
      .ready    { color: #22c55e; }
      .error    { color: #ef4444; }
    `;
    this._shadow.appendChild(style);

    // Build chart containers from defaultCharts
    const root = document.createElement("div");
    root.id = "charts";
    this._shadow.appendChild(root);

    defaultCharts.forEach((spec) => {
      const wrapper = document.createElement("div");
      wrapper.className = "chart-container";
      wrapper.id = `container-${spec.name}`;

      const title = document.createElement("div");
      title.className = "chart-title";
      title.innerHTML = `${spec.label} <span class="metric-name">${spec.metric}</span>`;
      wrapper.appendChild(title);

      const chartDiv = document.createElement("div");
      chartDiv.id = `chart-${spec.name}`;
      chartDiv.style.width = "100%";
      chartDiv.style.height = "120px";
      wrapper.appendChild(chartDiv);

      root.appendChild(wrapper);
    });

    // Status indicator
    const status = document.createElement("div");
    status.id = "status";
    status.className = "loading";
    status.textContent = "loading";
    this._shadow.appendChild(status);

    // Load all charts
    this.loadCharts();

    // Start live polling after initial load
    this.startPolling(5000);
  }

  disconnectedCallback() {
    this.stopPolling();
    this.destroy();
  }

  // ---- Live updates -----------------------------------------------------

  /** Start polling for fresh metric data at the given interval (ms). Default 5000. */
  startPolling(intervalMs = 5000) {
    this.stopPolling();
    this._pollInterval = setInterval(() => this.refreshAll(), intervalMs);
  }

  /** Stop the polling interval. */
  stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  /** Refresh every chart by re-fetching its metric and updating the uPlot data. */
  async refreshAll() {
    for (const spec of defaultCharts) {
      try {
        const data = await this.fetchMetric(spec.metric);
        this.updateChart(spec, data);
      } catch {
        // Swallow — individual chart failures must not break the whole refresh cycle.
      }
    }
  }

  /**
   * Update a single chart with new data.
   * Appends new data points to the existing chart.
   */
  updateChart(spec, data) {
    const entry = this._charts.get(spec.name);
    if (!entry || !entry.u) return;

    const timestamps = data.map((d) => parseFloat(d.value[0]));
    const rawValues = data.map((d) => parseFloat(d.value[1]));

    // Scale values for display (bytes -> MB, Hz -> MHz)
    const values = rawValues.map((v) => {
      if (spec.name === "amdgpu_vram" || spec.name === "amdgpu_gtt") {
        return v / (1024 * 1024); // bytes to MB
      }
      if (spec.name === "cpu_freq") {
        return v / 1e6; // Hz to MHz
      }
      return v;
    });

    // Skip empty data
    if (timestamps.length === 0) return;

    // Append new data point to existing data
    entry.data[0].push(...timestamps);
    entry.data[1].push(...values);

    // Keep only the last 60 data points (5 minutes at 5s intervals)
    // This keeps the x-axis range tight while showing a recent trend line
    if (entry.data[0].length > 60) {
      entry.data[0] = entry.data[0].slice(-60);
      entry.data[1] = entry.data[1].slice(-60);
    }

    // Recompute the x-axis range from the current data so the axis
    // tracks the rolling window of real data instead of staying locked
    // to the initial (possibly sparse) range.
    const curMin = entry.data[0][0];
    const curMax = entry.data[0][entry.data[0].length - 1];
    const curSpan = Math.max(curMax - curMin, 10);
    const curPad = Math.max(curSpan * 0.15, 5);
    entry.u.scales.x.range = (min, max) => [curMin - curPad, curMax + curPad];

    entry.u.setData(entry.data);
    entry.u.redraw(false); // false = don't resize
  }

  // ---- Public API -------------------------------------------------------

  /**
   * Fetch a metric from the backend proxy.
   *
   * @param {string} metric  - PromQL expression (metric name or query)
   * @returns {Promise<Array>}  Array of [timestamp, value] pairs
   */
  async fetchMetric(metric) {
    const url = `${this.backendUrl}/api/query?query=${encodeURIComponent(metric)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const json = await response.json();
    // Prometheus /api/v1/query returns { status, data: { result: [...] } }
    // Each result is { metric: {...}, value: [timestamp, value] }
    // Handle instant vector vs range vector responses
    const result = json.data?.result || [];
    if (result.length === 0) return [];

    // For instant vectors, value is [timestamp, value]
    // For range vectors, value is [timestamp, [[timestamp, value], ...]]
    if (Array.isArray(result[0].value[1]) && Array.isArray(result[0].value[1][0])) {
      // Range vector - take the last sample
      return result.map((r) => {
        const samples = r.value[1];
        const lastSample = samples[samples.length - 1];
        return { metric: r.metric, value: lastSample };
      });
    }

    return result;
  }

  /**
   * Render a single chart using uPlot (creates instance if needed).
   *
   * @param {ChartSpec} spec   - Chart specification
   * @param {Array}      data  - Array of [timestamp, value] pairs from Prometheus
   */
  renderChart(spec, data) {
    const chartDiv = this._shadow.querySelector(`#chart-${spec.name}`);
    if (!chartDiv) return;

    // Transform Prometheus result into uPlot format:
    //   data[0] = [timestamps in seconds] (uPlot expects seconds for time scales)
    //   data[1] = [values]
    const timestamps = data.map((d) => parseFloat(d.value[0]));
    const rawValues = data.map((d) => parseFloat(d.value[1]));

    // Scale values for display (bytes -> MB, Hz -> MHz)
    const values = rawValues.map((v) => {
      if (spec.name === "amdgpu_vram" || spec.name === "amdgpu_gtt") {
        return v / (1024 * 1024); // bytes to MB
      }
      if (spec.name === "cpu_freq") {
        return v / 1e6; // Hz to MHz
      }
      return v;
    });

    // Skip empty data
    if (timestamps.length === 0) return;

    // Only create uPlot instance once
    if (!this._charts.has(spec.name)) {
      // Compute the actual x-axis range from the initial data so we can
      // pin the axis tightly around the real data. uPlot's time scale
      // auto-range adds ~86.4M seconds (~2.7 years) of padding when there
      // is only one data point (because hl=u.ms|0.001, so 86400/hl=86_400_000).
      const tMin = timestamps[0];
      const tMax = timestamps[timestamps.length - 1];
      const tSpan = Math.max(tMax - tMin, 10); // at least 10s so single-point charts aren't degenerate
      const xPad = Math.max(tSpan * 0.15, 5); // ~15% padding, min 5s on each side

      const opts = {
        width: chartDiv.clientWidth || 300,
        height: 120,
        scales: {
          x: {
            time: true,
            // Add right-side padding so the latest point isn't at the edge
            padding: [0, 5],
          },
          y: {
            // Auto-scale Y axis based on data range
            padding: [5, 5],
          },
        },
        axes: [
          {
            // x-axis
            scale: 'x',
            // Format time labels as HH:MM
            labels: (val) => {
              const d = new Date(val);
              return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            },
          },
          {
            // y-axis
            scale: 'y',
          },
        ],
        series: [
          {}, // x-axis (time)
          {
            label: spec.label,
            stroke: spec.color,
            width: 1.5,
            points: false,
          },
        ],
        cursor: {
          sync: {
            target: this,
            keys: true,
          },
        },
        plugins: [],
      };

      try {
        // Create with empty data first, then setData so the range function
        // is applied on top of the real data (bypasses constructor's buggy
        // auto-range for time scales with few points).
        const u = new uPlot(opts, [[], []], chartDiv);
        // Set the range as a function AFTER construction so uPlot's internal
        // wrapping doesn't munge it through its range-rounder Z(). This
        // ensures the x-axis tightly follows the actual data window.
        u.scales.x.range = () => [tMin - xPad, tMax + xPad];
        u.setData([timestamps, values]);
        u.redraw(true); // true = resize + recompute scales
        this._charts.set(spec.name, { u, spec, data: [timestamps, values] });
        this._setStatus(`ready: ${spec.label}`, "ready");
      } catch (err) {
        console.error(`uPlot render error for ${spec.name}:`, err);
        this._setStatus(`error: ${spec.name} — ${err.message}`, "error");
      }
    } else {
      // Update existing chart with new data
      this.updateChart(spec, data);
    }
  }

  /**
   * Destroy all uPlot instances (cleanup).
   */
  destroy() {
    this._charts.forEach((entry) => {
      if (entry.u) {
        entry.u.destroy();
      }
    });
    this._charts.clear();
  }

  /**
   * Load all charts defined in defaultCharts.
   */
  async loadCharts() {
    try {
      for (const spec of defaultCharts) {
        try {
          this._setStatus(`loading: ${spec.label}`, "loading");
          const data = await this.fetchMetric(spec.metric);
          this.renderChart(spec, data);
        } catch (err) {
          this._setStatus(`error: ${spec.metric} — ${err.message}`, "error");
        }
      }
      this._setStatus("ready", "ready");
    } catch (err) {
      this._setStatus(`error: ${err.message}`, "error");
    }
  }

  // ---- Helpers ----------------------------------------------------------

  /**
   * Update the status bar with a message and CSS class.
   */
  _setStatus(message, className) {
    const status = this._shadow.querySelector("#status");
    if (status) {
      status.textContent = message;
      status.className = className;
    }
  }
}

// ---------------------------------------------------------------------------
// Register the custom element
// ---------------------------------------------------------------------------

if (!customElements.get("perf-metrics-panel")) {
  customElements.define("perf-metrics-panel", PerfMetricsPanel);
}
