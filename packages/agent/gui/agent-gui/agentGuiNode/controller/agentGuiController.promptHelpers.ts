// Agent GUI controller — prompt content normalization and optimistic messages.

import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import { mergeAgentGUITimelineItems } from "../model/agentGuiConversationModel";
import { projectWorkspaceAgentMessagesToTimelineItems } from "../../../shared/agentConversation/projection/workspaceAgentMessageProjection";
import type {
  WorkspaceAgentActivityMessage,
  WorkspaceAgentActivityTimelineItem
} from "../../../shared/workspaceAgentActivityTypes";

export function stringPayloadValue(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" ? nested : undefined;
}

export function createAgentGUIConversationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `00000000-0000-4000-8000-${fallbackHex.slice(0, 12)}`;
}

export function projectAgentGUIMessagesToTimelineItems(
  messages: readonly WorkspaceAgentActivityMessage[]
): WorkspaceAgentActivityTimelineItem[] {
  return mergeAgentGUITimelineItems(
    [],
    projectWorkspaceAgentMessagesToTimelineItems(messages)
  );
}

export function normalizeOptionalText(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeOptionalPrompt(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function textPromptContent(prompt: string): AgentPromptContentBlock[] {
  const text = prompt.trim();
  return text ? [{ type: "text", text }] : [];
}

export function normalizePromptContentBlocks(
  content: readonly AgentPromptContentBlock[]
): AgentPromptContentBlock[] {
  const result: AgentPromptContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const text = block.text?.trim() ?? "";
      if (text) {
        result.push({ type: "text", text });
      }
      continue;
    }
    if (block.type === "image") {
      const mimeType = block.mimeType?.trim();
      const data = block.data?.trim();
      if (
        !data ||
        (mimeType !== "image/png" &&
          mimeType !== "image/jpeg" &&
          mimeType !== "image/webp")
      ) {
        continue;
      }
      result.push({
        type: "image",
        mimeType,
        data,
        ...(block.name?.trim() ? { name: block.name.trim() } : {})
      });
      continue;
    }
    if (block.type === "skill" || block.type === "mention") {
      const name = block.name?.trim();
      const path = block.path?.trim();
      if (name && path) {
        result.push({ type: block.type, name, path });
      }
    }
  }
  return result;
}

export function promptContentDisplayText(
  content: readonly AgentPromptContentBlock[]
): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

export function promptContentHasImage(
  content: readonly AgentPromptContentBlock[]
): boolean {
  return content.some((block) => block.type === "image");
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
