import { useCallback } from "react";
import {
  BillingIcon,
  CreditsIcon,
  LaunchIcon,
  SettingsIcon
} from "@tutti-os/ui-system";
import { resolveMembershipAction, type CommerceMenuState } from "../index";

export interface CommerceMenuLabels {
  member: string;
  upgradeMembership: string;
  rechargeCredits: string;
  viewCreditPlans: string;
  creditsBalance: string;
  accountCenter: string;
  loading: string;
  unavailable: string;
  dataUnavailable: string;
}

export interface CommerceMenuContentProps {
  state: CommerceMenuState;
  labels: CommerceMenuLabels;
}

export function CommerceMenuContent({
  state,
  labels
}: CommerceMenuContentProps): React.JSX.Element {
  const creditsLabel =
    state.loading && !state.creditsLabel
      ? labels.loading
      : (state.creditsLabel ?? labels.unavailable);
  const openExternal = useCallback(
    (url: string) => {
      if (!url.trim()) {
        return;
      }
      try {
        const result = state.onOpenExternal(url);
        if (result) {
          void result.catch((error: unknown) => {
            state.onActionError?.(error);
          });
        }
      } catch (error) {
        state.onActionError?.(error);
      }
    },
    [state]
  );
  const membershipActionLabel = resolveMembershipActionLabel(state, labels);

  return (
    <div className="flex min-w-0 flex-col" data-testid="commerce-menu-content">
      <button
        type="button"
        className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]"
        disabled={!state.links.planUrl.trim()}
        onClick={() => openExternal(state.links.planUrl)}
      >
        <BillingIcon aria-hidden="true" size={15} />
        <span className="min-w-0 flex-1 truncate text-left">
          {labels.member}
        </span>
        <span className="shrink-0 text-[12px] text-[var(--tutti-purple)]">
          {membershipActionLabel}
        </span>
      </button>
      <button
        type="button"
        className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]"
        disabled={!state.links.usageUrl.trim()}
        onClick={() => openExternal(state.links.usageUrl)}
      >
        <CreditsIcon aria-hidden="true" size={15} />
        <span className="min-w-0 flex-1 truncate text-left">
          {labels.creditsBalance}
        </span>
        <span className="truncate text-[var(--text-secondary)]">
          {creditsLabel}
        </span>
      </button>
      <button
        type="button"
        className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]"
        disabled={!state.links.settingsUrl.trim()}
        onClick={() => openExternal(state.links.settingsUrl)}
      >
        <SettingsIcon aria-hidden="true" size={15} />
        <span className="min-w-0 flex-1 truncate text-left">
          {labels.accountCenter}
        </span>
        <LaunchIcon aria-hidden="true" size={14} />
      </button>
      {state.dataUnavailable ? (
        <span className="px-2 py-1 text-[11px] leading-4 text-[var(--text-danger)]">
          {labels.dataUnavailable}
        </span>
      ) : null}
    </div>
  );
}

function resolveMembershipActionLabel(
  state: CommerceMenuState,
  labels: Pick<
    CommerceMenuLabels,
    "upgradeMembership" | "rechargeCredits" | "viewCreditPlans"
  >
): string {
  switch (resolveMembershipAction(state.membershipAccess)) {
    case "upgrade-membership":
      return labels.upgradeMembership;
    case "recharge-credits":
      return labels.rechargeCredits;
    case "view-credit-plans":
      return labels.viewCreditPlans;
  }
}
