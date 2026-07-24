import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent
} from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tutti-os/ui-system";
import {
  createDisabledPlaceholderAgentGUIAgentTarget,
  createLocalAgentGUIAgentTarget
} from "../../../agentTargets";
import {
  migratedAgentGUIProviderIdentityCatalog,
  resolveAgentGUIProviderCatalogIdentity
} from "../../../providerIdentityCatalog.ts";
import type {
  AgentGUIProvider,
  AgentGUIProviderRailAllPresentation
} from "../../../types";
import {
  applyAgentGUIProviderRailOrder,
  applyAgentGUIProviderRailVisibility,
  agentGUIRunningTargetIds,
  changeAgentGUIProviderManagerVisibility,
  normalizeAgentGUIProviderRailHiddenTargetIds,
  reorderAgentGUIProviderRailOrder,
  type AgentGUIProviderManagerDropPlacement
} from "../model/agentGuiProviderRailOrder";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type {
  AgentGUIAgentsEmptyRenderer,
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import {
  AgentGUIProviderIconVisual,
  AgentGUIUnifiedProviderIcon,
  agentGUIProviderRailIconPresentation
} from "./AgentGUIEmptyState";
import { isBetaAgentProvider } from "../../../shared/managedAgentProviders";
import betaTagAssetUrl from "../../../app/renderer/assets/icons/agent-vinyl-beta-tag.svg";
import styles from "../AgentGUINode.styles";
import { AgentGUIProviderManagerDialog } from "./AgentGUIProviderManagerDialog";
import { useAgentGUIProviderRailPreferences } from "./useAgentGUIProviderRailPreferences";

const agentGUIProviderRailCatalog = [
  ...migratedAgentGUIProviderIdentityCatalog
].sort((left, right) => left.target.sortOrder - right.target.sortOrder);

const agentGUIProviderRailOrder: readonly AgentGUIProvider[] =
  agentGUIProviderRailCatalog.map(
    (identity) => identity.providerId as AgentGUIProvider
  );

const agentGUIProviderRailDefaultProviders = agentGUIProviderRailOrder;

const agentGUIProviderRailDisabledProviders = new Set<AgentGUIProvider>(
  agentGUIProviderRailCatalog
    .filter((identity) => !identity.target.enabled)
    .map((identity) => identity.providerId as AgentGUIProvider)
);

function agentGUIProviderRailOrderIndex(provider: AgentGUIProvider): number {
  const index = agentGUIProviderRailOrder.indexOf(provider);
  return index < 0 ? agentGUIProviderRailOrder.length : index;
}

function agentGUIProviderRailLabel(
  provider: AgentGUIProvider,
  targetLabel: string
): string {
  if (targetLabel.trim() && targetLabel !== provider) {
    return targetLabel;
  }
  return (
    resolveAgentGUIProviderCatalogIdentity(provider)?.displayName ?? targetLabel
  );
}

function agentGUIProviderRailAriaLabel(
  label: string,
  badgeLabel: string | null | undefined
): string {
  const normalizedBadgeLabel = badgeLabel?.trim() ?? "";
  if (!normalizedBadgeLabel || normalizedBadgeLabel === label) {
    return label;
  }
  return `${label}, ${normalizedBadgeLabel}`;
}

function agentGUIProviderTargetMatchesConversationFilter(
  target: AgentGUINodeViewModel["rail"]["agentTargets"][number],
  filter: AgentGUINodeViewModel["rail"]["conversationFilter"]
): boolean {
  const agentTargetId = target.agentTargetId?.trim() ?? "";
  return (
    filter.kind === "agentTarget" &&
    agentTargetId !== "" &&
    agentTargetId === filter.agentTargetId
  );
}

function agentGUIProviderRailTargets(
  agentTargets: AgentGUINodeViewModel["rail"]["agentTargets"],
  agentTargetsLoading: boolean,
  comingSoonProviders: AgentGUINodeViewModel["rail"]["comingSoonProviders"],
  providerRailMode: AgentGUINodeViewModel["rail"]["providerRailMode"]
): AgentGUINodeViewModel["rail"]["agentTargets"] {
  if (agentTargetsLoading) {
    return [];
  }
  // Exact mode renders precisely the provided targets — no backfilling to the
  // default provider catalog, no local/placeholder padding.
  if (providerRailMode === "exact") {
    return agentTargets;
  }
  const comingSoon = new Set(comingSoonProviders);
  const source =
    agentTargets.length > 0 &&
    !agentGUIProviderRailTargetsAreFullLocalFallback(agentTargets)
      ? agentTargets
      : [];
  const seenProviders = new Set(source.map((target) => target.provider));
  const missingDefaultProviders = agentGUIProviderRailDefaultProviders.filter(
    (provider) => !seenProviders.has(provider)
  );
  if (source.length > 0 && missingDefaultProviders.length === 0) {
    return source;
  }
  return [
    ...source,
    ...missingDefaultProviders.map((provider) =>
      agentGUIProviderRailDisabledProviders.has(provider) ||
      comingSoon.has(provider)
        ? createDisabledPlaceholderAgentGUIAgentTarget(provider)
        : createLocalAgentGUIAgentTarget(provider)
    )
  ];
}

function agentGUIProviderRailTargetsAreFullLocalFallback(
  agentTargets: AgentGUINodeViewModel["rail"]["agentTargets"]
): boolean {
  if (agentTargets.length !== agentGUIProviderRailOrder.length) {
    return false;
  }
  const fallbackProviders = new Set(agentGUIProviderRailOrder);
  return agentTargets.every(
    (target) =>
      fallbackProviders.has(target.provider) &&
      target.ref.kind === "local" &&
      target.ref.provider === target.provider &&
      target.targetId === `local:${target.provider}`
  );
}

interface AgentGUIProviderRailProps {
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
  activeConversationId: string | null;
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  labels: AgentGUIViewLabels;
  managerOpen: boolean;
  onManagerOpenChange: (open: boolean) => void;
  selectedAgentTarget: AgentGUINodeViewModel["rail"]["selectedAgentTarget"];
  agentTargets: AgentGUINodeViewModel["rail"]["agentTargets"];
  agentTargetsLoading: AgentGUINodeViewModel["rail"]["agentTargetsLoading"];
  providerRailMode: AgentGUINodeViewModel["rail"]["providerRailMode"];
  renderProviderRailEmpty?: AgentGUIAgentsEmptyRenderer;
  providerRailAllPresentation?: AgentGUIProviderRailAllPresentation | null;
  comingSoonProviders: AgentGUINodeViewModel["rail"]["comingSoonProviders"];
  onRequestComposerFocus: () => void;
  onSelectHomeComposerAgentTarget: AgentGUINodeViewProps["actions"]["selectHomeComposerAgentTarget"];
  onSelectConversationFilterTarget: AgentGUINodeViewProps["actions"]["selectConversationFilterTarget"];
  onUpdateConversationFilter: (
    filter: AgentGUINodeViewModel["rail"]["conversationFilter"]
  ) => void;
}

const AGENT_GUI_PROVIDER_RAIL_DRAG_HYSTERESIS_PX = 8;

type AgentGUIProviderRailDragState = {
  draggedTargetId: string;
  overTargetId: string | null;
  position: "before" | "after" | null;
};

export const AgentGUIProviderRail = memo(function AgentGUIProviderRail({
  activeConversation,
  activeConversationId,
  conversationFilter,
  conversations,
  labels,
  managerOpen,
  onManagerOpenChange,
  selectedAgentTarget,
  agentTargets,
  agentTargetsLoading,
  providerRailMode,
  renderProviderRailEmpty,
  providerRailAllPresentation,
  comingSoonProviders,
  onRequestComposerFocus,
  onSelectHomeComposerAgentTarget,
  onSelectConversationFilterTarget,
  onUpdateConversationFilter
}: AgentGUIProviderRailProps): React.JSX.Element {
  "use memo";
  const {
    persistPreferences: persistProviderRailPreferences,
    preferences: providerRailPreferences
  } = useAgentGUIProviderRailPreferences();
  const [dragState, setDragState] =
    useState<AgentGUIProviderRailDragState | null>(null);
  const dragStateRef = useRef<AgentGUIProviderRailDragState | null>(null);
  const setProviderRailDragState = useCallback(
    (nextDragState: AgentGUIProviderRailDragState | null) => {
      dragStateRef.current = nextDragState;
      setDragState(nextDragState);
    },
    []
  );

  const railProviderTargets = useMemo(
    () =>
      agentGUIProviderRailTargets(
        agentTargets,
        agentTargetsLoading,
        comingSoonProviders,
        providerRailMode
      ),
    [comingSoonProviders, providerRailMode, agentTargets, agentTargetsLoading]
  );
  const providerTiles = useMemo(() => {
    const targets = [...railProviderTargets];
    const orderedTargets =
      providerRailMode === "exact"
        ? targets
        : (() => {
            const originalIndexByTarget = new Map<string, number>();
            targets.forEach((target, index) => {
              originalIndexByTarget.set(
                `${target.provider}\u0000${target.targetId}`,
                index
              );
            });
            return targets.sort((left, right) => {
              const orderDelta =
                agentGUIProviderRailOrderIndex(left.provider) -
                agentGUIProviderRailOrderIndex(right.provider);
              if (orderDelta !== 0) {
                return orderDelta;
              }
              return (
                (originalIndexByTarget.get(
                  `${left.provider}\u0000${left.targetId}`
                ) ?? 0) -
                (originalIndexByTarget.get(
                  `${right.provider}\u0000${right.targetId}`
                ) ?? 0)
              );
            });
          })();
    return applyAgentGUIProviderRailOrder(
      orderedTargets,
      providerRailPreferences.order
    );
  }, [providerRailMode, providerRailPreferences.order, railProviderTargets]);
  const effectiveHiddenTargetIds = normalizeAgentGUIProviderRailHiddenTargetIds(
    providerTiles.map((target) => target.targetId),
    providerRailPreferences.hiddenTargetIds
  );
  const effectiveProviderRailPreferences =
    effectiveHiddenTargetIds === providerRailPreferences.hiddenTargetIds
      ? providerRailPreferences
      : {
          ...providerRailPreferences,
          hiddenTargetIds: effectiveHiddenTargetIds
        };
  const runningTargetIds = agentGUIRunningTargetIds({
    activeConversation,
    agentTargets: providerTiles,
    conversations
  });
  const visibleProviderTiles = useMemo(
    () =>
      applyAgentGUIProviderRailVisibility(
        providerTiles,
        effectiveHiddenTargetIds
      ),
    [effectiveHiddenTargetIds, providerTiles]
  );
  const allTileSelected = conversationFilter.kind === "all";
  const selectAllProviders = useCallback(() => {
    onUpdateConversationFilter({ kind: "all" });
    onRequestComposerFocus();
  }, [onRequestComposerFocus, onUpdateConversationFilter]);
  const selectAgentTargetTile = useCallback(
    (target: AgentGUINodeViewModel["rail"]["agentTargets"][number]) => {
      const agentTargetId = target.agentTargetId?.trim() ?? "";
      if (!agentTargetId) {
        return;
      }
      onSelectConversationFilterTarget({
        provider: target.provider,
        agentTargetId
      });
      onRequestComposerFocus();
    },
    [onRequestComposerFocus, onSelectConversationFilterTarget]
  );
  const clearProviderRailDragState = useCallback(() => {
    setProviderRailDragState(null);
  }, [setProviderRailDragState]);
  const handleProviderRailDragStart = useCallback(
    (
      event: DragEvent<HTMLButtonElement>,
      target: AgentGUINodeViewModel["rail"]["agentTargets"][number]
    ) => {
      if (agentTargetsLoading) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", target.targetId);
      setProviderRailDragState({
        draggedTargetId: target.targetId,
        overTargetId: null,
        position: null
      });
    },
    [agentTargetsLoading, setProviderRailDragState]
  );
  const handleProviderRailDragOver = useCallback(
    (
      event: DragEvent<HTMLButtonElement>,
      target: AgentGUINodeViewModel["rail"]["agentTargets"][number]
    ) => {
      if (agentTargetsLoading || !dragState) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dragState.draggedTargetId === target.targetId) {
        return;
      }
      const bounds = event.currentTarget.getBoundingClientRect();
      const midpointY = bounds.top + bounds.height / 2;
      let position: "before" | "after";
      if (dragState.overTargetId === target.targetId && dragState.position) {
        if (
          dragState.position === "before" &&
          event.clientY <=
            midpointY + AGENT_GUI_PROVIDER_RAIL_DRAG_HYSTERESIS_PX
        ) {
          position = "before";
        } else if (
          dragState.position === "after" &&
          event.clientY >=
            midpointY - AGENT_GUI_PROVIDER_RAIL_DRAG_HYSTERESIS_PX
        ) {
          position = "after";
        } else {
          position = event.clientY > midpointY ? "after" : "before";
        }
      } else {
        position = event.clientY > midpointY ? "after" : "before";
      }
      setProviderRailDragState({
        draggedTargetId: dragState.draggedTargetId,
        overTargetId: target.targetId,
        position
      });
    },
    [dragState, agentTargetsLoading, setProviderRailDragState]
  );
  const commitProviderRailDragDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const fallbackDraggedTargetId = event.dataTransfer
        .getData("text/plain")
        .trim();
      const activeDragState =
        dragStateRef.current ??
        dragState ??
        (fallbackDraggedTargetId
          ? {
              draggedTargetId: fallbackDraggedTargetId,
              overTargetId: null,
              position: null
            }
          : null);
      if (agentTargetsLoading || !activeDragState) {
        clearProviderRailDragState();
        return;
      }
      let overTargetId = activeDragState.overTargetId;
      let dropPosition = activeDragState.position ?? "before";
      if (!overTargetId || overTargetId === activeDragState.draggedTargetId) {
        const dropTargets = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "[data-provider-tile='true']"
          )
        )
          .map((element) => {
            const targetId = element.dataset.providerTargetId?.trim() ?? "";
            if (!targetId || targetId === activeDragState.draggedTargetId) {
              return null;
            }
            const bounds = element.getBoundingClientRect();
            const midpointY = bounds.top + bounds.height / 2;
            return {
              midpointY,
              targetId
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((left, right) => left.midpointY - right.midpointY);
        const firstTarget = dropTargets[0];
        const lastTarget = dropTargets[dropTargets.length - 1];
        if (firstTarget && lastTarget) {
          const inferredTarget =
            event.clientY <= firstTarget.midpointY
              ? firstTarget
              : event.clientY >= lastTarget.midpointY
                ? lastTarget
                : (dropTargets.find(
                    (entry) => event.clientY <= entry.midpointY
                  ) ?? lastTarget);
          overTargetId = inferredTarget.targetId;
          dropPosition =
            event.clientY > inferredTarget.midpointY ? "after" : "before";
        }
      }
      if (!overTargetId || overTargetId === activeDragState.draggedTargetId) {
        const droppedOnRailGap = event.target === event.currentTarget;
        const finalTargetId = visibleProviderTiles
          .map((tile) => tile.targetId)
          .filter((targetId) => targetId !== activeDragState.draggedTargetId)
          .at(-1);
        if (droppedOnRailGap && finalTargetId) {
          overTargetId = finalTargetId;
          dropPosition = "after";
        }
      }
      if (!overTargetId || overTargetId === activeDragState.draggedTargetId) {
        clearProviderRailDragState();
        return;
      }
      event.preventDefault();
      const nextOrder = reorderAgentGUIProviderRailOrder({
        currentTargetIds: visibleProviderTiles.map((tile) => tile.targetId),
        draggedTargetId: activeDragState.draggedTargetId,
        dropPosition,
        overTargetId
      });
      persistProviderRailPreferences({
        ...effectiveProviderRailPreferences,
        order: nextOrder
      });
      clearProviderRailDragState();
    },
    [
      clearProviderRailDragState,
      dragState,
      persistProviderRailPreferences,
      agentTargetsLoading,
      effectiveProviderRailPreferences,
      visibleProviderTiles
    ]
  );

  const moveProviderManagerTarget = (
    draggedTargetId: string,
    overTargetId: string,
    position: "before" | "after"
  ) => {
    const nextOrder = reorderAgentGUIProviderRailOrder({
      currentTargetIds: providerTiles.map((tile) => tile.targetId),
      draggedTargetId,
      dropPosition: position,
      overTargetId
    });
    persistProviderRailPreferences({
      ...effectiveProviderRailPreferences,
      order: nextOrder
    });
  };
  const changeProviderManagerVisibility = (
    targetId: string,
    visible: boolean,
    placement?: AgentGUIProviderManagerDropPlacement
  ) => {
    const nextPreferences = changeAgentGUIProviderManagerVisibility({
      currentTargetIds: providerTiles.map((target) => target.targetId),
      placement,
      preferences: effectiveProviderRailPreferences,
      runningTargetIds,
      targetId,
      visible
    });
    if (nextPreferences === effectiveProviderRailPreferences) {
      return;
    }
    persistProviderRailPreferences(nextPreferences);
    const selectedTargetIds = new Set(
      [selectedAgentTarget?.targetId, selectedAgentTarget?.agentTargetId]
        .map((candidateId) => candidateId?.trim() ?? "")
        .filter(Boolean)
    );
    if (
      !visible &&
      activeConversationId === null &&
      selectedTargetIds.has(targetId)
    ) {
      const fallbackTargets = applyAgentGUIProviderRailVisibility(
        providerTiles,
        nextPreferences.hiddenTargetIds
      );
      const fallbackTarget =
        fallbackTargets.find((target) => target.disabled !== true) ??
        fallbackTargets[0];
      if (fallbackTarget && fallbackTarget.targetId !== targetId) {
        const fallbackAgentTargetId =
          fallbackTarget.agentTargetId?.trim() ?? "";
        if (fallbackAgentTargetId) {
          onSelectHomeComposerAgentTarget({
            provider: fallbackTarget.provider,
            agentTargetId: fallbackAgentTargetId
          });
        }
      }
    }
    if (
      !visible &&
      providerTiles.some(
        (target) =>
          target.targetId === targetId &&
          agentGUIProviderTargetMatchesConversationFilter(
            target,
            conversationFilter
          )
      )
    ) {
      onUpdateConversationFilter({ kind: "all" });
    }
  };
  const handleProviderRailContainerDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const activeDragState = dragStateRef.current ?? dragState;
      if (!activeDragState || agentTargetsLoading) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const tileElements = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>(
          "[data-provider-tile='true']"
        )
      );
      const dropTargets = tileElements
        .map((element) => {
          const targetId = element.dataset.providerTargetId?.trim() ?? "";
          if (!targetId || targetId === activeDragState.draggedTargetId) {
            return null;
          }
          const bounds = element.getBoundingClientRect();
          const midpointY = bounds.top + bounds.height / 2;
          return {
            distance: Math.abs(event.clientY - midpointY),
            midpointY,
            targetId
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((left, right) => left.midpointY - right.midpointY);
      if (dropTargets.length === 0) {
        return;
      }
      const firstTarget = dropTargets[0];
      const lastTarget = dropTargets[dropTargets.length - 1];
      if (!firstTarget || !lastTarget) {
        return;
      }
      const inferredTarget =
        event.clientY <= firstTarget.midpointY
          ? firstTarget
          : event.clientY >= lastTarget.midpointY
            ? lastTarget
            : (dropTargets.find((entry) => event.clientY <= entry.midpointY) ??
              lastTarget);
      const position =
        event.clientY > inferredTarget.midpointY ? "after" : "before";
      setProviderRailDragState({
        draggedTargetId: activeDragState.draggedTargetId,
        overTargetId: inferredTarget.targetId,
        position
      });
    },
    [dragState, agentTargetsLoading, setProviderRailDragState]
  );
  const providerManagerDialog = (
    <AgentGUIProviderManagerDialog
      hiddenTargetIds={effectiveHiddenTargetIds}
      labels={labels}
      onMoveTarget={moveProviderManagerTarget}
      onOpenChange={onManagerOpenChange}
      onVisibilityChange={changeProviderManagerVisibility}
      open={managerOpen}
      runningTargetIds={runningTargetIds}
      targets={providerTiles}
    />
  );

  // Exact mode with no targets (and not loading): hand the rail body to the
  // host-provided empty renderer instead of the static local catalog fallback.
  if (
    providerRailMode === "exact" &&
    !agentTargetsLoading &&
    visibleProviderTiles.length === 0 &&
    renderProviderRailEmpty
  ) {
    return (
      <div
        className={styles.providerRail}
        role="tablist"
        aria-label={labels.providerSwitchLabel}
        aria-busy={agentTargetsLoading}
        data-empty="true"
      >
        {renderProviderRailEmpty()}
        {providerManagerDialog}
      </div>
    );
  }

  return (
    <div className={styles.providerRail}>
      <div
        className="flex min-h-0 w-full flex-col items-center"
        role="tablist"
        aria-label={labels.providerSwitchLabel}
        aria-busy={agentTargetsLoading}
        onDragOver={handleProviderRailContainerDragOver}
        onDrop={commitProviderRailDragDrop}
      >
        <button
          type="button"
          role="tab"
          aria-label={labels.conversationFilterAll}
          aria-selected={allTileSelected}
          className={styles.providerRailTile}
          data-selected={allTileSelected ? "true" : "false"}
          onClick={selectAllProviders}
        >
          <AgentGUIUnifiedProviderIcon
            presentation={providerRailAllPresentation}
          />
          <span className={styles.providerRailTileLabel}>
            {labels.conversationFilterAll}
          </span>
        </button>
        <span aria-hidden="true" className={styles.providerRailSeparator} />
        {agentTargetsLoading
          ? [0, 1, 2].map((index) => (
              <button
                key={`provider-target-loading-${index}`}
                type="button"
                role="tab"
                aria-selected="false"
                className={styles.providerRailTile}
                data-loading="true"
                data-selected="false"
                disabled
              >
                <span
                  aria-hidden="true"
                  className={styles.providerRailAvatar}
                />
              </button>
            ))
          : null}
        {visibleProviderTiles.map((target) => {
          const providerSelected =
            agentGUIProviderTargetMatchesConversationFilter(
              target,
              conversationFilter
            );
          const label = agentGUIProviderRailLabel(
            target.provider,
            target.label
          );
          const ariaLabel = agentGUIProviderRailAriaLabel(
            label,
            target.badge?.label
          );
          const tile = (
            <button
              key={`${target.provider}:${target.targetId}`}
              type="button"
              role="tab"
              aria-label={ariaLabel}
              aria-selected={providerSelected}
              className={styles.providerRailTile}
              data-disabled={target.disabled === true ? "true" : undefined}
              data-drag-over={
                dragState?.overTargetId === target.targetId
                  ? dragState.position
                  : undefined
              }
              data-dragging={
                dragState?.draggedTargetId === target.targetId
                  ? "true"
                  : undefined
              }
              data-provider-tile="true"
              data-provider-target-id={target.targetId}
              data-selected={providerSelected ? "true" : "false"}
              draggable={!agentTargetsLoading}
              onClick={() => selectAgentTargetTile(target)}
              onDragEnd={clearProviderRailDragState}
              onDragOver={(event) => handleProviderRailDragOver(event, target)}
              onDragStart={(event) =>
                handleProviderRailDragStart(event, target)
              }
            >
              <span className={styles.providerRailAvatar}>
                <AgentGUIProviderIconVisual
                  ariaHidden
                  imageClassName={styles.providerRailAvatarImage}
                  icon={agentGUIProviderRailIconPresentation(
                    target.provider,
                    target.iconUrl
                  )}
                />
                {target.badge?.iconUrl ? (
                  <span aria-hidden="true" className={styles.agentAvatarBadge}>
                    <img
                      alt=""
                      className={styles.agentAvatarBadgeImage}
                      draggable={false}
                      src={target.badge.iconUrl}
                    />
                  </span>
                ) : null}
                {providerSelected && isBetaAgentProvider(target.provider) ? (
                  <img
                    aria-hidden="true"
                    className={styles.providerRailBetaBadge}
                    src={betaTagAssetUrl}
                    alt=""
                  />
                ) : null}
              </span>
            </button>
          );

          return (
            <Tooltip key={`${target.provider}:${target.targetId}:tooltip`}>
              <TooltipTrigger asChild>{tile}</TooltipTrigger>
              <TooltipContent side="right" sideOffset={-4}>
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      {providerManagerDialog}
    </div>
  );
});
