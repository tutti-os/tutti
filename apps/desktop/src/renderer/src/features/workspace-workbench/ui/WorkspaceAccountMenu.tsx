import { memo, useEffect, useMemo, useState } from "react";
import type {
  CommerceMenuState,
  MembershipAccessState,
  RegistrationCreditsToastState
} from "@tutti-os/commerce";
import {
  CommerceMenuContent,
  MembershipBadge,
  MembershipTierIcon,
  RegistrationCreditsToast,
  type CommerceMenuLabels
} from "@tutti-os/commerce/react";
import { userAvatarPlaceholderUrl } from "@tutti-os/agent-gui/agent-message-center";
import { useService } from "@tutti-os/infra/di";
import { INotificationService } from "@tutti-os/ui-notifications";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SettingsIcon,
  SignOutIcon
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { useAccountService } from "./useAccountService";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import {
  projectWorkspaceAccountCommerce,
  projectWorkspaceAccountMenuComposition
} from "./workspaceAccountCommerceAdapter";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";

const debugRegistrationCreditsToastStorageKey =
  "tutti.agentGui.debugRegistrationCreditsToast";
const debugRegistrationCreditsToastID =
  "debug:registrationCreditsToastShown:local";
const registrationCreditsToastAutoDismissMs = 120_000;

export interface WorkspaceAccountMenuProps {
  showLeadingDivider?: boolean;
  signedOutPresentation?: "signInButton" | "placeholderAvatar";
  workspaceId: string;
}

export function WorkspaceAccountMenu({
  showLeadingDivider = true,
  signedOutPresentation = "signInButton",
  workspaceId
}: WorkspaceAccountMenuProps) {
  const { state: workspaceSettingsState } = useWorkspaceSettingsService();
  const commerceEnabled =
    workspaceSettingsState.tuttiAgentSwitchEnabled === true;

  return (
    <WorkspaceAccountMenuEnabled
      commerceEnabled={commerceEnabled}
      showLeadingDivider={showLeadingDivider}
      signedOutPresentation={signedOutPresentation}
      workspaceId={workspaceId}
    />
  );
}

function WorkspaceAccountMenuEnabled({
  commerceEnabled,
  showLeadingDivider,
  signedOutPresentation,
  workspaceId
}: Required<WorkspaceAccountMenuProps> & { commerceEnabled: boolean }) {
  const accountMenuState = useWorkspaceAccountMenuState(
    commerceEnabled,
    workspaceId
  );
  const labels = useWorkspaceAccountMenuLabels();

  return (
    <WorkspaceAccountMenuView
      accountMenuState={accountMenuState}
      labels={labels}
      showLeadingDivider={showLeadingDivider}
      signedOutPresentation={signedOutPresentation}
    />
  );
}

interface WorkspaceAccountMenuState {
  user: {
    userId: string;
    name?: string | null;
    email?: string | null;
    avatar?: string | null;
  } | null;
  commerce: CommerceMenuState;
  commerceVisible: boolean;
  membershipLabel: string;
  membershipAccess: MembershipAccessState;
  membershipTierKey: string | null;
  registrationCreditsToast: RegistrationCreditsToastState | null;
  onOpenChange(open: boolean): void;
  onLogin(): void;
  onLogout(): void;
  onSettings(): void;
  onCopyUserId(): void | Promise<void>;
}

function useWorkspaceAccountMenuState(
  commerceEnabled: boolean,
  workspaceId: string
): WorkspaceAccountMenuState {
  const { locale, t } = useTranslation();
  const notifications = useService(INotificationService);
  const { service: accountService, state: accountState } = useAccountService();
  const { service: workspaceSettingsService } = useWorkspaceSettingsService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const [
    debugRegistrationCreditsToastEnabled,
    setDebugRegistrationCreditsToastEnabled
  ] = useState(readDebugRegistrationCreditsToastEnabled);
  const commerceProjection = useMemo(
    () =>
      projectWorkspaceAccountCommerce({
        enabled: commerceEnabled,
        summary: accountState.productSummary,
        loading: accountState.productSummaryLoading,
        error: accountState.productSummaryError
      }),
    [
      accountState.productSummary,
      accountState.productSummaryError,
      accountState.productSummaryLoading,
      commerceEnabled
    ]
  );

  useEffect(() => {
    void accountService.refreshUserInfo();
    if (commerceProjection.shouldRefresh) {
      void accountService.refreshProductSummary();
    }
  }, [accountService, commerceProjection.shouldRefresh]);

  return useMemo<WorkspaceAccountMenuState>(() => {
    const summary = commerceProjection.summary;
    const summaryUser = summary?.user ?? null;
    const user = summaryUser ?? accountState.user;
    const membershipLabel =
      summary?.membership?.display_name?.trim() ||
      summary?.membership?.tier_key?.trim() ||
      "";
    const membershipTierKey =
      summary?.membership?.tier_key?.trim() ||
      (summary?.membership_access === "free" ? "free" : null);
    const creditsLabel = formatCreditsLabel(
      summary?.credits?.available_credits,
      locale
    );
    const debugRegistrationCreditsReward =
      commerceEnabled && user && debugRegistrationCreditsToastEnabled
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
      membershipTierKey,
      commerceVisible: commerceProjection.commerceVisible,
      commerce: {
        membershipLabel,
        membershipAccess: summary?.membership_access ?? "unknown",
        creditsLabel,
        loading: commerceProjection.loading,
        dataUnavailable: commerceProjection.dataUnavailable,
        links: {
          planUrl: summary?.links.plan_url ?? "",
          usageUrl: summary?.links.usage_url ?? "",
          settingsUrl: summary?.links.settings_url ?? ""
        },
        async onOpenExternal(url) {
          if (url.trim()) {
            await workbenchHostService.openExternal(url);
          }
        },
        onActionError() {
          notifications.error({
            title: t("workspace.accountMenu.openExternalFailed")
          });
        }
      },
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
      onOpenChange(open) {
        if (open) {
          void accountService.refreshUserInfo();
          if (commerceEnabled) {
            void accountService.refreshProductSummary({ force: true });
          }
        }
      },
      onLogin() {
        void accountService.startLogin();
      },
      onLogout() {
        void accountService.logout();
      },
      onSettings() {
        workspaceSettingsService.openPanel(
          { id: workspaceId },
          { section: "general" }
        );
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
      }
    };
  }, [
    accountService,
    accountState.user,
    commerceProjection,
    commerceEnabled,
    debugRegistrationCreditsToastEnabled,
    locale,
    notifications,
    t,
    workbenchHostService,
    workspaceId,
    workspaceSettingsService
  ]);
}

type WorkspaceAccountMenuLabels = CommerceMenuLabels & {
  title: string;
  settings: string;
  free: string;
  signIn: string;
  signOut: string;
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
  showLeadingDivider,
  signedOutPresentation
}: {
  accountMenuState: WorkspaceAccountMenuState;
  labels: WorkspaceAccountMenuLabels;
  showLeadingDivider: boolean;
  signedOutPresentation: "signInButton" | "placeholderAvatar";
}) {
  "use memo";
  const userLabel =
    accountMenuState.user?.name?.trim() ||
    accountMenuState.user?.email?.trim() ||
    accountMenuState.user?.userId?.trim() ||
    labels.title;
  const initials = accountInitials(userLabel);
  const membershipLabel =
    accountMenuState.membershipLabel.trim() ||
    (accountMenuState.membershipAccess === "free"
      ? labels.free
      : labels.unavailable);
  const composition = projectWorkspaceAccountMenuComposition({
    commerceEnabled: accountMenuState.commerceVisible,
    signedIn: Boolean(accountMenuState.user)
  });

  if (!accountMenuState.user) {
    return (
      <div className="relative flex min-w-0 items-center gap-1.5">
        {showLeadingDivider ? <WorkspaceAccountMenuDivider /> : null}
        {signedOutPresentation === "placeholderAvatar" ? (
          <button
            type="button"
            aria-label={labels.signIn}
            onClick={accountMenuState.onLogin}
            className="relative grid size-8 cursor-pointer place-items-center rounded-full border border-transparent bg-transparent p-0 shadow-none [-webkit-app-region:no-drag]"
            data-account-signin-trigger="true"
          >
            <span className="grid size-7 place-items-center overflow-hidden rounded-full border-[0.5px] border-[var(--line-2)] bg-[var(--transparency-block)]">
              <img
                alt=""
                className="size-full object-cover"
                src={userAvatarPlaceholderUrl}
              />
            </span>
          </button>
        ) : (
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
        )}
      </div>
    );
  }

  return (
    <div className="relative flex min-w-0 items-center gap-1.5">
      {accountMenuState.commerceVisible !== false &&
      accountMenuState.registrationCreditsToast ? (
        <div className="absolute right-0 top-10 z-50 w-[280px]">
          <RegistrationCreditsToast
            toast={accountMenuState.registrationCreditsToast}
            labels={{
              title: labels.rewardToastTitle,
              description: labels.rewardToastDescription,
              creditsUnit: labels.rewardToastCreditsUnit,
              close: labels.rewardToastClose
            }}
          />
        </div>
      ) : null}
      {showLeadingDivider ? <WorkspaceAccountMenuDivider /> : null}
      <Popover onOpenChange={accountMenuState.onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={userLabel}
            className="relative grid size-8 cursor-pointer place-items-center rounded-full border border-transparent bg-transparent p-0 text-[var(--workbench-chrome-foreground)] shadow-none hover:bg-transparent [-webkit-app-region:no-drag]"
            data-account-menu-trigger="true"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void accountMenuState.onCopyUserId?.();
            }}
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
            {accountMenuState.commerceVisible !== false ? (
              <MembershipTierIcon
                tierKey={accountMenuState.membershipTierKey}
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
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-2 px-2 py-2">
              <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--background-fronted)] text-[13px] font-semibold text-[var(--text-primary)]">
                {accountMenuState.user.avatar ? (
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
                {composition.showCommerce ? (
                  <MembershipBadge
                    className="mt-0.5"
                    label={membershipLabel}
                    tierKey={accountMenuState.membershipTierKey}
                  />
                ) : null}
              </span>
            </div>
            <span
              aria-hidden="true"
              className="mx-2 mb-1 h-px bg-[var(--border-1)]"
            />
            {composition.showCommerce ? (
              <CommerceMenuContent
                state={accountMenuState.commerce}
                labels={labels}
              />
            ) : null}
            {composition.showSettings ? (
              <button
                type="button"
                className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                onClick={accountMenuState.onSettings}
              >
                <SettingsIcon aria-hidden="true" size={15} />
                <span className="min-w-0 flex-1 truncate text-left">
                  {labels.settings}
                </span>
              </button>
            ) : null}
            {composition.showLogout ? (
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
                  <SignOutIcon aria-hidden="true" size={15} />
                  <span className="truncate">{labels.signOut}</span>
                </button>
              </>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});

function accountInitials(label: string): string {
  const normalized = label.trim();
  return normalized ? normalized.slice(0, 2).toUpperCase() : "T";
}

function WorkspaceAccountMenuDivider(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-px shrink-0 bg-[color-mix(in_srgb,var(--workbench-chrome-foreground)_24%,transparent)]"
    />
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
