import {
  buildAgentEnvWizardViewModel,
  readCodexSetupActiveAction,
  resolveWizardAutoStartAction,
  shouldAdvanceReveal,
  type AgentSetupStageLabels,
  type OpenAgentEnvPanelInput,
  type StageActionId
} from "@tutti-os/agent-gui/agent-env";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type {
  AgentEnvSnapshot,
  IAgentEnvService
} from "../agentEnvService.interface.ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import {
  AGENT_ENV_REVEAL_ALL,
  AGENT_ENV_REVEAL_STEP_MS,
  AgentEnvController,
  type AgentEnvPanelRequest
} from "./agentEnvController.ts";

const ORCHESTRATION_LABELS: AgentSetupStageLabels = {
  detect: "",
  network: "",
  install: "",
  adapter: "",
  login: "",
  ready: ""
};

interface AgentEnvScheduler {
  clearTimeout(timer: number): void;
  setTimeout(callback: () => void, delayMs: number): number;
}

export interface AgentEnvServiceDependencies {
  clipboard: { writeText(text: string): Promise<void> };
  providerStatusService: IAgentProviderStatusService;
  scheduler?: AgentEnvScheduler;
  workspaceId: string;
}

export class AgentEnvService implements IAgentEnvService {
  readonly _serviceBrand: undefined;

  private readonly controller = new AgentEnvController();
  private readonly dependencies: AgentEnvServiceDependencies;
  private readonly listeners = new Set<() => void>();
  private readonly scheduler: AgentEnvScheduler;
  private readonly unsubscribeProviderStatus: () => void;
  private panelRequest: AgentEnvPanelRequest = {
    focus: null,
    open: false,
    provider: null,
    requestSequence: 0
  };
  private hostBinding: { host: WorkbenchHostHandle; token: symbol } | null =
    null;
  private revealTimer: number | null = null;
  private disposed = false;
  private orchestrating = false;

  constructor(dependencies: AgentEnvServiceDependencies) {
    this.dependencies = dependencies;
    this.scheduler =
      dependencies.scheduler ??
      ({
        clearTimeout: (timer) => window.clearTimeout(timer),
        setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs)
      } satisfies AgentEnvScheduler);
    this.unsubscribeProviderStatus =
      dependencies.providerStatusService.subscribe(() => {
        this.syncProviderStatus();
      });
    this.syncProviderStatus();
  }

  getSnapshot(): AgentEnvSnapshot {
    return this.controller.getSnapshot();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bindWorkbenchHost(host: WorkbenchHostHandle): () => void {
    const token = Symbol("agent-env-workbench-host");
    this.hostBinding = { host, token };
    this.orchestrate();
    return () => {
      if (this.hostBinding?.token === token) {
        this.hostBinding = null;
      }
    };
  }

  open(input?: OpenAgentEnvPanelInput): void {
    this.panelRequest = {
      focus: input?.focus ?? null,
      open: true,
      provider: input?.provider ?? null,
      requestSequence: this.panelRequest.requestSequence + 1
    };
    this.syncRequest();
  }

  close(): void {
    if (!this.panelRequest.open) {
      return;
    }
    this.panelRequest = { ...this.panelRequest, open: false };
    this.syncRequest();
  }

  redetect(): void {
    const snapshot = this.controller.getSnapshot();
    this.clearRevealTimer();
    this.controller.restartReveal();
    this.emit();
    void this.dependencies.providerStatusService
      .refresh([snapshot.provider], { includeNetwork: true })
      .catch((error) =>
        logDetachedActionError("redetect", snapshot.provider, error)
      );
  }

  async runStageAction(actionId: StageActionId): Promise<void> {
    if (actionId === "redetect") {
      this.redetect();
      return;
    }
    const snapshot = this.controller.getSnapshot();
    await this.dependencies.providerStatusService.runAction(
      snapshot.provider,
      actionId,
      {
        context: {
          workbenchHost: this.hostBinding?.host,
          workspaceId: this.dependencies.workspaceId
        },
        origin: "user"
      }
    );
  }

  confirmReport(): void {
    const snapshot = this.controller.getSnapshot();
    this.dependencies.providerStatusService.setDiagnosticsConsent(true);
    this.controller.setReportState("reported");
    this.emit();
    void this.dependencies.providerStatusService
      .reportEnvIssue(snapshot.provider)
      .catch((error) =>
        logDetachedActionError("reportEnvIssue", snapshot.provider, error)
      );
  }

  dismissReport(): void {
    this.controller.setReportState("dismissed");
    this.emit();
  }

  async copyManual(command: string): Promise<void> {
    try {
      await this.dependencies.clipboard.writeText(command);
      this.controller.setCopied(true);
    } catch {
      this.controller.setCopied(false);
    }
    this.emit();
  }

  toggleLog(): void {
    this.controller.toggleLog();
    this.emit();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearRevealTimer();
    this.unsubscribeProviderStatus();
    this.hostBinding = null;
    this.listeners.clear();
  }

  private syncRequest(): void {
    if (this.disposed) {
      return;
    }
    const request = this.panelRequest;
    const statusSnapshot =
      this.dependencies.providerStatusService.getSnapshot();
    const { sessionChanged } = this.controller.applyRequest(
      request,
      statusSnapshot.defaultProvider
    );
    if (sessionChanged) {
      this.clearRevealTimer();
      const snapshot = this.controller.getSnapshot();
      if (snapshot.open && snapshot.isSupported) {
        const detection = request.focus
          ? this.dependencies.providerStatusService.refresh(
              [snapshot.provider],
              { includeNetwork: true }
            )
          : this.dependencies.providerStatusService.ensureLoaded({
              providers: [snapshot.provider],
              includeNetwork: true
            });
        void detection.catch((error) =>
          logDetachedActionError("detect", snapshot.provider, error)
        );
      }
    }
    this.syncProviderStatus();
  }

  private syncProviderStatus(): void {
    if (this.disposed) {
      return;
    }
    const service = this.dependencies.providerStatusService;
    const statusSnapshot = service.getSnapshot();
    const current = this.controller.getSnapshot();
    const status =
      statusSnapshot.statuses.find(
        (candidate) => candidate.provider === current.provider
      ) ?? null;
    this.controller.applyStatus({
      installPending: service.isActionPending(current.provider, "install"),
      isLoading: statusSnapshot.isLoading,
      loginPending: service.isActionPending(current.provider, "login"),
      status
    });
    this.emit();
    this.orchestrate();
  }

  private orchestrate(): void {
    if (this.disposed || this.orchestrating) {
      return;
    }
    const snapshot = this.controller.getSnapshot();
    if (!snapshot.open || !snapshot.isSupported) {
      this.clearRevealTimer();
      return;
    }
    this.orchestrating = true;
    try {
      const rawViewModel = buildAgentEnvWizardViewModel({
        provider: snapshot.provider,
        status: snapshot.status,
        isLoading: snapshot.isLoading,
        activeAction: readCodexSetupActiveAction(snapshot.status),
        installActionPending: snapshot.installPending,
        loginPending: snapshot.loginPending,
        revealIndex: AGENT_ENV_REVEAL_ALL,
        stageLabels: ORCHESTRATION_LABELS
      });

      if (!this.controller.hasAcceptedAutoAction()) {
        const action = resolveWizardAutoStartAction({
          focus: this.controller.getFocus(),
          detected: !snapshot.isLoading && snapshot.status !== null,
          ready: snapshot.status?.availability.status === "ready",
          installPending: snapshot.installPending,
          loginPending: snapshot.loginPending
        });
        if (action && (action !== "login" || this.hostBinding)) {
          this.controller.acceptAutoAction();
          void this.dependencies.providerStatusService
            .runAction(snapshot.provider, action, {
              context: {
                workbenchHost: this.hostBinding?.host,
                workspaceId: this.dependencies.workspaceId
              },
              origin: "automatic"
            })
            .catch((error) =>
              logDetachedActionError(
                `auto-start ${action}`,
                snapshot.provider,
                error
              )
            );
        }
      }

      if (snapshot.reportState === "idle" && rawViewModel.hasAnomaly) {
        if (this.dependencies.providerStatusService.getDiagnosticsConsent()) {
          this.controller.setReportState("reported");
          void this.dependencies.providerStatusService
            .reportEnvIssue(snapshot.provider)
            .catch((error) =>
              logDetachedActionError("reportEnvIssue", snapshot.provider, error)
            );
        } else {
          this.controller.setReportState("confirming");
        }
        this.emit();
      }

      this.clearRevealTimer();
      if (
        shouldAdvanceReveal(rawViewModel.displayStages, snapshot.revealIndex)
      ) {
        this.revealTimer = this.scheduler.setTimeout(() => {
          this.revealTimer = null;
          this.controller.advanceReveal();
          this.emit();
          this.orchestrate();
        }, AGENT_ENV_REVEAL_STEP_MS);
      }
    } finally {
      this.orchestrating = false;
    }
  }

  private clearRevealTimer(): void {
    if (this.revealTimer === null) {
      return;
    }
    this.scheduler.clearTimeout(this.revealTimer);
    this.revealTimer = null;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function logDetachedActionError(
  action: string,
  provider: string,
  error: unknown
): void {
  console.warn(`[agent-env] ${action} failed`, provider, error);
}
