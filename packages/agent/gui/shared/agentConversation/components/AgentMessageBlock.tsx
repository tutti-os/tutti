import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX
} from "react";
import { AlertTriangle, ChevronRight, Info, ListChecks } from "lucide-react";
import { Button } from "../../../app/renderer/components/ui/button";
import { translate } from "../../../i18n/index";
import { getOptionalAgentActivityRuntime } from "../../../agentActivityRuntime";
import { ZoomableImage } from "../../../app/renderer/components/ZoomableImage";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import {
  AgentMessageMarkdown,
  type AgentMessageMarkdownWorkspaceAppIcon
} from "../../AgentMessageMarkdown";
import { AgentRichTextReadonly } from "../../AgentRichTextReadonly";
import { resolveAgentConversationLinkAction } from "../actions/agentConversationLinkActions";
import { workspaceAgentProviderLabel } from "../../workspaceAgentProviderLabel";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import type {
  AgentMessageContentVM,
  AgentMessageImageVM,
  AgentMessageRowVM
} from "../contracts/agentMessageRowVM";
import { CollapsibleReveal } from "./CollapsibleReveal";
import { AgentThinkingDisclosure } from "./AgentThinkingDisclosure";
import { RawTimelineJsonDisclosure } from "./RawTimelineJsonDisclosure";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";

interface AgentMessageBlockProps {
  workspaceRoot: string | null;
  basePath: string;
  row: AgentMessageRowVM;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  thinkingLabel: string;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  showRawTimelineJson?: boolean;
  rawTimelineJsonLabel?: string;
}

export function AgentMessageBlock({
  workspaceRoot,
  basePath,
  row,
  onLinkAction,
  thinkingLabel,
  onAuthLogin,
  availableSkills,
  workspaceAppIcons,
  showRawTimelineJson = false,
  rawTimelineJsonLabel = ""
}: AgentMessageBlockProps): JSX.Element {
  "use memo";
  const isUser = row.speaker === "user";
  const handleLinkClick = useCallback(
    (href: string): void => {
      const action = resolveAgentConversationLinkAction({
        workspaceRoot,
        basePath,
        href,
        source: "agent-markdown"
      });
      if (action) {
        onLinkAction?.(action);
      }
    },
    [basePath, onLinkAction, workspaceRoot]
  );
  const thinkingContent = !isUser
    ? row.thinking.map((thinking) => (
        <AgentThinkingDisclosure
          key={thinking.id}
          thinking={thinking}
          label={thinkingLabel}
          onLinkClick={handleLinkClick}
          showRawTimelineJson={showRawTimelineJson}
          rawTimelineJsonLabel={rawTimelineJsonLabel}
        />
      ))
    : null;

  return (
    <div
      className={isUser ? styles.userMessageFlow : styles.assistantMessageFlow}
    >
      {thinkingContent}
      {row.messages.map((message) => {
        const rawTimelineJson =
          showRawTimelineJson &&
          rawTimelineJsonLabel &&
          (message.sourceTimelineItems?.length ?? 0) > 0 ? (
            <RawTimelineJsonDisclosure
              items={message.sourceTimelineItems}
              label={rawTimelineJsonLabel}
            />
          ) : null;
        const content =
          isUser && message.contentKind === "image-grid" ? (
            <AgentUserImageGrid message={message} />
          ) : isUser ? (
            <AgentRichTextReadonly
              value={message.body}
              className={`workspace-agents-status-panel__detail-user-message ${styles.userMessageBubble}`}
              editorClassName="text-[inherit]"
              onLinkClick={handleLinkClick}
              availableSkills={availableSkills}
              workspaceAppIcons={workspaceAppIcons}
            />
          ) : message.visibleError ? (
            <AgentVisibleErrorMessage
              message={message}
              onAuthLogin={onAuthLogin}
            />
          ) : message.systemNotice ? (
            <AgentSystemNoticeMessage message={message} />
          ) : message.contentKind === "plan" ? (
            <AgentPlanCardMessage
              message={message}
              workspaceRoot={workspaceRoot}
              basePath={basePath}
              onLinkAction={onLinkAction}
              workspaceAppIcons={workspaceAppIcons}
            />
          ) : (
            <AgentMessageMarkdown
              content={message.body}
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
            />
          );

        if (rawTimelineJson) {
          return (
            <div key={message.id} className={styles.messageGroup}>
              {content}
              {rawTimelineJson}
            </div>
          );
        }

        return <Fragment key={message.id}>{content}</Fragment>;
      })}
    </div>
  );
}

function AgentUserImageGrid({
  message
}: {
  message: AgentMessageContentVM;
}): JSX.Element {
  "use memo";
  const images = message.images ?? [];
  const loadedImages = useAgentMessageImageSources(images);
  const columnCount = Math.min(Math.max(images.length, 1), 4);
  return (
    <div
      className="grid justify-self-end gap-2"
      style={{ gridTemplateColumns: `repeat(${columnCount}, 80px)` }}
    >
      {images.map((image) => {
        const src = loadedImages.get(image.id) ?? imageDataUrl(image);
        return (
          <div
            key={image.id}
            className="size-20 min-w-0 overflow-hidden rounded-[6px]"
          >
            {src ? (
              <ZoomableImage
                src={src}
                alt={image.name?.trim() || "image"}
                className="size-full object-cover"
                draggable={false}
              />
            ) : (
              <div className="size-full animate-pulse bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function useAgentMessageImageSources(
  images: readonly AgentMessageImageVM[]
): ReadonlyMap<string, string> {
  const runtime = getOptionalAgentActivityRuntime();
  const [sources, setSources] = useState<Map<string, string>>(() => new Map());
  const missingImages = useMemo(
    () =>
      images.filter(
        (image) =>
          !imageDataUrl(image) &&
          !sources.has(image.id) &&
          image.workspaceId &&
          image.agentSessionId &&
          image.attachmentId
      ),
    [images, sources]
  );

  useEffect(() => {
    if (!runtime?.readSessionAttachment || missingImages.length === 0) {
      return;
    }
    let canceled = false;
    for (const image of missingImages) {
      void runtime
        .readSessionAttachment({
          workspaceId: image.workspaceId ?? "",
          agentSessionId: image.agentSessionId,
          attachmentId: image.attachmentId ?? ""
        })
        .then((attachment) => {
          if (canceled) {
            return;
          }
          setSources((current) => {
            if (current.has(image.id)) {
              return current;
            }
            const next = new Map(current);
            next.set(
              image.id,
              `data:${attachment.mimeType};base64,${attachment.data}`
            );
            return next;
          });
        })
        .catch(() => {});
    }
    return () => {
      canceled = true;
    };
  }, [missingImages, runtime]);

  return sources;
}

function imageDataUrl(image: AgentMessageImageVM): string | null {
  const data = image.data?.trim() ?? "";
  const mimeType = image.mimeType.trim();
  if (!data || !mimeType) {
    return null;
  }
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

function AgentSystemNoticeMessage({
  message
}: {
  message: AgentMessageContentVM;
}): JSX.Element {
  "use memo";
  const notice = message.systemNotice;
  const detail = notice?.detail?.trim() ?? "";
  const isWarning =
    notice?.severity === "warning" || notice?.severity === "error";
  const Icon = isWarning ? AlertTriangle : Info;
  return (
    <section
      role={isWarning ? "status" : undefined}
      className="box-border w-full min-w-0 rounded-[8px] border border-[color-mix(in_srgb,var(--state-warning)_14%,transparent)] bg-[color-mix(in_srgb,var(--background-fronted)_100%,var(--state-warning)_6%)] p-3 text-[13px] leading-5 text-[var(--text-primary)]"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon
          size={15}
          strokeWidth={2.1}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-[var(--state-warning)]"
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--text-primary)]">
            {systemNoticeTitle(message)}
          </div>
          {detail ? (
            <AgentMessageDetailsDisclosure detail={detail} className="mt-1" />
          ) : null}
        </div>
      </div>
    </section>
  );
}

// Codex plan-mode proposals render as a framed card (mirrors the codex TUI
// treating the plan item as a distinct artifact rather than chat text).
function AgentPlanCardMessage({
  message,
  workspaceRoot,
  basePath,
  onLinkAction,
  workspaceAppIcons
}: {
  message: AgentMessageContentVM;
  workspaceRoot: string | null;
  basePath: string;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}): JSX.Element {
  "use memo";
  return (
    <section
      data-testid="agent-plan-card"
      className="box-border w-full min-w-0 rounded-[8px] border border-[var(--tutti-purple-border)] bg-[var(--tutti-purple-bg)] p-3"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
        <ListChecks
          size={14}
          strokeWidth={2}
          aria-hidden="true"
          className="shrink-0"
        />
        <span data-testid="agent-plan-card-title">
          {translate("agentHost.agentGui.planCardTitle")}
        </span>
      </div>
      <AgentMessageMarkdown
        content={message.body}
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
      />
    </section>
  );
}

function systemNoticeTitle(message: AgentMessageContentVM): string {
  const notice = message.systemNotice;
  switch (notice?.noticeKind) {
    case "transport_retry":
      return translate("agentHost.agentGui.systemNoticeTransportRetry");
    case "transport_fallback":
      return translate("agentHost.agentGui.systemNoticeTransportFallback");
    case "warning":
      return (
        notice.title || translate("agentHost.agentGui.systemNoticeWarning")
      );
    default:
      return (
        notice?.title ||
        message.body ||
        translate("agentHost.agentGui.systemNoticeDefault")
      );
  }
}

function AgentVisibleErrorMessage({
  message,
  onAuthLogin
}: {
  message: AgentMessageContentVM;
  onAuthLogin?: (provider?: string | null) => void;
}): JSX.Element {
  "use memo";
  const error = message.visibleError;
  const title = visibleErrorTitle(message);
  const hint = visibleErrorHint(message);
  const detail = error?.detail?.trim() ?? "";
  const showAuthLogin = error?.code === "auth_required" && onAuthLogin;
  return (
    <section
      role="alert"
      className="box-border w-full min-w-0 rounded-[8px] border border-[var(--on-danger-hover)] bg-[var(--on-danger)] p-3 text-[13px] leading-5 text-[var(--state-danger)]"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--text-primary)]">{title}</div>
          {hint ? (
            <div className="mt-1 text-[12px] text-[var(--text-secondary)]">
              {hint}
            </div>
          ) : null}
          {detail ? (
            <AgentMessageDetailsDisclosure detail={detail} className="mt-1" />
          ) : null}
        </div>
        {showAuthLogin ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-0.5 shrink-0"
            onClick={() => onAuthLogin(error?.provider ?? null)}
          >
            {translate("agentHost.agentGui.authLogin")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function AgentMessageDetailsDisclosure({
  detail,
  className = ""
}: {
  detail: string;
  className?: string;
}): JSX.Element {
  "use memo";
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`${className} text-[12px] text-[var(--state-danger)]`}>
      <button
        type="button"
        className="inline-flex w-fit max-w-full min-w-0 cursor-pointer select-none items-center gap-1.5 border-0 bg-transparent p-0 text-left font-[inherit] text-[inherit] transition-colors duration-150 hover:text-[var(--state-danger-hover)]"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {translate("agentHost.agentGui.visibleErrorDetails")}
        <ChevronRight
          size={12}
          strokeWidth={2.2}
          aria-hidden="true"
          className="shrink-0 text-[var(--state-danger)]"
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transformOrigin: "center",
            transition: "transform 200ms cubic-bezier(0.22, 1.18, 0.36, 1)",
            willChange: "transform"
          }}
        />
      </button>
      <CollapsibleReveal expanded={expanded} preMountOnIdle>
        <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-[var(--on-danger)] px-3 py-2 font-[var(--tsh-font-mono)] text-[11px] leading-5 text-[var(--state-danger)]">
          {detail}
        </pre>
      </CollapsibleReveal>
    </div>
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
      return (
        message.body ||
        translate("agentHost.agentGui.visibleErrorRequestFailed", { provider })
      );
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
