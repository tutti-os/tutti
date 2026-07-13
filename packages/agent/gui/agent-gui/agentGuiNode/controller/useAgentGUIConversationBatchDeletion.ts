import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { useAgentHostApi } from "../../../agentActivityHost";
import type { AgentSessionViewRef } from "../../../contexts/workspace/presentation/renderer/agentSessions/useAgentSessionTransport";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";
import { type AgentGUIConversationListQuery } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import type { AgentGUINodeData } from "../../../types";
import {
  resolveAgentGUIConversationProject,
  type AgentGUIConversationSummary
} from "../model/agentGuiConversationModel";
import type {
  AgentComposerDraft,
  AgentGUIProjectConversationDeleteTarget
} from "../model/agentGuiNodeTypes";
import { getAgentGUIErrorMessage } from "./agentGuiController.errors";
import {
  normalizeProjectConversationPath,
  omitConversationLocalState
} from "./agentGuiController.interactiveHelpers";
import {
  reportAgentGUIRuntimeError,
  showAgentGUIControllerErrorToast
} from "./agentGuiController.reporting";
import { type ConversationIntent } from "./useAgentConversationSelection";

export interface UseAgentGUIConversationBatchDeletionInput {
  isDeletingProjectConversations: boolean;
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  userProjectsRef: RefObject<AgentHostUserProject[]>;
  isNoProjectPathRef: RefObject<
    ((input: { path: string }) => boolean) | undefined
  >;
  setPendingDeleteProjectConversations: Dispatch<
    SetStateAction<AgentGUIProjectConversationDeleteTarget | null>
  >;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setListError: Dispatch<SetStateAction<string | null>>;
  deleteAgentSessionView: (ref: AgentSessionViewRef) => void;
  sessionViewRef: (agentSessionId: string | null | undefined) => {
    workspaceId: string;
    agentSessionId: string | null | undefined;
    origin: string;
  };
  setDraftBySessionId: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
  sessionEngine: AgentSessionEngine;
  activeConversationIdRef: RefObject<string | null>;
  markSelectedConversationDetailPending: (
    agentSessionId: string
  ) => string | null;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  setIsLoadingMessages: Dispatch<SetStateAction<boolean>>;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  persistActiveConversation: (agentSessionId: string | null) => void;
  removeConversations: (conversationIds: readonly string[]) => void;
  conversationListQuery: AgentGUIConversationListQuery | null;
  workspaceId: string;
  pendingDeleteProjectConversations: AgentGUIProjectConversationDeleteTarget | null;
  setIsDeletingProjectConversations: Dispatch<SetStateAction<boolean>>;
  setAgentSessionViewMessagesLoading: (
    ref: AgentSessionViewRef,
    value: boolean
  ) => void;
  activation: ReturnType<typeof useAgentGUIActivation>;
  agentActivityRuntime: AgentActivityRuntime;
  dataRef: RefObject<AgentGUINodeData>;
  agentHostApi: ReturnType<typeof useAgentHostApi>;
}

export function useAgentGUIConversationBatchDeletion(
  input: UseAgentGUIConversationBatchDeletionInput
) {
  const {
    isDeletingProjectConversations,
    conversationsRef,
    userProjectsRef,
    isNoProjectPathRef,
    setPendingDeleteProjectConversations,
    setDetailError,
    setListError,
    deleteAgentSessionView,
    sessionViewRef,
    setDraftBySessionId,
    sessionEngine,
    activeConversationIdRef,
    markSelectedConversationDetailPending,
    setIntent,
    setIsLoadingMessages,
    setActiveConversationId,
    persistActiveConversation,
    removeConversations,
    conversationListQuery,
    workspaceId,
    pendingDeleteProjectConversations,
    setIsDeletingProjectConversations,
    setAgentSessionViewMessagesLoading,
    activation,
    agentActivityRuntime,
    dataRef,
    agentHostApi
  } = input;

  const requestDeleteProjectConversations = useCallback(
    (path: string) => {
      const normalizedPath = normalizeProjectConversationPath(path);
      if (!normalizedPath || isDeletingProjectConversations) {
        return;
      }
      const targetConversations = conversationsRef.current.filter(
        (conversation) =>
          normalizeProjectConversationPath(
            resolveAgentGUIConversationProject(
              conversation.cwd,
              userProjectsRef.current,
              { isNoProjectPath: isNoProjectPathRef.current }
            )?.path
          ) === normalizedPath
      );
      if (targetConversations.length === 0) {
        return;
      }
      const project = userProjectsRef.current.find(
        (candidate) =>
          normalizeProjectConversationPath(candidate.path) === normalizedPath
      );
      setPendingDeleteProjectConversations({
        conversationCount: targetConversations.length,
        label: project?.label?.trim() || path,
        path: normalizedPath
      });
      setDetailError(null);
      setListError(null);
    },
    [isDeletingProjectConversations]
  );

  const cancelDeleteProjectConversations = useCallback(() => {
    if (isDeletingProjectConversations) {
      return;
    }
    setPendingDeleteProjectConversations(null);
  }, [isDeletingProjectConversations]);

  const finalizeConversationBatchDeletion = useCallback(
    (targetIds: Set<string>) => {
      for (const id of targetIds) {
        deleteAgentSessionView(sessionViewRef(id));
      }
      setDraftBySessionId((current) =>
        omitConversationLocalState(current, targetIds)
      );
      for (const id of targetIds) {
        sessionEngine.dispatch({
          agentSessionId: id,
          type: "queue/sessionCleaned"
        });
      }
      const nextConversations = conversationsRef.current.filter(
        (conversation) => !targetIds.has(conversation.id)
      );
      const currentActiveId = activeConversationIdRef.current;
      if (currentActiveId && targetIds.has(currentActiveId)) {
        const nextActive = nextConversations[0]?.id ?? null;
        if (nextActive) {
          markSelectedConversationDetailPending(nextActive);
          setIntent({ tag: "active", id: nextActive });
        } else {
          setIsLoadingMessages(false);
          setIntent({ tag: "home" });
        }
        activeConversationIdRef.current = nextActive;
        setActiveConversationId(nextActive);
        persistActiveConversation(nextActive);
      }
      removeConversations([...targetIds]);
    },
    [
      conversationListQuery,
      markSelectedConversationDetailPending,
      persistActiveConversation,
      sessionEngine,
      sessionViewRef,
      workspaceId,
      removeConversations
    ]
  );

  const confirmDeleteProjectConversations = useCallback(
    (path?: string) => {
      const normalizedPath = normalizeProjectConversationPath(path);
      const target =
        normalizedPath !== ""
          ? {
              conversationCount: conversationsRef.current.filter(
                (conversation) =>
                  normalizeProjectConversationPath(
                    resolveAgentGUIConversationProject(
                      conversation.cwd,
                      userProjectsRef.current,
                      { isNoProjectPath: isNoProjectPathRef.current }
                    )?.path
                  ) === normalizedPath
              ).length,
              label:
                userProjectsRef.current.find(
                  (project) =>
                    normalizeProjectConversationPath(project.path) ===
                    normalizedPath
                )?.label ??
                path ??
                normalizedPath,
              path: normalizedPath
            }
          : pendingDeleteProjectConversations;
      if (!target || isDeletingProjectConversations) {
        return;
      }
      const targetConversations = conversationsRef.current.filter(
        (conversation) =>
          normalizeProjectConversationPath(
            resolveAgentGUIConversationProject(
              conversation.cwd,
              userProjectsRef.current,
              { isNoProjectPath: isNoProjectPathRef.current }
            )?.path
          ) === target.path
      );
      if (targetConversations.length === 0) {
        setPendingDeleteProjectConversations(null);
        return;
      }
      const targetIds = new Set(
        targetConversations.map((conversation) => conversation.id)
      );
      setIsDeletingProjectConversations(true);
      setDetailError(null);
      setListError(null);
      const activeDeletedConversationId = activeConversationIdRef.current;
      if (
        activeDeletedConversationId &&
        targetIds.has(activeDeletedConversationId)
      ) {
        setIsLoadingMessages(true);
        setAgentSessionViewMessagesLoading(
          sessionViewRef(activeDeletedConversationId),
          true
        );
      }
      void Promise.all(
        targetConversations.map(async (conversation) => {
          await activation.unactivate(conversation.id);
          await agentActivityRuntime.deleteSession({
            workspaceId,
            agentSessionId: conversation.id
          });
        })
      )
        .then(() => {
          finalizeConversationBatchDeletion(targetIds);
          setPendingDeleteProjectConversations(null);
        })
        .catch((error) => {
          const message = getAgentGUIErrorMessage(error);
          reportAgentGUIRuntimeError({
            error,
            phase: "delete_conversation",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId,
            context: {
              projectPath: target.path,
              conversationCount: targetConversations.length
            }
          });
          setListError(message);
          showAgentGUIControllerErrorToast(agentHostApi.toast, message);
          if (
            activeDeletedConversationId &&
            activeConversationIdRef.current === activeDeletedConversationId
          ) {
            setIsLoadingMessages(false);
            setAgentSessionViewMessagesLoading(
              sessionViewRef(activeDeletedConversationId),
              false
            );
          }
        })
        .finally(() => {
          setIsDeletingProjectConversations(false);
        });
    },
    [
      activation,
      agentActivityRuntime,
      conversationListQuery,
      finalizeConversationBatchDeletion,
      isDeletingProjectConversations,
      markSelectedConversationDetailPending,
      pendingDeleteProjectConversations,
      persistActiveConversation,
      sessionViewRef,
      removeConversations,
      agentHostApi.toast,
      workspaceId
    ]
  );

  const confirmDeleteConversations = useCallback(
    (agentSessionIds: string[]) => {
      if (isDeletingProjectConversations) {
        return;
      }
      const targetIds = new Set(
        agentSessionIds.map((id) => id.trim()).filter((id) => id !== "")
      );
      const targetConversations = conversationsRef.current.filter(
        (conversation) => targetIds.has(conversation.id)
      );
      if (targetConversations.length === 0) {
        return;
      }
      setIsDeletingProjectConversations(true);
      setDetailError(null);
      setListError(null);
      const activeDeletedConversationId = activeConversationIdRef.current;
      if (
        activeDeletedConversationId &&
        targetIds.has(activeDeletedConversationId)
      ) {
        setIsLoadingMessages(true);
        setAgentSessionViewMessagesLoading(
          sessionViewRef(activeDeletedConversationId),
          true
        );
      }
      void Promise.all(
        targetConversations.map(async (conversation) => {
          await activation.unactivate(conversation.id);
          await agentActivityRuntime.deleteSession({
            workspaceId,
            agentSessionId: conversation.id
          });
        })
      )
        .then(() => {
          finalizeConversationBatchDeletion(targetIds);
        })
        .catch((error) => {
          const message = getAgentGUIErrorMessage(error);
          reportAgentGUIRuntimeError({
            error,
            phase: "delete_conversation",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId,
            context: {
              conversationCount: targetConversations.length
            }
          });
          setListError(message);
          showAgentGUIControllerErrorToast(agentHostApi.toast, message);
          if (
            activeDeletedConversationId &&
            activeConversationIdRef.current === activeDeletedConversationId
          ) {
            setIsLoadingMessages(false);
            setAgentSessionViewMessagesLoading(
              sessionViewRef(activeDeletedConversationId),
              false
            );
          }
        })
        .finally(() => {
          setIsDeletingProjectConversations(false);
        });
    },
    [
      activation,
      agentActivityRuntime,
      finalizeConversationBatchDeletion,
      isDeletingProjectConversations,
      sessionViewRef,
      agentHostApi.toast,
      workspaceId
    ]
  );

  return {
    requestDeleteProjectConversations,
    cancelDeleteProjectConversations,
    confirmDeleteProjectConversations,
    confirmDeleteConversations
  };
}
