import { useEffect, useMemo } from "react";
import {
  WorkspaceUserProjectSelect,
  type WorkspaceUserProjectSelectChangeAction,
  type WorkspaceUserProjectSelectLabelOverrides
} from "@tutti-os/workspace-user-project/ui";
import { prepareWorkspaceUserProjectSelection } from "@tutti-os/workspace-user-project/core";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { useAgentHostApi } from "../../agentActivityHost";
import {
  NewWorkspaceLinedIcon,
  RoomsHintIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectSplitColumn,
  SelectSplitColumnItems,
  SelectSplitColumnLabel,
  SelectSplitDivider,
  SelectSplitLayout,
  SelectTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import type {
  AgentGUIComposerSettingOption,
  AgentGUIComposerSettingsVM
} from "./model/agentGuiNodeTypes";
import styles from "./AgentGUINode.styles";

export type AgentComposerSettingsMenuLabels = {
  modelLabel: string;
  modelSelectionLabel: string;
  defaultModel: string;
  inheritedUnavailable: string;
  loadingSettings: string;
  reasoningLabel: string;
  reasoningDegreeLabel: string;
  reasoningOptionMinimal: string;
  reasoningOptionLow: string;
  reasoningOptionMedium: string;
  reasoningOptionHigh: string;
  reasoningOptionXHigh: string;
  permissionLabel: string;
  permissionModeReadOnly?: string;
  permissionModeAuto?: string;
  permissionModeFullAccess?: string;
  modelDescriptions: {
    frontierComplexCoding: string;
    everydayCoding: string;
    smallFastCostEfficient: string;
    codingOptimized: string;
    ultraFastCoding: string;
    professionalLongRunning: string;
  };
};

export type AgentProjectDropdownLabels = Pick<
  WorkspaceUserProjectSelectLabelOverrides,
  "projectLocked"
> & {
  projectMissingDescription: string;
};

export interface AgentProjectPathChangeMetadata {
  action: WorkspaceUserProjectSelectChangeAction;
}

export function AgentProjectDropdown({
  composerSettings,
  labels,
  i18n,
  onProjectMissingChange,
  onProjectPathChange
}: {
  composerSettings: Pick<
    AgentGUIComposerSettingsVM,
    "selectedProjectPath" | "projectLocked"
  >;
  i18n: WorkspaceUserProjectI18nRuntime;
  labels: AgentProjectDropdownLabels;
  onProjectMissingChange?: (isMissing: boolean) => void;
  onProjectPathChange: (
    path: string | null,
    metadata?: AgentProjectPathChangeMetadata
  ) => void;
}): React.JSX.Element {
  "use memo";
  const agentHostApi = useAgentHostApi();
  const userProjectApi = useMemo(
    () =>
      agentHostApi.userProjects
        ? {
            ...agentHostApi.userProjects,
            selectDirectory: agentHostApi.workspace.selectDirectory
          }
        : null,
    [agentHostApi.userProjects, agentHostApi.workspace.selectDirectory]
  );

  return (
    <WorkspaceUserProjectSelect
      api={userProjectApi}
      classNames={{
        content: cn(
          styles.composerMenuContent,
          "w-[240px] min-w-[240px] data-[side=top]:!translate-y-0"
        ),
        item: styles.composerMenuItem,
        trigger: cn(
          "w-auto max-w-full",
          styles.composerMenuTrigger,
          "text-[var(--agent-gui-text-tertiary)]",
          "disabled:cursor-not-allowed disabled:text-[var(--agent-gui-text-tertiary)] disabled:opacity-60 disabled:hover:text-[var(--agent-gui-text-tertiary)]"
        )
      }}
      i18n={i18n}
      labels={labels}
      projectLocked={Boolean(composerSettings.projectLocked)}
      renderAddProjectIcon={() => (
        <NewWorkspaceLinedIcon
          aria-hidden
          data-workspace-user-project-add-icon="true"
          size={15}
        />
      )}
      selectedProjectPath={composerSettings.selectedProjectPath}
      service={agentHostApi.userProjects?.service ?? null}
      showCreateProjectAction
      onProjectMissingChange={onProjectMissingChange}
      onProjectPathChange={onProjectPathChange}
    />
  );
}

export function AgentPermissionModeDropdown({
  composerSettings,
  disabled = false,
  labels,
  onSettingsChange
}: {
  composerSettings: AgentGUIComposerSettingsVM;
  disabled?: boolean;
  labels: Pick<AgentComposerSettingsMenuLabels, "permissionLabel">;
  onSettingsChange: (patch: { permissionModeId?: string | null }) => void;
}): React.JSX.Element {
  "use memo";
  const availableOptions = composerSettings.availablePermissionModes ?? [];
  const selectedValue =
    composerSettings.selectedPermissionModeValue ??
    composerSettings.draftSettings.permissionModeId;
  const permissionOptions = permissionOptionsWithSelectedValue(
    availableOptions,
    selectedValue
  );
  const selectDisabled =
    disabled ||
    composerSettings.isSettingsLoading ||
    composerSettings.permissionModeUnavailable ||
    permissionOptions.length === 0;
  const selectedOption =
    permissionOptions.find((option) => option.value === selectedValue) ?? null;
  const triggerLabel =
    selectedOption?.label ?? selectedValue?.trim() ?? labels.permissionLabel;
  const triggerTone = selectDisabled
    ? undefined
    : resolvePermissionModeTriggerTone(selectedValue);
  const applyPermissionModeId = (permissionModeId: string): void => {
    if (selectDisabled) {
      return;
    }
    onSettingsChange({ permissionModeId });
  };
  const handleSelectedItemPointerDown = (
    event: React.PointerEvent,
    permissionModeId: string
  ): void => {
    if (selectDisabled || event.button !== 0 || event.ctrlKey) {
      return;
    }
    applyPermissionModeId(permissionModeId);
  };

  return (
    <Select
      value={selectedValue ?? undefined}
      disabled={selectDisabled}
      onValueChange={applyPermissionModeId}
    >
      <SelectTrigger
        className={cn(
          "w-auto max-w-full",
          styles.composerMenuTrigger,
          selectDisabled &&
            "cursor-not-allowed text-[var(--agent-gui-text-tertiary)] opacity-60 hover:text-[var(--agent-gui-text-tertiary)]",
          composerSettings.isSettingsLoading && "animate-pulse"
        )}
        aria-label={labels.permissionLabel}
        data-permission-tone={triggerTone}
      >
        <span className="flex min-w-0 flex-1 items-center">
          <span className="truncate">{triggerLabel}</span>
        </span>
      </SelectTrigger>
      <SelectContent
        align="end"
        side="top"
        sideOffset={4}
        collisionPadding={16}
        className={cn(
          styles.composerMenuContent,
          "w-max min-w-[220px] max-w-[calc(100vw-32px)] data-[side=top]:!translate-y-0"
        )}
      >
        {permissionOptions.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={selectDisabled}
            className={cn(styles.composerMenuItem, "group/permission-option")}
            onPointerDown={(event) =>
              handleSelectedItemPointerDown(event, option.value)
            }
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">{option.label}</span>
              {option.description ? (
                <PermissionModeOptionInfo description={option.description} />
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function permissionOptionsWithSelectedValue(
  options: readonly AgentGUIComposerSettingOption[],
  selectedValue: string | null | undefined
): AgentGUIComposerSettingOption[] {
  const normalizedSelectedValue = selectedValue?.trim() ?? "";
  const clonedOptions = options.map((option) => ({ ...option }));
  if (
    !normalizedSelectedValue ||
    clonedOptions.some((option) => option.value === normalizedSelectedValue)
  ) {
    return clonedOptions;
  }
  return [
    ...clonedOptions,
    {
      value: normalizedSelectedValue,
      label: normalizedSelectedValue
    }
  ];
}

export function AgentProjectMissingStatusProbe({
  composerSettings,
  onProjectMissingChange
}: {
  composerSettings: Pick<
    AgentGUIComposerSettingsVM,
    "selectedProjectPath" | "projectLocked"
  >;
  onProjectMissingChange: (isMissing: boolean) => void;
}): null {
  "use memo";
  const agentHostApi = useAgentHostApi();
  const selectedPath = composerSettings.selectedProjectPath?.trim() ?? "";

  useEffect(() => {
    let canceled = false;
    const userProjects = agentHostApi.userProjects;
    if (!userProjects || !composerSettings.projectLocked || !selectedPath) {
      onProjectMissingChange(false);
      return () => {
        canceled = true;
      };
    }
    void prepareWorkspaceUserProjectSelection(userProjects, {
      projectLocked: true,
      selectedPath
    }).then(
      (prepared) => {
        if (!canceled) {
          onProjectMissingChange(prepared.isSelectedPathMissing);
        }
      },
      () => {
        if (!canceled) {
          onProjectMissingChange(false);
        }
      }
    );
    return () => {
      canceled = true;
    };
  }, [
    agentHostApi.userProjects,
    composerSettings.projectLocked,
    onProjectMissingChange,
    selectedPath
  ]);

  return null;
}

function PermissionModeOptionInfo({
  description
}: {
  description: string;
}): React.JSX.Element {
  const stopSelect = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 cursor-help text-[var(--agent-gui-text-tertiary)] opacity-0 transition-opacity group-hover/permission-option:opacity-100 group-hover/permission-option:pointer-events-auto group-data-[highlighted]/permission-option:opacity-100 group-data-[highlighted]/permission-option:pointer-events-auto pointer-events-none"
          data-agent-permission-info-trigger="true"
          onClick={stopSelect}
          onPointerDown={stopSelect}
        >
          <RoomsHintIcon aria-hidden className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[240px] whitespace-normal">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

function resolveSelectedModelLabel(
  composerSettings: AgentGUIComposerSettingsVM,
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    "defaultModel" | "inheritedUnavailable" | "loadingSettings"
  >
): string {
  const selectedValue = selectedComposerModelValue(composerSettings);
  const selected = modelOptionsWithSelectedValue(composerSettings).find(
    (option) => option.value === selectedValue
  );
  if (selected) {
    return formatModelDisplayLabel(selected.label);
  }
  if (composerSettings.modelUnavailable) {
    return labels.inheritedUnavailable;
  }
  if (composerSettings.isSettingsLoading) {
    return labels.loadingSettings;
  }
  const firstAvailableModel = composerSettings.availableModels[0]?.label;
  if (firstAvailableModel) {
    return formatModelDisplayLabel(firstAvailableModel);
  }
  return labels.defaultModel;
}

function resolveSelectedReasoningLabel(
  composerSettings: AgentGUIComposerSettingsVM,
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    | "reasoningLabel"
    | "inheritedUnavailable"
    | "loadingSettings"
    | "reasoningOptionMinimal"
    | "reasoningOptionLow"
    | "reasoningOptionMedium"
    | "reasoningOptionHigh"
    | "reasoningOptionXHigh"
  >
): string {
  const selectedValue = selectedComposerReasoningValue(composerSettings);
  const selected = reasoningOptionsWithSelectedValue(composerSettings).find(
    (option) => option.value === selectedValue
  );
  if (selected) {
    switch (selected.value) {
      case "minimal":
        return labels.reasoningOptionMinimal;
      case "low":
        return labels.reasoningOptionLow;
      case "medium":
        return labels.reasoningOptionMedium;
      case "high":
        return labels.reasoningOptionHigh;
      case "xhigh":
        return labels.reasoningOptionXHigh;
      default:
        return selected.label;
    }
  }
  if (composerSettings.reasoningUnavailable) {
    return labels.inheritedUnavailable;
  }
  if (composerSettings.isSettingsLoading) {
    return "";
  }
  if (composerSettings.availableReasoningEfforts.length === 0) {
    return "";
  }
  return labels.reasoningLabel;
}

function selectedComposerModelValue(
  composerSettings: AgentGUIComposerSettingsVM
): string | null {
  return (
    composerSettings.selectedModelValue ??
    composerSettings.draftSettings.model ??
    null
  );
}

function selectedComposerReasoningValue(
  composerSettings: AgentGUIComposerSettingsVM
): string | null {
  return (
    composerSettings.selectedReasoningEffortValue ??
    composerSettings.draftSettings.reasoningEffort ??
    null
  );
}

function modelOptionsWithSelectedValue(
  composerSettings: AgentGUIComposerSettingsVM
): AgentGUIComposerSettingsVM["availableModels"] {
  const selectedValue = selectedComposerModelValue(composerSettings);
  if (
    !selectedValue ||
    composerSettings.availableModels.some(
      (option) => option.value === selectedValue
    )
  ) {
    return composerSettings.availableModels;
  }
  return [
    { value: selectedValue, label: selectedValue },
    ...composerSettings.availableModels
  ];
}

function reasoningOptionsWithSelectedValue(
  composerSettings: AgentGUIComposerSettingsVM
): AgentGUIComposerSettingsVM["availableReasoningEfforts"] {
  const selectedValue = selectedComposerReasoningValue(composerSettings);
  if (
    !selectedValue ||
    composerSettings.availableReasoningEfforts.some(
      (option) => option.value === selectedValue
    )
  ) {
    return composerSettings.availableReasoningEfforts;
  }
  return [
    { value: selectedValue, label: selectedValue },
    ...composerSettings.availableReasoningEfforts
  ];
}

function resolveReasoningOptionLabel(
  value: string,
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    | "reasoningOptionMinimal"
    | "reasoningOptionLow"
    | "reasoningOptionMedium"
    | "reasoningOptionHigh"
    | "reasoningOptionXHigh"
  >
): string {
  switch (value) {
    case "minimal":
      return labels.reasoningOptionMinimal;
    case "low":
      return labels.reasoningOptionLow;
    case "medium":
      return labels.reasoningOptionMedium;
    case "high":
      return labels.reasoningOptionHigh;
    case "xhigh":
      return labels.reasoningOptionXHigh;
    default:
      return value;
  }
}

function formatModelDisplayLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return label;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function resolvePermissionModeTriggerTone(
  value: string | null | undefined
): string | undefined {
  switch (normalizePermissionModeValue(value)) {
    case "read-only":
    case "readonly":
    case "ask-for-approval":
      return "success";
    case "auto":
    case "default":
    case "accept-edits":
    case "acceptedits":
      return "accent";
    case "full-access":
    case "bypasspermissions":
      return "warning";
    default:
      return undefined;
  }
}

function normalizePermissionModeValue(
  value: string | null | undefined
): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, "-");
  return normalized || undefined;
}

function resolveModelDescription(
  description: string | undefined,
  labels: Pick<AgentComposerSettingsMenuLabels, "modelDescriptions">
): string | undefined {
  switch (description) {
    case "Frontier model for complex coding, research, and real-world work.":
      return labels.modelDescriptions.frontierComplexCoding;
    case "Strong model for everyday coding.":
      return labels.modelDescriptions.everydayCoding;
    case "Small, fast, and cost-efficient model for simpler coding tasks.":
      return labels.modelDescriptions.smallFastCostEfficient;
    case "Coding-optimized model.":
      return labels.modelDescriptions.codingOptimized;
    case "Ultra-fast coding model.":
      return labels.modelDescriptions.ultraFastCoding;
    case "Optimized for professional work and long-running agents.":
      return labels.modelDescriptions.professionalLongRunning;
    default:
      return description;
  }
}

export function AgentModelReasoningDropdown({
  composerSettings,
  disabled = false,
  labels,
  onSettingsChange
}: {
  composerSettings: AgentGUIComposerSettingsVM;
  disabled?: boolean;
  labels: AgentComposerSettingsMenuLabels;
  onSettingsChange: (patch: {
    model?: string;
    reasoningEffort?: string;
  }) => void;
}): React.JSX.Element {
  "use memo";
  const selectedModelLabel = resolveSelectedModelLabel(
    composerSettings,
    labels
  );
  const selectedReasoningLabel = resolveSelectedReasoningLabel(
    composerSettings,
    labels
  );
  const triggerLabel =
    selectedModelLabel === selectedReasoningLabel
      ? selectedModelLabel
      : `${selectedModelLabel} ${selectedReasoningLabel}`.trim();
  const modelItems = modelOptionsWithSelectedValue(composerSettings);
  const reasoningItems = reasoningOptionsWithSelectedValue(composerSettings);
  const triggerDisabled =
    disabled ||
    composerSettings.isSettingsLoading ||
    (!composerSettings.supportsModel &&
      !composerSettings.supportsReasoningEffort);
  const showReasoningSection =
    composerSettings.supportsReasoningEffort &&
    reasoningItems.length > 0 &&
    !composerSettings.reasoningUnavailable;
  const showModelSection =
    composerSettings.supportsModel &&
    modelItems.length > 0 &&
    !composerSettings.modelUnavailable;
  const selectedReasoningValue =
    selectedComposerReasoningValue(composerSettings) ?? "";
  const selectedModelValue = selectedComposerModelValue(composerSettings) ?? "";
  const selectDisabled =
    triggerDisabled || (!showModelSection && !showReasoningSection);
  const selectedModelSelectValue = selectedModelValue
    ? `model:${selectedModelValue}`
    : "";
  const selectedReasoningSelectValue = selectedReasoningValue
    ? `reasoning:${selectedReasoningValue}`
    : "";
  const selectValue = showModelSection
    ? selectedModelSelectValue
    : selectedReasoningSelectValue;
  const applySettingsValue = (nextValue: string): void => {
    if (selectDisabled) {
      return;
    }
    if (nextValue.startsWith("reasoning:")) {
      onSettingsChange({
        reasoningEffort: nextValue.slice("reasoning:".length)
      });
      return;
    }
    if (nextValue.startsWith("model:")) {
      onSettingsChange({ model: nextValue.slice("model:".length) });
    }
  };
  const handleSelectedItemPointerDown = (
    event: React.PointerEvent,
    optionValue: string
  ): void => {
    if (selectDisabled || event.button !== 0 || event.ctrlKey) {
      return;
    }
    applySettingsValue(optionValue);
  };

  return (
    <Select
      value={selectValue}
      disabled={selectDisabled}
      onValueChange={applySettingsValue}
    >
      <SelectTrigger
        className={cn(
          "w-auto",
          styles.composerMenuTrigger,
          selectDisabled &&
            "cursor-not-allowed text-[var(--agent-gui-text-tertiary)] opacity-60 hover:text-[var(--agent-gui-text-tertiary)]",
          composerSettings.isSettingsLoading && "animate-pulse"
        )}
        aria-label={`${labels.modelLabel} / ${labels.reasoningLabel}`}
        data-agent-model-reasoning-trigger="true"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {selectedModelLabel === selectedReasoningLabel ||
          selectedReasoningLabel.length === 0 ? (
            <span className="min-w-0 truncate">{triggerLabel}</span>
          ) : (
            <>
              <span className="min-w-0 truncate">{selectedModelLabel}</span>
              <span className="shrink-0">{selectedReasoningLabel}</span>
            </>
          )}
        </span>
      </SelectTrigger>
      <SelectContent
        align="end"
        side="top"
        sideOffset={4}
        collisionPadding={16}
        className={cn(
          styles.composerMenuContent,
          "data-[side=top]:!translate-y-0",
          showReasoningSection && showModelSection
            ? "w-[430px] max-w-[calc(100vw-32px)]"
            : "w-max min-w-[240px] max-w-[calc(100vw-32px)]"
        )}
      >
        {showReasoningSection && showModelSection ? (
          <SelectSplitLayout data-agent-composer-settings-layout="split">
            <SelectSplitColumn>
              <SelectSplitColumnLabel>
                {labels.modelSelectionLabel}
              </SelectSplitColumnLabel>
              <SelectSplitColumnItems>
                <ComposerSettingsModelItems
                  disabled={selectDisabled}
                  labels={labels}
                  models={modelItems}
                  onSelectedItemPointerDown={handleSelectedItemPointerDown}
                />
              </SelectSplitColumnItems>
            </SelectSplitColumn>
            <SelectSplitDivider />
            <SelectSplitColumn>
              <SelectSplitColumnLabel>
                {labels.reasoningDegreeLabel}
              </SelectSplitColumnLabel>
              <SelectSplitColumnItems>
                <ComposerSettingsReasoningItems
                  composerSettings={composerSettings}
                  disabled={selectDisabled}
                  labels={labels}
                  reasoningEfforts={reasoningItems}
                  showManualSelectedIndicator={true}
                  onSelectedItemPointerDown={handleSelectedItemPointerDown}
                />
              </SelectSplitColumnItems>
            </SelectSplitColumn>
          </SelectSplitLayout>
        ) : (
          <>
            {showModelSection ? (
              <>
                <div className={styles.composerMenuLabel}>
                  {labels.modelSelectionLabel}
                </div>
                <ComposerSettingsModelItems
                  disabled={selectDisabled}
                  labels={labels}
                  models={modelItems}
                  onSelectedItemPointerDown={handleSelectedItemPointerDown}
                />
              </>
            ) : null}
            {showReasoningSection ? (
              <>
                <div className={styles.composerMenuLabel}>
                  {labels.reasoningDegreeLabel}
                </div>
                <ComposerSettingsReasoningItems
                  composerSettings={composerSettings}
                  disabled={selectDisabled}
                  labels={labels}
                  reasoningEfforts={reasoningItems}
                  showManualSelectedIndicator={false}
                  onSelectedItemPointerDown={handleSelectedItemPointerDown}
                />
              </>
            ) : null}
          </>
        )}
      </SelectContent>
    </Select>
  );
}

function ComposerSettingsModelItems({
  disabled,
  labels,
  models,
  onSelectedItemPointerDown
}: {
  disabled: boolean;
  labels: AgentComposerSettingsMenuLabels;
  models: AgentGUIComposerSettingsVM["availableModels"];
  onSelectedItemPointerDown: (
    event: React.PointerEvent,
    optionValue: string
  ) => void;
}): React.JSX.Element {
  return (
    <>
      {models.map((model) => {
        const optionValue = `model:${model.value}`;
        return (
          <SelectItem
            key={model.value}
            value={optionValue}
            disabled={disabled}
            className={styles.composerMenuItem}
            onPointerDown={(event) =>
              onSelectedItemPointerDown(event, optionValue)
            }
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="min-w-0 truncate">
                {formatModelDisplayLabel(model.label)}
              </span>
              {model.description ? (
                <span className="whitespace-normal text-[11px] leading-[1.3] text-[var(--text-tertiary)]">
                  {resolveModelDescription(model.description, labels)}
                </span>
              ) : null}
            </span>
          </SelectItem>
        );
      })}
    </>
  );
}

function ComposerSettingsReasoningItems({
  composerSettings,
  disabled,
  labels,
  reasoningEfforts,
  showManualSelectedIndicator,
  onSelectedItemPointerDown
}: {
  composerSettings: AgentGUIComposerSettingsVM;
  disabled: boolean;
  labels: AgentComposerSettingsMenuLabels;
  reasoningEfforts: AgentGUIComposerSettingsVM["availableReasoningEfforts"];
  showManualSelectedIndicator: boolean;
  onSelectedItemPointerDown: (
    event: React.PointerEvent,
    optionValue: string
  ) => void;
}): React.JSX.Element {
  const selectedReasoningValue =
    composerSettings.selectedReasoningEffortValue ??
    composerSettings.draftSettings.reasoningEffort ??
    "";
  return (
    <>
      {reasoningEfforts.map((option) => {
        const optionValue = `reasoning:${option.value}`;
        const isSelected = selectedReasoningValue === option.value;
        return (
          <SelectItem
            key={option.value}
            value={optionValue}
            disabled={disabled}
            className={styles.composerMenuItem}
            forceSelectedIndicator={showManualSelectedIndicator && isSelected}
            onPointerDown={(event) =>
              onSelectedItemPointerDown(event, optionValue)
            }
          >
            <span className="min-w-0 truncate">
              {resolveReasoningOptionLabel(option.value, labels)}
            </span>
          </SelectItem>
        );
      })}
    </>
  );
}
