import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import { AgentTranscriptItemView } from "./AgentTranscriptItemView";
import { assessAgentTranscriptComplexity } from "./agentTranscriptComplexity";
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

const AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN = 6;
const AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX = 280;
const AGENT_TRANSCRIPT_TURN_GAP_PX = 12;
const AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT = 3;
interface AgentTranscriptViewProps {
  conversation: AgentConversationVM;
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

function transcriptConversationRenderInputEquals(
  previous: AgentConversationVM,
  next: AgentConversationVM
): boolean {
  return (
    previous === next ||
    (previous.rows === next.rows &&
      previous.workspaceRoot === next.workspaceRoot &&
      previous.sourceDetail.cwd === next.sourceDetail.cwd &&
      transcriptTurnIdentityEquals(
        previous.sourceDetail.turns,
        next.sourceDetail.turns
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
    previous.previewMode === next.previewMode &&
    previous.showRawTimelineJson === next.showRawTimelineJson &&
    transcriptLabelsEqual(previous.labels, next.labels)
  );
}

export const AgentTranscriptView = memo(function AgentTranscriptView({
  conversation,
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
  const basePath = conversation.sourceDetail.cwd;
  const workspaceRoot = conversation.workspaceRoot;
  const provider = conversation.activity.agentProvider;
  const shouldVirtualize = useMemo(
    () => assessAgentTranscriptComplexity(turnGroups).shouldVirtualize,
    [turnGroups]
  );
  const rowVirtualizer = useVirtualizer({
    count: turnGroups.length,
    estimateSize: () => AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX,
    getItemKey: (index) => turnGroups[index]?.key ?? index,
    getScrollElement: () => virtualScrollElement,
    overscan: AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN
  });
  const handleLocateUserMessage = useCallback(
    (item: AgentMessageLocatorItem) => {
      const scrollParent = virtualizerHostRef.current?.parentElement ?? null;
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
      setVirtualScrollElement(null);
      return;
    }
    setVirtualScrollElement(virtualizerHostRef.current?.parentElement ?? null);
  }, [shouldVirtualize]);

  const renderRow = (
    row: AgentConversationVM["rows"][number],
    rowIndex: number
  ): JSX.Element => {
    const rowKey = rowKeys[rowIndex] ?? transcriptRowKey(row);
    const showTurnDivider = dividerRowIndexes.has(rowIndex);
    const shouldAnimateEnter =
      row.kind !== "processing" && enteringRowKeys.has(rowKey);

    return (
      <Fragment key={rowKey}>
        {showTurnDivider ? (
          <div
            className="h-px w-full flex-none bg-[var(--line-2,var(--tutti-line-2))]"
            data-testid="agent-transcript-turn-divider"
            aria-hidden="true"
          />
        ) : null}
        <div
          className="agent-gui-transcript-row"
          data-agent-transcript-row={rowKey}
          data-agent-transcript-row-kind={row.kind}
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
            toolGroupExpansionKey={
              row.kind === "tool-group" ? rowKey : undefined
            }
            onToolGroupExpandedChange={handleToolGroupExpandedChange}
          />
        </div>
      </Fragment>
    );
  };

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
                  paddingBottom: `${AGENT_TRANSCRIPT_TURN_GAP_PX}px`,
                  transform: `translateY(${virtualTurn.start}px)`
                }}
              >
                {group.rows.map(({ row, rowIndex }) =>
                  renderRow(row, rowIndex)
                )}
              </div>
            );
          })}
        </div>
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
      {conversation.rows.map(renderRow)}
    </>
  );
}, areAgentTranscriptViewPropsEqual);
