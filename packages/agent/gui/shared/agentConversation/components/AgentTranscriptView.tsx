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

const AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN = 6;
const AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX = 280;
const AGENT_TRANSCRIPT_TURN_GAP_PX = 12;
const AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT = 3;

interface AgentTranscriptTurnGroup {
  key: string;
  turnId: string | null;
  rows: Array<{
    row: AgentConversationVM["rows"][number];
    rowIndex: number;
  }>;
}

interface AgentTranscriptViewProps {
  conversation: AgentConversationVM;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  showRawTimelineJson?: boolean;
  labels: {
    toolCallsLabel: (count: number) => string;
    thinkingLabel: string;
    processing: string;
    turnSummary: string;
    rawTimelineJson?: string;
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
            availableSkills={availableSkills}
            workspaceAppIcons={workspaceAppIcons}
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
              {group.rows.map(({ row, rowIndex }) => renderRow(row, rowIndex))}
            </div>
          );
        })}
      </div>
    );
  }

  return <>{conversation.rows.map(renderRow)}</>;
}, areAgentTranscriptViewPropsEqual);

function useEnteringTranscriptRows(rowKeys: string[]): ReadonlySet<string> {
  const previousKeysRef = useRef<Set<string> | null>(null);
  const previousKeys = previousKeysRef.current;
  const enteringRowKeys = new Set<string>();

  if (previousKeys) {
    for (const key of rowKeys) {
      if (!previousKeys.has(key)) {
        enteringRowKeys.add(key);
      }
    }
  }

  useLayoutEffect(() => {
    previousKeysRef.current = new Set(rowKeys);
  }, [rowKeys]);

  return enteringRowKeys;
}

function transcriptRowKey(row: AgentConversationVM["rows"][number]): string {
  if (row.kind === "tool-group") {
    return row.expansionKey ?? row.id;
  }
  return row.id;
}

function buildAgentTranscriptTurnGroups(
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>,
  rowKeys: ReadonlyArray<string>
): AgentTranscriptTurnGroup[] {
  const groups: AgentTranscriptTurnGroup[] = [];
  let currentGroup: AgentTranscriptTurnGroup | null = null;

  rows.forEach((row, rowIndex) => {
    const turnId = row.turnId ?? null;
    if (!currentGroup || currentGroup.turnId !== turnId) {
      currentGroup = {
        key: turnId ?? `orphan:${rowKeys[rowIndex] ?? transcriptRowKey(row)}`,
        turnId,
        rows: []
      };
      groups.push(currentGroup);
    }

    currentGroup.rows.push({ row, rowIndex });
  });

  return groups;
}

function findTurnDividerRowIndexes(
  turnIndexById: ReadonlyMap<string, number>,
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>
): ReadonlySet<number> {
  const dividerRowIndexes = new Set<number>();
  const previousTurnIds = new Set<string>();

  rows.forEach((row, rowIndex) => {
    const currentTurnId = row.turnId ?? null;
    if (!currentTurnId) {
      return;
    }

    const turnIndex = turnIndexById.get(currentTurnId) ?? -1;
    const previousTurnId = rows[rowIndex - 1]?.turnId ?? null;
    if (
      rowIndex > 0 &&
      turnIndex > 0 &&
      previousTurnId &&
      previousTurnId !== currentTurnId &&
      !previousTurnIds.has(currentTurnId)
    ) {
      dividerRowIndexes.add(rowIndex);
    }

    previousTurnIds.add(currentTurnId);
  });

  return dividerRowIndexes;
}
