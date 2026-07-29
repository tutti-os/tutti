// Parses the agent-inert sentinel line the daemon prepends to a Tutti Mode
// checkpoint-wake prompt. The source agent still receives the full prompt
// verbatim; the desktop GUI keys a compact summary card off this marker instead
// of rendering the wall of CLI-usage text.
//
// Wire contract (must stay in sync with the daemon builder in
// services/tuttid/service/tuttimodeexecution/prompts.go):
//
//   <!-- TUTTI_MODE_CHECKPOINT_WAKE {"v":1,"kind":"task_settled",...} -->
//   <blank line>
//   A durable Tutti Mode execution checkpoint requires your review.
//   ...full prompt body...
//
// Detection is anchored on the exact sentinel delimiters and a JSON payload —
// never on the English prose below it — so it survives i18n and prompt edits.
// A missing or malformed marker returns null and the caller renders the raw
// body as before (graceful degradation for legacy messages).

export const TUTTI_MODE_CHECKPOINT_WAKE_MARKER_PREFIX =
  "<!-- TUTTI_MODE_CHECKPOINT_WAKE ";
const MARKER_SUFFIX = " -->";

export interface TuttiModeCheckpointWakeMarker {
  kind: string;
  issueId: string;
  checkpointId: string;
  graphRevision: number | null;
}

export interface ParsedTuttiModeCheckpointWake {
  marker: TuttiModeCheckpointWakeMarker;
  /**
   * The full injected prompt with the sentinel line (and its trailing blank
   * line) removed, for the expand-to-full affordance. Never empty: falls back
   * to the original text if stripping would leave nothing.
   */
  body: string;
}

export function parseTuttiModeCheckpointWake(
  rawText: string | null | undefined
): ParsedTuttiModeCheckpointWake | null {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return null;
  }
  // Tolerate a leading BOM but nothing else before the marker: the sentinel
  // must be the very first line so we never sniff markers out of body prose.
  const text = rawText.replace(/^\uFEFF/, "");
  const newlineIndex = text.indexOf("\n");
  const firstLine = (
    newlineIndex === -1 ? text : text.slice(0, newlineIndex)
  ).trim();
  if (
    !firstLine.startsWith(TUTTI_MODE_CHECKPOINT_WAKE_MARKER_PREFIX) ||
    !firstLine.endsWith(MARKER_SUFFIX) ||
    firstLine.length <=
      TUTTI_MODE_CHECKPOINT_WAKE_MARKER_PREFIX.length + MARKER_SUFFIX.length
  ) {
    return null;
  }
  const json = firstLine
    .slice(
      TUTTI_MODE_CHECKPOINT_WAKE_MARKER_PREFIX.length,
      firstLine.length - MARKER_SUFFIX.length
    )
    .trim();
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (!kind) {
    // Kind is the semantic driver of the friendly summary; without it the
    // marker is unusable and we degrade to the raw body.
    return null;
  }
  const issueId =
    typeof record.issueId === "string" ? record.issueId.trim() : "";
  const checkpointId =
    typeof record.checkpointId === "string" ? record.checkpointId.trim() : "";
  const graphRevision =
    typeof record.graphRevision === "number" &&
    Number.isFinite(record.graphRevision)
      ? record.graphRevision
      : null;
  const rest = newlineIndex === -1 ? "" : text.slice(newlineIndex + 1);
  const body = rest.replace(/^\n+/, "");
  return {
    marker: { kind, issueId, checkpointId, graphRevision },
    body: body.length > 0 ? body : text
  };
}
