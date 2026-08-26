import type {
  AgentActivityCreateSessionInput,
  AgentActivitySendInput,
  AgentActivitySubmitDiagnostics,
  AgentPromptContentBlock,
  AgentSessionActivateEffectInput
} from "@tutti-os/agent-activity-core";
import type {
  AgentPromptContentBlock as TuttidAgentPromptContentBlock,
  AgentSubmitDiagnostics,
  CreateWorkspaceAgentSessionRequest,
  SendWorkspaceAgentSessionInputRequest,
  TuttiModeActivationIntent
} from "@tutti-os/client-tuttid-ts";
import { tuttiCapabilityReferencesFromActivity } from "./capabilityReferences.ts";

type NewAgentSessionActivationInput = Extract<
  AgentSessionActivateEffectInput,
  { mode: "new" }
>;

export function tuttiCreateWorkspaceAgentSessionRequestFromActivity(
  input: AgentActivityCreateSessionInput & { agentSessionId: string },
  options: { recordingId?: string | null } = {}
): CreateWorkspaceAgentSessionRequest {
  const capabilityRefs = tuttiCapabilityReferencesFromActivity(
    input.capabilityRefs
  );
  return {
    agentSessionId: input.agentSessionId,
    agentTargetId: input.agentTargetId,
    ...(typeof input.browserUse === "boolean"
      ? { browserUse: input.browserUse }
      : {}),
    ...(typeof input.codexSaverMode === "boolean"
      ? { codexSaverMode: input.codexSaverMode }
      : {}),
    ...(typeof input.rtkSaverMode === "boolean"
      ? { rtkSaverMode: input.rtkSaverMode }
      : {}),
    ...(capabilityRefs.length > 0 ? { capabilityRefs } : {}),
    clientSubmitId: input.clientSubmitId,
    cwd: input.cwd ?? null,
    ...(input.isolation ? { isolation: input.isolation } : {}),
    initialContent: input.initialGoalControl
      ? []
      : tuttiPromptContentBlocksFromActivity(input.initialContent ?? []),
    initialDisplayPrompt: input.initialDisplayPrompt ?? null,
    ...(input.initialGoalControl
      ? { initialGoalControl: { ...input.initialGoalControl } }
      : {}),
    ...(input.initialTuttiModeActivation
      ? {
          initialTuttiModeActivation: tuttiInitialModeActivationFromActivity(
            input.initialTuttiModeActivation
          )
        }
      : {}),
    ...(input.submitDiagnostics
      ? {
          submitDiagnostics: tuttiSubmitDiagnosticsFromActivity(
            input.submitDiagnostics
          )
        }
      : {}),
    model: input.model ?? null,
    ...(input.modelExplicit !== undefined
      ? { modelExplicit: input.modelExplicit }
      : {}),
    ...(input.noProject !== undefined
      ? { noProject: input.noProject ?? null }
      : {}),
    ...(input.railPlacement
      ? { railPlacement: { ...input.railPlacement } }
      : {}),
    permissionModeId: input.permissionModeId ?? null,
    planMode: input.planMode ?? null,
    ...(options.recordingId ? { recordingId: options.recordingId } : {}),
    reasoningEffort: input.reasoningEffort ?? null,
    ...(input.reasoningEffortExplicit !== undefined
      ? { reasoningEffortExplicit: input.reasoningEffortExplicit }
      : {}),
    speed: input.speed ?? null,
    title: input.title ?? null,
    visible: input.visible ?? null
  };
}

export function tuttiCreateWorkspaceAgentSessionRequestFromActivation(
  input: NewAgentSessionActivationInput
): CreateWorkspaceAgentSessionRequest {
  return tuttiCreateWorkspaceAgentSessionRequestFromActivity({
    agentSessionId: input.agentSessionId,
    agentTargetId: input.agentTargetId,
    ...(typeof input.settings?.browserUse === "boolean"
      ? { browserUse: input.settings.browserUse }
      : {}),
    ...(typeof input.settings?.codexSaverMode === "boolean"
      ? { codexSaverMode: input.settings.codexSaverMode }
      : {}),
    ...(typeof input.settings?.rtkSaverMode === "boolean"
      ? { rtkSaverMode: input.settings.rtkSaverMode }
      : {}),
    capabilityRefs: input.capabilityRefs
      ? input.capabilityRefs.map((reference) => ({ ...reference }))
      : undefined,
    clientSubmitId: input.clientSubmitId,
    cwd: input.cwd,
    isolation: input.isolation,
    initialContent: input.initialContent
      ? input.initialContent.map((block) => ({ ...block }))
      : undefined,
    initialDisplayPrompt: input.initialDisplayPrompt,
    initialGoalControl: input.initialGoalControl
      ? { ...input.initialGoalControl }
      : undefined,
    initialTuttiModeActivation: input.initialTuttiModeActivation
      ? { ...input.initialTuttiModeActivation }
      : undefined,
    model: input.settings?.model,
    modelExplicit: input.modelExplicit,
    permissionModeId: input.settings?.permissionModeId,
    planMode: input.settings?.planMode,
    railPlacement: input.railPlacement ? { ...input.railPlacement } : undefined,
    reasoningEffort: input.settings?.reasoningEffort,
    reasoningEffortExplicit: input.reasoningEffortExplicit,
    speed: input.settings?.speed,
    submitDiagnostics: input.submitDiagnostics
      ? { ...input.submitDiagnostics }
      : undefined,
    title: input.title,
    visible: input.visible ?? true,
    workspaceId: input.workspaceId
  });
}

export function tuttiSendWorkspaceAgentSessionInputRequestFromActivity(
  input: AgentActivitySendInput
): SendWorkspaceAgentSessionInputRequest {
  const capabilityRefs = tuttiCapabilityReferencesFromActivity(
    input.capabilityRefs
  );
  return {
    ...(capabilityRefs.length > 0 ? { capabilityRefs } : {}),
    clientSubmitId: input.clientSubmitId,
    content: tuttiPromptContentBlocksFromActivity(input.content),
    displayPrompt: input.displayPrompt ?? null,
    ...(input.guidance === true ? { guidance: true } : {}),
    ...(input.guidance === true && input.targetTurnId?.trim()
      ? { turnId: input.targetTurnId.trim() }
      : {}),
    ...(input.submitDiagnostics
      ? {
          submitDiagnostics: tuttiSubmitDiagnosticsFromActivity(
            input.submitDiagnostics
          )
        }
      : {})
  };
}

function tuttiPromptContentBlocksFromActivity(
  content: readonly AgentPromptContentBlock[]
): TuttidAgentPromptContentBlock[] {
  return content.map((block) => {
    if (block.type === "file") {
      throw new Error("File prompt blocks must be uploaded before submission");
    }
    if (
      block.type !== "text" &&
      block.type !== "image" &&
      block.type !== "skill" &&
      block.type !== "mention" &&
      block.type !== "connector"
    ) {
      throw new Error("Unsupported workspace agent prompt content block");
    }
    const nextBlock: TuttidAgentPromptContentBlock = { type: block.type };
    if (block.attachmentId !== undefined) {
      nextBlock.attachmentId = block.attachmentId;
    }
    if (block.data !== undefined) {
      nextBlock.data = block.data;
    }
    if (block.url !== undefined) {
      nextBlock.url = block.url;
    }
    if (block.mimeType !== undefined) {
      if (
        block.mimeType !== "image/png" &&
        block.mimeType !== "image/jpeg" &&
        block.mimeType !== "image/webp"
      ) {
        throw new Error("Unsupported workspace agent prompt image MIME type");
      }
      nextBlock.mimeType = block.mimeType;
    }
    if (block.name !== undefined) {
      nextBlock.name = block.name;
    }
    if (block.path !== undefined) {
      nextBlock.path = block.path;
    }
    if (block.connectorKey !== undefined) {
      nextBlock.connectorKey = block.connectorKey;
    }
    if (block.text !== undefined) {
      nextBlock.text = block.text;
    }
    return nextBlock;
  });
}

function tuttiSubmitDiagnosticsFromActivity(
  input: AgentActivitySubmitDiagnostics
): AgentSubmitDiagnostics {
  return {
    ...(input.blockCount !== undefined ? { blockCount: input.blockCount } : {}),
    ...(input.hasImage !== undefined ? { hasImage: input.hasImage } : {}),
    ...(input.promptLength !== undefined
      ? { promptLength: input.promptLength }
      : {}),
    ...(input.queued !== undefined ? { queued: input.queued } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.submittedAtUnixMs !== undefined
      ? { submittedAtUnixMs: input.submittedAtUnixMs }
      : {}),
    ...(input.uiMode !== undefined ? { uiMode: input.uiMode } : {})
  };
}

function tuttiInitialModeActivationFromActivity(
  input: NonNullable<
    AgentActivityCreateSessionInput["initialTuttiModeActivation"]
  >
): TuttiModeActivationIntent {
  return {
    effect: input.effect ?? input.orchestrationIntensity ?? null,
    source: input.source,
    speed: input.speed ?? null,
    status: input.status
  };
}
