import { useCallback } from "react";
import { resolveMembershipAction, type CommerceMenuState } from "../index";

export interface CommerceMembershipActionLabels {
  upgradeMembership: string;
  rechargeCredits: string;
  viewCreditPlans: string;
}

export function resolveCommerceMembershipActionLabel(
  state: CommerceMenuState,
  labels: CommerceMembershipActionLabels
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

export function useCommerceOpenExternal(
  state: CommerceMenuState
): (url: string) => void {
  return useCallback(
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
}
