import { useEffect, useRef, useState } from "react";
import {
  AddIcon,
  Button,
  CloseIcon,
  DeleteIcon,
  EyeIcon,
  OpenLinkLinedIcon,
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
  toWorkspaceModelPlanPresetModels
} from "../services/workspaceModelPlanTemplates";
import type {
  WorkspaceModelPlanDetection,
  WorkspaceModelPlanDraft,
  WorkspaceModelPlanFeedback,
  WorkspaceModelPlanModel,
  WorkspaceModelPlanProtocol
} from "../services/workspaceSettingsTypes";
import { WorkspaceModelPlanDetectionSteps } from "./WorkspaceModelPlanDetectionSteps";
import {
  workspaceSettingsInputClass,
  workspaceSettingsSelectContentClass,
  workspaceSettingsSelectTriggerClass
} from "./workspaceSettingsFieldStyles";

const workspaceModelPlanInputClass = `${workspaceSettingsInputClass} focus-visible:!border-[var(--border-1)]`;

const draftFeedbackConfig: Record<
  WorkspaceModelPlanFeedback["kind"],
  { className: string; messageKey: DesktopI18nKey }
> = {
  detectFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.detectFailed"
  },
  deleteFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.deleteFailed"
  },
  duplicateFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.modelPlans.duplicateFailed"
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
 * Inline editor for one model plan draft: template preset, credentials,
 * staged connection detection, model selection, and default model.
 */
export function WorkspaceModelPlanEditor({
  detecting,
  detection,
  discoveredModels,
  draft,
  feedback,
  saving,
  onAddDiscoveredModel,
  onCancel,
  onDetect,
  onSave,
  onUpdate
}: {
  detecting: boolean;
  detection: WorkspaceModelPlanDetection | null;
  discoveredModels: readonly WorkspaceModelPlanModel[];
  draft: Readonly<WorkspaceModelPlanDraft>;
  feedback: WorkspaceModelPlanFeedback | null;
  saving: boolean;
  onAddDiscoveredModel: (modelID: string) => void;
  onCancel: () => void;
  onDetect: () => void;
  onSave: () => void;
  onUpdate: (patch: Partial<WorkspaceModelPlanDraft>) => void;
}) {
  const { t } = useTranslation();
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const modelInputRefs = useRef(new Map<number, HTMLInputElement>());
  const [pendingFocusModelIndex, setPendingFocusModelIndex] = useState<
    number | null
  >(null);

  useEffect(() => {
    if (pendingFocusModelIndex === null) {
      return;
    }
    const input = modelInputRefs.current.get(pendingFocusModelIndex);
    if (!input) {
      return;
    }
    input.focus();
    setPendingFocusModelIndex(null);
  }, [draft.models.length, pendingFocusModelIndex]);

  const group = getWorkspaceModelPlanTemplateGroup(draft.templateKind);
  const preset = getWorkspaceModelPlanTemplatePreset(draft.templateId);
  const apiKeyUrl = preset?.apiKeyUrl ?? null;
  const protocolLocked = preset?.protocolLocked ?? false;
  const availableDiscoveredModels = discoveredModels.filter(
    (candidate) => !draft.models.some((model) => model.id === candidate.id)
  );
  const editing = draft.planId !== null;

  const updateModels = (models: readonly WorkspaceModelPlanModel[]) => {
    onUpdate({ models });
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
                  defaultModel: nextPreset.models[0] ?? "",
                  models: toWorkspaceModelPlanPresetModels(nextPreset),
                  protocol: nextPreset.protocol,
                  templateId: nextPreset.id
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

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.modelPlans.detectionTitle")}
          </span>
          <Button
            className="h-auto px-0 text-[12px] font-medium text-[var(--text-primary)] hover:bg-transparent hover:text-[var(--text-primary)]"
            disabled={detecting}
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

      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.modelPlans.models")}
        </span>
        <div className="flex flex-col gap-1.5">
          {draft.models.map((model, index) => (
            <div
              // Index keys keep the input mounted (and focused) while the
              // model id is being typed.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_32px] items-center gap-1.5"
            >
              <input
                aria-label={t("workspace.settings.apps.modelPlans.modelId")}
                className={workspaceModelPlanInputClass}
                placeholder={t(
                  "workspace.settings.apps.modelPlans.modelIdPlaceholder"
                )}
                ref={(input) => {
                  if (input) {
                    modelInputRefs.current.set(index, input);
                    return;
                  }
                  modelInputRefs.current.delete(index);
                }}
                value={model.id}
                onChange={(event) => {
                  const id = event.currentTarget.value;
                  updateModels(
                    draft.models.map((row, rowIndex) =>
                      rowIndex === index
                        ? { ...row, id, name: id.trim() || row.name }
                        : row
                    )
                  );
                }}
              />
              <button
                aria-label={t("workspace.settings.apps.modelPlans.removeModel")}
                className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                type="button"
                onClick={() =>
                  updateModels(
                    draft.models.filter((_, rowIndex) => rowIndex !== index)
                  )
                }
              >
                <DeleteIcon aria-hidden="true" size={15} />
              </button>
            </div>
          ))}
        </div>
        {availableDiscoveredModels.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {t("workspace.settings.apps.modelPlans.discoveredModels")}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {availableDiscoveredModels.map((model) => (
                <button
                  key={model.id}
                  aria-label={t(
                    "workspace.settings.apps.modelPlans.addDiscoveredModel",
                    { model: model.id }
                  )}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--border-1)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                  type="button"
                  onClick={() => onAddDiscoveredModel(model.id)}
                >
                  <AddIcon aria-hidden="true" className="size-3" />
                  {model.id}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.modelPlans.defaultModelLabel")}
          </span>
          <Select
            disabled={
              draft.models.filter((model) => model.id.trim()).length === 0
            }
            value={
              draft.models.some((model) => model.id === draft.defaultModel)
                ? draft.defaultModel
                : ""
            }
            onValueChange={(value) => onUpdate({ defaultModel: value })}
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.apps.modelPlans.defaultModelLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue
                placeholder={t(
                  "workspace.settings.apps.modelPlans.defaultModelNone"
                )}
              />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {draft.models
                .filter((model) => model.id.trim())
                .map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <WorkspaceModelPlanFeedbackLine feedback={feedback} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          className="h-auto px-0 text-[12px] font-medium text-[var(--text-primary)] hover:bg-transparent hover:text-[var(--text-primary)]"
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => {
            const nextIndex = draft.models.length;
            setPendingFocusModelIndex(nextIndex);
            updateModels([...draft.models, { id: "", name: "" }]);
          }}
        >
          <AddIcon className="size-3.5" />
          {t("workspace.settings.apps.modelPlans.addModel")}
        </Button>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={saving} type="button" onClick={onSave}>
            {saving
              ? t("workspace.settings.apps.modelPlans.saving")
              : t("workspace.settings.apps.modelPlans.save")}
          </Button>
        </div>
      </div>
    </section>
  );
}
