import { type ReactNode } from "react";
import { ListChecks, Sparkles, Target, X } from "lucide-react";
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
  AgentComposerMaskIcon,
  AgentUsageChip,
  composerStyles,
  resolveComposerProviderTargetIconUrl,
  workspaceReferenceOptionValue,
  workspaceReferenceSelectValue
} from "./AgentComposerChrome";
import { AgentHandoffMenu } from "./AgentHandoffMenu";

interface Props {
  workspaceId: string;
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
  isPlanModeActive: boolean;
  isTuttiModeActive: boolean;
  isTuttiModeUpdating: boolean;
  composerActionButton: ReactNode;
  quickPromptControl?: ReactNode;
  showHandoffSelect: boolean;
  handoffDisabled: boolean;
  effectiveHandoffLabel: string;
  effectiveHandoffMenuLabel: string;
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
  draftPrompt: string;
  onClearPlanMode: () => void;
  onClearTuttiMode: () => void;
}

export function ComposerFooter({
  workspaceId: _workspaceId,
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
  isPlanModeActive,
  isTuttiModeActive,
  isTuttiModeUpdating,
  composerActionButton,
  quickPromptControl,
  showHandoffSelect,
  handoffDisabled,
  effectiveHandoffLabel,
  effectiveHandoffMenuLabel,
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
  onClearGoalMode: clearGoalModeBadge,
  draftPrompt: _draftPrompt,
  onClearPlanMode,
  onClearTuttiMode
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
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <SelectTrigger
                          size="sm"
                          aria-label={labels.referenceWorkspaceFiles}
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
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {labels.addContent}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
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
                      "group w-auto justify-center text-[var(--agent-gui-text-secondary)] hover:text-[var(--agent-gui-text-primary)] focus-visible:text-[var(--agent-gui-text-primary)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0"
                    )}
                    data-testid="agent-gui-composer-mention-trigger"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={handleMentionPaletteButton}
                  >
                    <span
                      aria-hidden
                      className="inline-block size-3.5 bg-current transition-colors"
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
            <AgentHandoffMenu
              disabled={handoffDisabled}
              labels={{
                action: effectiveHandoffLabel,
                deviceSource: labels.handoffTargetDeviceSource,
                menu: effectiveHandoffMenuLabel,
                self: labels.handoffTargetSelf,
                shared: labels.handoffTargetShared,
                tooltip: labels.handoffConversationTooltip
              }}
              targets={handoffMenuTargets}
              triggerLabel={effectiveHandoffLabel}
              onSelect={(target) => {
                onHandoffConversation?.(target);
              }}
            />
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
          {quickPromptControl}
          {composerSettings.supportsPlanMode && isPlanModeActive ? (
            <button
              type="button"
              disabled={settingsControlsDisabled}
              aria-label={labels.planModeLabel}
              title={labels.planModeDescription ?? labels.planModeLabel}
              data-agent-plan-mode-badge="true"
              className={cn(
                styles.composerMenuTrigger,
                "group w-auto",
                "disabled:cursor-not-allowed disabled:opacity-60"
              )}
              onClick={onClearPlanMode}
            >
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <RemovableBadgeIcon
                  icon={<ListChecks className="size-3.5" />}
                />
                <span className="min-w-0 truncate">{labels.planModeLabel}</span>
              </span>
            </button>
          ) : null}
          {isTuttiModeActive ? (
            <button
              type="button"
              disabled={isTuttiModeUpdating}
              aria-label={labels.tuttiModeLabel}
              title={labels.tuttiModeDescription}
              data-agent-tutti-mode-badge="true"
              className={cn(
                styles.composerMenuTrigger,
                "group w-auto",
                "disabled:cursor-not-allowed disabled:opacity-60"
              )}
              onClick={onClearTuttiMode}
            >
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <RemovableBadgeIcon icon={<Sparkles className="size-3.5" />} />
                <span className="min-w-0 truncate">
                  {labels.tuttiModeLabel}
                </span>
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

function RemovableBadgeIcon({ icon }: { icon: ReactNode }) {
  return (
    <span className="relative flex size-3.5 shrink-0 items-center justify-center">
      <span
        aria-hidden
        className="transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
      >
        {icon}
      </span>
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
  );
}
