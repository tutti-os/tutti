import { isValidElement, useState, type ReactNode } from "react";
import { Gauge, Wrench } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@tutti-os/ui-system";
import { MoreHorizontalIcon } from "@tutti-os/ui-system/icons";
import { AgentProbeUsageFreshness } from "../AgentProbeUsageFreshness";
import { AgentUsageMeter } from "../AgentUsageMeter";
import { SettingsLinedIcon } from "../../../app/renderer/components/icons/SettingsLinedIcon";
import { resolveAgentGuiSessionProviderFlatIconUrl } from "../../../agentGuiSessionProviderIconUrls";
import styles from "../AgentGUINode.styles";
import type { AgentComposerSlashStatusLimit } from "../AgentComposer";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";

interface AgentGUIConfigMenuProps {
  accountContent?: ReactNode;
  systemActionsContent?: ReactNode;
  environmentSetupVisible: boolean;
  labels: AgentGUIViewLabels;
  providerScopedActionsVisible: boolean;
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading: boolean;
  slashStatusLimitsResolvedEmpty: boolean;
  slashStatusUsageCapturedAtUnixMs: number | null;
  slashStatusUsageDidFail: boolean;
  slashStatusUsageErrorMessage?: string | null;
  slashStatusUsageAttempted: boolean;
  provider?: string | null;
  providerIconUrl?: string | null;
  providerMaskIconUrl?: string | null;
  providerLabel?: string | null;
  providerAuthAccountLabel?: string | null;
  onAgentConfigMenuOpen?: () => void;
  onAgentConfigMenuClose?: () => void;
  onAgentUsageRefresh?: () => void;
  onOpenAgentEnvSetup: () => void;
  onOpenAgentSettings: () => void;
}

export function AgentGUIConfigAccountFallbackSuppressed(): null {
  return null;
}

export function AgentGUIConfigMenu({
  accountContent,
  systemActionsContent,
  environmentSetupVisible,
  labels,
  providerScopedActionsVisible,
  slashStatusLimits,
  slashStatusLimitsLoading,
  slashStatusLimitsResolvedEmpty,
  slashStatusUsageCapturedAtUnixMs,
  slashStatusUsageDidFail,
  slashStatusUsageErrorMessage,
  slashStatusUsageAttempted,
  provider,
  providerIconUrl,
  providerMaskIconUrl: targetMaskIconUrl,
  providerLabel,
  providerAuthAccountLabel,
  onAgentConfigMenuOpen,
  onAgentConfigMenuClose,
  onAgentUsageRefresh,
  onOpenAgentEnvSetup,
  onOpenAgentSettings
}: AgentGUIConfigMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const builtInMaskIconUrl = resolveAgentGuiSessionProviderFlatIconUrl(
    provider ?? undefined
  );
  const providerImageIconUrl = builtInMaskIconUrl
    ? null
    : (providerIconUrl?.trim() ?? null);
  const providerMaskIconUrl =
    builtInMaskIconUrl ??
    (providerImageIconUrl ? null : (targetMaskIconUrl?.trim() ?? null));
  const providerDisplayName = providerLabel?.trim() || provider?.trim();
  const providerDisplayTitle = providerDisplayName
    ? labels.slashStatusProviderAccount(providerDisplayName)
    : null;
  const accountTitle = providerDisplayTitle ?? labels.slashStatusAccount;
  const accountFallbackSuppressed =
    isValidElement(accountContent) &&
    accountContent.type === AgentGUIConfigAccountFallbackSuppressed;
  const hasAccountContent =
    !accountFallbackSuppressed &&
    Boolean(accountContent) &&
    typeof accountContent !== "boolean";
  const providerAccountFallbackVisible =
    !accountFallbackSuppressed && !hasAccountContent;
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        // Refresh the underlying probe on open, the same way the window-title
        // info tooltip does; otherwise a stale/empty fetch can sit here until
        // something unrelated refreshes it.
        if (nextOpen) {
          onAgentConfigMenuOpen?.();
        } else {
          onAgentConfigMenuClose?.();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={labels.agentConfig}
          className={`${styles.providerRailConfigButton} nodrag tsh-desktop-no-drag`}
          title={labels.agentConfig}
        >
          <MoreHorizontalIcon aria-hidden="true" width={18} height={18} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        className="w-[300px] max-w-[calc(100vw-32px)] gap-3 p-1 text-xs"
        data-testid="agent-gui-config-menu"
        style={{ zIndex: "var(--z-panel-popover)" }}
      >
        <div className="flex min-w-0 flex-col gap-1">
          {hasAccountContent ? (
            <>
              {accountContent}
              <div className="px-2">
                <span className="block h-px bg-[var(--border-1)]" />
              </div>
            </>
          ) : null}
          {providerAccountFallbackVisible &&
          providerScopedActionsVisible &&
          providerAuthAccountLabel ? (
            <>
              <div className="flex min-w-0 flex-col gap-2 p-2">
                <div className="flex min-w-0 items-center gap-2">
                  {providerMaskIconUrl ? (
                    <span
                      aria-hidden="true"
                      className="size-4 shrink-0 bg-current"
                      style={{
                        mask: `url("${providerMaskIconUrl}") center / contain no-repeat`,
                        WebkitMask: `url("${providerMaskIconUrl}") center / contain no-repeat`
                      }}
                    />
                  ) : providerImageIconUrl ? (
                    <img
                      alt=""
                      aria-hidden="true"
                      className="size-4 shrink-0 object-contain"
                      src={providerImageIconUrl}
                    />
                  ) : null}
                  <span className="text-[13px] font-semibold leading-4">
                    {accountTitle}
                  </span>
                </div>
                <span className="text-[13px] leading-5 text-[var(--text-secondary)]">
                  {providerAuthAccountLabel}
                </span>
              </div>
              {slashStatusLimits.length > 0 ||
              slashStatusUsageAttempted ||
              slashStatusLimitsLoading ? (
                <div className="px-2">
                  <span className="block h-px bg-[var(--border-1)]" />
                </div>
              ) : null}
            </>
          ) : null}
          {providerAccountFallbackVisible &&
          providerScopedActionsVisible &&
          (slashStatusLimits.length > 0 ||
            slashStatusUsageAttempted ||
            slashStatusLimitsLoading) ? (
            <>
              <div className="flex min-w-0 flex-col gap-2 p-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Gauge
                      aria-hidden="true"
                      className="shrink-0"
                      size={16}
                      strokeWidth={1.8}
                    />
                    <span className="shrink-0 text-[13px] font-semibold leading-4">
                      {labels.slashStatusLimits}
                    </span>
                    {slashStatusLimits.length === 0 &&
                    !slashStatusLimitsLoading &&
                    !slashStatusUsageErrorMessage ? (
                      <span
                        className="min-w-0 truncate text-[var(--text-tertiary)]"
                        data-testid="agent-gui-config-usage-unavailable"
                      >
                        {slashStatusLimitsResolvedEmpty
                          ? labels.slashStatusEmptyValue
                          : labels.slashStatusLimitsUnavailable}
                      </span>
                    ) : null}
                  </div>
                  <AgentProbeUsageFreshness
                    testId="agent-gui-config-usage-refresh"
                    capturedAtUnixMs={slashStatusUsageCapturedAtUnixMs}
                    isLoading={slashStatusLimitsLoading}
                    didFail={slashStatusUsageDidFail}
                    disabled={!onAgentUsageRefresh}
                    onRefresh={() => onAgentUsageRefresh?.()}
                    labels={{
                      justUpdated: labels.slashStatusUsageJustUpdated,
                      minutesAgo: labels.slashStatusUsageMinutesAgo,
                      hoursAgo: labels.slashStatusUsageHoursAgo,
                      updating: labels.slashStatusUsageUpdating,
                      refreshFailed: labels.slashStatusUsageRefreshFailed,
                      refreshAria: labels.slashStatusUsageRefreshAria
                    }}
                  />
                </div>
                {slashStatusLimits.length > 0
                  ? slashStatusLimits.map((limit) => (
                      <AgentUsageMeter
                        key={limit.id}
                        label={limit.label}
                        value={`${limit.value}${limit.reset ? ` (${limit.reset})` : ""}`}
                        percent={
                          typeof limit.percentRemaining === "number" &&
                          Number.isFinite(limit.percentRemaining)
                            ? limit.percentRemaining
                            : null
                        }
                      />
                    ))
                  : null}
                {slashStatusUsageErrorMessage ? (
                  <div
                    className="rounded-[6px] border border-[var(--on-danger-hover)] bg-[var(--on-danger)] px-2 py-1.5 text-[12px] leading-4 text-[var(--state-danger)]"
                    data-testid="agent-gui-config-usage-error"
                    role="alert"
                  >
                    {slashStatusUsageErrorMessage}
                  </div>
                ) : null}
              </div>
              <div className="px-2">
                <span className="block h-px bg-[var(--border-1)]" />
              </div>
            </>
          ) : null}
          <div className="flex min-w-0 flex-col gap-1">
            {providerScopedActionsVisible && environmentSetupVisible ? (
              <button
                type="button"
                data-testid="agent-gui-config-env-setup"
                className="nodrag flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:text-[var(--text-tertiary)] [-webkit-app-region:no-drag]"
                onClick={() => onOpenAgentEnvSetup()}
              >
                <Wrench aria-hidden="true" size={16} strokeWidth={1.8} />
                <span>{labels.agentEnvSetup}</span>
              </button>
            ) : null}
            <button
              type="button"
              data-testid="agent-gui-config-settings"
              className="nodrag flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:text-[var(--text-tertiary)] [-webkit-app-region:no-drag]"
              onClick={() => onOpenAgentSettings()}
            >
              <SettingsLinedIcon aria-hidden="true" width={16} height={16} />
              <span>{labels.agentSettingsMenu}</span>
            </button>
          </div>
          {systemActionsContent ? (
            <>
              <div className="px-2">
                <span className="block h-px bg-[var(--border-1)]" />
              </div>
              {systemActionsContent}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
