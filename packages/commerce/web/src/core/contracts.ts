export type MembershipAccessState = "free" | "active" | "inactive" | "unknown";

export type CommerceMembershipAction =
  | "upgrade-membership"
  | "recharge-credits"
  | "view-credit-plans";

export type MembershipTierVisual = "free" | "lite" | "pro" | "ultra";

export interface RegistrationCreditsToastState {
  id: string;
  creditsLabel: string;
  visible: boolean;
  autoDismissMs?: number;
  onDismiss(): void;
}

export interface CommerceMenuState {
  membershipLabel: string;
  membershipAccess?: MembershipAccessState;
  creditsLabel: string | null;
  loading: boolean;
  dataUnavailable: boolean;
  links: {
    planUrl: string;
    usageUrl: string;
    settingsUrl: string;
  };
  onOpenExternal(url: string): void | Promise<void>;
  onActionError?(error: unknown): void;
}
