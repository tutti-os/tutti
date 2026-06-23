import {
  cloneElement,
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactElement
} from "react";
import { ChevronDown, ZapIcon } from "lucide-react";
import {
  WorkspaceUserProjectSelect,
  resolveWorkspaceUserProjectSelectLabels,
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
  FolderIcon,
  NewWorkspaceLinedIcon,
  NoWorkspaceLinedIcon,
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
import { permissionModeSelectionPatch } from "./model/composerModeSelection";
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

function basenameProjectPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

export function AgentProjectDropdown({
  composerSettings,
  labels,
  i18n,
  previewMode = false,
  onProjectMissingChange,
  onProjectPathChange
}: {
  composerSettings: Pick<
    AgentGUIComposerSettingsVM,
    "selectedProjectPath" | "projectLocked"
  >;
  i18n: WorkspaceUserProjectI18nRuntime;
  labels: AgentProjectDropdownLabels;
  previewMode?: boolean;
  onProjectMissingChange?: (isMissing: boolean) => void;
  onProjectPathChange: (
    path: string | null,
    metadata?: AgentProjectPathChangeMetadata
  ) => void;
}): React.JSX.Element {
  "use memo";
  const agentHostApi = useAgentHostApi();
  const resolvedLabels = useMemo(
    () => resolveWorkspaceUserProjectSelectLabels(i18n, labels),
    [i18n, labels]
  );
  const userProjectApi = useMemo(
    () =>
      !previewMode && agentHostApi.userProjects
        ? {
            ...agentHostApi.userProjects,
            selectDirectory: agentHostApi.workspace.selectDirectory
          }
        : null,
    [
      agentHostApi.userProjects,
      agentHostApi.workspace.selectDirectory,
      previewMode
    ]
  );

  if (previewMode) {
    const selectedPath = composerSettings.selectedProjectPath?.trim() ?? "";
    const triggerLabel = selectedPath
      ? basenameProjectPath(selectedPath)
      : resolvedLabels.noProject;
    return (
      <button
        type="button"
        aria-label={
          composerSettings.projectLocked
            ? resolvedLabels.projectLocked
            : resolvedLabels.projectLabel
        }
        className={cn(
          "w-auto max-w-full",
          styles.composerMenuTrigger,
          "text-[var(--agent-gui-text-tertiary)]"
        )}
      >
        <span
          className="workspace-user-project-trigger-label"
          data-workspace-user-project-trigger-label="true"
        >
          {selectedPath ? (
            <FolderIcon aria-hidden className="shrink-0" size={15} />
          ) : (
            <NoWorkspaceLinedIcon
              aria-hidden
              className="shrink-0"
              data-agent-project-trigger-no-workspace-icon="true"
              size={15}
            />
          )}
          <span className="min-w-0 truncate">{triggerLabel}</span>
        </span>
        <ChevronDown aria-hidden="true" className="shrink-0" size={16} />
      </button>
    );
  }

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
  previewMode = false,
  labels,
  onSettingsChange
}: {
  composerSettings: AgentGUIComposerSettingsVM;
  disabled?: boolean;
  previewMode?: boolean;
  labels: Pick<AgentComposerSettingsMenuLabels, "permissionLabel">;
  onSettingsChange: (patch: {
    permissionModeId?: string | null;
    planMode?: boolean;
  }) => void;
}): React.JSX.Element {
  "use memo";
  const [isSelectOpen, setIsSelectOpen] = useState(false);
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

function ComposerOptionInfoTooltip({
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

export function AgentModelReasoningDropdown({
  composerSettings,
  disabled = false,
  previewMode = false,
  labels,
  onSettingsChange
}: {
  composerSettings: AgentGUIComposerSettingsVM;
  disabled?: boolean;
  previewMode?: boolean;
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
  const trigger = (
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
          <ZapIcon
            aria-hidden
            className="size-3.5 shrink-0"
            data-agent-speed-indicator="fast"
            strokeWidth={2.5}
          />
        ) : null}
        {menu.trigger.showCombined ? (
          <span className="min-w-0 truncate">{menu.trigger.combinedLabel}</span>
        ) : (
          <>
            <span className="min-w-0 truncate">{menu.trigger.modelLabel}</span>
            <span className="shrink-0">{menu.trigger.reasoningLabel}</span>
          </>
        )}
      </span>
      <ChevronDown aria-hidden="true" className="shrink-0" size={16} />
    </button>
  );

  if (previewMode) {
    return trigger;
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild disabled={menuDisabled}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={4}
        collisionPadding={16}
        className={cn(
          styles.composerMenuContent,
          "w-max min-w-[360px] max-w-[calc(100vw-32px)] data-[side=top]:!translate-y-0"
        )}
        data-agent-composer-settings-layout="model-primary"
      >
        {menu.model.show ? (
          <>
            <DropdownMenuLabel>{labels.modelSelectionLabel}</DropdownMenuLabel>
            <ComposerMenuOptionItems
              options={menu.model.options}
              selectedValue={menu.model.selectedValue}
              descriptionPresentation="model-tooltip"
              tooltipsEnabled={!previewMode}
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
                tooltipsEnabled={!previewMode}
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
                descriptionPresentation="inline"
                tooltipsEnabled={!previewMode}
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
  descriptionPresentation = "none",
  tooltipsEnabled = true,
  onSelect
}: {
  options: ComposerMenuOption[];
  selectedValue: string;
  descriptionPresentation?: "inline" | "model-tooltip" | "none" | "tooltip";
  tooltipsEnabled?: boolean;
  onSelect: (value: string) => void;
}): React.JSX.Element {
  return (
    <>
      {options.map((option) => {
        const hasDescription = Boolean(option.description);
        const showInlineDescription =
          descriptionPresentation === "inline" && hasDescription;
        const showModelTooltip = descriptionPresentation === "model-tooltip";
        const showTooltipDescription =
          descriptionPresentation === "tooltip" && hasDescription;
        const item = (
          <DropdownMenuItem
            key={option.value}
            className={cn(
              styles.composerMenuItem,
              "group/composer-option",
              showModelTooltip &&
                "min-h-[40px] max-w-full items-center px-3 py-2",
              showInlineDescription && "items-start"
            )}
            data-agent-model-option={showModelTooltip ? "true" : undefined}
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
            {showModelTooltip ? (
              <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                <span className="min-w-0 truncate leading-[1.15]">
                  {option.label}
                </span>
                {option.summary && option.summary.length > 0 ? (
                  <span className="flex min-w-0 shrink-0 items-baseline gap-1.5 overflow-hidden text-[var(--agent-gui-text-tertiary)]">
                    {option.summary.map((summary) => (
                      <span
                        key={summary}
                        className="max-w-[64px] truncate leading-[1.15]"
                      >
                        {summary}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            ) : (
              <span
                className={cn(
                  "flex min-w-0 flex-1 flex-col",
                  showInlineDescription ? "gap-0.5" : "gap-0"
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate leading-[1.15]">
                    {option.label}
                  </span>
                  {showTooltipDescription && option.description ? (
                    <ComposerOptionInfoTooltip
                      description={option.description}
                      tooltipsEnabled={tooltipsEnabled}
                    />
                  ) : null}
                </span>
                {showInlineDescription && option.description ? (
                  <span className="whitespace-normal text-[11px] leading-[1.2] text-[var(--text-tertiary)]">
                    {option.description}
                  </span>
                ) : null}
              </span>
            )}
            <CheckIcon
              aria-hidden
              className={cn(
                "ml-2 size-3.5 shrink-0 text-[var(--tutti-purple)]",
                option.value !== selectedValue && "invisible"
              )}
            />
          </DropdownMenuItem>
        );
        return showModelTooltip ? (
          <ComposerModelOptionTooltip
            key={option.value}
            option={option}
            tooltipsEnabled={tooltipsEnabled}
          >
            {item}
          </ComposerModelOptionTooltip>
        ) : (
          item
        );
      })}
    </>
  );
}

function ComposerModelOptionTooltip({
  children,
  option,
  tooltipsEnabled = true
}: {
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  option: ComposerMenuOption;
  tooltipsEnabled?: boolean;
}): React.JSX.Element {
  if (!tooltipsEnabled || !option.tooltip) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {cloneElement(children, {
          "data-agent-model-option-tooltip-trigger": "true"
        } as Partial<HTMLAttributes<HTMLElement>> &
          Record<"data-agent-model-option-tooltip-trigger", string>)}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        sideOffset={8}
        className="flex w-[320px] max-w-[calc(100vw-32px)] flex-col items-start gap-0 whitespace-normal rounded-lg border border-[var(--line-2)] bg-[var(--background-fronted)] px-4 py-3 text-[13px] leading-[1.3] text-[var(--text-primary)] shadow-lg"
        data-agent-model-option-tooltip="true"
      >
        <span className="block text-[15px] font-semibold leading-[1.2]">
          {option.tooltip.title}
        </span>
        {option.tooltip.description ? (
          <span className="mt-1.5 block text-[13px] leading-[1.35]">
            {option.tooltip.description}
          </span>
        ) : null}
        {option.tooltip.contextWindow ? (
          <span className="mt-4 block">{option.tooltip.contextWindow}</span>
        ) : null}
        {option.tooltip.version ? (
          <span className="mt-4 block italic">{option.tooltip.version}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
