import { useEffect } from "react";
import { LoadingIcon } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { WorkspaceSettingsActionButton } from "./WorkspaceSettingsActionButton";
import { useAccountService } from "./useAccountService";

export function WorkspaceConnectionSettingsSection() {
  const { t } = useTranslation();
  const { service: accountService, state: accountState } = useAccountService();

  useEffect(() => {
    void accountService.refreshUserInfo();
  }, [accountService]);

  const handleLogin = async () => {
    if (accountState.signingOut) {
      return;
    }
    await accountService.startLogin();
  };

  const handleLogout = async () => {
    if (accountState.signingIn || accountState.signingOut) {
      return;
    }
    await accountService.logout();
  };

  const user = accountState.user;
  const displayName = user?.name || user?.email || user?.user_id || "Tutti";

  return (
    <div className="flex flex-col gap-6 pb-[22px] pt-5">
      <div className="flex min-w-0 items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {user?.avatar ? (
            <img
              alt=""
              className="size-12 shrink-0 rounded-full object-cover"
              draggable={false}
              src={user.avatar}
            />
          ) : (
            <div className="grid size-12 shrink-0 place-items-center rounded-full bg-[var(--transparency-block)] text-[18px] font-semibold text-[var(--text-primary)]">
              {displayName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <strong className="block truncate text-[16px] font-semibold leading-6 text-[var(--text-primary)]">
              {accountState.loading
                ? t("common.loading")
                : user
                  ? displayName
                  : t("workspace.settings.account.signedOutTitle")}
            </strong>
            <p className="m-0 truncate text-[13px] text-[var(--text-secondary)]">
              {user?.email || t("workspace.settings.account.description")}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2 max-[560px]:w-full max-[560px]:justify-start">
          {user ? (
            <>
              <WorkspaceSettingsActionButton
                className="w-auto min-w-[96px]"
                disabled={accountState.signingIn || accountState.signingOut}
                label={
                  accountState.signingOut
                    ? t("workspace.settings.account.signingOut")
                    : t("workspace.settings.account.logout")
                }
                onClick={handleLogout}
              />
              <WorkspaceSettingsActionButton
                className="w-auto min-w-[96px]"
                disabled={accountState.signingIn || accountState.signingOut}
                label={t("workspace.settings.account.refresh")}
                onClick={() => void accountService.refreshUserInfo()}
              />
            </>
          ) : (
            <WorkspaceSettingsActionButton
              className="w-auto min-w-[104px] max-[560px]:w-full"
              disabled={accountState.loading || accountState.signingOut}
              icon={
                accountState.signingIn ? (
                  <LoadingIcon className="size-3.5" />
                ) : null
              }
              label={
                accountState.signingIn
                  ? t("workspace.settings.account.signingIn")
                  : accountState.loginStatus === "pending"
                    ? t("workspace.settings.account.reopenLogin")
                    : t("workspace.settings.account.login")
              }
              onClick={handleLogin}
              variant="default"
            />
          )}
        </div>
      </div>

      {accountState.error ? (
        <p className="m-0 rounded-[6px] bg-[color-mix(in_srgb,var(--state-warning)_16%,transparent)] px-3 py-2 text-[13px] text-[var(--text-primary)]">
          {accountState.error}
        </p>
      ) : null}
    </div>
  );
}
