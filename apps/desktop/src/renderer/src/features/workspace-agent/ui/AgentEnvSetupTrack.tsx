import { type JSX } from "react";
import {
  Button,
  CheckIcon,
  CopyIcon,
  LoadingIcon,
  RefreshIcon,
  SuccessFilledIcon,
  WarningFilledIcon
} from "@tutti-os/ui-system";
import {
  stageRemediation,
  type AgentEnvWizardViewModel,
  type CodexSetupStepStatus,
  type StageDetailToken
} from "@tutti-os/agent-gui/agent-env";
import { useTranslation } from "@renderer/i18n";
import type { AgentEnvWizardActions } from "./useAgentEnvWizard";
import {
  describeStageProblem,
  doneStageLabel,
  renderStageDetail
} from "./agentEnvPanelText";

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

function latestLogLine(log: string[]): string | null {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const line = log[index]?.trim();
    if (line) {
      return line;
    }
  }
  return null;
}

export function AgentEnvSetupTrack({
  viewModel,
  providerLabel,
  copied,
  logExpanded,
  actions,
  t
}: {
  viewModel: AgentEnvWizardViewModel;
  providerLabel: string;
  copied: boolean;
  logExpanded: boolean;
  actions: AgentEnvWizardActions;
  t: ReturnType<typeof useTranslation>["t"];
}): JSX.Element {
  const {
    displayStages: stages,
    networkChecks,
    activePhase,
    log,
    registry,
    blockingStageId,
    manualCommand,
    installPending,
    loginPending,
    redetecting,
    ready,
    busy,
    error
  } = viewModel;

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

      <ol className="m-0 flex list-none flex-col divide-y divide-[var(--border-1)] p-0">
        {stages.map((stage) => {
          const isActive = stage.status === "running";
          const dimmed = stage.status === "pending";
          const hasLog = isActive && log.length > 0;
          const stageDetail: StageDetailToken | null = hasLog
            ? { kind: "text", text: latestLogLine(log) ?? "" }
            : stage.detail;
          const stageDetailText = renderStageDetail(stageDetail, t);
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
                ? // Re-detect stays disabled for the whole install (busy is
                  // stable, unlike redetecting/isLoading which flickers per poll).
                  redetecting || busy
                : installPending;
          return (
            <li
              key={stage.id}
              data-stage={stage.id}
              data-status={stage.status}
              className={`flex gap-2.5 py-3 ${
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
                        ? doneStageLabel(stage.id, stage.authMethod, t)
                        : stage.label}
                  </span>
                  {stageDetailText ? (
                    // Shown for a healthy step (version · path) AND for a version
                    // problem (current · requires ≥ floor) — a blocked CLI must
                    // still reveal which version it has and what it needs. While
                    // running, this becomes the latest installer log line.
                    <span className="min-w-0 truncate text-[12px] text-[var(--text-secondary)]">
                      {stageDetailText}
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
                  onClick={() => actions.runStageAction(remediation.actionId)}
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
                  onClick={() => actions.runStageAction("login")}
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
            onClick={actions.toggleLog}
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
              onClick={() => actions.copyManual(manualCommand)}
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
