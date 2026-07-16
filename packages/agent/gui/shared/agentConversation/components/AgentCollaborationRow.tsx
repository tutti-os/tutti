import { useState, type JSX } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  GitFork,
  LoaderCircle,
  MessageCircleQuestion,
  RefreshCw,
  Square,
  Users
} from "lucide-react";
import { Button, toast } from "@tutti-os/ui-system";
import { translate } from "../../../i18n/index";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import { useOptionalAgentActivityRuntime } from "../../../agentActivityRuntime";
import {
  AgentMessageMarkdown,
  type AgentMessageMarkdownWorkspaceAppIcon
} from "../../AgentMessageMarkdown";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentCollaborationVM } from "../contracts/agentCollaborationVM";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";

/**
 * Transcript card for one durable collaboration run (model consult, fork,
 * delegate, or handoff). The daemon updates the same message in place as the
 * run progresses, so all durable state comes from the projected
 * `AgentCollaborationVM`; the card owns only UI-local interaction state
 * (result disclosure, in-flight adoption action + optimistic echo).
 */
export function AgentCollaborationRow({
  collaboration,
  workspaceRoot,
  basePath,
  onLinkAction,
  workspaceAppIcons,
  onReviseCollaboration,
  previewMode = false
}: {
  collaboration: AgentCollaborationVM;
  workspaceRoot: string | null;
  basePath: string;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  onReviseCollaboration?: (collaboration: AgentCollaborationVM) => void;
  previewMode?: boolean;
}): JSX.Element {
  "use memo";
  const agentHostApi = useOptionalAgentHostApi();
  const runtime = useOptionalAgentActivityRuntime();
  const [resultExpanded, setResultExpanded] = useState(false);
  const [adoptionPending, setAdoptionPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  // Optimistic echo until the daemon's in-place message update arrives.
  const [localAdoption, setLocalAdoption] = useState<string | null>(null);

  const adoption = localAdoption ?? collaboration.adoption;
  const resultText = collaboration.resultText?.trim() ?? "";
  const canSubmitAdoption = Boolean(
    runtime?.setCollaborationAdoption &&
    collaboration.workspaceId &&
    collaboration.agentSessionId &&
    !previewMode
  );
  const showAdoptionControls =
    (collaboration.mode === "consult" || collaboration.mode === "delegate") &&
    adoption !== "not_applicable" &&
    collaboration.status === "completed" &&
    canSubmitAdoption;
  const canCancel = Boolean(
    runtime?.cancelCollaboration &&
    collaboration.workspaceId &&
    collaboration.status === "running" &&
    !previewMode
  );
  const canRetry = Boolean(
    runtime?.retryCollaboration &&
    collaboration.workspaceId &&
    collaboration.status === "failed" &&
    !previewMode
  );
  const canReturnFailed =
    collaboration.status === "failed" &&
    (collaboration.mode === "consult" || collaboration.mode === "delegate") &&
    adoption === "pending" &&
    canSubmitAdoption;
  const canReviseFailed = Boolean(
    collaboration.status === "failed" &&
    collaboration.requestText?.trim() &&
    onReviseCollaboration &&
    !previewMode
  );

  const retryCollaboration = async (): Promise<void> => {
    const retry = runtime?.retryCollaboration;
    if (
      !retry ||
      !collaboration.workspaceId ||
      collaboration.status !== "failed" ||
      retryPending
    ) {
      return;
    }
    setRetryPending(true);
    try {
      await retry({
        runId: collaboration.runId,
        workspaceId: collaboration.workspaceId
      });
    } catch (error) {
      void agentHostApi?.debug?.logRuntimeDiagnostics?.({
        details: {
          error: error instanceof Error ? error.message : String(error),
          runId: collaboration.runId
        },
        event: "agent_gui.collaboration_retry.failed"
      });
      const message = translate("agentHost.agentGui.collaborationRetryFailed");
      if (agentHostApi?.toast?.error) {
        agentHostApi.toast.error(message);
      } else {
        toast.error(message);
      }
    } finally {
      setRetryPending(false);
    }
  };

  const cancelCollaboration = async (): Promise<void> => {
    const cancel = runtime?.cancelCollaboration;
    if (
      !cancel ||
      !collaboration.workspaceId ||
      collaboration.status !== "running" ||
      cancelPending
    ) {
      return;
    }
    setCancelPending(true);
    try {
      await cancel({
        runId: collaboration.runId,
        workspaceId: collaboration.workspaceId
      });
    } catch (error) {
      void agentHostApi?.debug?.logRuntimeDiagnostics?.({
        details: {
          error: error instanceof Error ? error.message : String(error),
          runId: collaboration.runId
        },
        event: "agent_gui.collaboration_cancel.failed"
      });
      const message = translate("agentHost.agentGui.collaborationCancelFailed");
      if (agentHostApi?.toast?.error) {
        agentHostApi.toast.error(message);
      } else {
        toast.error(message);
      }
    } finally {
      setCancelPending(false);
    }
  };

  const submitAdoption = async (
    nextAdoption: "adopted" | "rejected"
  ): Promise<void> => {
    const setCollaborationAdoption = runtime?.setCollaborationAdoption;
    if (
      !setCollaborationAdoption ||
      !collaboration.workspaceId ||
      !collaboration.agentSessionId ||
      adoptionPending
    ) {
      return;
    }
    setAdoptionPending(true);
    try {
      const run = await setCollaborationAdoption({
        adoption: nextAdoption,
        agentSessionId: collaboration.agentSessionId,
        runId: collaboration.runId,
        workspaceId: collaboration.workspaceId
      });
      setLocalAdoption(run.adoption);
    } catch (error) {
      void agentHostApi?.debug?.logRuntimeDiagnostics?.({
        details: {
          error: error instanceof Error ? error.message : String(error),
          runId: collaboration.runId
        },
        event: "agent_gui.collaboration_adoption.failed"
      });
      const message = translate(
        "agentHost.agentGui.collaborationAdoptionFailed"
      );
      if (agentHostApi?.toast?.error) {
        agentHostApi.toast.error(message);
      } else {
        toast.error(message);
      }
    } finally {
      setAdoptionPending(false);
    }
  };

  const ModeIcon = collaborationModeIcon(collaboration.mode);
  const planText = collaboration.modelPlanName ?? collaboration.modelPlanId;

  return (
    <section
      data-testid="agent-collaboration-row"
      data-collaboration-run-id={collaboration.runId}
      data-collaboration-mode={collaboration.mode}
      data-collaboration-status={collaboration.status}
      className="box-border w-full min-w-0 rounded-[8px] border border-[var(--line-2)] bg-[var(--background-fronted)] p-3 text-[13px] leading-5 text-[var(--text-primary)]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
          <ModeIcon
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className="shrink-0 text-[var(--text-secondary)]"
          />
          <span className="truncate">
            {collaborationModeLabel(collaboration.mode)}
          </span>
        </span>
        <span
          data-testid="agent-collaboration-trigger"
          className="shrink-0 rounded-full border border-[var(--line-2)] px-1.5 text-[11px] leading-4 text-[var(--text-tertiary)]"
        >
          {collaborationTriggerLabel(collaboration.triggerSource)}
        </span>
        {planText || collaboration.model ? (
          <span
            data-testid="agent-collaboration-model"
            className="min-w-0 truncate text-[12px] text-[var(--text-tertiary)]"
          >
            {planText
              ? translate("agentHost.agentGui.collaborationPlanLabel", {
                  name: planText
                })
              : null}
            {planText && collaboration.model ? " · " : null}
            {collaboration.model}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <span
          data-testid="agent-collaboration-status"
          data-status={collaboration.status}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-[11px] leading-[18px] ${collaborationStatusClassName(collaboration.status)}`}
        >
          {collaboration.status === "running" ? (
            <LoaderCircle
              size={11}
              strokeWidth={2.2}
              aria-hidden="true"
              className="animate-spin"
            />
          ) : null}
          {collaborationStatusLabel(collaboration.status)}
          {collaboration.durationMs !== null &&
          collaboration.status !== "running"
            ? ` · ${formatCollaborationDuration(collaboration.durationMs)}`
            : null}
        </span>
      </div>
      {collaboration.usage ? (
        <div
          data-testid="agent-collaboration-usage"
          className="mt-1 text-[11px] text-[var(--text-tertiary)]"
        >
          {translate("agentHost.agentGui.collaborationUsageTokens", {
            input: String(collaboration.usage.inputTokens),
            output: String(collaboration.usage.outputTokens),
            cacheRead: String(collaboration.usage.cacheReadTokens),
            cacheWrite: String(collaboration.usage.cacheWriteTokens)
          })}
        </div>
      ) : null}
      <div
        data-testid="agent-collaboration-attempt"
        className="mt-1 text-[11px] text-[var(--text-tertiary)]"
      >
        {translate("agentHost.agentGui.collaborationAttempt", {
          attempt: String(collaboration.attempt)
        })}
        {collaboration.retryOfRunId
          ? ` · ${translate("agentHost.agentGui.collaborationRetryOf", {
              runId: collaboration.retryOfRunId
            })}`
          : null}
      </div>
      {collaboration.cost ? (
        <div
          data-testid="agent-collaboration-cost"
          className="mt-1 text-[11px] text-[var(--text-tertiary)]"
        >
          {translate("agentHost.agentGui.collaborationEstimatedCost", {
            cost: formatCollaborationCost(collaboration.cost)
          })}
        </div>
      ) : null}
      {collaboration.failureReason ? (
        <div
          data-testid="agent-collaboration-failure"
          className="mt-1.5 text-[12px] text-[var(--state-danger)]"
        >
          {translate("agentHost.agentGui.collaborationFailureReason", {
            reason: collaboration.failureReason
          })}
        </div>
      ) : null}
      {collaboration.failureStage ? (
        <div
          data-testid="agent-collaboration-failure-stage"
          className="mt-1 text-[11px] text-[var(--text-tertiary)]"
        >
          {translate("agentHost.agentGui.collaborationFailureStage", {
            stage: collaboration.failureStage
          })}
        </div>
      ) : null}
      {canRetry || canReviseFailed || canReturnFailed ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canRetry ? (
            <Button
              data-testid="agent-collaboration-retry"
              disabled={retryPending || adoptionPending}
              size="sm"
              type="button"
              onClick={() => void retryCollaboration()}
            >
              {retryPending ? (
                <LoaderCircle
                  className="animate-spin"
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
              )}
              {translate("agentHost.agentGui.collaborationRetry")}
            </Button>
          ) : null}
          {canReviseFailed ? (
            <Button
              data-testid="agent-collaboration-revise"
              disabled={retryPending || adoptionPending}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => onReviseCollaboration?.(collaboration)}
            >
              <ArrowRightLeft size={12} strokeWidth={2} aria-hidden="true" />
              {translate("agentHost.agentGui.collaborationRevise")}
            </Button>
          ) : null}
          {canReturnFailed ? (
            <Button
              data-testid="agent-collaboration-return-user"
              disabled={retryPending || adoptionPending}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => void submitAdoption("rejected")}
            >
              {translate("agentHost.agentGui.collaborationReturnUser")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {canCancel ? (
        <div className="mt-2">
          <button
            type="button"
            data-testid="agent-collaboration-cancel"
            disabled={cancelPending}
            className="inline-flex h-6 items-center gap-1 rounded-[6px] border border-[var(--line-2)] px-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--state-danger)] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void cancelCollaboration()}
          >
            {cancelPending ? (
              <LoaderCircle
                size={12}
                strokeWidth={2}
                aria-hidden="true"
                className="animate-spin"
              />
            ) : (
              <Square size={11} strokeWidth={2} aria-hidden="true" />
            )}
            {translate("agentHost.agentGui.collaborationCancel")}
          </button>
        </div>
      ) : null}
      {collaboration.mode === "consult" && resultText ? (
        <div className="mt-2">
          <button
            type="button"
            data-testid="agent-collaboration-result-toggle"
            aria-expanded={resultExpanded}
            className="inline-flex items-center gap-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            onClick={() => setResultExpanded((value) => !value)}
          >
            {translate(
              resultExpanded
                ? "agentHost.agentGui.collaborationResultHide"
                : "agentHost.agentGui.collaborationResultShow"
            )}
            {resultExpanded ? (
              <ChevronUp size={13} strokeWidth={2} aria-hidden="true" />
            ) : (
              <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
          {resultExpanded ? (
            <div
              data-testid="agent-collaboration-result"
              className="mt-1.5 min-w-0"
            >
              <AgentMessageMarkdown
                content={resultText}
                className={styles.assistantMarkdown}
                onLinkAction={onLinkAction}
                workspaceLinkContext={{
                  workspaceRoot,
                  basePath,
                  source: "agent-markdown"
                }}
                workspaceAppIcons={workspaceAppIcons}
                deferLongContentRender
                enableImageZoom
                previewMode={previewMode}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {showAdoptionControls && adoption === "pending" ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            data-testid="agent-collaboration-adopt"
            disabled={adoptionPending}
            className="inline-flex h-6 items-center rounded-[6px] border border-[var(--line-2)] px-2 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void submitAdoption("adopted")}
          >
            {translate("agentHost.agentGui.collaborationAdopt")}
          </button>
          <button
            type="button"
            data-testid="agent-collaboration-reject"
            disabled={adoptionPending}
            className="inline-flex h-6 items-center rounded-[6px] border border-[var(--line-2)] px-2 text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void submitAdoption("rejected")}
          >
            {translate("agentHost.agentGui.collaborationReject")}
          </button>
        </div>
      ) : null}
      {adoption === "adopted" || adoption === "rejected" ? (
        <div
          data-testid="agent-collaboration-adoption"
          data-adoption={adoption}
          className="mt-2 text-[11px] text-[var(--text-tertiary)]"
        >
          {translate(
            adoption === "adopted"
              ? "agentHost.agentGui.collaborationAdopted"
              : "agentHost.agentGui.collaborationRejected"
          )}
        </div>
      ) : null}
    </section>
  );
}

function formatCollaborationCost(
  cost: NonNullable<AgentCollaborationVM["cost"]>
): string {
  const amount = cost.estimatedMicros / 1_000_000;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cost.currency,
      maximumFractionDigits: 6
    }).format(amount);
  } catch {
    return `${cost.currency} ${amount.toFixed(6)}`;
  }
}

function collaborationModeIcon(
  mode: AgentCollaborationVM["mode"]
): typeof MessageCircleQuestion {
  switch (mode) {
    case "fork":
      return GitFork;
    case "delegate":
      return Users;
    case "handoff":
      return ArrowRightLeft;
    default:
      return MessageCircleQuestion;
  }
}

function collaborationModeLabel(mode: AgentCollaborationVM["mode"]): string {
  switch (mode) {
    case "consult":
      return translate("agentHost.agentGui.collaborationModeConsult");
    case "fork":
      return translate("agentHost.agentGui.collaborationModeFork");
    case "delegate":
      return translate("agentHost.agentGui.collaborationModeDelegate");
    case "handoff":
      return translate("agentHost.agentGui.collaborationModeHandoff");
    default:
      return mode;
  }
}

function collaborationTriggerLabel(
  triggerSource: AgentCollaborationVM["triggerSource"]
): string {
  switch (triggerSource) {
    case "user":
      return translate("agentHost.agentGui.collaborationTriggerUser");
    case "agent":
      return translate("agentHost.agentGui.collaborationTriggerAgent");
    case "policy":
      return translate("agentHost.agentGui.collaborationTriggerPolicy");
    case "automation":
      return translate("agentHost.agentGui.collaborationTriggerAutomation");
    default:
      return triggerSource;
  }
}

function collaborationStatusLabel(
  status: AgentCollaborationVM["status"]
): string {
  switch (status) {
    case "running":
      return translate("agentHost.agentGui.collaborationStatusRunning");
    case "completed":
      return translate("agentHost.agentGui.collaborationStatusCompleted");
    case "failed":
      return translate("agentHost.agentGui.collaborationStatusFailed");
    case "canceled":
      return translate("agentHost.agentGui.collaborationStatusCanceled");
    default:
      return status;
  }
}

function collaborationStatusClassName(
  status: AgentCollaborationVM["status"]
): string {
  switch (status) {
    case "failed":
      return "bg-[var(--on-danger)] text-[var(--state-danger)]";
    case "running":
      return "bg-[color-mix(in_srgb,var(--tutti-purple)_12%,transparent)] text-[var(--tutti-purple)]";
    default:
      return "bg-[var(--transparency-hover)] text-[var(--text-secondary)]";
  }
}

function formatCollaborationDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
