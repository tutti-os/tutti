import type { TranslateFn } from "../../../i18n/index";

export function agentGUIProjectLaunchLabels(t: TranslateFn) {
  return {
    projectLocked: t("agentHost.agentGui.projectLocked"),
    projectMissingDescription: t(
      "agentHost.agentGui.projectMissingDescription"
    ),
    sessionLaunchModeLabel: t("agentHost.agentGui.sessionLaunchModeLabel"),
    sessionLaunchModeLocal: t("agentHost.agentGui.sessionLaunchModeLocal"),
    sessionLaunchModeWorktree: t("agentHost.agentGui.sessionLaunchModeWorktree")
  };
}
