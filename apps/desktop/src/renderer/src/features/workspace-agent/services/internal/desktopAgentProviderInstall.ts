import type {
  AgentProviderActionRunResponse,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { translate } from "../../../../i18n/appRuntime.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import { resolveDesktopErrorMessage } from "../../../../lib/desktopErrors.ts";

class AgentProviderInstallActionFailedError extends Error {
  readonly reasonCode: string | null;
  readonly reason: string;

  constructor(reason: string, reasonCode: string | null) {
    super(reason);
    this.reason = reason;
    this.reasonCode = reasonCode;
    this.name = "AgentProviderInstallActionFailedError";
  }
}

export async function runInstalledProviderAction(
  tuttidClient: TuttidClient,
  provider: WorkspaceAgentProvider
): Promise<void> {
  const result = await tuttidClient.runAgentProviderAction(provider, "install");
  if (result.status !== "failed") {
    return;
  }
  throw new AgentProviderInstallActionFailedError(
    resolveAgentProviderActionFailureReason(result),
    result.reasonCode?.trim() || null
  );
}

export function resolveAgentProviderInstallErrorMessage(
  error: unknown
): string {
  if (error instanceof AgentProviderInstallActionFailedError) {
    if (error.reasonCode === "install_unavailable_in_region") {
      return translate(
        "workspace.workbenchDesktop.agentProviders.installUnavailableInRegion"
      );
    }
    return summarizeAgentProviderInstallFailureReason(error.reason);
  }
  const message = resolveDesktopErrorMessage(error, getActiveLocale());
  if (isTechnicalInstallFailureMessage(message)) {
    return summarizeAgentProviderInstallFailureReason(message);
  }
  return message;
}

export function shouldTrackPendingAction(actionId: string): boolean {
  return actionId === "install";
}

function resolveAgentProviderActionFailureReason(
  result: AgentProviderActionRunResponse
): string {
  return (
    result.message?.trim() ||
    result.reasonCode?.trim() ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    result.probe?.message?.trim() ||
    result.probe?.reasonCode?.trim() ||
    "Agent provider install action failed."
  );
}

function summarizeAgentProviderInstallFailureReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.installFailedDescription"
    );
  }
  const normalized = trimmed.toLowerCase();
  if (
    normalized.includes("timed out") ||
    normalized.includes("install_timed_out")
  ) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.installFailedTimedOut"
    );
  }
  if (
    normalized.includes("enoent") ||
    normalized.includes("error: spawn") ||
    normalized.includes("spawn ") ||
    normalized.includes("post_install_probe_failed") ||
    isTechnicalInstallFailureMessage(trimmed)
  ) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.installFailedMissingRuntime"
    );
  }
  if (trimmed.length <= 120 && !trimmed.includes("\n")) {
    return trimmed;
  }
  return translate(
    "workspace.workbenchDesktop.agentProviders.installFailedDescription"
  );
}

function isTechnicalInstallFailureMessage(message: string): boolean {
  return (
    message.includes("\n") ||
    message.includes(" at ") ||
    message.includes("errno:") ||
    message.includes("syscall:") ||
    message.includes("spawnargs:") ||
    message.includes("ChildProcess")
  );
}
