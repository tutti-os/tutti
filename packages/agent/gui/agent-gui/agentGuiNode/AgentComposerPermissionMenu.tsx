import { useState } from "react";
import { ChevronDown, RotateCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
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
import { permissionModeSelectionPatch } from "./model/composerModeSelection";
import type { AgentComposerSettingsMenuLabels } from "./model/composerSettingsMenuModel";
import { ComposerOptionInfoTooltip } from "./AgentComposerModelOptionItems";
import styles from "./AgentGUINode.styles";

// Permission-mode dropdown plus the shared composer-options error affordance.
// Extracted from AgentComposerSettingsMenus.tsx to keep that file within the
// business file budget; behavior is unchanged.

/**
 * Terminal composer-options failure affordance: an enabled trigger-styled
 * button that surfaces the error copy and retries the load on click, instead
 * of the permanent disabled "loading" placeholder.
 */
export function ComposerOptionsErrorTrigger({
  ariaLabel,
  errorLabel,
  marker,
  previewMode,
  retryHint,
  onRetryOptions
}: {
  ariaLabel: string;
  errorLabel: string;
  marker: string;
  previewMode: boolean;
  retryHint: string;
  onRetryOptions?: (() => void) | undefined;
}): React.JSX.Element {
  const trigger = (
    <button
      type="button"
      className={cn("w-auto max-w-full", styles.composerMenuTrigger)}
      aria-label={ariaLabel}
      data-agent-composer-options-error={marker}
      onClick={previewMode ? undefined : onRetryOptions}
    >
      <span className="flex min-w-0 flex-1 items-center">
        <span className="truncate">{errorLabel}</span>
      </span>
      <RotateCw aria-hidden="true" className="shrink-0" size={14} />
    </button>
  );
  if (previewMode) {
    return trigger;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top">{retryHint}</TooltipContent>
    </Tooltip>
  );
}

export function AgentPermissionModeDropdown({
  composerSettings,
  disabled = false,
  previewMode = false,
  labels,
  onRetryOptions,
  onSettingsChange
}: {
  composerSettings: AgentGUIComposerSettingsVM;
  disabled?: boolean;
  previewMode?: boolean;
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    | "permissionLabel"
    | "loadingOptions"
    | "optionsLoadFailed"
    | "optionsLoadFailedRetry"
  >;
  onRetryOptions?: () => void;
  onSettingsChange: (patch: {
    permissionModeId?: string | null;
    planMode?: boolean;
  }) => void;
}): React.JSX.Element {
  "use memo";
  const [isSelectOpen, setIsSelectOpen] = useState(false);
  if (composerSettings.settingsLoadFailed === true) {
    return (
      <ComposerOptionsErrorTrigger
        ariaLabel={labels.permissionLabel}
        errorLabel={labels.optionsLoadFailed}
        marker="permission"
        previewMode={previewMode}
        retryHint={labels.optionsLoadFailedRetry}
        onRetryOptions={onRetryOptions}
      />
    );
  }
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
  const applyPermissionModeId = (permissionModeId: string): void => {
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
  const handleSelectedItemPointerDown = (
    event: React.PointerEvent,
    permissionModeId: string
  ): void => {
    if (selectDisabled || event.button !== 0 || event.ctrlKey) {
      return;
    }
    applyPermissionModeId(permissionModeId);
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
    <Select
      open={isSelectOpen}
      value={selectedValue ?? ""}
      disabled={selectDisabled}
      onOpenChange={setIsSelectOpen}
      onValueChange={applyPermissionModeId}
    >
      {/* Keep one trigger/ref composition for the Select lifetime. The trigger
          is disabled while loading, so the stable wrapper also provides the
          focusable tooltip target during that phase. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={isLoading ? 0 : undefined}>
            {selectTrigger}
          </span>
        </TooltipTrigger>
        {isLoading ? (
          <TooltipContent side="top">{labels.loadingOptions}</TooltipContent>
        ) : null}
      </Tooltip>
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
              onPointerDown={(event) =>
                handleSelectedItemPointerDown(event, option.value)
              }
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
