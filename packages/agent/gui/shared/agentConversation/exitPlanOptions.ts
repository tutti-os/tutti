import type { AgentApprovalOptionVM } from "./contracts/agentApprovalItemVM";

// Shared exit-plan (Claude Code `switch_mode`) detection and option extraction.
//
// Claude Code surfaces "exit plan mode" as a permission/approval whose
// `input.toolCall.kind` is `switch_mode` and whose options are the permission
// modes to switch into ("Yes, and bypass permissions" / "...auto" / etc.) plus
// a trailing `plan` option ("No, keep planning"). Both the conversation and the
// message-center deck must classify and render these identically, so the
// detection + option normalization live here instead of being re-implemented at
// each projection site (which is how they drifted in the first place).
//
// The runtime is the source of truth for the option set: callers render exactly
// the modes it sent (so newly added modes like `auto` appear automatically)
// rather than a hand-maintained list. The `plan` option is the keep-planning /
// deny action and is filtered out of the mode list — callers render it as a
// dedicated "keep planning" affordance.

export const EXIT_PLAN_KEEP_PLANNING_OPTION_ID = "plan";

export function isExitPlanSwitchModeInput(input: unknown): boolean {
  const record = recordValue(input);
  const toolCall = recordValue(record.toolCall);
  if (normalizeToken(stringValue(toolCall.kind)) !== "switchmode") {
    return false;
  }
  return collectRawOptions(record).some(
    (option) =>
      normalizeToken(rawOptionId(option)) === EXIT_PLAN_KEEP_PLANNING_OPTION_ID
  );
}

// Normalized "Yes, and ..." mode options, in runtime order, with the
// keep-planning (`plan`) option removed. Returns [] when the payload carries no
// options (e.g. Codex plan or the legacy `exitplanmode` tool), letting callers
// fall back to a curated default list.
export function extractExitPlanModeOptions(
  input: unknown,
  payload?: unknown
): AgentApprovalOptionVM[] {
  const sources =
    payload === undefined
      ? [recordValue(input)]
      : [recordValue(input), recordValue(payload)];
  return sources.flatMap(collectRawOptions).flatMap((option) => {
    // The emitted id must be the runtime's exact value (e.g. "acceptEdits",
    // "auto") — it is submitted back as the permission mode. Only the
    // keep-planning comparison is case/format-insensitive.
    const id = rawOptionId(option);
    if (!id || normalizeToken(id) === EXIT_PLAN_KEEP_PLANNING_OPTION_ID) {
      return [];
    }
    return [
      {
        id,
        label:
          stringValue(option.name) ??
          stringValue(option.label) ??
          stringValue(option.title) ??
          stringValue(option.kind) ??
          id,
        kind: stringValue(option.kind) ?? id,
        ...(stringValue(option.description)
          ? { description: stringValue(option.description) as string }
          : {})
      }
    ];
  });
}

// The runtime's keep-planning option id ("No, keep planning"), preserving its
// exact casing so it can be submitted back. The daemon models exit-plan as an
// approval that *requires* an option id — declining means selecting this option,
// not sending a bare deny. Returns null when the payload has no plan option
// (legacy `exitplanmode` / Codex), where callers fall back to a plain deny.
export function extractExitPlanKeepPlanningOptionId(
  input: unknown,
  payload?: unknown
): string | null {
  const sources =
    payload === undefined
      ? [recordValue(input)]
      : [recordValue(input), recordValue(payload)];
  for (const option of sources.flatMap(collectRawOptions)) {
    const id = rawOptionId(option);
    if (id && normalizeToken(id) === EXIT_PLAN_KEEP_PLANNING_OPTION_ID) {
      return id;
    }
  }
  return null;
}

function collectRawOptions(
  record: Record<string, unknown>
): Record<string, unknown>[] {
  return arrayValue(record.options).map(recordValue);
}

function rawOptionId(option: Record<string, unknown>): string {
  return (
    stringValue(option.optionId) ??
    stringValue(option.id) ??
    stringValue(option.kind) ??
    ""
  );
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[_\s-]+/g, "")
    .trim()
    .toLowerCase();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
