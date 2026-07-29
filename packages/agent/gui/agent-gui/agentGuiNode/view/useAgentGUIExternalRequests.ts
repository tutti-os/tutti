import { useCallback, useEffect, useRef } from "react";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "./AgentGUINodeView.types";
import { useAgentGUIConversationCopyAction } from "./AgentGUIConversationActionsMenu";

type SessionActionRequest = NonNullable<
  AgentGUINodeViewProps["sessionActionRequest"]
>;

type Conversation = AgentGUINodeViewModel["rail"]["conversations"][number];

function resolveSessionActionConversation(
  viewModel: AgentGUINodeViewModel,
  agentSessionId: string | null
): Conversation | null {
  const active = viewModel.rail.activeConversation;
  if (!agentSessionId) {
    return active;
  }
  if (active?.id === agentSessionId) {
    return active;
  }
  return (
    viewModel.rail.conversations.find(
      (conversation) => conversation.id === agentSessionId
    ) ?? null
  );
}

/**
 * Handles requests dispatched by the host chrome (workbench header) into the
 * AgentGUI node: creating a conversation and session actions (rename, copy
 * variants) targeting the conversation the header menu was rendered for.
 *
 * The header chrome cannot see the rail interaction lock or whether the
 * target conversation is loaded, so unlike the rail menus (which disable or
 * suppress actions up front) failures here surface as an error toast rather
 * than a silent drop.
 *
 * The rail query controller owns the interaction lock and lives inside the
 * rail subtree; it registers a probe through the returned callback so session
 * actions honor the same lock as the rail's own menus.
 */
export function useAgentGUIExternalRequests(input: {
  createConversationDisabled: boolean;
  labels: Pick<
    AgentGUIViewLabels,
    | "conversationCopyFile"
    | "conversationCopyImage"
    | "conversationCopyImagesOmitted"
    | "conversationCopyInProgress"
    | "conversationCopyMentionPrefix"
    | "conversationCopyPreviousMessages"
    | "copiedToClipboard"
    | "copyFailed"
    | "sessionActionUnavailable"
    | "untitledConversationTitle"
  >;
  newConversationRequestSequence: number | null;
  requestCreateConversation: (options?: { source?: string }) => void;
  requestRenameConversation: (conversation: Conversation) => void;
  sessionActionRequest: SessionActionRequest | null;
  uiLanguage: UiLanguage;
  viewModel: AgentGUINodeViewModel;
}): {
  registerRailInteractionLockProbe: (probe: (() => boolean) | null) => void;
} {
  const {
    createConversationDisabled,
    labels,
    newConversationRequestSequence,
    requestCreateConversation,
    requestRenameConversation,
    sessionActionRequest,
    uiLanguage,
    viewModel
  } = input;
  const agentHostApi = useOptionalAgentHostApi();
  const railInteractionLockProbeRef = useRef<(() => boolean) | null>(null);
  const registerRailInteractionLockProbe = useCallback(
    (probe: (() => boolean) | null) => {
      railInteractionLockProbeRef.current = probe;
    },
    []
  );
  const handledNewConversationRequestSequenceRef = useRef(
    newConversationRequestSequence
  );
  const handledSessionActionRequestSequenceRef = useRef(
    sessionActionRequest?.sequence ?? null
  );
  const copyConversationValue = useAgentGUIConversationCopyAction(labels);
  useEffect(() => {
    if (
      newConversationRequestSequence !== null &&
      handledNewConversationRequestSequenceRef.current !==
        newConversationRequestSequence
    ) {
      handledNewConversationRequestSequenceRef.current =
        newConversationRequestSequence;
      if (!createConversationDisabled) {
        requestCreateConversation({ source: "external_request" });
      }
    }
    if (
      sessionActionRequest &&
      handledSessionActionRequestSequenceRef.current !==
        sessionActionRequest.sequence
    ) {
      handledSessionActionRequestSequenceRef.current =
        sessionActionRequest.sequence;
      const conversation = resolveSessionActionConversation(
        viewModel,
        sessionActionRequest.agentSessionId
      );
      const railInteractionLocked =
        railInteractionLockProbeRef.current?.() ?? false;
      if (!conversation || railInteractionLocked) {
        agentHostApi?.toast?.error(labels.sessionActionUnavailable);
      } else if (sessionActionRequest.action === "rename") {
        requestRenameConversation(conversation);
      } else {
        copyConversationValue(sessionActionRequest.action, {
          conversation,
          uiLanguage,
          workspaceId: viewModel.shell.workspaceId
        });
      }
    }
  }, [
    agentHostApi,
    copyConversationValue,
    createConversationDisabled,
    labels,
    newConversationRequestSequence,
    requestCreateConversation,
    requestRenameConversation,
    sessionActionRequest,
    uiLanguage,
    viewModel
  ]);
  return { registerRailInteractionLockProbe };
}
