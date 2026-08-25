import { useCallback, useState, type KeyboardEvent } from "react";
import type { AgentMessageRowVM } from "../contracts/agentMessageRowVM";
import type { AgentUserMessageEditRetryControl } from "./AgentUserMessageEditRetry";

interface AgentUserMessageEditState {
  draft: string;
  originalText: string;
  rowId: string;
}

export function useAgentUserMessageEditRetry(input: {
  editRetry?: AgentUserMessageEditRetryControl;
  isUser: boolean;
  row: AgentMessageRowVM;
}) {
  const rawFirstTextBlock =
    input.isUser && input.row.rawFirstTextBlock !== undefined
      ? input.row.rawFirstTextBlock
      : null;
  const editableTargetMessageId =
    rawFirstTextBlock !== null
      ? (input.row.messages.find(
          (message) =>
            message.contentKind === "text" || message.contentKind === undefined
        )?.id ?? null)
      : null;
  const canEdit =
    input.isUser &&
    input.editRetry !== undefined &&
    rawFirstTextBlock !== null &&
    editableTargetMessageId !== null;
  const [editState, setEditState] = useState<AgentUserMessageEditState | null>(
    null
  );
  const [locallySubmittingRowId, setLocallySubmittingRowId] = useState<
    string | null
  >(null);
  const isEditing =
    canEdit &&
    editState?.rowId === input.row.id &&
    editState.originalText === rawFirstTextBlock;
  const editPending =
    input.editRetry?.pending === true ||
    locallySubmittingRowId === input.row.id;

  const handleStartEdit = useCallback(() => {
    if (!canEdit || editPending || rawFirstTextBlock === null) {
      return;
    }
    setEditState({
      draft: rawFirstTextBlock,
      originalText: rawFirstTextBlock,
      rowId: input.row.id
    });
  }, [canEdit, editPending, input.row.id, rawFirstTextBlock]);

  const handleCancelEdit = useCallback(() => {
    if (!editPending) {
      setEditState(null);
    }
  }, [editPending]);

  const handleEditTextChange = useCallback(
    (draft: string) => {
      setEditState((current) =>
        current?.rowId === input.row.id ? { ...current, draft } : current
      );
    },
    [input.row.id]
  );

  const handleSubmitEdit = useCallback(async () => {
    if (
      !input.editRetry ||
      !isEditing ||
      editPending ||
      !editState?.draft.trim()
    ) {
      return;
    }
    setLocallySubmittingRowId(input.row.id);
    try {
      const succeeded = await input.editRetry.onSubmit({
        turnId: input.row.turnId,
        editedText: editState.draft
      });
      if (succeeded) {
        setEditState(null);
      }
    } finally {
      setLocallySubmittingRowId((current) =>
        current === input.row.id ? null : current
      );
    }
  }, [
    editPending,
    editState,
    input.editRetry,
    input.row.id,
    input.row.turnId,
    isEditing
  ]);

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handleCancelEdit();
        return;
      }
      if (event.key !== "Enter") {
        return;
      }
      event.stopPropagation();
      if (event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }
      event.preventDefault();
      void handleSubmitEdit();
    },
    [handleCancelEdit, handleSubmitEdit]
  );

  return {
    canEdit,
    editableTargetMessageId,
    editPending,
    editState,
    handleCancelEdit,
    handleEditorKeyDown,
    handleEditTextChange,
    handleStartEdit,
    handleSubmitEdit,
    isEditing
  };
}
