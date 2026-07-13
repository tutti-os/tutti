import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from "react";
import { cn } from "@tutti-os/ui-system";
import { useTranslation } from "../i18n/index";
import type { WorkspaceLinkAction } from "../actions/workspaceLinkActions";
import { WorkspaceAgentMessageCenterCard } from "./WorkspaceAgentMessageCenterCard";
import type { WorkspaceAgentMessageCenterItem } from "./workspaceAgentMessageCenterModel";

const DECK_MAX_PEEK = 2;
const DECK_NEW_CARD_COOLDOWN_MS = 500;
const DECK_LEAVE_ANIMATION_FALLBACK_MS = 420;

export interface WorkspaceAgentMessageCenterAttentionDeckProps {
  items: WorkspaceAgentMessageCenterItem[];
  highlightedItemId?: string | null;
  isPromptSubmitting: (item: WorkspaceAgentMessageCenterItem) => boolean;
  registerNode?: (itemId: string, node: HTMLElement | null) => void;
  renderCard?: (
    input: WorkspaceAgentMessageCenterAttentionDeckRenderCardInput
  ) => ReactNode;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onOpenChat: (input: { agentSessionId: string; provider: string }) => void;
  onSubmitPrompt: (
    item: WorkspaceAgentMessageCenterItem,
    input: {
      action?: string;
      optionId?: string;
      payload?: Record<string, unknown>;
      requestId: string;
    }
  ) => void;
}

export interface WorkspaceAgentMessageCenterAttentionDeckRenderCardInput {
  cardRef?: (node: HTMLElement | null) => void;
  highlighted: boolean;
  interactive: boolean;
  isSubmitting: boolean;
  item: WorkspaceAgentMessageCenterItem;
  onSubmitPrompt: (input: {
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
    requestId: string;
  }) => void;
}

export function WorkspaceAgentMessageCenterAttentionDeck({
  items,
  highlightedItemId = null,
  isPromptSubmitting,
  registerNode,
  renderCard,
  onLinkAction,
  onOpenChat,
  onSubmitPrompt
}: WorkspaceAgentMessageCenterAttentionDeckProps): JSX.Element | null {
  "use memo";
  const { t } = useTranslation();

  const ordered = useMemo(
    () => orderDeckItems(items, highlightedItemId),
    [items, highlightedItemId]
  );

  // Derive topRequestId using optional chaining so it is safe when ordered[0] is undefined.
  // All hooks must run before the early-return guard.
  const topRequestId = ordered[0]?.pendingPrompt?.requestId ?? null;
  const topPromotedByHighlight =
    ordered[0]?.id === highlightedItemId && highlightedItemId !== null;
  const previousTopRequestIdRef = useRef<string | null>(null);
  const [cooldownRequestId, setCooldownRequestId] = useState<string | null>(
    null
  );

  useEffect(() => {
    const previousTopRequestId = previousTopRequestIdRef.current;
    previousTopRequestIdRef.current = topRequestId;
    if (
      !topRequestId ||
      topPromotedByHighlight ||
      previousTopRequestId === null ||
      previousTopRequestId === topRequestId
    ) {
      return undefined;
    }
    setCooldownRequestId(topRequestId);
    const timeoutId = window.setTimeout(() => {
      setCooldownRequestId((current) =>
        current === topRequestId ? null : current
      );
    }, DECK_NEW_CARD_COOLDOWN_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [topPromotedByHighlight, topRequestId]);

  const isTopCoolingDown =
    cooldownRequestId !== null && cooldownRequestId === topRequestId;

  const previousTopItemRef = useRef<WorkspaceAgentMessageCenterItem | null>(
    null
  );
  const [leavingItem, setLeavingItem] =
    useState<WorkspaceAgentMessageCenterItem | null>(null);

  useEffect(() => {
    const previousTopItem = previousTopItemRef.current;
    previousTopItemRef.current = ordered[0] ?? null;
    if (
      previousTopItem &&
      previousTopItem.id !== (ordered[0]?.id ?? null) &&
      !items.some((item) => item.id === previousTopItem.id)
    ) {
      setLeavingItem(previousTopItem);
      const timeoutId = window.setTimeout(() => {
        setLeavingItem((current) =>
          current?.id === previousTopItem.id ? null : current
        );
      }, DECK_LEAVE_ANIMATION_FALLBACK_MS);
      return () => {
        window.clearTimeout(timeoutId);
      };
    }
    return undefined;
  }, [items, ordered]);

  const topItem = ordered[0];
  if (!topItem) {
    return null;
  }

  const peekCount = Math.min(ordered.length - 1, DECK_MAX_PEEK);
  const topIsSubmitting = isPromptSubmitting(topItem);

  return (
    <section
      className="flex min-w-0 flex-col gap-2.5"
      aria-label={t("agentHost.workspaceAgentMessageCenterGroupNeedsAttention")}
    >
      <div className="flex min-w-0 items-center justify-between gap-3 px-0.5">
        <div className="truncate text-xs font-bold leading-4 text-[var(--text-tertiary)]">
          {t("agentHost.workspaceAgentMessageCenterGroupNeedsAttention")} ·{" "}
          {ordered.length}
        </div>
      </div>
      <div
        className={cn(
          "relative min-w-0",
          peekCount > 1 ? "pb-[18px]" : peekCount > 0 && "pb-[10px]"
        )}
        data-testid="workspace-agent-message-center-attention-deck"
        data-deck-count={ordered.length}
        data-deck-peek-count={peekCount}
        data-deck-top-item-id={topItem.id}
      >
        {leavingItem ? (
          <div
            key={`leaving-${leavingItem.agentSessionId}`}
            aria-hidden="true"
            inert
            data-deck-leaving-item-id={leavingItem.id}
            className="pointer-events-none absolute inset-x-0 top-0 z-20 min-w-0 motion-safe:animate-out motion-safe:fade-out-0 motion-safe:slide-out-to-top-2 motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:hidden"
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) {
                setLeavingItem((current) =>
                  current?.id === leavingItem.id ? null : current
                );
              }
            }}
          >
            {renderCard ? (
              renderCard({
                highlighted: false,
                interactive: false,
                isSubmitting: false,
                item: leavingItem,
                onSubmitPrompt: () => {}
              })
            ) : (
              <WorkspaceAgentMessageCenterCard
                interactive={false}
                isSubmitting={false}
                item={leavingItem}
                onOpenChat={onOpenChat}
                onSubmitPrompt={() => {}}
              />
            )}
          </div>
        ) : null}
        <div
          key={topItem.id}
          className={cn(
            "relative min-w-0 rounded-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-300 motion-reduce:animate-none",
            peekCount > 1
              ? "shadow-[0_7px_0_-4px_var(--background-fronted),0_7px_0_-3px_var(--line-2),0_14px_0_-8px_var(--background-fronted),0_14px_0_-7px_var(--line-2)]"
              : peekCount > 0 &&
                  "shadow-[0_7px_0_-4px_var(--background-fronted),0_7px_0_-3px_var(--line-2)]"
          )}
        >
          {renderCard ? (
            renderCard({
              cardRef: registerNode
                ? (node) => registerNode(topItem.id, node)
                : undefined,
              highlighted: topItem.id === highlightedItemId,
              interactive: true,
              isSubmitting: topIsSubmitting || isTopCoolingDown,
              item: topItem,
              onSubmitPrompt: (input) => onSubmitPrompt(topItem, input)
            })
          ) : (
            <WorkspaceAgentMessageCenterCard
              cardRef={
                registerNode
                  ? (node) => registerNode(topItem.id, node)
                  : undefined
              }
              highlighted={topItem.id === highlightedItemId}
              interactive
              isSubmitting={topIsSubmitting || isTopCoolingDown}
              item={topItem}
              onLinkAction={onLinkAction}
              onOpenChat={onOpenChat}
              onSubmitPrompt={(input) => onSubmitPrompt(topItem, input)}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function orderDeckItems(
  items: readonly WorkspaceAgentMessageCenterItem[],
  highlightedItemId: string | null
): WorkspaceAgentMessageCenterItem[] {
  if (!highlightedItemId) {
    return [...items];
  }
  const index = items.findIndex((item) => item.id === highlightedItemId);
  if (index <= 0) {
    return [...items];
  }
  const next = [...items];
  const [picked] = next.splice(index, 1);
  return picked ? [picked, ...next] : next;
}
