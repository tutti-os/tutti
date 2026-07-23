export interface AgentGUIAccountMenuState {
  user: {
    userId: string;
    name?: string | null;
    email?: string | null;
    avatar?: string | null;
  } | null;
  membershipLabel: string;
  creditsLabel: string | null;
  loading: boolean;
  error: string | null;
  partialError?: boolean;
  registrationCreditsToast?: {
    id: string;
    creditsLabel: string;
    visible: boolean;
    autoDismissMs?: number;
    onDismiss(): void;
  } | null;
  links: {
    planUrl: string;
    usageUrl: string;
    settingsUrl: string;
  };
  onOpenChange(open: boolean): void;
  onLogin(): void;
  onLogout?(): void;
  onSettings?(): void;
  onCopyUserId?(): void | Promise<void>;
  onOpenExternal(url: string): void;
}
