// Discovery helpers for pi-continue's persisted handoff files, modeled on
// the bundled `relays` plugin's relayDiscovery.js. Never rejects: callers
// get a discriminated "kind" result instead of a thrown error, so the panel
// can render missing/unavailable/loaded states without try/catch at every
// call site.

export const CONTINUE_ROOT = ".pi/continue";

// The workspace file API rejects with these messages when a path is absent
// or is not a directory. For the continue root both mean "no handoffs yet",
// not a failure.
const missingListingErrorMessages = new Set(["Path does not exist", "Path is not a directory"]);

/** List this workspace's persisted pi-continue handoffs, most recently modified first. Never rejects. */
export async function listContinueHandoffs(files) {
  let listing;
  try {
    listing = await files.listFiles(CONTINUE_ROOT);
  } catch (error) {
    return fileAccessFailure(error);
  }
  const handoffs = listing.entries
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
    .map((entry) => toHandoffSummary(entry))
    .sort(compareByRecency);
  return { kind: "loaded", handoffs };
}

/** Read one handoff file's raw markdown content. Never rejects. */
export async function readContinueHandoff(files, path) {
  try {
    const file = await files.readFile(path);
    return { kind: "loaded", content: file.content, truncated: file.truncated, binary: file.binary };
  } catch (error) {
    return fileAccessFailure(error);
  }
}

/**
 * Decode a handoff filename's base64url-encoded session id into a display
 * label. Falls back to the raw filename stem if it isn't valid base64url,
 * so an unexpected file in the directory never breaks the list.
 */
export function decodeSessionLabel(filename) {
  const stem = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
  const decoded = decodeBase64Url(stem);
  return decoded ?? stem;
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const binary = atob(padded + padding);
    // Session ids are plain ASCII UUID-like strings; guard against binary
    // garbage decoding to something unprintable.
    if (!/^[\x20-\x7e]+$/.test(binary)) return undefined;
    return binary;
  } catch {
    return undefined;
  }
}

function toHandoffSummary(entry) {
  return {
    name: entry.name,
    path: entry.path,
    modifiedAt: entry.modifiedAt,
    sessionLabel: decodeSessionLabel(entry.name),
  };
}

function compareByRecency(left, right) {
  const leftTime = timestampOf(left.modifiedAt);
  const rightTime = timestampOf(right.modifiedAt);
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return rightTime - leftTime;
  if (leftTime !== undefined) return -1;
  if (rightTime !== undefined) return 1;
  return left.name.localeCompare(right.name);
}

function timestampOf(modifiedAt) {
  if (modifiedAt === undefined) return undefined;
  const time = Date.parse(modifiedAt);
  return Number.isNaN(time) ? undefined : time;
}

function fileAccessFailure(error) {
  if (error instanceof Error && missingListingErrorMessages.has(error.message)) return { kind: "missing" };
  return { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) };
}
