import { createDecorator } from "@tutti-os/infra/di";
import type {
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  AgentProviderTerminalCommand,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";

export interface AgentProviderStatusActionContext {
  workbenchHost?: unknown;
  workspaceId?: string;
}

export type AgentProviderActionOrigin = "automatic" | "user";

export interface AgentProviderStatusActionOptions {
  context?: AgentProviderStatusActionContext;
  origin?: AgentProviderActionOrigin;
}

// A closable handle to the terminal a command opened, so the caller can dismiss
// it once the command's purpose is fulfilled (e.g. close the login terminal after
// authentication succeeds).
export interface AgentProviderTerminalCommandHandle {
  close(): void;
}

export interface AgentProviderTerminalCommandRunner {
  runTerminalCommand(
    command: AgentProviderTerminalCommand,
    context?: AgentProviderStatusActionContext
  ): Promise<AgentProviderTerminalCommandHandle | void>;
}

export interface AgentProviderStatusPendingAction {
  actionId: string;
  provider: WorkspaceAgentProvider;
}

export interface AgentProviderStatusSnapshot {
  error: string | null;
  isLoading: boolean;
  pendingActions: readonly AgentProviderStatusPendingAction[];
  statuses: readonly AgentProviderStatus[];
  capturedAt: string | null;
  defaultProvider: WorkspaceAgentProvider | null;
}

export interface IAgentProviderStatusService {
  readonly _serviceBrand: undefined;

  getRevision(): number;
  getSnapshot(): AgentProviderStatusSnapshot;
  isActionPending(provider: WorkspaceAgentProvider, actionId: string): boolean;
  isCheckingUpdates(): boolean;
  getStatus(provider: WorkspaceAgentProvider): AgentProviderStatus | null;
  /**
   * Seeds the snapshot from another window's already-captured status (e.g. a
   * detached agent window bootstrapping from the main window's snapshot at
   * open time) so this instance never has to redo a from-scratch check for
   * providers that are already known. No-ops once this instance has captured
   * its own snapshot, so it can never regress fresher local data.
   */
  hydrate(snapshot: AgentProviderStatusSnapshot): void;
  ensureLoaded(input?: {
    providers?: WorkspaceAgentProvider[];
    /**
     * Opt into the network connectivity probe. Off by default so the dock /
     * startup path stays local and never blocks; only the agent-env wizard,
     * which renders the network diagnostic, sets this.
     */
    includeNetwork?: boolean;
    /**
     * Opt into cached remote CLI update discovery. Off by default so ordinary
     * readiness loads stay local.
     */
    includeUpdates?: boolean;
  }): Promise<AgentProviderStatusListResponse | null>;
  /**
   * Reconciles the renderer snapshot with tuttid without bypassing tuttid's
   * provider-status cache. Stale visibility checks use this path; analytics
   * reuses ensureLoaded, and explicit user actions use refresh instead.
   */
  reconcileStatuses(
    providers?: WorkspaceAgentProvider[]
  ): Promise<AgentProviderStatusListResponse | null>;
  runAction(
    provider: WorkspaceAgentProvider,
    actionId: string,
    options?: AgentProviderStatusActionOptions
  ): Promise<void>;
  refresh(
    providers?: WorkspaceAgentProvider[],
    options?: {
      includeNetwork?: boolean;
      includeUpdates?: boolean;
      /**
       * Bypass only the update-metadata cache when includeUpdates is true.
       */
      refreshUpdates?: boolean;
    }
  ): Promise<void>;
  /**
   * Explicit manual update-check path. Always opts into includeUpdates and
   * refreshes cached update metadata; never forces local readiness detection.
   */
  checkUpdates(providers?: WorkspaceAgentProvider[]): Promise<void>;
  subscribe(listener: () => void): () => void;
  /** Whether the user agreed to send fuller diagnostics via "report problem". */
  getDiagnosticsConsent(): boolean;
  setDiagnosticsConsent(value: boolean): void;
  /** Send the consent-gated diagnostic report for a provider (no-op without consent). */
  reportEnvIssue(provider: WorkspaceAgentProvider): Promise<void>;
  dispose(): void;
}

export const IAgentProviderStatusService =
  createDecorator<IAgentProviderStatusService>("agent-provider-status-service");
