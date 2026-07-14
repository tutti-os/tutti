import type { AgentActivityUsage } from "@tutti-os/agent-activity-core";
import type { TranslateFn } from "../../i18n/index";
import { toLocalShortDateTime } from "../../app/renderer/shell/utils/format";
import type { AgentUsageQuota } from "../../shared/contracts/dto";
import type { AgentProvider } from "../../contexts/settings/domain/agentSettings";
import type { AgentGUIAgentTarget } from "../../types";
import type { AgentComposerSlashStatusLimit } from "./AgentComposer";
import type { useAgentGUINodeController } from "./controller/useAgentGUINodeController";

function slashStatusQuotaLabel(quota: AgentUsageQuota, t: TranslateFn): string {
  const modelName = quota.modelName?.trim();
  if (modelName) {
    return modelName;
  }
  switch (quota.quotaType) {
    case "session":
      return t("agentHost.agentGui.slashStatusFiveHourLimit");
    case "weekly":
      return t("agentHost.agentGui.slashStatusWeeklyLimit");
    case "daily":
      return t("agentHost.workspaceAgentProbeQuotaDaily");
    case "monthly":
      return t("agentHost.workspaceAgentProbeQuotaMonthly");
    case "cost":
      return t("agentHost.workspaceAgentProbeQuotaCost");
    case "model":
      return t("agentHost.workspaceAgentProbeAgentUsage");
    default:
      return quota.quotaType;
  }
}

function slashStatusQuotaValue(quota: AgentUsageQuota, t: TranslateFn): string {
  if (
    typeof quota.percentRemaining === "number" &&
    Number.isFinite(quota.percentRemaining)
  ) {
    return t("agentHost.agentGui.slashStatusLimitPercentLeft", {
      percent: Math.round(quota.percentRemaining)
    });
  }
  if (
    typeof quota.dollarRemaining === "number" &&
    Number.isFinite(quota.dollarRemaining)
  ) {
    return t("agentHost.workspaceAgentProbeQuotaDollarRemaining", {
      amount: quota.dollarRemaining.toFixed(2)
    });
  }
  return "";
}

function slashStatusQuotaReset(quota: AgentUsageQuota, t: TranslateFn): string {
  const reset =
    typeof quota.resetsAtUnixMs === "number" &&
    Number.isFinite(quota.resetsAtUnixMs)
      ? toLocalShortDateTime(quota.resetsAtUnixMs)
      : quota.resetText?.trim();
  return reset ? t("agentHost.agentGui.slashStatusLimitReset", { reset }) : "";
}

export function slashStatusLimitsFromQuotas(
  quotas: readonly AgentUsageQuota[] | undefined,
  selectedModel: string | null | undefined,
  t: TranslateFn
): AgentComposerSlashStatusLimit[] {
  const filteredQuotas = filterSlashStatusQuotasForModel(quotas, selectedModel);
  return filteredQuotas
    .map((quota, index): AgentComposerSlashStatusLimit | null => {
      const value = slashStatusQuotaValue(quota, t);
      if (!value) {
        return null;
      }
      const label = slashStatusQuotaLabel(quota, t).trim();
      if (!label) {
        return null;
      }
      return {
        id: `${quota.quotaType}:${quota.modelName ?? ""}:${index}`,
        label,
        percentRemaining:
          typeof quota.percentRemaining === "number" &&
          Number.isFinite(quota.percentRemaining)
            ? Math.max(0, Math.min(100, Math.round(quota.percentRemaining)))
            : null,
        value,
        reset: slashStatusQuotaReset(quota, t) || null
      };
    })
    .filter((limit): limit is AgentComposerSlashStatusLimit => limit !== null);
}

export function slashStatusQuotasFromCanonicalUsage(
  usage: AgentActivityUsage | null
): AgentUsageQuota[] {
  if (!usage) {
    return [];
  }
  return usage.quotas
    .map((quota): AgentUsageQuota | null => {
      const record = objectRecord(quota);
      const quotaType = agentUsageQuotaTypeValue(record?.quotaType);
      if (!record || !quotaType) {
        return null;
      }
      const normalized: AgentUsageQuota = { quotaType };
      const percentRemaining = numberValue(record.percentRemaining);
      if (percentRemaining !== null) {
        normalized.percentRemaining = percentRemaining;
      }
      const resetsAtUnixMs = numberValue(record.resetsAtUnixMs);
      if (resetsAtUnixMs !== null) {
        normalized.resetsAtUnixMs = resetsAtUnixMs;
      }
      const resetText = stringValue(record.resetText);
      if (resetText) {
        normalized.resetText = resetText;
      }
      const dollarRemaining = numberValue(record.dollarRemaining);
      if (dollarRemaining !== null) {
        normalized.dollarRemaining = dollarRemaining;
      }
      const modelName = stringValue(record.modelName);
      if (modelName) {
        normalized.modelName = modelName;
      }
      return normalized;
    })
    .filter((quota): quota is AgentUsageQuota => quota !== null);
}

function agentUsageQuotaTypeValue(
  value: unknown
): AgentUsageQuota["quotaType"] | null {
  switch (stringValue(value)) {
    case "session":
    case "weekly":
    case "monthly":
    case "daily":
    case "model":
    case "cost":
      return stringValue(value) as AgentUsageQuota["quotaType"];
    default:
      return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function filterSlashStatusQuotasForModel(
  quotas: readonly AgentUsageQuota[] | undefined,
  selectedModel: string | null | undefined
): readonly AgentUsageQuota[] {
  const normalizedSelectedModel = normalizeSlashStatusModelName(selectedModel);
  const baseQuotas = (quotas ?? []).filter(
    (quota) => quota.quotaType !== "model"
  );
  const matchingModelQuotas = (quotas ?? []).filter((quota) => {
    const quotaModelName = normalizeSlashStatusModelName(quota.modelName);
    return (
      quota.quotaType === "model" &&
      quotaModelName !== "" &&
      normalizedSelectedModel !== "" &&
      quotaModelName === normalizedSelectedModel
    );
  });
  return [...baseQuotas, ...matchingModelQuotas];
}

function normalizeSlashStatusModelName(
  value: string | null | undefined
): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") ?? ""
  );
}

export function resolveAgentGUIRailStatusProvider(input: {
  conversationFilter: ReturnType<
    typeof useAgentGUINodeController
  >["viewModel"]["rail"]["conversationFilter"];
  agentTargets: readonly AgentGUIAgentTarget[];
}): AgentProvider | null {
  const filter = input.conversationFilter;
  if (filter.kind !== "agentTarget") {
    return null;
  }
  const target = input.agentTargets.find(
    (candidate) =>
      candidate.disabled !== true &&
      (candidate.agentTargetId?.trim() ?? "") === filter.agentTargetId
  );
  return target ? (target.provider as AgentProvider) : null;
}
