import type { AgentVisibleErrorOverrides } from "@tutti-os/agent-gui";
import type { InsufficientCreditsSemantic } from "@tutti-os/commerce";

export interface DesktopInsufficientCreditsCopy {
  upgradeMembership: {
    message: string;
    actionLabel: string;
  };
  rechargeCredits: {
    message: string;
    actionLabel: string;
  };
  creditsUnavailable: {
    message: string;
    actionLabel: string;
  };
}

export function buildDesktopCommerceErrorPresentation(input: {
  semantic: InsufficientCreditsSemantic["message"];
  actionUrl: string | null | undefined;
  copy: DesktopInsufficientCreditsCopy;
}): AgentVisibleErrorOverrides {
  const copyByMessage = {
    "upgrade-membership": input.copy.upgradeMembership,
    "recharge-credits": input.copy.rechargeCredits,
    "credits-unavailable": input.copy.creditsUnavailable
  } as const;
  const presentationCopy = copyByMessage[input.semantic];
  const actionUrl = input.actionUrl?.trim() || "";

  return {
    insufficient_credits: {
      message: presentationCopy.message,
      providers: ["tutti-agent"],
      action: actionUrl
        ? {
            label: presentationCopy.actionLabel,
            url: actionUrl
          }
        : null
    }
  };
}
