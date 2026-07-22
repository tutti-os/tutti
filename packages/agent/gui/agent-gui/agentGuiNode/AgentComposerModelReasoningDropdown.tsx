import {
  Fragment,
  cloneElement,
  useCallback,
  useState,
  type HTMLAttributes,
  type ReactElement
} from "react";
import { ChevronDown, Star, ZapIcon } from "lucide-react";
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
  RoomsHintIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import type { AgentGUIComposerSettingsVM } from "./model/agentGuiNodeTypes";
import {
  buildComposerModelMenuModel,
  type AgentComposerSettingsMenuLabels,
  type ComposerMenuOption
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
import styles from "./AgentGUINode.styles";

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
    reasoningEffort?: string;
    speed?: string;
  }) => void;
}): React.JSX.Element {
  "use memo";
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [favoriteModelIds, setFavoriteModelIds] = useState<readonly string[]>(
    () =>
      parseComposerModelIdList(
        readComposerLocalStorage(
          composerModelFavoritesStorageKey(modelHistoryTargetId)
        )
      )
  );
  const [recentModelIds, setRecentModelIds] = useState<readonly string[]>(() =>
    parseComposerModelIdList(
      readComposerLocalStorage(
        composerModelRecentsStorageKey(modelHistoryTargetId)
      )
    )
  );
  const reloadModelHistory = useCallback(() => {
    setFavoriteModelIds(
      parseComposerModelIdList(
        readComposerLocalStorage(
          composerModelFavoritesStorageKey(modelHistoryTargetId)
        )
      )
    );
    setRecentModelIds(
      parseComposerModelIdList(
        readComposerLocalStorage(
          composerModelRecentsStorageKey(modelHistoryTargetId)
        )
      )
    );
  }, [modelHistoryTargetId]);
  const handleMenuOpenChange = (open: boolean): void => {
    if (open) {
      // Pick up writes from other windows and clear the previous filter.
      reloadModelHistory();
      setModelSearchQuery("");
    }
    setMenuOpen(open);
  };
  const menu = buildComposerModelMenuModel(composerSettings, labels, {
    favoriteModelIds,
    recentModelIds,
    searchQuery: modelSearchQuery
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
    applySettingsChange({ model: value });
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

// Renders a list of pick-to-apply menu items. Pointer activation applies
// directly because runtime evidence showed submenu items can receive
// pointerdown while Radix onSelect never fires in this embedded menu. onSelect
// remains for keyboard activation and normal Radix paths.
function ComposerMenuOptionItems({
  options,
  selectedValue,
  descriptionPresentation = "none",
  tooltipsEnabled = true,
  favoriteValues,
  onToggleFavorite,
  onSelect
}: {
  options: ComposerMenuOption[];
  selectedValue: string;
  descriptionPresentation?: "inline" | "model-tooltip" | "none" | "tooltip";
  tooltipsEnabled?: boolean;
  /** Values currently favorited; enables the per-option star toggle. */
  favoriteValues?: ReadonlySet<string>;
  onToggleFavorite?: (value: string) => void;
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
        const isFavorite = favoriteValues?.has(option.value) ?? false;
        const favoriteToggle = onToggleFavorite ? (
          <button
            type="button"
            data-agent-model-favorite-toggle="true"
            data-favorited={isFavorite ? "true" : "false"}
            aria-label={translate(
              isFavorite
                ? "agentHost.agentGui.composerModelFavoriteRemove"
                : "agentHost.agentGui.composerModelFavoriteAdd"
            )}
            className={cn(
              "ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[var(--agent-gui-text-tertiary)] transition-opacity hover:text-[var(--text-secondary)]",
              isFavorite
                ? "text-[var(--tutti-purple)] opacity-100 hover:text-[var(--tutti-purple)]"
                : "opacity-0 group-hover/composer-option:opacity-100 group-data-[highlighted]/composer-option:opacity-100"
            )}
            // Stop before the DropdownMenuItem's pointerdown-apply handler:
            // starring an option must not also select it or close the menu.
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFavorite(option.value);
            }}
          >
            <Star
              aria-hidden
              className="size-3.5"
              fill={isFavorite ? "currentColor" : "none"}
              strokeWidth={2}
            />
          </button>
        ) : null;
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
            {favoriteToggle}
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
          <span className="mt-1.5 block text-[13px] leading-[1.35] text-[var(--text-tertiary)]">
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
