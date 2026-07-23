import { memo, useEffect, useMemo, useState } from "react";
import {
  AgentGUIAccountAvatar,
  AgentGUIAccountMenu,
  AgentGUIAccountRewardToast,
  agentGUIAccountInitials,
  type AgentGUIAccountMenuLabels,
  type AgentGUIAccountMenuState
} from "@tutti-os/agent-gui";
import { useService } from "@tutti-os/infra/di";
import { INotificationService } from "@tutti-os/ui-notifications";
import { Button } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { useAccountService } from "./useAccountService";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";

const debugRegistrationCreditsToastStorageKey =
  "tutti.agentGui.debugRegistrationCreditsToast";
const debugRegistrationCreditsToastID =
  "debug:registrationCreditsToastShown:local";
const registrationCreditsToastAutoDismissMs = 120_000;
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
    const membershipLabel =
      summary?.membership?.display_name?.trim() ||
      summary?.membership?.tier_key?.trim() ||
      "";
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
      membershipAccess: summary?.membership_access ?? "unknown",
      membershipTierKey: summary?.membership?.tier_key?.trim() || null,
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
        planUrl: summary?.links.plan_url ?? "",
        usageUrl: summary?.links.usage_url ?? "",
        settingsUrl: summary?.links.settings_url ?? ""
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
        if (url.trim()) {
          void workbenchHostService.openExternal(url);
        }
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

type WorkspaceAccountMenuLabels = AgentGUIAccountMenuLabels & {
  rewardToastTitle: string;
  rewardToastDescription: string;
  rewardToastCreditsUnit: string;
  rewardToastClose: string;
};

function useWorkspaceAccountMenuLabels(): WorkspaceAccountMenuLabels {
  const { t } = useTranslation();
  return {
    title: t("workspace.accountMenu.title"),
    member: t("workspace.accountMenu.member"),
    upgradeMembership: t("workspace.accountMenu.upgradeMembership"),
    rechargeCredits: t("workspace.accountMenu.rechargeCredits"),
    viewCreditPlans: t("workspace.accountMenu.viewCreditPlans"),
    creditsBalance: t("workspace.accountMenu.creditsBalance"),
    accountCenter: t("workspace.accountMenu.accountCenter"),
    settings: t("workspace.accountMenu.settings"),
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
  const userLabel =
    accountMenuState.user?.name?.trim() ||
    accountMenuState.user?.email?.trim() ||
    accountMenuState.user?.userId?.trim() ||
    labels.title;
  const initials = agentGUIAccountInitials(userLabel);
  const membershipIconSource = resolveMembershipIconSource(
    accountMenuState.membershipTierKey,
    accountMenuState.membershipLabel
  );

  if (!accountMenuState.user) {
    return (
      <div className="relative flex min-w-0 items-center gap-1.5">
        {showLeadingDivider ? <WorkspaceAccountMenuDivider /> : null}
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
        <div className="absolute right-0 top-10 z-50 w-[280px]">
          <AgentGUIAccountRewardToast
            toast={accountMenuState.registrationCreditsToast}
            labels={{
              accountRewardToastTitle: labels.rewardToastTitle,
              accountRewardToastDescription: labels.rewardToastDescription,
              accountRewardToastCreditsUnit: labels.rewardToastCreditsUnit,
              accountRewardToastClose: labels.rewardToastClose
            }}
          />
        </div>
      ) : null}
      {showLeadingDivider ? <WorkspaceAccountMenuDivider /> : null}
      <AgentGUIAccountMenu
        state={accountMenuState}
        labels={labels}
        trigger={
          <button
            type="button"
            aria-label={userLabel}
            className="relative grid size-8 cursor-pointer place-items-center rounded-full border border-transparent bg-transparent p-0 text-[var(--workbench-chrome-foreground)] shadow-none hover:bg-transparent [-webkit-app-region:no-drag]"
            data-account-menu-trigger="true"
          >
            <AgentGUIAccountAvatar
              state={accountMenuState}
              label={labels.copyUserId}
            >
              <span
                className="grid size-7 place-items-center overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--workbench-chrome-foreground)_16%,transparent)] text-[12px] font-semibold"
                data-testid="workspace-account-avatar"
              >
                {accountMenuState.user.avatar ? (
                  <img
                    alt=""
                    className="size-full object-cover"
                    src={accountMenuState.user.avatar}
                  />
                ) : (
                  <span aria-hidden="true">{initials}</span>
                )}
              </span>
            </AgentGUIAccountAvatar>
            <img
              alt=""
              aria-hidden="true"
              draggable={false}
              src={membershipIconSource}
              className="absolute -right-0.5 -bottom-0.5 size-[14px] object-contain"
            />
          </button>
        }
      />
    </div>
  );
});

function WorkspaceAccountMenuDivider(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-px shrink-0 bg-[color-mix(in_srgb,var(--workbench-chrome-foreground)_24%,transparent)]"
    />
  );
}

function resolveMembershipIconSource(
  tierKey: string | null,
  membershipLabel: string
): string {
  const normalized = `${tierKey ?? ""} ${membershipLabel}`.toLowerCase();
  if (normalized.includes("ultra")) {
    return PLAN_ICON_SOURCES.ultra;
  }
  if (normalized.includes("pro")) {
    return PLAN_ICON_SOURCES.pro;
  }
  if (normalized.includes("lite")) {
    return PLAN_ICON_SOURCES.lite;
  }
  return PLAN_ICON_SOURCES.free;
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
