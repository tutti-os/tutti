import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";

const AGENT_ACTIVITY_KINDS = new Set([
  "thinking",
  "responding",
  "notification"
]);

export function isAgentActivityTimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const activityKey = activityPayloadKey(item);
  if (activityKey.startsWith("agent.")) {
    return true;
  }

  const metadata = recordValue(item.payload, "metadata");
  const normalizedKind = normalizeToolToken(
    firstPresentString(
      stringRecordValue(item.payload, "activityKind"),
      stringRecordValue(item.payload, "activity_kind"),
      stringRecordValue(metadata, "activityKind"),
      stringRecordValue(metadata, "activity_kind")
    )
  );
  if (AGENT_ACTIVITY_KINDS.has(normalizedKind)) {
    return true;
  }

  const normalizedName = (item.name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.\-\s]+/gu, "_");
  return normalizedName.startsWith("agent_");
}

function activityPayloadKey(item: WorkspaceAgentActivityTimelineItem): string {
  const metadata = recordValue(item.payload, "metadata");
  return firstPresentString(
    stringRecordValue(item.payload, "activityKey"),
    stringRecordValue(item.payload, "activity_key"),
    stringRecordValue(metadata, "activityKey"),
    stringRecordValue(metadata, "activity_key")
  )
    .trim()
    .toLowerCase();
}

function normalizeToolToken(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, "_") ?? ""
  );
}

function recordValue(
  value: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const entry = value?.[key];
  return typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : undefined;
}

function stringRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const entry = value?.[key];
  return typeof entry === "string" ? entry : undefined;
}

function firstPresentString(...values: Array<string | undefined>): string {
  return (
    values.find(
      (value) => typeof value === "string" && value.trim().length > 0
    ) ?? ""
  );
}
