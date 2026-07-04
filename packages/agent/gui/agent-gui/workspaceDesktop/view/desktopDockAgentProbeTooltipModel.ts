import type { TranslateFn } from "../../../i18n/index";
import { toLocalShortDateTime } from "../../../app/renderer/shell/utils/format";
import type {
  AgentProbeProvider,
  AgentProbeSnapshot,
  AgentUsageQuota
} from "../../../shared/contracts/dto";
import type { AgentProvider } from "../../../contexts/settings/domain/agentSettings";
import type { WorkspaceDesktopAgentProbesState } from "../types";

export function findWorkspaceAgentProbeForDockProvider(
  snapshot: AgentProbeSnapshot | null | undefined,
  provider: AgentProvider
): AgentProbeProvider | null {
  if (!snapshot?.providers) {
    return null;
  }
  return snapshot.providers.find((p) => p.provider === provider) ?? null;
}

function quotaRenderStateEquals(
  left: AgentUsageQuota | undefined,
  right: AgentUsageQuota | undefined
): boolean {
  return (
    left?.quotaType === right?.quotaType &&
    left?.percentRemaining === right?.percentRemaining &&
    left?.resetsAtUnixMs === right?.resetsAtUnixMs &&
    left?.resetText === right?.resetText &&
    left?.dollarRemaining === right?.dollarRemaining &&
    left?.modelName === right?.modelName
  );
}

export function agentProbeProviderRenderStateEquals(
  left: AgentProbeProvider | null | undefined,
  right: AgentProbeProvider | null | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return left === right;
  }
  return (
    left.provider === right.provider &&
    left.availability.status === right.availability.status &&
    left.availability.detailsVisible === right.availability.detailsVisible &&
    (left.availability.checks?.length ?? 0) ===
      (right.availability.checks?.length ?? 0) &&
    (left.availability.checks ?? []).every((check, index) => {
      const next = right.availability.checks?.[index];
      return (
        check.name === next?.name &&
        check.passed === next?.passed &&
        check.detail === next?.detail
      );
    }) &&
    (left.usage?.accountTier ?? null) === (right.usage?.accountTier ?? null) &&
    (left.usage?.costUsage?.dollarUsed ?? null) ===
      (right.usage?.costUsage?.dollarUsed ?? null) &&
    (left.usage?.costUsage?.dollarLimit ?? null) ===
      (right.usage?.costUsage?.dollarLimit ?? null) &&
    (left.usage?.quotas?.length ?? 0) === (right.usage?.quotas?.length ?? 0) &&
    (left.usage?.quotas ?? []).every((quota, index) =>
      quotaRenderStateEquals(quota, right.usage?.quotas?.[index])
    ) &&
    (left.attempts?.length ?? 0) === (right.attempts?.length ?? 0) &&
    (left.attempts ?? []).every((attempt, index) => {
      const next = right.attempts?.[index];
      return (
        attempt.strategy === next?.strategy &&
        attempt.success === next?.success &&
        attempt.errorCode === next?.errorCode &&
        attempt.errorMessage === next?.errorMessage
      );
    }) &&
    left.lastError?.code === right.lastError?.code &&
    left.lastError?.message === right.lastError?.message
  );
}

export function workspaceAgentProbeRenderStateEqualsForProvider(
  left: WorkspaceDesktopAgentProbesState | null | undefined,
  right: WorkspaceDesktopAgentProbesState | null | undefined,
  provider: AgentProvider
): boolean {
  if (left === right) {
    return true;
  }
  return (
    (left?.isLoadingAvailability ?? false) ===
      (right?.isLoadingAvailability ?? false) &&
    (left?.isLoadingUsage ?? false) === (right?.isLoadingUsage ?? false) &&
    agentProbeProviderRenderStateEquals(
      findWorkspaceAgentProbeForDockProvider(left?.snapshot ?? null, provider),
      findWorkspaceAgentProbeForDockProvider(right?.snapshot ?? null, provider)
    )
  );
}

export interface DockAgentProbePopupLineOptions {
  /** Append usage / quota lines (requires `includeUsage` probe polling). */
  includeUsageLines?: boolean;
  isLoadingUsage?: boolean;
}

export type DockAgentProbeTooltipLine =
  | string
  | {
      label?: string;
      primary: string;
      secondary?: string;
    };

/** Status text for dock popover / inline agent probe UI. */
export function buildDockAgentProbeTooltipLines(
  probe: AgentProbeProvider | null,
  isLoadingAvailability: boolean,
  t: TranslateFn,
  popupOpts?: DockAgentProbePopupLineOptions
): DockAgentProbeTooltipLine[] {
  if (isLoadingAvailability && !probe) {
    return [t("agentHost.workspaceAgentProbeDockChecking")];
  }
  if (!probe) {
    return [t("agentHost.workspaceAgentProbeDockNoData")];
  }

  const lines: DockAgentProbeTooltipLine[] = [];
  switch (probe.availability.status) {
    case "available":
      lines.push({
        label: t("agentHost.workspaceAgentProbeDetailStatus"),
        primary: t("agentHost.workspaceAgentProbeDockAvailable")
      });
      break;
    case "unavailable":
      lines.push({
        label: t("agentHost.workspaceAgentProbeDetailStatus"),
        primary: t("agentHost.workspaceAgentProbeUnavailableAria")
      });
      break;
    default:
      lines.push({
        label: t("agentHost.workspaceAgentProbeDetailStatus"),
        primary: t("agentHost.workspaceAgentProbeUnknownAria")
      });
  }

  if (
    probe.availability.status !== "available" &&
    probe.availability.detailsVisible
  ) {
    for (const check of probe.availability.checks ?? []) {
      if (!check.passed) {
        const primary = check.detail?.trim() || check.name.trim();
        if (!primary) {
          continue;
        }
        lines.push({
          label: check.name,
          primary
        });
      }
    }
  }

  const errMsg = probe.lastError?.message?.trim();
  // Usage-aware dock popup: omit raw probe errors — they duplicate usage polling noise
  // ("could not find … quotas") while availability is often still fine via checks.
  if (errMsg && !popupOpts?.includeUsageLines) {
    lines.push(errMsg);
  }

  if (!popupOpts?.includeUsageLines) {
    return lines;
  }

  appendDockProbeUsageLines(probe, lines, popupOpts.isLoadingUsage ?? false, t);

  return lines;
}

interface DockDisplayQuotaRow {
  label: string;
  percentRemaining?: number;
  dollarRemaining?: number;
  resetDisplay?: string;
}

function formatQuotaResetDisplay(
  quota: AgentUsageQuota | undefined
): string | undefined {
  if (!quota) {
    return undefined;
  }
  if (
    typeof quota.resetsAtUnixMs === "number" &&
    Number.isFinite(quota.resetsAtUnixMs)
  ) {
    return toLocalShortDateTime(quota.resetsAtUnixMs);
  }
  return quota.resetText;
}

function quotaTypeLabel(quotaType: string, t: TranslateFn): string {
  switch (quotaType) {
    case "session":
      return t("agentHost.workspaceAgentProbeQuotaSession");
    case "weekly":
      return t("agentHost.workspaceAgentProbeQuotaWeekly");
    case "monthly":
      return t("agentHost.workspaceAgentProbeQuotaMonthly");
    case "daily":
      return t("agentHost.workspaceAgentProbeQuotaDaily");
    case "cost":
      return t("agentHost.workspaceAgentProbeQuotaCost");
    default:
      return quotaType;
  }
}

function buildCompactDisplayQuotas(
  quotas: AgentUsageQuota[],
  t: TranslateFn
): DockDisplayQuotaRow[] {
  const modelQuotas = quotas.filter(
    (quota) => quota.modelName || quota.quotaType === "model"
  );
  const nonModelQuotas = quotas.filter(
    (quota) => !quota.modelName && quota.quotaType !== "model"
  );
  const displayRows: DockDisplayQuotaRow[] = nonModelQuotas.map((quota) => ({
    label:
      quota.quotaType === "session" ? "" : quotaTypeLabel(quota.quotaType, t),
    percentRemaining: quota.percentRemaining,
    dollarRemaining: quota.dollarRemaining,
    resetDisplay: formatQuotaResetDisplay(quota)
  }));

  if (modelQuotas.length === 0) {
    return displayRows;
  }

  const percentQuota = modelQuotas
    .filter(
      (quota): quota is AgentUsageQuota & { percentRemaining: number } =>
        typeof quota.percentRemaining === "number"
    )
    .sort((left, right) => left.percentRemaining - right.percentRemaining)[0];
  const dollarQuota = modelQuotas
    .filter(
      (quota): quota is AgentUsageQuota & { dollarRemaining: number } =>
        typeof quota.dollarRemaining === "number"
    )
    .sort((left, right) => left.dollarRemaining - right.dollarRemaining)[0];

  displayRows.push({
    label: t("agentHost.workspaceAgentProbeAgentUsage"),
    percentRemaining: percentQuota?.percentRemaining,
    dollarRemaining: dollarQuota?.dollarRemaining,
    resetDisplay: formatQuotaResetDisplay(percentQuota ?? dollarQuota)
  });
  return displayRows;
}

function formatQuotaPrimaryLine(
  row: DockDisplayQuotaRow,
  t: TranslateFn
): string | null {
  if (row.percentRemaining !== undefined) {
    return t("agentHost.workspaceAgentProbeQuotaRemaining", {
      percent: Math.round(row.percentRemaining)
    });
  }
  if (row.dollarRemaining !== undefined) {
    return t("agentHost.workspaceAgentProbeQuotaDollarRemaining", {
      amount: row.dollarRemaining.toFixed(2)
    });
  }
  return null;
}

function appendDockProbeUsageLines(
  probe: AgentProbeProvider,
  lines: DockAgentProbeTooltipLine[],
  isLoadingUsage: boolean,
  t: TranslateFn
): void {
  if (probe.lastError?.code === "unsupported") {
    lines.push({
      label: t("agentHost.workspaceAgentProbeDetailQuota"),
      primary: t("agentHost.workspaceAgentProbeUsageUnsupported")
    });
    return;
  }

  if (isLoadingUsage && !probe.usage) {
    lines.push(t("agentHost.workspaceAgentProbeLoadingUsage"));
    return;
  }

  const quotas = probe.usage?.quotas ?? [];
  if (quotas.length === 0) {
    if (probe.usage) {
      lines.push({
        label: t("agentHost.workspaceAgentProbeDetailQuota"),
        primary: t("agentHost.workspaceAgentProbeUsageUnsupported")
      });
    }
    return;
  }

  const rows = buildCompactDisplayQuotas(quotas, t);
  for (const row of rows) {
    const primary = formatQuotaPrimaryLine(row, t);
    const labelTrim = row.label.trim();
    if (primary) {
      const label = labelTrim || t("agentHost.workspaceAgentProbeDetailQuota");
      lines.push({
        label,
        primary
      });
      if (row.resetDisplay) {
        lines.push({
          label: t("agentHost.workspaceAgentProbeQuotaResetTimeLabel", {
            label
          }),
          primary: row.resetDisplay
        });
      }
    }
  }
}
