import { memo, useId, useMemo } from "react";
import { Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Switch,
  cn
} from "@tutti-os/ui-system";
import { Button } from "../../../app/renderer/components/ui/button";
import {
  MANAGED_AGENT_ICON_FALLBACK_URL,
  MANAGED_AGENT_ICON_URLS,
  MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS
} from "../../../shared/managedAgentIcons";
import { normalizeManagedAgentProvider } from "../../../shared/managedAgentProviders";
import { agentColorfulUrl } from "../../../managedAgentIconAssets";
import type {
  AgentGUIProviderRailAllPresentation,
  AgentGUIProviderReadinessGate,
  AgentGUIAgentTarget
} from "../../../types";
import { AgentGUIHeroAgentCarousel } from "../AgentGUIHeroAgentCarousel";
import { AgentSessionChrome } from "../AgentSessionChrome";
import { AgentComposer, type AgentComposerProps } from "../AgentComposer";
import { AgentHomeSuggestions } from "../AgentHomeSuggestions";
import {
  createFallbackAgentGUIAgentAvatar,
  projectAgentGUIAgentTargetAvatar,
  type AgentGUIAgentAvatarPresentation
} from "../model/agentGuiAgentAvatarPresentation";
import type {
  AgentHomeSuggestionAction,
  AgentHomeSuggestionCategory,
  AgentGUINodeViewModel,
  AgentGUISessionChrome
} from "../model/agentGuiNodeTypes";
import {
  resolveAgentGUIProviderReadinessAction,
  resolveAgentGUIProviderReadinessContent
} from "../model/agentGuiProviderReadiness";
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import type { ChromeLabels } from "./AgentGUINodeView.types";
import { AgentGUIEmptyHeroCarouselStage } from "./AgentGUIEmptyHeroCarouselStage";
import { AgentTargetSetupGate } from "./AgentTargetSetupGate.tsx";
import {
  AgentGUIAgentTargetName,
  projectAgentGUIAgentTargetName
} from "./AgentGUIAgentTargetName";
import styles from "../AgentGUINode.styles";

export interface AgentGUIProviderIconPresentation {
  iconUrl: string;
  provider: string;
}

export function resolveAgentGUIHeroIconUrl(
  provider: string | undefined
): string {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  return (
    MANAGED_AGENT_ICON_URLS[normalizedProvider] ??
    MANAGED_AGENT_ICON_FALLBACK_URL
  );
}

export function agentGUIProviderRailIconPresentation(
  provider: string | undefined,
  iconUrl?: string | null
): AgentGUIProviderIconPresentation {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  const providerRailIconUrl =
    MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS[normalizedProvider] ?? null;
  return {
    provider: normalizedProvider,
    iconUrl:
      iconUrl?.trim() ||
      providerRailIconUrl ||
      resolveAgentGUIHeroIconUrl(normalizedProvider)
  };
}

export function shouldEmphasizeEmptyHeroProvider(label: string): boolean {
  return label.trim().length > 0;
}

export const EMPTY_HOME_SUGGESTIONS: readonly AgentHomeSuggestionCategory[] =
  Object.freeze([]);

interface AgentGUIEmptyHomePaneProps {
  provider: AgentGUINodeViewModel["shell"]["data"]["provider"];
  providerReadinessGate: AgentGUIProviderReadinessGate | null;
  showAllProviders: boolean;
  agentTargets: readonly AgentGUIAgentTarget[];
  selectedAgentTarget: AgentGUIAgentTarget | null;
  onProviderSelect?: AgentGUINodeViewProps["actions"]["selectHomeComposerAgentTarget"];
  noticeChrome: AgentGUISessionChrome | null;
  isRespondingApproval: boolean;
  previewMode: boolean;
  onSubmitApprovalOption: AgentGUINodeViewProps["actions"]["submitApprovalOption"];
  onAuthLogin?: (provider?: string | null) => void;
  onRetryActivation: AgentGUINodeViewProps["actions"]["retryActivation"];
  onContinueInNewConversation: AgentGUINodeViewProps["actions"]["continueInNewConversation"];
  chromeLabels: ChromeLabels;
  composerProps: AgentComposerProps;
  labels: AgentGUIViewLabels;
  suggestions: readonly AgentHomeSuggestionCategory[];
  suggestionsCloseLabel?: string;
  onSelectSuggestion: (prompt: string) => void;
  onSelectSuggestionAction?: (action: AgentHomeSuggestionAction) => void;
}

export const AgentGUIEmptyHomePane = memo(function AgentGUIEmptyHomePane({
  provider,
  providerReadinessGate,
  showAllProviders,
  agentTargets,
  selectedAgentTarget,
  onProviderSelect,
  previewMode,
  labels,
  ...heroProps
}: AgentGUIEmptyHomePaneProps): React.JSX.Element {
  "use memo";

  const runtimeProviderLabel =
    labels.emptyProviderForProvider?.(provider) ?? labels.emptyProvider ?? "";
  const providerLabel = selectedAgentTarget
    ? projectAgentGUIAgentTargetName({
        ownerSeparator: labels.sharedAgentOwnerSeparator,
        target: selectedAgentTarget
      }).fullLabel
    : runtimeProviderLabel;
  const baseLabel = labels.emptyForProvider?.(provider) ?? labels.empty;
  const emptyLabel = runtimeProviderLabel
    ? baseLabel.replace(runtimeProviderLabel, providerLabel)
    : baseLabel;
  const avatarPresentations = useMemo(
    () =>
      agentTargets.length
        ? agentTargets.map(projectAgentGUIAgentTargetAvatar)
        : selectedAgentTarget
          ? [projectAgentGUIAgentTargetAvatar(selectedAgentTarget)]
          : [
              createFallbackAgentGUIAgentAvatar({
                provider,
                label: providerLabel
              })
            ],
    [agentTargets, provider, providerLabel, selectedAgentTarget]
  );
  const carouselMountedExternally = avatarPresentations.length > 1;

  return (
    <AgentGUIEmptyHeroCarouselStage
      activeAgentTargetId={
        selectedAgentTarget?.agentTargetId ?? selectedAgentTarget?.targetId
      }
      items={avatarPresentations}
      onProviderSelect={onProviderSelect}
      previewMode={previewMode}
      providerSelectLabel={labels.providerSwitchLabel}
    >
      <AgentTargetSetupGate
        carouselMountedExternally={carouselMountedExternally}
      >
        {providerReadinessGate ? (
          <AgentGUIProviderReadinessGatePane
            provider={provider}
            gate={providerReadinessGate}
            showAllProviders={showAllProviders}
            emptyLabel={emptyLabel}
            agentTargets={agentTargets}
            avatarPresentations={avatarPresentations}
            carouselMountedExternally={carouselMountedExternally}
            onProviderSelect={onProviderSelect}
            providerLabel={providerLabel}
            providerSelectLabel={labels.providerSwitchLabel}
            selectedAgentTarget={selectedAgentTarget}
            labels={labels}
          />
        ) : (
          <AgentGUIEmptyHeroPane
            {...heroProps}
            provider={provider}
            emptyLabel={emptyLabel}
            emptyProvider={providerLabel}
            avatarPresentations={avatarPresentations}
            carouselMountedExternally={carouselMountedExternally}
            onProviderSelect={onProviderSelect}
            agentTargets={agentTargets}
            selectedAgentTarget={selectedAgentTarget}
            providerSelectLabel={labels.providerSwitchLabel}
            sharedAgentOwnerSeparator={labels.sharedAgentOwnerSeparator}
          />
        )}
      </AgentTargetSetupGate>
    </AgentGUIEmptyHeroCarouselStage>
  );
});

interface AgentGUIEmptyHeroPaneProps {
  provider: AgentGUINodeViewModel["shell"]["data"]["provider"];
  emptyLabel: string;
  emptyProvider: string;
  avatarPresentations: readonly AgentGUIAgentAvatarPresentation[];
  carouselMountedExternally?: boolean;
  noticeChrome: AgentGUISessionChrome | null;
  isRespondingApproval: boolean;
  onSubmitApprovalOption: AgentGUINodeViewProps["actions"]["submitApprovalOption"];
  onAuthLogin?: (provider?: string | null) => void;
  onRetryActivation: AgentGUINodeViewProps["actions"]["retryActivation"];
  onContinueInNewConversation: AgentGUINodeViewProps["actions"]["continueInNewConversation"];
  onProviderSelect?: AgentGUINodeViewProps["actions"]["selectHomeComposerAgentTarget"];
  agentTargets: readonly AgentGUIAgentTarget[];
  selectedAgentTarget: AgentGUIAgentTarget | null;
  chromeLabels: ChromeLabels;
  composerProps: AgentComposerProps;
  providerSelectLabel: string;
  sharedAgentOwnerSeparator: string;
  suggestions: readonly AgentHomeSuggestionCategory[];
  suggestionsCloseLabel?: string;
  onSelectSuggestion: (prompt: string) => void;
  onSelectSuggestionAction?: (action: AgentHomeSuggestionAction) => void;
}

export const AgentGUIEmptyHeroPane = memo(function AgentGUIEmptyHeroPane({
  provider,
  emptyLabel,
  emptyProvider,
  avatarPresentations,
  carouselMountedExternally = false,
  noticeChrome,
  isRespondingApproval,
  onSubmitApprovalOption,
  onAuthLogin,
  onRetryActivation,
  onContinueInNewConversation,
  onProviderSelect,
  agentTargets,
  selectedAgentTarget,
  chromeLabels,
  composerProps,
  providerSelectLabel,
  sharedAgentOwnerSeparator,
  suggestions,
  suggestionsCloseLabel,
  onSelectSuggestion,
  onSelectSuggestionAction
}: AgentGUIEmptyHeroPaneProps): React.JSX.Element {
  "use memo";

  const heroAvatarPresentations =
    avatarPresentations.length > 0
      ? avatarPresentations
      : [
          createFallbackAgentGUIAgentAvatar({
            provider,
            label: emptyProvider
          })
        ];
  const heroIconAnimationKey = heroAvatarPresentations
    .map(
      (avatar) =>
        `${avatar.agentTargetId}:${avatar.iconUrl}:${avatar.badge?.iconUrl ?? ""}`
    )
    .join("|");

  return (
    <div className={styles.emptyHero}>
      <div className={styles.emptyHeroBody}>
        <div
          className={styles.emptyHeroIconSlot}
          data-carousel-placeholder={carouselMountedExternally || undefined}
        >
          {carouselMountedExternally ? null : heroAvatarPresentations.length >
            1 ? (
            <AgentGUIHeroAgentCarousel
              activeAgentTargetId={
                selectedAgentTarget?.agentTargetId ??
                selectedAgentTarget?.targetId
              }
              items={heroAvatarPresentations}
              onProviderSelect={onProviderSelect}
              providerSelectLabel={providerSelectLabel}
            />
          ) : (
            <AgentGUIAgentAvatarVisual
              key={heroIconAnimationKey}
              className={styles.emptyHeroIconEffect}
              presentation={heroAvatarPresentations[0]!}
            />
          )}
        </div>
        <h2 className={styles.emptyHeroTitle}>
          <EmptyHeroTitle
            label={emptyLabel}
            providerLabel={emptyProvider}
            providerSelectLabel={providerSelectLabel}
            agentTargets={agentTargets}
            selectedAgentTarget={selectedAgentTarget}
            onProviderSelect={onProviderSelect}
            sharedAgentOwnerSeparator={sharedAgentOwnerSeparator}
          />
        </h2>
        {noticeChrome ? (
          <AgentSessionChrome
            chrome={noticeChrome}
            isRespondingApproval={isRespondingApproval}
            onSubmitApprovalOption={onSubmitApprovalOption}
            onAuthLogin={onAuthLogin}
            onRetryActivation={onRetryActivation}
            onContinueInNewConversation={onContinueInNewConversation}
            labels={chromeLabels}
          />
        ) : null}
        <AgentComposer {...composerProps} />
        <AgentGUIEmptyHeroTuttiToggle composerProps={composerProps} />
        <AgentHomeSuggestions
          categories={suggestions}
          onSelectSuggestion={onSelectSuggestion}
          onSelectAction={onSelectSuggestionAction}
          closeLabel={suggestionsCloseLabel}
        />
      </div>
    </div>
  );
});

/**
 * Prominent Tutti mode entry on the new-conversation hero. It drives the same
 * pre-session draft path as the /tutti slash command (the composer badge
 * lights up in sync, and the first message carries the activation into the
 * created session), so this is purely an additional, discoverable switch.
 */
export function AgentGUIEmptyHeroTuttiToggle({
  composerProps
}: {
  composerProps: AgentComposerProps;
}): React.JSX.Element | null {
  const switchId = useId();
  const onTuttiModeChange = composerProps.onTuttiModeChange;
  // Same host gate as /tutti and the composer badge: omit or enabled:false
  // must not show Tutti Mode chrome on Codex/VM or other shared AgentGUI hosts.
  const tuttiModeEnabled =
    composerProps.capabilityMenuState?.tuttiMode?.enabled === true;
  if (!onTuttiModeChange || !tuttiModeEnabled) {
    return null;
  }
  const active = composerProps.tuttiModeActive === true;
  const updating = composerProps.tuttiModeUpdating === true;
  const label = composerProps.labels.tuttiModeLabel;
  const description = composerProps.labels.tuttiModeDescription;
  return (
    <label
      className={cn(
        "mx-auto flex w-full max-w-[560px] items-center gap-2.5 rounded-xl border px-3 py-2 transition-colors",
        active
          ? "border-[var(--tutti-purple)] bg-[color-mix(in_srgb,var(--tutti-purple)_8%,transparent)]"
          : "border-[var(--line-2)] hover:border-[var(--tutti-purple)]",
        updating ? "cursor-wait opacity-70" : "cursor-pointer"
      )}
      htmlFor={switchId}
      title={description}
      data-testid="agent-gui-hero-tutti-toggle"
    >
      <Sparkles
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          active
            ? "text-[var(--tutti-purple)]"
            : "text-[var(--agent-gui-text-secondary)]"
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="text-[13px] font-medium text-[var(--text-primary)]">
          {label}
        </span>
        {description ? (
          <span className="truncate text-[11px] text-[var(--agent-gui-text-tertiary)]">
            {description}
          </span>
        ) : null}
      </span>
      <Switch
        id={switchId}
        size="sm"
        checked={active}
        disabled={updating}
        aria-label={label}
        data-testid="agent-gui-hero-tutti-toggle-switch"
        onCheckedChange={(checked) => onTuttiModeChange(checked)}
      />
    </label>
  );
}

interface AgentGUIProviderReadinessGatePaneProps {
  provider: AgentGUINodeViewModel["shell"]["data"]["provider"];
  gate: AgentGUIProviderReadinessGate;
  showAllProviders?: boolean;
  emptyLabel: string;
  agentTargets: readonly AgentGUIAgentTarget[];
  avatarPresentations: readonly AgentGUIAgentAvatarPresentation[];
  carouselMountedExternally?: boolean;
  onProviderSelect?: AgentGUINodeViewProps["actions"]["selectHomeComposerAgentTarget"];
  providerLabel: string;
  providerSelectLabel: string;
  selectedAgentTarget: AgentGUIAgentTarget | null;
  labels: Pick<
    AgentGUIViewLabels,
    | "providerGateCheckingTitle"
    | "providerGateCheckingDescription"
    | "providerGateCheckingAgentsDescription"
    | "providerGateInstallTitle"
    | "providerGateInstallDescription"
    | "providerGateInstallAction"
    | "providerGateLoginTitle"
    | "providerGateLoginDescription"
    | "providerGateLoginAction"
    | "providerGateComingSoonTitle"
    | "providerGateComingSoonDescription"
    | "providerGateComingSoonAction"
    | "providerGateUnavailableTitle"
    | "providerGateUnavailableDescription"
    | "providerGateRetryAction"
    | "providerGatePendingInstall"
    | "providerGatePendingLogin"
    | "providerGatePendingRefresh"
    | "sharedAgentOwnerSeparator"
  >;
}

export const AgentGUIProviderReadinessGatePane = memo(
  function AgentGUIProviderReadinessGatePane({
    provider,
    gate,
    showAllProviders = false,
    emptyLabel,
    agentTargets,
    avatarPresentations,
    carouselMountedExternally = false,
    onProviderSelect,
    providerLabel,
    providerSelectLabel,
    selectedAgentTarget,
    labels
  }: AgentGUIProviderReadinessGatePaneProps): React.JSX.Element {
    "use memo";

    const heroAvatarPresentations =
      avatarPresentations.length > 0
        ? avatarPresentations
        : [
            selectedAgentTarget
              ? projectAgentGUIAgentTargetAvatar(selectedAgentTarget)
              : createFallbackAgentGUIAgentAvatar({
                  provider,
                  label: provider
                })
          ];
    const pendingAction = gate.pendingAction ?? null;
    const isPending = pendingAction !== null;
    const showAllProvidersChecking =
      showAllProviders && gate.status === "checking";
    const content = resolveAgentGUIProviderReadinessContent(
      gate.status,
      labels,
      {
        showAllProviders: showAllProvidersChecking
      }
    );
    const titleLabel =
      gate.status === "not_installed" || gate.status === "auth_required"
        ? emptyLabel
        : content.title;
    const action = resolveAgentGUIProviderReadinessAction(gate.status);
    const pendingLabel =
      pendingAction === "install"
        ? labels.providerGatePendingInstall
        : pendingAction === "login"
          ? labels.providerGatePendingLogin
          : pendingAction === "refresh"
            ? labels.providerGatePendingRefresh
            : null;

    return (
      <div className={styles.emptyHero}>
        <div
          className={cn(styles.emptyHeroBody, styles.emptyProviderGate)}
          data-testid="agent-gui-provider-readiness-gate"
          role="status"
        >
          {carouselMountedExternally ? (
            <div
              aria-hidden="true"
              className={styles.emptyHeroCarouselPlaceholder}
            />
          ) : heroAvatarPresentations.length > 1 ? (
            <AgentGUIHeroAgentCarousel
              activeAgentTargetId={
                selectedAgentTarget?.agentTargetId ??
                selectedAgentTarget?.targetId
              }
              items={heroAvatarPresentations}
              onProviderSelect={onProviderSelect}
              providerSelectLabel={providerSelectLabel}
            />
          ) : (
            <AgentGUIAgentAvatarVisual
              className={styles.emptyHeroIconEffect}
              presentation={heroAvatarPresentations[0]!}
            />
          )}
          <h2 className={styles.emptyHeroTitle}>
            <EmptyHeroTitle
              label={titleLabel}
              providerLabel={providerLabel}
              providerSelectLabel={providerSelectLabel}
              agentTargets={agentTargets}
              selectedAgentTarget={selectedAgentTarget}
              onProviderSelect={onProviderSelect}
              sharedAgentOwnerSeparator={labels.sharedAgentOwnerSeparator}
            />
          </h2>
          <p className={styles.emptyProviderGateDescription}>
            {content.description}
          </p>
          {pendingLabel && !action ? (
            <div
              className={styles.emptyProviderGateStatus}
              data-testid="agent-gui-provider-readiness-gate-pending"
            >
              {pendingLabel}
            </div>
          ) : null}
          {action ? (
            <Button
              type="button"
              className={cn(
                styles.emptyProviderGateAction,
                "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]"
              )}
              data-testid="agent-gui-provider-readiness-gate-action"
              disabled={isPending}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                if (isPending) {
                  return;
                }
                gate.onAction?.(provider, action);
              }}
            >
              {isPending && pendingLabel ? pendingLabel : content.actionLabel}
            </Button>
          ) : content.actionLabel ? (
            <Button
              type="button"
              className={cn(
                styles.emptyProviderGateAction,
                "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]"
              )}
              data-testid="agent-gui-provider-readiness-gate-action"
              disabled
              onPointerDown={(event) => event.stopPropagation()}
            >
              {content.actionLabel}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
);

export function AgentGUIUnifiedProviderIcon({
  presentation
}: {
  presentation?: AgentGUIProviderRailAllPresentation | null;
}): React.JSX.Element {
  const iconUrl = presentation?.iconUrl?.trim() || agentColorfulUrl;
  return (
    <span aria-hidden="true" className={styles.providerRailAvatar}>
      <img
        alt=""
        className={styles.providerRailAvatarImage}
        draggable={false}
        src={iconUrl}
      />
    </span>
  );
}

export function AgentGUIProviderIconVisual({
  ariaHidden = false,
  icon,
  imageClassName
}: {
  ariaHidden?: boolean;
  icon: AgentGUIProviderIconPresentation;
  imageClassName: string;
}): React.JSX.Element {
  return (
    <img
      alt=""
      aria-hidden={ariaHidden ? "true" : undefined}
      className={imageClassName}
      draggable={false}
      src={icon.iconUrl}
    />
  );
}

function AgentGUIAgentAvatarVisual({
  className,
  imageClassName,
  presentation
}: {
  className?: string;
  imageClassName?: string;
  presentation: AgentGUIAgentAvatarPresentation;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(styles.agentAvatar, className)}
      data-agent-target-id={presentation.agentTargetId}
    >
      <img
        alt=""
        className={cn(styles.agentAvatarImage, imageClassName)}
        draggable={false}
        src={presentation.iconUrl}
      />
      {presentation.badge?.iconUrl ? (
        <span className={styles.agentAvatarBadge}>
          <img
            alt=""
            className={styles.agentAvatarBadgeImage}
            draggable={false}
            src={presentation.badge.iconUrl}
          />
        </span>
      ) : null}
    </span>
  );
}

function EmptyHeroTitle({
  label,
  providerLabel,
  providerSelectLabel,
  agentTargets = [],
  selectedAgentTarget = null,
  onProviderSelect,
  sharedAgentOwnerSeparator
}: {
  label: string;
  providerLabel: string;
  providerSelectLabel: string;
  agentTargets?: readonly AgentGUIAgentTarget[];
  selectedAgentTarget?: AgentGUIAgentTarget | null;
  onProviderSelect?: AgentGUINodeViewProps["actions"]["selectHomeComposerAgentTarget"];
  sharedAgentOwnerSeparator: string;
}): React.JSX.Element {
  const providerStart = providerLabel ? label.indexOf(providerLabel) : -1;

  if (!shouldEmphasizeEmptyHeroProvider(label) || providerStart < 0) {
    return <>{label}</>;
  }

  const providerEnd = providerStart + providerLabel.length;
  const selectedAgentTargetId =
    selectedAgentTarget?.targetId ??
    `local:${selectedAgentTarget?.provider ?? ""}`;
  const canSwitchProvider =
    agentTargets.length > 1 && selectedAgentTarget && onProviderSelect;
  const providerName = label.slice(providerStart, providerEnd);

  return (
    <>
      {label.slice(0, providerStart)}
      {canSwitchProvider ? (
        <Select
          value={selectedAgentTargetId}
          onValueChange={(nextTargetId) => {
            const target = agentTargets.find(
              (candidate) => candidate.targetId === nextTargetId
            );
            if (!target) {
              return;
            }
            onProviderSelect({
              provider: target.provider,
              agentTargetId: target.targetId
            });
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={providerSelectLabel}
            title={providerSelectLabel}
            className={styles.emptyHeroProviderSelect}
          >
            <AgentGUIAgentTargetName
              className={cn(styles.emptyHeroProvider, "max-w-[240px]")}
              ownerSeparator={sharedAgentOwnerSeparator}
              target={selectedAgentTarget}
            />
          </SelectTrigger>
          <SelectContent
            align="center"
            className={cn(
              styles.composerMenuContent,
              "min-w-[190px] max-w-[min(420px,calc(100vw-32px))]"
            )}
          >
            {agentTargets.map((target) => (
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
                    src={
                      agentGUIProviderRailIconPresentation(
                        target.provider,
                        target.iconUrl
                      ).iconUrl
                    }
                  />
                  <AgentGUIAgentTargetName
                    ownerSeparator={sharedAgentOwnerSeparator}
                    target={target}
                  />
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : selectedAgentTarget ? (
        <AgentGUIAgentTargetName
          className={cn(styles.emptyHeroProvider, "max-w-[240px]")}
          ownerSeparator={sharedAgentOwnerSeparator}
          target={selectedAgentTarget}
        />
      ) : (
        <span className={styles.emptyHeroProvider}>{providerName}</span>
      )}
      {label.slice(providerEnd)}
    </>
  );
}
