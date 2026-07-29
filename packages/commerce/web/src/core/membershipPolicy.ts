import type {
  CommerceMembershipAction,
  MembershipAccessState
} from "./contracts";

export interface InsufficientCreditsSemantic {
  message: "upgrade-membership" | "recharge-credits" | "credits-unavailable";
  action: CommerceMembershipAction;
}

export function resolveMembershipAction(
  membershipAccess: MembershipAccessState | null | undefined
): CommerceMembershipAction {
  switch (membershipAccess) {
    case "free":
    case "inactive":
      return "upgrade-membership";
    case "active":
      return "recharge-credits";
    default:
      return "view-credit-plans";
  }
}

export function resolveInsufficientCreditsSemantic(
  membershipAccess: MembershipAccessState | null | undefined
): InsufficientCreditsSemantic {
  const action = resolveMembershipAction(membershipAccess);
  switch (action) {
    case "upgrade-membership":
      return { message: "upgrade-membership", action };
    case "recharge-credits":
      return { message: "recharge-credits", action };
    default:
      return { message: "credits-unavailable", action };
  }
}
