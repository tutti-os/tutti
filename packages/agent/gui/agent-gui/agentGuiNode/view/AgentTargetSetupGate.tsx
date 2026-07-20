import type { ReactNode } from "react";
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
import type { AgentHostAgentTargetSetupSnapshot } from "../../../host/agentHostApi.ts";
import { useTranslation } from "../../../i18n/index.ts";
import styles from "../AgentGUINode.styles.ts";

export interface AgentTargetSetupGateProps {
  children?: ReactNode;
  carouselMountedExternally: boolean;
  dialogOwner?: boolean;
  gateVisible?: boolean;
}

export function AgentTargetSetupGate({
  children,
  carouselMountedExternally,
  dialogOwner = false,
  gateVisible = true
}: AgentTargetSetupGateProps): React.JSX.Element {
  const controller = useAgentTargetSetupController();
  const { t } = useTranslation();
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
                  authenticationAvailable && authMethods.length > 0 ? (
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
                  ) : undefined
                }
              >
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
