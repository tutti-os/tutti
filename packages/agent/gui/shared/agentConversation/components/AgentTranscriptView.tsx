import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref
} from "react";
import { useOptionalAgentActivityRuntime } from "../../../agentActivityRuntime";
import { providerForkBindingAllowsAttempt } from "@tutti-os/agent-activity-core";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentConversationParticipantPresentation } from "../contracts/agentConversationParticipantPresentation";
import type { AgentConversationFollowEndMode } from "../agentConversationFollowEndController";
import { AgentTranscriptItemView } from "./AgentTranscriptItemView";
import {
  AgentForkThroughTurnButton,
  AgentForkThroughTurnFooter
} from "./AgentForkThroughTurnButton";
import { useAgentTurnDisclosureStore } from "./AgentTurnDisclosureContext";
import { AgentTurnWorkSection } from "./AgentTurnWorkSection";
import { findParticipantHeaderRenderKeys } from "./agentTurnWorkSectionModel";
import {
  AgentMessageLocatorRail,
  findMessageLocatorScrollParent
} from "./AgentMessageLocatorRail";
import {
  findExactTranscriptLocatorTarget,
  type AgentMessageLocatorLocateOptions
} from "./agentMessageLocatorNavigation";
import {
  buildAgentTranscriptTurnGroups,
  buildTurnGroupIndexByRowIndex,
  buildUserMessageLocatorItems,
  escapeCssString,
  findLastAgentTranscriptMessageRowIndex,
  findTurnDividerRowIndexes,
  transcriptRowKey,
  useAgentTranscriptDisplayRows,
  useEnteringTranscriptRows,
  type AgentMessageLocatorItem
} from "./agentTranscriptModel";
import {
  AgentTranscriptAttachmentView,
  useAgentTranscriptTurnAttachments,
  type AgentTranscriptAttachmentLocator,
  type AgentTranscriptTurnAttachment
} from "./useAgentTranscriptTurnAttachments";
import {
  useAgentTranscriptVirtualizer,
  type AgentTranscriptRowVirtualizer,
  type AgentTranscriptVirtualScrollController
} from "./useAgentTranscriptVirtualizer";
import { useAgentTranscriptTurnPresentation } from "./useAgentTranscriptTurnPresentation";
import { useAgentTranscriptLocateOperation } from "./useAgentTranscriptLocateOperation";
import { AgentTranscriptVirtualTurn } from "./AgentTranscriptVirtualTurn";
import {
  editRetryControlsEqual,
  type AgentTranscriptEditRetryControl,
  useAgentTranscriptEditRetryProjection
} from "./useAgentTranscriptEditRetryProjection";

export type {
  AgentTranscriptAttachmentLocator,
  AgentTranscriptTurnAttachment
} from "./useAgentTranscriptTurnAttachments";
export type {
  AgentTranscriptViewportSnapshot,
  AgentTranscriptVirtualScrollController
} from "./useAgentTranscriptVirtualizer";
export interface AgentTranscriptViewProps {
  conversation: AgentConversationVM;
  isConversationHistoryComplete?: boolean;
  isVisible?: boolean;
  editRetry?: AgentTranscriptEditRetryControl;
  turnAttachments?: readonly AgentTranscriptTurnAttachment[];
  turnAttachmentLocatorRef?: Ref<AgentTranscriptAttachmentLocator>;
  onTurnAttachmentVisibilityChange?: (
    attachmentId: string,
    visible: boolean
  ) => void;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  onForkThroughTurn?: (turnId: string) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  showRawTimelineJson?: boolean;
  participantPresentation?: AgentConversationParticipantPresentation;
  followEndMode?: AgentConversationFollowEndMode;
  forkThroughTurnPendingTurnIds?: readonly string[];
  virtualListLayoutRevision?: number;
  virtualScrollControllerRef?: Ref<AgentTranscriptVirtualScrollController>;
  labels: {
    toolCallsLabel: (count: number) => string;
    thinkingLabel: string;
    processing: string;
    turnSummary: string;
    rawTimelineJson?: string;
    userMessageLocator?: string;
  };
}

function participantPresentationEqual(
  previous: AgentConversationParticipantPresentation | undefined,
  next: AgentConversationParticipantPresentation | undefined
): boolean {
  if (previous === next) {
    return true;
  }
  if ((!previous || !previous.enabled) && (!next || !next.enabled)) {
    return true;
  }
  if (!previous?.enabled || !next?.enabled) {
    return false;
  }
  if (previous.status !== next.status) {
    return false;
  }
  if (previous.status === "loading" || next.status === "loading") {
    return true;
  }
  return (
    previous.user.name === next.user.name &&
    previous.user.avatarUrl === next.user.avatarUrl &&
    previous.agent.name === next.agent.name &&
    previous.agent.avatarUrl === next.agent.avatarUrl
  );
}

function isAssistantParticipantContentRow(
  row: AgentConversationVM["rows"][number]
): boolean {
  switch (row.kind) {
    case "message":
      return row.speaker === "assistant";
    case "generated-image":
    case "processing":
    case "tool-group":
    case "turn-summary":
      return true;
    case "goal-control":
      return false;
  }
}

function transcriptLabelsEqual(
  previous: AgentTranscriptViewProps["labels"],
  next: AgentTranscriptViewProps["labels"]
): boolean {
  return (
    previous === next ||
    (previous.thinkingLabel === next.thinkingLabel &&
      previous.processing === next.processing &&
      previous.turnSummary === next.turnSummary &&
      previous.rawTimelineJson === next.rawTimelineJson &&
      previous.userMessageLocator === next.userMessageLocator &&
      previous.toolCallsLabel === next.toolCallsLabel)
  );
}

function transcriptTurnIdentityEquals(
  previous: AgentConversationVM["sourceDetail"]["turns"],
  next: AgentConversationVM["sourceDetail"]["turns"]
): boolean {
  return (
    previous === next ||
    (previous.length === next.length &&
      previous.every((turn, index) => turn.id === next[index]?.id))
  );
}

function transcriptCanonicalTurnsEqual(
  previous: AgentConversationVM["sourceDetail"]["sessionTurns"],
  next: AgentConversationVM["sourceDetail"]["sessionTurns"]
): boolean {
  return (
    previous === next ||
    (previous?.length === next?.length &&
      (previous?.every((turn, index) => {
        const nextTurn = next?.[index];
        return (
          turn.turnId === nextTurn?.turnId &&
          turn.phase === nextTurn.phase &&
          turn.outcome === nextTurn.outcome &&
          turn.providerForkBindingAvailable ===
            nextTurn.providerForkBindingAvailable &&
          turn.providerForkBindingState === nextTurn.providerForkBindingState &&
          turn.startedAtUnixMs === nextTurn.startedAtUnixMs &&
          turn.settledAtUnixMs === nextTurn.settledAtUnixMs
        );
      }) ??
        true))
  );
}

function transcriptConversationRenderInputEquals(
  previous: AgentConversationVM,
  next: AgentConversationVM
): boolean {
  return (
    previous === next ||
    (previous.rows === next.rows &&
      previous.workspaceRoot === next.workspaceRoot &&
      previous.sourceDetail.session.agentSessionId ===
        next.sourceDetail.session.agentSessionId &&
      previous.sourceDetail.session.activeTurnId ===
        next.sourceDetail.session.activeTurnId &&
      previous.sourceDetail.session.activeTurn?.turnId ===
        next.sourceDetail.session.activeTurn?.turnId &&
      previous.sourceDetail.session.activeTurn?.phase ===
        next.sourceDetail.session.activeTurn?.phase &&
      previous.sourceDetail.session.imported ===
        next.sourceDetail.session.imported &&
      previous.sourceDetail.session.kind === next.sourceDetail.session.kind &&
      previous.sourceDetail.session.lifecycleCapabilities.forkThroughTurn ===
        next.sourceDetail.session.lifecycleCapabilities.forkThroughTurn &&
      previous.sourceDetail.session.pendingInteractions ===
        next.sourceDetail.session.pendingInteractions &&
      previous.sourceDetail.cwd === next.sourceDetail.cwd &&
      transcriptTurnIdentityEquals(
        previous.sourceDetail.turns,
        next.sourceDetail.turns
      ) &&
      transcriptCanonicalTurnsEqual(
        previous.sourceDetail.sessionTurns,
        next.sourceDetail.sessionTurns
      ))
  );
}

export function areAgentTranscriptViewPropsEqual(
  previous: AgentTranscriptViewProps,
  next: AgentTranscriptViewProps
): boolean {
  return (
    transcriptConversationRenderInputEquals(
      previous.conversation,
      next.conversation
    ) &&
    (previous.isConversationHistoryComplete ?? true) ===
      (next.isConversationHistoryComplete ?? true) &&
    (previous.isVisible ?? true) === (next.isVisible ?? true) &&
    previous.onLinkAction === next.onLinkAction &&
    previous.onAuthLogin === next.onAuthLogin &&
    previous.onForkThroughTurn === next.onForkThroughTurn &&
    previous.forkThroughTurnPendingTurnIds ===
      next.forkThroughTurnPendingTurnIds &&
    previous.availableSkills === next.availableSkills &&
    previous.workspaceAppIcons === next.workspaceAppIcons &&
    previous.turnAttachments === next.turnAttachments &&
    previous.turnAttachmentLocatorRef === next.turnAttachmentLocatorRef &&
    previous.onTurnAttachmentVisibilityChange ===
      next.onTurnAttachmentVisibilityChange &&
    editRetryControlsEqual(previous.editRetry, next.editRetry) &&
    previous.showRawTimelineJson === next.showRawTimelineJson &&
    previous.followEndMode === next.followEndMode &&
    previous.virtualListLayoutRevision === next.virtualListLayoutRevision &&
    previous.virtualScrollControllerRef === next.virtualScrollControllerRef &&
    participantPresentationEqual(
      previous.participantPresentation,
      next.participantPresentation
    ) &&
    transcriptLabelsEqual(previous.labels, next.labels)
  );
}

export const AgentTranscriptView = memo(function AgentTranscriptView({
  conversation,
  isConversationHistoryComplete = true,
  isVisible = true,
  editRetry,
  turnAttachments = [],
  turnAttachmentLocatorRef,
  onTurnAttachmentVisibilityChange,
  onLinkAction,
  onAuthLogin,
  onForkThroughTurn,
  availableSkills,
  workspaceAppIcons,
  showRawTimelineJson = false,
  participantPresentation,
  followEndMode,
  forkThroughTurnPendingTurnIds = [],
  virtualListLayoutRevision = 0,
  virtualScrollControllerRef,
  labels
}: AgentTranscriptViewProps): JSX.Element {
  "use memo";
  const agentActivityRuntime = useOptionalAgentActivityRuntime();
  const [expandedToolRows, setExpandedToolRows] = useState<
    Record<string, boolean>
  >({});
  const turnDisclosureStore = useAgentTurnDisclosureStore();
  const participantHeadersEnabled = participantPresentation?.enabled === true;
  // Participant-header presentation (Agent board session detail): tool-group
  // rows attach to the assistant message that follows them instead of sitting
  // after the previous message, and presentation turns key off user messages.
  // Canonical Turn groups remain responsible for disclosure and timing. The
  // row projection lives in the transcript model read hook so this component
  // stays within the degradation-check memo budget.
  const transcriptRowSet = useAgentTranscriptDisplayRows(
    conversation.rows,
    participantHeadersEnabled
  );
  const displayRows = transcriptRowSet.rows;
  const rowKeys = transcriptRowSet.rowKeys;
  const { editableUserMessageRowId, scopedEditRetry } =
    useAgentTranscriptEditRetryProjection(
      displayRows,
      conversation.sourceDetail.session.agentSessionId,
      editRetry
    );
  const participantTurnProjection = transcriptRowSet.participantTurnProjection;
  const turnGroups = useMemo(
    () => buildAgentTranscriptTurnGroups(displayRows, rowKeys),
    [displayRows, rowKeys]
  );
  const turnGroupIndexByRowIndex = useMemo(
    () => buildTurnGroupIndexByRowIndex(turnGroups),
    [turnGroups]
  );
  const userMessageLocatorItems = useMemo(
    () =>
      buildUserMessageLocatorItems(
        displayRows,
        rowKeys,
        turnGroupIndexByRowIndex
      ),
    [displayRows, rowKeys, turnGroupIndexByRowIndex]
  );
  const enteringRowKeys = useEnteringTranscriptRows(rowKeys);
  const handleToolGroupExpandedChange = useCallback(
    (key: string, expanded: boolean) => {
      setExpandedToolRows((previous) => {
        if (previous[key] === expanded) {
          return previous;
        }
        return {
          ...previous,
          [key]: expanded
        };
      });
    },
    []
  );
  const turnIndexById = useMemo(
    () =>
      new Map(
        conversation.sourceDetail.turns.map((turn, index) => [turn.id, index])
      ),
    [conversation.sourceDetail.turns]
  );
  const dividerRowIndexes = useMemo(
    () =>
      participantTurnProjection
        ? participantTurnProjection.dividerRowIndexes
        : findTurnDividerRowIndexes(turnIndexById, displayRows),
    [displayRows, turnIndexById, participantTurnProjection]
  );
  const { canonicalTurnById, turnWorkSectionModelByKey, virtualEntries } =
    useAgentTranscriptTurnPresentation(conversation, turnGroups);
  const latestTurnGroup = turnGroups.at(-1) ?? null;
  const latestContentTurn =
    latestTurnGroup?.turnId === null || latestTurnGroup?.turnId === undefined
      ? null
      : (conversation.sourceDetail.turns[
          turnIndexById.get(latestTurnGroup.turnId) ?? -1
        ] ?? null);
  const latestCanonicalTurn =
    latestTurnGroup?.turnId === null || latestTurnGroup?.turnId === undefined
      ? null
      : (canonicalTurnById.get(latestTurnGroup.turnId) ?? null);
  const activeTurnId =
    conversation.sourceDetail.session.activeTurn?.turnId ??
    conversation.sourceDetail.session.activeTurnId;
  const isLatestTurnInProgress =
    latestTurnGroup !== null &&
    latestTurnGroup.turnId === activeTurnId &&
    (conversation.sourceDetail.session.activeTurn?.phase ??
      latestCanonicalTurn?.phase) !== "settled";
  const participantHeaderRenderKeys = participantTurnProjection
    ? findParticipantHeaderRenderKeys(
        turnGroups,
        rowKeys,
        turnWorkSectionModelByKey,
        participantTurnProjection.turnIndexByRowIndex
      )
    : null;
  const basePath = conversation.sourceDetail.cwd;
  const workspaceRoot = conversation.workspaceRoot;
  const provider = conversation.activity.agentProvider;
  const agentSessionId = conversation.sourceDetail.session.agentSessionId;
  const {
    layoutRevision,
    responseSpacerHeightPx,
    rowVirtualizer,
    setVirtualizerHostElement,
    totalHeightPx,
    virtualItems,
    virtualizerHostRef,
    windowOffsetPx
  } = useAgentTranscriptVirtualizer({
    agentSessionId,
    entries: virtualEntries,
    followEndMode,
    isLatestTurnInProgress,
    latestTurnKey: latestTurnGroup?.key ?? null,
    virtualScrollControllerRef
  });
  const locateOperation = useAgentTranscriptLocateOperation(isVisible);
  const attachmentProjection = useAgentTranscriptTurnAttachments({
    attachments: turnAttachments,
    isVisible,
    locateOperation,
    locatorRef: turnAttachmentLocatorRef,
    onVisibilityChange: onTurnAttachmentVisibilityChange,
    rowVirtualizer,
    turnGroups
  });
  const handleLocateUserMessage = useCallback(
    async (
      item: AgentMessageLocatorItem,
      options: AgentMessageLocatorLocateOptions = {
        align: "center",
        behavior: "smooth"
      }
    ) => {
      if (options.signal?.aborted) return null;
      const scrollParent = virtualizerHostRef.current
        ? findMessageLocatorScrollParent(virtualizerHostRef.current)
        : null;
      const findRenderedTarget = (): HTMLElement | null => {
        const row = (scrollParent ?? document).querySelector<HTMLElement>(
          `[data-agent-transcript-row="${escapeCssString(item.rowKey)}"]`
        );
        return row ? findExactTranscriptLocatorTarget(row) : null;
      };
      const group = turnGroups[item.turnGroupIndex];
      if (!group) return null;
      const revealedTarget = await rowVirtualizer.scrollToKey(
        group.key,
        findRenderedTarget,
        {
          align: options.align,
          behavior: options.behavior,
          signal: options.signal
        }
      );
      if (options.signal?.aborted) return null;
      return revealedTarget instanceof HTMLElement ? revealedTarget : null;
    },
    [rowVirtualizer, turnGroups]
  );
  const scrollMarginRevisionRef = useRef<number | null>(null);
  const layoutSyncInputsRef = useRef<{
    isVisible: boolean;
    layoutRevision: number;
    rowVirtualizer: AgentTranscriptRowVirtualizer;
    virtualListLayoutRevision: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (rowVirtualizer.syncMeasurements()) return;
    const previousInputs = layoutSyncInputsRef.current;
    if (
      previousInputs?.isVisible === isVisible &&
      previousInputs.layoutRevision === layoutRevision &&
      previousInputs.rowVirtualizer === rowVirtualizer &&
      previousInputs.virtualListLayoutRevision === virtualListLayoutRevision
    ) {
      return;
    }
    layoutSyncInputsRef.current = {
      isVisible,
      layoutRevision,
      rowVirtualizer,
      virtualListLayoutRevision
    };
    if (!isVisible) {
      rowVirtualizer.connectScrollElement(null);
      return;
    }
    if (scrollMarginRevisionRef.current !== virtualListLayoutRevision) {
      scrollMarginRevisionRef.current = virtualListLayoutRevision;
      const virtualizerHost = virtualizerHostRef.current;
      const scrollElement = virtualizerHost
        ? findMessageLocatorScrollParent(virtualizerHost)
        : null;
      if (!virtualizerHost || !scrollElement) {
        rowVirtualizer.syncLayout(0);
        rowVirtualizer.connectScrollElement(scrollElement);
        return;
      }
      const nextOffset = Math.max(
        0,
        virtualizerHost.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top +
          scrollElement.scrollTop
      );
      rowVirtualizer.syncLayout(nextOffset);
      rowVirtualizer.connectScrollElement(scrollElement);
      return;
    }
    rowVirtualizer.syncLayout();
  });

  const renderRow = (
    row: AgentConversationVM["rows"][number],
    rowIndex: number,
    renderKey?: string,
    footerAction?: ReactNode
  ): JSX.Element => {
    const rowKey =
      renderKey ??
      (displayRows[rowIndex] === row
        ? (rowKeys[rowIndex] ?? transcriptRowKey(row))
        : transcriptRowKey(row));
    const shouldAnimateEnter =
      row.kind !== "processing" && enteringRowKeys.has(rowKey);
    const showParticipantHeader =
      participantHeaderRenderKeys?.has(rowKey) ?? false;
    const participantContent =
      participantHeadersEnabled &&
      !showParticipantHeader &&
      isAssistantParticipantContentRow(row)
        ? "assistant"
        : undefined;
    const activeTurn = conversation.sourceDetail.session.activeTurn;
    const canonicalTurn =
      row.turnId === null ? null : (canonicalTurnById.get(row.turnId) ?? null);
    const isActiveTurn =
      row.turnId !== null &&
      canonicalTurn?.phase !== "settled" &&
      (activeTurn?.turnId === row.turnId
        ? activeTurn.phase !== "settled"
        : conversation.sourceDetail.session.activeTurnId === row.turnId);
    return (
      <div
        key={rowKey}
        className="agent-gui-transcript-row"
        data-agent-transcript-row={rowKey}
        data-agent-message-locator-key={
          row.kind === "message" && row.speaker === "user"
            ? `user-message:${rowKey}`
            : undefined
        }
        data-agent-transcript-row-kind={row.kind}
        data-agent-transcript-row-speaker={
          row.kind === "message" ? row.speaker : undefined
        }
        data-agent-transcript-row-thinking-first={
          row.kind === "message" &&
          row.speaker === "assistant" &&
          row.thinking.length > 0
            ? "true"
            : undefined
        }
        data-agent-transcript-row-thinking-last={
          row.kind === "message" &&
          row.speaker === "assistant" &&
          row.thinking.length > 0 &&
          row.messages.length === 0
            ? "true"
            : undefined
        }
        data-agent-transcript-row-index={rowIndex}
        data-agent-transcript-row-participant-content={participantContent}
        data-agent-transcript-row-enter={
          shouldAnimateEnter ? "true" : undefined
        }
      >
        <AgentTranscriptItemView
          workspaceRoot={workspaceRoot}
          basePath={basePath}
          row={row}
          editRetry={
            row.id === editableUserMessageRowId ? scopedEditRetry : undefined
          }
          labels={labels}
          onLinkAction={onLinkAction}
          onAuthLogin={onAuthLogin}
          provider={provider}
          availableSkills={availableSkills}
          workspaceAppIcons={workspaceAppIcons}
          showRawTimelineJson={showRawTimelineJson}
          participantPresentation={participantPresentation}
          showParticipantHeader={showParticipantHeader}
          isActiveTurn={isActiveTurn}
          toolGroupExpanded={
            row.kind === "tool-group"
              ? expandedToolRows[rowKey] === true
              : undefined
          }
          toolGroupExpansionKey={row.kind === "tool-group" ? rowKey : undefined}
          onToolGroupExpandedChange={handleToolGroupExpandedChange}
          footerAction={footerAction}
        />
      </div>
    );
  };

  const resolveForkThroughTurnAction = (
    turnId: string | null
  ): { disabled: boolean; pending: boolean; turnId: string } | null => {
    const lifecycleCapabilities =
      conversation.sourceDetail.session.lifecycleCapabilities;
    const canonicalTurn =
      turnId === null ? null : (canonicalTurnById.get(turnId) ?? null);
    if (
      !turnId ||
      !onForkThroughTurn ||
      conversation.sourceDetail.session.kind !== "root" ||
      lifecycleCapabilities.forkThroughTurn !== true ||
      !canonicalTurn ||
      canonicalTurn.phase !== "settled" ||
      !providerForkBindingAllowsAttempt(canonicalTurn)
    ) {
      return null;
    }
    const pending = forkThroughTurnPendingTurnIds.includes(turnId);
    return {
      disabled: pending,
      pending,
      turnId
    };
  };

  const renderLegacyTurnGroup = (
    group: (typeof turnGroups)[number]
  ): JSX.Element => {
    const forkAction = resolveForkThroughTurnAction(group.turnId);
    const forkButton = forkAction ? (
      <AgentForkThroughTurnButton
        disabled={forkAction.disabled}
        pending={forkAction.pending}
        onFork={() => onForkThroughTurn?.(forkAction.turnId)}
      />
    ) : null;
    const footerRowIndex = findLastAgentTranscriptMessageRowIndex(group.rows);
    return (
      <Fragment key={group.key}>
        {group.rows.map(({ row, rowIndex }) => {
          const rowKey = rowKeys[rowIndex] ?? transcriptRowKey(row);
          return (
            <Fragment key={rowKey}>
              {dividerRowIndexes.has(rowIndex) ? (
                <div
                  className="h-px w-full flex-none bg-[var(--line-2,var(--tutti-line-2))]"
                  data-testid="agent-transcript-turn-divider"
                  aria-hidden="true"
                />
              ) : null}
              {renderRow(
                row,
                rowIndex,
                undefined,
                rowIndex === footerRowIndex ? forkButton : null
              )}
            </Fragment>
          );
        })}
        {forkAction && footerRowIndex === null ? (
          <AgentForkThroughTurnFooter
            disabled={forkAction.disabled}
            pending={forkAction.pending}
            onFork={() => onForkThroughTurn?.(forkAction.turnId)}
          />
        ) : null}
      </Fragment>
    );
  };

  const renderTurnGroup = (group: (typeof turnGroups)[number]): JSX.Element => {
    const model = turnWorkSectionModelByKey.get(group.key) ?? null;
    if (!model) {
      return renderLegacyTurnGroup(group);
    }
    const forkAction = resolveForkThroughTurnAction(group.turnId);
    const forkButton = forkAction ? (
      <AgentForkThroughTurnButton
        disabled={forkAction.disabled}
        pending={forkAction.pending}
        onFork={() => onForkThroughTurn?.(forkAction.turnId)}
      />
    ) : null;
    const footerRowIndex = findLastAgentTranscriptMessageRowIndex(group.rows);

    return (
      <AgentTurnWorkSection
        key={group.key}
        model={model}
        sessionId={conversation.sourceDetail.session.agentSessionId}
        turnKey={group.turnId ?? group.key}
        showDivider={group.rows.some(({ rowIndex }) =>
          dividerRowIndexes.has(rowIndex)
        )}
        disclosureStore={turnDisclosureStore}
        renderRow={(row, rowIndex, renderKey) =>
          renderRow(
            row,
            rowIndex,
            renderKey,
            rowIndex === footerRowIndex ? forkButton : null
          )
        }
        footer={
          forkAction && footerRowIndex === null ? (
            <AgentForkThroughTurnFooter
              disabled={forkAction.disabled}
              pending={forkAction.pending}
              onFork={() => onForkThroughTurn?.(forkAction.turnId)}
            />
          ) : null
        }
      />
    );
  };

  const renderAttachment = (
    attachment: AgentTranscriptTurnAttachment
  ): JSX.Element => (
    <AgentTranscriptAttachmentView
      key={attachment.id}
      attachment={attachment}
      onElementChange={attachmentProjection.onElementChange}
    />
  );

  return (
    <>
      <AgentMessageLocatorRail
        agentSessionId={agentSessionId}
        diagnosticRuntime={agentActivityRuntime ?? undefined}
        items={userMessageLocatorItems}
        isConversationHistoryComplete={isConversationHistoryComplete}
        isVisible={isVisible}
        label={labels.userMessageLocator}
        locateOperation={locateOperation}
        onLocate={handleLocateUserMessage}
        viewportSource={rowVirtualizer}
      />
      <div
        ref={setVirtualizerHostElement}
        className="agent-gui-transcript-virtual"
        data-agent-transcript-virtualized="true"
        style={{ height: `${totalHeightPx}px` }}
      >
        <div
          className="agent-gui-transcript-virtual-window"
          style={{ marginTop: `${windowOffsetPx}px` }}
        >
          {virtualItems.map((virtualTurn) => {
            const group = turnGroups[virtualTurn.index];
            if (!group) return null;
            return (
              <AgentTranscriptVirtualTurn
                key={virtualTurn.key}
                constrainedHeightPx={
                  !virtualTurn.measured &&
                  virtualTurn.index !== turnGroups.length - 1 &&
                  group.turnId !==
                    conversation.sourceDetail.session.activeTurnId
                    ? virtualTurn.size
                    : undefined
                }
                gapAfterPx={virtualEntries[virtualTurn.index]?.gapAfterPx ?? 0}
                index={virtualTurn.index}
                rowVirtualizer={rowVirtualizer}
                synchronousMeasurementKey={
                  isLatestTurnInProgress ? latestContentTurn : undefined
                }
                turnKey={group.key}
              >
                {renderTurnGroup(group)}
                {attachmentProjection.byGroupIndex
                  .get(virtualTurn.index)
                  ?.map(renderAttachment)}
              </AgentTranscriptVirtualTurn>
            );
          })}
        </div>
      </div>
      <div
        aria-hidden="true"
        className="agent-gui-transcript-response-spacer"
        data-agent-transcript-response-spacer="true"
        style={{ height: `${responseSpacerHeightPx}px` }}
      />
    </>
  );
}, areAgentTranscriptViewPropsEqual);
