import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  WorkspaceUserProjectSelect,
  type WorkspaceUserProjectSelectChangeAction,
  type WorkspaceUserProjectSelectLabelOverrides
} from "@tutti-os/workspace-user-project/ui";
import { prepareWorkspaceUserProjectSelection } from "@tutti-os/workspace-user-project/core";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { useAgentHostApi } from "../../agentActivityHost";
import {
  CheckIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  NewWorkspaceLinedIcon,
  RoomsHintIcon,
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
import {
  composerModeOptions,
  composerModeSelectedValue,
  composerModeSelectionPatch
} from "./model/composerModeCycle";
import {
  buildComposerModelMenuModel,
  type AgentComposerSettingsMenuLabels,
  type ComposerMenuOption
} from "./model/composerSettingsMenuModel";
import styles from "./AgentGUINode.styles";

export type { AgentComposerSettingsMenuLabels } from "./model/composerSettingsMenuModel";

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
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    "permissionLabel" | "planModeLabel"
  >;
  onSettingsChange: (patch: {
    permissionModeId?: string | null;
    planMode?: boolean;
  }) => void;
}): React.JSX.Element {
  "use memo";
  const [isSelectOpen, setIsSelectOpen] = useState(false);
  const availableOptions = composerSettings.availablePermissionModes ?? [];
  const planModeActive = Boolean(
    composerSettings.supportsPlanMode &&
    (composerSettings.effectivePlanMode ??
      composerSettings.draftSettings.planMode)
  );
  const selectedPermissionValue =
    composerSettings.selectedPermissionModeValue ??
    composerSettings.draftSettings.permissionModeId;
  const selectedValue = composerModeSelectedValue({
    planModeActive,
    selectedPermissionModeValue: selectedPermissionValue
  });
  // Plan mode rides the permission dropdown (Zed-style); the option list and
  // selection mapping are shared with the Shift+Tab cycle.
  const optionsWithPlan = composerModeOptions({
    availablePermissionModes: permissionOptionsWithSelectedValue(
      availableOptions,
      selectedPermissionValue
    ),
    supportsPlanMode: composerSettings.supportsPlanMode,
    planModeLabel: labels.planModeLabel
  });
  const selectDisabled =
    disabled ||
    composerSettings.isSettingsLoading ||
    composerSettings.permissionModeUnavailable ||
    optionsWithPlan.length === 0;
  const selectedOption =
    optionsWithPlan.find((option) => option.value === selectedValue) ?? null;
  const triggerLabel =
    selectedOption?.label ?? selectedValue?.trim() ?? labels.permissionLabel;
  const triggerTone = selectDisabled
    ? undefined
    : resolvePermissionModeTriggerTone(selectedValue);
  const applyPermissionModeId = (permissionModeId: string): void => {
    if (selectDisabled) {
      return;
    }
    onSettingsChange(
      composerModeSelectionPatch(permissionModeId, planModeActive)
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

  return (
    <Select
      open={isSelectOpen}
      value={selectedValue ?? undefined}
      disabled={selectDisabled}
      onOpenChange={setIsSelectOpen}
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
          {optionsWithPlan.map((option) => (
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
    speed?: string;
  }) => void;
}): React.JSX.Element {
  "use memo";
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = buildComposerModelMenuModel(composerSettings, labels);
  const menuDisabled = disabled || menu.disabled;
  const applySettingsChange = (patch: {
    model?: string;
    reasoningEffort?: string;
    speed?: string;
  }): void => {
    onSettingsChange(patch);
    setMenuOpen(false);
  };

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild disabled={menuDisabled}>
        <button
          type="button"
          className={cn(
            "w-auto",
            styles.composerMenuTrigger,
            menuDisabled &&
              "cursor-not-allowed text-[var(--agent-gui-text-tertiary)] opacity-60 hover:text-[var(--agent-gui-text-tertiary)]",
            composerSettings.isSettingsLoading && "animate-pulse"
          )}
          aria-label={`${labels.modelLabel} / ${labels.reasoningLabel}`}
          data-agent-model-reasoning-trigger="true"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            {menu.speed.show && menu.trigger.isFast ? (
              <span
                aria-hidden
                className="shrink-0"
                data-agent-speed-indicator="fast"
              >
                ⚡
              </span>
            ) : null}
            {menu.trigger.showCombined ? (
              <span className="min-w-0 truncate">
                {menu.trigger.combinedLabel}
              </span>
            ) : (
              <>
                <span className="min-w-0 truncate">
                  {menu.trigger.modelLabel}
                </span>
                <span className="shrink-0">{menu.trigger.reasoningLabel}</span>
              </>
            )}
          </span>
          <ChevronDown aria-hidden="true" className="shrink-0" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={4}
        collisionPadding={16}
        className={cn(
          styles.composerMenuContent,
          "w-max min-w-[240px] max-w-[calc(100vw-32px)] data-[side=top]:!translate-y-0"
        )}
        data-agent-composer-settings-layout="model-primary"
      >
        {menu.model.show ? (
          <>
            <DropdownMenuLabel>{labels.modelSelectionLabel}</DropdownMenuLabel>
            <ComposerMenuOptionItems
              options={menu.model.options}
              selectedValue={menu.model.selectedValue}
              withDescription
              onSelect={(value) => applySettingsChange({ model: value })}
            />
          </>
        ) : null}
        {menu.model.show && (menu.reasoning.show || menu.speed.show) ? (
          <DropdownMenuSeparator />
        ) : null}
        {menu.reasoning.show ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className={cn(styles.composerMenuItem, "[&>svg]:!ml-0.5")}
              data-agent-reasoning-submenu-trigger="true"
            >
              <span className="min-w-0 flex-1 truncate">
                {labels.reasoningLabel}
              </span>
              <span className="text-[var(--text-tertiary)]">
                {menu.reasoning.selectedLabel}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className={cn(styles.composerMenuContent, "min-w-[132px]")}
              data-agent-composer-settings-layout="model-submenu"
            >
              <ComposerMenuOptionItems
                options={menu.reasoning.options}
                selectedValue={menu.reasoning.selectedValue}
                onSelect={(value) =>
                  applySettingsChange({ reasoningEffort: value })
                }
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {menu.speed.show ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className={cn(styles.composerMenuItem, "[&>svg]:!ml-0.5")}
              data-agent-speed-submenu-trigger="true"
            >
              <span className="min-w-0 flex-1 truncate">
                {labels.speedLabel}
              </span>
              <span className="text-[var(--text-tertiary)]">
                {menu.speed.selectedLabel}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className={cn(styles.composerMenuContent, "w-[200px]")}
              data-agent-composer-settings-layout="model-submenu"
            >
              <ComposerMenuOptionItems
                options={menu.speed.options}
                selectedValue={menu.speed.selectedValue}
                withDescription
                onSelect={(value) => applySettingsChange({ speed: value })}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Renders a list of pick-to-apply menu items. Pointer activation applies
// directly because runtime evidence showed submenu items can receive
// pointerdown while Radix onSelect never fires in this embedded menu. onSelect
// remains for keyboard activation and normal Radix paths.
function ComposerMenuOptionItems({
  options,
  selectedValue,
  withDescription = false,
  onSelect
}: {
  options: ComposerMenuOption[];
  selectedValue: string;
  withDescription?: boolean;
  onSelect: (value: string) => void;
}): React.JSX.Element {
  return (
    <>
      {options.map((option) => (
        <DropdownMenuItem
          key={option.value}
          className={cn(
            styles.composerMenuItem,
            withDescription && option.description && "items-start"
          )}
          onPointerDown={(event) => {
            if (event.button === 0 && !event.ctrlKey) {
              event.preventDefault();
              onSelect(option.value);
            }
          }}
          onSelect={() => {
            onSelect(option.value);
          }}
        >
          <span
            className={cn(
              "flex min-w-0 flex-1 flex-col",
              withDescription && option.description ? "gap-0.5" : "gap-0"
            )}
          >
            <span className="min-w-0 truncate leading-[1.15]">
              {option.label}
            </span>
            {withDescription && option.description ? (
              <span className="whitespace-normal text-[11px] leading-[1.2] text-[var(--text-tertiary)]">
                {option.description}
              </span>
            ) : null}
          </span>
          <CheckIcon
            aria-hidden
            className={cn(
              "ml-2 size-3.5 shrink-0 text-[var(--tutti-purple)]",
              option.value !== selectedValue && "invisible"
            )}
          />
        </DropdownMenuItem>
      ))}
    </>
  );
}
