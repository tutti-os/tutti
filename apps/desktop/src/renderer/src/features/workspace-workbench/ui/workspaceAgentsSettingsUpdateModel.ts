import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import type { TranslateFn } from "@renderer/i18n";

export type AgentProviderUpdateRowPresentation = {
  checkFailed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
};

export function resolveAgentProviderUpdateRowPresentation(
  status: AgentProviderStatus | null | undefined
): AgentProviderUpdateRowPresentation {
  const update = status?.update;
  const currentVersion =
    update?.currentVersion?.trim() || status?.cli.version?.trim() || null;
  const latestVersion = update?.lastCheckedAt
    ? update.latestVersion?.trim() || null
    : null;
  const updateAvailable = update?.updateAvailable === true;
  const checkFailed = Boolean(
    update?.capability === "supported" &&
    update.lastCheckedAt &&
    update.reasonCode
  );

  return {
    checkFailed,
    currentVersion,
    latestVersion,
    updateAvailable
  };
}

export function formatAgentProviderUpdateSummary(input: {
  checkFailed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  t: TranslateFn;
}): string | null {
  const { checkFailed, currentVersion, latestVersion, updateAvailable, t } =
    input;
  if (checkFailed && currentVersion) {
    return t("workspace.settings.agent.agents.updateCheckFailedSummary", {
      current: currentVersion
    });
  }
  if (checkFailed) {
    return t("workspace.settings.agent.agents.updateCheckFailed");
  }
  if (updateAvailable && currentVersion && latestVersion) {
    return t("workspace.settings.agent.agents.updateAvailableSummary", {
      current: currentVersion,
      latest: latestVersion
    });
  }
  if (updateAvailable && latestVersion) {
    return t("workspace.settings.agent.agents.updateAvailableLatest", {
      latest: latestVersion
    });
  }
  if (currentVersion && latestVersion && !updateAvailable) {
    return t("workspace.settings.agent.agents.updateUpToDateSummary", {
      current: currentVersion
    });
  }
  if (currentVersion) {
    return t("workspace.settings.agent.agents.currentVersionSummary", {
      current: currentVersion
    });
  }
  return null;
}
