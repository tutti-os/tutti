import type { AgentEnvPanelFocus } from "@tutti-os/agent-gui/agent-env";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type {
  AgentEnvReportState,
  AgentEnvSnapshot
} from "../agentEnvService.interface.ts";
import {
  desktopManagedAgentDefaultProvider,
  isDesktopManagedAgentProvider
} from "./desktopManagedAgentProviders.ts";

export const AGENT_ENV_REVEAL_STEP_MS = 450;
export const AGENT_ENV_REVEAL_ALL = Number.MAX_SAFE_INTEGER;

export interface AgentEnvControllerStatusInput {
  installPending: boolean;
  isLoading: boolean;
  loginPending: boolean;
  status: AgentProviderStatus | null;
}

export interface AgentEnvPanelRequest {
  readonly focus: AgentEnvPanelFocus | null;
  readonly open: boolean;
  readonly provider: string | null;
  readonly requestSequence: number;
}

export class AgentEnvController {
  private focus: AgentEnvPanelFocus | null = null;
  private autoActionAccepted = false;
  private snapshot: AgentEnvSnapshot = {
    copied: false,
    installPending: false,
    isLoading: false,
    isSupported: true,
    logExpanded: false,
    loginPending: false,
    open: false,
    provider: desktopManagedAgentDefaultProvider,
    reportState: "idle",
    requestSequence: 0,
    revealIndex: AGENT_ENV_REVEAL_ALL,
    status: null
  };

  getSnapshot(): AgentEnvSnapshot {
    return this.snapshot;
  }

  getFocus(): AgentEnvPanelFocus | null {
    return this.focus;
  }

  applyRequest(
    request: AgentEnvPanelRequest,
    defaultProvider: WorkspaceAgentProvider | null
  ): { sessionChanged: boolean } {
    const resolved = resolveActiveProvider(request.provider, defaultProvider);
    const sessionChanged =
      request.requestSequence !== this.snapshot.requestSequence ||
      resolved.provider !== this.snapshot.provider;
    this.focus = request.focus;
    this.snapshot = {
      ...this.snapshot,
      open: request.open,
      provider: resolved.provider,
      isSupported: resolved.isSupported,
      requestSequence: request.requestSequence,
      ...(sessionChanged
        ? {
            copied: false,
            installPending: false,
            isLoading: false,
            logExpanded: false,
            loginPending: false,
            reportState: "idle" as const,
            revealIndex: request.focus === "detect" ? 0 : AGENT_ENV_REVEAL_ALL,
            status: null
          }
        : {})
    };
    if (sessionChanged) {
      this.autoActionAccepted = false;
    }
    return { sessionChanged };
  }

  applyStatus(input: AgentEnvControllerStatusInput): void {
    this.snapshot = { ...this.snapshot, ...input };
  }

  hasAcceptedAutoAction(): boolean {
    return this.autoActionAccepted;
  }

  acceptAutoAction(): void {
    this.autoActionAccepted = true;
  }

  restartReveal(): void {
    this.snapshot = {
      ...this.snapshot,
      copied: false,
      logExpanded: false,
      reportState: "idle",
      revealIndex: 0
    };
  }

  advanceReveal(): void {
    this.snapshot = {
      ...this.snapshot,
      revealIndex: this.snapshot.revealIndex + 1
    };
  }

  setReportState(reportState: AgentEnvReportState): void {
    this.snapshot = { ...this.snapshot, reportState };
  }

  setCopied(copied: boolean): void {
    this.snapshot = { ...this.snapshot, copied };
  }

  toggleLog(): void {
    this.snapshot = {
      ...this.snapshot,
      logExpanded: !this.snapshot.logExpanded
    };
  }
}

function resolveActiveProvider(
  requested: string | null,
  defaultProvider: WorkspaceAgentProvider | null
): { provider: WorkspaceAgentProvider; isSupported: boolean } {
  if (requested) {
    return {
      provider: requested as WorkspaceAgentProvider,
      isSupported: isDesktopManagedAgentProvider(requested)
    };
  }
  if (defaultProvider && isDesktopManagedAgentProvider(defaultProvider)) {
    return { provider: defaultProvider, isSupported: true };
  }
  return {
    provider: desktopManagedAgentDefaultProvider,
    isSupported: true
  };
}
