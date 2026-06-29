import {
  buildAgentEnvWizardViewModel,
  readCodexSetupActiveAction,
  resolveWizardAutoStartAction,
  shouldAdvanceReveal,
  type AgentEnvPanelFocus,
  type AgentSetupStageLabels
} from "@tutti-os/agent-gui/agent-env";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import {
  advanceWizardReveal,
  getAgentEnvWizardSnapshot,
  markWizardAutoStarted,
  resetWizardForOpen,
  restartWizardReveal,
  setWizardReportState,
  REVEAL_ALL,
  REVEAL_STEP_MS
} from "./agentEnvWizardStore.ts";

// The auto-start runAction and the anomaly reportEnvIssue are fired detached;
// both reject on failure (and the service already surfaces a user-facing
// notification). Log for diagnostics so the rejection does not escape as an
// unhandled promise rejection in the renderer.
function logDetachedActionError(
  action: string,
  provider: string,
  err: unknown
): void {
  console.warn(`[agent-env] ${action} failed`, provider, err);
}

// Reveal/auto-start/anomaly are status-driven, not label-driven; the orchestrator
// only needs stage *status*, so it feeds the view-model placeholder labels.
const ORCHESTRATION_LABELS: AgentSetupStageLabels = {
  detect: "",
  network: "",
  install: "",
  adapter: "",
  login: "",
  ready: ""
};

interface Scheduler {
  setTimeout: (cb: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

export interface AttachAgentEnvWizardParams {
  service: IAgentProviderStatusService;
  provider: WorkspaceAgentProvider;
  focus: AgentEnvPanelFocus | null;
  requestSequence: number;
  context: { workspaceId: string; workbenchHost?: unknown };
  scheduler?: Scheduler;
}

function defaultScheduler(): Scheduler {
  return {
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (id) => window.clearTimeout(id)
  };
}

/**
 * Build the view model with REVEAL_ALL so projectRevealedStages does NOT mask
 * the cursor stage (ok → running). The returned displayStages are the real
 * (unprojected) stage statuses, which is what shouldAdvanceReveal requires.
 *
 * CRITICAL: The brief's buildOrchestrationViewModel passes the live revealIndex.
 * projectRevealedStages rewrites the stage AT the cursor from "ok" to "running"
 * (the brief "working on it" animation). If we feed those projected displayStages
 * to shouldAdvanceReveal, the cursor stage is always "running", never "ok", so
 * the advance condition is never satisfied and the reveal freezes.
 *
 * Fix: use REVEAL_ALL as revealIndex — every stage satisfies index < REVEAL_ALL,
 * so projectRevealedStages returns all real statuses unchanged.
 */
function buildRawViewModel(p: AttachAgentEnvWizardParams) {
  const snap = p.service.getSnapshot();
  const status = snap.statuses.find((s) => s.provider === p.provider) ?? null;
  return buildAgentEnvWizardViewModel({
    provider: p.provider,
    status,
    isLoading: snap.isLoading,
    activeAction: readCodexSetupActiveAction(status),
    installActionPending: p.service.isActionPending(p.provider, "install"),
    loginPending: p.service.isActionPending(p.provider, "login"),
    revealIndex: REVEAL_ALL,
    stageLabels: ORCHESTRATION_LABELS
  });
}

export function attachAgentEnvWizard(
  params: AttachAgentEnvWizardParams
): () => void {
  const scheduler = params.scheduler ?? defaultScheduler();
  let revealTimer: number | null = null;
  let detached = false;

  resetWizardForOpen(params.focus);
  // The wizard renders the network diagnostic, so its detections opt into the
  // network probe; the dock and other callers stay local-only.
  if (params.focus) {
    void params.service.refresh([params.provider], { includeNetwork: true });
  } else {
    void params.service.ensureLoaded({
      providers: [params.provider],
      includeNetwork: true
    });
  }

  const clearRevealTimer = (): void => {
    if (revealTimer !== null) {
      scheduler.clearTimeout(revealTimer);
      revealTimer = null;
    }
  };

  const orchestrate = (): void => {
    if (detached) {
      return;
    }
    const snap = params.service.getSnapshot();
    const status =
      snap.statuses.find((s) => s.provider === params.provider) ?? null;
    const wizard = getAgentEnvWizardSnapshot();

    // Raw (unprojected) view-model: built once with revealIndex REVEAL_ALL so
    // projectRevealedStages never masks the cursor stage (ok → running). Both the
    // anomaly and reveal branches consume this, so compute it once per tick.
    const rawVm = buildRawViewModel(params);

    // auto-start (dedup key in store; mark BEFORE running so re-entrant ticks no-op)
    if (wizard.autoStartedSeq !== params.requestSequence) {
      const action = resolveWizardAutoStartAction({
        focus: params.focus,
        detected: !snap.isLoading && status !== null,
        ready: status?.availability.status === "ready",
        installPending: params.service.isActionPending(
          params.provider,
          "install"
        ),
        loginPending: params.service.isActionPending(params.provider, "login")
      });
      if (action) {
        markWizardAutoStarted(params.requestSequence);
        void params.service
          .runAction(params.provider, action, params.context)
          .catch((err) =>
            logDetachedActionError(`auto-start ${action}`, params.provider, err)
          );
      }
    }

    // anomaly report (once per open)
    // hasAnomaly is derived from raw stages (not displayStages) inside
    // buildAgentEnvWizardViewModel, so revealIndex does not affect it.
    if (wizard.reportState === "idle" && rawVm.hasAnomaly) {
      if (params.service.getDiagnosticsConsent()) {
        void params.service
          .reportEnvIssue(params.provider)
          .catch((err) =>
            logDetachedActionError("reportEnvIssue", params.provider, err)
          );
        setWizardReportState("reported");
      } else {
        setWizardReportState("confirming");
      }
    }

    // reveal advance: use raw (unprojected) stages so shouldAdvanceReveal can
    // see the real "ok" status at the cursor, not the projected "running" value.
    clearRevealTimer();
    if (
      shouldAdvanceReveal(
        rawVm.displayStages,
        getAgentEnvWizardSnapshot().revealIndex
      )
    ) {
      revealTimer = scheduler.setTimeout(() => {
        revealTimer = null;
        advanceWizardReveal();
        orchestrate();
      }, REVEAL_STEP_MS);
    }
  };

  // Subscribe, then orchestrate once synchronously. The initial tick is REQUIRED
  // for behavior parity with the old AgentEnvPanel effects: a no-focus casual open
  // onto already-cached status takes the ensureLoaded() cache-hit path, which
  // returns cached data WITHOUT notifying listeners (see
  // desktopAgentProviderStatusService.ensureLoaded). Without this synchronous tick,
  // the anomaly/report-consent prompt would never surface on such an open.
  const unsubscribe = params.service.subscribe(orchestrate);
  orchestrate();

  return () => {
    detached = true;
    clearRevealTimer();
    unsubscribe();
  };
}

export function restartAgentEnvWizardDetection(
  params: AttachAgentEnvWizardParams
): void {
  restartWizardReveal();
  void params.service.refresh([params.provider], { includeNetwork: true });
}
