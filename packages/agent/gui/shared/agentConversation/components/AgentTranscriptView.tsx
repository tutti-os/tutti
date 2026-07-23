import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type Ref
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import { AgentTranscriptItemView } from "./AgentTranscriptItemView";
import { useAgentTurnDisclosureStore } from "./AgentTurnDisclosureContext";
import { AgentTurnWorkSection } from "./AgentTurnWorkSection";
import { buildAgentTurnWorkSectionModel } from "./agentTurnWorkSectionModel";
import { assessAgentTranscriptComplexity } from "./agentTranscriptComplexity";
import { useTurnDisclosureMotion } from "./useTurnDisclosureMotion";
import {
  AgentMessageLocatorRail,
  findMessageLocatorScrollParent,
  scrollTranscriptRowIntoView
} from "./AgentMessageLocatorRail";
import {
  buildAgentTranscriptTurnGroups,
  buildTurnGroupIndexByRowIndex,
  buildUserMessageLocatorItems,
  escapeCssString,
  findTurnDividerRowIndexes,
  transcriptRowKey,
  useEnteringTranscriptRows,
  type AgentMessageLocatorItem
} from "./agentTranscriptModel";
import {
  AgentTranscriptAttachmentView,
  useAgentTranscriptTurnAttachments,
  type AgentTranscriptAttachmentLocator,
  type AgentTranscriptTurnAttachment
} from "./useAgentTranscriptTurnAttachments";

const AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN = 6;
const AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX = 280;
const AGENT_TRANSCRIPT_DISCLOSURE_TURN_GAP_PX = 24;
const AGENT_TRANSCRIPT_LEGACY_TURN_GAP_PX = 12;
const AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT = 3;
const preventVirtualScrollAdjustment = () => false;

export type {
  AgentTranscriptAttachmentLocator,
  AgentTranscriptTurnAttachment
} from "./useAgentTranscriptTurnAttachments";
interface AgentTranscriptViewProps {
  conversation: AgentConversationVM;
  turnAttachments?: readonly AgentTranscriptTurnAttachment[];
  turnAttachmentLocatorRef?: Ref<AgentTranscriptAttachmentLocator>;
  onTurnAttachmentVisibilityChange?: (
    attachmentId: string,
    visible: boolean
  ) => void;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  previewMode?: boolean;
  showRawTimelineJson?: boolean;
  labels: {
    toolCallsLabel: (count: number) => string;
    thinkingLabel: string;
    processing: string;
    turnSummary: string;
    rawTimelineJson?: string;
    userMessageLocator?: string;
  };
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
      previous.sourceDetail.session.imported ===
        next.sourceDetail.session.imported &&
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
    previous.onLinkAction === next.onLinkAction &&
    previous.onAuthLogin === next.onAuthLogin &&
    previous.availableSkills === next.availableSkills &&
    previous.workspaceAppIcons === next.workspaceAppIcons &&
    previous.turnAttachments === next.turnAttachments &&
    previous.turnAttachmentLocatorRef === next.turnAttachmentLocatorRef &&
    previous.onTurnAttachmentVisibilityChange ===
      next.onTurnAttachmentVisibilityChange &&
    previous.previewMode === next.previewMode &&
    previous.showRawTimelineJson === next.showRawTimelineJson &&
    transcriptLabelsEqual(previous.labels, next.labels)
  );
}

export const AgentTranscriptView = memo(function AgentTranscriptView({
  conversation,
  turnAttachments = [],
  turnAttachmentLocatorRef,
  onTurnAttachmentVisibilityChange,
  onLinkAction,
  onAuthLogin,
  availableSkills,
  workspaceAppIcons,
  previewMode = false,
  showRawTimelineJson = false,
  labels
}: AgentTranscriptViewProps): JSX.Element {
  "use memo";
  const [expandedToolRows, setExpandedToolRows] = useState<
    Record<string, boolean>
  >({});
  const [hasMovingTurnDisclosure, handleDisclosureMotionChange] =
    useTurnDisclosureMotion();
  const turnDisclosureStore = useAgentTurnDisclosureStore();
  const virtualizerHostRef = useRef<HTMLDivElement | null>(null);
  const [virtualScrollElement, setVirtualScrollElement] =
    useState<HTMLElement | null>(null);
  const rowKeys = useMemo(
    () => conversation.rows.map(transcriptRowKey),
    [conversation.rows]
  );
  const turnGroups = useMemo(
    () => buildAgentTranscriptTurnGroups(conversation.rows, rowKeys),
    [conversation.rows, rowKeys]
  );
  const turnGroupIndexByRowIndex = useMemo(
    () => buildTurnGroupIndexByRowIndex(turnGroups),
    [turnGroups]
  );
  const userMessageLocatorItems = useMemo(
    () =>
      buildUserMessageLocatorItems(
        conversation.rows,
        rowKeys,
        turnGroupIndexByRowIndex
      ),
    [conversation.rows, rowKeys, turnGroupIndexByRowIndex]
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
    () => findTurnDividerRowIndexes(turnIndexById, conversation.rows),
    [conversation.rows, turnIndexById]
  );
  const canonicalTurnById = new Map(
    (conversation.sourceDetail.sessionTurns ?? []).map((turn) => [
      turn.turnId,
      turn
    ])
  );
  const turnWorkSectionModelByKey = new Map(
    turnGroups.map((group) => {
      const isActiveTurn =
        group.turnId !== null &&
        group.turnId === conversation.sourceDetail.session.activeTurnId;
      return [
        group.key,
        buildAgentTurnWorkSectionModel(
          group,
          group.turnId ? (canonicalTurnById.get(group.turnId) ?? null) : null,
          isActiveTurn,
          {
            collapseIntermediateAssistantReplies:
              !conversation.sourceDetail.session.imported
          }
        )
      ] as const;
    })
  );
  const basePath = conversation.sourceDetail.cwd;
  const workspaceRoot = conversation.workspaceRoot;
  const provider = conversation.activity.agentProvider;
  const shouldVirtualize = useMemo(
    () => assessAgentTranscriptComplexity(turnGroups).shouldVirtualize,
    [turnGroups]
  );
  const rowVirtualizer = useVirtualizer({
    anchorTo: shouldVirtualize && hasMovingTurnDisclosure ? "start" : "end",
    count: turnGroups.length,
    estimateSize: () => AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX,
    getItemKey: (index) => turnGroups[index]?.key ?? index,
    getScrollElement: () => virtualScrollElement,
    overscan: AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN,
    scrollEndThreshold: 24
  });
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    shouldVirtualize && hasMovingTurnDisclosure
      ? preventVirtualScrollAdjustment
      : undefined;
  const attachmentProjection = useAgentTranscriptTurnAttachments({
    attachments: turnAttachments,
    locatorRef: turnAttachmentLocatorRef,
    onVisibilityChange: onTurnAttachmentVisibilityChange,
    rowVirtualizer,
    shouldVirtualize,
    turnGroups,
    virtualizerHostRef
  });
  const handleLocateUserMessage = useCallback(
    (item: AgentMessageLocatorItem) => {
      const scrollParent = virtualizerHostRef.current
        ? findMessageLocatorScrollParent(virtualizerHostRef.current)
        : null;
      const scrollToRenderedRow = (): boolean => {
        const renderedRow = (
          scrollParent ?? document
        ).querySelector<HTMLElement>(
          `[data-agent-transcript-row="${escapeCssString(item.rowKey)}"]`
        );
        if (!renderedRow) {
          return false;
        }
        scrollTranscriptRowIntoView(
          renderedRow,
          scrollParent ?? findMessageLocatorScrollParent(renderedRow)
        );
        return true;
      };

      if (scrollToRenderedRow()) {
        return;
      }
      if (shouldVirtualize) {
        rowVirtualizer.scrollToIndex(item.turnGroupIndex, {
          align: "center"
        });
        window.setTimeout(scrollToRenderedRow, 0);
      }
    },
    [rowVirtualizer, shouldVirtualize]
  );

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      return;
    }
    setVirtualScrollElement(
      virtualizerHostRef.current
        ? findMessageLocatorScrollParent(virtualizerHostRef.current)
        : null
    );
  }, [shouldVirtualize]);

  const renderRow = (
    row: AgentConversationVM["rows"][number],
    rowIndex: number,
    renderKey?: string
  ): JSX.Element => {
    const rowKey =
      renderKey ??
      (conversation.rows[rowIndex] === row
        ? (rowKeys[rowIndex] ?? transcriptRowKey(row))
        : transcriptRowKey(row));
    const shouldAnimateEnter =
      row.kind !== "processing" && enteringRowKeys.has(rowKey);

    return (
      <div
        key={rowKey}
        className="agent-gui-transcript-row"
        data-agent-transcript-row={rowKey}
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
        data-agent-transcript-row-enter={
          shouldAnimateEnter ? "true" : undefined
        }
      >
        <AgentTranscriptItemView
          workspaceRoot={workspaceRoot}
          basePath={basePath}
          row={row}
          labels={labels}
          onLinkAction={onLinkAction}
          onAuthLogin={onAuthLogin}
          provider={provider}
          availableSkills={availableSkills}
          workspaceAppIcons={workspaceAppIcons}
          previewMode={previewMode}
          showRawTimelineJson={showRawTimelineJson}
          toolGroupExpanded={
            row.kind === "tool-group"
              ? expandedToolRows[rowKey] === true
              : undefined
          }
          toolGroupExpansionKey={row.kind === "tool-group" ? rowKey : undefined}
          onToolGroupExpandedChange={handleToolGroupExpandedChange}
        />
      </div>
    );
  };

  const renderLegacyTurnGroup = (
    group: (typeof turnGroups)[number]
  ): JSX.Element => (
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
            {renderRow(row, rowIndex)}
          </Fragment>
        );
      })}
    </Fragment>
  );

  const renderTurnGroup = (group: (typeof turnGroups)[number]): JSX.Element => {
    const model = turnWorkSectionModelByKey.get(group.key) ?? null;
    if (!model) {
      return renderLegacyTurnGroup(group);
    }

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
        onDisclosureMotionChange={handleDisclosureMotionChange}
        renderRow={renderRow}
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

  if (shouldVirtualize) {
    const virtualItems =
      virtualScrollElement === null
        ? turnGroups
            .slice(-AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT)
            .map((group, fallbackIndex) => ({
              index:
                turnGroups.length -
                Math.min(
                  turnGroups.length,
                  AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT
                ) +
                fallbackIndex,
              key: group.key,
              start:
                (turnGroups.length -
                  Math.min(
                    turnGroups.length,
                    AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT
                  ) +
                  fallbackIndex) *
                AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX
            }))
        : rowVirtualizer.getVirtualItems();
    return (
      <>
        <AgentMessageLocatorRail
          items={userMessageLocatorItems}
          label={labels.userMessageLocator}
          onLocate={handleLocateUserMessage}
          virtualSelectionSource={rowVirtualizer}
        />
        <div
          ref={virtualizerHostRef}
          className="agent-gui-transcript-virtual"
          data-agent-transcript-virtualized="true"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {virtualItems.map((virtualTurn) => {
            const group = turnGroups[virtualTurn.index];
            if (!group) {
              return null;
            }
            return (
              <div
                key={virtualTurn.key}
                ref={rowVirtualizer.measureElement}
                className="agent-gui-transcript-virtual-item"
                data-index={virtualTurn.index}
                data-agent-transcript-virtual-turn={group.key}
                style={{
                  paddingBottom: `${
                    turnWorkSectionModelByKey.get(group.key)
                      ? AGENT_TRANSCRIPT_DISCLOSURE_TURN_GAP_PX
                      : AGENT_TRANSCRIPT_LEGACY_TURN_GAP_PX
                  }px`,
                  transform: `translateY(${virtualTurn.start}px)`
                }}
              >
                {renderTurnGroup(group)}
                {attachmentProjection.byGroupIndex
                  .get(virtualTurn.index)
                  ?.map(renderAttachment)}
              </div>
            );
          })}
        </div>
        {attachmentProjection.trailing.map(renderAttachment)}
      </>
    );
  }

  return (
    <>
      <AgentMessageLocatorRail
        items={userMessageLocatorItems}
        label={labels.userMessageLocator}
        onLocate={handleLocateUserMessage}
      />
      {turnGroups.map((group, groupIndex) => (
        <Fragment key={group.key}>
          {renderTurnGroup(group)}
          {attachmentProjection.byGroupIndex
            .get(groupIndex)
            ?.map(renderAttachment)}
        </Fragment>
      ))}
      {attachmentProjection.trailing.map(renderAttachment)}
    </>
  );
}, areAgentTranscriptViewPropsEqual);
