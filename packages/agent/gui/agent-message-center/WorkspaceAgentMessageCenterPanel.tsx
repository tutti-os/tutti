import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";
import {
  Button,
  cn,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  StatusDot,
  TooltipProvider
} from "@tutti-os/ui-system";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  AgentGuiI18nProvider,
  useTranslation,
  type AgentGuiI18nLocale
} from "../i18n/index";
import { AgentVerticalScrollArea } from "../shared/AgentVerticalScrollArea";
import type { WorkspaceLinkAction } from "../actions/workspaceLinkActions";
import {
  isInteractiveMessageCenterItem,
  selectMessageCenterAttentionDeckItems,
  type WorkspaceAgentMessageCenterItem,
  type WorkspaceAgentMessageCenterModel
} from "./workspaceAgentMessageCenterModel";
import { WorkspaceAgentMessageCenterAttentionDeck } from "./WorkspaceAgentMessageCenterAttentionDeck";
import { MessageCenterViewMenu } from "./WorkspaceAgentMessageCenterViewControls";
import {
  MessageCenterIdentityAvatarMark,
  MessageCenterIdentityLabel,
  messageCenterStatusToneClass,
  resolveMessageCenterNotificationAction,
  WorkspaceAgentMessageCenterStack,
  WorkspaceAgentMessageCenterCard,
  type MessageCenterStatusTone,
  type WorkspaceAgentMessageCenterCardProps
} from "./WorkspaceAgentMessageCenterCard";
import {
  buildMessageCenterProviderOptions,
  buildMessageCenterStatusOptions,
  groupMessageCenterItems,
  itemMatchesViewFilters,
  messageCenterStackRenderId,
  messageCenterStackScrollSyncSegment,
  partitionMessageCenterItemsByAgentUser,
  statusFilterSummary,
  type MessageCenterGroupBy,
  type MessageCenterStatusFilter
} from "./workspaceAgentMessageCenterViewModel";
import {
  readMessageCenterFilterPreferences,
  writeMessageCenterFilterPreferences
} from "./messageCenterFilterPreferences";

export {
  buildWorkspaceAgentInteractivePromptLabels,
  WorkspaceAgentMessageCenterCard
} from "./WorkspaceAgentMessageCenterCard";
export type { WorkspaceAgentMessageCenterCardProps } from "./WorkspaceAgentMessageCenterCard";

const MESSAGE_CENTER_TOOLTIP_DELAY_MS = 300;
const MESSAGE_CENTER_STACK_EAGER_SUMMARY_COUNT = 8;

type WorkspaceAgentMessageCenterPromptInput = Parameters<
  WorkspaceAgentMessageCenterCardProps["onSubmitPrompt"]
>[0];

export interface WorkspaceAgentMessageCenterPanelProps {
  i18n?: I18nRuntime<string> | null;
  locale?: AgentGuiI18nLocale;
  open: boolean;
  model: WorkspaceAgentMessageCenterModel;
  highlightedItemId?: string | null;
  portalContainer?: HTMLElement | null;
  onClose: () => void;
  onHighlightedItemSettled?: (itemId: string) => void;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onNotificationActioned?: (input: {
    action: string;
    provider: string;
  }) => void;
  onOpenChat: (input: { agentSessionId: string; provider: string }) => void;
  onSubmitPrompt: (input: {
    action?: string;
    agentSessionId: string;
    optionId?: string;
    payload?: Record<string, unknown>;
    promptKind?: string;
    requestId: string;
  }) => Promise<void> | void;
}

export const WorkspaceAgentMessageCenterPanel = memo(
  function WorkspaceAgentMessageCenterPanel({
    open,
    i18n,
    locale,
    model,
    highlightedItemId = null,
    portalContainer = null,
    onClose,
    onHighlightedItemSettled,
    onLinkAction,
    onNotificationActioned,
    onOpenChat,
    onSubmitPrompt
  }: WorkspaceAgentMessageCenterPanelProps): JSX.Element | null {
    "use memo";
    if (!open) {
      return null;
    }
    return (
      <AgentGuiI18nProvider runtime={i18n} locale={locale}>
        <WorkspaceAgentMessageCenterPanelContent
          open={open}
          model={model}
          highlightedItemId={highlightedItemId}
          portalContainer={portalContainer}
          onClose={onClose}
          onHighlightedItemSettled={onHighlightedItemSettled}
          onLinkAction={onLinkAction}
          onNotificationActioned={onNotificationActioned}
          onOpenChat={onOpenChat}
          onSubmitPrompt={onSubmitPrompt}
        />
      </AgentGuiI18nProvider>
    );
  }
);

function WorkspaceAgentMessageCenterPanelContent({
  open,
  model,
  highlightedItemId = null,
  portalContainer = null,
  onClose,
  onHighlightedItemSettled,
  onLinkAction,
  onNotificationActioned,
  onOpenChat,
  onSubmitPrompt
}: Omit<
  WorkspaceAgentMessageCenterPanelProps,
  "i18n" | "locale"
>): JSX.Element | null {
  "use memo";
  const { t } = useTranslation();
  const [initialFilters] = useState(readMessageCenterFilterPreferences);
  const [groupBy, setGroupBy] = useState<MessageCenterGroupBy>(
    initialFilters.groupBy
  );
  const [statusFilters, setStatusFilters] =
    useState<Set<MessageCenterStatusFilter> | null>(
      initialFilters.statusFilters
    );
  const [providerFilters, setProviderFilters] = useState<Set<string> | null>(
    initialFilters.providerFilters
  );
  useEffect(() => {
    writeMessageCenterFilterPreferences({
      groupBy,
      statusFilters,
      providerFilters
    });
  }, [groupBy, statusFilters, providerFilters]);
  const [expandedStackIds, setExpandedStackIds] = useState<Set<string>>(
    () => new Set()
  );
  const [submittingPromptKey, setSubmittingPromptKey] = useState<string | null>(
    null
  );
  const itemNodesRef = useRef<Map<string, HTMLElement>>(new Map());
  const lastScrolledHighlightedItemIdRef = useRef<string | null>(null);
  const lastFilterResetHighlightedItemIdRef = useRef<string | null>(null);
  const statusOptions = useMemo(
    () => buildMessageCenterStatusOptions(model.counts, t),
    [model.counts, t]
  );
  const providerOptions = useMemo(
    () => buildMessageCenterProviderOptions(model.items),
    [model.items]
  );
  const visibleItems = useMemo(
    () =>
      model.items.filter((item) =>
        itemMatchesViewFilters({
          item,
          providerFilters,
          statusFilters
        })
      ),
    [model.items, providerFilters, statusFilters]
  );
  const deckItems = useMemo(
    () => selectMessageCenterAttentionDeckItems(visibleItems),
    [visibleItems]
  );
  const listItems = useMemo(
    () => visibleItems.filter((item) => !isInteractiveMessageCenterItem(item)),
    [visibleItems]
  );
  const itemGroups = useMemo(
    () => groupMessageCenterItems(listItems, groupBy, t),
    [groupBy, t, listItems]
  );
  const itemGroupStacks = useMemo(
    () =>
      itemGroups.map((group) => ({
        ...group,
        stacks: partitionMessageCenterItemsByAgentUser(group.items)
      })),
    [itemGroups]
  );
  const highlightedItem = useMemo(
    () =>
      highlightedItemId
        ? (model.items.find((item) => item.id === highlightedItemId) ?? null)
        : null,
    [highlightedItemId, model.items]
  );
  const activeStatusSummary = statusFilterSummary(statusFilters, statusOptions);
  const scrollSyncKey = useMemo(
    () =>
      [
        groupBy,
        activeStatusSummary,
        ...deckItems.map((item) => `deck:${item.id}`),
        ...itemGroupStacks.flatMap((group) =>
          group.stacks.map((stack) => {
            const stackId = messageCenterStackRenderId(group.id, stack.id);
            return messageCenterStackScrollSyncSegment({
              expanded: expandedStackIds.has(stackId),
              groupId: group.id,
              stack
            });
          })
        )
      ].join("|"),
    [activeStatusSummary, deckItems, expandedStackIds, groupBy, itemGroupStacks]
  );
  const hasActiveFilters = statusFilters !== null || providerFilters !== null;
  const headerSummary = useMemo(() => {
    if (hasActiveFilters) {
      return t("agentHost.workspaceAgentMessageCenterSummaryFiltered", {
        count: visibleItems.length,
        total: model.counts.all
      });
    }
    if (model.counts.waiting > 0) {
      return t("agentHost.workspaceAgentMessageCenterSummaryWaiting", {
        count: model.counts.all,
        waiting: model.counts.waiting
      });
    }
    if (model.counts.completed > 0) {
      return t("agentHost.workspaceAgentMessageCenterSummaryCompleted", {
        count: model.counts.all,
        completed: model.counts.completed
      });
    }
    return t("agentHost.workspaceAgentMessageCenterSummaryCount", {
      count: model.counts.all
    });
  }, [
    hasActiveFilters,
    model.counts.all,
    model.counts.completed,
    model.counts.waiting,
    t,
    visibleItems.length
  ]);

  const submitPrompt = useCallback(
    async (
      item: WorkspaceAgentMessageCenterItem,
      input: {
        action?: string;
        optionId?: string;
        payload?: Record<string, unknown>;
        requestId: string;
      }
    ) => {
      const promptKey = `${item.agentSessionId}:${input.requestId}`;
      setSubmittingPromptKey(promptKey);
      try {
        const notificationAction = resolveMessageCenterNotificationAction(
          item,
          input
        );
        if (notificationAction) {
          onNotificationActioned?.({
            action: notificationAction,
            provider: item.provider
          });
        }
        await onSubmitPrompt({
          ...input,
          agentSessionId: item.agentSessionId,
          promptKind: item.pendingPrompt?.kind
        });
      } finally {
        setSubmittingPromptKey((current) =>
          current === promptKey ? null : current
        );
      }
    },
    [onNotificationActioned, onSubmitPrompt]
  );
  const setItemNode = useCallback(
    (itemId: string, node: HTMLElement | null) => {
      if (node) {
        itemNodesRef.current.set(itemId, node);
      } else {
        itemNodesRef.current.delete(itemId);
      }
    },
    []
  );
  const toggleStatusFilter = useCallback(
    (status: MessageCenterStatusFilter) => {
      setStatusFilters((current) => {
        const next = new Set(
          current ?? statusOptions.map((option) => option.value)
        );
        if (next.has(status)) {
          next.delete(status);
        } else {
          next.add(status);
        }
        return next.size === statusOptions.length ? null : next;
      });
    },
    [statusOptions]
  );
  const toggleProviderFilter = useCallback(
    (provider: string) => {
      setProviderFilters((current) => {
        const next = new Set(
          current ?? providerOptions.map((option) => option.value)
        );
        if (next.has(provider)) {
          next.delete(provider);
        } else {
          next.add(provider);
        }
        return next.size === providerOptions.length ? null : next;
      });
    },
    [providerOptions]
  );
  const clearFilters = useCallback(() => {
    setStatusFilters(null);
    setProviderFilters(null);
  }, []);
  const expandStack = useCallback((groupId: string) => {
    setExpandedStackIds((current) => {
      if (current.has(groupId)) {
        return current;
      }
      const next = new Set(current);
      next.add(groupId);
      return next;
    });
  }, []);
  const collapseStack = useCallback((groupId: string) => {
    setExpandedStackIds((current) => {
      if (!current.has(groupId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    if (!open || !highlightedItem) {
      return;
    }
    if (lastFilterResetHighlightedItemIdRef.current === highlightedItem.id) {
      return;
    }
    if (
      itemMatchesViewFilters({
        item: highlightedItem,
        providerFilters,
        statusFilters
      })
    ) {
      return;
    }
    lastFilterResetHighlightedItemIdRef.current = highlightedItem.id;
    setStatusFilters(null);
    setProviderFilters(null);
  }, [highlightedItem, open, providerFilters, statusFilters]);

  useLayoutEffect(() => {
    if (!open || !highlightedItemId) {
      return;
    }
    for (const group of itemGroupStacks) {
      for (const stack of group.stacks) {
        if (
          stack.items.length > 1 &&
          stack.items.some((item) => item.id === highlightedItemId)
        ) {
          expandStack(messageCenterStackRenderId(group.id, stack.id));
          return;
        }
      }
    }
  }, [expandStack, highlightedItemId, itemGroupStacks, open]);

  useLayoutEffect(() => {
    if (!open || !highlightedItemId) {
      lastScrolledHighlightedItemIdRef.current = null;
      return;
    }
    if (
      highlightedItem &&
      !itemMatchesViewFilters({
        item: highlightedItem,
        providerFilters,
        statusFilters
      })
    ) {
      return;
    }
    if (lastScrolledHighlightedItemIdRef.current === highlightedItemId) {
      return;
    }
    const target = itemNodesRef.current.get(highlightedItemId);
    if (!target) {
      return;
    }
    lastScrolledHighlightedItemIdRef.current = highlightedItemId;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
  }, [
    expandedStackIds,
    highlightedItem,
    highlightedItemId,
    open,
    providerFilters,
    statusFilters,
    visibleItems
  ]);

  useEffect(() => {
    if (!open || !highlightedItemId) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      onHighlightedItemSettled?.(highlightedItemId);
    }, 3200);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [highlightedItemId, onHighlightedItemSettled, open]);

  const renderMessageCenterCard = useCallback(
    (
      item: WorkspaceAgentMessageCenterItem,
      options: { stackedIndex?: number } = {}
    ) => {
      const highlighted = item.id === highlightedItemId;
      const stackedIndex = options.stackedIndex;
      const card = (
        <MessageCenterRenderedCard
          key={item.agentSessionId}
          highlighted={highlighted}
          item={item}
          isSubmitting={
            submittingPromptKey ===
            `${item.agentSessionId}:${item.pendingPrompt?.requestId}`
          }
          lazySummary={
            stackedIndex !== undefined &&
            stackedIndex >= MESSAGE_CENTER_STACK_EAGER_SUMMARY_COUNT
          }
          registerNode={setItemNode}
          onLinkAction={onLinkAction}
          onOpenChat={onOpenChat}
          onSubmitPrompt={submitPrompt}
        />
      );

      if (stackedIndex === undefined) {
        return card;
      }

      return (
        <div
          key={item.agentSessionId}
          className="min-w-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none"
          style={{
            animationDelay: `${Math.min(stackedIndex * 24, 96)}ms`
          }}
        >
          {card}
        </div>
      );
    },
    [
      highlightedItemId,
      onLinkAction,
      onOpenChat,
      setItemNode,
      submitPrompt,
      submittingPromptKey
    ]
  );

  return (
    <Drawer
      open={open}
      direction="right"
      handleOnly
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DrawerContent
        className={cn(
          "t-modal nodrag min-h-0 w-[min(440px,calc(100vw-16px))] max-w-none overflow-hidden rounded-none border-y-0 border-r-0 bg-[var(--background-panel)] text-[var(--text-primary)] shadow-side-panel data-[vaul-drawer-direction=right]:rounded-none",
          "[-webkit-app-region:no-drag]"
        )}
        data-testid="workspace-agent-message-center"
        portalContainer={portalContainer ?? undefined}
        showOverlay={false}
        aria-label={t("agentHost.workspaceAgentMessageCenterTitle")}
      >
        <TooltipProvider delayDuration={MESSAGE_CENTER_TOOLTIP_DELAY_MS}>
          <div className="flex-none border-b border-[var(--border-1)] px-3.5 pt-3 pb-3">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <DrawerTitle className="truncate text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
                  {t("agentHost.workspaceAgentMessageCenterTitle")}
                </DrawerTitle>
                <DrawerDescription className="truncate text-[11px] leading-4 text-[var(--text-tertiary)]">
                  {headerSummary}
                </DrawerDescription>
              </div>
              <MessageCenterViewMenu
                filtersActive={hasActiveFilters}
                groupBy={groupBy}
                providerFilters={providerFilters}
                providerOptions={providerOptions}
                statusFilters={statusFilters}
                statusOptions={statusOptions}
                onClearFilters={clearFilters}
                onGroupByChange={setGroupBy}
                onProviderToggle={toggleProviderFilter}
                onStatusToggle={toggleStatusFilter}
              />
            </div>
          </div>

          <AgentVerticalScrollArea
            className="min-h-0 flex-1"
            viewportClassName="flex h-full w-full flex-col px-3.5 pt-4 pb-4"
            scrollbarClassName="top-4 bottom-4"
            syncKey={scrollSyncKey}
          >
            {deckItems.length > 0 || listItems.length > 0 ? (
              <div className="flex w-full min-w-0 flex-col gap-4">
                {deckItems.length > 0 ? (
                  <WorkspaceAgentMessageCenterAttentionDeck
                    items={deckItems}
                    highlightedItemId={highlightedItemId}
                    submittingPromptKey={submittingPromptKey}
                    registerNode={setItemNode}
                    onLinkAction={onLinkAction}
                    onOpenChat={onOpenChat}
                    onSubmitPrompt={(item, input) =>
                      void submitPrompt(item, input)
                    }
                  />
                ) : null}
                {itemGroupStacks.map((group) => (
                  <section
                    key={group.id}
                    className="flex min-w-0 flex-col gap-2.5"
                    aria-label={`${group.label} ${group.items.length}`}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-3 px-0.5">
                      <MessageCenterGroupHeading group={group} />
                    </div>
                    {(() => {
                      return group.stacks.map((stack) => {
                        const firstItem = stack.items[0];
                        if (!firstItem) {
                          return null;
                        }
                        if (stack.items.length === 1) {
                          return renderMessageCenterCard(firstItem);
                        }
                        const stackId = messageCenterStackRenderId(
                          group.id,
                          stack.id
                        );
                        return (
                          <MessageCenterStack
                            key={stackId}
                            expanded={expandedStackIds.has(stackId)}
                            groupId={stackId}
                            highlightedItemId={highlightedItemId}
                            items={stack.items}
                            renderCard={renderMessageCenterCard}
                            onCollapse={collapseStack}
                            onExpand={expandStack}
                          />
                        );
                      });
                    })()}
                  </section>
                ))}
              </div>
            ) : model.items.length > 0 ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-6 py-8 text-center text-[13px] text-[var(--text-tertiary)]">
                <span>
                  {t("agentHost.workspaceAgentMessageCenterFilteredEmpty")}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="border border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  onClick={clearFilters}
                >
                  {t("agentHost.workspaceAgentMessageCenterClearFilters")}
                </Button>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center text-[13px] text-[var(--text-tertiary)]">
                {t("agentHost.workspaceAgentMessageCenterEmpty")}
              </div>
            )}
          </AgentVerticalScrollArea>
        </TooltipProvider>
      </DrawerContent>
    </Drawer>
  );
}

const MessageCenterCard = WorkspaceAgentMessageCenterCard;
const MessageCenterStack = WorkspaceAgentMessageCenterStack;

const MessageCenterRenderedCard = memo(function MessageCenterRenderedCard({
  highlighted,
  isSubmitting,
  item,
  lazySummary,
  onLinkAction,
  onOpenChat,
  onSubmitPrompt,
  registerNode
}: {
  highlighted: boolean;
  isSubmitting: boolean;
  item: WorkspaceAgentMessageCenterItem;
  lazySummary: boolean;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onOpenChat: (input: { agentSessionId: string; provider: string }) => void;
  onSubmitPrompt: (
    item: WorkspaceAgentMessageCenterItem,
    input: WorkspaceAgentMessageCenterPromptInput
  ) => void;
  registerNode: (itemId: string, node: HTMLElement | null) => void;
}): JSX.Element {
  const cardRef = useCallback(
    (node: HTMLElement | null) => {
      registerNode(item.id, node);
    },
    [item.id, registerNode]
  );
  const handleSubmitPrompt = useCallback(
    (input: WorkspaceAgentMessageCenterPromptInput) => {
      onSubmitPrompt(item, input);
    },
    [item, onSubmitPrompt]
  );

  return (
    <MessageCenterCard
      cardRef={cardRef}
      highlighted={highlighted}
      item={item}
      isSubmitting={isSubmitting}
      lazySummary={lazySummary}
      onLinkAction={onLinkAction}
      onOpenChat={onOpenChat}
      onSubmitPrompt={handleSubmitPrompt}
    />
  );
});

export function MessageCenterGroupHeading({
  group
}: {
  group: ReturnType<typeof groupMessageCenterItems>[number];
}): JSX.Element {
  "use memo";
  const statusSignal = messageCenterGroupStatusSignal(group.id);

  if (group.provider) {
    return (
      <h3
        aria-label={`${group.label} · ${group.items.length}`}
        className="flex min-w-0 items-center gap-1.5 text-[11px] font-normal leading-4 text-[var(--text-tertiary)]"
        title={`${group.label} · ${group.items.length}`}
      >
        {group.identity ? (
          <MessageCenterIdentityLabel
            identity={group.identity}
            provider={group.provider}
          />
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <MessageCenterIdentityAvatarMark
              identity={null}
              provider={group.provider}
              userId={group.userId ?? null}
            />
            <span className="min-w-0 truncate">{group.label}</span>
          </span>
        )}
        <span className="shrink-0">· {group.items.length}</span>
      </h3>
    );
  }

  return (
    <h3
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-[11px] font-normal leading-4",
        statusSignal
          ? messageCenterStatusToneClass(statusSignal.tone)
          : "text-[var(--text-tertiary)]"
      )}
      title={`${group.label} · ${group.items.length}`}
    >
      {statusSignal ? (
        <StatusDot
          tone={statusSignal.tone}
          pulse={statusSignal.pulse}
          size="sm"
          title={group.label}
        />
      ) : null}
      <span className="min-w-0 truncate">
        {group.label} · {group.items.length}
      </span>
    </h3>
  );
}

function messageCenterGroupStatusSignal(groupId: string): {
  pulse: boolean;
  tone: Exclude<MessageCenterStatusTone, "neutral">;
} | null {
  switch (groupId) {
    case "needs-attention":
    case "waiting":
      return { pulse: true, tone: "amber" };
    case "working":
      return { pulse: true, tone: "blue" };
    case "failed":
      return { pulse: false, tone: "red" };
    case "recently-completed":
    case "completed":
      return { pulse: false, tone: "green" };
    default:
      return null;
  }
}
