import { type JSX } from "react";
import {
  Button,
  RefreshIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { AgentSetupDialog } from "@tutti-os/agent-gui/agent-env-ui";
import { useTranslation } from "@renderer/i18n";
import { useAgentEnvWizard } from "./useAgentEnvWizard";
import { AgentEnvSetupTrack } from "./AgentEnvSetupTrack";
import { AgentEnvReportConsent } from "./AgentEnvReportConsent";
import { resolveProviderLabel } from "./agentEnvPanelText";

export function AgentEnvPanel(): JSX.Element | null {
  const { t } = useTranslation();
  const {
    open,
    provider,
    isSupported,
    viewModel,
    reportState,
    copied,
    logExpanded,
    actions
  } = useAgentEnvWizard();
  const providerLabel = resolveProviderLabel(provider);

  // Re-detect is disabled while an install runs (busy) or a detect is already in
  // flight (redetecting). Surface WHY via a tooltip — a disabled button with no
  // hint reads as broken.
  const redetectDisabled = viewModel.redetecting || viewModel.busy;
  const redetectDisabledReason = viewModel.busy
    ? t("workspace.agentEnv.redetectDisabledInstalling")
    : viewModel.redetecting
      ? t("workspace.agentEnv.redetectDisabledChecking")
      : null;
  const redetectButton = (
    <Button
      size="dialog"
      type="button"
      disabled={redetectDisabled}
      onClick={actions.redetect}
    >
      <RefreshIcon className="size-4" />
      {t("workspace.agentEnv.actionDetect")}
    </Button>
  );
  const redetectControl = redetectDisabledReason ? (
    <Tooltip>
      {/* A disabled <button> emits no hover events, so the tooltip hangs off a
          <span> wrapper that does. */}
      <TooltipTrigger asChild>
        <span className="inline-flex">{redetectButton}</span>
      </TooltipTrigger>
      <TooltipContent>{redetectDisabledReason}</TooltipContent>
    </Tooltip>
  ) : (
    redetectButton
  );

  // Do NOT early-return null when closed. This <Dialog> is a controlled Radix
  // dialog with disableOutsidePointerEvents; it must observe the open→false
  // transition to restore document.body pointer-events and the scroll lock.
  // Unmounting it while it still believes it is open strands the whole app
  // with `pointer-events: none` — clicks register nowhere and the wizard can
  // never be reopened until reload. Let the `open` prop drive visibility; the
  // DialogContent wrapper unmounts its own subtree after the close animation.
  return (
    <AgentSetupDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) actions.close();
      }}
      title={t("workspace.agentEnv.configTitle", { provider: providerLabel })}
      description={
        viewModel.ready
          ? t("workspace.agentEnv.configDescription", {
              provider: providerLabel
            })
          : t("workspace.agentEnv.wizardDescription", {
              provider: providerLabel
            })
      }
      afterContent={
        reportState === "confirming" ? (
          <AgentEnvReportConsent
            onCancel={actions.dismissReport}
            onAgree={actions.confirmReport}
            t={t}
          />
        ) : null
      }
      footer={redetectControl}
    >
      {!isSupported ? (
        <p className="m-0 text-[13px] text-[var(--text-secondary)]">
          {t("workspace.agentEnv.providerUnsupported")}
        </p>
      ) : (
        <AgentEnvSetupTrack
          viewModel={viewModel}
          providerLabel={providerLabel}
          copied={copied}
          logExpanded={logExpanded}
          actions={actions}
          t={t}
        />
      )}
    </AgentSetupDialog>
  );
}
