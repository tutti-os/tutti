import type {
  AgentSetupStageId,
  StageDetailToken,
  StageProblem
} from "@tutti-os/agent-gui/agent-env";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import type { useTranslation } from "@renderer/i18n";

type T = ReturnType<typeof useTranslation>["t"];

const PROVIDER_LABELS: Partial<Record<WorkspaceAgentProvider, string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  gemini: "Gemini",
  nexight: "Nexight",
  hermes: "Hermes",
  openclaw: "OpenClaw"
};

export function resolveProviderLabel(provider: WorkspaceAgentProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Maps a blocked stage's problem token onto the "未xxx" headline and the
 * "进行xxx" action label, plus whether it reads as an error (version problem)
 * or a not-yet-done warning. The action id itself comes from stageRemediation.
 */
export function describeStageProblem(
  problem: StageProblem,
  providerLabel: string,
  t: T
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
      // We don't auto-upgrade a present CLI: the headline states it's outdated,
      // the manual upgrade command is shown below, and the action re-checks
      // once the user has upgraded it themselves.
      return {
        headline: t("workspace.agentEnv.stageProblemInstallOutdated", {
          provider: providerLabel
        }),
        actionLabel: t("workspace.agentEnv.stageDoRedetect"),
        isError: true
      };
    case "install-platform-incomplete":
      // The launcher is present but its platform subpackage is missing. The
      // daemon repairs this in place via the install action, so — like a
      // missing CLI — it is a warning (not a hard error) that auto-installs.
      return {
        headline: t(
          "workspace.agentEnv.stageProblemInstallPlatformIncomplete",
          {
            provider: providerLabel
          }
        ),
        actionLabel: t("workspace.agentEnv.stageDoRepair"),
        isError: false
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
export function doneStageLabel(
  stageId: AgentSetupStageId,
  authMethod: string | null | undefined,
  t: T
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
      if (authMethod === "apiKey") {
        return t("workspace.agentEnv.stageLoginDoneApiBilling");
      }
      return t("workspace.agentEnv.stageLoginDone");
    case "ready":
      return t("workspace.agentEnv.stageReadyDone");
  }
}

export function renderStageDetail(
  token: StageDetailToken | null,
  t: T
): string | null {
  if (!token) {
    return null;
  }
  if (token.kind === "version-floor") {
    return t("workspace.agentEnv.stageInstallVersionRequirement", {
      current: token.current,
      required: token.required
    });
  }
  if (token.kind === "version-mismatch") {
    return t("workspace.agentEnv.stageAdapterVersionRequirement", {
      current: token.current,
      required: token.required
    });
  }
  if (token.text === "__SIGNED_IN__") {
    return t("workspace.agentEnv.valueSignedIn");
  }
  return token.text;
}
