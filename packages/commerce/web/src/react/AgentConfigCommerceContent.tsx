import {
  BillingIcon,
  CreditsIcon,
  LaunchIcon,
  RefreshIcon,
  UserLinedIcon
} from "@tutti-os/ui-system";
import type { CommerceMenuState } from "../index";
import { useCommerceOpenExternal } from "./commerceMenuPresentation";

export interface AgentConfigCommerceLabels {
  account: string;
  membership: string;
  creditsBalance: string;
  refresh: string;
  refreshing: string;
  freeMembership: string;
  accountCenter: string;
  loading: string;
  unavailable: string;
  dataUnavailable: string;
}

export interface AgentConfigCommerceContentProps {
  accountName: string | null;
  showAccountIdentity?: boolean;
  state: CommerceMenuState;
  labels: AgentConfigCommerceLabels;
  onRefresh(): void;
}

const menuItemBaseClassName =
  "nodrag flex h-7 items-center gap-2 rounded-[6px] text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] disabled:hover:bg-transparent [-webkit-app-region:no-drag]";
const menuItemClassName = `${menuItemBaseClassName} w-full px-2`;

export function AgentConfigCommerceContent({
  accountName,
  showAccountIdentity = true,
  state,
  labels,
  onRefresh
}: AgentConfigCommerceContentProps): React.JSX.Element {
  const openExternal = useCommerceOpenExternal(state);
  const accountNameLabel =
    accountName?.trim() ||
    (state.loading ? labels.loading : labels.unavailable);
  const creditsLabel =
    state.loading && !state.creditsLabel
      ? labels.loading
      : (state.creditsLabel ?? labels.unavailable);
  const membershipLabel =
    state.membershipLabel.trim() ||
    (state.membershipAccess === "free"
      ? labels.freeMembership
      : state.loading
        ? labels.loading
        : labels.unavailable);
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="agent-config-commerce-content"
    >
      {showAccountIdentity ? (
        <>
          <div className="flex min-w-0 flex-col gap-1 p-2">
            <div className="flex min-w-0 items-center gap-2">
              <UserLinedIcon aria-hidden="true" size={16} />
              <span className="truncate text-[13px] font-semibold leading-4">
                {labels.account}
              </span>
            </div>
            <span className="truncate pl-6 text-[13px] leading-5 text-[var(--text-secondary)]">
              {accountNameLabel}
            </span>
          </div>
          <div className="px-2">
            <span className="block h-px bg-[var(--border-1)]" />
          </div>
        </>
      ) : null}
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          className={`${menuItemBaseClassName} min-w-0 flex-1 px-2`}
          disabled={!state.links.usageUrl.trim()}
          aria-label={`${labels.creditsBalance} ${creditsLabel}`}
          onClick={() => openExternal(state.links.usageUrl)}
        >
          <CreditsIcon aria-hidden="true" size={16} />
          <span className="min-w-0 flex-1 truncate text-left">
            {labels.creditsBalance}
          </span>
          <span
            className="max-w-[120px] truncate text-[var(--text-secondary)] tabular-nums"
            data-testid="agent-config-commerce-credits"
            aria-live="polite"
          >
            {creditsLabel}
          </span>
        </button>
        <button
          type="button"
          className={`${menuItemBaseClassName} shrink-0 px-2`}
          data-testid="agent-config-commerce-refresh"
          disabled={state.loading}
          aria-label={state.loading ? labels.refreshing : labels.refresh}
          onClick={onRefresh}
        >
          <RefreshIcon
            aria-hidden="true"
            className={state.loading ? "motion-safe:animate-spin" : undefined}
            size={14}
          />
          <span>{state.loading ? labels.refreshing : labels.refresh}</span>
        </button>
      </div>
      <button
        type="button"
        className={menuItemClassName}
        disabled={!state.links.planUrl.trim()}
        aria-label={`${labels.membership} ${membershipLabel}`}
        onClick={() => openExternal(state.links.planUrl)}
      >
        <BillingIcon aria-hidden="true" size={16} />
        <span className="min-w-0 flex-1 truncate text-left">
          {labels.membership}
        </span>
        <span className="max-w-[72px] truncate text-[var(--text-secondary)]">
          {membershipLabel}
        </span>
        <LaunchIcon
          aria-hidden="true"
          className="text-[var(--text-secondary)]"
          size={14}
        />
      </button>
      <button
        type="button"
        className={menuItemClassName}
        disabled={!state.links.settingsUrl.trim()}
        onClick={() => openExternal(state.links.settingsUrl)}
      >
        <UserLinedIcon aria-hidden="true" size={16} />
        <span className="min-w-0 flex-1 truncate text-left">
          {labels.accountCenter}
        </span>
        <LaunchIcon
          aria-hidden="true"
          className="text-[var(--text-secondary)]"
          size={14}
        />
      </button>
      {state.dataUnavailable ? (
        <span
          className="px-2 py-1 text-[11px] leading-4 text-[var(--state-danger)]"
          role="status"
        >
          {labels.dataUnavailable}
        </span>
      ) : null}
    </div>
  );
}
