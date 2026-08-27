/** format.ts: small display-formatting helpers shared by the list/detail views. */

export function formatStatus(status: string | null): string {
  return status ?? "unknown";
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDuration(startIso: string | null, endIso: string | null, nowMs: number): string {
  if (!startIso) return "—";
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "—";
  const end = endIso ? Date.parse(endIso) : nowMs;
  const ms = Math.max(0, end - start);
  return formatMs(ms);
}

export function formatMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${String(seconds)}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${String(hours)}h ${String(remMinutes)}m`;
}

export function formatTokens(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toFixed(2)}`;
}

export function formatClockTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
