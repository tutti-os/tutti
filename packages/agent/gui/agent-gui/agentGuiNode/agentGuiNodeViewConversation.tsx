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
  project: AgentGUINodeViewModel["conversations"][number]["project"];
  items: AgentGUINodeViewModel["conversations"];
}

export function ConversationMeta({
  item,
  nowMs,
  labels
}: {
  item: AgentGUINodeViewModel["conversations"][number];
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

export function groupConversations(
  conversations: AgentGUINodeViewModel["conversations"],
  labels: Pick<AgentGUIViewLabels, "sectionPinned" | "sectionConversations">,
  userProjects: AgentGUINodeViewModel["userProjects"] = [],
  options: { includeEmptyConversations?: boolean } = {}
): ConversationSection[] {
  const groups: ConversationSection[] = [];
  const pinned = conversations
    .filter((conversation) => (conversation.pinnedAtUnixMs ?? 0) > 0)
    .sort(
      (left, right) =>
        (right.pinnedAtUnixMs ?? 0) - (left.pinnedAtUnixMs ?? 0) ||
        resolveAgentGUIConversationSortTimeUnixMs(right) -
          resolveAgentGUIConversationSortTimeUnixMs(left) ||
        left.id.localeCompare(right.id)
    );
  if (pinned.length > 0) {
    groups.push({
      id: "pinned",
      kind: "pinned",
      label: labels.sectionPinned,
      project: null,
      items: pinned
    });
  }
  const projectGroups = new Map<string, ConversationSectionWithSort>();
  const normalizedProjectPathByPath = new Map<string, string>();
  const normalizeProjectPath = (path: string) =>
    normalizeConversationProjectPathCached(path, normalizedProjectPathByPath);
  userProjects.forEach((project, projectOrder) => {
    const normalizedPath = normalizeProjectPath(project.path);
    const sectionId = `project:${normalizedPath}`;
    if (projectGroups.has(sectionId)) {
      return;
    }
    projectGroups.set(sectionId, {
      id: sectionId,
      kind: "project",
      label: project.label,
      project,
      items: [],
      projectOrder,
      sectionOrder: 0,
      projectUpdatedAtUnixMs: resolveConversationProjectUpdatedAtUnixMs(project)
    });
  });
  if (options.includeEmptyConversations) {
    projectGroups.set("conversations", {
      id: "conversations",
      kind: "conversations",
      label: labels.sectionConversations,
      project: null,
      items: [],
      projectOrder: Number.MAX_SAFE_INTEGER,
      sectionOrder: 1,
      projectUpdatedAtUnixMs: 0
    });
  }
  for (const conversation of conversations) {
    if ((conversation.pinnedAtUnixMs ?? 0) > 0) {
      continue;
    }
    if (!conversation.project) {
      const existing = projectGroups.get("conversations");
      if (existing) {
        existing.items.push(conversation);
        continue;
      }
      projectGroups.set("conversations", {
        id: "conversations",
        kind: "conversations",
        label: labels.sectionConversations,
        project: null,
        items: [conversation],
        projectOrder: Number.MAX_SAFE_INTEGER,
        sectionOrder: 1,
        projectUpdatedAtUnixMs: 0
      });
      continue;
    }

    const normalizedPath = normalizeProjectPath(conversation.project.path);
    const sectionId = `project:${normalizedPath}`;
    const existing = projectGroups.get(sectionId);
    if (existing) {
      existing.items.push(conversation);
      continue;
    }
    projectGroups.set(sectionId, {
      id: sectionId,
      kind: "project",
      label: conversation.project.label,
      project: conversation.project,
      items: [conversation],
      projectOrder: Number.MAX_SAFE_INTEGER - 1,
      sectionOrder: 0,
      projectUpdatedAtUnixMs: resolveConversationProjectUpdatedAtUnixMs(
        conversation.project
      )
    });
  }
  groups.push(
    ...[...projectGroups.values()]
      .sort(
        (left, right) =>
          left.sectionOrder - right.sectionOrder ||
          right.projectUpdatedAtUnixMs - left.projectUpdatedAtUnixMs ||
          left.projectOrder - right.projectOrder ||
          left.label.localeCompare(right.label) ||
          left.id.localeCompare(right.id)
      )
      .map(
        ({
          projectOrder: _projectOrder,
          sectionOrder: _sectionOrder,
          projectUpdatedAtUnixMs: _projectUpdatedAtUnixMs,
          ...group
        }) => group
      )
  );
  return groups;
}

export function filterConversationSectionsBySearchMatches(
  sections: readonly ConversationSection[],
  matchingConversations: AgentGUINodeViewModel["conversations"]
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

type ConversationSectionWithSort = ConversationSection & {
  projectOrder: number;
  sectionOrder: number;
  projectUpdatedAtUnixMs: number;
};

function resolveConversationProjectUpdatedAtUnixMs(
  project: ConversationSection["project"]
): number {
  if (!project) {
    return 0;
  }
  return (
    project.updatedAtUnixMs ??
    project.lastUsedAtUnixMs ??
    project.createdAtUnixMs ??
    0
  );
}

export function normalizeConversationProjectPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/, "") || "/";
}

function normalizeConversationProjectPathCached(
  path: string,
  normalizedPathByPath: Map<string, string>
): string {
  const cached = normalizedPathByPath.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const normalized = normalizeConversationProjectPath(path);
  normalizedPathByPath.set(path, normalized);
  return normalized;
}

function conversationMetaKind(
  conversation: AgentGUINodeViewModel["conversations"][number]
): "loading" | "waiting" | "failed" | "unread-complete" | "time" {
  if (conversation.status === "working") {
    return "loading";
  }
  if (conversation.status === "waiting") {
    return "waiting";
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
      strokeWidth={1.5}
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
