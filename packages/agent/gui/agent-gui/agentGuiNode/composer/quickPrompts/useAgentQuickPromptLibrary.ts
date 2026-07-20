import { useCallback, useMemo, useRef, useState } from "react";
import { useOptionalAgentHostApi } from "../../../../agentActivityHost";
import type {
  AgentHostQuickPrompt,
  AgentHostQuickPromptSnapshot
} from "../../../../host/agentHostApi";
import { useEngineSelector } from "../../../../shared/engine/useEngineSelector";
import type { AgentQuickPromptLabels } from "./agentQuickPromptLabels";

const unavailableSnapshot: AgentHostQuickPromptSnapshot = {
  enabled: false,
  status: "idle",
  prompts: [],
  error: null,
  revision: 0,
  pendingMutationIds: []
};
const unavailableQuickPromptStore = {
  getSnapshot: (): AgentHostQuickPromptSnapshot => unavailableSnapshot,
  subscribe:
    (
      _listener: (snapshot: AgentHostQuickPromptSnapshot) => void
    ): (() => void) =>
    () => {}
};

type AgentQuickPromptMode = "closed" | "popover" | "create" | "edit" | "delete";
type AgentQuickPromptMutationError = "conflict" | "generic" | null;

export interface AgentQuickPromptDraft {
  content: string;
  title: string;
}

export interface AgentQuickPromptLibraryController {
  capabilityAvailable: boolean;
  canReorder: boolean;
  close: () => void;
  closeDialog: () => void;
  deletePrompt: (prompt: AgentHostQuickPrompt) => void;
  filteredPrompts: readonly AgentHostQuickPrompt[];
  isDeleting: boolean;
  isEditorOpen: boolean;
  isPopoverOpen: boolean;
  isSaving: boolean;
  isInteractionLocked: boolean;
  isReordering: boolean;
  initialDraft: AgentQuickPromptDraft | null;
  labels: AgentQuickPromptLabels;
  mode: AgentQuickPromptMode;
  mutationError: AgentQuickPromptMutationError;
  openCreate: (draft?: AgentQuickPromptDraft) => void;
  openEdit: (prompt: AgentHostQuickPrompt) => void;
  openPopover: () => void;
  promptToDelete: AgentHostQuickPrompt | null;
  retry: () => void;
  reorderError: AgentQuickPromptMutationError;
  reorderPrompts: (
    promptId: string,
    beforePromptId: string | null
  ) => Promise<boolean>;
  saveDraft: (draft: AgentQuickPromptDraft) => Promise<boolean>;
  searchQuery: string;
  showReorderHandles: boolean;
  selectPrompt: (prompt: AgentHostQuickPrompt) => void;
  selectedPrompt: AgentHostQuickPrompt | null;
  setPopoverOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  snapshot: AgentHostQuickPromptSnapshot;
  submitDelete: () => Promise<boolean>;
}

export function useAgentQuickPromptLibrary(input: {
  disabled: boolean;
  labels: AgentQuickPromptLabels;
  onBeforeOpen: () => void;
  onInsertPrompt: (content: string) => void;
}): AgentQuickPromptLibraryController {
  const { disabled, labels, onBeforeOpen, onInsertPrompt } = input;
  const hostApi = useOptionalAgentHostApi();
  const quickPrompts = hostApi?.quickPrompts;
  const snapshot = useEngineSelector(
    quickPrompts ?? unavailableQuickPromptStore,
    selectQuickPromptSnapshot
  );
  const [mode, setMode] = useState<AgentQuickPromptMode>("closed");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPrompt, setSelectedPrompt] =
    useState<AgentHostQuickPrompt | null>(null);
  const [initialDraft, setInitialDraft] =
    useState<AgentQuickPromptDraft | null>(null);
  const [promptToDelete, setPromptToDelete] =
    useState<AgentHostQuickPrompt | null>(null);
  const [mutationError, setMutationError] =
    useState<AgentQuickPromptMutationError>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [reorderError, setReorderError] =
    useState<AgentQuickPromptMutationError>(null);
  const capabilityAvailable = Boolean(quickPrompts && snapshot.enabled);
  const disclosureAvailable = capabilityAvailable && !disabled;
  const [previousDisclosureAvailable, setPreviousDisclosureAvailable] =
    useState(disclosureAvailable);
  const disclosureAvailableRef = useRef(disclosureAvailable);
  disclosureAvailableRef.current = disclosureAvailable;
  if (previousDisclosureAvailable !== disclosureAvailable) {
    setPreviousDisclosureAvailable(disclosureAvailable);
    modeRef.current = "closed";
    setMode("closed");
    setSelectedPrompt(null);
    setInitialDraft(null);
    setPromptToDelete(null);
    setMutationError(null);
    setReorderError(null);
  }
  const effectiveMode =
    disclosureAvailable && previousDisclosureAvailable === disclosureAvailable
      ? mode
      : "closed";

  const filteredPrompts = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) {
      return snapshot.prompts;
    }
    return snapshot.prompts.filter(
      (prompt) =>
        prompt.title.toLocaleLowerCase().includes(query) ||
        prompt.content.toLocaleLowerCase().includes(query)
    );
  }, [searchQuery, snapshot.prompts]);
  const isInteractionLocked =
    isSaving ||
    isDeleting ||
    isReordering ||
    Boolean(snapshot.orderMutationPending) ||
    snapshot.pendingMutationIds.length > 0;
  const canReorder = Boolean(
    quickPrompts?.move &&
    capabilityAvailable &&
    !disabled &&
    !searchQuery.trim() &&
    filteredPrompts.length > 1 &&
    !isInteractionLocked
  );
  const showReorderHandles = Boolean(
    quickPrompts?.move &&
    capabilityAvailable &&
    !searchQuery.trim() &&
    filteredPrompts.length > 1
  );

  const openPopover = useCallback(() => {
    if (!capabilityAvailable || disabled) {
      return;
    }
    onBeforeOpen();
    setMutationError(null);
    setReorderError(null);
    modeRef.current = "popover";
    setMode("popover");
    if (snapshot.status === "idle") {
      void quickPrompts?.ensureLoaded().catch(() => undefined);
    }
  }, [
    capabilityAvailable,
    disabled,
    onBeforeOpen,
    quickPrompts,
    snapshot.status
  ]);

  const close = useCallback(() => {
    modeRef.current = "closed";
    setMode("closed");
    setSelectedPrompt(null);
    setInitialDraft(null);
    setPromptToDelete(null);
    setMutationError(null);
    setReorderError(null);
  }, []);

  const closeDialog = useCallback(() => {
    const nextMode = capabilityAvailable && !disabled ? "popover" : "closed";
    modeRef.current = nextMode;
    setMutationError(null);
    setReorderError(null);
    setSelectedPrompt(null);
    setInitialDraft(null);
    setPromptToDelete(null);
    setMode(nextMode);
  }, [capabilityAvailable, disabled]);

  const setPopoverOpen = useCallback(
    (open: boolean) => {
      if (open) {
        openPopover();
      } else if (modeRef.current === "popover") {
        close();
      }
    },
    [close, openPopover]
  );

  const openCreate = useCallback(
    (draft?: AgentQuickPromptDraft) => {
      if (isInteractionLocked) return;
      modeRef.current = "create";
      setSelectedPrompt(null);
      setInitialDraft(draft ?? null);
      setMutationError(null);
      setMode("create");
    },
    [isInteractionLocked]
  );

  const openEdit = useCallback(
    (prompt: AgentHostQuickPrompt) => {
      if (isInteractionLocked) return;
      modeRef.current = "edit";
      setSelectedPrompt(prompt);
      setInitialDraft(null);
      setMutationError(null);
      setMode("edit");
    },
    [isInteractionLocked]
  );

  const deletePrompt = useCallback(
    (prompt: AgentHostQuickPrompt) => {
      if (isInteractionLocked) return;
      modeRef.current = "delete";
      setPromptToDelete(prompt);
      setMutationError(null);
      setMode("delete");
    },
    [isInteractionLocked]
  );

  const saveDraft = useCallback(
    async (draft: AgentQuickPromptDraft): Promise<boolean> => {
      if (!quickPrompts || !capabilityAvailable || isInteractionLocked) {
        return false;
      }
      setIsSaving(true);
      setMutationError(null);
      try {
        const saved = selectedPrompt
          ? await quickPrompts.update({
              id: selectedPrompt.id,
              title: draft.title,
              content: draft.content,
              expectedVersion: selectedPrompt.version
            })
          : await quickPrompts.create(draft);
        setSelectedPrompt(saved);
        setInitialDraft(null);
        const nextMode = disclosureAvailableRef.current ? "popover" : "closed";
        modeRef.current = nextMode;
        setMode(nextMode);
        return true;
      } catch (error) {
        const conflict = isVersionConflict(error);
        setMutationError(conflict ? "conflict" : "generic");
        if (conflict && selectedPrompt) {
          try {
            await quickPrompts.ensureLoaded({ force: true });
            const refreshedPrompt = quickPrompts
              .getSnapshot()
              .prompts.find((prompt) => prompt.id === selectedPrompt.id);
            if (refreshedPrompt) setSelectedPrompt(refreshedPrompt);
          } catch {
            setMutationError("conflict");
          }
        }
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [capabilityAvailable, isInteractionLocked, quickPrompts, selectedPrompt]
  );

  const submitDelete = useCallback(async (): Promise<boolean> => {
    if (
      !quickPrompts ||
      !capabilityAvailable ||
      !promptToDelete ||
      isInteractionLocked
    ) {
      return false;
    }
    setIsDeleting(true);
    setMutationError(null);
    try {
      await quickPrompts.remove({
        id: promptToDelete.id,
        expectedVersion: promptToDelete.version
      });
      setPromptToDelete(null);
      const nextMode = disclosureAvailableRef.current ? "popover" : "closed";
      modeRef.current = nextMode;
      setMode(nextMode);
      return true;
    } catch (error) {
      const conflict = isVersionConflict(error);
      setMutationError(conflict ? "conflict" : "generic");
      if (conflict) {
        try {
          await quickPrompts.ensureLoaded({ force: true });
          const refreshedPrompt = quickPrompts
            .getSnapshot()
            .prompts.find((prompt) => prompt.id === promptToDelete.id);
          if (refreshedPrompt) setPromptToDelete(refreshedPrompt);
        } catch {
          setMutationError("conflict");
        }
      }
      return false;
    } finally {
      setIsDeleting(false);
    }
  }, [capabilityAvailable, isInteractionLocked, promptToDelete, quickPrompts]);

  const retry = useCallback(() => {
    if (!quickPrompts || !capabilityAvailable || isInteractionLocked) {
      return;
    }
    setReorderError(null);
    void quickPrompts.ensureLoaded({ force: true }).catch(() => undefined);
  }, [capabilityAvailable, isInteractionLocked, quickPrompts]);

  const reorderPrompts = useCallback(
    async (
      promptId: string,
      beforePromptId: string | null
    ): Promise<boolean> => {
      if (!quickPrompts?.move || !canReorder) return false;
      const prompt = snapshot.prompts.find((item) => item.id === promptId);
      if (!prompt) return false;
      setIsReordering(true);
      setReorderError(null);
      try {
        await quickPrompts.move({
          promptId,
          beforePromptId,
          expectedVersion: prompt.version
        });
        return true;
      } catch (error) {
        setReorderError(isOrderConflict(error) ? "conflict" : "generic");
        return false;
      } finally {
        setIsReordering(false);
      }
    },
    [canReorder, quickPrompts, snapshot.prompts]
  );

  const selectPrompt = useCallback(
    (prompt: AgentHostQuickPrompt) => {
      if (disabled || !capabilityAvailable || isInteractionLocked) {
        return;
      }
      close();
      onInsertPrompt(prompt.content);
    },
    [capabilityAvailable, close, disabled, isInteractionLocked, onInsertPrompt]
  );

  const updateSearchQuery = useCallback(
    (query: string) => {
      if (isInteractionLocked) return;
      setSearchQuery(query);
    },
    [isInteractionLocked]
  );

  return {
    capabilityAvailable,
    canReorder,
    close,
    closeDialog,
    deletePrompt,
    filteredPrompts,
    isDeleting,
    isEditorOpen: effectiveMode === "create" || effectiveMode === "edit",
    isPopoverOpen: effectiveMode === "popover",
    isSaving,
    isInteractionLocked,
    isReordering,
    initialDraft,
    labels,
    mode: effectiveMode,
    mutationError,
    openCreate,
    openEdit,
    openPopover,
    promptToDelete,
    retry,
    reorderError,
    reorderPrompts,
    saveDraft,
    searchQuery,
    showReorderHandles,
    selectPrompt,
    selectedPrompt,
    setPopoverOpen,
    setSearchQuery: updateSearchQuery,
    snapshot,
    submitDelete
  };
}

function isOrderConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "agent_quick_prompt_conflict" &&
    "reason" in error &&
    (error.reason === "agent_quick_prompt_order_conflict" ||
      error.reason === "agent_quick_prompt_version_conflict")
  );
}

function selectQuickPromptSnapshot(
  snapshot: AgentHostQuickPromptSnapshot
): AgentHostQuickPromptSnapshot {
  return snapshot;
}

function isVersionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "agent_quick_prompt_conflict" &&
    "reason" in error &&
    error.reason === "agent_quick_prompt_version_conflict"
  );
}
