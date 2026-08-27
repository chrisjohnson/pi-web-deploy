// Parser for pi-continue's persisted handoff markdown
// (<gitProjectRoot>/.pi/continue/<base64url(sessionId)>.md).
//
// pi-continue flattens its internal BriefEnvelope into a fixed markdown
// shape on every handoff (see pi-continue's blocks.ts render* helpers):
//
//   ## Task
//   <free text>
//
//   ## Done When
//   <free text>
//
//   ## Forbid
//   - <rule> — source: <source>
//
//   ## Established
//   - <claim> — evidence: <evidence>; basis: <basis>; reopen: <reopen>
//
//   ## Learned
//   - <lesson> — source: <source>
//
//   ## Open
//   - <question> — verifies: <verifies>
//
//   ## Next
//   - <action> → <outcome>
//
// Sections may be absent entirely (e.g. no Forbid entries this handoff) --
// callers must not throw on partial/empty input. This module never throws;
// on unparseable input it returns the "empty" structured shape.

const SECTION_HEADER_RE = /^##\s+(.+?)\s*$/;

// Bullet lines use an em dash (—) to separate the primary text from a
// trailing "key: value; key: value" tail. Some bullets (Next) instead use a
// right arrow (→) to separate an action from its outcome.
const EM_DASH = "—";
const ARROW = "→";

const SECTION_KEY_BY_HEADER = {
  task: "task",
  "done when": "doneWhen",
  forbid: "forbid",
  established: "established",
  learned: "learned",
  open: "open",
  next: "next",
};

/** Structured shape returned by parseContinueHandoff(). Always fully populated. */
function emptyBrief() {
  return {
    task: "",
    doneWhen: "",
    forbid: [],
    established: [],
    learned: [],
    open: [],
    next: [],
  };
}

/**
 * Parse pi-continue's persisted handoff markdown into a structured brief.
 * Resilient to missing/empty sections and unexpected content: never throws,
 * falls back to empty strings/arrays for anything it cannot confidently
 * parse.
 */
export function parseContinueHandoff(markdown) {
  const brief = emptyBrief();
  if (typeof markdown !== "string" || markdown.length === 0) {
    return brief;
  }

  const lines = markdown.split(/\r\n|\r|\n/);
  let currentKey;
  let buffer = [];

  const flush = () => {
    if (currentKey === undefined) {
      buffer = [];
      return;
    }
    if (currentKey === "task" || currentKey === "doneWhen") {
      brief[currentKey] = buffer.join("\n").trim();
    } else {
      brief[currentKey] = parseBullets(buffer, currentKey);
    }
    buffer = [];
  };

  for (const line of lines) {
    const headerMatch = SECTION_HEADER_RE.exec(line);
    if (headerMatch) {
      flush();
      const headerKey = headerMatch[1].trim().toLowerCase();
      currentKey = SECTION_KEY_BY_HEADER[headerKey];
      continue;
    }
    buffer.push(line);
  }
  flush();

  return brief;
}

function parseBullets(lines, sectionKey) {
  const entries = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);
    if (!bulletMatch) continue;
    const body = bulletMatch[1].trim();
    if (body.length === 0) continue;
    entries.push(parseBulletEntry(body, sectionKey));
  }
  return entries;
}

function parseBulletEntry(body, sectionKey) {
  if (sectionKey === "next") {
    const arrowIndex = body.indexOf(ARROW);
    if (arrowIndex === -1) {
      return { action: body, outcome: "" };
    }
    return {
      action: body.slice(0, arrowIndex).trim(),
      outcome: body.slice(arrowIndex + ARROW.length).trim(),
    };
  }

  const dashIndex = body.indexOf(EM_DASH);
  const primary = (dashIndex === -1 ? body : body.slice(0, dashIndex)).trim();
  const tail = dashIndex === -1 ? "" : body.slice(dashIndex + EM_DASH.length).trim();

  switch (sectionKey) {
    case "forbid": {
      const fields = parseFieldTail(tail, ["source"]);
      return { rule: primary, source: fields.source ?? "" };
    }
    case "established": {
      const fields = parseFieldTail(tail, ["evidence", "basis", "reopen"]);
      return {
        claim: primary,
        evidence: fields.evidence ?? "",
        basis: fields.basis ?? "",
        reopen: fields.reopen ?? "",
      };
    }
    case "learned": {
      const fields = parseFieldTail(tail, ["source"]);
      return { lesson: primary, source: fields.source ?? "" };
    }
    case "open": {
      const fields = parseFieldTail(tail, ["verifies"]);
      return { question: primary, verifies: fields.verifies ?? "" };
    }
    default:
      return { text: primary, tail };
  }
}

/**
 * Parse a "key: value; key: value" tail into an object, given the known
 * field names expected for this section. Splitting on every `;` would wrongly
 * cut off values that legitimately contain semicolons (seen in real handoff
 * data, e.g. an Open entry's `verifies:` text listing several steps); instead
 * this only splits at boundaries that look like `; <knownField>:`, so a
 * semicolon inside a field's own value is left alone. Single-field sections
 * (source/verifies) never split at all -- the whole tail is the value.
 */
function parseFieldTail(tail, knownFields) {
  const fields = {};
  if (tail.length === 0) return fields;

  if (knownFields.length === 1) {
    const [key] = knownFields;
    const colonIndex = tail.indexOf(":");
    if (colonIndex !== -1 && tail.slice(0, colonIndex).trim() === key) {
      fields[key] = tail.slice(colonIndex + 1).trim();
    } else {
      fields[key] = tail.trim();
    }
    return fields;
  }

  const boundaryRe = new RegExp(`;\\s*(?=(?:${knownFields.join("|")})\\s*:)`, "g");
  const parts = tail.split(boundaryRe);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (!knownFields.includes(key)) continue;
    fields[key] = value;
  }
  return fields;
}
