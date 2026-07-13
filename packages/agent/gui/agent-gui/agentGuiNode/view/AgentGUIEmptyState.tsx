import { memo, useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
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
import { AgentSessionChrome } from "../AgentSessionChrome";
import { AgentComposer, type AgentComposerProps } from "../AgentComposer";
import { AgentHomeSuggestions } from "../AgentHomeSuggestions";
import type {
  AgentHomeSuggestionAction,
  AgentHomeSuggestionCategory,
  AgentGUINodeViewModel,
  AgentGUISessionChrome
} from "../model/agentGuiNodeTypes";
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import type { ChromeLabels } from "./AgentGUIDetailHeader";
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

export function agentGUIProviderIconPresentation(
  provider: string | undefined,
  iconUrl?: string | null
): AgentGUIProviderIconPresentation {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  const providerRailIconUrl =
    MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS[normalizedProvider] ?? null;
  return {
    provider: normalizedProvider,
    iconUrl:
      (normalizedProvider === "cursor" ? providerRailIconUrl : null) ||
      iconUrl?.trim() ||
      resolveAgentGUIHeroIconUrl(normalizedProvider)
  };
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
      (normalizedProvider === "cursor" ? providerRailIconUrl : null) ||
      iconUrl?.trim() ||
      providerRailIconUrl ||
      resolveAgentGUIHeroIconUrl(normalizedProvider)
  };
}

export function shouldEmphasizeEmptyHeroProvider(label: string): boolean {
  return label.trim().length > 0;
}

export function agentGUILaunchpadIconPresentations(): readonly AgentGUIProviderIconPresentation[] {
  return [
    agentGUIProviderRailIconPresentation("codex"),
    agentGUIProviderRailIconPresentation("claude-code"),
    agentGUIProviderRailIconPresentation("cursor"),
    agentGUIProviderRailIconPresentation("tutti")
  ];
}

export const EMPTY_HOME_SUGGESTIONS: readonly AgentHomeSuggestionCategory[] =
  Object.freeze([]);

interface AgentGUIEmptyHeroPaneProps {
  provider: AgentGUINodeViewModel["shell"]["data"]["provider"];
  emptyLabel: string;
  emptyProvider: string;
  iconPresentations: readonly AgentGUIProviderIconPresentation[];
  inlineNoticeChrome: AgentGUISessionChrome | null;
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
  suggestions: readonly AgentHomeSuggestionCategory[];
  suggestionsCloseLabel?: string;
  onSelectSuggestion: (prompt: string) => void;
  onSelectSuggestionAction?: (action: AgentHomeSuggestionAction) => void;
}

export const AgentGUIEmptyHeroPane = memo(function AgentGUIEmptyHeroPane({
  provider,
  emptyLabel,
  emptyProvider,
  iconPresentations,
  inlineNoticeChrome,
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
  suggestions,
  suggestionsCloseLabel,
  onSelectSuggestion,
  onSelectSuggestionAction
}: AgentGUIEmptyHeroPaneProps): React.JSX.Element {
  "use memo";

  const heroIconPresentations =
    iconPresentations.length > 0
      ? iconPresentations
      : [agentGUIProviderIconPresentation(provider)];
  const heroIconAnimationKey = heroIconPresentations
    .map((icon) => `${icon.provider}:${icon.iconUrl}`)
    .join("|");

  return (
    <div className={styles.emptyHero}>
      <div className={styles.emptyHeroBody}>
        <div className={styles.emptyHeroIconSlot}>
          {heroIconPresentations.length > 1 ? (
            <AgentGUIAllProviderGridIcon
              key={heroIconAnimationKey}
              activeProvider={provider}
              className={styles.agentAvatar}
              icons={heroIconPresentations}
            />
          ) : (
            <AgentGUIProviderIconVisual
              key={heroIconAnimationKey}
              ariaHidden
              imageClassName={styles.emptyHeroIconEffect}
              icon={heroIconPresentations[0]!}
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
          />
        </h2>
        {inlineNoticeChrome ? (
          <AgentSessionChrome
            chrome={inlineNoticeChrome}
            isRespondingApproval={isRespondingApproval}
            onSubmitApprovalOption={onSubmitApprovalOption}
            onAuthLogin={onAuthLogin}
            onRetryActivation={onRetryActivation}
            onContinueInNewConversation={onContinueInNewConversation}
            labels={chromeLabels}
          />
        ) : null}
        <AgentComposer {...composerProps} />
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

interface AgentGUIProviderReadinessGatePaneProps {
  provider: AgentGUINodeViewModel["shell"]["data"]["provider"];
  gate: AgentGUIProviderReadinessGate;
  showAllProviders?: boolean;
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
  >;
}

export const AgentGUIProviderReadinessGatePane = memo(
  function AgentGUIProviderReadinessGatePane({
    provider,
    gate,
    showAllProviders = false,
    labels
  }: AgentGUIProviderReadinessGatePaneProps): React.JSX.Element {
    "use memo";

    const heroIconUrl = resolveAgentGUIHeroIconUrl(provider);
    const launchpadIconPresentations = useMemo(
      () => agentGUILaunchpadIconPresentations(),
      []
    );
    const pendingAction = gate.pendingAction ?? null;
    const isPending = pendingAction !== null;
    const showAllProvidersChecking =
      showAllProviders && gate.status === "checking";
    const content = providerGateContent(gate.status, labels, {
      showAllProviders: showAllProvidersChecking
    });
    const action = providerGateAction(gate.status);
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
          {showAllProvidersChecking ? (
            <AgentGUIAllProviderGridIcon
              className={styles.agentAvatar}
              icons={launchpadIconPresentations}
            />
          ) : (
            <img
              aria-hidden="true"
              className={styles.emptyHeroIconEffect}
              draggable={false}
              src={heroIconUrl}
              alt=""
            />
          )}
          <h2 className={styles.emptyHeroTitle}>{content.title}</h2>
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

function providerGateContent(
  status: AgentGUIProviderReadinessGate["status"],
  labels: AgentGUIProviderReadinessGatePaneProps["labels"],
  options: { showAllProviders?: boolean } = {}
): { title: string; description: string; actionLabel?: string } {
  switch (status) {
    case "checking":
      return {
        title: labels.providerGateCheckingTitle,
        description:
          options.showAllProviders === true
            ? labels.providerGateCheckingAgentsDescription
            : labels.providerGateCheckingDescription
      };
    case "not_installed":
      return {
        title: labels.providerGateInstallTitle,
        description: labels.providerGateInstallDescription,
        actionLabel: labels.providerGateInstallAction
      };
    case "auth_required":
      return {
        title: labels.providerGateLoginTitle,
        description: labels.providerGateLoginDescription,
        actionLabel: labels.providerGateLoginAction
      };
    case "coming_soon":
      return {
        title: labels.providerGateComingSoonTitle,
        description: labels.providerGateComingSoonDescription,
        actionLabel: labels.providerGateComingSoonAction
      };
    case "unavailable":
      return {
        title: labels.providerGateUnavailableTitle,
        description: labels.providerGateUnavailableDescription,
        actionLabel: labels.providerGateRetryAction
      };
  }
}

function providerGateAction(
  status: AgentGUIProviderReadinessGate["status"]
): AgentGUIProviderReadinessGate["pendingAction"] {
  switch (status) {
    case "not_installed":
      return "install";
    case "auth_required":
      return "login";
    case "unavailable":
      return "refresh";
    case "coming_soon":
    case "checking":
      return null;
  }
}

export function AgentGUIAllProviderGridIcon({
  activeProvider,
  className,
  icons
}: {
  activeProvider?: string;
  className?: string;
  icons: readonly AgentGUIProviderIconPresentation[];
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={[styles.providerRailAvatar, className]
        .filter(Boolean)
        .join(" ")}
    >
      <AgentGUILaunchpadIconGrid
        activeProvider={activeProvider}
        icons={icons}
      />
    </span>
  );
}

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

function AgentGUILaunchpadIconGrid({
  activeProvider,
  icons
}: {
  activeProvider?: string;
  icons: readonly AgentGUIProviderIconPresentation[];
}): React.JSX.Element {
  const normalizedActiveProvider = activeProvider
    ? normalizeManagedAgentProvider(activeProvider)
    : null;
  return (
    <span aria-hidden="true" className={styles.agentAvatar}>
      {icons.map((icon) => {
        return (
          <span
            key={`${icon.provider}:${icon.iconUrl}`}
            className={styles.agentAvatar}
            data-provider-active={
              normalizedActiveProvider === null
                ? undefined
                : normalizeManagedAgentProvider(icon.provider) ===
                  normalizedActiveProvider
            }
          >
            <AgentGUIProviderIconVisual imageClassName="" icon={icon} />
          </span>
        );
      })}
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

function EmptyHeroTitle({
  label,
  providerLabel,
  providerSelectLabel,
  agentTargets = [],
  selectedAgentTarget = null,
  onProviderSelect
}: {
  label: string;
  providerLabel: string;
  providerSelectLabel: string;
  agentTargets?: readonly AgentGUIAgentTarget[];
  selectedAgentTarget?: AgentGUIAgentTarget | null;
  onProviderSelect?: AgentGUINodeViewProps["actions"]["selectHomeComposerAgentTarget"];
}): React.JSX.Element {
  const providerStart = providerLabel ? label.indexOf(providerLabel) : -1;

  if (!shouldEmphasizeEmptyHeroProvider(label) || providerStart < 0) {
    return <>{label}</>;
  }

  const providerEnd = providerStart + providerLabel.length;
  const selectedAgentTargetId =
    selectedAgentTarget?.targetId ??
    `local:${selectedAgentTarget?.provider ?? ""}`;
  const enabledProviderTargets = agentTargets.filter(
    (target) => target.disabled !== true
  );
  const canSwitchProvider =
    enabledProviderTargets.length > 1 &&
    selectedAgentTarget &&
    onProviderSelect;
  const providerName = label.slice(providerStart, providerEnd);

  return (
    <>
      {label.slice(0, providerStart)}
      {canSwitchProvider ? (
        <Select
          value={selectedAgentTargetId}
          onValueChange={(nextTargetId) => {
            const target = enabledProviderTargets.find(
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
            <span className={styles.emptyHeroProvider}>{providerName}</span>
          </SelectTrigger>
          <SelectContent
            align="center"
            className={cn(styles.composerMenuContent, "min-w-[190px]")}
          >
            {enabledProviderTargets.map((target) => (
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
                  <span className="min-w-0 truncate">{target.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className={styles.emptyHeroProvider}>{providerName}</span>
      )}
      {label.slice(providerEnd)}
    </>
  );
}
