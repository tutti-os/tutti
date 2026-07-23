import { useCallback, type ReactNode } from "react";
import {
  Coins,
  Copy,
  Crown,
  ExternalLink,
  LogIn,
  LogOut,
  Settings
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@tutti-os/ui-system";
import { buildAssetUrl } from "../../../shared/assetUrl";
import { AccountMembershipBadge } from "../AccountMembershipBadge";
import type { AgentGUIAccountMenuState } from "../accountMenuState";

export interface AgentGUIAccountMenuLabels {
  title: string;
  member: string;
  upgradeMembership: string;
  rechargeCredits: string;
  viewCreditPlans: string;
  creditsBalance: string;
  accountCenter: string;
  settings: string;
  free: string;
  signIn: string;
  signOut: string;
  copyUserId: string;
  loading: string;
  unavailable: string;
  dataUnavailable: string;
}

export interface AgentGUIAccountMenuProps {
  state: AgentGUIAccountMenuState;
  labels: AgentGUIAccountMenuLabels;
  trigger: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  testId?: string;
}

export function AgentGUIAccountMenu({
  state,
  labels,
  trigger,
  side = "bottom",
  align = "end",
  sideOffset = 8,
  testId = "agent-gui-account-menu"
}: AgentGUIAccountMenuProps): React.JSX.Element {
  const userLabel = agentGUIAccountUserLabel(state, labels);
  const initials = agentGUIAccountInitials(userLabel);
  const membershipLabel =
    state.membershipLabel.trim() ||
    (state.membershipAccess === "free" ? labels.free : labels.unavailable);
  const creditsLabel =
    state.loading && !state.creditsLabel
      ? labels.loading
      : (state.creditsLabel ?? labels.unavailable);
  const errorLabel =
    state.error || (state.partialError ? labels.dataUnavailable : null);
  const openExternal = useCallback(
    (url: string) => {
      if (url.trim()) {
        state.onOpenExternal(url);
      }
    },
    [state]
  );
  const membershipActionLabel = resolveMembershipActionLabel(state, labels);

  return (
    <Popover onOpenChange={state.onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="w-[232px] max-w-[calc(100vw-32px)] p-1 text-xs"
        data-testid={testId}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2 px-2 py-2">
            <AgentGUIAccountAvatar state={state} label={labels.copyUserId}>
              <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--background-fronted)] text-[13px] font-semibold text-[var(--text-primary)]">
                {state.user?.assetUrl ? (
                  <img
                    alt=""
                    className="size-full object-cover"
                    src={buildAssetUrl(state.user.assetUrl, {
                      kind: "avatar",
                      size: 48,
                      format: "webp"
                    })}
                  />
                ) : (
                  initials
                )}
              </span>
            </AgentGUIAccountAvatar>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">
                {userLabel}
              </span>
              <AccountMembershipBadge
                className="mt-1"
                label={membershipLabel}
              />
            </span>
          </div>
          <span aria-hidden="true" className="mx-2 h-px bg-[var(--border-1)]" />
          {state.user ? (
            <>
              <button
                type="button"
                className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]"
                disabled={!state.links.planUrl.trim()}
                onClick={() => openExternal(state.links.planUrl)}
              >
                <Crown aria-hidden="true" size={15} strokeWidth={1.8} />
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
                <Coins aria-hidden="true" size={15} strokeWidth={1.8} />
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
                <Settings aria-hidden="true" size={15} strokeWidth={1.8} />
                <span className="min-w-0 flex-1 truncate text-left">
                  {labels.accountCenter}
                </span>
                <ExternalLink aria-hidden="true" size={14} strokeWidth={1.8} />
              </button>
              {state.onSettings ? (
                <button
                  type="button"
                  className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={state.onSettings}
                >
                  <Settings aria-hidden="true" size={15} strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.settings}
                  </span>
                </button>
              ) : null}
              {state.onLogout ? (
                <>
                  <span
                    aria-hidden="true"
                    className="mx-2 my-1 h-px bg-[var(--border-1)]"
                  />
                  <button
                    type="button"
                    className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                    onClick={state.onLogout}
                  >
                    <LogOut aria-hidden="true" size={15} strokeWidth={1.8} />
                    <span className="truncate">{labels.signOut}</span>
                  </button>
                </>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
              onClick={state.onLogin}
            >
              <LogIn aria-hidden="true" size={15} strokeWidth={1.8} />
              <span className="truncate">{labels.signIn}</span>
            </button>
          )}
          {errorLabel ? (
            <span className="px-2 py-1 text-[11px] leading-4 text-[var(--text-danger)]">
              {errorLabel}
            </span>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function AgentGUIAccountAvatar({
  state,
  children,
  label
}: {
  state: AgentGUIAccountMenuState;
  children: ReactNode;
  label: string;
}): React.JSX.Element {
  if (!state.user || !state.onCopyUserId) {
    return <>{children}</>;
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={state.onCopyUserId}>
          <Copy aria-hidden="true" size={15} strokeWidth={1.8} />
          {label}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function resolveMembershipActionLabel(
  state: AgentGUIAccountMenuState,
  labels: AgentGUIAccountMenuLabels
): string {
  switch (state.membershipAccess) {
    case "free":
    case "inactive":
      return labels.upgradeMembership;
    case "active":
      return labels.rechargeCredits;
    default:
      return labels.viewCreditPlans;
  }
}

function agentGUIAccountUserLabel(
  state: AgentGUIAccountMenuState,
  labels: Pick<AgentGUIAccountMenuLabels, "title">
): string {
  const user = state.user;
  return (
    user?.name?.trim() ||
    user?.email?.trim() ||
    user?.userId?.trim() ||
    labels.title
  );
}

export function agentGUIAccountInitials(label: string): string {
  const normalized = label.trim();
  return normalized ? normalized.slice(0, 2).toUpperCase() : "T";
}
