import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ZapIcon } from "lucide-react";
import { prepareWorkspaceUserProjectSelection } from "@tutti-os/workspace-user-project/core";
import { useAgentHostApi } from "../../agentActivityHost";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
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
import {
  buildComposerModelMenuModel,
  type AgentComposerSettingsMenuLabels
} from "./model/composerSettingsMenuModel";
import {
  composerModelFavoritesStorageKey,
  composerModelRecentsStorageKey,
  parseComposerModelIdList,
  recordRecentComposerModel,
  serializeComposerModelIdList,
  toggleFavoriteComposerModel
} from "./model/composerModelChoiceHistory";
import { translate } from "../../i18n/index";
import {
  ComposerMenuOptionItems,
  ComposerOptionInfoTooltip
} from "./AgentComposerModelOptionItems";
import styles from "./AgentGUINode.styles";

export type { AgentComposerSettingsMenuLabels } from "./model/composerSettingsMenuModel";

export {
  AgentProjectDropdown,
  type AgentProjectDropdownLabels,
  type AgentProjectPathChangeMetadata
} from "./AgentComposerProjectMenu";
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
        value={selectedValue ?? ""}
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
  modelHistoryTargetId = null,
  onSettingsChange
}: {
  composerSettings: AgentGUIComposerSettingsVM;
  disabled?: boolean;
  previewMode?: boolean;
  labels: AgentComposerSettingsMenuLabels;
  /**
   * Stable per-target key for the recents/favorites localStorage chrome
   * state; omit to fall back to one shared "default" bucket.
   */
  modelHistoryTargetId?: string | null;
  onSettingsChange: (patch: {
    model?: string;
    modelPlanId?: string | null;
    reasoningEffort?: string;
    speed?: string;
  }) => void;
}): React.JSX.Element {
  "use memo";
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [modelSourceFilter, setModelSourceFilter] = useState("");
  const readFavoriteModelIds = () =>
    parseComposerModelIdList(
      readComposerLocalStorage(
        composerModelFavoritesStorageKey(modelHistoryTargetId)
      )
    );
  const readRecentModelIds = () =>
    parseComposerModelIdList(
      readComposerLocalStorage(
        composerModelRecentsStorageKey(modelHistoryTargetId)
      )
    );
  const [favoriteModelIds, setFavoriteModelIds] =
    useState<readonly string[]>(readFavoriteModelIds);
  const [recentModelIds, setRecentModelIds] =
    useState<readonly string[]>(readRecentModelIds);
  const reloadModelHistory = (): void => {
    setFavoriteModelIds(readFavoriteModelIds());
    setRecentModelIds(readRecentModelIds());
  };
  const handleMenuOpenChange = (open: boolean): void => {
    if (open) {
      // Pick up writes from other windows and clear the previous filter.
      reloadModelHistory();
      setModelSearchQuery("");
      setModelSourceFilter("");
    }
    setMenuOpen(open);
  };
  const menu = buildComposerModelMenuModel(composerSettings, labels, {
    favoriteModelIds,
    recentModelIds,
    searchQuery: modelSearchQuery,
    sourceFilter: modelSourceFilter
  });
  const menuDisabled = disabled || menu.disabled;
  // While the model list is still loading the trigger shows a placeholder
  // ("Default") that reads like a real selection. Surface a hover hint so the
  // user knows the list is still loading rather than already resolved.
  const isModelLoading =
    composerSettings.isModelOptionsLoading ||
    composerSettings.isSettingsLoading;
  const applySettingsChange = (patch: {
    model?: string;
    modelPlanId?: string | null;
    reasoningEffort?: string;
    speed?: string;
  }): void => {
    onSettingsChange(patch);
    setMenuOpen(false);
  };
  const applyModelSelection = (value: string): void => {
    const nextRecentIds = recordRecentComposerModel(recentModelIds, value);
    setRecentModelIds(nextRecentIds);
    writeComposerLocalStorage(
      composerModelRecentsStorageKey(modelHistoryTargetId),
      serializeComposerModelIdList(nextRecentIds)
    );
    const selected = composerSettings.availableModels.find(
      (option) => option.value === value
    );
    applySettingsChange(
      selected?.modelPlanId
        ? { model: selected.model ?? value, modelPlanId: selected.modelPlanId }
        : { model: selected?.model ?? value }
    );
  };
  const handleToggleFavoriteModel = (value: string): void => {
    const nextFavoriteIds = toggleFavoriteComposerModel(
      favoriteModelIds,
      value
    );
    setFavoriteModelIds(nextFavoriteIds);
    writeComposerLocalStorage(
      composerModelFavoritesStorageKey(modelHistoryTargetId),
      serializeComposerModelIdList(nextFavoriteIds)
    );
  };
  const favoriteValueSet = new Set(menu.model.favoriteValues);
  const modelDescriptionPresentation = menu.model.optionDescriptionInline
    ? ("inline" as const)
    : ("model-tooltip" as const);
  const modelListEmpty =
    menu.model.options.length === 0 &&
    menu.model.favoriteOptions.length === 0 &&
    menu.model.recentOptions.length === 0;
  const trigger = (
    <button
      type="button"
      className={cn(
        "w-auto",
        styles.composerMenuTrigger,
        menuDisabled &&
          "cursor-not-allowed text-[var(--agent-gui-text-tertiary)] opacity-60 hover:text-[var(--agent-gui-text-tertiary)]",
        (composerSettings.isSettingsLoading ||
          composerSettings.isModelOptionsLoading) &&
          "animate-pulse"
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
    <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
      {isModelLoading ? (
        // The trigger is disabled while loading, so pointer events never reach
        // it. Target the tooltip at a focusable wrapper span (Radix's pattern
        // for disabled triggers) so hover/focus reliably surfaces the hint.
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" tabIndex={0}>
              <DropdownMenuTrigger asChild disabled={menuDisabled}>
                {trigger}
              </DropdownMenuTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{labels.loadingOptions}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild disabled={menuDisabled}>
          {trigger}
        </DropdownMenuTrigger>
      )}
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
            <DropdownMenuLabel className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate">
                {labels.modelSelectionLabel}
              </span>
              {menu.model.plan ? (
                <span
                  data-agent-model-plan-badge="true"
                  className="min-w-0 shrink truncate rounded-full border border-[var(--line-2)] px-1.5 text-[10px] font-normal leading-4 text-[var(--agent-gui-text-tertiary)]"
                >
                  {translate("agentHost.agentGui.composerModelPlanBadge", {
                    name: menu.model.plan.name
                  })}
                </span>
              ) : null}
            </DropdownMenuLabel>
            {menu.model.searchEnabled ? (
              <div
                className="px-2 pb-1.5"
                // Keep typing local to the input: Radix menu typeahead and
                // arrow-key focus handling must not steal these key events.
                onKeyDown={(event) => event.stopPropagation()}
              >
                <input
                  type="text"
                  value={modelSearchQuery}
                  data-agent-model-search-input="true"
                  placeholder={translate(
                    "agentHost.agentGui.composerModelSearchPlaceholder"
                  )}
                  className="box-border h-7 w-full min-w-0 rounded-[6px] border border-[var(--line-2)] bg-transparent px-2 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--agent-gui-text-tertiary)] focus:border-[var(--tutti-purple)]"
                  onChange={(event) => setModelSearchQuery(event.target.value)}
                />
              </div>
            ) : null}
            {menu.model.sourceFilters.length > 1 ? (
              <div
                aria-label={translate(
                  "agentHost.agentGui.composerModelSourceFilterLabel"
                )}
                className="flex max-w-[420px] flex-wrap gap-1 px-2 pb-1.5"
                data-agent-model-source-filters="true"
                role="group"
              >
                {["", ...menu.model.sourceFilters].map((source) => {
                  const selected = menu.model.sourceFilter === source;
                  return (
                    <button
                      key={source || "all"}
                      aria-pressed={selected}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                        selected
                          ? "border-[var(--tutti-purple)] bg-[color-mix(in_srgb,var(--tutti-purple)_12%,transparent)] text-[var(--tutti-purple)]"
                          : "border-[var(--line-2)] text-[var(--agent-gui-text-tertiary)] hover:text-[var(--text-secondary)]"
                      )}
                      data-agent-model-source-filter={source || "all"}
                      type="button"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setModelSourceFilter(source);
                      }}
                    >
                      {source ||
                        translate("agentHost.agentGui.composerModelAllSources")}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {menu.model.favoriteOptions.length > 0 ? (
              <>
                <DropdownMenuLabel
                  data-agent-model-favorites-group="true"
                  className="text-xs text-[var(--agent-gui-text-tertiary)]"
                >
                  {translate("agentHost.agentGui.composerModelFavoritesGroup")}
                </DropdownMenuLabel>
                <ComposerMenuOptionItems
                  options={menu.model.favoriteOptions}
                  selectedValue={menu.model.selectedValue}
                  descriptionPresentation={modelDescriptionPresentation}
                  tooltipsEnabled={!previewMode}
                  favoriteValues={favoriteValueSet}
                  onToggleFavorite={handleToggleFavoriteModel}
                  onSelect={applyModelSelection}
                />
              </>
            ) : null}
            {menu.model.recentOptions.length > 0 ? (
              <>
                <DropdownMenuLabel
                  data-agent-model-recents-group="true"
                  className="text-xs text-[var(--agent-gui-text-tertiary)]"
                >
                  {translate("agentHost.agentGui.composerModelRecentsGroup")}
                </DropdownMenuLabel>
                <ComposerMenuOptionItems
                  options={menu.model.recentOptions}
                  selectedValue={menu.model.selectedValue}
                  descriptionPresentation={modelDescriptionPresentation}
                  tooltipsEnabled={!previewMode}
                  favoriteValues={favoriteValueSet}
                  onToggleFavorite={handleToggleFavoriteModel}
                  onSelect={applyModelSelection}
                />
              </>
            ) : null}
            {(menu.model.favoriteOptions.length > 0 ||
              menu.model.recentOptions.length > 0) &&
            menu.model.options.length > 0 ? (
              <DropdownMenuSeparator />
            ) : null}
            {menu.model.groups.length > 0 ? (
              menu.model.groups.map((group, index) => (
                <Fragment key={group.label ?? `ungrouped-${index}`}>
                  {group.label !== null ? (
                    <DropdownMenuLabel className="text-xs text-[var(--agent-gui-text-tertiary)]">
                      {group.label}
                    </DropdownMenuLabel>
                  ) : null}
                  <ComposerMenuOptionItems
                    options={group.options}
                    selectedValue={menu.model.selectedValue}
                    descriptionPresentation={modelDescriptionPresentation}
                    tooltipsEnabled={!previewMode}
                    favoriteValues={favoriteValueSet}
                    onToggleFavorite={handleToggleFavoriteModel}
                    onSelect={applyModelSelection}
                  />
                </Fragment>
              ))
            ) : (
              <ComposerMenuOptionItems
                options={menu.model.options}
                selectedValue={menu.model.selectedValue}
                descriptionPresentation={modelDescriptionPresentation}
                tooltipsEnabled={!previewMode}
                favoriteValues={favoriteValueSet}
                onToggleFavorite={handleToggleFavoriteModel}
                onSelect={applyModelSelection}
              />
            )}
            {menu.model.searchEnabled &&
            menu.model.searchQuery &&
            modelListEmpty ? (
              <div
                data-agent-model-search-empty="true"
                className="px-2 py-1.5 text-[12px] text-[var(--agent-gui-text-tertiary)]"
              >
                {translate("agentHost.agentGui.composerModelSearchEmpty")}
              </div>
            ) : null}
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
        {menu.switchEffectHint ? (
          <>
            <DropdownMenuSeparator />
            <div
              data-agent-model-switch-hint="true"
              className="px-2 py-1.5 text-[11px] text-[var(--agent-gui-text-tertiary)]"
            >
              {translate("agentHost.agentGui.composerModelSwitchNextTurnHint")}
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function readComposerLocalStorage(key: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeComposerLocalStorage(key: string, value: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // Chrome-state persistence is best-effort; never break the menu.
    return;
  }
}
