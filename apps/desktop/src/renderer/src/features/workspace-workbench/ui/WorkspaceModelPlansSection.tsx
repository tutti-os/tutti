import { useState } from "react";
import {
  AddIcon,
  Button,
  CopyIcon,
  DeleteIcon,
  EditIcon,
  StatusDot,
  Switch
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import type { DesktopI18nKey } from "../../../../../shared/i18n/index.ts";
import {
  workspaceModelPlanTemplateGroups,
  type WorkspaceModelPlanTemplateGroup
} from "../services/workspaceModelPlanTemplates";
import type {
  WorkspaceModelPlan,
  WorkspaceModelPlanReferenceKind,
  WorkspaceModelPlanStatus,
  WorkspaceSettingsModelPlansSnapshotState
} from "../services/workspaceSettingsTypes";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import {
  WorkspaceModelPlanEditor,
  WorkspaceModelPlanFeedbackLine
} from "./WorkspaceModelPlanEditor";

const planStatusLabelKeys: Record<WorkspaceModelPlanStatus, DesktopI18nKey> = {
  disabled: "workspace.settings.apps.modelPlans.statusLabels.disabled",
  undetected: "workspace.settings.apps.modelPlans.statusLabels.undetected",
  detection_failed:
    "workspace.settings.apps.modelPlans.statusLabels.detectionFailed",
  ready: "workspace.settings.apps.modelPlans.statusLabels.ready"
};

const planStatusTones: Record<
  WorkspaceModelPlanStatus,
  "amber" | "blue" | "green" | "neutral" | "red"
> = {
  disabled: "neutral",
  undetected: "blue",
  detection_failed: "red",
  ready: "green"
};

const referenceKindLabelKeys: Record<
  WorkspaceModelPlanReferenceKind,
  DesktopI18nKey
> = {
  agent_target: "workspace.settings.apps.modelPlans.referenceKinds.agentTarget",
  model_policy: "workspace.settings.apps.modelPlans.referenceKinds.modelPolicy",
  workspace_agent:
    "workspace.settings.apps.modelPlans.referenceKinds.workspaceAgent",
  workspace_app:
    "workspace.settings.apps.modelPlans.referenceKinds.workspaceApp"
};

const protocolLabelKeys: Record<
  WorkspaceModelPlan["protocol"],
  DesktopI18nKey
> = {
  anthropic: "workspace.settings.apps.modelPlans.protocols.anthropic",
  openai: "workspace.settings.apps.modelPlans.protocols.openai"
};

/**
 * Workspace "model plans" settings: named model access plans per access
 * scheme, with staged detection status and lifecycle actions.
 */
export function WorkspaceModelPlansSection() {
  const { t } = useTranslation();
  const { service, state } = useWorkspaceSettingsService();
  const modelPlans = state.modelPlans;
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  const beginDraftFromGroup = (group: WorkspaceModelPlanTemplateGroup) => {
    const preset = group.presets[0];
    if (!preset) {
      return;
    }
    service.modelPlans.beginDraft({
      baseUrl: preset.baseUrl,
      name: t(preset.labelKey),
      protocol: preset.protocol,
      templateId: preset.id,
      templateKind: group.kind
    });
    setTemplatePickerOpen(false);
  };

  const draft = modelPlans.draft;
  const isEmpty = modelPlans.plans.length === 0 && draft === null;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.apps.modelPlans.title")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.35] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.modelPlans.description")}
          </p>
        </div>
        <Button
          className="shrink-0"
          disabled={draft !== null}
          size="sm"
          type="button"
          onClick={() => setTemplatePickerOpen((open) => !open)}
        >
          <AddIcon className="size-3.5" />
          {t("workspace.settings.apps.modelPlans.addPlan")}
        </Button>
      </div>

      {templatePickerOpen && draft === null ? (
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.modelPlans.templatePickerTitle")}
          </span>
          {workspaceModelPlanTemplateGroups.map((group) => (
            <button
              key={group.kind}
              className="flex flex-col gap-0.5 rounded-[8px] px-2.5 py-2 text-left outline-none transition-colors duration-150 hover:bg-[var(--transparency-hover)] focus-visible:bg-[var(--transparency-hover)]"
              type="button"
              onClick={() => beginDraftFromGroup(group)}
            >
              <span className="text-[13px] font-medium text-[var(--text-primary)]">
                {t(group.labelKey)}
              </span>
              <span className="text-[11px] leading-[1.4] text-[var(--text-secondary)]">
                {t(group.guidanceKey)}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {isEmpty && !templatePickerOpen ? (
        <div className="flex flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-[var(--border-1)] bg-[var(--transparency-block)] px-4 py-8 text-center">
          <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
            {t("workspace.settings.apps.modelPlans.emptyTitle")}
          </p>
          <p className="m-0 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.modelPlans.emptyDescription")}
          </p>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-2">
          {modelPlans.plans.map((plan) =>
            draft && draft.planId === plan.id ? (
              <WorkspaceModelPlanEditor
                key={plan.id}
                discoveredModels={modelPlans.draftDiscoveredModels}
                draft={draft}
                feedback={modelPlans.draftFeedback}
                fetchingModels={modelPlans.fetchingDraftModels}
                saveImpact={modelPlans.draftSaveImpact}
                saving={modelPlans.saving}
                onCancel={() => service.modelPlans.cancelDraft()}
                onFetchModels={() => {
                  void service.modelPlans.fetchDraftModels();
                }}
                onSave={() => {
                  void service.modelPlans.saveDraft();
                }}
                onUpdate={(patch) => service.modelPlans.updateDraft(patch)}
              />
            ) : (
              <WorkspaceModelPlanRow
                key={plan.id}
                modelPlans={modelPlans}
                plan={plan}
              />
            )
          )}
          {draft && draft.planId === null ? (
            <WorkspaceModelPlanEditor
              discoveredModels={modelPlans.draftDiscoveredModels}
              draft={draft}
              feedback={modelPlans.draftFeedback}
              fetchingModels={modelPlans.fetchingDraftModels}
              saveImpact={modelPlans.draftSaveImpact}
              saving={modelPlans.saving}
              onCancel={() => service.modelPlans.cancelDraft()}
              onFetchModels={() => {
                void service.modelPlans.fetchDraftModels();
              }}
              onSave={() => {
                void service.modelPlans.saveDraft();
              }}
              onUpdate={(patch) => service.modelPlans.updateDraft(patch)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function WorkspaceModelPlanRow({
  modelPlans,
  plan
}: {
  modelPlans: WorkspaceSettingsModelPlansSnapshotState;
  plan: WorkspaceModelPlan;
}) {
  const { t } = useTranslation();
  const { service } = useWorkspaceSettingsService();
  const detecting = modelPlans.detectingPlanID === plan.id;
  const confirmingDelete = modelPlans.confirmingDeletePlanID === plan.id;
  const deleteBlock =
    modelPlans.deleteBlock?.planID === plan.id ? modelPlans.deleteBlock : null;
  const deleting = modelPlans.deletingPlanID === plan.id;
  const busy =
    modelPlans.detectingPlanID !== null ||
    modelPlans.togglingPlanID !== null ||
    modelPlans.duplicatingPlanID !== null ||
    deleting;
  const templateGroup = workspaceModelPlanTemplateGroups.find(
    (group) => group.kind === plan.templateKind
  );
  const checkedAt = plan.detection.checkedAt;

  return (
    <section className="flex w-full flex-col gap-3 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {plan.name}
            </strong>
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--transparency-block)] px-2 py-0.5">
              <StatusDot size="sm" tone={planStatusTones[plan.status]} />
              <span className="text-[11px] text-[var(--text-secondary)]">
                {t(planStatusLabelKeys[plan.status])}
              </span>
            </span>
          </div>
          <p className="m-0 mt-1 truncate text-[11px] leading-[1.3] text-[var(--text-secondary)]">
            {[
              templateGroup ? t(templateGroup.labelKey) : null,
              t(protocolLabelKeys[plan.protocol]),
              t("workspace.settings.apps.modelPlans.modelCount", {
                count: String(plan.models.length)
              }),
              checkedAt
                ? t("workspace.settings.apps.modelPlans.lastDetectedAt", {
                    time: new Date(checkedAt).toLocaleString()
                  })
                : t("workspace.settings.apps.modelPlans.neverDetected")
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {confirmingDelete ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[12px] text-[var(--text-secondary)]">
              {t("workspace.settings.apps.modelPlans.deleteConfirm")}
            </span>
            <Button
              disabled={deleting}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                void service.modelPlans.confirmDeletePlan(plan.id);
              }}
            >
              {deleting
                ? t("workspace.settings.apps.modelPlans.deleting")
                : t("workspace.settings.apps.modelPlans.delete")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => service.modelPlans.cancelDeletePlan()}
            >
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              disabled={busy || modelPlans.draft !== null}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                void service.modelPlans.detectPlan(plan.id);
              }}
            >
              {detecting
                ? t("workspace.settings.apps.modelPlans.detecting")
                : t("workspace.settings.apps.modelPlans.detect")}
            </Button>
            <Button
              aria-label={t("workspace.settings.apps.modelPlans.edit")}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              disabled={modelPlans.draft !== null}
              size="icon"
              title={t("workspace.settings.apps.modelPlans.edit")}
              type="button"
              variant="ghost"
              onClick={() => service.modelPlans.beginEditPlan(plan.id)}
            >
              <EditIcon aria-hidden="true" size={15} />
            </Button>
            <Button
              aria-label={t("workspace.settings.apps.modelPlans.duplicate")}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              disabled={busy}
              size="icon"
              title={t("workspace.settings.apps.modelPlans.duplicate")}
              type="button"
              variant="ghost"
              onClick={() => {
                void service.modelPlans.duplicatePlan(plan.id);
              }}
            >
              <CopyIcon aria-hidden="true" size={15} />
            </Button>
            <Button
              aria-label={t("workspace.settings.apps.modelPlans.delete")}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              disabled={busy}
              size="icon"
              title={t("workspace.settings.apps.modelPlans.delete")}
              type="button"
              variant="ghost"
              onClick={() => {
                void service.modelPlans.requestDeletePlan(plan.id);
              }}
            >
              <DeleteIcon aria-hidden="true" size={15} />
            </Button>
            <Switch
              aria-label={t("workspace.settings.apps.modelPlans.enabled", {
                plan: plan.name
              })}
              checked={plan.enabled}
              disabled={modelPlans.togglingPlanID !== null}
              onCheckedChange={(enabled) => {
                void service.modelPlans.setPlanEnabled(plan.id, enabled);
              }}
            />
          </div>
        )}
      </div>

      {deleteBlock ? (
        <div className="flex flex-col gap-1.5 rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3">
          <p className="m-0 text-[12px] font-medium text-[var(--state-danger)]">
            {t("workspace.settings.apps.modelPlans.deleteBlockedTitle")}
          </p>
          <p className="m-0 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.modelPlans.deleteBlockedDescription")}
          </p>
          {deleteBlock.references.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {deleteBlock.references.map((reference) => (
                <li
                  key={`${reference.kind}:${reference.id}`}
                  className="text-[12px] text-[var(--text-primary)]"
                >
                  {t(referenceKindLabelKeys[reference.kind])} ·{" "}
                  {reference.name || reference.id}
                </li>
              ))}
            </ul>
          ) : null}
          <Button
            className="self-start"
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => service.modelPlans.cancelDeletePlan()}
          >
            {t("common.cancel")}
          </Button>
        </div>
      ) : null}

      <WorkspaceModelPlanFeedbackLine
        feedback={modelPlans.planFeedback[plan.id] ?? null}
      />
    </section>
  );
}
