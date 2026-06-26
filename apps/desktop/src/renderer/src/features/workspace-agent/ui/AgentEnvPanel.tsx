import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";
import { useSyncExternalStore } from "react";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  Button,
  CheckIcon,
  CopyIcon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  LoadingIcon,
  RefreshIcon,
  SuccessFilledIcon,
  WarningFilledIcon
} from "@tutti-os/ui-system";
import {
  readCodexSetupActiveAction,
  useAgentEnvPanelRequest,
  closeAgentEnvPanel,
  deriveAgentSetupStages,
  projectRevealedStages,
  resolveWizardAutoStartAction,
  shouldAdvanceReveal,
  stageRemediation,
  type AgentSetupStage,
  type AgentSetupStageId,
  type CodexSetupPhase,
  type CodexSetupStepStatus,
  type StageActionId,
  type StageProblem
} from "@tutti-os/agent-gui/agent-env";
import { useTranslation } from "@renderer/i18n";
import type { IAgentProviderStatusService } from "../services/agentProviderStatusService.interface";
import {
  desktopManagedAgentProviders,
  isDesktopManagedAgentProvider
} from "../services/internal/desktopManagedAgentProviders.ts";

interface AgentEnvPanelProps {
  agentProviderStatusService: IAgentProviderStatusService;
  workspaceId: string;
  workbenchHost?: unknown;
}

// Cadence of the step-by-step reveal — each already-satisfied stage waits this
// long before checking off, so the track animates instead of flashing complete.
const REVEAL_STEP_MS = 450;

// A reveal cursor parked past the last step: every step shows its real status
// immediately, with no walk-through animation. Used when opening onto an
// already-known status so the track doesn't replay from step 1 on every open —
// the animation is reserved for an actual re-detect.
const REVEAL_ALL = Number.MAX_SAFE_INTEGER;

const PROVIDER_LABELS: Partial<Record<WorkspaceAgentProvider, string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  gemini: "Gemini",
  nexight: "Nexight",
  hermes: "Hermes",
  openclaw: "OpenClaw"
};

// Best-effort manual install command for the "install it yourself" escape hatch.
// The daemon owns the real install; this is only a copyable fallback.
const MANUAL_INSTALL_COMMANDS: Partial<Record<WorkspaceAgentProvider, string>> =
  {
    codex: "npm install -g @openai/codex",
    "claude-code": "npm install -g @anthropic-ai/claude-code"
  };

function resolveProviderLabel(provider: WorkspaceAgentProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

// Trim an endpoint URL down to its host for display, e.g.
// "https://registry.npmjs.org" -> "registry.npmjs.org".
function endpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) {
    return null;
  }
  return endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
}

// The network step shows its checks separately: the npm registry (install path),
// the provider's API (run/login path), and the proxy in front of them.
interface NetworkCheck {
  kind: "registry" | "api" | "proxy";
  reachable: boolean;
  host: string | null;
  // Proxy-only: whether a proxy is configured at all. When false, the line reads
  // "direct / not configured" and never counts as a connectivity failure.
  configured?: boolean;
}

function useStatusSnapshot(service: IAgentProviderStatusService) {
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getSnapshot()
  );
}

/**
 * Maps a blocked stage's problem token onto the "未xxx" headline and the
 * "进行xxx" action label, plus whether it reads as an error (version problem)
 * or a not-yet-done warning. The action id itself comes from stageRemediation.
 */
function describeStageProblem(
  problem: StageProblem,
  providerLabel: string,
  t: ReturnType<typeof useTranslation>["t"]
): { headline: string; actionLabel: string; isError: boolean } {
  switch (problem) {
    case "network-unreachable":
      return {
        headline: t("workspace.agentEnv.stageProblemNetworkUnreachable"),
        actionLabel: t("workspace.agentEnv.stageDoRedetect"),
        isError: true
      };
    case "install-missing":
      return {
        headline: t("workspace.agentEnv.stageProblemInstallMissing", {
          provider: providerLabel
        }),
        actionLabel: t("workspace.agentEnv.stageDoInstall"),
        isError: false
      };
    case "install-outdated":
      return {
        headline: t("workspace.agentEnv.stageProblemInstallOutdated", {
          provider: providerLabel
        }),
        actionLabel: t("workspace.agentEnv.stageDoUpgrade"),
        isError: true
      };
    case "adapter-missing":
      return {
        headline: t("workspace.agentEnv.stageProblemAdapterMissing"),
        actionLabel: t("workspace.agentEnv.stageDoInstall"),
        isError: false
      };
    case "adapter-mismatch":
      return {
        headline: t("workspace.agentEnv.stageProblemAdapterMismatch"),
        actionLabel: t("workspace.agentEnv.stageDoUpgrade"),
        isError: true
      };
    case "login-missing":
      return {
        headline: t("workspace.agentEnv.stageProblemLoginMissing"),
        actionLabel: t("workspace.agentEnv.stageDoLogin"),
        isError: false
      };
  }
}

// A completed step reads in the done tense ("已安装 CLI") rather than the
// imperative track label ("安装 CLI"); the imperative is kept for pending/running
// rows where the step is still a to-do.
function doneStageLabel(
  stageId: AgentSetupStageId,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  switch (stageId) {
    case "detect":
      return t("workspace.agentEnv.stageDetectDone");
    case "network":
      return t("workspace.agentEnv.stageNetworkDone");
    case "install":
      return t("workspace.agentEnv.stageInstallDone");
    case "adapter":
      return t("workspace.agentEnv.stageAdapterDone");
    case "login":
      return t("workspace.agentEnv.stageLoginDone");
    case "ready":
      return t("workspace.agentEnv.stageReadyDone");
  }
}

function StepStatusIcon({
  status
}: {
  status: CodexSetupStepStatus;
}): JSX.Element {
  if (status === "ok") {
    return <SuccessFilledIcon className="size-4 text-[var(--tutti-purple)]" />;
  }
  if (status === "running") {
    return <LoadingIcon className="size-4 animate-spin" />;
  }
  if (status === "error") {
    return <WarningFilledIcon className="size-4 text-[var(--state-danger)]" />;
  }
  return (
    <span
      aria-hidden="true"
      className="size-4 rounded-full border border-[var(--border-1)]"
    />
  );
}

export function AgentEnvPanel({
  agentProviderStatusService,
  workspaceId,
  workbenchHost
}: AgentEnvPanelProps): JSX.Element | null {
  const { t } = useTranslation();
  const request = useAgentEnvPanelRequest();
  const snapshot = useStatusSnapshot(agentProviderStatusService);
  const [copied, setCopied] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  // "上报异常" flow. The consent prompt pops up on its own when an anomaly is
  // detected; "dismissed" remembers a decline so it doesn't re-pop this open.
  const [reportState, setReportState] = useState<
    "idle" | "confirming" | "reported" | "dismissed"
  >("idle");
  // Step-by-step reveal cursor: walks the stage track on open so each stage
  // visibly checks off one at a time instead of all flashing complete at once.
  const [revealIndex, setRevealIndex] = useState(0);

  const provider: WorkspaceAgentProvider = useMemo(() => {
    const requested = request.provider;
    if (requested && isDesktopManagedAgentProvider(requested)) {
      return requested;
    }
    if (
      snapshot.defaultProvider &&
      isDesktopManagedAgentProvider(snapshot.defaultProvider)
    ) {
      return snapshot.defaultProvider;
    }
    return desktopManagedAgentProviders.includes("codex")
      ? "codex"
      : desktopManagedAgentProviders[0];
  }, [request.provider, snapshot.defaultProvider]);

  const status: AgentProviderStatus | null = useMemo(
    () =>
      snapshot.statuses.find((entry) => entry.provider === provider) ?? null,
    [snapshot.statuses, provider]
  );

  const open = request.open;
  const providerLabel = resolveProviderLabel(provider);

  // What an open does depends on how it was opened:
  // - "detect" (re-detect): re-probe AND replay the step animation from step 1.
  // - any other focus (auth/install/repair/upgrade/network — i.e. opened FROM an
  //   error or remediation CTA): re-probe so the wizard reflects the real problem
  //   (and can auto-remediate), but show steps at once without the walk-through.
  // - no focus (casual "智能体环境" open): reuse the cached snapshot, don't re-probe.
  useEffect(() => {
    if (!open) {
      return;
    }
    setCopied(false);
    setLogExpanded(false);
    setReportState("idle");
    setRevealIndex(request.focus === "detect" ? 0 : REVEAL_ALL);
    if (request.focus) {
      void agentProviderStatusService.refresh([provider]);
    } else {
      void agentProviderStatusService.ensureLoaded({ providers: [provider] });
    }
  }, [
    open,
    provider,
    request.requestSequence,
    request.focus,
    agentProviderStatusService
  ]);

  const handleClose = useCallback((next: boolean) => {
    if (!next) {
      closeAgentEnvPanel();
    }
  }, []);

  // Re-detect restarts the whole flow: rewind the reveal cursor to step 1 and
  // clear transient UI so the track animates from the top, then re-run live
  // detection. Without the rewind the steps would stay checked off instead of
  // visibly re-running as the user asked.
  const handleRedetect = useCallback(() => {
    setCopied(false);
    setLogExpanded(false);
    setRevealIndex(0);
    // A fresh detection re-arms the anomaly prompt: if the new result still has
    // an anomaly and reporting is off, the prompt shows again.
    setReportState("idle");
    void agentProviderStatusService.refresh([provider]);
  }, [agentProviderStatusService, provider]);

  const handleConfirmReport = useCallback(() => {
    agentProviderStatusService.setDiagnosticsConsent(true);
    void agentProviderStatusService.reportEnvIssue(provider);
    setReportState("reported");
  }, [agentProviderStatusService, provider]);

  const runAction = useCallback(
    (actionId: string) => {
      void agentProviderStatusService.runAction(provider, actionId, {
        workbenchHost,
        workspaceId
      });
    },
    [agentProviderStatusService, provider, workbenchHost, workspaceId]
  );

  const handleCopyManualCommand = useCallback(async (command: string) => {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, []);

  const autoStartedSeqRef = useRef<number | null>(null);

  // Auto-start the focused remediation once detection settles, at most once per
  // open. The dock link / error card opened us with a focus; we run that action
  // for the user (decision A — the wizard takes over).
  //
  // The requestSequence ref below is the real re-entry guard: runAction mutates
  // the status snapshot (pending flag), which re-runs this effect, so the ref
  // must be set before runAction fires. The loginPending check inside
  // resolveWizardAutoStartAction is only best-effort — the desktop service does
  // not track "login" as a pending action, so that flag is effectively always
  // false here; do not weaken the ref guard on the assumption it covers re-entry.
  useEffect(() => {
    if (!open) {
      autoStartedSeqRef.current = null;
      return;
    }
    const seq = request.requestSequence;
    if (autoStartedSeqRef.current === seq) {
      return;
    }
    const liveStatus =
      snapshot.statuses.find((entry) => entry.provider === provider) ?? null;
    const action = resolveWizardAutoStartAction({
      focus: request.focus,
      detected: !snapshot.isLoading && liveStatus !== null,
      ready: liveStatus?.availability.status === "ready",
      installPending: agentProviderStatusService.isActionPending(
        provider,
        "install"
      ),
      loginPending: agentProviderStatusService.isActionPending(
        provider,
        "login"
      )
    });
    if (!action) {
      return;
    }
    autoStartedSeqRef.current = seq;
    runAction(action);
  }, [
    open,
    request.requestSequence,
    request.focus,
    snapshot.isLoading,
    snapshot.statuses,
    provider,
    agentProviderStatusService,
    runAction
  ]);

  // Do NOT early-return null when closed. This <Dialog> is a controlled Radix
  // dialog with disableOutsidePointerEvents; it must observe the open→false
  // transition to restore document.body pointer-events and the scroll lock.
  // Unmounting it while it still believes it is open strands the whole app
  // with `pointer-events: none` — clicks register nowhere and the wizard can
  // never be reopened until reload. Let the `open` prop drive visibility; the
  // DialogContent wrapper unmounts its own subtree after the close animation.

  const ready = status?.availability.status === "ready";
  const activeAction = readCodexSetupActiveAction(status);
  const installPending = agentProviderStatusService.isActionPending(
    provider,
    "install"
  );
  const loginPending = agentProviderStatusService.isActionPending(
    provider,
    "login"
  );
  const busy =
    installPending ||
    activeAction?.phase === "install" ||
    activeAction?.phase === "repair" ||
    activeAction?.phase === "verify";

  const reasonCode = (status?.availability.reasonCode ?? "").toLowerCase();
  const versionTooOld = reasonCode.includes("version");

  // Both connectivity checks are shown separately under the network step.
  const networkChecks: NetworkCheck[] = status?.network
    ? [
        {
          kind: "registry",
          reachable: status.network.registry.reachable,
          host: endpointHost(status.network.registry.endpoint)
        },
        ...(status.network.providerApi
          ? [
              {
                kind: "api" as const,
                reachable: status.network.providerApi.reachable,
                host: endpointHost(status.network.providerApi.endpoint)
              }
            ]
          : []),
        ...(status.network.proxy
          ? [
              {
                kind: "proxy" as const,
                // A proxy that isn't configured is not a failure (direct
                // connection); only a configured-but-unreachable proxy blocks.
                reachable:
                  !status.network.proxy.configured ||
                  status.network.proxy.reachable,
                host: status.network.proxy.url ?? null,
                configured: status.network.proxy.configured
              }
            ]
          : [])
      ]
    : [];
  // The step is blocked only when a probed endpoint is unreachable; no network
  // data at all (older daemon) stays null so it doesn't hold up the flow.
  const networkReachable =
    networkChecks.length === 0
      ? null
      : networkChecks.every((check) => check.reachable);

  const stages: AgentSetupStage[] = deriveAgentSetupStages({
    detected: status !== null,
    cliInstalled: status?.cli.installed ?? false,
    versionTooOld,
    adapterInstalled: status?.adapter.installed ?? false,
    adapterVersionMismatch: reasonCode.includes("adapter_version_mismatch"),
    authenticated: status?.auth.status === "authenticated",
    authRequired: status?.auth.status === "required",
    ready,
    activePhase: activeAction?.phase ?? null,
    installActionPending: installPending,
    loginPending,
    networkReachable,
    // Each completed step carries its own info inline (decision: unified track,
    // detail lines only). Install shows version + CLI path; login shows the
    // account, falling back to "signed in" when the provider exposes no label.
    cliVersionDetail: status?.cli.installed
      ? [status.cli.version, status.cli.binaryPath]
          .filter((part): part is string => Boolean(part))
          .join(" · ") || null
      : (status?.cli.version ?? null),
    adapterDetail:
      status?.adapter.binaryPath ??
      (status?.adapter.command?.length
        ? status.adapter.command.join(" ")
        : null),
    accountDetail:
      status?.auth.accountLabel ??
      (status?.auth.status === "authenticated"
        ? t("workspace.agentEnv.valueSignedIn")
        : null),
    // The network step renders its two checks as sub-lines (see SetupTrack), so
    // it carries no single detail string of its own.
    networkDetail: null,
    labels: {
      detect: t("workspace.agentEnv.stageDetect"),
      network: t("workspace.agentEnv.stageNetwork"),
      install: t("workspace.agentEnv.stageInstall"),
      adapter: t("workspace.agentEnv.stageAdapter"),
      login: t("workspace.agentEnv.stageLogin"),
      ready: t("workspace.agentEnv.stageReady")
    }
  });

  // Advance the reveal cursor once the stage it sits on is really done; it parks
  // on a still-running install (e.g. the slow ACP adapter), an error, or a
  // blocked prerequisite, so the animation never races ahead of reality.
  // canAdvanceReveal is a primitive boolean, so the timer effect re-arms only
  // when the advance decision actually changes (not on every stages re-derive).
  const canAdvanceReveal = shouldAdvanceReveal(stages, revealIndex);
  useEffect(() => {
    if (!open || !canAdvanceReveal) {
      return;
    }
    const timer = window.setTimeout(() => {
      setRevealIndex((index) => index + 1);
    }, REVEAL_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [open, canAdvanceReveal, revealIndex]);

  const manualCommand = MANUAL_INSTALL_COMMANDS[provider] ?? null;
  const registry = activeAction?.registry ?? null;

  // Registry is the ready step's completed-state detail; it has no bearing on
  // any step's status, so fold it in before the reveal projection.
  const stagesWithDetail = registry
    ? stages.map((entry) =>
        entry.id === "ready" ? { ...entry, detail: registry } : entry
      )
    : stages;
  const displayStages = projectRevealedStages(stagesWithDetail, revealIndex);

  // The blocking step is the first stage that is not yet ok — surfaced (with its
  // inline "进行xxx" fix) only once the reveal cursor has walked to it, so dimmed
  // not-yet-revealed steps below never sprout a button.
  const blockingIndex = stages.findIndex((entry) => entry.status !== "ok");
  const blockingStage = blockingIndex >= 0 ? stages[blockingIndex] : undefined;
  const blockingStageId: AgentSetupStageId | null =
    blockingStage && revealIndex >= blockingIndex ? blockingStage.id : null;

  // An anomaly is a real failure (a stage in error — version/adapter/network —
  // or a failed action), as opposed to the normal "not set up yet" flow. When
  // one is detected we proactively offer to report it.
  const hasAnomaly =
    stages.some((entry) => entry.status === "error") ||
    Boolean(activeAction?.error);

  // Proactively surface the report flow on an anomaly: ask for consent inline
  // (first time), or — if the user already agreed before — send it once. Sits
  // idle again only after the user acts (agree / decline / report).
  useEffect(() => {
    if (!open || !hasAnomaly || reportState !== "idle") {
      return;
    }
    if (agentProviderStatusService.getDiagnosticsConsent()) {
      void agentProviderStatusService.reportEnvIssue(provider);
      setReportState("reported");
    } else {
      setReportState("confirming");
    }
  }, [open, hasAnomaly, reportState, agentProviderStatusService, provider]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="flex max-h-[min(640px,calc(100vh-32px))] flex-col gap-0 overflow-hidden bg-[var(--background-fronted)] p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <DialogTitle>
            {/* One stable title regardless of state — the subtitle carries
                ready vs needs-setup — so the "环境检测" entry always opens
                "<provider> 环境". */}
            {t("workspace.agentEnv.configTitle", { provider: providerLabel })}
          </DialogTitle>
          <DialogDescription>
            {ready
              ? t("workspace.agentEnv.configDescription", {
                  provider: providerLabel
                })
              : t("workspace.agentEnv.wizardDescription", {
                  provider: providerLabel
                })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!isDesktopManagedAgentProvider(provider) ? (
            <p className="m-0 text-[13px] text-[var(--text-secondary)]">
              {t("workspace.agentEnv.providerUnsupported")}
            </p>
          ) : (
            <SetupTrack
              ready={ready}
              busy={Boolean(busy)}
              providerLabel={providerLabel}
              stages={displayStages}
              blockingStageId={blockingStageId}
              networkChecks={networkChecks}
              activePhase={activeAction?.phase ?? null}
              log={activeAction?.log ?? []}
              registry={registry}
              logExpanded={logExpanded}
              onToggleLog={() => setLogExpanded((value) => !value)}
              manualCommand={manualCommand}
              copied={copied}
              onCopyManualCommand={(command) =>
                void handleCopyManualCommand(command)
              }
              onRunStageAction={(actionId) =>
                actionId === "redetect" ? handleRedetect() : runAction(actionId)
              }
              redetecting={snapshot.isLoading}
              loginPending={loginPending}
              installPending={installPending}
              error={activeAction?.error ?? null}
              t={t}
            />
          )}
        </div>

        {/* Consent ask for the diagnostic report. Pops up on its own when an
            anomaly is detected (or via the manual button); shown only before any
            fuller diagnostics are sent, and remembered once agreed. */}
        {reportState === "confirming" ? (
          <div className="shrink-0 border-t border-[var(--border-1)] bg-[var(--transparency-block)] px-5 py-3">
            <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
              {t("workspace.agentEnv.reportConsentTitle")}
            </p>
            <p className="m-0 mt-1 text-[12px] text-[var(--text-secondary)]">
              {t("workspace.agentEnv.reportConsentBody")}
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setReportState("dismissed")}
              >
                {t("workspace.agentEnv.reportConsentCancel")}
              </Button>
              <Button size="sm" type="button" onClick={handleConfirmReport}>
                {t("workspace.agentEnv.reportConsentAgree")}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Re-detect rewinds the flow on the left; the right holds the single
            confirm/dismiss. Per-step actions live inline on their step, and the
            diagnostic report is offered via the on-anomaly prompt above (and the
            Settings → General toggle), not a footer button. */}
        <DialogFooter className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border-1)] px-5 py-4">
          <Button
            size="dialog"
            type="button"
            variant="ghost"
            disabled={snapshot.isLoading}
            onClick={handleRedetect}
          >
            <RefreshIcon className="size-4" />
            {t("workspace.agentEnv.actionDetect")}
          </Button>
          <Button
            size="dialog"
            type="button"
            onClick={() => closeAgentEnvPanel()}
          >
            {t("workspace.agentEnv.actionClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SetupTrack({
  ready,
  busy,
  providerLabel,
  stages,
  blockingStageId,
  networkChecks,
  activePhase,
  log,
  registry,
  logExpanded,
  onToggleLog,
  manualCommand,
  copied,
  onCopyManualCommand,
  onRunStageAction,
  loginPending,
  installPending,
  redetecting,
  error,
  t
}: {
  ready: boolean;
  busy: boolean;
  providerLabel: string;
  stages: AgentSetupStage[];
  blockingStageId: AgentSetupStageId | null;
  networkChecks: NetworkCheck[];
  activePhase: CodexSetupPhase | null;
  log: string[];
  registry: string | null;
  logExpanded: boolean;
  onToggleLog: () => void;
  manualCommand: string | null;
  copied: boolean;
  onCopyManualCommand: (command: string) => void;
  onRunStageAction: (actionId: StageActionId) => void;
  loginPending: boolean;
  installPending: boolean;
  redetecting: boolean;
  error: { code: string | null; message: string | null } | null;
  t: ReturnType<typeof useTranslation>["t"];
}): JSX.Element {
  const detectRunning =
    stages.find((entry) => entry.id === "detect")?.status === "running";
  return (
    <div className="flex flex-col gap-4">
      {ready ? null : (
        <p className="m-0 text-[13px] text-[var(--text-secondary)]">
          {busy
            ? t("workspace.agentEnv.busyInstalling", {
                provider: providerLabel
              })
            : detectRunning
              ? t("workspace.agentEnv.detecting", { provider: providerLabel })
              : t("workspace.agentEnv.setupRemaining", {
                  provider: providerLabel
                })}
        </p>
      )}

      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {stages.map((stage) => {
          const isActive = stage.status === "running";
          const dimmed = stage.status === "pending";
          const hasLog = isActive && log.length > 0;
          // Single-line rows center vertically; rows that stack content under
          // their label (the running log, the network sub-checks) top-align so
          // the icon lines up with the first line.
          const multiLine =
            hasLog || (stage.id === "network" && networkChecks.length > 0);
          // The single blocking step states the problem ("未xxx") and offers the
          // inline fix ("进行xxx"); every other row just reflects its status.
          const remediation =
            blockingStageId === stage.id ? stageRemediation(stage) : null;
          const problem = remediation
            ? describeStageProblem(remediation.problem, providerLabel, t)
            : null;
          const actionPending =
            remediation?.actionId === "login"
              ? loginPending
              : remediation?.actionId === "redetect"
                ? redetecting
                : installPending;
          return (
            <li
              key={stage.id}
              data-stage={stage.id}
              data-status={stage.status}
              className={`flex gap-2.5 rounded-[8px] bg-[var(--transparency-block)] p-3 ${
                multiLine ? "items-start" : "items-center"
              } ${dimmed && !problem ? "opacity-50" : ""}`}
            >
              <span className={`shrink-0 ${multiLine ? "mt-0.5" : ""}`}>
                {problem ? (
                  <WarningFilledIcon
                    className={`size-4 ${
                      problem.isError
                        ? "text-[var(--state-danger)]"
                        : "text-[var(--state-warning)]"
                    }`}
                  />
                ) : (
                  <StepStatusIcon status={stage.status} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                {/* Label + detail sit on one baseline-aligned row; the detail
                    (version / path / account) truncates so the step stays a
                    single line whenever it fits. */}
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    className={`shrink-0 text-[13px] font-medium ${
                      problem
                        ? problem.isError
                          ? "text-[var(--state-danger)]"
                          : "text-[var(--state-warning)]"
                        : "text-[var(--text-primary)]"
                    }`}
                  >
                    {problem
                      ? problem.headline
                      : stage.status === "ok"
                        ? doneStageLabel(stage.id, t)
                        : stage.label}
                  </span>
                  {!problem && stage.detail ? (
                    <span className="min-w-0 truncate text-[12px] text-[var(--text-secondary)]">
                      {stage.detail}
                    </span>
                  ) : null}
                </span>
                {stage.id === "network" && networkChecks.length > 0 ? (
                  <span className="mt-1.5 flex flex-col gap-1">
                    {networkChecks.map((check) => {
                      const label =
                        check.kind === "registry"
                          ? t("workspace.agentEnv.networkCheckRegistry")
                          : check.kind === "api"
                            ? t("workspace.agentEnv.networkCheckApi")
                            : t("workspace.agentEnv.networkCheckProxy");
                      const proxyAbsent =
                        check.kind === "proxy" && check.configured === false;
                      const value = proxyAbsent
                        ? t("workspace.agentEnv.networkProxyNone")
                        : check.reachable
                          ? (check.host ?? "")
                          : t("workspace.agentEnv.networkUnreachable");
                      return (
                        <span
                          key={check.kind}
                          className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]"
                        >
                          {proxyAbsent ? (
                            <span
                              aria-hidden="true"
                              className="size-3.5 shrink-0 rounded-full border border-[var(--border-1)]"
                            />
                          ) : check.reachable ? (
                            <SuccessFilledIcon className="size-3.5 shrink-0 text-[var(--tutti-purple)]" />
                          ) : (
                            <WarningFilledIcon className="size-3.5 shrink-0 text-[var(--state-danger)]" />
                          )}
                          <span className="min-w-0 truncate">
                            {label}
                            {value ? ` · ${value}` : ""}
                          </span>
                        </span>
                      );
                    })}
                  </span>
                ) : null}
                {hasLog ? (
                  <pre className="mt-2 max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-[var(--background-fronted)] px-2 py-1.5 text-[11px] leading-5 text-[var(--text-secondary)]">
                    {log.join("\n")}
                  </pre>
                ) : null}
              </span>
              {remediation && problem ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={actionPending}
                  onClick={() => onRunStageAction(remediation.actionId)}
                >
                  {actionPending ? (
                    <LoadingIcon className="size-4 animate-spin" />
                  ) : null}
                  {problem.actionLabel}
                </Button>
              ) : stage.id === "login" && stage.status === "ok" ? (
                // Sign-in management lives on the step it concerns, not the
                // footer: a signed-in account can re-authenticate right here.
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loginPending}
                  onClick={() => onRunStageAction("login")}
                >
                  {loginPending ? (
                    <LoadingIcon className="size-4 animate-spin" />
                  ) : (
                    <RefreshIcon className="size-4" />
                  )}
                  {t("workspace.agentEnv.actionRelogin")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>

      {error?.message ? (
        <p className="m-0 text-[12px] text-[var(--state-danger)]">
          {t("workspace.agentEnv.actionFailed")}
        </p>
      ) : null}

      {(activePhase !== null || registry) && log.length > 0 ? (
        <div className="rounded-[8px] border border-[var(--border-1)]">
          <button
            type="button"
            className="flex w-full cursor-pointer items-center justify-between border-0 bg-transparent px-3 py-2 text-left text-[12px] font-semibold text-[var(--text-primary)]"
            aria-expanded={logExpanded}
            onClick={onToggleLog}
          >
            <span>{t("workspace.agentEnv.logToggle")}</span>
            {registry ? (
              <span className="text-[11px] font-normal text-[var(--text-secondary)]">
                {t("workspace.agentEnv.registryLabel")}: {registry}
              </span>
            ) : null}
          </button>
          {logExpanded ? (
            <pre className="m-0 max-h-[200px] overflow-auto whitespace-pre-wrap break-words border-t border-[var(--border-1)] px-3 py-2 text-[11px] leading-5 text-[var(--text-secondary)]">
              {log.length > 0 ? log.join("\n") : "—"}
            </pre>
          ) : null}
        </div>
      ) : null}

      {manualCommand ? (
        <div className="rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3">
          <strong className="text-[12px] font-semibold text-[var(--text-primary)]">
            {t("workspace.agentEnv.manualTitle")}
          </strong>
          <p className="mt-1 mb-2 text-[12px] text-[var(--text-secondary)]">
            {t("workspace.agentEnv.manualDescription")}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[6px] bg-[var(--background-fronted)] px-2 py-1.5 font-[var(--tsh-font-mono)] text-[12px] text-[var(--text-primary)]">
              {manualCommand}
            </code>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onCopyManualCommand(manualCommand)}
            >
              {copied ? (
                <CheckIcon className="size-4" />
              ) : (
                <CopyIcon className="size-4" />
              )}
              {copied
                ? t("workspace.agentEnv.manualCopied")
                : t("workspace.agentEnv.manualCopy")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
