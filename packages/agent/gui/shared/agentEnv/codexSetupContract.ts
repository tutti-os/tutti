import type {
  AgentProviderActiveAction,
  AgentProviderActiveActionError,
  AgentProviderActiveActionPhase,
  AgentProviderActiveActionStep,
  AgentProviderActiveActionStepStatus,
  AgentProviderStatus
} from "@tutti-os/client-tuttid-ts";

// Compatibility aliases for the existing Agent Environment UI. The wire
// contract is generated from OpenAPI; this module must not maintain a second
// parser or enum vocabulary.
export type CodexSetupStepStatus = AgentProviderActiveActionStepStatus;
export type CodexSetupStep = AgentProviderActiveActionStep;
export type CodexSetupPhase = AgentProviderActiveActionPhase;
export type CodexSetupActiveActionError = AgentProviderActiveActionError;
export type CodexSetupActiveAction = AgentProviderActiveAction;

export function readCodexSetupActiveAction(
  status: Pick<AgentProviderStatus, "activeAction"> | null | undefined
): AgentProviderActiveAction | null {
  return status?.activeAction ?? null;
}
