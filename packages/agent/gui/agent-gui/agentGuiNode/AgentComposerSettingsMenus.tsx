import { Fragment, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { prepareWorkspaceUserProjectSelection } from "@tutti-os/workspace-user-project/core";
import { useAgentHostApi } from "../../agentActivityHost";
import {
  RoomsHintIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import type {
  AgentGUIComposerSettingOption,
  AgentGUIComposerSettingsVM
} from "./model/agentGuiNodeTypes";
import type { WorkspaceLinkAction } from "../../actions/workspaceLinkActions";
import { AgentFullAccessWarningDialog } from "./AgentFullAccessWarningDialog";
import {
  normalizePermissionModeSelection,
  permissionModeSelectionPatch
} from "./model/composerModeSelection";
import { requiresFullAccessSafetyConfirmation } from "./model/agentPermissionModeSafetyPolicy";
import { acknowledgeCodexFullAccessWarning } from "./view/agentFullAccessWarningPreference";
import type { AgentComposerSettingsMenuLabels } from "./model/composerSettingsMenuModel";
import styles from "./AgentGUINode.styles";

export type { AgentComposerSettingsMenuLabels } from "./model/composerSettingsMenuModel";

export {
  AgentProjectDropdown,
  type AgentProjectDropdownLabels,
  type AgentProjectPathChangeMetadata
} from "./AgentComposerProjectMenu";
export { AgentModelReasoningDropdown } from "./AgentComposerModelReasoningDropdown";
import { ComposerOptionInfoTooltip } from "./AgentComposerModelReasoningDropdown";
export function AgentPermissionModeDropdown({
  composerSettings,
  disabled = false,
  disabledTooltip,
  onLinkAction,
  previewMode = false,
  provider,
  labels,
  onSettingsChange
}: {
  composerSettings: AgentGUIComposerSettingsVM;
  disabled?: boolean;
  disabledTooltip?: string;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  previewMode?: boolean;
  provider: string;
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    "permissionLabel" | "loadingOptions"
  >;
  onSettingsChange: (patch: {
    permissionModeId?: string | null;
    planMode?: boolean;
  }) => void;
}): React.JSX.Element {
  "use memo";
  const [isSelectOpen, setIsSelectOpen] = useState(false);
  const [pendingFullAccessModeId, setPendingFullAccessModeId] = useState<
    string | null
  >(null);
  // While the daemon's composer options load, the permission options are empty
  // and the trigger is disabled; surface a hover hint so the user knows it is
  // still loading rather than permanently unavailable.
  const isLoading = composerSettings.isSettingsLoading;
  const availableOptions = composerSettings.availablePermissionModes ?? [];
  const selectedValue =
    composerSettings.selectedPermissionModeValue ??
    composerSettings.draftSettings.permissionModeId;
  // Plan mode is no longer a dropdown option — it is an independent toggle
  // (Shift+Tab / plan badge). The dropdown lists only real permission modes.
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
  // While loading, the permission options are empty and `selectedValue` is a
  // raw mode id (e.g. "full-access"); show the loading copy instead so the
  // trigger never surfaces an untranslated enum value.
  const triggerLabel = isLoading
    ? labels.loadingOptions
    : (selectedOption?.label ??
      selectedValue?.trim() ??
      labels.permissionLabel);
  const triggerTone = selectDisabled
    ? undefined
    : resolvePermissionModeTriggerTone(selectedValue);
  const selectDisabledTooltip = disabled
    ? disabledTooltip
    : isLoading
      ? labels.loadingOptions
      : undefined;
  const commitPermissionModeId = (permissionModeId: string): void => {
    if (selectDisabled) {
      return;
    }
    onSettingsChange(
      permissionModeSelectionPatch(permissionModeId, {
        clearsPlanMode:
          composerSettings.planExclusiveWithPermissionMode === true
      })
    );
  };
  const applyPermissionModeId = (rawPermissionModeId: string): void => {
    const permissionModeId =
      normalizePermissionModeSelection(rawPermissionModeId);
    if (!permissionModeId) {
      return;
    }
    if (requiresFullAccessSafetyConfirmation(provider, permissionModeId)) {
      setIsSelectOpen(false);
      setPendingFullAccessModeId(permissionModeId);
      return;
    }
    commitPermissionModeId(permissionModeId);
  };
  const trigger = (
    <button
      type="button"
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
      <ChevronDown aria-hidden="true" className="shrink-0" size={16} />
    </button>
  );

  if (previewMode) {
    return trigger;
  }

  const selectTrigger = (
    <SelectTrigger
      className={cn(
        "w-auto max-w-full",
        styles.composerMenuTrigger,
        selectDisabled &&
          "cursor-not-allowed text-[var(--agent-gui-text-tertiary)] opacity-60 hover:text-[var(--agent-gui-text-tertiary)]",
        isLoading && "animate-pulse"
      )}
      aria-label={labels.permissionLabel}
      data-permission-tone={triggerTone}
    >
      <span className="flex min-w-0 flex-1 items-center">
        <span className="truncate">{triggerLabel}</span>
      </span>
    </SelectTrigger>
  );

  return (
    <Fragment>
      <Select
        open={isSelectOpen}
        value={selectedValue ?? undefined}
        disabled={selectDisabled}
        onOpenChange={setIsSelectOpen}
        onValueChange={applyPermissionModeId}
      >
        {selectDisabledTooltip ? (
          // Disabled controls do not receive pointer events. Target the tooltip
          // at a focusable wrapper span so hover/focus reliably surfaces the
          // reason, both during loading and while a turn is active.
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex" tabIndex={0}>
                  {selectTrigger}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {selectDisabledTooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          selectTrigger
        )}
        {isSelectOpen ? (
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
                className={cn(styles.composerMenuItem, "group/composer-option")}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.description ? (
                    <ComposerOptionInfoTooltip
                      description={option.description}
                      tooltipsEnabled={!previewMode}
                    />
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        ) : null}
      </Select>
      <AgentFullAccessWarningDialog
        onConfirm={() => {
          if (!pendingFullAccessModeId) {
            return;
          }
          const permissionModeId = pendingFullAccessModeId;
          setPendingFullAccessModeId(null);
          acknowledgeCodexFullAccessWarning();
          commitPermissionModeId(permissionModeId);
        }}
        onLinkAction={onLinkAction}
        onOpenChange={(open) => {
          if (!open) {
            setPendingFullAccessModeId(null);
          }
        }}
        open={pendingFullAccessModeId !== null}
      />
    </Fragment>
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

export function ComposerOptionInfoTooltip({
  description,
  tooltipsEnabled = true
}: {
  description: string;
  tooltipsEnabled?: boolean;
}): React.JSX.Element {
  const stopSelect = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  const trigger = (
    <span
      className="pointer-events-none inline-flex shrink-0 cursor-help text-[var(--agent-gui-text-tertiary)] opacity-0 transition-opacity group-hover/composer-option:pointer-events-auto group-hover/composer-option:opacity-100 group-data-[highlighted]/composer-option:pointer-events-auto group-data-[highlighted]/composer-option:opacity-100"
      data-agent-composer-option-info-trigger="true"
      onClick={stopSelect}
      onPointerDown={stopSelect}
    >
      <RoomsHintIcon aria-hidden className="size-3" />
    </span>
  );

  if (!tooltipsEnabled) {
    return trigger;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-[240px] whitespace-normal">
        {description}
      </TooltipContent>
    </Tooltip>
  );
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
