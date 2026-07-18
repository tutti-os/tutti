import { type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ListChecks, Target, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { cn } from "../../../app/renderer/lib/utils";
import addLinedIconUrl from "../../../app/renderer/assets/icons/add-lined.svg";
import atLinedIconUrl from "../../../app/renderer/assets/icons/@-lined.svg";
import styles from "../AgentGUINode.styles";
import {
  AgentModelReasoningDropdown,
  AgentPermissionModeDropdown
} from "../AgentComposerSettingsMenus";
import { textPromptContent } from "../model/agentComposerDraft";
import type { AgentGUIAgentTarget } from "../../../types";
import type {
  AgentComposerProps,
  AgentComposerUsage
} from "./AgentComposer.types";
import {
  AgentComposerHandoffIcon,
  AgentComposerMaskIcon,
  AgentUsageChip,
  HANDOFF_SELECT_IDLE_VALUE,
  composerStyles,
  resolveComposerProviderTargetIconUrl,
  workspaceReferenceOptionValue,
  workspaceReferenceSelectValue
} from "./AgentComposerChrome";
import { resolveHandoffTargetOwnershipLabel } from "./handoffTargetPresentation";

interface Props {
  labels: AgentComposerProps["labels"];
  provider: AgentComposerProps["provider"];
  composerSettings: AgentComposerProps["composerSettings"];
  usage: AgentComposerUsage | null;
  previewMode: boolean;
  compactSupported: boolean | null;
  hasCompactableContext: boolean;
  composerControlsHardDisabled: boolean;
  inputDisabled: boolean;
  settingsControlsDisabled: boolean;
  permissionModeControlsDisabled: boolean;
  isSendingTurn: boolean;
  isHeroLayout: boolean;
  isGoalModeActive: boolean;
  composerActionButton: ReactNode;
  showHandoffSelect: boolean;
  handoffDisabled: boolean;
  effectiveHandoffLabel: string;
  effectiveHandoffMenuLabel: string;
  isHandoffIconPlaying: boolean;
  setIsHandoffIconPlaying: Dispatch<SetStateAction<boolean>>;
  handoffMenuTargets: readonly AgentGUIAgentTarget[];
  onHandoffConversation?: (target: AgentGUIAgentTarget) => void;
  showProviderSelect: boolean;
  selectedProviderSwitchTarget: AgentGUIAgentTarget | null;
  providerSelectDisabled: boolean;
  providerSelectLabel: string;
  selectedProviderLabel: string;
  providerMenuTargets: readonly AgentGUIAgentTarget[];
  onProviderSelect: AgentComposerProps["onProviderSelect"];
  onLinkAction: AgentComposerProps["onLinkAction"];
  onRequestWorkspaceReferences: AgentComposerProps["onRequestWorkspaceReferences"];
  onWorkspaceReferencePicker: () => void;
  onMentionPaletteButton: () => void;
  onSettingsChange: AgentComposerProps["onSettingsChange"];
  onSubmit: AgentComposerProps["onSubmit"];
  onClearGoalMode: () => void;
}

export function ComposerFooter({
  labels,
  provider,
  composerSettings,
  usage,
  previewMode,
  compactSupported,
  hasCompactableContext,
  composerControlsHardDisabled,
  inputDisabled,
  settingsControlsDisabled,
  permissionModeControlsDisabled,
  isSendingTurn,
  isHeroLayout,
  isGoalModeActive,
  composerActionButton,
  showHandoffSelect,
  handoffDisabled,
  effectiveHandoffLabel,
  effectiveHandoffMenuLabel,
  isHandoffIconPlaying,
  setIsHandoffIconPlaying,
  handoffMenuTargets,
  onHandoffConversation,
  showProviderSelect,
  selectedProviderSwitchTarget,
  providerSelectDisabled,
  providerSelectLabel,
  selectedProviderLabel,
  providerMenuTargets,
  onProviderSelect,
  onLinkAction,
  onRequestWorkspaceReferences,
  onWorkspaceReferencePicker: handleWorkspaceReferencePicker,
  onMentionPaletteButton: handleMentionPaletteButton,
  onSettingsChange,
  onSubmit,
  onClearGoalMode: clearGoalModeBadge
}: Props) {
  const showSettingsLoadingPlaceholders = composerSettings.isSettingsLoading;
  return (
    <>
      <div className={styles.composerFooter}>
        <div className={composerStyles.footerGroup}>
          <div className="inline-flex shrink-0 items-center gap-1">
            {previewMode ? (
              <TooltipProvider delayDuration={120}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={labels.referenceWorkspaceFiles}
                      className={cn(
                        styles.composerMenuTrigger,
                        styles.composerReferenceTrigger,
                        "group w-auto justify-center text-[var(--agent-gui-text-secondary)]"
                      )}
                    >
                      <AgentComposerMaskIcon
                        iconUrl={addLinedIconUrl}
                        marker="reference-add"
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {labels.addContent}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <Select
                open={false}
                value={workspaceReferenceSelectValue}
                disabled={
                  !onRequestWorkspaceReferences || composerControlsHardDisabled
                }
                onOpenChange={(isOpen) => {
                  if (isOpen) {
                    void handleWorkspaceReferencePicker();
                  }
                }}
                onValueChange={(nextValue) => {
                  if (nextValue === workspaceReferenceOptionValue) {
                    void handleWorkspaceReferencePicker();
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={labels.referenceWorkspaceFiles}
                  title={labels.addContent}
                  className={cn(
                    styles.composerMenuTrigger,
                    styles.composerReferenceTrigger,
                    "group w-auto justify-center text-[var(--agent-gui-text-secondary)] [&>svg:last-child]:hidden"
                  )}
                >
                  <AgentComposerMaskIcon
                    iconUrl={addLinedIconUrl}
                    marker="reference-add"
                  />
                </SelectTrigger>
              </Select>
            )}
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={labels.mentionPalette}
                    disabled={composerControlsHardDisabled || inputDisabled}
                    className={cn(
                      styles.composerMenuTrigger,
                      styles.composerReferenceTrigger,
                      "group w-auto justify-center text-[var(--agent-gui-text-secondary)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0"
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={handleMentionPaletteButton}
                  >
                    <span
                      aria-hidden
                      className="inline-block size-3.5 bg-[var(--text-secondary)] transition-colors group-hover:bg-[var(--text-primary)] group-focus-visible:bg-[var(--text-primary)]"
                      style={{
                        WebkitMaskImage: `url("${atLinedIconUrl}")`,
                        WebkitMaskPosition: "center",
                        WebkitMaskRepeat: "no-repeat",
                        WebkitMaskSize: "contain",
                        maskImage: `url("${atLinedIconUrl}")`,
                        maskPosition: "center",
                        maskRepeat: "no-repeat",
                        maskSize: "contain"
                      }}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {labels.mentionPalette}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {showHandoffSelect ? (
            <Select
              value={HANDOFF_SELECT_IDLE_VALUE}
              disabled={handoffDisabled}
              onValueChange={(nextTargetId) => {
                const target = handoffMenuTargets.find(
                  (candidate) => candidate.targetId === nextTargetId
                );
                if (!target || target.disabled === true) {
                  return;
                }
                onHandoffConversation?.(target);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label={effectiveHandoffLabel}
                title={labels.handoffConversationTooltip}
                onBlur={() => {
                  setIsHandoffIconPlaying(false);
                }}
                onFocus={() => {
                  setIsHandoffIconPlaying(true);
                }}
                onMouseEnter={() => {
                  setIsHandoffIconPlaying(true);
                }}
                onMouseLeave={() => {
                  setIsHandoffIconPlaying(false);
                }}
                className={cn(
                  styles.composerMenuTrigger,
                  styles.composerProviderSelect,
                  styles.composerHandoffTrigger,
                  "w-auto max-w-[180px] [&>svg:last-child]:hidden"
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <AgentComposerHandoffIcon
                    disabled={handoffDisabled}
                    isPlaying={isHandoffIconPlaying}
                  />
                  <span className="min-w-0 truncate">
                    {effectiveHandoffLabel}
                  </span>
                </span>
              </SelectTrigger>
              <SelectContent
                align="start"
                className={cn(
                  styles.composerMenuContent,
                  styles.composerHandoffMenuContent,
                  "min-w-[190px]"
                )}
                aria-label={effectiveHandoffMenuLabel}
              >
                {handoffMenuTargets.map((target) => {
                  const ownershipLabel = resolveHandoffTargetOwnershipLabel(
                    target,
                    {
                      self: labels.handoffTargetSelf,
                      shared: labels.handoffTargetShared
                    }
                  );
                  return (
                    <SelectItem
                      key={`${target.provider}:${target.targetId}`}
                      value={target.targetId}
                      className={cn(styles.composerMenuItem, "gap-2 py-1.5")}
                      disabled={target.disabled === true}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="relative size-5 shrink-0">
                          <img
                            alt=""
                            aria-hidden="true"
                            className="size-5 rounded-[4px]"
                            src={resolveComposerProviderTargetIconUrl(target)}
                          />
                          {target.badge?.iconUrl ? (
                            <img
                              alt=""
                              aria-hidden="true"
                              className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-[var(--background-fronted)] bg-[var(--background-fronted)] object-cover"
                              src={target.badge.iconUrl}
                            />
                          ) : null}
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="min-w-0 truncate">
                            {target.label}
                          </span>
                          {ownershipLabel ? (
                            <span className="min-w-0 truncate text-[11px] leading-none text-[var(--agent-gui-text-secondary)]">
                              {ownershipLabel}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          ) : showProviderSelect && selectedProviderSwitchTarget ? (
            <Select
              value={selectedProviderSwitchTarget.targetId}
              disabled={providerSelectDisabled}
              onValueChange={(nextTargetId) => {
                const target = providerMenuTargets.find(
                  (candidate) => candidate.targetId === nextTargetId
                );
                if (!target) {
                  return;
                }
                onProviderSelect?.({
                  provider: target.provider,
                  agentTargetId: target.targetId
                });
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label={providerSelectLabel}
                title={providerSelectLabel}
                className={cn(
                  styles.composerMenuTrigger,
                  styles.composerProviderSelect,
                  "w-auto max-w-[180px]"
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <img
                    alt=""
                    aria-hidden="true"
                    className="size-4 shrink-0 rounded-[4px]"
                    src={resolveComposerProviderTargetIconUrl(
                      selectedProviderSwitchTarget
                    )}
                  />
                  <span className="min-w-0 truncate">
                    {selectedProviderLabel}
                  </span>
                </span>
              </SelectTrigger>
              <SelectContent
                align="start"
                className={cn(styles.composerMenuContent, "min-w-[190px]")}
              >
                {providerMenuTargets.map((target) => (
                  <SelectItem
                    key={`${target.provider}:${target.targetId}`}
                    value={target.targetId}
                    className={cn(styles.composerMenuItem, "gap-2")}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <img
                        alt=""
                        aria-hidden="true"
                        className="size-4 shrink-0 rounded-[4px]"
                        src={resolveComposerProviderTargetIconUrl(target)}
                      />
                      <span className="min-w-0 truncate">{target.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {composerSettings.supportsPlanMode &&
          composerSettings.draftSettings.planMode ? (
            <button
              type="button"
              disabled={settingsControlsDisabled}
              aria-label={labels.planModeLabel}
              title={labels.planModeLabel}
              data-agent-plan-mode-badge="true"
              className={cn(
                styles.composerMenuTrigger,
                "group w-auto",
                "disabled:cursor-not-allowed disabled:opacity-60"
              )}
              onClick={() => onSettingsChange({ planMode: false })}
            >
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                  <ListChecks
                    aria-hidden
                    className="size-3.5 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                  />
                  <span
                    aria-hidden
                    className="absolute inset-0 flex items-center justify-center rounded-full bg-[var(--text-secondary)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-0"
                  >
                    <X
                      className="size-2.5 text-[var(--background-fronted)]"
                      strokeWidth={3}
                    />
                  </span>
                </span>
                <span className="min-w-0 truncate">{labels.planModeLabel}</span>
              </span>
            </button>
          ) : null}
          {isGoalModeActive ? (
            <button
              type="button"
              disabled={settingsControlsDisabled}
              aria-label={labels.goalLabel}
              title={labels.goalLabel}
              data-agent-goal-badge="true"
              className={cn(
                styles.composerMenuTrigger,
                "group w-auto",
                "disabled:cursor-not-allowed disabled:opacity-60"
              )}
              onClick={clearGoalModeBadge}
            >
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                  <Target
                    aria-hidden
                    className="size-3.5 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                  />
                  <span
                    aria-hidden
                    className="absolute inset-0 flex items-center justify-center rounded-full bg-[var(--text-secondary)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-0"
                  >
                    <X
                      className="size-2.5 text-[var(--background-fronted)]"
                      strokeWidth={3}
                    />
                  </span>
                </span>
                <span className="min-w-0 truncate">{labels.goalLabel}</span>
              </span>
            </button>
          ) : null}
        </div>
        <div className={composerStyles.footerGroupRight}>
          {usage && usage.percentUsed !== null ? (
            <AgentUsageChip
              percentUsed={usage.percentUsed}
              usedTokens={usage.usedTokens}
              totalTokens={usage.totalTokens}
              tooltipsEnabled={!previewMode}
              compactSupported={compactSupported ?? false}
              // Only guard against compacting mid-turn: isSendingTurn is
              // the narrow "a turn is actively executing right now"
              // signal. showStopButton alone (e.g. pending approval or
              // interrupting, with isSendingTurn false) must keep this
              // enabled -- that broader gate was the bug fixed by
              // 0e736412 and should not be reintroduced.
              compactDisabled={
                !hasCompactableContext ||
                composerControlsHardDisabled ||
                isSendingTurn
              }
              onCompact={() => onSubmit(textPromptContent("/compact"))}
              labels={{
                usageChipLabel: labels.usageChipLabel,
                usageTooltipLabel: labels.usageTooltipLabel,
                usagePopoverTitle: labels.usagePopoverTitle,
                usageContextWindowLabel: labels.usageContextWindowLabel,
                usageCompactAction: labels.usageCompactAction
              }}
            />
          ) : null}
          {showSettingsLoadingPlaceholders ||
          composerSettings.supportsPermissionMode ? (
            <AgentPermissionModeDropdown
              composerSettings={composerSettings}
              disabled={permissionModeControlsDisabled}
              disabledTooltip={
                permissionModeControlsDisabled
                  ? labels.permissionModeChangeUnavailableDuringTurn
                  : undefined
              }
              onLinkAction={onLinkAction}
              previewMode={previewMode}
              provider={provider}
              labels={{
                permissionLabel: labels.permissionLabel,
                loadingOptions: labels.loadingOptions
              }}
              onSettingsChange={(patch) => onSettingsChange(patch)}
            />
          ) : null}
          {showSettingsLoadingPlaceholders ||
          composerSettings.supportsModel ||
          composerSettings.supportsReasoningEffort ? (
            <AgentModelReasoningDropdown
              composerSettings={composerSettings}
              disabled={settingsControlsDisabled}
              previewMode={previewMode}
              labels={{
                modelLabel: labels.modelLabel,
                modelSelectionLabel: labels.modelSelectionLabel,
                modelContextWindowSuffix: labels.modelContextWindowSuffix,
                modelTooltipVersionLabel: labels.modelTooltipVersionLabel,
                planModeLabel: labels.planModeLabel,
                reasoningLabel: labels.reasoningLabel,
                reasoningDegreeLabel: labels.reasoningDegreeLabel,
                reasoningOptionDefault: labels.reasoningOptionDefault,
                reasoningOptionMinimal: labels.reasoningOptionMinimal,
                reasoningOptionLow: labels.reasoningOptionLow,
                reasoningOptionMedium: labels.reasoningOptionMedium,
                reasoningOptionHigh: labels.reasoningOptionHigh,
                reasoningOptionXHigh: labels.reasoningOptionXHigh,
                reasoningOptionMax: labels.reasoningOptionMax,
                reasoningOptionUltra: labels.reasoningOptionUltra,
                speedLabel: labels.speedLabel,
                speedSelectionLabel: labels.speedSelectionLabel,
                speedOptionStandard: labels.speedOptionStandard,
                speedOptionStandardDescription:
                  labels.speedOptionStandardDescription,
                speedOptionFast: labels.speedOptionFast,
                speedOptionFastDescription: labels.speedOptionFastDescription,
                permissionLabel: labels.permissionLabel,
                modelDescriptions: labels.modelDescriptions,
                defaultModel: labels.defaultModel,
                loadingOptions: labels.loadingOptions,
                inheritedUnavailable: labels.inheritedUnavailable
              }}
              onSettingsChange={onSettingsChange}
            />
          ) : null}
          {isHeroLayout ? composerActionButton : null}
        </div>
      </div>
    </>
  );
}
