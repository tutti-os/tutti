import { memo, useCallback, useEffect } from "react";
import {
  Coins,
  Crown,
  ExternalLink,
  Gift,
  LogIn,
  LogOut,
  Settings,
  Wrench,
  X
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@tutti-os/ui-system";
import { AccountMembershipBadge } from "../AccountMembershipBadge";
import { AgentProbeUsageFreshness } from "../AgentProbeUsageFreshness";
import { AgentUsageMeter } from "../AgentUsageMeter";
import { SettingsLinedIcon } from "../../../app/renderer/components/icons/SettingsLinedIcon";
import styles from "../AgentGUINode.styles";
import type { AgentGUIAccountMenuState } from "../accountMenuState";
import type { AgentComposerSlashStatusLimit } from "../AgentComposer";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";

interface AgentGUIAccountRailMenuProps {
  accountMenuState: AgentGUIAccountMenuState;
  labels: AgentGUIViewLabels;
  previewMode: boolean;
}

interface AgentGUIAccountRewardToastProps {
  toast: NonNullable<AgentGUIAccountMenuState["registrationCreditsToast"]>;
  labels: Pick<
    AgentGUIViewLabels,
    | "accountRewardToastTitle"
    | "accountRewardToastCreditsUnit"
    | "accountRewardToastDescription"
    | "accountRewardToastClose"
  >;
}

const accountRewardToastAutoDismissMs = 120_000;

const AgentGUIAccountRewardToast = memo(function AgentGUIAccountRewardToast({
  toast,
  labels
}: AgentGUIAccountRewardToastProps): React.JSX.Element | null {
  "use memo";
  useEffect(() => {
    if (!toast.visible) {
      return;
    }
    // timing: auto-dismiss the reward toast after its configured display duration
    const timeout = window.setTimeout(
      toast.onDismiss,
      toast.autoDismissMs ?? accountRewardToastAutoDismissMs
    );
    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast.autoDismissMs, toast.onDismiss, toast.visible]);

  if (!toast.visible) {
    return null;
  }

  return (
    <div
      className="agent-gui-node__account-reward-toast nodrag relative mx-3 mb-1 w-[calc(100%-24px)] max-w-[calc(100%-24px)] overflow-hidden rounded-[14px] p-2.5 pr-9 text-white [-webkit-app-region:no-drag]"
      data-testid="agent-gui-account-reward-toast"
      role="status"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/90 to-transparent" />
      <div className="relative flex min-w-0 items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[rgba(250,255,236,0.78)] text-emerald-400 shadow-[0_9px_18px_rgba(20,184,166,0.18),0_0_0_1px_rgba(255,255,255,0.5)_inset]">
          <Gift aria-hidden="true" size={23} strokeWidth={2} />
        </span>
        <span
          aria-hidden="true"
          className="absolute left-[40px] top-0 h-2 w-2 rounded-full bg-white/85 shadow-[0_0_10px_rgba(255,255,255,0.7)]"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold leading-4 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.22)]">
            {labels.accountRewardToastTitle}
          </span>
          <span className="block truncate text-[20px] font-semibold leading-6 text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.22)]">
            +{toast.creditsLabel} {labels.accountRewardToastCreditsUnit}
          </span>
          <span className="block truncate text-[11px] font-medium leading-4 text-white/88 drop-shadow-[0_1px_3px_rgba(0,0,0,0.18)]">
            {labels.accountRewardToastDescription}
          </span>
        </span>
      </div>
      <button
        type="button"
        aria-label={labels.accountRewardToastClose}
        className="nodrag absolute right-2.5 top-2.5 grid h-6 w-6 place-items-center rounded-[7px] text-white/85 hover:bg-white/18 hover:text-white [-webkit-app-region:no-drag]"
        onClick={toast.onDismiss}
      >
        <X aria-hidden="true" size={16} strokeWidth={2} />
      </button>
    </div>
  );
});

export const AgentGUIAccountRailMenu = memo(function AgentGUIAccountRailMenu({
  accountMenuState,
  labels,
  previewMode
}: AgentGUIAccountRailMenuProps): React.JSX.Element {
  "use memo";
  const userLabel = agentGUIAccountUserLabel(accountMenuState, labels);
  const initials = agentGUIAccountInitials(userLabel);
  const membershipLabel =
    accountMenuState.membershipLabel.trim() || labels.accountMenuFree;
  const creditsLabel =
    accountMenuState.loading && !accountMenuState.creditsLabel
      ? labels.accountMenuLoading
      : (accountMenuState.creditsLabel ?? labels.accountMenuUnavailable);
  const errorLabel =
    accountMenuState.error ||
    (accountMenuState.partialError ? labels.accountMenuDataUnavailable : null);
  const openExternal = useCallback(
    (url: string) => {
      accountMenuState.onOpenExternal(url);
    },
    [accountMenuState]
  );
  return (
    <div className="flex min-w-0 flex-col">
      {accountMenuState.registrationCreditsToast ? (
        <AgentGUIAccountRewardToast
          labels={labels}
          toast={accountMenuState.registrationCreditsToast}
        />
      ) : null}
      <Popover onOpenChange={accountMenuState.onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={userLabel}
            className="nodrag mx-2 mt-2 flex min-h-12 w-[calc(100%-16px)] min-w-0 items-center gap-2 rounded-[8px] px-2 text-left text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] disabled:opacity-50 [-webkit-app-region:no-drag]"
            data-account-menu-trigger="true"
            disabled={previewMode}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--background-fronted)] text-[13px] font-semibold">
              {accountMenuState.user?.avatar ? (
                <img
                  alt=""
                  className="h-full w-full object-cover"
                  src={accountMenuState.user.avatar}
                />
              ) : (
                <span aria-hidden="true">{initials}</span>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-4">
                {userLabel}
              </span>
              <AccountMembershipBadge
                className="mt-0.5"
                label={membershipLabel}
              />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="end"
          sideOffset={8}
          className="w-[232px] max-w-[calc(100vw-32px)] p-1 text-xs"
          data-testid="agent-gui-account-menu"
        >
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-2 px-2 py-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[8px] bg-[var(--background-fronted)] text-[13px] font-semibold text-[var(--text-primary)]">
                {accountMenuState.user?.avatar ? (
                  <img
                    alt=""
                    className="h-full w-full object-cover"
                    src={accountMenuState.user.avatar}
                  />
                ) : (
                  initials
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">
                  {userLabel}
                </span>
                <AccountMembershipBadge
                  className="mt-1"
                  label={membershipLabel}
                />
              </span>
            </div>
            <span
              aria-hidden="true"
              className="mx-2 h-px bg-[var(--border-1)]"
            />
            {accountMenuState.user ? (
              <>
                <button
                  type="button"
                  className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={() => openExternal(accountMenuState.links.planUrl)}
                >
                  <Crown aria-hidden="true" size={15} strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.accountMenuMember}
                  </span>
                  <span className="shrink-0 rounded-[6px] bg-[color-mix(in_srgb,var(--tutti-purple)_24%,transparent)] px-2 py-0.5 text-[12px] font-semibold text-[var(--tutti-purple)]">
                    {labels.accountMenuUpgrade}
                  </span>
                </button>
                <button
                  type="button"
                  className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={() => openExternal(accountMenuState.links.usageUrl)}
                >
                  <Coins aria-hidden="true" size={15} strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.accountMenuCreditsBalance}
                  </span>
                  <span className="truncate text-[var(--text-secondary)]">
                    {creditsLabel}
                  </span>
                </button>
                <button
                  type="button"
                  className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={() =>
                    openExternal(accountMenuState.links.settingsUrl)
                  }
                >
                  <Settings aria-hidden="true" size={15} strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.accountMenuAccountCenter}
                  </span>
                  <ExternalLink
                    aria-hidden="true"
                    size={14}
                    strokeWidth={1.8}
                  />
                </button>
                {accountMenuState.onSettings ? (
                  <button
                    type="button"
                    className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                    onClick={accountMenuState.onSettings}
                  >
                    <Settings aria-hidden="true" size={15} strokeWidth={1.8} />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {labels.accountMenuSettings}
                    </span>
                  </button>
                ) : null}
                {accountMenuState.onLogout ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="mx-2 my-1 h-px bg-[var(--border-1)]"
                    />
                    <button
                      type="button"
                      className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                      onClick={accountMenuState.onLogout}
                    >
                      <LogOut aria-hidden="true" size={15} strokeWidth={1.8} />
                      <span className="truncate">
                        {labels.accountMenuSignOut}
                      </span>
                    </button>
                  </>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                onClick={accountMenuState.onLogin}
              >
                <LogIn aria-hidden="true" size={15} strokeWidth={1.8} />
                <span className="truncate">{labels.accountMenuSignIn}</span>
              </button>
            )}
            {errorLabel ? (
              <span className="px-2 py-1 text-[11px] leading-4 text-[var(--text-danger)]">
                {errorLabel}
              </span>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});

function agentGUIAccountUserLabel(
  accountMenuState: AgentGUIAccountMenuState,
  labels: Pick<AgentGUIViewLabels, "accountMenuTitle">
): string {
  const user = accountMenuState.user;
  return (
    user?.name?.trim() ||
    user?.email?.trim() ||
    user?.userId?.trim() ||
    labels.accountMenuTitle
  );
}

function agentGUIAccountInitials(label: string): string {
  const normalized = label.trim();
  if (!normalized) {
    return "T";
  }
  return normalized.slice(0, 2).toUpperCase();
}

interface AgentGUIConfigMenuProps {
  labels: AgentGUIViewLabels;
  previewMode: boolean;
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading: boolean;
  slashStatusUsageCapturedAtUnixMs: number | null;
  slashStatusUsageDidFail: boolean;
  slashStatusUsageAttempted: boolean;
  providerAuthAccountLabel?: string | null;
  onAgentConfigMenuOpen?: () => void;
  onAgentUsageRefresh?: () => void;
  onOpenAgentEnvSetup: () => void;
  onOpenAgentSettings: () => void;
}

export function AgentGUIConfigMenu({
  labels,
  previewMode,
  slashStatusLimits,
  slashStatusLimitsLoading,
  slashStatusUsageCapturedAtUnixMs,
  slashStatusUsageDidFail,
  slashStatusUsageAttempted,
  providerAuthAccountLabel,
  onAgentConfigMenuOpen,
  onAgentUsageRefresh,
  onOpenAgentEnvSetup,
  onOpenAgentSettings
}: AgentGUIConfigMenuProps): React.JSX.Element {
  return (
    <Popover
      onOpenChange={(open) => {
        // Refresh the underlying probe on open, the same way the window-title
        // info tooltip does; otherwise a stale/empty fetch can sit here until
        // something unrelated refreshes it.
        if (open) {
          onAgentConfigMenuOpen?.();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={labels.agentConfig}
          className={`${styles.providerRailConfigButton} nodrag tsh-desktop-no-drag`}
          title={labels.agentConfig}
          disabled={previewMode}
        >
          <SettingsLinedIcon aria-hidden="true" width={18} height={18} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        className="w-[300px] max-w-[calc(100vw-32px)] gap-3 p-1 text-xs"
        data-testid="agent-gui-config-menu"
      >
        <div className="flex min-w-0 flex-col gap-3">
          {providerAuthAccountLabel ? (
            <>
              <div className="flex min-w-0 flex-col gap-2 p-2">
                <span className="text-[13px] font-semibold leading-4">
                  {labels.slashStatusAccount}
                </span>
                <span className="text-[13px] leading-5 text-[var(--text-secondary)]">
                  {providerAuthAccountLabel}
                </span>
              </div>
              {slashStatusLimits.length > 0 ||
              slashStatusUsageAttempted ||
              slashStatusLimitsLoading ? (
                <div className="px-2">
                  <span className="block h-px bg-[var(--border-1)]" />
                </div>
              ) : null}
            </>
          ) : null}
          {slashStatusLimits.length > 0 ||
          slashStatusUsageAttempted ||
          slashStatusLimitsLoading ? (
            <>
              <div className="flex min-w-0 flex-col gap-2 p-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] font-semibold leading-4">
                    {labels.slashStatusLimits}
                  </span>
                  <AgentProbeUsageFreshness
                    testId="agent-gui-config-usage-refresh"
                    capturedAtUnixMs={slashStatusUsageCapturedAtUnixMs}
                    isLoading={slashStatusLimitsLoading}
                    didFail={slashStatusUsageDidFail}
                    disabled={previewMode || !onAgentUsageRefresh}
                    onRefresh={() => onAgentUsageRefresh?.()}
                    labels={{
                      justUpdated: labels.slashStatusUsageJustUpdated,
                      minutesAgo: labels.slashStatusUsageMinutesAgo,
                      hoursAgo: labels.slashStatusUsageHoursAgo,
                      updating: labels.slashStatusUsageUpdating,
                      refreshFailed: labels.slashStatusUsageRefreshFailed,
                      refreshAria: labels.slashStatusUsageRefreshAria
                    }}
                  />
                </div>
                {slashStatusLimits.length > 0 ? (
                  slashStatusLimits.map((limit) => (
                    <AgentUsageMeter
                      key={limit.id}
                      label={limit.label}
                      value={`${limit.value}${limit.reset ? ` (${limit.reset})` : ""}`}
                      percent={
                        typeof limit.percentRemaining === "number" &&
                        Number.isFinite(limit.percentRemaining)
                          ? limit.percentRemaining
                          : null
                      }
                    />
                  ))
                ) : slashStatusLimitsLoading ? null : (
                  <span
                    className="text-[var(--text-tertiary)]"
                    data-testid="agent-gui-config-usage-unavailable"
                  >
                    {labels.slashStatusLimitsUnavailable}
                  </span>
                )}
              </div>
              <div className="px-2">
                <span className="block h-px bg-[var(--border-1)]" />
              </div>
            </>
          ) : null}
          <div className="flex min-w-0 flex-col gap-1">
            <button
              type="button"
              data-testid="agent-gui-config-settings"
              className="nodrag flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:text-[var(--text-tertiary)] [-webkit-app-region:no-drag]"
              disabled={previewMode}
              onClick={() => onOpenAgentSettings()}
            >
              <SettingsLinedIcon aria-hidden="true" width={16} height={16} />
              <span>{labels.agentSettingsMenu}</span>
            </button>
            <button
              type="button"
              data-testid="agent-gui-config-env-setup"
              className="nodrag flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:text-[var(--text-tertiary)] [-webkit-app-region:no-drag]"
              disabled={previewMode}
              onClick={() => onOpenAgentEnvSetup()}
            >
              <Wrench aria-hidden="true" size={16} strokeWidth={1.8} />
              <span>{labels.agentEnvSetup}</span>
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
