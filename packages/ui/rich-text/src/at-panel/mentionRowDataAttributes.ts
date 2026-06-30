import type { MentionRowItem } from "./mentionRowTypes.ts";

export type MentionRowDataAttributeMode = "shared" | "agent";

export type MentionRowDataAttributeKey =
  | "agentAvatar"
  | "appIcon"
  | "fileEntryKind"
  | "fileThumb"
  | "fileVisualKind"
  | "navigation"
  | "navigateInto"
  | "openReferences"
  | "statusTag"
  | "userAvatar";

const MENTION_ROW_DATA_ATTRIBUTES: Record<
  MentionRowDataAttributeMode,
  Record<MentionRowDataAttributeKey, string>
> = {
  shared: {
    agentAvatar: "data-rich-text-at-mention-agent-avatar",
    appIcon: "data-rich-text-at-mention-app-icon",
    fileEntryKind: "data-rich-text-at-mention-file-entry-kind",
    fileThumb: "data-rich-text-at-mention-file-thumb",
    fileVisualKind: "data-rich-text-at-mention-file-visual-kind",
    navigation: "data-rich-text-at-mention-navigation",
    navigateInto: "data-rich-text-at-mention-navigate-into",
    openReferences: "data-rich-text-at-mention-open-references",
    statusTag: "data-rich-text-at-mention-status-tag",
    userAvatar: "data-rich-text-at-mention-user-avatar"
  },
  agent: {
    agentAvatar: "data-agent-mention-agent-avatar",
    appIcon: "data-agent-mention-app-icon",
    fileEntryKind: "data-agent-file-entry-kind",
    fileThumb: "data-agent-mention-file-thumb",
    fileVisualKind: "data-agent-file-visual-kind",
    navigation: "data-agent-mention-navigation",
    navigateInto: "data-agent-mention-navigate-into",
    openReferences: "data-agent-mention-open-references",
    statusTag: "data-agent-mention-status-tag",
    userAvatar: "data-agent-mention-user-avatar"
  }
};

export function mentionRowRootDataAttributes(
  mode: MentionRowDataAttributeMode,
  kind: MentionRowItem["kind"]
): Record<string, string> {
  return mode === "agent"
    ? {
        "data-agent-file-mention": "true",
        "data-agent-mention-kind": kind
      }
    : {
        "data-rich-text-at-mention-row": "true",
        "data-rich-text-at-mention-kind": kind
      };
}

export function mentionRowDataAttribute(
  mode: MentionRowDataAttributeMode,
  key: MentionRowDataAttributeKey,
  value: string
): Record<string, string> {
  return {
    [MENTION_ROW_DATA_ATTRIBUTES[mode][key]]: value
  };
}
