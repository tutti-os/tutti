import { useRef, useState, type ReactNode } from "react";
import {
  dispatchCollaborationOperation,
  selectCollaborationOperation,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { toast } from "@tutti-os/ui-system";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentHostApi } from "../../../host/agentHostApi";
import { translate } from "../../../i18n/index";
import {
  agentComposerDraftAttachmentProjection,
  emptyAgentComposerDraft,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import {
  AgentComposerCollaborationControls,
  type AgentComposerCollaborationContextScope,
  type AgentComposerCollaborationMode
} from "./AgentComposerCollaborationControls";
import type { AgentComposerProps } from "./AgentComposer.types";
import type {
  AgentGUIAgentTarget,
  AgentGUISharedAgentAccess
} from "../../../types";
import {
  agentGUISharedAgentAllowsPolicy,
  normalizeAgentGUISharedAgentAccess
} from "../../../sharedAgentAccess";
import {
  agentCollaborationTargetsFromPrompt,
  collaborationQuestionFromPrompt
} from "./composerAgentCollaboration";
import { useOptionalEngineSelector } from "../../../shared/engine/useEngineSelector";

interface Input {
  agentHostApi: AgentHostApi | null;
  agentTargets: readonly AgentGUIAgentTarget[];
  agentSessionId: string | null;
  disabled: boolean;
  draftContent: AgentComposerDraft;
  draftPrompt: string;
  draftScopeKey: string;
  onDraftContentChange: AgentComposerProps["onDraftContentChange"];
  runtime: AgentActivityRuntime | null;
  submitDisabled: boolean;
  workspaceId: string;
}

interface Result {
  controls: ReactNode;
  effectiveSubmitDisabled: boolean;
  hasCollaborationTargets: boolean;
  submit: () => void;
}

interface CollaborationComposerState {
  contextScope: AgentComposerCollaborationContextScope;
  errorMessage: string | null;
  mode: AgentComposerCollaborationMode | null;
  requestId: string;
  supplement: string;
}

/**
 * Owns the explicit @Agent composer branch. Normal prompt submission remains
 * in AgentComposer/useComposerSlashActions; this hook only intercepts durable
 * agent-target mentions and launches the daemon-owned collaboration run.
 */
export function useComposerAgentCollaboration(input: Input): Result {
  const targets = agentCollaborationTargetsFromPrompt(input.draftPrompt);
  const targetKey = targets.map((target) => target.targetId).join("\u0000");
  const operationRequestId = `composer:${input.draftScopeKey}:${targetKey}`;
  const sessionEngine = input.runtime?.collaborationCommandSupport
    ? input.runtime.getSessionEngine(input.workspaceId)
    : null;
  const operation = useOptionalEngineSelector<
    AgentSessionEngineState,
    ReturnType<typeof selectCollaborationOperation>
  >(
    sessionEngine,
    (state) => selectCollaborationOperation(state, operationRequestId),
    null
  );
  const { images, files, largeTexts } = agentComposerDraftAttachmentProjection(
    input.draftContent
  );
  const attachmentCount = images.length + files.length + largeTexts.length;
  const collaborationTarget = input.agentTargets.find(
    (candidate) =>
      candidate.targetId === targets[0]?.targetId ||
      candidate.agentTargetId === targets[0]?.targetId
  );
  const sharedAccess = normalizeAgentGUISharedAgentAccess(
    collaborationTarget?.ref.sharedAccess as
      | AgentGUISharedAgentAccess
      | null
      | undefined
  );
  const delegationAllowed = agentGUISharedAgentAllowsPolicy(
    sharedAccess,
    "delegate"
  );
  const draftContentRef = useRef(input.draftContent);
  const draftPromptRef = useRef(input.draftPrompt);
  draftContentRef.current = input.draftContent;
  draftPromptRef.current = input.draftPrompt;

  const [storedComposerState, setStoredComposerState] =
    useState<CollaborationComposerState>(() =>
      emptyCollaborationComposerState(operationRequestId)
    );
  const composerState =
    storedComposerState.requestId === operationRequestId
      ? storedComposerState
      : emptyCollaborationComposerState(operationRequestId);
  const { contextScope, errorMessage, mode, supplement } = composerState;
  const pending = operation?.status === "inFlight";

  const blocked =
    targets.length > 0 &&
    (targets.length !== 1 ||
      !input.agentSessionId ||
      !sessionEngine ||
      !delegationAllowed ||
      !mode ||
      attachmentCount > 0);
  const effectiveSubmitDisabled = input.submitDisabled || pending || blocked;

  const updateComposerState = (
    patch: Partial<Omit<CollaborationComposerState, "requestId">>
  ): void => {
    setStoredComposerState((current) => ({
      ...(current.requestId === operationRequestId
        ? current
        : emptyCollaborationComposerState(operationRequestId)),
      ...patch
    }));
  };

  const showError = (
    message: string,
    error?: unknown,
    expectedRequestId?: string
  ): void => {
    if (expectedRequestId) {
      setStoredComposerState((current) =>
        current.requestId === expectedRequestId
          ? { ...current, errorMessage: message }
          : current
      );
    } else {
      updateComposerState({ errorMessage: message });
    }
    void input.agentHostApi?.debug?.logRuntimeDiagnostics?.({
      details: {
        error:
          error instanceof Error
            ? error.message
            : error === undefined
              ? undefined
              : String(error),
        sourceSessionId: input.agentSessionId,
        targetAgentTargetId: targets[0]?.targetId
      },
      event: "agent_gui.collaboration_start.failed"
    });
    if (input.agentHostApi?.toast?.error) {
      input.agentHostApi.toast.error(message);
    } else {
      toast.error(message);
    }
  };

  const submit = (): void => {
    submitAgentCollaboration();
  };

  const submitAgentCollaboration = (): void => {
    if (pending) {
      return;
    }
    const target = targets[0];
    if (targets.length !== 1 || !target) {
      showError(
        translate("agentHost.agentGui.collaborationComposerSingleAgentOnly")
      );
      return;
    }
    if (!input.agentSessionId) {
      showError(translate("agentHost.agentGui.collaborationComposerNoSession"));
      return;
    }
    if (!sessionEngine) {
      showError(
        translate("agentHost.agentGui.collaborationComposerUnavailable")
      );
      return;
    }
    if (!delegationAllowed) {
      showError(
        translate("agentHost.agentGui.collaborationComposerPolicyDenied")
      );
      return;
    }
    if (attachmentCount > 0) {
      showError(
        translate(
          "agentHost.agentGui.collaborationComposerAttachmentsUnsupported"
        )
      );
      return;
    }
    if (!mode) {
      showError(
        translate("agentHost.agentGui.collaborationComposerModeRequired")
      );
      return;
    }
    const submittedDraft = draftContentRef.current;
    const submittedPrompt = draftPromptRef.current;
    const submittedScopeKey = input.draftScopeKey;
    const submittedRequestId = operationRequestId;
    updateComposerState({ errorMessage: null });
    void dispatchCollaborationOperation(sessionEngine, {
      input: {
        agentSessionId: input.agentSessionId,
        contextScope,
        contextText: supplement.trim() || null,
        mode,
        question: collaborationQuestionFromPrompt(submittedPrompt),
        targetAgentTargetId: target.targetId,
        workspaceId: input.workspaceId
      },
      requestId: operationRequestId,
      type: "collaboration/startRequested"
    })
      .then(() => {
        if (draftContentRef.current === submittedDraft) {
          input.onDraftContentChange(
            emptyAgentComposerDraft(),
            submittedScopeKey
          );
        }
        setStoredComposerState((current) =>
          current.requestId === submittedRequestId
            ? emptyCollaborationComposerState(submittedRequestId)
            : current
        );
      })
      .catch((error: unknown) => {
        showError(
          translate("agentHost.agentGui.collaborationComposerStartFailed"),
          error,
          submittedRequestId
        );
      });
  };

  return {
    controls:
      targets.length > 0 ? (
        <AgentComposerCollaborationControls
          agentSessionId={input.agentSessionId}
          attachmentCount={attachmentCount}
          contextScope={contextScope}
          disabled={input.disabled || input.submitDisabled}
          delegationAllowed={delegationAllowed}
          errorMessage={errorMessage}
          mode={mode}
          pending={pending}
          runtime={input.runtime}
          supplement={supplement}
          targets={targets}
          onContextScopeChange={(scope) => {
            updateComposerState({ contextScope: scope, errorMessage: null });
          }}
          onModeChange={(nextMode) => {
            updateComposerState({ errorMessage: null, mode: nextMode });
          }}
          onRetry={() => {
            submitAgentCollaboration();
          }}
          onChooseAnotherMode={() => {
            updateComposerState({ errorMessage: null, mode: null });
          }}
          onReturnToSession={() => {
            input.onDraftContentChange(
              updateAgentComposerDraft(draftContentRef.current, {
                prompt: collaborationQuestionFromPrompt(draftPromptRef.current)
              }),
              input.draftScopeKey
            );
            updateComposerState({
              contextScope: "recent",
              errorMessage: null,
              mode: null,
              supplement: ""
            });
          }}
          onSupplementChange={(nextSupplement) => {
            updateComposerState({ supplement: nextSupplement });
          }}
        />
      ) : null,
    effectiveSubmitDisabled,
    hasCollaborationTargets: targets.length > 0,
    submit
  };
}

function emptyCollaborationComposerState(
  requestId: string
): CollaborationComposerState {
  return {
    contextScope: "recent",
    errorMessage: null,
    mode: null,
    requestId,
    supplement: ""
  };
}
