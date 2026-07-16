import { useEffect, useRef, useState, type ReactNode } from "react";
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

/**
 * Owns the explicit @Agent composer branch. Normal prompt submission remains
 * in AgentComposer/useComposerSlashActions; this hook only intercepts durable
 * agent-target mentions and launches the daemon-owned collaboration run.
 */
export function useComposerAgentCollaboration(input: Input): Result {
  const targets = agentCollaborationTargetsFromPrompt(input.draftPrompt);
  const targetKey = targets.map((target) => target.targetId).join("\u0000");
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

  const [mode, setMode] = useState<AgentComposerCollaborationMode | null>(null);
  const [contextScope, setContextScope] =
    useState<AgentComposerCollaborationContextScope>("recent");
  const [supplement, setSupplement] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setMode(null);
    setContextScope("recent");
    setSupplement("");
    setErrorMessage(null);
  }, [input.draftScopeKey, targetKey]);

  const blocked =
    targets.length > 0 &&
    (targets.length !== 1 ||
      !input.agentSessionId ||
      !input.runtime?.startAgentCollaboration ||
      !delegationAllowed ||
      !mode ||
      attachmentCount > 0);
  const effectiveSubmitDisabled = input.submitDisabled || pending || blocked;

  const showError = (message: string, error?: unknown): void => {
    setErrorMessage(message);
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
    void submitAgentCollaboration();
  };

  const submitAgentCollaboration = async (): Promise<void> => {
    if (pending) {
      return;
    }
    const startAgentCollaboration = input.runtime?.startAgentCollaboration;
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
    if (!startAgentCollaboration) {
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
    setErrorMessage(null);
    setPending(true);
    try {
      const run = await startAgentCollaboration({
        agentSessionId: input.agentSessionId,
        contextScope,
        contextText: supplement.trim() || null,
        mode,
        question: collaborationQuestionFromPrompt(submittedPrompt),
        targetAgentTargetId: target.targetId,
        workspaceId: input.workspaceId
      });
      if (run.status === "failed") {
        showError(
          translate("agentHost.agentGui.collaborationComposerStartFailed")
        );
        return;
      }
      if (draftContentRef.current === submittedDraft) {
        input.onDraftContentChange(
          emptyAgentComposerDraft(),
          submittedScopeKey
        );
      }
      setMode(null);
      setContextScope("recent");
      setSupplement("");
      setErrorMessage(null);
    } catch (error) {
      showError(
        translate("agentHost.agentGui.collaborationComposerStartFailed"),
        error
      );
    } finally {
      setPending(false);
    }
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
            setContextScope(scope);
            setErrorMessage(null);
          }}
          onModeChange={(nextMode) => {
            setMode(nextMode);
            setErrorMessage(null);
          }}
          onRetry={() => {
            void submitAgentCollaboration();
          }}
          onChooseAnotherMode={() => {
            setMode(null);
            setErrorMessage(null);
          }}
          onReturnToSession={() => {
            input.onDraftContentChange(
              updateAgentComposerDraft(draftContentRef.current, {
                prompt: collaborationQuestionFromPrompt(draftPromptRef.current)
              }),
              input.draftScopeKey
            );
            setMode(null);
            setContextScope("recent");
            setSupplement("");
            setErrorMessage(null);
          }}
          onSupplementChange={setSupplement}
        />
      ) : null,
    effectiveSubmitDisabled,
    hasCollaborationTargets: targets.length > 0,
    submit
  };
}
