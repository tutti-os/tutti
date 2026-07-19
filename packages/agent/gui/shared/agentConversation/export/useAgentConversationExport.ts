import { useCallback, useMemo, useRef, useState } from "react";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import { useTranslation } from "../../../i18n/index";
import type { AgentTranscriptExportSelection } from "../components/AgentTranscriptView";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import {
  agentConversationOpeningText,
  buildAgentConversationExportTurns,
  buildAgentConversationPrintConversation,
  classifyAgentConversationExportError,
  serializeAgentConversationExportMarkdown,
  suggestedAgentConversationExportFileName,
  toggleAgentConversationExportTurn
} from "./agentConversationExport";

const PRINT_SURFACE_READY_TIMEOUT_MS = 8_000;

export interface AgentConversationExportController {
  clearSelection: () => void;
  copyMarkdown: () => Promise<void>;
  exportConversation: (format: "markdown" | "pdf") => Promise<void>;
  exportingFormat: "copy-markdown" | "markdown" | "pdf" | null;
  selection: AgentTranscriptExportSelection | undefined;
  selectedCount: number;
  onToolGroupExpandedChange: (key: string, expanded: boolean) => void;
  onPrintSurfaceReady: (requestId: number) => void;
  printRequest: AgentConversationPrintRequest | null;
}

export interface AgentConversationPrintRequest {
  conversation: AgentConversationVM;
  expandedToolRowKeys: ReadonlySet<string>;
  requestId: number;
  turnExpandedOverrides: Readonly<Record<string, boolean>>;
}

export function useAgentConversationExport(input: {
  conversation: AgentConversationVM | null;
  previewMode: boolean;
  toolCallsLabel: (count: number) => string;
  turnExpandedOverrides: Readonly<Record<string, boolean>>;
}): AgentConversationExportController {
  const { t } = useTranslation();
  const agentHostApi = useOptionalAgentHostApi();
  const [storedSelection, setStoredSelection] = useState<{
    sessionId: string;
    turnIds: Set<string>;
  } | null>(null);
  const [exportingFormat, setExportingFormat] = useState<
    "copy-markdown" | "markdown" | "pdf" | null
  >(null);
  const [storedExpandedToolRows, setStoredExpandedToolRows] = useState<{
    rowKeys: Set<string>;
    sessionId: string;
  } | null>(null);
  const [printRequest, setPrintRequest] =
    useState<AgentConversationPrintRequest | null>(null);
  const printReadyRef = useRef<{
    requestId: number;
    resolve: () => void;
  } | null>(null);
  const nextPrintRequestIdRef = useRef(0);
  const exportTurns = useMemo(
    () =>
      input.conversation
        ? buildAgentConversationExportTurns(input.conversation)
        : [],
    [input.conversation]
  );
  const exportableTurnIds = useMemo(
    () => new Set(exportTurns.map((turn) => turn.turnId)),
    [exportTurns]
  );
  const sessionId =
    input.conversation?.sourceDetail.session.agentSessionId ?? "";
  const expandedToolRowKeys = useMemo(
    () =>
      storedExpandedToolRows?.sessionId === sessionId
        ? storedExpandedToolRows.rowKeys
        : new Set<string>(),
    [sessionId, storedExpandedToolRows]
  );
  const onToolGroupExpandedChange = useCallback(
    (key: string, expanded: boolean) => {
      setStoredExpandedToolRows((current) => {
        const rowKeys = new Set(
          current?.sessionId === sessionId ? current.rowKeys : []
        );
        if (expanded) {
          rowKeys.add(key);
        } else {
          rowKeys.delete(key);
        }
        return { rowKeys, sessionId };
      });
    },
    [sessionId]
  );
  const selectedTurnIds = useMemo(
    () =>
      new Set(
        storedSelection?.sessionId === sessionId
          ? [...storedSelection.turnIds].filter((turnId) =>
              exportableTurnIds.has(turnId)
            )
          : []
      ),
    [exportableTurnIds, sessionId, storedSelection]
  );
  const toggleTurn = useCallback(
    (turnId: string) => {
      setStoredSelection((current) => ({
        sessionId,
        turnIds: toggleAgentConversationExportTurn(
          current?.sessionId === sessionId ? current.turnIds : new Set(),
          turnId
        )
      }));
    },
    [sessionId]
  );
  const clearSelection = useCallback(() => setStoredSelection(null), []);
  const buildSelectedDocument = useCallback(() => {
    const conversation = input.conversation;
    if (!conversation || selectedTurnIds.size === 0) return null;
    const title =
      conversation.sourceDetail.session.title?.trim() ||
      conversation.activity.title.trim() ||
      conversation.activity.agentName.trim() ||
      t("agentHost.agentGui.exportConversationFallbackTitle");
    return {
      markdown: serializeAgentConversationExportMarkdown({
        expandedToolRowKeys,
        labels: {
          agentText: t("agentHost.agentGui.exportAgentText"),
          executionRecord: t("agentHost.agentGui.exportExecutionRecord"),
          fileChanges: t("agentHost.agentGui.exportFileChanges"),
          prompt: t("agentHost.agentGui.exportUserPrompt"),
          questionAnswer: (index) =>
            t("agentHost.agentGui.exportQuestionAnswer", { index }),
          toolCalls: input.toolCallsLabel
        },
        title,
        turns: exportTurns.filter((turn) => selectedTurnIds.has(turn.turnId))
      }),
      openingText: agentConversationOpeningText(conversation),
      printConversation: buildAgentConversationPrintConversation(
        conversation,
        selectedTurnIds
      ),
      sessionId,
      title
    };
  }, [
    expandedToolRowKeys,
    exportTurns,
    input.conversation,
    input.toolCallsLabel,
    selectedTurnIds,
    sessionId,
    t
  ]);
  const copyMarkdown = useCallback(async () => {
    const document = buildSelectedDocument();
    if (!document) return;
    setExportingFormat("copy-markdown");
    try {
      await agentHostApi?.clipboard.writeText(document.markdown);
      agentHostApi?.toast?.success?.(
        t("agentHost.agentGui.exportMarkdownCopied")
      );
    } catch (error) {
      agentHostApi?.toast?.error(
        t("agentHost.agentGui.exportMarkdownCopyFailed"),
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setExportingFormat(null);
    }
  }, [agentHostApi, buildSelectedDocument, t]);
  const exportConversation = useCallback(
    async (format: "markdown" | "pdf") => {
      const save = agentHostApi?.conversationExport?.save;
      const document = buildSelectedDocument();
      if (!save || !document) return;
      setExportingFormat(format);
      let printRequestId: number | null = null;
      try {
        const suggestedFileName = suggestedAgentConversationExportFileName({
          format,
          openingText: document.openingText,
          sessionId: document.sessionId
        });
        let result;
        if (format === "pdf") {
          printRequestId = nextPrintRequestIdRef.current + 1;
          nextPrintRequestIdRef.current = printRequestId;
          const ready = new Promise<void>((resolve, reject) => {
            const timeoutSignal = AbortSignal.timeout(
              PRINT_SURFACE_READY_TIMEOUT_MS
            );
            // timing: fail cleanly if the print portal cannot mount or signal readiness.
            const onTimeout = (): void => {
              if (printReadyRef.current?.requestId === printRequestId) {
                printReadyRef.current = null;
              }
              reject(
                new Error("Conversation print surface did not become ready")
              );
            };
            timeoutSignal.addEventListener("abort", onTimeout, { once: true });
            printReadyRef.current = {
              requestId: printRequestId!,
              resolve: () => {
                timeoutSignal.removeEventListener("abort", onTimeout);
                resolve();
              }
            };
          });
          setPrintRequest({
            conversation: document.printConversation,
            expandedToolRowKeys: new Set(expandedToolRowKeys),
            requestId: printRequestId,
            turnExpandedOverrides: { ...input.turnExpandedOverrides }
          });
          await ready;
          result = await save({
            format: "pdf",
            renderSource: "current-renderer",
            suggestedFileName
          });
        } else {
          result = await save({
            content: document.markdown,
            format: "markdown",
            suggestedFileName
          });
        }
        if (result.status === "saved") {
          setStoredSelection(null);
          agentHostApi.toast?.success?.(
            t("agentHost.agentGui.exportConversationSaved"),
            result.path
          );
        }
      } catch (error) {
        if (
          classifyAgentConversationExportError(error) ===
          "desktop-restart-required"
        ) {
          const notify = agentHostApi.toast?.info ?? agentHostApi.toast?.error;
          notify?.(
            t("agentHost.agentGui.exportConversationDesktopRestartRequired"),
            t("agentHost.agentGui.exportConversationDesktopRestartDescription")
          );
        } else {
          agentHostApi.toast?.error(
            t("agentHost.agentGui.exportConversationFailed"),
            error instanceof Error ? error.message : String(error)
          );
        }
      } finally {
        if (printRequestId !== null) {
          setPrintRequest((current) =>
            current?.requestId === printRequestId ? null : current
          );
          if (printReadyRef.current?.requestId === printRequestId) {
            printReadyRef.current = null;
          }
        }
        setExportingFormat(null);
      }
    },
    [
      agentHostApi,
      buildSelectedDocument,
      expandedToolRowKeys,
      input.turnExpandedOverrides,
      t
    ]
  );
  const onPrintSurfaceReady = useCallback((requestId: number) => {
    const pending = printReadyRef.current;
    if (!pending || pending.requestId !== requestId) return;
    printReadyRef.current = null;
    pending.resolve();
  }, []);
  const selection = useMemo<AgentTranscriptExportSelection | undefined>(
    () =>
      agentHostApi?.conversationExport && !input.previewMode
        ? {
            deselectLabel: t("agentHost.agentGui.deselectQuestionAnswer"),
            exportableTurnIds,
            onToggleTurn: toggleTurn,
            selectionMode: selectedTurnIds.size > 0,
            selectLabel: t("agentHost.agentGui.selectQuestionAnswer"),
            selectedTurnIds
          }
        : undefined,
    [
      agentHostApi?.conversationExport,
      exportableTurnIds,
      input.previewMode,
      selectedTurnIds,
      t,
      toggleTurn
    ]
  );

  return {
    clearSelection,
    copyMarkdown,
    exportConversation,
    exportingFormat,
    onToolGroupExpandedChange,
    onPrintSurfaceReady,
    printRequest,
    selection,
    selectedCount: selectedTurnIds.size
  };
}
