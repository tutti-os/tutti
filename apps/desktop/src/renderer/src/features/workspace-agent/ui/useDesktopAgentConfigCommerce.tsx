import { useCallback, useMemo } from "react";
import {
  AgentGUIConfigAccountFallbackSuppressed,
  type AgentGUIProps
} from "@tutti-os/agent-gui";
import type { CommerceMenuState } from "@tutti-os/commerce";
import { AgentConfigCommerceContent } from "@tutti-os/commerce/react";
import { useService } from "@tutti-os/infra/di";
import { INotificationService } from "@tutti-os/ui-notifications";
import { useTranslation } from "@renderer/i18n";
import { useAccountService } from "../../workspace-workbench/ui/useAccountService";
import {
  formatWorkspaceAccountCreditsLabel,
  projectWorkspaceAccountCommerce
} from "../../workspace-workbench/ui/workspaceAccountCommerceAdapter";
import { useWorkspaceWorkbenchHostService } from "../../workspace-workbench/ui/useWorkspaceWorkbenchHostService";
import {
  isDesktopLocalTuttiAgentConfigContext,
  shouldRenderDesktopAgentConfigCommerce
} from "./desktopAgentConfigCommerceContext.ts";

export function useDesktopAgentConfigCommerce(enabled: boolean) {
  const { locale, t } = useTranslation();
  const notifications = useService(INotificationService);
  const { service: accountService, state: accountState } = useAccountService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const commerceProjection = useMemo(
    () =>
      projectWorkspaceAccountCommerce({
        enabled,
        summary: accountState.productSummary,
        loading: accountState.productSummaryLoading,
        error: accountState.productSummaryError
      }),
    [
      accountState.productSummary,
      accountState.productSummaryError,
      accountState.productSummaryLoading,
      enabled
    ]
  );
  const summary = commerceProjection.summary;
  const summaryUser = summary?.user ?? null;
  const user = summaryUser ?? accountState.user;
  const hasAccount = Boolean(user);
  const accountName =
    user?.name?.trim() || user?.email?.trim() || user?.user_id?.trim() || null;
  const commerceState = useMemo<CommerceMenuState>(
    () => ({
      membershipLabel:
        summary?.membership?.display_name?.trim() ||
        summary?.membership?.tier_key?.trim() ||
        "",
      membershipAccess: summary?.membership_access ?? "unknown",
      creditsLabel: formatWorkspaceAccountCreditsLabel(
        summary?.credits?.available_credits,
        locale
      ),
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
    }),
    [
      commerceProjection.dataUnavailable,
      commerceProjection.loading,
      locale,
      notifications,
      summary,
      t,
      workbenchHostService
    ]
  );
  const refreshCommerce = useCallback(() => {
    void accountService.refreshUserInfo();
    void accountService.refreshProductSummary({ force: true });
  }, [accountService]);
  const handleAgentConfigMenuOpen = useCallback<
    NonNullable<AgentGUIProps["hostActions"]["onAgentConfigMenuOpen"]>
  >(
    (context) => {
      if (enabled && isDesktopLocalTuttiAgentConfigContext(context)) {
        refreshCommerce();
      }
    },
    [enabled, refreshCommerce]
  );
  const renderAgentConfigAccount = useCallback<
    NonNullable<AgentGUIProps["renderSlots"]["agentConfigAccount"]>
  >(
    (context) => {
      if (!enabled || !isDesktopLocalTuttiAgentConfigContext(context)) {
        return null;
      }
      if (
        !shouldRenderDesktopAgentConfigCommerce({
          context,
          enabled: commerceProjection.commerceVisible,
          hasAccount
        })
      ) {
        return <AgentGUIConfigAccountFallbackSuppressed />;
      }
      return (
        <AgentConfigCommerceContent
          accountName={accountName}
          presentation="menu"
          showAccountIdentity={false}
          state={commerceState}
          labels={{
            account: t("workspace.accountMenu.title"),
            membership: t("workspace.accountMenu.member"),
            creditsBalance: t("workspace.accountMenu.creditsBalance"),
            refresh: t("workspace.accountMenu.refresh"),
            refreshing: t("workspace.accountMenu.refreshing"),
            freeMembership: t("workspace.accountMenu.free"),
            accountCenter: t("workspace.accountMenu.accountCenter"),
            loading: t("workspace.accountMenu.loading"),
            unavailable: t("workspace.accountMenu.unavailable"),
            dataUnavailable: t("workspace.accountMenu.dataUnavailable")
          }}
          onRefresh={refreshCommerce}
        />
      );
    },
    [
      accountName,
      commerceProjection.commerceVisible,
      commerceState,
      enabled,
      hasAccount,
      refreshCommerce,
      t
    ]
  );

  return {
    accountState,
    handleAgentConfigMenuOpen,
    renderAgentConfigAccount
  };
}
