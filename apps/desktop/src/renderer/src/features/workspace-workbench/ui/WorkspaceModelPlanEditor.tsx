import { useState } from "react";
import {
  AddIcon,
  Button,
  CloseIcon,
  Combobox,
  DeleteIcon,
  EyeIcon,
  OpenLinkLinedIcon,
  RadioIndicator,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import type { DesktopI18nKey } from "../../../../../shared/i18n/index.ts";
import {
  getWorkspaceModelPlanTemplateGroup,
  getWorkspaceModelPlanTemplatePreset,
  toWorkspaceModelPlanPresetModels,
  workspaceModelPlanUsesNativeLogin
} from "../services/workspaceModelPlanTemplates";
import {
  buildWorkspaceModelPlanCandidateCatalog,
  createCustomWorkspaceModelPlanCandidate,
  workspaceModelPlanCandidatesForSlot
} from "../services/workspaceModelPlanCandidates";
import {
  createEmptyWorkspaceModelPlanDraftModel,
  reconcileWorkspaceModelPlanDraftModelsForPreset,
  removeWorkspaceModelPlanDraftModel,
  replaceWorkspaceModelPlanDraftModel
} from "../services/workspaceModelPlanDraftModels";
import type {
  WorkspaceModelPlanDetection,
  WorkspaceModelPlanDraft,
  WorkspaceModelPlanFeedback,
  WorkspaceModelPlanModel,
  WorkspaceModelPlanProtocol,
  WorkspaceModelPlanReferenceKind,
  WorkspaceModelPlanSaveImpact
} from "../services/workspaceSettingsTypes";
import { WorkspaceModelPlanDetectionSteps } from "./WorkspaceModelPlanDetectionSteps";
import {
  workspaceSettingsInputClass,
  workspaceSettingsSelectContentClass,
  workspaceSettingsSelectTriggerClass
} from "./workspaceSettingsFieldStyles";

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

const draftFeedbackConfig: Record<
  WorkspaceModelPlanFeedback["kind"],
  { className: string; messageKey: DesktopI18nKey }
> = {
  detectFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.detectFailed"
  },
  detectionRequired: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.detectionRequired"
  },
  deleteFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.deleteFailed"
  },
  duplicateFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.duplicateFailed"
  },
  fetchModelsEmpty: {
    className: "text-[var(--text-secondary)]",
    messageKey: "workspace.settings.apps.modelPlans.fetchModelsEmpty"
  },
  fetchModelsFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.fetchModelsFailed"
  },
  requiredFields: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.requiredFieldsMissing"
  },
  saveFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.saveFailed"
  },
  toggleFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.toggleFailed"
  }
};

export function WorkspaceModelPlanFeedbackLine({
  feedback
}: {
  feedback: WorkspaceModelPlanFeedback | null | undefined;
}) {
  const { t } = useTranslation();
  if (!feedback) {
    return null;
  }
  const config = draftFeedbackConfig[feedback.kind];
  return (
    <p className={cn("m-0 text-[12px] leading-[1.4]", config.className)}>
      {t(config.messageKey)}
    </p>
  );
}

/**
 * Inline editor for one model plan draft, ordered as the user works:
 * credentials, explicit model fetch, model selection with an inline default
 * marker, then the connection check as the final gate before saving.
 */
export function WorkspaceModelPlanEditor({
  detecting,
  detection,
  discoveredModels,
  draft,
  feedback,
  fetchingModels,
  saveImpact,
  saving,
  onCancel,
  onDetect,
  onFetchModels,
  onSave,
  onUpdate
}: {
  detecting: boolean;
  detection: WorkspaceModelPlanDetection | null;
  discoveredModels: readonly WorkspaceModelPlanModel[];
  draft: Readonly<WorkspaceModelPlanDraft>;
  feedback: WorkspaceModelPlanFeedback | null;
  fetchingModels: boolean;
  saveImpact: WorkspaceModelPlanSaveImpact | null;
  saving: boolean;
  onCancel: () => void;
  onDetect: () => void;
  onFetchModels: () => void;
  onSave: () => void;
  onUpdate: (patch: Partial<WorkspaceModelPlanDraft>) => void;
}) {
  const { t } = useTranslation();
  const [apiKeyVisible, setApiKeyVisible] = useState(false);

  const group = getWorkspaceModelPlanTemplateGroup(draft.templateKind);
  const usesNativeLogin = workspaceModelPlanUsesNativeLogin(draft.templateKind);
  const preset = getWorkspaceModelPlanTemplatePreset(draft.templateId);
  const apiKeyUrl = preset?.apiKeyUrl ?? null;
  const protocolLocked = preset?.protocolLocked ?? false;
  const candidateCatalog = buildWorkspaceModelPlanCandidateCatalog(
    preset ? toWorkspaceModelPlanPresetModels(preset) : [],
    discoveredModels
  );
  const editing = draft.planId !== null;
  const isFetchFeedback =
    feedback?.kind === "fetchModelsFailed" ||
    feedback?.kind === "fetchModelsEmpty";
  const fetchFeedback = isFetchFeedback ? feedback : null;
  const generalFeedback = isFetchFeedback ? null : feedback;

  const selectSlotModel = (index: number, value: string) => {
    const model =
      candidateCatalog.find((candidate) => candidate.id === value) ??
      createCustomWorkspaceModelPlanCandidate(value);
    if (!model) {
      return;
    }
    onUpdate(
      replaceWorkspaceModelPlanDraftModel({
        defaultModel: draft.defaultModel,
        index,
        model,
        models: draft.models
      })
    );
  };

  return (
    <section className="flex w-full flex-col gap-4 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {editing
              ? t("workspace.settings.apps.modelPlans.editTitle", {
                  plan: draft.name
                })
              : (group && t(group.labelKey)) ||
                t("workspace.settings.apps.modelPlans.addPlan")}
          </strong>
          {group ? (
            <p className="m-0 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
              {t(group.guidanceKey)}
            </p>
          ) : null}
        </div>
        <button
          aria-label={t("common.cancel")}
          className="flex size-8 shrink-0 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
          type="button"
          onClick={onCancel}
        >
          <CloseIcon className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        {group && group.presets.length > 1 && !editing ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              {t("workspace.settings.apps.modelPlans.presetLabel")}
            </span>
            <Select
              value={draft.templateId ?? group.presets[0]?.id ?? ""}
              onValueChange={(value) => {
                const nextPreset = group.presets.find(
                  (candidate) => candidate.id === value
                );
                if (!nextPreset) {
                  return;
                }
                onUpdate({
                  baseUrl: nextPreset.baseUrl,
                  protocol: nextPreset.protocol,
                  templateId: nextPreset.id,
                  ...reconcileWorkspaceModelPlanDraftModelsForPreset({
                    defaultModel: draft.defaultModel,
                    models: draft.models,
                    presetModels: toWorkspaceModelPlanPresetModels(nextPreset)
                  })
                });
              }}
            >
              <SelectTrigger
                aria-label={t("workspace.settings.apps.modelPlans.presetLabel")}
                className={workspaceSettingsSelectTriggerClass}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                className={workspaceSettingsSelectContentClass}
                style={{ zIndex: "var(--z-panel-popover)" }}
              >
                {group.presets.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {t(candidate.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.modelPlans.protocolLabel")}
          </span>
          <Select
            disabled={protocolLocked || editing}
            value={draft.protocol}
            onValueChange={(value) => {
              onUpdate({ protocol: value as WorkspaceModelPlanProtocol });
            }}
          >
            <SelectTrigger
              aria-label={t("workspace.settings.apps.modelPlans.protocolLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              <SelectItem value="anthropic">
                {t("workspace.settings.apps.modelPlans.protocols.anthropic")}
              </SelectItem>
              <SelectItem value="openai">
                {t("workspace.settings.apps.modelPlans.protocols.openai")}
              </SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.modelPlans.nameLabel")}
          </span>
          <input
            className={workspaceSettingsInputClass}
            placeholder={t(
              "workspace.settings.apps.modelPlans.namePlaceholder"
            )}
            type="text"
            value={draft.name}
            onChange={(event) => onUpdate({ name: event.currentTarget.value })}
          />
        </label>

        {usesNativeLogin ? (
          <p className="col-span-2 m-0 rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3 text-[12px] leading-[1.5] text-[var(--text-secondary)] max-[640px]:col-span-1">
            {t("workspace.settings.apps.modelPlans.nativeLoginHint")}
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                {t("workspace.settings.apps.modelPlans.apiKey")}
              </span>
              <div className="relative">
                <input
                  className={`${workspaceSettingsInputClass} pr-9`}
                  placeholder={
                    draft.hasApiKey
                      ? t("workspace.settings.apps.modelPlans.keepExistingKey")
                      : "sk-..."
                  }
                  spellCheck={false}
                  type={apiKeyVisible ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) =>
                    onUpdate({ apiKey: event.currentTarget.value })
                  }
                />
                <button
                  aria-label={t(
                    apiKeyVisible
                      ? "workspace.settings.apps.modelPlans.hideApiKey"
                      : "workspace.settings.apps.modelPlans.showApiKey"
                  )}
                  aria-pressed={apiKeyVisible}
                  className={cn(
                    "absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[5px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
                    apiKeyVisible && "text-[var(--text-primary)]"
                  )}
                  type="button"
                  onClick={() => setApiKeyVisible((visible) => !visible)}
                >
                  <EyeIcon aria-hidden="true" size={16} />
                </button>
              </div>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                {t("workspace.settings.apps.modelPlans.baseUrl")}
              </span>
              <input
                className={workspaceSettingsInputClass}
                placeholder="https://"
                type="url"
                value={draft.baseUrl}
                onChange={(event) =>
                  onUpdate({ baseUrl: event.currentTarget.value })
                }
              />
            </label>
          </>
        )}
      </div>

      {apiKeyUrl ? (
        <button
          className="inline-flex w-fit items-center gap-1.5 rounded-[5px] text-left text-[12px] font-medium text-[var(--text-primary)] transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
          type="button"
          onClick={() => {
            window.open(apiKeyUrl, "_blank", "noopener,noreferrer");
          }}
        >
          {t("workspace.settings.apps.modelPlans.getApiKey", {
            provider: preset ? t(preset.labelKey) : ""
          })}
          <OpenLinkLinedIcon aria-hidden="true" size={13} />
        </button>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={fetchingModels || detecting}
            size="sm"
            type="button"
            variant="secondary"
            onClick={onFetchModels}
          >
            {fetchingModels
              ? t("workspace.settings.apps.modelPlans.fetchingModels")
              : t("workspace.settings.apps.modelPlans.fetchModels")}
          </Button>
          {discoveredModels.length > 0 ? (
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {t("workspace.settings.apps.modelPlans.fetchModelsResult", {
                count: String(discoveredModels.length)
              })}
            </span>
          ) : null}
        </div>
        <WorkspaceModelPlanFeedbackLine feedback={fetchFeedback} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.modelPlans.models")}
        </span>
        <div className="flex flex-col gap-1.5">
          {draft.models.map((model, index) => {
            const modelID = model.id.trim();
            const isDefault =
              modelID.length > 0 && modelID === draft.defaultModel;
            return (
              <div
                // Index keys keep slot identity stable while a slot's id
                // changes through the combobox; blank slots share the empty
                // id, so ids cannot key the rows.
                // eslint-disable-next-line react/no-array-index-key
                key={index}
                className="grid grid-cols-[minmax(0,1fr)_auto_32px] items-center gap-1.5 rounded-[8px] border border-[var(--border-1)] p-2"
              >
                <Combobox
                  allowCustomValue
                  aria-label={t("workspace.settings.apps.modelPlans.modelId")}
                  className={workspaceSettingsSelectTriggerClass}
                  contentStyle={{ zIndex: "var(--z-panel-popover)" }}
                  customValueLabel={(query) =>
                    t(
                      "workspace.settings.apps.modelPlans.modelPickerUseCustom",
                      {
                        model: query
                      }
                    )
                  }
                  emptyMessage={t(
                    "workspace.settings.apps.modelPlans.modelPickerEmpty"
                  )}
                  options={workspaceModelPlanCandidatesForSlot(
                    candidateCatalog,
                    draft.models,
                    index
                  ).map((candidate) => ({
                    description:
                      candidate.name && candidate.name !== candidate.id
                        ? candidate.name
                        : undefined,
                    keywords: candidate.name ? [candidate.name] : undefined,
                    label: candidate.id,
                    value: candidate.id
                  }))}
                  placeholder={t(
                    "workspace.settings.apps.modelPlans.modelPickerPlaceholder"
                  )}
                  searchPlaceholder={t(
                    "workspace.settings.apps.modelPlans.modelPickerSearchPlaceholder"
                  )}
                  value={model.id}
                  onValueChange={(value) => selectSlotModel(index, value)}
                />
                <button
                  aria-label={t(
                    "workspace.settings.apps.modelPlans.setDefaultModel",
                    { model: modelID }
                  )}
                  aria-pressed={isDefault}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-[12px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
                    isDefault
                      ? "text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]",
                    !modelID && "cursor-not-allowed opacity-50"
                  )}
                  disabled={!modelID}
                  type="button"
                  onClick={() => onUpdate({ defaultModel: modelID })}
                >
                  <RadioIndicator checked={isDefault} disabled={!modelID} />
                  {t("workspace.settings.apps.modelPlans.defaultMarker")}
                </button>
                <button
                  aria-label={t(
                    "workspace.settings.apps.modelPlans.removeModel"
                  )}
                  className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                  type="button"
                  onClick={() =>
                    onUpdate(
                      removeWorkspaceModelPlanDraftModel({
                        defaultModel: draft.defaultModel,
                        index,
                        models: draft.models
                      })
                    )
                  }
                >
                  <DeleteIcon aria-hidden="true" size={15} />
                </button>
              </div>
            );
          })}
          <button
            className="flex h-9 items-center justify-center gap-1.5 rounded-[8px] border border-dashed border-[var(--border-1)] text-[12px] font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
            type="button"
            onClick={() => {
              onUpdate({
                models: [
                  ...draft.models,
                  createEmptyWorkspaceModelPlanDraftModel()
                ]
              });
            }}
          >
            <AddIcon className="size-3.5" />
            {t("workspace.settings.apps.modelPlans.addModel")}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.modelPlans.detectionTitle")}
          </span>
          <Button
            className="h-auto px-0 text-[12px] font-medium text-[var(--text-primary)] hover:bg-transparent hover:text-[var(--text-primary)]"
            disabled={detecting || fetchingModels}
            size="sm"
            type="button"
            variant="ghost"
            onClick={onDetect}
          >
            {detecting
              ? t("workspace.settings.apps.modelPlans.detecting")
              : t("workspace.settings.apps.modelPlans.detect")}
          </Button>
        </div>
        <WorkspaceModelPlanDetectionSteps
          detecting={detecting}
          detection={detection}
        />
      </div>

      <WorkspaceModelPlanFeedbackLine feedback={generalFeedback} />

      {saveImpact ? (
        <section className="grid gap-2 rounded-[8px] border border-[var(--state-warning)] bg-[var(--transparency-block)] p-3">
          <strong className="text-[12px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.apps.modelPlans.modelRangeImpactTitle")}
          </strong>
          <p className="m-0 text-[11px] leading-[1.4] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.apps.modelPlans.modelRangeImpactDescription"
            )}
          </p>
          <ul className="m-0 grid gap-1 pl-4 text-[11px] text-[var(--text-secondary)]">
            {saveImpact.references.map((reference) => (
              <li key={`${reference.kind}:${reference.id}`}>
                {t(referenceKindLabelKeys[reference.kind])}
                {" · "}
                {reference.name || reference.id}
                {reference.role ? ` · ${reference.role}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button disabled={saving} type="button" onClick={onSave}>
          {saving
            ? t("workspace.settings.apps.modelPlans.saving")
            : t(
                saveImpact
                  ? "workspace.settings.apps.modelPlans.confirmModelRangeImpact"
                  : "workspace.settings.apps.modelPlans.save"
              )}
        </Button>
      </div>
    </section>
  );
}
