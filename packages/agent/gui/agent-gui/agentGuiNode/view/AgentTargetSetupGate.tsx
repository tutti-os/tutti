import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useExternalStoreSnapshot } from "@tutti-os/ui-react-hooks";
import {
  Button,
  RefreshIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn
} from "@tutti-os/ui-system";
import {
  AgentSetupDialog,
  AgentSetupStepIcon,
  type AgentSetupStepStatus
} from "../../../shared/agentEnv/AgentSetupDialog.tsx";
import { useAgentTargetSetupController } from "../../../shared/agentEnv/agentTargetSetupController.tsx";
import { useAgentHostApi } from "../../../agentActivityHost.tsx";
import type { AgentHostAgentTargetSetupSnapshot } from "../../../host/agentHostApi.ts";
import { useTranslation } from "../../../i18n/index.ts";
import styles from "../AgentGUINode.styles.ts";

export interface AgentTargetSetupGateProps {
  children?: ReactNode;
  carouselMountedExternally: boolean;
  dialogOwner?: boolean;
  gateVisible?: boolean;
}

const TERMINAL_LOGIN_POLL_MS = 3_000;
const TERMINAL_LOGIN_TIMEOUT_MS = 10 * 60_000;

type TerminalLoginPhase = "idle" | "waiting" | "error";

export function AgentTargetSetupGate({
  children,
  carouselMountedExternally,
  dialogOwner = false,
  gateVisible = true
}: AgentTargetSetupGateProps): React.JSX.Element {
  const controller = useAgentTargetSetupController();
  const { t } = useTranslation();
  const { terminalLogin } = useAgentHostApi();
  const state = useExternalStoreSnapshot(controller);
  const {
    agentTarget,
    agentTargetId,
    authenticatePending,
    dialogOpen,
    enabled,
    installPending,
    selectedAuthMethodId,
    setup
  } = state;
  const { snapshot, loading, failed } = setup;
  const authMethods = snapshot?.authMethods ?? [];
  const account = snapshot?.account ?? null;
  const effectiveAuthMethodId = authMethods.some(
    (method) => method.id === selectedAuthMethodId
  )
    ? (selectedAuthMethodId ?? "")
    : authMethods.some((method) => method.id === account?.authMethodId)
      ? (account?.authMethodId ?? "")
      : (authMethods[0]?.id ?? "");
  const effectiveAuthMethod = authMethods.find(
    (method) => method.id === effectiveAuthMethodId
  );
  const terminalLoginCommand =
    effectiveAuthMethod?.type === "terminal"
      ? (effectiveAuthMethod.terminalCommand?.trim() ?? "") || null
      : null;

  const [terminalLoginPhase, setTerminalLoginPhase] =
    useState<TerminalLoginPhase>("idle");
  const [terminalLoginError, setTerminalLoginError] = useState<string | null>(
    null
  );
  const terminalLoginHandleRef = useRef<{ close(): void } | null>(null);
  const terminalLoginPollRef = useRef<number | null>(null);
  const terminalLoginDeadlineRef = useRef(0);

  const stopTerminalLogin = useCallback((closeTerminal: boolean) => {
    if (terminalLoginPollRef.current !== null) {
      window.clearTimeout(terminalLoginPollRef.current);
      terminalLoginPollRef.current = null;
    }
    if (closeTerminal) {
      try {
        terminalLoginHandleRef.current?.close();
      } catch (error) {
        // Closing the terminal node is best-effort.
        console.warn("agent-gui: terminal login close failed", error);
      }
    }
    terminalLoginHandleRef.current = null;
  }, []);

  const snapshotStatus = setup.snapshot?.status ?? null;

  useEffect(() => {
    if (terminalLoginPhase === "waiting" && snapshotStatus === "ready") {
      stopTerminalLogin(true);
      setTerminalLoginPhase("idle");
      setTerminalLoginError(null);
    }
  }, [terminalLoginPhase, snapshotStatus, stopTerminalLogin]);

  useEffect(
    () => () => {
      if (terminalLoginPollRef.current !== null) {
        window.clearTimeout(terminalLoginPollRef.current);
        terminalLoginPollRef.current = null;
      }
      try {
        terminalLoginHandleRef.current?.close();
      } catch (error) {
        // Closing the terminal node is best-effort.
        console.warn("agent-gui: terminal login close failed", error);
      }
      terminalLoginHandleRef.current = null;
    },
    []
  );

  if (!enabled) {
    return <>{children}</>;
  }

  const setupChecking = !snapshot && !failed;
  const setupBlocked = failed || !snapshot || snapshot.status !== "ready";
  const handleInstall = async () => {
    const plan = snapshot?.plan;
    if (plan) await controller.install(plan.planDigest);
  };
  const handleAuthenticate = async () => {
    if (!effectiveAuthMethodId) return;
    await controller.authenticate(effectiveAuthMethodId);
  };
  const terminalLoginLaunchAvailable =
    Boolean(terminalLogin) && Boolean(terminalLoginCommand);
  const handleTerminalLoginStart = async () => {
    if (!terminalLogin || !terminalLoginCommand) return;
    setTerminalLoginPhase("waiting");
    setTerminalLoginError(null);
    try {
      const handle = await terminalLogin.run({
        command: terminalLoginCommand
      });
      terminalLoginHandleRef.current = handle ?? null;
    } catch {
      setTerminalLoginPhase("error");
      setTerminalLoginError(
        t("agentHost.agentGui.targetSetupTerminalLoginUnavailable")
      );
      return;
    }
    terminalLoginDeadlineRef.current = Date.now() + TERMINAL_LOGIN_TIMEOUT_MS;
    const poll = async () => {
      terminalLoginPollRef.current = null;
      if (Date.now() > terminalLoginDeadlineRef.current) {
        stopTerminalLogin(true);
        setTerminalLoginPhase("error");
        setTerminalLoginError(
          t("agentHost.agentGui.targetSetupTerminalLoginTimedOut")
        );
        return;
      }
      await controller.refresh();
      // timing: keep polling setup status until login completes or the deadline passes
      terminalLoginPollRef.current = window.setTimeout(
        () => void poll(),
        TERMINAL_LOGIN_POLL_MS
      );
    };
    // timing: schedule the first setup-status poll after opening the login terminal
    terminalLoginPollRef.current = window.setTimeout(
      () => void poll(),
      TERMINAL_LOGIN_POLL_MS
    );
  };
  const handleTerminalLoginCancel = () => {
    stopTerminalLogin(true);
    setTerminalLoginPhase("idle");
    setTerminalLoginError(null);
  };
  const actionRunning = isSetupActionRunning(snapshot?.action?.status);
  const actionFailed = isSetupActionFailed(snapshot?.action?.status);
  const installRetryAvailable =
    snapshot?.status === "failed" &&
    snapshot.action?.kind === "install" &&
    actionFailed &&
    Boolean(snapshot.plan);
  const phase = actionRunning ? (snapshot?.action?.phase ?? null) : null;
  const statusLabel = phase
    ? targetSetupPhaseLabel(t, phase)
    : loading
      ? t("agentHost.agentGui.targetSetupChecking")
      : null;
  const detectionStatus: AgentSetupStepStatus = failed
    ? "error"
    : loading || !snapshot
      ? "running"
      : snapshot
        ? "ok"
        : "pending";
  const installStatus = resolveInstallStepStatus(snapshot);
  const loginStatus = resolveLoginStepStatus(snapshot);
  const providerLabel = agentTarget?.label ?? agentTargetId;
  const accountDetail = account
    ? [account.displayName, account.organization].filter(Boolean).join(" · ")
    : undefined;
  const setupDescription = setupChecking
    ? t("agentHost.agentGui.targetSetupChecking")
    : snapshot?.status === "auth_required"
      ? t("agentHost.agentGui.targetSetupAuthRequired")
      : snapshot?.status === "ready"
        ? t("agentHost.agentGui.targetSetupReady")
        : t("agentHost.agentGui.targetSetupDescription");
  const authenticationAvailable =
    snapshot?.status === "auth_required" || snapshot?.status === "ready";

  return (
    <>
      {gateVisible && setupBlocked ? (
        <div className={styles.emptyHero}>
          <div
            className={cn(styles.emptyHeroBody, styles.emptyProviderGate)}
            data-testid="agent-target-setup-gate"
            role="status"
          >
            {carouselMountedExternally ? (
              <div
                aria-hidden="true"
                className={styles.emptyHeroCarouselPlaceholder}
              />
            ) : null}
            <h2 className={styles.emptyHeroTitle}>
              {t("agentHost.agentGui.targetSetupTitle", {
                provider: providerLabel
              })}
            </h2>
            <p className={styles.emptyProviderGateDescription}>
              {setupDescription}
            </p>
            {!setupChecking ? (
              <Button
                type="button"
                className={styles.emptyProviderGateAction}
                onClick={() => controller.setDialogOpen(true)}
              >
                {t("agentHost.agentGui.targetSetupOpen")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        children
      )}

      {dialogOwner ? (
        <AgentSetupDialog
          open={dialogOpen}
          onOpenChange={controller.setDialogOpen}
          title={t("agentHost.agentGui.targetSetupTitle", {
            provider: providerLabel
          })}
          description={setupDescription}
          footer={
            <Button
              size="dialog"
              type="button"
              disabled={loading}
              onClick={() => void controller.refresh()}
            >
              <RefreshIcon className="size-4" />
              {t("agentHost.agentGui.targetSetupRetry")}
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="m-0 text-[13px] text-[var(--text-secondary)]">
              {statusLabel ??
                (snapshot?.status === "ready"
                  ? t("agentHost.agentGui.targetSetupComplete", {
                      provider: providerLabel
                    })
                  : t("agentHost.agentGui.targetSetupRemaining", {
                      provider: providerLabel
                    }))}
            </p>

            <ol className="m-0 flex list-none flex-col divide-y divide-[var(--border-1)] p-0">
              <SetupTrackRow
                label={t("agentHost.agentGui.targetSetupStage.detect")}
                status={detectionStatus}
                detail={
                  snapshot?.runtimeVersion
                    ? `${snapshot.runtimeVersion} · ${snapshot.runtimeSource ?? ""}`
                    : undefined
                }
              />

              <SetupTrackRow
                label={t("agentHost.agentGui.targetSetupStage.install")}
                status={installStatus}
                warning={snapshot?.status === "not_installed"}
                detail={
                  snapshot?.plan
                    ? `${snapshot.plan.packageName}@${snapshot.plan.packageVersion}`
                    : undefined
                }
                action={
                  (snapshot?.status === "not_installed" ||
                    installRetryAvailable) &&
                  snapshot.plan ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={installPending}
                      onClick={() => void handleInstall()}
                    >
                      {installPending
                        ? t("agentHost.agentGui.targetSetupStarting")
                        : t(
                            installRetryAvailable
                              ? "agentHost.agentGui.targetSetupReinstall"
                              : "agentHost.agentGui.targetSetupInstall"
                          )}
                    </Button>
                  ) : undefined
                }
              >
                {snapshot?.plan ? (
                  <span className="mt-2 block break-all text-[12px] text-[var(--text-secondary)]">
                    {snapshot.plan.installRoot}
                  </span>
                ) : null}
              </SetupTrackRow>

              <SetupTrackRow
                label={t(
                  snapshot?.status === "ready"
                    ? "agentHost.agentGui.targetSetupLoggedInAccount"
                    : "agentHost.agentGui.targetSetupStage.login"
                )}
                status={loginStatus}
                warning={snapshot?.status === "auth_required"}
                detail={
                  snapshot?.status === "ready" ? accountDetail : undefined
                }
                action={
                  authenticationAvailable &&
                  authMethods.length > 0 &&
                  !terminalLoginCommand ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={!effectiveAuthMethodId || authenticatePending}
                      onClick={() => void handleAuthenticate()}
                    >
                      {authenticatePending
                        ? t("agentHost.agentGui.targetSetupAuthStarting")
                        : snapshot?.status === "ready"
                          ? t("agentHost.agentGui.targetSetupReauthenticate")
                          : t("agentHost.agentGui.targetSetupAuthenticate")}
                    </Button>
                  ) : terminalLoginCommand &&
                    terminalLoginLaunchAvailable &&
                    terminalLoginPhase !== "waiting" ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleTerminalLoginStart()}
                    >
                      {t("agentHost.agentGui.targetSetupTerminalLoginStart")}
                    </Button>
                  ) : undefined
                }
              >
                {terminalLoginCommand ? (
                  <TerminalLoginGuide
                    command={terminalLoginCommand}
                    error={terminalLoginError}
                    onCancelLogin={
                      terminalLoginPhase === "waiting"
                        ? handleTerminalLoginCancel
                        : undefined
                    }
                    waiting={terminalLoginPhase === "waiting"}
                  />
                ) : null}
                {snapshot?.status === "auth_required" &&
                authMethods.length > 0 ? (
                  <label className="mt-2 flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
                    {t("agentHost.agentGui.targetSetupAuthMethod")}
                    <Select
                      value={effectiveAuthMethodId}
                      onValueChange={controller.selectAuthMethod}
                    >
                      <SelectTrigger
                        aria-label={t(
                          "agentHost.agentGui.targetSetupAuthMethod"
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent
                        style={{ zIndex: "var(--z-dialog-popover)" }}
                      >
                        {authMethods.map((method) => (
                          <SelectItem key={method.id} value={method.id}>
                            {method.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : snapshot?.status === "auth_required" ? (
                  <p className="mt-2 mb-0 text-[12px] text-[var(--text-secondary)]">
                    {t("agentHost.agentGui.targetSetupNoAuthMethods")}
                  </p>
                ) : null}
              </SetupTrackRow>
            </ol>

            {failed || snapshot?.status === "failed" || actionFailed ? (
              <p className="m-0 text-[12px] text-[var(--state-danger)]">
                <span className="block">
                  {snapshot?.action?.kind === "authenticate"
                    ? t("agentHost.agentGui.targetSetupAuthFailed")
                    : t("agentHost.agentGui.targetSetupFailed")}
                </span>
                {snapshot?.action?.errorMessage?.trim() ? (
                  <span className="mt-1 block break-words text-[var(--text-secondary)]">
                    {snapshot.action.errorMessage.trim()}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
        </AgentSetupDialog>
      ) : null}
    </>
  );
}

function TerminalLoginGuide({
  command,
  error,
  onCancelLogin,
  waiting = false
}: {
  command: string;
  error?: string | null;
  onCancelLogin?: () => void;
  waiting?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { clipboard } = useAgentHostApi();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await clipboard.writeText(command);
      setCopied(true);
      // timing: reset the copied indicator after a brief confirmation delay
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      // Clipboard unavailable; the command text remains selectable.
      console.warn("agent-gui: clipboard copy failed", error);
    }
  };
  return (
    <div className="mt-2 flex flex-col gap-2">
      <p className="m-0 text-[12px] text-[var(--text-secondary)]">
        {waiting
          ? t("agentHost.agentGui.targetSetupTerminalLoginWaiting")
          : t("agentHost.agentGui.targetSetupTerminalAuthHint")}
      </p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-md border border-[var(--line-2)] bg-[var(--background-fronted)] px-3 py-2 font-mono text-[11px] leading-5 text-[var(--text-primary)]">
          {command}
        </code>
        <Button type="button" size="sm" onClick={() => void handleCopy()}>
          {copied
            ? t("agentHost.agentGui.targetSetupCommandCopied")
            : t("agentHost.agentGui.targetSetupCopyCommand")}
        </Button>
      </div>
      {waiting && onCancelLogin ? (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={onCancelLogin}>
            {t("agentHost.agentGui.targetSetupTerminalLoginCancel")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="m-0 text-[12px] text-[var(--state-danger)]">{error}</p>
      ) : null}
    </div>
  );
}

function isSetupActionRunning(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}

function isSetupActionFailed(status: string | undefined): boolean {
  return status === "failed" || status === "interrupted";
}

function SetupTrackRow({
  action,
  children,
  detail,
  label,
  status,
  warning = false
}: {
  action?: ReactNode;
  children?: ReactNode;
  detail?: string;
  label: string;
  status: AgentSetupStepStatus;
  warning?: boolean;
}): React.JSX.Element {
  return (
    <li
      data-status={status}
      className={`flex items-start gap-2.5 py-3 ${status === "pending" ? "opacity-50" : ""}`}
    >
      <span className="mt-0.5 shrink-0">
        <AgentSetupStepIcon status={status} warning={warning} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={`shrink-0 text-[13px] font-medium ${status === "error" ? (warning ? "text-[var(--state-warning)]" : "text-[var(--state-danger)]") : "text-[var(--text-primary)]"}`}
          >
            {label}
          </span>
          {detail ? (
            <span className="min-w-0 truncate text-[12px] text-[var(--text-secondary)]">
              {detail}
            </span>
          ) : null}
        </span>
        {children}
      </span>
      {action}
    </li>
  );
}

function resolveInstallStepStatus(
  snapshot: AgentHostAgentTargetSetupSnapshot | null
): AgentSetupStepStatus {
  if (!snapshot) return "pending";
  if (snapshot.status === "installing") return "running";
  if (snapshot.status === "not_installed") return "error";
  if (
    snapshot.status === "auth_required" ||
    snapshot.status === "authenticating" ||
    snapshot.status === "ready" ||
    snapshot.runtimeSource
  ) {
    return "ok";
  }
  return snapshot.status === "failed" ? "error" : "pending";
}

function resolveLoginStepStatus(
  snapshot: AgentHostAgentTargetSetupSnapshot | null
): AgentSetupStepStatus {
  if (!snapshot) return "pending";
  if (snapshot.status === "authenticating") return "running";
  if (snapshot.status === "auth_required") return "error";
  if (snapshot.status === "ready") return "ok";
  if (
    snapshot.status === "failed" &&
    snapshot.action?.kind === "authenticate"
  ) {
    return "error";
  }
  return "pending";
}

function targetSetupPhaseLabel(
  t: ReturnType<typeof useTranslation>["t"],
  phase: NonNullable<AgentHostAgentTargetSetupSnapshot["action"]>["phase"]
): string {
  switch (phase) {
    case "preparing":
      return t("agentHost.agentGui.targetSetupPhase.preparing");
    case "installing":
      return t("agentHost.agentGui.targetSetupPhase.installing");
    case "verifying":
      return t("agentHost.agentGui.targetSetupPhase.verifying");
    case "probing":
      return t("agentHost.agentGui.targetSetupPhase.probing");
    case "activating":
      return t("agentHost.agentGui.targetSetupPhase.activating");
    case "authenticating":
      return t("agentHost.agentGui.targetSetupPhase.authenticating");
    case "complete":
      return t("agentHost.agentGui.targetSetupPhase.complete");
  }
}
