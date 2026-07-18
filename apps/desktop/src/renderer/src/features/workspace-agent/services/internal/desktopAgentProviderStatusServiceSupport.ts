import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import type {
  AgentProviderStatusActionContext,
  AgentProviderStatusActionOptions
} from "../agentProviderStatusService.interface.ts";

export function normalizeAgentProviderActionOptions(
  input: AgentProviderStatusActionOptions | AgentProviderStatusActionContext
): AgentProviderStatusActionOptions {
  if ("context" in input || "origin" in input) {
    return input as AgentProviderStatusActionOptions;
  }
  return { context: input as AgentProviderStatusActionContext };
}

export function providerStatusRequestKey(input: {
  providers?: readonly WorkspaceAgentProvider[];
  includeNetwork?: boolean;
}): string {
  const providers = [...new Set(input.providers ?? [])].sort();
  return JSON.stringify({
    includeNetwork: input.includeNetwork === true,
    providers: providers.length > 0 ? providers : null
  });
}

export function unrefAgentProviderTimer(
  timer: number | { unref?: () => void }
): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
}

export function withAgentProviderRequestTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timeoutID: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutID = setTimeout(() => {
      reject(new Error("Agent provider status request timed out."));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutID) {
      clearTimeout(timeoutID);
    }
  });
}
