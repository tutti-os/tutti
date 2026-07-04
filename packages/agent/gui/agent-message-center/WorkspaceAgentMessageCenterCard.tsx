import {
  cloneElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type FocusEvent as ReactFocusEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type ReactElement,
  type ReactNode
} from "react";
import {
  AppWindow,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Info
} from "lucide-react";
import {
  Button,
  cn,
  StatusDot,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import {
  isRichTextMentionHref,
  parseRichTextMentionHref
} from "@tutti-os/ui-rich-text/core";
import { getActiveUiLanguage, useTranslation } from "../i18n/index";
import { formatAgentSessionMentionText } from "../shared/utils/agentSessionMentionText";
import { AgentInteractivePromptSurface } from "../shared/agentConversation/components/AgentInteractivePromptSurface";
import { AgentMessageMarkdown } from "../shared/AgentMessageMarkdown";
import { AgentVerticalScrollArea } from "../shared/AgentVerticalScrollArea";
import { managedAgentRoundedIconUrl } from "../shared/managedAgentIcons";
import { workspaceAgentActivityStatusLabel } from "../shared/workspaceAgentActivityStatusLabel";
import { workspaceAgentProviderLabel } from "../shared/workspaceAgentProviderLabel";
import { userAvatarPlaceholderUrl } from "../shared/userAvatarPlaceholder";
import type { WorkspaceLinkAction } from "../actions/workspaceLinkActions";
import {
  isWaitingMessageCenterItem,
  type WorkspaceAgentMessageCenterIdentity,
  type WorkspaceAgentMessageCenterItem
} from "./workspaceAgentMessageCenterModel";
import { formatAgentGuiConversationPlainTitle } from "../workbench/sessionTitle";

export interface WorkspaceAgentMessageCenterCardProps {
  item: WorkspaceAgentMessageCenterItem;
  cardRef?: (node: HTMLElement | null) => void;
  actionsAccessory?: ReactNode;
  footerAccessory?: ReactNode;
  headerAccessory?: ReactNode;
  highlighted?: boolean;
  interactive?: boolean;
  isSubmitting: boolean;
  lazySummary?: boolean;
  summaryAccessory?: ReactNode;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onOpenChat: (input: { agentSessionId: string; provider: string }) => void;
  onSubmitPrompt: (input: {
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
    requestId: string;
  }) => void;
}

interface WorkspaceAgentMessageCenterStackProps {
  className?: string;
  expanded: boolean;
  groupId: string;
  highlightedItemId?: string | null;
  items: WorkspaceAgentMessageCenterItem[];
  renderCard: (
    item: WorkspaceAgentMessageCenterItem,
    options?: { stackedIndex?: number }
  ) => ReactNode;
  onCollapse: (groupId: string) => void;
  onExpand: (groupId: string) => void;
}

function stopMessageCenterTextPointerPropagation(
  event: ReactPointerEvent<HTMLElement>
): void {
  event.stopPropagation();
}

export const WorkspaceAgentMessageCenterCard = memo(
  function WorkspaceAgentMessageCenterCard({
    cardRef,
    actionsAccessory,
    footerAccessory,
    headerAccessory,
    highlighted = false,
    interactive = true,
    item,
    isSubmitting,
    lazySummary = false,
    summaryAccessory,
    onLinkAction,
    onOpenChat,
    onSubmitPrompt
  }: WorkspaceAgentMessageCenterCardProps): JSX.Element {
    "use memo";
    const { t } = useTranslation();
    const prompt = item.pendingPrompt;
    const displayTitle = formatAgentGuiConversationPlainTitle(item, {
      language: getActiveUiLanguage()
    });
    const summary = messageCenterVisibleSummary(item);
    const displayStatus = statusClass(item);
    const statusTone = messageCenterStatusTone(item);
    const statusLabel = workspaceAgentActivityStatusLabel(displayStatus, t);

    return (
      <article
        ref={cardRef}
        className={cn(
          "workspace-agent-message-center__card group/message-card flex min-w-0 flex-col gap-2.5 rounded-lg border border-[var(--line-2)] bg-[var(--background-fronted)] p-3.5 outline outline-0 outline-offset-2 outline-transparent transition-[background-color,border-color,outline-color]",
          isWaitingMessageCenterItem(item) &&
            "agent-gui-edge-glow border-[var(--tutti-purple-border)] bg-[var(--tutti-purple-bg)]",
          highlighted && "outline-2 outline-[var(--accent)]"
        )}
        data-highlighted={highlighted ? "true" : undefined}
        data-message-center-digest-kind={item.digest.primary.kind}
        data-message-center-item-id={item.id}
        data-waiting={isWaitingMessageCenterItem(item) ? "true" : undefined}
        data-status={displayStatus}
        tabIndex={highlighted ? -1 : undefined}
      >
        <div className="flex min-w-0 items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <LazyMessageCenterTooltip
              content={displayTitle}
              side="top"
              align="start"
              className="max-w-[min(360px,calc(100vw-32px))] whitespace-normal text-left [overflow-wrap:anywhere]"
            >
              <h3
                className="workspace-agent-message-center__copy-text min-w-0 truncate text-[13px] font-bold leading-5 text-[var(--text-secondary)]"
                onPointerDown={stopMessageCenterTextPointerPropagation}
              >
                {displayTitle}
              </h3>
            </LazyMessageCenterTooltip>
            {item.cwd ? <ProjectPathInfo path={item.cwd} /> : null}
          </div>
          <span className="flex shrink-0 items-center gap-2">
            {headerAccessory}
            <span
              className={cn(
                "workspace-agent-message-center__status inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold leading-4",
                messageCenterStatusToneClass(statusTone)
              )}
              data-status={displayStatus}
              title={statusLabel}
            >
              <StatusDot
                tone={statusTone}
                pulse={
                  isWaitingMessageCenterItem(item) || item.status === "working"
                }
                size="sm"
                title={statusLabel}
              />
              <span>{statusLabel}</span>
            </span>
          </span>
        </div>

        {summary ? (
          <MessageCenterSummary
            item={item}
            lazy={lazySummary}
            onLinkAction={onLinkAction}
            summary={summary}
            emptyLabel={t("agentHost.workspaceAgentMessageCenterNoSummary")}
          />
        ) : null}

        {summaryAccessory}

        {prompt && interactive ? (
          <div className="min-w-0">
            <AgentInteractivePromptSurface
              embedded
              variant="compact"
              keyboardShortcuts={false}
              prompt={prompt}
              isSubmitting={isSubmitting}
              onSubmit={onSubmitPrompt}
              labels={buildWorkspaceAgentInteractivePromptLabels(
                t,
                item.provider
              )}
            />
          </div>
        ) : null}

        {footerAccessory}

        <MessageCenterOpenChatButton
          actionsAccessory={actionsAccessory}
          provider={item.provider}
          item={item}
          label={t("agentHost.workspaceAgentMessageCenterOpenChat")}
          onOpenChat={onOpenChat}
          // Interactive deck cards only offer the primary decision inline; the
          // jump to the conversation is the path for everything else (e.g.
          // refining a plan), so keep it always visible rather than hover-only.
          alwaysVisible={interactive && prompt !== null}
        />
      </article>
    );
  }
);

const STACK_PRESENCE_FALLBACK_MS = 380;
const MESSAGE_CENTER_STACK_INITIAL_RENDER_COUNT = 24;
const MESSAGE_CENTER_STACK_RENDER_BATCH_SIZE = 24;
const MESSAGE_CENTER_STACK_RENDER_BATCH_DELAY_MS = 40;
const MESSAGE_CENTER_SUMMARY_LAZY_ROOT_MARGIN = "480px 0px";
const MESSAGE_CENTER_SUMMARY_OVERFLOW_MEASURE_DELAY_MS = 80;

function useStackRegionPresence(visible: boolean): {
  closing: boolean;
  mounted: boolean;
  onAnimationEnd: (event: ReactAnimationEvent<HTMLDivElement>) => void;
} {
  const [mounted, setMounted] = useState(visible);
  const closing = mounted && !visible;

  useLayoutEffect(() => {
    if (visible) {
      setMounted(true);
    }
  }, [visible]);

  useEffect(() => {
    if (!closing) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setMounted(false);
    }, STACK_PRESENCE_FALLBACK_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [closing]);

  const onAnimationEnd = useCallback(
    (event: ReactAnimationEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && closing) {
        setMounted(false);
      }
    },
    [closing]
  );

  return { closing, mounted, onAnimationEnd };
}

export const WorkspaceAgentMessageCenterStack = memo(
  function WorkspaceAgentMessageCenterStack({
    className,
    expanded,
    groupId,
    highlightedItemId,
    items,
    renderCard,
    onCollapse,
    onExpand
  }: WorkspaceAgentMessageCenterStackProps): JSX.Element | null {
    "use memo";
    const { t } = useTranslation();
    const summaryRegion = useStackRegionPresence(!expanded);
    const cardsRegion = useStackRegionPresence(expanded);
    const visibleItems = useBatchedMessageCenterStackItems({
      expanded,
      highlightedItemId,
      items,
      mounted: cardsRegion.mounted
    });
    if (items.length < 2) {
      return null;
    }
    const collapseLabel = t(
      "agentHost.workspaceAgentMessageCenterCollapseStackAria"
    );

    return (
      <div
        className={cn("relative flex min-w-0 flex-col", className)}
        data-stack-count={items.length}
        data-stack-motion="smooth"
        data-stack-state={expanded ? "expanded" : "collapsed"}
        data-stack-top-item-id={items[0]?.id}
        data-testid={`workspace-agent-message-stack-${groupId}`}
      >
        {summaryRegion.mounted ? (
          <div
            className={cn(
              "workspace-agent-message-center__stack-rest min-w-0",
              summaryRegion.closing
                ? "workspace-agent-message-center__stack-rest--closing"
                : "workspace-agent-message-center__stack-rest--opening"
            )}
            onAnimationEnd={summaryRegion.onAnimationEnd}
          >
            <div
              className="min-h-0 min-w-0 overflow-hidden"
              aria-hidden={summaryRegion.closing ? true : undefined}
              inert={summaryRegion.closing ? true : undefined}
            >
              <MessageCenterStackSummary
                groupId={groupId}
                items={items}
                onExpand={onExpand}
              />
            </div>
          </div>
        ) : null}

        {cardsRegion.mounted ? (
          <div
            className={cn(
              "workspace-agent-message-center__stack-rest min-w-0",
              cardsRegion.closing
                ? "workspace-agent-message-center__stack-rest--closing"
                : "workspace-agent-message-center__stack-rest--opening"
            )}
            onAnimationEnd={cardsRegion.onAnimationEnd}
          >
            <div
              className="min-h-0 min-w-0 overflow-hidden"
              aria-hidden={cardsRegion.closing ? true : undefined}
              inert={cardsRegion.closing ? true : undefined}
            >
              <div className="flex min-w-0 items-center justify-between gap-2 px-0.5 pb-1.5">
                <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold leading-4 text-[var(--text-tertiary)]">
                  <MessageCenterIdentityAvatarMark
                    identity={items[0]?.identity ?? null}
                    provider={items[0]?.provider ?? ""}
                    userId={items[0]?.userId ?? null}
                  />
                  <span className="min-w-0 truncate">
                    {t(
                      "agentHost.workspaceAgentMessageCenterStackSummaryCount",
                      {
                        count: items.length
                      }
                    )}
                  </span>
                </span>
                <LazyMessageCenterTooltip
                  content={collapseLabel}
                  side="top"
                  align="center"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={collapseLabel}
                    className="size-6 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    onClick={() => onCollapse(groupId)}
                  >
                    <ChevronUp className="size-3.5" aria-hidden="true" />
                  </Button>
                </LazyMessageCenterTooltip>
              </div>
              <div className="flex min-w-0 flex-col gap-2.5">
                {visibleItems.map((item, stackedIndex) =>
                  renderCard(item, { stackedIndex })
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  },
  areMessageCenterStackPropsEqual
);

function areMessageCenterStackPropsEqual(
  previous: WorkspaceAgentMessageCenterStackProps,
  next: WorkspaceAgentMessageCenterStackProps
): boolean {
  if (
    previous.className !== next.className ||
    previous.expanded !== next.expanded ||
    previous.groupId !== next.groupId ||
    previous.onCollapse !== next.onCollapse ||
    previous.onExpand !== next.onExpand ||
    previous.renderCard !== next.renderCard
  ) {
    return false;
  }
  if (next.expanded) {
    return (
      previous.highlightedItemId === next.highlightedItemId &&
      previous.items === next.items
    );
  }
  return (
    messageCenterCollapsedStackSignature(previous.items) ===
    messageCenterCollapsedStackSignature(next.items)
  );
}

function messageCenterCollapsedStackSignature(
  items: readonly WorkspaceAgentMessageCenterItem[]
): string {
  const firstItem = items[0];
  if (!firstItem) {
    return "0";
  }
  const hasWaiting = items.some(isWaitingMessageCenterItem) ? "1" : "0";
  return [
    items.length,
    firstItem.id,
    firstItem.provider,
    firstItem.userId ?? "",
    firstItem.identity?.userName ?? "",
    firstItem.identity?.agentName ?? "",
    hasWaiting,
    messageCenterStackPreviewText(firstItem)
  ].join(":");
}

function useBatchedMessageCenterStackItems({
  expanded,
  highlightedItemId,
  items,
  mounted
}: {
  expanded: boolean;
  highlightedItemId?: string | null;
  items: WorkspaceAgentMessageCenterItem[];
  mounted: boolean;
}): WorkspaceAgentMessageCenterItem[] {
  const limit = items.length;
  const highlightedIndex =
    highlightedItemId === null || highlightedItemId === undefined
      ? -1
      : items.findIndex((item) => item.id === highlightedItemId);
  const initialCount = Math.min(
    limit,
    Math.max(MESSAGE_CENTER_STACK_INITIAL_RENDER_COUNT, highlightedIndex + 1)
  );
  const [renderCount, setRenderCount] = useState(initialCount);

  useEffect(() => {
    if (!mounted) {
      setRenderCount(initialCount);
      return;
    }
    setRenderCount((current) =>
      Math.min(Math.max(current, initialCount), limit)
    );
  }, [initialCount, limit, mounted]);

  useEffect(() => {
    if (!expanded || !mounted || renderCount >= limit) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setRenderCount((current) =>
        Math.min(current + MESSAGE_CENTER_STACK_RENDER_BATCH_SIZE, limit)
      );
    }, MESSAGE_CENTER_STACK_RENDER_BATCH_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [expanded, limit, mounted, renderCount]);

  return items.slice(0, Math.min(renderCount, limit));
}

function MessageCenterStackSummary({
  groupId,
  items,
  onExpand
}: {
  groupId: string;
  items: WorkspaceAgentMessageCenterItem[];
  onExpand: (groupId: string) => void;
}): JSX.Element | null {
  "use memo";
  const { t } = useTranslation();
  const firstItem = items[0];
  const hasWaiting = items.some((item) => isWaitingMessageCenterItem(item));
  if (!firstItem) {
    return null;
  }

  return (
    <button
      type="button"
      aria-label={t("agentHost.workspaceAgentMessageCenterExpandStackAria", {
        count: items.length
      })}
      className={cn(
        "group/stack-peek relative block w-full min-w-0 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        items.length > 2 ? "pb-[18px]" : "pb-[10px]"
      )}
      data-stack-summary-count={items.length}
      data-stack-provider={firstItem.provider}
      data-stack-user-id={firstItem.userId ?? ""}
      data-testid={`workspace-agent-message-stack-summary-${groupId}`}
      onClick={() => onExpand(groupId)}
    >
      <span
        className={cn(
          "relative z-10 flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--line-2)] bg-[var(--background-fronted)] p-3.5 transition-[background-color,border-color] duration-200 group-hover/stack-peek:bg-[var(--transparency-hover)]",
          items.length > 2
            ? "shadow-[0_7px_0_-4px_var(--background-fronted),0_7px_0_-3px_var(--line-2),0_14px_0_-8px_var(--background-fronted),0_14px_0_-7px_var(--line-2)]"
            : "shadow-[0_7px_0_-4px_var(--background-fronted),0_7px_0_-3px_var(--line-2)]",
          hasWaiting &&
            "border-[var(--tutti-purple-border)] bg-[var(--tutti-purple-bg)]"
        )}
      >
        <span className="flex min-w-0 items-center justify-between gap-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <MessageCenterIdentityAvatarMark
              identity={firstItem.identity}
              provider={firstItem.provider}
              userId={firstItem.userId}
            />
            <span className="min-w-0 truncate text-[13px] font-bold leading-5 text-[var(--text-secondary)]">
              {t("agentHost.workspaceAgentMessageCenterStackSummaryCount", {
                count: items.length
              })}
            </span>
          </span>
          <ChevronDown
            className="size-4 shrink-0 text-[var(--text-tertiary)] transition-transform duration-200 group-hover/stack-peek:translate-y-0.5 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </span>
        <span className="min-w-0 rounded-md bg-transparency-block p-2.5 text-[13px] leading-[1.45] text-[var(--text-primary)]">
          <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
            {messageCenterStackPreviewNodes(firstItem)}
          </span>
        </span>
      </span>
    </button>
  );
}

function messageCenterStackRawPreviewText(
  item: WorkspaceAgentMessageCenterItem
): string {
  return (
    item.digest.primary.summary.trim() ||
    item.lastAgentMessageSummary.trim() ||
    item.title
  );
}

export function messageCenterStackPreviewText(
  item: WorkspaceAgentMessageCenterItem
): string {
  return formatAgentSessionMentionText(messageCenterStackRawPreviewText(item), {
    language: getActiveUiLanguage()
  });
}

const MESSAGE_CENTER_PREVIEW_MARKDOWN_LINK_PATTERN =
  /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;
const MESSAGE_CENTER_PREVIEW_LABEL_ESCAPE_PATTERN = /\\([\\[\]()])/g;

type MessageCenterPreviewMentionKind =
  | "session"
  | "workspace-app"
  | "workspace-issue";

/**
 * 收起态预览只展示纯文本 + 一个静态(不可点击)的 mention 图标,复用
 * AgentMessageMarkdown 里那套富文本 chip 的视觉样式,但不渲染成 <a>——
 * 这块预览本身嵌套在外层切换展开/收起的 <button> 里,塞一个可点击链接
 * 会出现交互元素嵌套交互元素的问题。
 */
export function messageCenterStackPreviewNodes(
  item: WorkspaceAgentMessageCenterItem
): ReactNode[] {
  const text = messageCenterStackRawPreviewText(item);
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let mentionIndex = 0;

  for (const match of text.matchAll(
    MESSAGE_CENTER_PREVIEW_MARKDOWN_LINK_PATTERN
  )) {
    const [fullMatch, rawLabel = "", href = ""] = match;
    const matchStart = match.index ?? 0;
    if (matchStart > lastIndex) {
      nodes.push(text.slice(lastIndex, matchStart));
    }

    const label = rawLabel.replace(
      MESSAGE_CENTER_PREVIEW_LABEL_ESCAPE_PATTERN,
      "$1"
    );
    const mention = parseRichTextMentionHref(href, label);
    if (!mention) {
      nodes.push(isRichTextMentionHref(href) ? label : fullMatch);
    } else {
      const kind = messageCenterPreviewMentionKind(mention.providerId);
      const displayLabel = label || mention.label;
      nodes.push(
        kind ? (
          <MessageCenterPreviewMentionChip
            key={`mention-${mentionIndex}`}
            kind={kind}
            label={displayLabel}
          />
        ) : (
          displayLabel
        )
      );
      mentionIndex += 1;
    }

    lastIndex = matchStart + fullMatch.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function messageCenterPreviewMentionKind(
  providerId: string
): MessageCenterPreviewMentionKind | null {
  switch (providerId.trim().toLowerCase()) {
    case "agent-session":
      return "session";
    case "workspace-app":
      return "workspace-app";
    case "workspace-issue":
      return "workspace-issue";
    default:
      return null;
  }
}

function MessageCenterPreviewMentionChip({
  kind,
  label
}: {
  kind: MessageCenterPreviewMentionKind;
  label: string;
}): ReactElement {
  return (
    <span
      className="tsh-agent-object-token tsh-agent-object-token--entity"
      data-agent-mention-kind={kind}
    >
      <span className="tsh-agent-object-token__kind" aria-hidden="true">
        {kind === "workspace-app" ? (
          <AppWindow className="size-3.5" aria-hidden="true" />
        ) : (
          <span
            className="tsh-agent-object-token__kind-icon"
            aria-hidden="true"
          />
        )}
      </span>
      <span className="tsh-agent-object-token__main">{label}</span>
    </span>
  );
}

export function resolveMessageCenterNotificationAction(
  item: WorkspaceAgentMessageCenterItem,
  input: {
    action?: string;
    optionId?: string;
  }
): string | null {
  if (input.action) {
    return normalizeMessageCenterNotificationAction(input.action);
  }

  if (!input.optionId) {
    return null;
  }

  const prompt = item.pendingPrompt;
  const option =
    prompt && "options" in prompt
      ? prompt.options.find((candidate) => candidate.id === input.optionId)
      : null;
  const optionToken = `${option?.kind ?? ""}:${input.optionId}`.toLowerCase();
  if (optionToken.includes("allow") || optionToken.includes("accept")) {
    return "accept";
  }
  if (
    optionToken.includes("deny") ||
    optionToken.includes("reject") ||
    optionToken.includes("disallow")
  ) {
    return "reject";
  }
  return input.optionId;
}

export function buildWorkspaceAgentInteractivePromptLabels(
  t: ReturnType<typeof useTranslation>["t"],
  provider?: string
) {
  return {
    approvalLead: t("agentHost.agentGui.approvalRequired", {
      provider: provider
        ? workspaceAgentProviderLabel(provider)
        : t("agentHost.workspaceAgentsGenericAgentName")
    }),
    planLead: t("agentHost.agentGui.planLead"),
    planModes: [
      {
        id: "acceptEdits",
        label: t("agentHost.agentGui.planModes.acceptEdits.label"),
        description: t("agentHost.agentGui.planModes.acceptEdits.description")
      },
      {
        id: "default",
        label: t("agentHost.agentGui.planModes.askFirst.label"),
        description: t("agentHost.agentGui.planModes.askFirst.description")
      },
      {
        id: "bypassPermissions",
        label: t("agentHost.agentGui.planModes.allowAll.label"),
        description: t("agentHost.agentGui.planModes.allowAll.description")
      },
      {
        id: "auto",
        label: t("agentHost.agentGui.planModes.auto.label"),
        description: t("agentHost.agentGui.planModes.auto.description")
      }
    ],
    stayInPlan: t("agentHost.agentGui.stayInPlan"),
    sendFeedback: t("agentHost.agentGui.sendFeedback"),
    feedbackPlaceholder: t("agentHost.agentGui.feedbackPlaceholder"),
    previousQuestion: t("agentHost.agentGui.previousQuestion"),
    nextQuestion: t("agentHost.agentGui.nextQuestion"),
    submitAnswers: t("agentHost.agentGui.submitAnswers"),
    answerPlaceholder: t("agentHost.agentGui.answerPlaceholder"),
    waitingForAnswer: t("agentHost.agentGui.waitingForAnswer"),
    planImplementationLead: t("agentHost.agentGui.planImplementationLead"),
    planImplementationConfirm: t(
      "agentHost.agentGui.planImplementationConfirm"
    ),
    planImplementationFeedbackPlaceholder: t(
      "agentHost.agentGui.planImplementationFeedbackPlaceholder"
    ),
    planImplementationSend: t("agentHost.agentGui.planImplementationSend"),
    planImplementationSkip: t("agentHost.agentGui.planImplementationSkip")
  };
}

function normalizeMessageCenterNotificationAction(action: string): string {
  switch (action) {
    case "allow":
      return "accept";
    case "deny":
      return "reject";
    default:
      return action;
  }
}

function messageCenterVisibleSummary(
  item: WorkspaceAgentMessageCenterItem
): string {
  const summary = item.digest.primary.summary.trim();
  if (
    item.pendingPrompt?.kind === "approval" &&
    isGenericApprovalSummary(summary)
  ) {
    return "";
  }
  return summary;
}

function isGenericApprovalSummary(summary: string): boolean {
  const normalized = summary.trim().toLowerCase();
  return normalized === "approval";
}

export function MessageCenterSummary({
  emptyLabel,
  item,
  lazy,
  onLinkAction,
  summary
}: {
  emptyLabel: string;
  item: WorkspaceAgentMessageCenterItem;
  lazy: boolean;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  summary: string;
}): JSX.Element {
  "use memo";
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const shouldRenderRichSummary = useLazyMessageCenterSummaryReady(
    summaryRef,
    lazy
  );
  const shouldMeasureOverflow = useDeferredMessageCenterSummaryMeasureReady(
    summaryRef,
    shouldRenderRichSummary
  );
  const handleLinkAction = useCallback(
    (action: WorkspaceLinkAction): void => {
      onLinkAction?.(
        action.type === "open-agent-session" && !action.provider
          ? { ...action, provider: item.provider }
          : action
      );
    },
    [item.provider, onLinkAction]
  );

  useEffect(() => {
    if (!shouldMeasureOverflow) {
      setIsOverflowing(false);
      return undefined;
    }
    const element = summaryRef.current;
    if (!element) {
      return undefined;
    }

    const updateOverflowState = () => {
      setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    };

    let resizeObserver: ResizeObserver | null = null;
    const timeoutId = window.setTimeout(() => {
      updateOverflowState();
      resizeObserver = new ResizeObserver(updateOverflowState);
      resizeObserver.observe(element);
    }, MESSAGE_CENTER_SUMMARY_OVERFLOW_MEASURE_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
      resizeObserver?.disconnect();
    };
  }, [shouldMeasureOverflow, summary]);

  return (
    <AgentVerticalScrollArea
      ref={summaryRef}
      className={cn(
        "workspace-agent-message-center__summary workspace-agent-message-center__copy-text max-h-[160px] min-w-0 rounded-md bg-transparency-block text-[13px] leading-[1.45] text-[var(--text-primary)] [overflow-wrap:anywhere]",
        isOverflowing && "workspace-agent-message-center__summary--overflowing"
      )}
      viewportClassName="workspace-agent-message-center__copy-text max-h-[160px] p-2.5 pr-4"
      onPointerDown={stopMessageCenterTextPointerPropagation}
      scrollbarClassName="top-2 bottom-2 right-1.5"
      syncKey={summary}
    >
      {summary && shouldRenderRichSummary ? (
        <AgentMessageMarkdown
          content={summary}
          className="[&_a]:text-[var(--tutti-purple)] [&_code]:text-[var(--text-secondary)] [&_hr]:border-t-[color-mix(in_srgb,var(--text-primary)_14%,transparent)] [&_ol]:!bg-transparent [&_p]:m-0 [&_th]:bg-[color-mix(in_srgb,var(--background-panel)_94%,var(--text-primary))] [&_th]:text-[var(--text-primary)] [&_ul]:!bg-transparent text-[var(--text-primary)]"
          onLinkAction={handleLinkAction}
          workspaceLinkContext={{
            workspaceRoot: item.cwd || null,
            basePath: item.cwd,
            source: "agent-markdown"
          }}
          enableImageZoom
        />
      ) : summary ? (
        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {summary}
        </div>
      ) : (
        emptyLabel
      )}
    </AgentVerticalScrollArea>
  );
}

function useLazyMessageCenterSummaryReady(
  ref: RefObject<HTMLDivElement | null>,
  lazy: boolean
): boolean {
  const [ready, setReady] = useState(!lazy);

  useEffect(() => {
    setReady(!lazy);
  }, [lazy]);

  useEffect(() => {
    if (!lazy) {
      return undefined;
    }
    if (ready) {
      return undefined;
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setReady(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: MESSAGE_CENTER_SUMMARY_LAZY_ROOT_MARGIN }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [lazy, ready, ref]);

  return ready;
}

function useDeferredMessageCenterSummaryMeasureReady(
  ref: RefObject<HTMLDivElement | null>,
  enabled: boolean
): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return undefined;
    }
    if (ready) {
      return undefined;
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      const timeoutId = window.setTimeout(
        () => setReady(true),
        MESSAGE_CENTER_SUMMARY_OVERFLOW_MEASURE_DELAY_MS
      );
      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    let timeoutId: number | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        observer.disconnect();
        timeoutId = window.setTimeout(
          () => setReady(true),
          MESSAGE_CENTER_SUMMARY_OVERFLOW_MEASURE_DELAY_MS
        );
      },
      { rootMargin: MESSAGE_CENTER_SUMMARY_LAZY_ROOT_MARGIN }
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [enabled, ready, ref]);

  return ready;
}

export function MessageCenterOpenChatButton({
  actionsAccessory,
  alwaysVisible = false,
  item,
  label,
  onOpenChat,
  provider
}: {
  actionsAccessory?: ReactNode;
  alwaysVisible?: boolean;
  item: WorkspaceAgentMessageCenterItem;
  label: string;
  onOpenChat: (input: { agentSessionId: string; provider: string }) => void;
  provider: string;
}): JSX.Element {
  "use memo";

  return (
    <div className="workspace-agent-message-center__footer flex min-w-0 items-center justify-between gap-2">
      <MessageCenterIdentityLabel
        identity={item.identity}
        provider={provider}
      />
      <span className="inline-flex shrink-0 items-center gap-2">
        {actionsAccessory}
        <Button
          type="button"
          variant="ghost"
          size="default"
          className={cn(
            "workspace-agent-message-center__open-chat-button h-auto gap-1.5 border-0 bg-transparent p-0 text-[var(--accent-codex)] shadow-none transition-[color,opacity,visibility] hover:bg-transparent hover:text-[var(--accent-codex)] focus-visible:bg-transparent focus-visible:text-[var(--accent-codex)] active:bg-transparent",
            !alwaysVisible &&
              "invisible opacity-0 group-hover/message-card:visible group-hover/message-card:opacity-100 group-focus-within/message-card:visible group-focus-within/message-card:opacity-100"
          )}
          onClick={() =>
            onOpenChat({
              agentSessionId: item.agentSessionId,
              provider: item.provider
            })
          }
        >
          <ExternalLink
            className="size-[15px]"
            strokeWidth={2.2}
            aria-hidden="true"
          />
          {label}
        </Button>
      </span>
    </div>
  );
}

export function MessageCenterIdentityLabel({
  identity,
  provider
}: {
  identity: WorkspaceAgentMessageCenterIdentity | null;
  provider: string;
}): JSX.Element {
  "use memo";

  if (!identity) {
    return <AgentProviderLabel provider={provider} />;
  }

  const agentAvatarUrl =
    identity.agentAvatarUrl?.trim() || managedAgentRoundedIconUrl(provider);
  const title = `${identity.userName} & ${identity.agentName}`;

  return (
    <span
      className="workspace-agent-message-center__identity inline-flex min-w-0 max-w-full items-center gap-2"
      title={title}
    >
      <MessageCenterIdentityAvatarStack
        userAvatarUrl={identity.userAvatarUrl}
        userName={identity.userName}
        agentAvatarUrl={agentAvatarUrl}
      />
      <span className="workspace-agent-message-center__identity-names flex min-w-0 items-center gap-1 truncate text-[13px] leading-5 text-[var(--text-secondary)]">
        <span className="min-w-0 truncate">{identity.userName}</span>
        <span className="shrink-0 text-[var(--text-tertiary)]">&</span>
        <span className="min-w-0 truncate">{identity.agentName}</span>
      </span>
    </span>
  );
}

export function MessageCenterIdentityAvatarMark({
  identity,
  provider,
  userId
}: {
  identity: WorkspaceAgentMessageCenterIdentity | null;
  provider: string;
  userId?: string | null;
}): JSX.Element {
  "use memo";

  const userName = identity?.userName.trim() || userId?.trim() || "";
  if (!userName) {
    return (
      <img
        src={managedAgentRoundedIconUrl(provider)}
        alt=""
        className="size-5 shrink-0 rounded-full"
        decoding="async"
        loading="lazy"
        draggable={false}
        aria-hidden="true"
      />
    );
  }

  return (
    <MessageCenterIdentityAvatarStack
      userAvatarUrl={identity?.userAvatarUrl}
      userName={userName}
      agentAvatarUrl={
        identity?.agentAvatarUrl?.trim() || managedAgentRoundedIconUrl(provider)
      }
    />
  );
}

export function MessageCenterIdentityAvatarStack({
  agentAvatarUrl,
  userAvatarUrl: rawUserAvatarUrl,
  userName
}: {
  agentAvatarUrl: string;
  userAvatarUrl?: string;
  userName: string;
}): JSX.Element {
  "use memo";
  const [userAvatarFailed, setUserAvatarFailed] = useState(false);
  const userAvatarUrl = rawUserAvatarUrl?.trim() ?? "";
  const userImageUrl =
    userAvatarUrl.length > 0 && !userAvatarFailed
      ? userAvatarUrl
      : userAvatarPlaceholderUrl;

  useEffect(() => {
    setUserAvatarFailed(false);
  }, [userAvatarUrl]);

  return (
    <span
      className="workspace-agent-message-center__identity-avatar-stack inline-flex w-9 shrink-0 items-center"
      aria-hidden="true"
    >
      <span className="inline-flex size-5 shrink-0 overflow-hidden rounded-full bg-[var(--transparency-block)] ring-2 ring-[var(--background-fronted)]">
        <img
          src={userImageUrl}
          alt={userName}
          className="size-full object-cover"
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => {
            setUserAvatarFailed(true);
          }}
        />
      </span>
      <span className="-ml-1.5 inline-flex size-5 shrink-0 overflow-hidden rounded-full bg-[var(--transparency-block)] ring-2 ring-[var(--background-fronted)]">
        <img
          src={agentAvatarUrl}
          alt=""
          className="size-full object-cover"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      </span>
    </span>
  );
}

function ProjectPathInfo({ path }: { path: string }): JSX.Element {
  "use memo";

  return (
    <LazyMessageCenterTooltip
      content={path}
      side="top"
      align="start"
      className="max-w-[320px] text-[11px] [overflow-wrap:anywhere]"
    >
      <button
        type="button"
        className="workspace-agent-message-center__project-info-button invisible inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-[var(--text-secondary)] opacity-0 transition-[background-color,color,opacity,visibility] group-hover/message-card:visible group-hover/message-card:opacity-100 group-focus-within/message-card:visible group-focus-within/message-card:opacity-100 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--transparency-hover)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none"
        aria-label={path}
      >
        <Info className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </button>
    </LazyMessageCenterTooltip>
  );
}

type LazyTooltipChildProps = {
  onBlur?: (event: ReactFocusEvent<HTMLElement>) => void;
  onFocus?: (event: ReactFocusEvent<HTMLElement>) => void;
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void;
};

function LazyMessageCenterTooltip({
  align,
  children,
  className,
  content,
  side
}: {
  align?: "center" | "end" | "start";
  children: ReactElement<LazyTooltipChildProps>;
  className?: string;
  content: ReactNode;
  side?: "bottom" | "left" | "right" | "top";
}): JSX.Element {
  "use memo";
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);

  const showTooltip = useCallback(() => {
    setHydrated(true);
    setOpen(true);
  }, []);
  const hideTooltip = useCallback(() => {
    setOpen(false);
  }, []);

  const trigger = cloneElement(children, {
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      hideTooltip();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      showTooltip();
    },
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerEnter?.(event);
      showTooltip();
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerLeave?.(event);
      hideTooltip();
    }
  });

  if (!hydrated) {
    return trigger;
  }

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side={side} align={align} className={className}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function AgentProviderLabel({ provider }: { provider: string }): JSX.Element {
  "use memo";
  const label = workspaceAgentProviderLabel(provider);

  return (
    <span className="workspace-agent-message-center__provider inline-flex min-w-0 max-w-full items-center gap-1.5">
      <img
        src={managedAgentRoundedIconUrl(provider)}
        alt=""
        className="workspace-agent-message-center__provider-icon size-5 shrink-0 rounded-full"
        decoding="async"
        loading="lazy"
        draggable={false}
        aria-hidden="true"
      />
      <span className="workspace-agent-message-center__provider-name min-w-0 truncate text-[13px] leading-5 text-[var(--text-secondary)]">
        {label}
      </span>
    </span>
  );
}

function statusClass(item: WorkspaceAgentMessageCenterItem): string {
  if (isWaitingMessageCenterItem(item)) {
    return "waiting";
  }
  if (item.status === "idle") {
    return "completed";
  }
  return item.status;
}

export type MessageCenterStatusTone =
  | "amber"
  | "blue"
  | "green"
  | "neutral"
  | "red";

export function messageCenterStatusTone(
  item: WorkspaceAgentMessageCenterItem
): MessageCenterStatusTone {
  if (isWaitingMessageCenterItem(item)) {
    return "amber";
  }
  if (item.status === "completed" || item.status === "idle") {
    return "green";
  }
  if (item.status === "canceled") {
    return "amber";
  }
  if (item.status === "failed") {
    return "red";
  }
  if (item.status === "working") {
    return "blue";
  }
  return "neutral";
}

export function messageCenterStatusToneClass(
  tone: MessageCenterStatusTone
): string {
  switch (tone) {
    case "amber":
      return "text-[var(--state-warning)]";
    case "blue":
      return "text-[var(--status-running)]";
    case "green":
      return "text-[var(--state-success)]";
    case "red":
      return "text-[var(--state-danger)]";
    case "neutral":
      return "text-[var(--text-secondary)]";
  }
}
