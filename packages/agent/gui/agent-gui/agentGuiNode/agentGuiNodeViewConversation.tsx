import { Spinner } from "@tutti-os/ui-system";
import { AskLinedIcon } from "@tutti-os/ui-system/icons";
import { resolveAgentGUIConversationSortTimeUnixMs } from "./model/agentGuiConversationModel";
import type { AgentGUINodeViewModel } from "./model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "./AgentGUINodeView";
import styles from "./AgentGUINode.styles";

export interface ConversationSection {
  id: string;
  kind: "pinned" | "project" | "conversations";
  label: string;
  project: AgentGUINodeViewModel["rail"]["conversations"][number]["project"];
  items: AgentGUINodeViewModel["rail"]["conversations"];
}

export function ConversationMeta({
  item,
  nowMs,
  labels
}: {
  item: AgentGUINodeViewModel["rail"]["conversations"][number];
  nowMs: number;
  labels: Pick<
    AgentGUIViewLabels,
    | "relativeTimeJustNow"
    | "relativeTimeMinutes"
    | "relativeTimeHours"
    | "relativeTimeDays"
    | "relativeTimeMonths"
    | "relativeTimeYears"
  >;
}): React.JSX.Element {
  "use memo";
  const kind = conversationMetaKind(item);

  if (kind === "loading") {
    return (
      <span
        className={styles.conversationMeta}
        data-kind={kind}
        data-testid={`agent-gui-conversation-meta-${item.id}`}
      >
        <LoadingGlyph />
      </span>
    );
  }

  if (kind === "waiting") {
    return (
      <span
        className={styles.conversationMeta}
        data-kind={kind}
        data-testid={`agent-gui-conversation-meta-${item.id}`}
      >
        <AskLinedIcon
          aria-hidden="true"
          className={styles.conversationStatusGlyph}
        />
      </span>
    );
  }

  if (kind === "failed") {
    return (
      <span
        className={styles.conversationMeta}
        data-kind={kind}
        data-testid={`agent-gui-conversation-meta-${item.id}`}
      >
        <AttentionGlyph />
      </span>
    );
  }

  if (kind === "unread-complete") {
    return (
      <span
        className={styles.conversationMeta}
        data-kind={kind}
        data-testid={`agent-gui-conversation-meta-${item.id}`}
      >
        <span className={styles.conversationUnreadLamp} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      className={styles.conversationMeta}
      data-kind={kind}
      data-testid={`agent-gui-conversation-meta-${item.id}`}
    >
      <span className={styles.conversationTime}>
        {formatConversationRelativeTime(
          resolveAgentGUIConversationSortTimeUnixMs(item),
          nowMs,
          labels
        )}
      </span>
    </span>
  );
}

export function filterConversationSectionsBySearchMatches(
  sections: readonly ConversationSection[],
  matchingConversations: AgentGUINodeViewModel["rail"]["conversations"]
): ConversationSection[] {
  const matchingConversationIds = new Set(
    matchingConversations.map((conversation) => conversation.id)
  );
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        matchingConversationIds.has(item.id)
      )
    }))
    .filter((section) => section.items.length > 0);
}

function conversationMetaKind(
  conversation: AgentGUINodeViewModel["rail"]["conversations"][number]
): "loading" | "waiting" | "failed" | "unread-complete" | "time" {
  if (conversation.needsUserAction) {
    return "waiting";
  }
  if (conversation.status === "working" || conversation.status === "waiting") {
    return "loading";
  }
  if (conversation.status === "failed") {
    return "failed";
  }
  if (conversation.hasUnreadCompletion) {
    return "unread-complete";
  }
  return "time";
}

function formatConversationRelativeTime(
  updatedAtUnixMs: number,
  nowMs: number,
  labels: Pick<
    AgentGUIViewLabels,
    | "relativeTimeJustNow"
    | "relativeTimeMinutes"
    | "relativeTimeHours"
    | "relativeTimeDays"
    | "relativeTimeMonths"
    | "relativeTimeYears"
  >
): string {
  const elapsedMs = Math.max(0, nowMs - updatedAtUnixMs);
  const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));

  if (elapsedMinutes < 1) {
    return labels.relativeTimeJustNow;
  }
  if (elapsedMinutes < 60) {
    return labels.relativeTimeMinutes(elapsedMinutes);
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return labels.relativeTimeHours(elapsedHours);
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) {
    return labels.relativeTimeDays(elapsedDays);
  }

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) {
    return labels.relativeTimeMonths(elapsedMonths);
  }

  return labels.relativeTimeYears(Math.floor(elapsedDays / 365));
}

function LoadingGlyph(): React.JSX.Element {
  "use memo";
  return (
    <Spinner
      className={styles.conversationStatusGlyph}
      size={14}
      style={{ color: "var(--text-secondary)" }}
      strokeWidth={2.25}
      trackColor="color-mix(in srgb, currentColor 24%, transparent)"
      testId="agent-gui-conversation-spinner"
    />
  );
}

function AttentionGlyph(): React.JSX.Element {
  "use memo";
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={styles.conversationStatusGlyph}
    >
      <path
        d="M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2ZM12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4ZM12.5 15C12.7761 15 13 15.2239 13 15.5V16.5C13 16.7761 12.7761 17 12.5 17H11.5C11.2239 17 11 16.7761 11 16.5V15.5C11 15.2239 11.2239 15 11.5 15H12.5ZM12.5 7C12.7761 7 13 7.22386 13 7.5V13.5C13 13.7761 12.7761 14 12.5 14H11.5C11.2239 14 11 13.7761 11 13.5V7.5C11 7.22386 11.2239 7 11.5 7H12.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
