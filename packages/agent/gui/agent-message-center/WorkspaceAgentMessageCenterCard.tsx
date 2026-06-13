import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { ChevronDown, ChevronUp, ExternalLink, Info } from "lucide-react";
import {
  Button,
  cn,
  StatusDot,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { useTranslation } from "../i18n/index";
import { normalizeAgentTitleText } from "../shared/utils/agentTitleText";
import { AgentInteractivePromptSurface } from "../shared/agentConversation/components/AgentInteractivePromptSurface";
import { AgentMessageMarkdown } from "../shared/AgentMessageMarkdown";
import { AgentVerticalScrollArea } from "../shared/AgentVerticalScrollArea";
import { managedAgentRoundedIconUrl } from "../shared/managedAgentIcons";
import { workspaceAgentActivityStatusLabel } from "../shared/workspaceAgentActivityStatusLabel";
import { workspaceAgentProviderLabel } from "../shared/workspaceAgentProviderLabel";
import userAvatarPlaceholderUrl from "../app/renderer/assets/icons/user-avatar-placeholder.png";
import type { WorkspaceLinkAction } from "../actions/workspaceLinkActions";
import {
  isWaitingMessageCenterItem,
  type WorkspaceAgentMessageCenterIdentity,
  type WorkspaceAgentMessageCenterItem
} from "./workspaceAgentMessageCenterModel";

export interface WorkspaceAgentMessageCenterCardProps {
  item: WorkspaceAgentMessageCenterItem;
  cardRef?: (node: HTMLElement | null) => void;
  highlighted?: boolean;
  isSubmitting: boolean;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onOpenChat: (input: { agentSessionId: string; provider: string }) => void;
  onSubmitPrompt: (input: {
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
    requestId: string;
  }) => void;
}

function stopMessageCenterTextPointerPropagation(
  event: ReactPointerEvent<HTMLElement>
): void {
  event.stopPropagation();
}

export function WorkspaceAgentMessageCenterCard({
  cardRef,
  highlighted = false,
  item,
  isSubmitting,
  onLinkAction,
  onOpenChat,
  onSubmitPrompt
}: WorkspaceAgentMessageCenterCardProps): JSX.Element {
  "use memo";
  const { t } = useTranslation();
  const prompt = item.pendingPrompt;
  const displayTitle = normalizeAgentTitleText(item.title);
  const summary = messageCenterVisibleSummary(item);
  const displayStatus = statusClass(item);
  const statusLabel = workspaceAgentActivityStatusLabel(displayStatus, t);

  return (
    <article
      ref={cardRef}
      className={cn(
        "workspace-agent-message-center__card group/message-card flex min-w-0 flex-col gap-2.5 rounded-lg border border-[var(--line-2)] bg-[var(--background-fronted)] p-3.5 outline outline-0 outline-offset-2 outline-transparent transition-[background-color,border-color,outline-color]",
        isWaitingMessageCenterItem(item) &&
          "agent-gui-edge-glow border-[var(--border-focus)] bg-[var(--accent-bg)]",
        highlighted && "outline-2 outline-[var(--accent)]"
      )}
      data-highlighted={highlighted ? "true" : undefined}
      data-message-center-item-id={item.id}
      data-waiting={isWaitingMessageCenterItem(item) ? "true" : undefined}
      data-status={displayStatus}
      tabIndex={highlighted ? -1 : undefined}
    >
      <div className="flex min-w-0 items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <h3
                className="workspace-agent-message-center__copy-text min-w-0 truncate text-sm font-bold leading-5 text-[var(--text-secondary)]"
                onPointerDown={stopMessageCenterTextPointerPropagation}
              >
                {displayTitle}
              </h3>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="max-w-[min(360px,calc(100vw-32px))] whitespace-normal text-left [overflow-wrap:anywhere]"
            >
              {displayTitle}
            </TooltipContent>
          </Tooltip>
          {item.cwd ? <ProjectPathInfo path={item.cwd} /> : null}
        </div>
        <span
          className="workspace-agent-message-center__status inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold leading-4 text-[var(--text-secondary)]"
          data-status={displayStatus}
          title={statusLabel}
        >
          <StatusDot
            tone={messageCenterStatusTone(item)}
            pulse={
              isWaitingMessageCenterItem(item) || item.status === "working"
            }
            size="sm"
            title={statusLabel}
          />
          <span>{statusLabel}</span>
        </span>
      </div>

      {summary ? (
        <MessageCenterSummary
          item={item}
          onLinkAction={onLinkAction}
          summary={summary}
          emptyLabel={t("agentHost.workspaceAgentMessageCenterNoSummary")}
        />
      ) : null}

      {prompt ? (
        <div className="min-w-0">
          <AgentInteractivePromptSurface
            embedded
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

      <MessageCenterOpenChatButton
        provider={item.provider}
        item={item}
        label={t("agentHost.workspaceAgentMessageCenterOpenChat")}
        onOpenChat={onOpenChat}
      />
    </article>
  );
}

const STACK_PRESENCE_FALLBACK_MS = 380;

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

export function WorkspaceAgentMessageCenterStack({
  className,
  expanded,
  groupId,
  items,
  renderCard,
  onCollapse,
  onExpand
}: {
  className?: string;
  expanded: boolean;
  groupId: string;
  items: WorkspaceAgentMessageCenterItem[];
  renderCard: (
    item: WorkspaceAgentMessageCenterItem,
    options?: { stackedIndex?: number }
  ) => ReactNode;
  onCollapse: () => void;
  onExpand: () => void;
}): JSX.Element | null {
  "use memo";
  const { t } = useTranslation();
  const summaryRegion = useStackRegionPresence(!expanded);
  const cardsRegion = useStackRegionPresence(expanded);
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
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold leading-4 text-[var(--text-tertiary)]">
                <img
                  src={managedAgentRoundedIconUrl(items[0]?.provider ?? "")}
                  alt=""
                  className="size-4 shrink-0 rounded-[4px]"
                  decoding="async"
                  loading="lazy"
                  draggable={false}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">
                  {t("agentHost.workspaceAgentMessageCenterStackSummaryCount", {
                    count: items.length
                  })}
                </span>
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={collapseLabel}
                    className="size-6 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    onClick={onCollapse}
                  >
                    <ChevronUp className="size-3.5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="center">
                  {collapseLabel}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex min-w-0 flex-col gap-2.5">
              {items.map((item, stackedIndex) =>
                renderCard(item, { stackedIndex })
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MessageCenterStackSummary({
  groupId,
  items,
  onExpand
}: {
  groupId: string;
  items: WorkspaceAgentMessageCenterItem[];
  onExpand: () => void;
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
      data-testid={`workspace-agent-message-stack-summary-${groupId}`}
      onClick={onExpand}
    >
      <span
        className={cn(
          "relative z-10 flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--line-2)] bg-[var(--background-fronted)] p-3.5 transition-[background-color,border-color] duration-200 group-hover/stack-peek:bg-[var(--transparency-hover)]",
          items.length > 2
            ? "shadow-[0_7px_0_-4px_var(--background-fronted),0_7px_0_-3px_var(--line-2),0_14px_0_-8px_var(--background-fronted),0_14px_0_-7px_var(--line-2)]"
            : "shadow-[0_7px_0_-4px_var(--background-fronted),0_7px_0_-3px_var(--line-2)]",
          hasWaiting && "border-[var(--border-focus)] bg-[var(--accent-bg)]"
        )}
      >
        <span className="flex min-w-0 items-center justify-between gap-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <img
              src={managedAgentRoundedIconUrl(firstItem.provider)}
              alt=""
              className="size-5 shrink-0 rounded-[4px]"
              decoding="async"
              loading="lazy"
              draggable={false}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-sm font-bold leading-5 text-[var(--text-secondary)]">
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
            {messageCenterStackPreviewText(firstItem)}
          </span>
        </span>
      </span>
    </button>
  );
}

function messageCenterStackPreviewText(
  item: WorkspaceAgentMessageCenterItem
): string {
  return (
    item.lastAgentMessageSummary.trim() || normalizeAgentTitleText(item.title)
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
  const summary = item.lastAgentMessageSummary.trim();
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

function MessageCenterSummary({
  emptyLabel,
  item,
  onLinkAction,
  summary
}: {
  emptyLabel: string;
  item: WorkspaceAgentMessageCenterItem;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  summary: string;
}): JSX.Element {
  "use memo";
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
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

  useLayoutEffect(() => {
    const element = summaryRef.current;
    if (!element) {
      return;
    }

    const updateOverflowState = () => {
      setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    };

    updateOverflowState();
    const resizeObserver = new ResizeObserver(updateOverflowState);
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
    };
  }, [summary]);

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
      {summary ? (
        <AgentMessageMarkdown
          content={summary}
          className="[&_a]:text-[var(--accent)] [&_code]:text-[var(--text-secondary)] [&_hr]:border-t-[color-mix(in_srgb,var(--text-primary)_14%,transparent)] [&_ol]:!bg-transparent [&_p]:m-0 [&_th]:bg-[color-mix(in_srgb,var(--background-panel)_94%,var(--text-primary))] [&_th]:text-[var(--text-primary)] [&_ul]:!bg-transparent text-[var(--text-primary)]"
          onLinkAction={handleLinkAction}
          workspaceLinkContext={{
            workspaceRoot: item.cwd || null,
            basePath: item.cwd,
            source: "agent-markdown"
          }}
          enableImageZoom
        />
      ) : (
        emptyLabel
      )}
    </AgentVerticalScrollArea>
  );
}

function MessageCenterOpenChatButton({
  item,
  label,
  onOpenChat,
  provider
}: {
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
      <Button
        type="button"
        variant="ghost"
        size="default"
        className="workspace-agent-message-center__open-chat-button invisible h-auto gap-1.5 border-0 bg-transparent p-0 text-[var(--agent-gui-accent)] opacity-0 shadow-none transition-[color,opacity,visibility] group-hover/message-card:visible group-hover/message-card:opacity-100 group-focus-within/message-card:visible group-focus-within/message-card:opacity-100 hover:bg-transparent hover:text-[var(--agent-gui-accent)] focus-visible:bg-transparent focus-visible:text-[var(--agent-gui-accent)] active:bg-transparent"
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
    </div>
  );
}

function MessageCenterIdentityLabel({
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
      <span className="workspace-agent-message-center__identity-names flex min-w-0 items-center gap-1 truncate text-[var(--text-secondary)]">
        <span className="min-w-0 truncate">{identity.userName}</span>
        <span className="shrink-0 text-[var(--text-tertiary)]">&</span>
        <span className="min-w-0 truncate">{identity.agentName}</span>
      </span>
    </span>
  );
}

function MessageCenterIdentityAvatarStack({
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
      <span className="-ml-1.5 inline-flex size-5 shrink-0 overflow-hidden rounded-[5px] bg-[var(--transparency-block)] ring-2 ring-[var(--background-fronted)]">
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="workspace-agent-message-center__project-info-button invisible inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-[var(--text-secondary)] opacity-0 transition-[background-color,color,opacity,visibility] group-hover/message-card:visible group-hover/message-card:opacity-100 group-focus-within/message-card:visible group-focus-within/message-card:opacity-100 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--transparency-hover)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none"
          aria-label={path}
        >
          <Info className="size-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-[320px] text-xs [overflow-wrap:anywhere]"
      >
        {path}
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
        className="workspace-agent-message-center__provider-icon size-5 shrink-0 rounded-[4px]"
        decoding="async"
        loading="lazy"
        draggable={false}
        aria-hidden="true"
      />
      <span className="workspace-agent-message-center__provider-name min-w-0 truncate text-[var(--text-secondary)]">
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

function messageCenterStatusTone(
  item: WorkspaceAgentMessageCenterItem
): "amber" | "blue" | "green" | "neutral" | "red" {
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
