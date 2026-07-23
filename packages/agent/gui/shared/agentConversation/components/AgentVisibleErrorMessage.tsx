import type { JSX } from "react";
import { Button } from "../../../app/renderer/components/ui/button";
import { translate } from "../../../i18n/index";
import { workspaceAgentProviderLabel } from "../../workspaceAgentProviderLabel";
import { useOpenAgentEnvPanel } from "../../agentEnv";
import {
  classifyRecoverableAgentMessage,
  resolveAgentErrorPresentation
} from "../../agentEnv/agentErrorPresentation";
import { useAgentCommercePresentation } from "../../commerce/AgentCommercePresentationContext";
import type { AgentMessageContentVM } from "../contracts/agentMessageRowVM";

// All error banners use the light-red danger surface. Yellow/warning surfaces
// are banned for notice boxes — see "Badges And Status" in
// docs/conventions/desktop-visual-language.md.
const ERROR_BANNER_CLASS_NAME =
  "border-[var(--on-danger-hover)] bg-[var(--on-danger)] text-[var(--state-danger)]";

// Builds a synthetic visibleError from a plain message whose text and terminal
// status identify a recognizable environment failure.
export function recoverVisibleErrorFromMessage(
  message: AgentMessageContentVM,
  provider: string | null | undefined
): AgentMessageContentVM | null {
  const code = classifyRecoverableAgentMessage({
    body: message.body,
    statusKind: message.statusKind
  });
  if (!code) {
    return null;
  }
  return {
    ...message,
    visibleError: {
      code,
      phase: null,
      provider: provider ?? null,
      detail: message.body,
      retryable: null
    }
  };
}

export function AgentVisibleErrorMessage({
  message,
  onExternalLink
}: {
  message: AgentMessageContentVM;
  onAuthLogin?: (provider?: string | null) => void;
  onExternalLink?: (href: string) => void;
}): JSX.Element {
  "use memo";
  const openAgentEnvPanel = useOpenAgentEnvPanel();
  const commercePresentation = useAgentCommercePresentation();
  const error = message.visibleError;

  // One card for every run-failure code. The presentation (keyed on the codes
  // the daemon actually emits — see agentErrorPresentation) supplies a granular,
  // provider-aware message and, when the failure is something the env wizard can
  // detect or repair, a single deep-linking call-to-action. Transient/server-side
  // failures resolve to no focus, so no (misleading) wizard button is shown.
  const providerLabel = workspaceAgentProviderLabel(
    error?.provider ?? "unknown"
  );
  const presentation = resolveAgentErrorPresentation(
    error?.code,
    commercePresentation
  );
  const headline = presentation?.messageKey
    ? translate(presentation.messageKey, { provider: providerLabel })
    : visibleErrorTitle(message);
  const focus = presentation?.focus ?? null;
  const actionKey = presentation?.actionKey ?? null;
  const externalUrl = presentation?.externalUrl ?? null;
  const hint = visibleErrorHint(message);
  // Account limits are status notices, not process crashes. Provider payloads
  // stay in the canonical model and diagnostics; the product card never renders
  // raw upstream text.
  const isPlanOrQuotaLimit =
    error?.code === "quota_or_rate_limit" ||
    error?.code === "insufficient_credits";
  return (
    <section
      role={isPlanOrQuotaLimit ? "status" : "alert"}
      className={`box-border w-full min-w-0 rounded-[8px] border p-3 text-[13px] leading-5 text-[var(--text-primary)] ${ERROR_BANNER_CLASS_NAME}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--text-primary)]">
            {headline}
          </div>
          {hint ? (
            <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
              {hint}
            </div>
          ) : null}
        </div>
        {actionKey &&
        ((focus && openAgentEnvPanel) || (externalUrl && onExternalLink)) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-0.5 shrink-0"
            onClick={() => {
              if (externalUrl) {
                onExternalLink?.(externalUrl);
                return;
              }
              if (focus && openAgentEnvPanel) {
                openAgentEnvPanel({
                  provider: error?.provider ?? null,
                  focus
                });
              }
            }}
          >
            {translate(actionKey)}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function visibleErrorTitle(message: AgentMessageContentVM): string {
  const error = message.visibleError;
  const provider = workspaceAgentProviderLabel(error?.provider ?? "unknown");
  switch (error?.code) {
    case "auth_required":
      return translate("agentHost.agentGui.visibleErrorAuthRequired", {
        provider
      });
    case "request_timed_out":
      return translate("agentHost.agentGui.visibleErrorRequestTimedOut", {
        provider
      });
    case "runtime_unavailable":
      return translate("agentHost.agentGui.visibleErrorRuntimeUnavailable", {
        provider
      });
    case "quota_or_rate_limit":
      return translate("agentHost.agentGui.visibleErrorQuotaOrRateLimit", {
        provider
      });
    default:
      if (error?.phase === "start") {
        return translate("agentHost.agentGui.visibleErrorStartFailed", {
          provider
        });
      }
      return translate("agentHost.agentGui.visibleErrorRequestFailed", {
        provider
      });
  }
}

function visibleErrorHint(message: AgentMessageContentVM): string | null {
  const error = message.visibleError;
  if (error?.code !== "auth_required") {
    return null;
  }
  return translate(
    "agentHost.agentGui.visibleErrorAuthRequiredLocalAgentHint",
    {
      provider: workspaceAgentProviderLabel(error.provider ?? "unknown")
    }
  );
}
