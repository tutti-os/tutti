import { translate } from "../i18n/index";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import { TOOL_NAME_TRANSLATION_KEYS } from "./workspaceAgentToolCallLabels";
import {
  firstPresentString,
  recordValue,
  stringRecordValue
} from "./workspaceAgentToolCallSummary";

export function itemId(item: WorkspaceAgentActivityTimelineItem): string {
  return item.eventId.trim() || `id:${item.id}`;
}

export function isGenericToolLabel(normalizedTitle: string): boolean {
  return normalizedTitle === "tool" || normalizedTitle === "usetool";
}

export function looksLikeOpaqueToolCallID(
  value: string | null,
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return false;
  const metadata = recordValue(item.payload, "metadata");
  const callID = firstPresentString(
    item.callId,
    stringRecordValue(item.payload, "callId"),
    stringRecordValue(item.payload, "callID"),
    stringRecordValue(item.payload, "call_id"),
    stringRecordValue(metadata, "callId"),
    stringRecordValue(metadata, "callID"),
    stringRecordValue(metadata, "call_id")
  );
  if (callID && trimmed === callID) return true;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("call_")) return isOpaqueTail(trimmed.slice(5));
  if (lower.startsWith("ws_")) return isOpaqueTail(trimmed.slice(3));
  return false;
}

export function toolCallLabel(toolName: string | null): string {
  const normalized = normalizeToolNameToken(toolName);
  const translationKey = normalized
    ? TOOL_NAME_TRANSLATION_KEYS[normalized]
    : null;
  if (translationKey) return translate(translationKey);
  if (toolName?.trim()) return humanizeToolName(toolName);
  return translate("agentHost.agentTool.fallbackName");
}

export function normalizeToolNameToken(
  value: string | null | undefined
): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/gu, "");
}

function isOpaqueTail(value: string): boolean {
  return value.length >= 12 && /^[a-z0-9]+$/i.test(value);
}

function humanizeToolName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
