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
  await runDaemonProviderAction(tuttidClient, provider, "install");
}

export async function runDaemonProviderAction(
  tuttidClient: TuttidClient,
  provider: WorkspaceAgentProvider,
  actionId: "install" | "update"
): Promise<void> {
  const result = await tuttidClient.runAgentProviderAction(provider, actionId);
  if (result.status !== "failed") {
    return;
  }
  throw new AgentProviderInstallActionFailedError(
    resolveAgentProviderActionFailureReason(result, actionId),
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

export function resolveAgentProviderUpdateErrorMessage(error: unknown): string {
  if (error instanceof AgentProviderInstallActionFailedError) {
    return summarizeAgentProviderUpdateFailureReason(error.reason);
  }
  const message = resolveDesktopErrorMessage(error, getActiveLocale());
  if (isTechnicalInstallFailureMessage(message)) {
    return summarizeAgentProviderUpdateFailureReason(message);
  }
  return message;
}

export function shouldTrackPendingAction(actionId: string): boolean {
  return actionId === "install" || actionId === "update";
}

function resolveAgentProviderActionFailureReason(
  result: AgentProviderActionRunResponse,
  actionId: "install" | "update" = "install"
): string {
  return (
    result.message?.trim() ||
    result.reasonCode?.trim() ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    result.probe?.message?.trim() ||
    result.probe?.reasonCode?.trim() ||
    (actionId === "update"
      ? "Agent provider update action failed."
      : "Agent provider install action failed.")
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
    normalized.includes("eexist") &&
    (normalized.includes("file exists") ||
      normalized.includes("npm error path")) &&
    normalized.includes("tutti-agent")
  ) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.installFailedOutdatedLocalAgent"
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

function summarizeAgentProviderUpdateFailureReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.updateFailedDescription"
    );
  }
  const normalized = trimmed.toLowerCase();
  if (
    normalized.includes("timed out") ||
    normalized.includes("install_timed_out") ||
    normalized.includes("update_timed_out")
  ) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.updateFailedTimedOut"
    );
  }
  if (trimmed.length <= 120 && !trimmed.includes("\n")) {
    return trimmed;
  }
  return translate(
    "workspace.workbenchDesktop.agentProviders.updateFailedDescription"
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
