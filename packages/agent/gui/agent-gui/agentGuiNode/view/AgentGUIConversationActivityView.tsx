import { memo, type ReactNode } from "react";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type {
  AgentGUIConversationActivityPriorityReason,
  AgentGUIConversationActivityProjection
} from "../model/agentGuiConversationActivityView";
import styles from "../AgentGUINode.styles";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import { AgentGUIConversationRailItem } from "./AgentGUIConversationRailItem";

interface AgentGUIConversationActivityViewProps {
  activeConversationId: string | null;
  conversationsById: ReadonlyMap<
    string,
    AgentGUINodeViewModel["rail"]["conversations"][number]
  >;
  isDeletingConversation: boolean;
  isRailInteractionLocked: () => boolean;
  labels: AgentGUIConversationRailLabels;
  pendingDeleteConversationId: string | null;
  projection: AgentGUIConversationActivityProjection;
  uiLanguage: UiLanguage;
  workspaceId: string;
  registerItemElement: (itemId: string, element: HTMLDivElement | null) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (
    conversation: AgentGUINodeViewModel["rail"]["conversations"][number]
  ) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
}

export const AgentGUIConversationActivityView = memo(
  function AgentGUIConversationActivityView({
    activeConversationId,
    conversationsById,
    isDeletingConversation,
    isRailInteractionLocked,
    labels,
    pendingDeleteConversationId,
    projection,
    uiLanguage,
    workspaceId,
    registerItemElement,
    onCancelDeleteConversation,
    onConfirmDeleteConversation,
    onMarkConversationUnread,
    onOpenConversationWindow,
    onRequestDeleteConversation,
    onRequestRenameConversation,
    onSelectConversation,
    onToggleConversationPinned
  }: AgentGUIConversationActivityViewProps): React.JSX.Element {
    "use memo";
    const itemProps = {
      activeConversationId,
      isDeletingConversation,
      isRailInteractionLocked,
      labels,
      pendingDeleteConversationId,
      registerItemElement,
      uiLanguage,
      workspaceId,
      onCancelDeleteConversation,
      onConfirmDeleteConversation,
      onMarkConversationUnread,
      onOpenConversationWindow,
      onRequestDeleteConversation,
      onRequestRenameConversation,
      onSelectConversation,
      onToggleConversationPinned
    };
    const children: ReactNode[] = [
      <ActivityHeading
        key="heading:priority"
        first
        heading={labels.activityPriority}
      />
    ];
    if (projection.priorityIds.length === 0) {
      children.push(
        <div key="empty:priority" className={styles.activityEmpty}>
          {labels.activityNothingNeedsAttention}
        </div>
      );
    } else {
      for (const id of projection.priorityIds) {
        const item = conversationsById.get(id);
        if (!item) continue;
        children.push(
          <ActivityConversationItem
            key={`item:${id}`}
            item={item}
            priorityReason={projection.priorityReasonsById.get(id) ?? null}
            {...itemProps}
          />
        );
      }
    }
    for (const section of projection.recentSections) {
      children.push(
        <ActivityHeading
          key={`heading:${section.dayStartUnixMs}`}
          heading={activityDayLabel(
            section.dayStartUnixMs,
            projection.referenceDayStartUnixMs,
            labels,
            uiLanguage
          )}
        />
      );
      for (const id of section.ids) {
        const item = conversationsById.get(id);
        if (!item) continue;
        children.push(
          <ActivityConversationItem
            key={`item:${id}`}
            item={item}
            priorityReason={null}
            {...itemProps}
          />
        );
      }
    }
    return (
      <fieldset className="contents" disabled={isRailInteractionLocked()}>
        {children}
      </fieldset>
    );
  }
);

type ActivityItemProps = Omit<
  AgentGUIConversationActivityViewProps,
  "conversationsById" | "projection"
> & {
  item: AgentGUINodeViewModel["rail"]["conversations"][number];
  priorityReason: AgentGUIConversationActivityPriorityReason | null;
};

function ActivityHeading({
  first = false,
  heading
}: {
  first?: boolean;
  heading: string;
}): React.JSX.Element {
  return (
    <h2 className={styles.activityHeading} data-first={first}>
      {heading}
    </h2>
  );
}

const ActivityConversationItem = memo(function ActivityConversationItem({
  item,
  priorityReason,
  ...props
}: ActivityItemProps): React.JSX.Element {
  const projectLabel =
    item.railSectionKey &&
    item.project?.sectionKey === item.railSectionKey &&
    item.project.label.trim()
      ? item.project.label.trim()
      : null;
  const secondary = projectLabel
    ? { kind: "project" as const, text: projectLabel }
    : { kind: "source" as const, text: props.labels.activityLocalSource };
  return (
    <AgentGUIConversationRailItem
      active={props.activeConversationId === item.id}
      isDeletingConversation={props.isDeletingConversation}
      isPendingDeleteConversation={
        props.pendingDeleteConversationId === item.id
      }
      isRailInteractionLocked={props.isRailInteractionLocked}
      item={item}
      labels={props.labels}
      presentation={{
        kind: "activity",
        priorityReason,
        projectLabel,
        secondary
      }}
      registerItemElement={props.registerItemElement}
      uiLanguage={props.uiLanguage}
      workspaceId={props.workspaceId}
      onCancelDeleteConversation={props.onCancelDeleteConversation}
      onConfirmDeleteConversation={props.onConfirmDeleteConversation}
      onMarkConversationUnread={props.onMarkConversationUnread}
      onOpenConversationWindow={props.onOpenConversationWindow}
      onRequestDeleteConversation={props.onRequestDeleteConversation}
      onRequestRenameConversation={props.onRequestRenameConversation}
      onSelectConversation={props.onSelectConversation}
      onToggleConversationPinned={props.onToggleConversationPinned}
    />
  );
});

function activityDayLabel(
  dayStartUnixMs: number,
  referenceDayStartUnixMs: number,
  labels: AgentGUIConversationRailLabels,
  uiLanguage: UiLanguage
): string {
  if (dayStartUnixMs === referenceDayStartUnixMs) return labels.activityToday;
  const yesterday = new Date(referenceDayStartUnixMs);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayStartUnixMs === yesterday.getTime()) return labels.activityYesterday;
  return new Intl.DateTimeFormat(uiLanguage, { weekday: "long" }).format(
    dayStartUnixMs
  );
}
