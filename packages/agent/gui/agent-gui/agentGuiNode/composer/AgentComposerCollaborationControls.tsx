import { useEffect, useState } from "react";
import { LoaderCircle, Users } from "lucide-react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  cn
} from "@tutti-os/ui-system";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type { AgentComposerCollaborationTargetMention } from "./composerAgentCollaboration";

export type AgentComposerCollaborationMode = "fork" | "delegate" | "handoff";
export type AgentComposerCollaborationContextScope = "none" | "recent" | "full";

interface Props {
  agentSessionId: string | null;
  attachmentCount: number;
  contextScope: AgentComposerCollaborationContextScope;
  delegationAllowed: boolean;
  disabled: boolean;
  errorMessage: string | null;
  mode: AgentComposerCollaborationMode | null;
  pending: boolean;
  runtime: AgentActivityRuntime | null;
  supplement: string;
  targets: readonly AgentComposerCollaborationTargetMention[];
  onContextScopeChange: (scope: AgentComposerCollaborationContextScope) => void;
  onModeChange: (mode: AgentComposerCollaborationMode) => void;
  onRetry: () => void;
  onChooseAnotherMode: () => void;
  onReturnToSession: () => void;
  onSupplementChange: (value: string) => void;
}

interface ContextPreviewMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function AgentComposerCollaborationControls({
  agentSessionId,
  attachmentCount,
  contextScope,
  delegationAllowed,
  disabled,
  errorMessage,
  mode,
  pending,
  runtime,
  supplement,
  targets,
  onContextScopeChange,
  onModeChange,
  onRetry,
  onChooseAnotherMode,
  onReturnToSession,
  onSupplementChange
}: Props): React.JSX.Element | null {
  "use memo";
  const [previewMessages, setPreviewMessages] = useState<
    ContextPreviewMessage[]
  >([]);
  const [previewStatus, setPreviewStatus] = useState<
    "idle" | "loading" | "ready" | "failed"
  >("idle");
  const target = targets[0] ?? null;
  const targetWorkspaceId = target?.workspaceId ?? "";

  useEffect(() => {
    if (
      !targetWorkspaceId ||
      contextScope === "none" ||
      !agentSessionId ||
      !runtime
    ) {
      setPreviewMessages([]);
      setPreviewStatus("idle");
      return;
    }
    const controller = new AbortController();
    setPreviewStatus("loading");
    void runtime
      .listSessionMessages({
        agentSessionId,
        limit: contextScope === "recent" ? 12 : 48,
        order: "desc",
        signal: controller.signal,
        workspaceId: targetWorkspaceId
      })
      .then((page) => {
        if (controller.signal.aborted) {
          return;
        }
        setPreviewMessages(contextPreviewMessages(page.messages));
        setPreviewStatus("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) {
          return;
        }
        setPreviewMessages([]);
        setPreviewStatus("failed");
      });
    return () => controller.abort();
  }, [agentSessionId, contextScope, runtime, targetWorkspaceId]);

  if (!target) {
    return null;
  }

  const blockingMessage =
    targets.length > 1
      ? translate("agentHost.agentGui.collaborationComposerSingleAgentOnly")
      : attachmentCount > 0
        ? translate(
            "agentHost.agentGui.collaborationComposerAttachmentsUnsupported"
          )
        : !agentSessionId
          ? translate("agentHost.agentGui.collaborationComposerNoSession")
          : !runtime?.startAgentCollaboration
            ? translate("agentHost.agentGui.collaborationComposerUnavailable")
            : !delegationAllowed
              ? translate(
                  "agentHost.agentGui.collaborationComposerPolicyDenied"
                )
              : null;
  const controlDisabled = disabled || pending || blockingMessage !== null;
  const preparedStatus = errorMessage
    ? "failed"
    : pending
      ? "running"
      : "prepared";

  return (
    <section
      className="mx-2 mb-1 mt-0 rounded-[8px] border border-[var(--line-2)] bg-[var(--background-secondary)] px-2.5 py-2 text-[12px] text-[var(--text-secondary)]"
      data-testid="agent-composer-collaboration-controls"
      data-collaboration-status={preparedStatus}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-[var(--text-primary)]">
          {pending ? (
            <LoaderCircle
              aria-hidden="true"
              className="shrink-0 animate-spin"
              size={13}
            />
          ) : (
            <Users aria-hidden="true" className="shrink-0" size={13} />
          )}
          <span className="truncate">
            {translate("agentHost.agentGui.collaborationComposerTitle", {
              name: target.name
            })}
          </span>
        </span>
        <span
          className="inline-flex rounded-full bg-[var(--background-fronted)] px-2 text-[11px] leading-[18px] text-[var(--text-tertiary)]"
          data-testid="agent-composer-collaboration-status"
        >
          {translate(
            preparedStatus === "prepared"
              ? "agentHost.agentGui.collaborationStatusPrepared"
              : preparedStatus === "running"
                ? "agentHost.agentGui.collaborationStatusRunning"
                : "agentHost.agentGui.collaborationStatusFailed"
          )}
        </span>
        <Select
          disabled={controlDisabled}
          value={mode ?? ""}
          onValueChange={(value) => {
            if (isCollaborationMode(value)) {
              onModeChange(value);
            }
          }}
        >
          <SelectTrigger
            aria-label={translate(
              "agentHost.agentGui.collaborationComposerModeLabel"
            )}
            className="h-7 w-auto min-w-[132px] rounded-[6px] border-[var(--line-2)] bg-[var(--background-fronted)] px-2 text-[12px]"
          >
            {mode
              ? collaborationModeLabel(mode)
              : translate(
                  "agentHost.agentGui.collaborationComposerModePlaceholder"
                )}
          </SelectTrigger>
          <SelectContent align="start" side="top">
            <SelectItem value="fork">
              {translate("agentHost.agentGui.collaborationModeFork")}
            </SelectItem>
            <SelectItem value="delegate">
              {translate("agentHost.agentGui.collaborationModeDelegate")}
            </SelectItem>
            <SelectItem value="handoff">
              {translate("agentHost.agentGui.collaborationModeHandoff")}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          disabled={controlDisabled}
          value={contextScope}
          onValueChange={(value) => {
            if (isContextScope(value)) {
              onContextScopeChange(value);
            }
          }}
        >
          <SelectTrigger
            aria-label={translate(
              "agentHost.agentGui.collaborationComposerContextLabel"
            )}
            className="h-7 w-auto min-w-[152px] rounded-[6px] border-[var(--line-2)] bg-[var(--background-fronted)] px-2 text-[12px]"
          >
            {collaborationContextLabel(contextScope)}
          </SelectTrigger>
          <SelectContent align="start" side="top">
            <SelectItem value="none">
              {translate("agentHost.agentGui.collaborationComposerContextNone")}
            </SelectItem>
            <SelectItem value="recent">
              {translate(
                "agentHost.agentGui.collaborationComposerContextRecent"
              )}
            </SelectItem>
            <SelectItem value="full">
              {translate("agentHost.agentGui.collaborationComposerContextFull")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {contextScope !== "none" ? (
        <details
          className="mt-1.5"
          data-testid="agent-collaboration-context-preview"
        >
          <summary className="cursor-pointer select-none text-[11px] text-[var(--text-tertiary)]">
            {previewStatus === "loading"
              ? translate(
                  "agentHost.agentGui.collaborationComposerContextLoading"
                )
              : translate(
                  "agentHost.agentGui.collaborationComposerContextPreview",
                  { count: String(previewMessages.length) }
                )}
          </summary>
          <div
            className={cn(
              "mt-1.5 max-h-24 overflow-auto rounded-[6px] border border-[var(--line-2)] bg-[var(--background-fronted)] px-2 py-1.5 text-[11px]",
              previewStatus === "failed" && "text-[var(--state-danger)]"
            )}
          >
            {previewStatus === "failed"
              ? translate(
                  "agentHost.agentGui.collaborationComposerContextLoadFailed"
                )
              : previewMessages.length === 0
                ? translate(
                    "agentHost.agentGui.collaborationComposerContextEmpty"
                  )
                : previewMessages.map((message) => (
                    <p className="mb-1 last:mb-0" key={message.id}>
                      <strong className="font-medium capitalize">
                        {message.role}:
                      </strong>{" "}
                      {message.text}
                    </p>
                  ))}
          </div>
        </details>
      ) : null}
      <label className="mt-1.5 block">
        <span className="sr-only">
          {translate(
            "agentHost.agentGui.collaborationComposerContextSupplementLabel"
          )}
        </span>
        <textarea
          className="block min-h-8 w-full resize-y rounded-[6px] border border-[var(--line-2)] bg-[var(--background-fronted)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--line-1)] disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="agent-collaboration-context-supplement"
          disabled={controlDisabled}
          placeholder={translate(
            "agentHost.agentGui.collaborationComposerContextSupplementPlaceholder"
          )}
          rows={1}
          value={supplement}
          onChange={(event) => onSupplementChange(event.target.value)}
        />
      </label>
      {blockingMessage || errorMessage || !mode ? (
        <p
          className={cn(
            "mt-1.5 text-[11px]",
            blockingMessage || errorMessage
              ? "text-[var(--state-danger)]"
              : "text-[var(--text-tertiary)]"
          )}
          data-testid="agent-collaboration-validation"
          role={blockingMessage || errorMessage ? "alert" : "status"}
        >
          {blockingMessage ??
            errorMessage ??
            translate("agentHost.agentGui.collaborationComposerModeRequired")}
        </p>
      ) : null}
      {errorMessage && !blockingMessage ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button
            disabled={controlDisabled}
            size="sm"
            type="button"
            onClick={onRetry}
          >
            {translate("agentHost.agentGui.collaborationComposerRetry")}
          </Button>
          <Button
            disabled={controlDisabled}
            size="sm"
            type="button"
            variant="secondary"
            onClick={onChooseAnotherMode}
          >
            {translate(
              "agentHost.agentGui.collaborationComposerChooseAnotherMode"
            )}
          </Button>
          <Button
            disabled={controlDisabled}
            size="sm"
            type="button"
            variant="ghost"
            onClick={onReturnToSession}
          >
            {translate(
              "agentHost.agentGui.collaborationComposerReturnToSession"
            )}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function isCollaborationMode(
  value: string
): value is AgentComposerCollaborationMode {
  return value === "fork" || value === "delegate" || value === "handoff";
}

function isContextScope(
  value: string
): value is AgentComposerCollaborationContextScope {
  return value === "none" || value === "recent" || value === "full";
}

function collaborationModeLabel(mode: AgentComposerCollaborationMode): string {
  switch (mode) {
    case "fork":
      return translate("agentHost.agentGui.collaborationModeFork");
    case "delegate":
      return translate("agentHost.agentGui.collaborationModeDelegate");
    case "handoff":
      return translate("agentHost.agentGui.collaborationModeHandoff");
  }
}

function collaborationContextLabel(
  scope: AgentComposerCollaborationContextScope
): string {
  switch (scope) {
    case "none":
      return translate("agentHost.agentGui.collaborationComposerContextNone");
    case "recent":
      return translate("agentHost.agentGui.collaborationComposerContextRecent");
    case "full":
      return translate("agentHost.agentGui.collaborationComposerContextFull");
  }
}

function contextPreviewMessages(
  messages: readonly AgentActivityMessage[]
): ContextPreviewMessage[] {
  return [...messages].reverse().flatMap((message) => {
    const role = message.role.trim().toLowerCase();
    if (role !== "user" && role !== "assistant") {
      return [];
    }
    const text = collaborationMessageText(message.payload);
    return text
      ? [{ id: message.messageId, role, text } satisfies ContextPreviewMessage]
      : [];
  });
}

function collaborationMessageText(payload: Record<string, unknown>): string {
  for (const key of ["text", "content", "message"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  return blocks
    .flatMap((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return [];
      }
      const text = (block as Record<string, unknown>).text;
      return typeof text === "string" && text.trim() ? [text.trim()] : [];
    })
    .join("\n");
}
