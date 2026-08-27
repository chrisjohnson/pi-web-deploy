// PI WEB Performance Metrics — Backend Proxy Server
// Zero-dependency Node.js HTTP server that forwards Prometheus queries from
// the PI WEB browser plugin to a local Prometheus instance.
//
// Usage:
//   node perf-server.js
//
// Environment variables:
//   PI_PERF_PORT           — listen port (default: 3457)
//   PI_PERF_PROMETHEUS_URL — Prometheus URL (default: http://172.18.0.1:9090)

import http from "http";

const PORT = parseInt(process.env.PI_PERF_PORT, 10) || 3457;
const PROMETHEUS_URL = process.env.PI_PERF_PROMETHEUS_URL || "http://172.18.0.1:9090";

const server = http.createServer(async (req, res) => {
  // Reflect the request's own Origin rather than a single hardcoded value —
  // pi-web is reachable through several real hostnames on this LAN
  // (127.0.0.1, the box's LAN IP, mDNS .local name), and a fixed
  // Access-Control-Allow-Origin would silently pass curl-based validation
  // (no Origin header sent) while still failing in every real browser.
  // No credentials/cookies are used by this proxy, so reflecting any
  // origin carries no meaningful risk on a personal home-network tool.
  const requestOrigin = req.headers.origin;
  if (requestOrigin) res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  // Preflight request
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // Health check endpoint
  if (reqUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", prometheus: PROMETHEUS_URL }));
    return;
  }

  // Prometheus query proxy
  if (reqUrl.pathname === "/api/query") {
    const promUrl = new URL(PROMETHEUS_URL + "/api/v1/query");
    promUrl.searchParams.set("query", reqUrl.searchParams.get("query") || "");

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(promUrl, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeoutId);

      const body = await response.text();
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "error",
        errorType: "proxy_error",
        error: err.message,
      }));
    }
    return;
  }

  // Everything else: 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[perf-server] Proxy running on :${PORT} → ${PROMETHEUS_URL}`);
  console.log(`[perf-server] CORS: reflecting request Origin (no fixed value)`);
});
