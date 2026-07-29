import type {
  AgentActivitySendInput,
  AgentActivitySessionSettings
} from "../types.ts";
import type { PromptQueueSendCommand } from "./promptQueue.types.ts";

/** Internal precondition port used by the Engine prompt effect projection. */
export interface AgentActivityPromptCommandPort<TResult = unknown> {
  sendInput(input: AgentActivitySendInput): Promise<TResult>;
  updateSessionSettings(input: {
    agentSessionId: string;
    settings: AgentActivitySessionSettings;
    workspaceId: string;
  }): Promise<unknown>;
}

/**
 * Executes the host-neutral ordering contract for one Engine prompt command.
 *
 * A required settings patch is part of the submission precondition: the send
 * must not begin until the exact Session accepts that patch. Hosts retain
 * transport, diagnostics, authentication, and result mapping.
 *
 * Engine-internal implementation. Hosts implement AgentSessionEffectPort
 * instead of importing this helper from the package root.
 */
export async function executeAgentActivityPromptCommand<TResult>(
  port: AgentActivityPromptCommandPort<TResult>,
  command: PromptQueueSendCommand,
  options?: { signal?: AbortSignal }
): Promise<TResult> {
  throwIfAborted(options?.signal);
  if (command.requiredSettingsPatch) {
    await port.updateSessionSettings({
      agentSessionId: command.agentSessionId,
      settings: { ...command.requiredSettingsPatch },
      workspaceId: command.workspaceId
    });
    throwIfAborted(options?.signal);
  }
  return port.sendInput({
    agentSessionId: command.agentSessionId,
    ...(command.capabilityRefs?.length
      ? { capabilityRefs: command.capabilityRefs }
      : {}),
    clientSubmitId: command.clientSubmitId,
    content: [...command.content],
    displayPrompt: command.displayPrompt ?? null,
    ...(command.guidance === true ? { guidance: true } : {}),
    ...(command.submitDiagnostics
      ? { submitDiagnostics: { ...command.submitDiagnostics } }
      : {}),
    workspaceId: command.workspaceId
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}
