import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { AgentGUIAccountMenuState } from "@tutti-os/agent-gui";
import { useService } from "@tutti-os/infra/di";
import { INotificationService } from "@tutti-os/ui-notifications";
import {
  BillingIcon,
  Button,
  CloseIcon,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  CreditsIcon,
  OpenLinkLinedIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SignOutIcon,
  UserLinedIcon
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { useAccountService } from "./useAccountService";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";

const PLAN_ICON_SOURCES = {
  free: new URL("../../../assets/account-plans/star-free.png", import.meta.url)
    .href,
  lite: new URL("../../../assets/account-plans/star-lite.png", import.meta.url)
    .href,
  pro: new URL("../../../assets/account-plans/star-pro.png", import.meta.url)
    .href,
  ultra: new URL(
    "../../../assets/account-plans/star-ultra.png",
    import.meta.url
  ).href
} as const;
const REWARD_TOAST_BG_SOURCE = new URL(
  "../../../assets/account-plans/reward-toast-bg.png",
  import.meta.url
).href;

const debugRegistrationCreditsToastStorageKey =
  "tutti.agentGui.debugRegistrationCreditsToast";
const debugRegistrationCreditsToastID =
  "debug:registrationCreditsToastShown:local";
const registrationCreditsToastAutoDismissMs = 120_000;

export interface WorkspaceAccountMenuProps {
  showLeadingDivider?: boolean;
}

export function WorkspaceAccountMenu({
  showLeadingDivider = true
}: WorkspaceAccountMenuProps = {}) {
  const { state: workspaceSettingsState } = useWorkspaceSettingsService();

  if (workspaceSettingsState.tuttiAgentSwitchEnabled !== true) {
    return null;
  }

  return (
    <WorkspaceAccountMenuEnabled showLeadingDivider={showLeadingDivider} />
  );
}

function WorkspaceAccountMenuEnabled({
  showLeadingDivider
}: Required<WorkspaceAccountMenuProps>) {
  const accountMenuState = useWorkspaceAccountMenuState();
  const labels = useWorkspaceAccountMenuLabels();

  return (
    <WorkspaceAccountMenuView
      accountMenuState={accountMenuState}
      labels={labels}
      showLeadingDivider={showLeadingDivider}
    />
  );
}

type WorkspaceAccountMenuState = AgentGUIAccountMenuState & {
  membershipTierKey: string | null;
};

function useWorkspaceAccountMenuState(): WorkspaceAccountMenuState {
  const { locale, t } = useTranslation();
  const notifications = useService(INotificationService);
  const { service: accountService, state: accountState } = useAccountService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const [
    debugRegistrationCreditsToastEnabled,
    setDebugRegistrationCreditsToastEnabled
  ] = useState(readDebugRegistrationCreditsToastEnabled);

  useEffect(() => {
    void accountService.refreshUserInfo();
    void accountService.refreshProductSummary();
  }, [accountService]);

  return useMemo<WorkspaceAccountMenuState>(() => {
    const summary = accountState.productSummary;
    const summaryUser = summary?.user ?? null;
    const user = summaryUser ?? accountState.user;
    const membershipTierKey = summary?.membership?.tier_key?.trim() || null;
    const membershipLabel =
      summary?.membership?.display_name?.trim() || membershipTierKey || "";
    const creditsLabel = formatCreditsLabel(
      summary?.credits?.available_credits,
      locale
    );
    const debugRegistrationCreditsReward =
      user && debugRegistrationCreditsToastEnabled
        ? {
            id: debugRegistrationCreditsToastID,
            grant_no: "debug-registration-credits-toast",
            credits: 500,
            created_at: new Date().toISOString()
          }
        : null;
    const registrationCreditsReward =
      summary?.registration_credits_reward ?? debugRegistrationCreditsReward;
    const registrationCreditsLabel =
      typeof registrationCreditsReward?.credits === "number" &&
      Number.isFinite(registrationCreditsReward.credits)
        ? new Intl.NumberFormat(locale).format(
            registrationCreditsReward.credits
          )
        : null;
    const links = summary?.links ?? {
      plan_url: "https://tutti.sh/profile/plan",
      usage_url: "https://tutti.sh/profile/usage",
      settings_url: "https://tutti.sh/profile/settings"
    };

    return {
      user: user
        ? {
            userId: user.user_id,
            name: user.name,
            email: user.email,
            avatar: user.avatar
          }
        : null,
      membershipLabel,
      membershipTierKey,
      creditsLabel,
      loading: accountState.productSummaryLoading,
      error: user ? null : accountState.productSummaryError,
      partialError: summary?.partial_error != null,
      registrationCreditsToast:
        registrationCreditsReward && registrationCreditsLabel
          ? {
              id: registrationCreditsReward.id,
              creditsLabel: registrationCreditsLabel,
              visible: true,
              autoDismissMs: registrationCreditsToastAutoDismissMs,
              onDismiss() {
                if (
                  registrationCreditsReward.id ===
                  debugRegistrationCreditsToastID
                ) {
                  clearDebugRegistrationCreditsToast();
                  setDebugRegistrationCreditsToastEnabled(false);
                  return;
                }
                void accountService.dismissRegistrationCreditsReward(
                  registrationCreditsReward.id
                );
              }
            }
          : null,
      links: {
        planUrl: links.plan_url,
        usageUrl: links.usage_url,
        settingsUrl: links.settings_url
      },
      onOpenChange(open) {
        if (open) {
          void accountService.refreshUserInfo();
          void accountService.refreshProductSummary({ force: true });
        }
      },
      onLogin() {
        void accountService.startLogin();
      },
      onLogout() {
        void accountService.logout();
      },
      async onCopyUserId() {
        if (!user?.user_id) {
          return;
        }
        try {
          await navigator.clipboard.writeText(user.user_id);
          notifications.success({
            title: t("workspace.accountMenu.copyUserIdSuccess")
          });
        } catch {
          notifications.error({
            title: t("workspace.accountMenu.copyUserIdFailed")
          });
        }
      },
      onOpenExternal(url) {
        void workbenchHostService.openExternal(url);
      }
    };
  }, [
    accountService,
    accountState.productSummary,
    accountState.productSummaryError,
    accountState.productSummaryLoading,
    accountState.user,
    debugRegistrationCreditsToastEnabled,
    locale,
    notifications,
    t,
    workbenchHostService
  ]);
}

interface WorkspaceAccountMenuLabels {
  title: string;
  member: string;
  creditsBalance: string;
  accountCenter: string;
  free: string;
  signIn: string;
  signOut: string;
  copyUserId: string;
  loading: string;
  unavailable: string;
  dataUnavailable: string;
  rewardToastTitle: string;
  rewardToastDescription: string;
  rewardToastCreditsUnit: string;
  rewardToastClose: string;
}

function useWorkspaceAccountMenuLabels(): WorkspaceAccountMenuLabels {
  const { t } = useTranslation();
  return {
    title: t("workspace.accountMenu.title"),
    member: t("workspace.accountMenu.member"),
    creditsBalance: t("workspace.accountMenu.creditsBalance"),
    accountCenter: t("workspace.accountMenu.accountCenter"),
    free: t("workspace.accountMenu.free"),
    signIn: t("workspace.accountMenu.signIn"),
    signOut: t("workspace.accountMenu.signOut"),
    copyUserId: t("workspace.accountMenu.copyUserId"),
    loading: t("workspace.accountMenu.loading"),
    unavailable: t("workspace.accountMenu.unavailable"),
    dataUnavailable: t("workspace.accountMenu.dataUnavailable"),
    rewardToastTitle: t("workspace.accountMenu.rewardToastTitle"),
    rewardToastDescription: t("workspace.accountMenu.rewardToastDescription"),
    rewardToastCreditsUnit: t("workspace.accountMenu.rewardToastCreditsUnit"),
    rewardToastClose: t("workspace.accountMenu.rewardToastClose")
  };
}

const WorkspaceAccountMenuView = memo(function WorkspaceAccountMenuView({
  accountMenuState,
  labels,
  showLeadingDivider
}: {
  accountMenuState: WorkspaceAccountMenuState;
  labels: WorkspaceAccountMenuLabels;
  showLeadingDivider: boolean;
}) {
  "use memo";
  const userLabel = workspaceAccountUserLabel(accountMenuState, labels);
  const initials = workspaceAccountInitials(userLabel);
  const membershipLabel =
    accountMenuState.membershipLabel.trim() || labels.free;
  const membershipIconSource = resolveMembershipIconSource(
    accountMenuState.membershipTierKey,
    membershipLabel
  );
  const creditsLabel =
    accountMenuState.loading && !accountMenuState.creditsLabel
      ? labels.loading
      : (accountMenuState.creditsLabel ?? labels.unavailable);
  const errorLabel =
    accountMenuState.error ||
    (accountMenuState.partialError ? labels.dataUnavailable : null);
  const openExternal = useCallback(
    (url: string) => {
      accountMenuState.onOpenExternal(url);
    },
    [accountMenuState]
  );

  if (!accountMenuState.user) {
    return (
      <div className="relative flex min-w-0 items-center gap-1.5">
        {showLeadingDivider ? (
          <span
            aria-hidden="true"
            className="h-4 w-px shrink-0 bg-[color-mix(in_srgb,var(--workbench-chrome-foreground)_24%,transparent)]"
          />
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={labels.signIn}
          onClick={accountMenuState.onLogin}
          className="rounded-[4px] px-2.5 text-[13px] font-semibold text-[var(--workbench-chrome-foreground)] [-webkit-app-region:no-drag]"
          data-account-signin-trigger="true"
        >
          {labels.signIn}
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex min-w-0 items-center gap-1.5">
      {accountMenuState.registrationCreditsToast ? (
        <WorkspaceAccountRewardToast
          labels={labels}
          toast={accountMenuState.registrationCreditsToast}
        />
      ) : null}
      {showLeadingDivider ? (
        <span
          aria-hidden="true"
          className="h-4 w-px shrink-0 bg-[color-mix(in_srgb,var(--workbench-chrome-foreground)_24%,transparent)]"
        />
      ) : null}
      <Popover onOpenChange={accountMenuState.onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={userLabel}
            className="relative grid size-8 cursor-pointer place-items-center rounded-full border border-transparent bg-transparent p-0 text-[var(--workbench-chrome-foreground)] shadow-none hover:border-transparent hover:bg-transparent focus-visible:border-transparent focus-visible:bg-transparent active:bg-transparent aria-expanded:bg-transparent aria-expanded:text-[var(--workbench-chrome-foreground)] [-webkit-app-region:no-drag]"
            data-account-menu-trigger="true"
          >
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <span className="grid size-7 place-items-center overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--workbench-chrome-foreground)_16%,transparent)] text-[12px] font-semibold">
                  {accountMenuState.user?.avatar ? (
                    <img
                      alt=""
                      className="size-full object-cover"
                      src={accountMenuState.user.avatar}
                    />
                  ) : (
                    <span aria-hidden="true">{initials}</span>
                  )}
                </span>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={accountMenuState.onCopyUserId}>
                  {labels.copyUserId}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {accountMenuState.user ? (
              <img
                alt=""
                aria-hidden="true"
                draggable={false}
                src={membershipIconSource}
                className="absolute -right-0.5 -bottom-0.5 size-[14px] object-contain"
              />
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={8}
          className="w-[232px] max-w-[calc(100vw-32px)] p-1 text-xs"
          data-testid="workspace-account-menu"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-2 px-2 py-2">
              <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--background-fronted)] text-[13px] font-semibold text-[var(--text-primary)]">
                {accountMenuState.user?.avatar ? (
                  <img
                    alt=""
                    className="size-full object-cover"
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
                <WorkspaceAccountMembershipBadge
                  className="mt-1"
                  iconSource={membershipIconSource}
                  label={membershipLabel}
                />
              </span>
            </div>
            <span
              aria-hidden="true"
              className="mx-2 mb-1 h-px bg-[var(--border-1)]"
            />
            {accountMenuState.user ? (
              <>
                <button
                  type="button"
                  className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={() => openExternal(accountMenuState.links.usageUrl)}
                >
                  <CreditsIcon
                    aria-hidden="true"
                    className="shrink-0"
                    size={15}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.creditsBalance}
                  </span>
                  <span className="truncate text-[var(--text-secondary)]">
                    {creditsLabel}
                  </span>
                </button>
                <button
                  type="button"
                  className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={() => openExternal(accountMenuState.links.planUrl)}
                >
                  <BillingIcon
                    aria-hidden="true"
                    className="shrink-0"
                    size={15}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.member}
                  </span>
                  <OpenLinkLinedIcon
                    aria-hidden="true"
                    className="text-[var(--text-secondary)]"
                    size={14}
                  />
                </button>
                <button
                  type="button"
                  className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={() =>
                    openExternal(accountMenuState.links.settingsUrl)
                  }
                >
                  <UserLinedIcon aria-hidden="true" size={15} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.accountCenter}
                  </span>
                  <OpenLinkLinedIcon
                    aria-hidden="true"
                    className="text-[var(--text-secondary)]"
                    size={14}
                  />
                </button>
                {accountMenuState.onLogout ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="mx-2 my-1 h-px bg-[var(--border-1)]"
                    />
                    <button
                      type="button"
                      className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                      onClick={accountMenuState.onLogout}
                    >
                      <SignOutIcon
                        aria-hidden="true"
                        className="shrink-0"
                        size={15}
                      />
                      <span className="truncate">{labels.signOut}</span>
                    </button>
                  </>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                onClick={accountMenuState.onLogin}
              >
                <OpenLinkLinedIcon aria-hidden="true" size={15} />
                <span className="truncate">{labels.signIn}</span>
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

function WorkspaceAccountMembershipBadge({
  iconSource,
  label,
  className
}: {
  iconSource: string;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 text-[11px] font-semibold leading-3 text-[var(--text-primary)]",
        className
      )}
      data-account-membership-badge="true"
    >
      <img
        alt=""
        aria-hidden="true"
        className="size-3 shrink-0"
        draggable={false}
        src={iconSource}
      />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

function resolveMembershipIconSource(
  tierKey: string | null,
  label: string
): string {
  const normalized = `${tierKey ?? ""} ${label}`.toLowerCase();
  if (normalized.includes("ultra")) {
    return PLAN_ICON_SOURCES.ultra;
  }
  if (normalized.includes("pro")) {
    return PLAN_ICON_SOURCES.pro;
  }
  if (normalized.includes("lite") || normalized.includes("basic")) {
    return PLAN_ICON_SOURCES.lite;
  }
  return PLAN_ICON_SOURCES.free;
}

function WorkspaceAccountRewardToast({
  labels,
  toast
}: {
  labels: WorkspaceAccountMenuLabels;
  toast: NonNullable<AgentGUIAccountMenuState["registrationCreditsToast"]>;
}) {
  useEffect(() => {
    if (!toast.visible || !toast.autoDismissMs) {
      return;
    }
    const timer = window.setTimeout(() => {
      toast.onDismiss();
    }, toast.autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!toast.visible) {
    return null;
  }

  return (
    <div
      className="absolute top-[calc(100%+8px)] right-0 z-50 w-[220px] overflow-hidden rounded-[12px] border border-[var(--tutti-purple-border)] bg-cover bg-center bg-no-repeat p-2 shadow-lg"
      style={{ backgroundImage: `url(${REWARD_TOAST_BG_SOURCE})` }}
    >
      <div className="relative rounded-[8px] bg-[var(--background-fronted)] p-3 text-[var(--text-primary)]">
        <Button
          aria-label={labels.rewardToastClose}
          className="absolute top-1.5 right-1.5 size-6 rounded-full text-[var(--text-secondary)]"
          onClick={toast.onDismiss}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <CloseIcon className="size-4" />
        </Button>
        <div className="pr-5 text-[13px] font-semibold">
          {labels.rewardToastTitle}
        </div>
        <div className="mt-1 text-[12px] leading-4 text-[var(--text-secondary)]">
          <span className="text-[var(--tutti-purple)]">
            {toast.creditsLabel} {labels.rewardToastCreditsUnit}
          </span>
          <br />
          {labels.rewardToastDescription}
        </div>
      </div>
    </div>
  );
}

function workspaceAccountUserLabel(
  accountMenuState: AgentGUIAccountMenuState,
  labels: Pick<WorkspaceAccountMenuLabels, "title">
): string {
  const user = accountMenuState.user;
  return (
    user?.name?.trim() ||
    user?.email?.trim() ||
    user?.userId?.trim() ||
    labels.title
  );
}

function formatCreditsLabel(
  value: number | string | null | undefined,
  locale: string
): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? new Intl.NumberFormat(locale).format(value)
      : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat(locale).format(numeric)
    : trimmed;
}

function workspaceAccountInitials(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return "T";
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return trimmed.slice(0, 1).toUpperCase();
}

function readDebugRegistrationCreditsToastEnabled(): boolean {
  try {
    return (
      window.localStorage.getItem(debugRegistrationCreditsToastStorageKey) ===
      "1"
    );
  } catch {
    return false;
  }
}

function clearDebugRegistrationCreditsToast(): void {
  try {
    window.localStorage.removeItem(debugRegistrationCreditsToastStorageKey);
  } catch {
    // Ignore storage access failures; this is a local debug-only switch.
  }
}
