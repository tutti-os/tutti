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
  close: () => void;
  closeDialog: () => void;
  deletePrompt: (prompt: AgentHostQuickPrompt) => void;
  filteredPrompts: readonly AgentHostQuickPrompt[];
  isDeleting: boolean;
  isEditorOpen: boolean;
  isPopoverOpen: boolean;
  isSaving: boolean;
  initialDraft: AgentQuickPromptDraft | null;
  labels: AgentQuickPromptLabels;
  mode: AgentQuickPromptMode;
  mutationError: AgentQuickPromptMutationError;
  openCreate: (draft?: AgentQuickPromptDraft) => void;
  openEdit: (prompt: AgentHostQuickPrompt) => void;
  openPopover: () => void;
  promptToDelete: AgentHostQuickPrompt | null;
  retry: () => void;
  saveDraft: (draft: AgentQuickPromptDraft) => Promise<boolean>;
  searchQuery: string;
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
  }
  const effectiveMode =
    disclosureAvailable && previousDisclosureAvailable === disclosureAvailable
      ? mode
      : "closed";

  const filteredPrompts = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const sorted = [...snapshot.prompts].sort(
      (left, right) =>
        right.updatedAtUnixMs - left.updatedAtUnixMs ||
        left.id.localeCompare(right.id)
    );
    if (!query) {
      return sorted;
    }
    return sorted.filter(
      (prompt) =>
        prompt.title.toLocaleLowerCase().includes(query) ||
        prompt.content.toLocaleLowerCase().includes(query)
    );
  }, [searchQuery, snapshot.prompts]);

  const openPopover = useCallback(() => {
    if (!capabilityAvailable || disabled) {
      return;
    }
    onBeforeOpen();
    setMutationError(null);
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
  }, []);

  const closeDialog = useCallback(() => {
    const nextMode = capabilityAvailable && !disabled ? "popover" : "closed";
    modeRef.current = nextMode;
    setMutationError(null);
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

  const openCreate = useCallback((draft?: AgentQuickPromptDraft) => {
    modeRef.current = "create";
    setSelectedPrompt(null);
    setInitialDraft(draft ?? null);
    setMutationError(null);
    setMode("create");
  }, []);

  const openEdit = useCallback((prompt: AgentHostQuickPrompt) => {
    modeRef.current = "edit";
    setSelectedPrompt(prompt);
    setInitialDraft(null);
    setMutationError(null);
    setMode("edit");
  }, []);

  const deletePrompt = useCallback((prompt: AgentHostQuickPrompt) => {
    modeRef.current = "delete";
    setPromptToDelete(prompt);
    setMutationError(null);
    setMode("delete");
  }, []);

  const saveDraft = useCallback(
    async (draft: AgentQuickPromptDraft): Promise<boolean> => {
      if (!quickPrompts || !capabilityAvailable || isSaving) {
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
    [capabilityAvailable, isSaving, quickPrompts, selectedPrompt]
  );

  const submitDelete = useCallback(async (): Promise<boolean> => {
    if (
      !quickPrompts ||
      !capabilityAvailable ||
      !promptToDelete ||
      isDeleting
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
  }, [capabilityAvailable, isDeleting, promptToDelete, quickPrompts]);

  const retry = useCallback(() => {
    if (!quickPrompts || !capabilityAvailable) {
      return;
    }
    void quickPrompts.ensureLoaded({ force: true }).catch(() => undefined);
  }, [capabilityAvailable, quickPrompts]);

  const selectPrompt = useCallback(
    (prompt: AgentHostQuickPrompt) => {
      if (disabled || !capabilityAvailable) {
        return;
      }
      close();
      onInsertPrompt(prompt.content);
    },
    [capabilityAvailable, close, disabled, onInsertPrompt]
  );

  return {
    capabilityAvailable,
    close,
    closeDialog,
    deletePrompt,
    filteredPrompts,
    isDeleting,
    isEditorOpen: effectiveMode === "create" || effectiveMode === "edit",
    isPopoverOpen: effectiveMode === "popover",
    isSaving,
    initialDraft,
    labels,
    mode: effectiveMode,
    mutationError,
    openCreate,
    openEdit,
    openPopover,
    promptToDelete,
    retry,
    saveDraft,
    searchQuery,
    selectPrompt,
    selectedPrompt,
    setPopoverOpen,
    setSearchQuery,
    snapshot,
    submitDelete
  };
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
