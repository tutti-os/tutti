import { useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import { useTranslation } from "../../i18n/index";
import { cn } from "../../app/renderer/lib/utils";
import { requiresFullAccessSafetyConfirmation } from "./model/agentPermissionModeSafetyPolicy";
import {
  acknowledgeCodexFullAccessWarning,
  isCodexFullAccessWarningAcknowledged
} from "./view/agentFullAccessWarningPreference";

export function AgentFullAccessRestoredWarning({
  isSettingsLoading,
  permissionModeId,
  provider,
  visibleOnHome
}: {
  isSettingsLoading: boolean;
  permissionModeId: string | null | undefined;
  provider: string;
  visibleOnHome: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [dismissedForCurrentOpen, setDismissedForCurrentOpen] = useState(false);
  const acknowledged = isCodexFullAccessWarningAcknowledged();
  const normalizedPermissionModeId = permissionModeId?.trim() ?? "";
  const shouldShow =
    visibleOnHome &&
    !isSettingsLoading &&
    !dismissedForCurrentOpen &&
    !acknowledged &&
    requiresFullAccessSafetyConfirmation(provider, normalizedPermissionModeId);

  if (!shouldShow) {
    return null;
  }

  return (
    <section
      className={cn(
        "nodrag tsh-desktop-no-drag mb-2 flex flex-wrap items-center gap-3 rounded-[16px] px-4 py-3",
        "bg-[color-mix(in_srgb,var(--state-danger)_9%,var(--background-panel))]",
        "text-[var(--state-danger)] [-webkit-app-region:no-drag]"
      )}
      data-testid="agent-gui-restored-full-access-warning"
      role="alert"
    >
      <ShieldAlert aria-hidden="true" className="size-5 shrink-0" />
      <div className="min-w-[220px] flex-1">
        <p className="m-0 font-semibold leading-[1.35]">
          {t("agentHost.agentGui.fullAccessRestoredWarning.title")}
        </p>
        <p className="m-0 mt-0.5 text-[13px] leading-[1.45]">
          {t("agentHost.agentGui.fullAccessRestoredWarning.description")}
        </p>
      </div>
      <button
        className={cn(
          "ml-auto shrink-0 rounded-full px-4 py-2 text-[13px] font-medium",
          "bg-[color-mix(in_srgb,var(--state-danger)_10%,transparent)]",
          "transition-colors hover:bg-[color-mix(in_srgb,var(--state-danger)_16%,transparent)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--state-danger)]"
        )}
        type="button"
        onClick={() => {
          acknowledgeCodexFullAccessWarning();
          setDismissedForCurrentOpen(true);
        }}
      >
        {t("agentHost.agentGui.fullAccessRestoredWarning.dontShowAgain")}
      </button>
      <button
        aria-label={t(
          "agentHost.agentGui.fullAccessRestoredWarning.dismissLabel"
        )}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          "text-[var(--text-secondary)] transition-colors",
          "hover:bg-[var(--transparency-subtle)] hover:text-[var(--text-primary)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--state-danger)]"
        )}
        type="button"
        onClick={() => setDismissedForCurrentOpen(true)}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </section>
  );
}
