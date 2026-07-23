import {
  CheckIcon,
  FailedLinedIcon,
  LoadingIcon,
  StatusDot
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import type { DesktopI18nKey } from "../../../../../shared/i18n/index.ts";
import type {
  WorkspaceModelPlanDetection,
  WorkspaceModelPlanDetectionStage,
  WorkspaceModelPlanStageResult
} from "../services/workspaceSettingsTypes";

const detectionStageOrder: readonly WorkspaceModelPlanDetectionStage[] = [
  "network",
  "auth",
  "model_discovery",
  "inference",
  "agent_runtime"
];

const detectionStageLabelKeys: Record<
  WorkspaceModelPlanDetectionStage,
  DesktopI18nKey
> = {
  network: "workspace.settings.apps.modelPlans.stages.network",
  auth: "workspace.settings.apps.modelPlans.stages.auth",
  model_discovery: "workspace.settings.apps.modelPlans.stages.modelDiscovery",
  inference: "workspace.settings.apps.modelPlans.stages.inference",
  agent_runtime: "workspace.settings.apps.modelPlans.stages.agentRuntime"
};

const stageStatusLabelKeys: Record<
  WorkspaceModelPlanStageResult["status"],
  DesktopI18nKey
> = {
  passed: "workspace.settings.apps.modelPlans.stageStatus.passed",
  failed: "workspace.settings.apps.modelPlans.stageStatus.failed",
  skipped: "workspace.settings.apps.modelPlans.stageStatus.skipped",
  pending: "workspace.settings.apps.modelPlans.stageStatus.pending"
};

const failureReasonLabelKeys: Record<string, DesktopI18nKey> = {
  connection_failed:
    "workspace.settings.apps.modelPlans.failureReasons.connectionFailed",
  unauthorized:
    "workspace.settings.apps.modelPlans.failureReasons.unauthorized",
  model_catalog_unavailable:
    "workspace.settings.apps.modelPlans.failureReasons.modelCatalogUnavailable",
  model_catalog_decode_failed:
    "workspace.settings.apps.modelPlans.failureReasons.modelCatalogDecodeFailed",
  no_model_selected:
    "workspace.settings.apps.modelPlans.failureReasons.noModelSelected",
  model_rejected:
    "workspace.settings.apps.modelPlans.failureReasons.modelRejected",
  inference_failed:
    "workspace.settings.apps.modelPlans.failureReasons.inferenceFailed",
  provider_runtime_unavailable:
    "workspace.settings.apps.modelPlans.failureReasons.providerRuntimeUnavailable",
  provider_auth_required:
    "workspace.settings.apps.modelPlans.failureReasons.providerAuthRequired"
};

const remedyLabelKeys: Record<string, DesktopI18nKey> = {
  check_network_or_base_url:
    "workspace.settings.apps.modelPlans.remedies.checkNetworkOrBaseUrl",
  check_api_key: "workspace.settings.apps.modelPlans.remedies.checkApiKey",
  add_models_manually:
    "workspace.settings.apps.modelPlans.remedies.addModelsManually",
  check_model_id: "workspace.settings.apps.modelPlans.remedies.checkModelId",
  select_model: "workspace.settings.apps.modelPlans.remedies.selectModel",
  install_or_enable_agent_provider:
    "workspace.settings.apps.modelPlans.remedies.enableProvider",
  login_agent_provider:
    "workspace.settings.apps.modelPlans.remedies.loginProvider",
  retry_compatible_agent:
    "workspace.settings.apps.modelPlans.remedies.retryCompatibleAgent"
};

/**
 * Vertical staged connection pipeline: 网络 → 认证 → 模型列表 → 真实调用,
 * with the fifth agent-runtime stage rendered as a pending-first-use hint
 * until a compatible agent completes one real call.
 */
export function WorkspaceModelPlanDetectionSteps({
  detecting,
  detection
}: {
  detecting: boolean;
  detection: WorkspaceModelPlanDetection | null;
}) {
  const { t } = useTranslation();

  if (!detecting && !detection) {
    return null;
  }

  const stageResults = new Map(
    (detection?.stages ?? []).map((stage) => [stage.stage, stage])
  );

  return (
    <ol className="m-0 flex list-none flex-col gap-0 rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3 pl-3">
      {detectionStageOrder.map((stage, index) => {
        const result = stageResults.get(stage) ?? null;
        const isAgentRuntime = stage === "agent_runtime";
        const pendingFirstUse =
          isAgentRuntime && (!result || result.status === "pending");
        return (
          <li key={stage} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <DetectionStageIcon
                detecting={detecting}
                pendingFirstUse={pendingFirstUse}
                result={result}
              />
              {index < detectionStageOrder.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="min-h-2.5 w-px flex-1 bg-[var(--border-1)]"
                />
              ) : null}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 pb-2.5 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[12px] font-medium text-[var(--text-primary)]">
                  {t(detectionStageLabelKeys[stage])}
                </span>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  {pendingFirstUse
                    ? t(
                        "workspace.settings.apps.modelPlans.statusLabels.pendingFirstUse"
                      )
                    : result
                      ? t(stageStatusLabelKeys[result.status])
                      : detecting
                        ? t(
                            "workspace.settings.apps.modelPlans.stageStatus.pending"
                          )
                        : null}
                </span>
                {typeof result?.latencyMs === "number" ? (
                  <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">
                    {t("workspace.settings.apps.modelPlans.stageLatency", {
                      ms: String(result.latencyMs)
                    })}
                  </span>
                ) : null}
              </div>
              {pendingFirstUse ? (
                <p className="m-0 text-[11px] leading-[1.4] text-[var(--text-secondary)]">
                  {t(
                    "workspace.settings.apps.modelPlans.agentRuntimePendingHint"
                  )}
                </p>
              ) : null}
              {result?.status === "failed" ? (
                <DetectionFailureLine result={result} />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DetectionStageIcon({
  detecting,
  pendingFirstUse,
  result
}: {
  detecting: boolean;
  pendingFirstUse: boolean;
  result: WorkspaceModelPlanStageResult | null;
}) {
  const { t } = useTranslation();
  if (pendingFirstUse) {
    return (
      <span className="flex size-4 items-center justify-center">
        <StatusDot
          size="sm"
          title={t(
            "workspace.settings.apps.modelPlans.statusLabels.pendingFirstUse"
          )}
          tone="amber"
        />
      </span>
    );
  }
  if (!result || result.status === "pending") {
    return (
      <span className="flex size-4 items-center justify-center">
        {detecting ? (
          <LoadingIcon
            aria-hidden="true"
            className="size-3.5 animate-spin text-[var(--text-tertiary)]"
          />
        ) : (
          <StatusDot
            size="sm"
            title={t("workspace.settings.apps.modelPlans.stageStatus.pending")}
            tone="neutral"
          />
        )}
      </span>
    );
  }
  if (result.status === "passed") {
    return (
      <CheckIcon
        aria-hidden="true"
        className="size-4 text-[var(--state-success)]"
      />
    );
  }
  if (result.status === "failed") {
    return (
      <FailedLinedIcon
        aria-hidden="true"
        className="size-4 text-[var(--state-danger)]"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 items-center justify-center text-[11px]",
        "text-[var(--text-tertiary)]"
      )}
    >
      –
    </span>
  );
}

function DetectionFailureLine({
  result
}: {
  result: WorkspaceModelPlanStageResult;
}) {
  const { t } = useTranslation();
  const reasonKey = result.failureReason
    ? (failureReasonLabelKeys[result.failureReason] ?? null)
    : null;
  const remedyKey = result.remedy
    ? (remedyLabelKeys[result.remedy] ?? null)
    : null;
  const reason = reasonKey
    ? t(reasonKey)
    : (result.detail ??
      t("workspace.settings.apps.modelPlans.failureReasons.unknown"));
  return (
    <p className="m-0 text-[11px] leading-[1.4] text-[var(--state-danger)]">
      {reason}
      {remedyKey ? (
        <span className="text-[var(--text-secondary)]"> · {t(remedyKey)}</span>
      ) : null}
    </p>
  );
}
