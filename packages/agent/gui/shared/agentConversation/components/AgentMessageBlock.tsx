import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type JSX,
  type ReactNode
} from "react";
import { Avatar } from "@tutti-os/ui-system";
import { CheckIcon, CopyIcon } from "@tutti-os/ui-system/icons";
import { formatAgentMessageTimestamp } from "../../../app/renderer/shell/utils/format";
import { AgentPlanCard } from "./AgentPlanCard";
import { AgentCollaborationRow } from "./AgentCollaborationRow";
import { translate } from "../../../i18n/index";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import {
  AgentMessageMarkdown,
  type AgentMessageMarkdownWorkspaceAppIcon
} from "../../AgentMessageMarkdown";
import { AgentRichTextReadonly } from "../../AgentRichTextReadonly";
import { resolveAgentConversationLinkAction } from "../actions/agentConversationLinkActions";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import type {
  AgentMessageContentVM,
  AgentMessageRowVM
} from "../contracts/agentMessageRowVM";
import type {
  AgentConversationParticipantIdentity,
  AgentConversationParticipantPresentation
} from "../contracts/agentConversationParticipantPresentation";
import { AgentMessageDetailsDisclosure } from "./AgentMessageDetailsDisclosure";
import {
  AgentVisibleErrorMessage,
  recoverVisibleErrorFromMessage
} from "./AgentVisibleErrorMessage";
import { AgentThinkingDisclosure } from "./AgentThinkingDisclosure";
import { RawTimelineJsonDisclosure } from "./RawTimelineJsonDisclosure";
import { useElapsedSeconds } from "./useElapsedSeconds";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";
import { CanvasNodeGhostIconButton } from "../../../contexts/workspace/presentation/renderer/components/shared/CanvasNodeGhostIconButton";
import { AgentUserImageGrid } from "./AgentMessageImages";

const MESSAGE_COPY_FEEDBACK_MS = 1400;
const TRANSPORT_RETRY_PROGRESS_PATTERN =
  /\b(reconnect(?:ing)?(?:\s*(?:\.\.\.|…|[.。]+|:|-))?\s*\(?\d+\s*\/\s*\d+\)?)/i;
// All system-notice banners use the light-red danger surface. Yellow/warning
// surfaces are banned for notice boxes — see "Badges And Status" in
// docs/conventions/desktop-visual-language.md.
const SYSTEM_NOTICE_CLASS_NAME =
  "border-[var(--on-danger-hover)] bg-[var(--on-danger)]";

interface AgentMessageBlockProps {
  workspaceRoot: string | null;
  basePath: string;
  row: AgentMessageRowVM;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  thinkingLabel: string;
  onAuthLogin?: (provider?: string | null) => void;
  // The conversation's provider, so a failed message recovered as an env error
  // routes its wizard CTA to the right provider.
  provider?: string | null;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  previewMode?: boolean;
  showRawTimelineJson?: boolean;
  rawTimelineJsonLabel?: string;
  participantPresentation?: AgentConversationParticipantPresentation;
}

export function AgentMessageBlock({
  workspaceRoot,
  basePath,
  row,
  onLinkAction,
  thinkingLabel,
  onAuthLogin,
  provider,
  availableSkills,
  workspaceAppIcons,
  previewMode = false,
  showRawTimelineJson = false,
  rawTimelineJsonLabel = "",
  participantPresentation
}: AgentMessageBlockProps): JSX.Element {
  "use memo";
  const agentHostApi = useOptionalAgentHostApi();
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
  const handleCopyMessageText = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text.trim()) {
        return false;
      }

      try {
        const hostWriteText = agentHostApi?.clipboard?.writeText;
        if (typeof hostWriteText === "function") {
          await hostWriteText(text);
          return true;
        }
        if (
          typeof navigator !== "undefined" &&
          typeof navigator.clipboard?.writeText === "function"
        ) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        return false;
      }
      return false;
    },
    [agentHostApi]
  );
  const thinkingContent = !isUser
    ? row.thinking.map((thinking) => (
        <AgentThinkingDisclosure
          key={thinking.id}
          thinking={thinking}
          label={thinkingLabel}
          onLinkClick={handleLinkClick}
          previewMode={previewMode}
          showRawTimelineJson={showRawTimelineJson}
          rawTimelineJsonLabel={rawTimelineJsonLabel}
        />
      ))
    : null;

  const messageContent = row.messages.map((message) => {
    const rawTimelineJson =
      showRawTimelineJson &&
      rawTimelineJsonLabel &&
      (message.sourceTimelineItems?.length ?? 0) > 0 ? (
        <RawTimelineJsonDisclosure
          items={message.sourceTimelineItems}
          label={rawTimelineJsonLabel}
        />
      ) : null;
    // Recover a structured error card from a terminal message that the
    // provider reported as plain text, including Claude SDK's completed
    // standalone login notice.
    const recoveredError =
      !isUser && !message.visibleError
        ? recoverVisibleErrorFromMessage(message, provider)
        : null;
    const content =
      isUser && message.contentKind === "image-grid" ? (
        <AgentUserImageGrid message={message} />
      ) : isUser ? (
        <AgentRichTextReadonly
          value={message.body}
          documentCacheKey={message.id}
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
          onExternalLink={handleLinkClick}
        />
      ) : recoveredError ? (
        <AgentVisibleErrorMessage
          message={recoveredError}
          onAuthLogin={onAuthLogin}
          onExternalLink={handleLinkClick}
        />
      ) : message.systemNotice ? (
        <AgentSystemNoticeMessage message={message} />
      ) : message.contentKind === "collaboration" && message.collaboration ? (
        <AgentCollaborationRow
          collaboration={message.collaboration}
          workspaceRoot={workspaceRoot}
          basePath={basePath}
          onLinkAction={onLinkAction}
          workspaceAppIcons={workspaceAppIcons}
          previewMode={previewMode}
        />
      ) : message.contentKind === "plan" ? (
        <AgentPlanCardMessage
          message={message}
          workspaceRoot={workspaceRoot}
          basePath={basePath}
          onLinkAction={onLinkAction}
          workspaceAppIcons={workspaceAppIcons}
          previewMode={previewMode}
        />
      ) : (
        <AgentMessageMarkdown
          content={message.body}
          documentCacheKey={message.id}
          className={styles.assistantMarkdown}
          onLinkAction={onLinkAction}
          workspaceLinkContext={{
            workspaceRoot,
            basePath,
            source: "agent-markdown"
          }}
          workspaceAppIcons={workspaceAppIcons}
          enableImageZoom
          previewMode={previewMode}
          streaming={message.statusKind === "working"}
        />
      );

    if (rawTimelineJson) {
      return (
        <AgentCopyableMessageGroup
          key={message.id}
          copyText={message.copyText ?? null}
          occurredAtUnixMs={message.occurredAtUnixMs}
          speaker={row.speaker}
          onCopyMessageText={handleCopyMessageText}
        >
          {content}
          {rawTimelineJson}
        </AgentCopyableMessageGroup>
      );
    }

    const copyText = message.copyText ?? null;
    if (copyText) {
      return (
        <AgentCopyableMessageGroup
          key={message.id}
          copyText={copyText}
          occurredAtUnixMs={message.occurredAtUnixMs}
          speaker={row.speaker}
          onCopyMessageText={handleCopyMessageText}
        >
          {content}
        </AgentCopyableMessageGroup>
      );
    }

    return <Fragment key={message.id}>{content}</Fragment>;
  });
  const enabledParticipantPresentation =
    participantPresentation?.enabled === true ? participantPresentation : null;
  const showParticipant =
    enabledParticipantPresentation !== null && row.messages.length > 0;

  return (
    <div
      className={isUser ? styles.userMessageFlow : styles.assistantMessageFlow}
      data-agent-message-flow-thinking-first={
        !isUser && row.thinking.length > 0 ? "true" : undefined
      }
      data-agent-message-flow-thinking-last={
        !isUser && row.thinking.length > 0 && row.messages.length === 0
          ? "true"
          : undefined
      }
    >
      {thinkingContent}
      {showParticipant ? (
        <div
          className={styles.participantMessageLayout}
          data-agent-message-speaker={row.speaker}
        >
          {!isUser ? (
            <AgentConversationParticipantAvatar
              presentation={enabledParticipantPresentation}
              speaker="assistant"
            />
          ) : null}
          <div className={styles.participantMessageContent}>
            {messageContent}
          </div>
          {isUser ? (
            <AgentConversationParticipantAvatar
              presentation={enabledParticipantPresentation}
              speaker="user"
            />
          ) : null}
        </div>
      ) : (
        messageContent
      )}
    </div>
  );
}

function AgentConversationParticipantAvatar({
  presentation,
  speaker
}: {
  presentation: Extract<
    AgentConversationParticipantPresentation,
    { enabled: true }
  >;
  speaker: AgentMessageRowVM["speaker"];
}): JSX.Element {
  if (presentation.status === "loading") {
    return (
      <Avatar
        aria-hidden="true"
        className={styles.participantAvatar}
        data-agent-conversation-participant-avatar={speaker}
        label=""
        loading
        size="md"
      />
    );
  }

  const participant: AgentConversationParticipantIdentity =
    speaker === "user" ? presentation.user : presentation.agent;
  return (
    <Avatar
      aria-label={participant.name}
      className={styles.participantAvatar}
      data-agent-conversation-participant-avatar={speaker}
      label={participant.name}
      size="md"
      src={participant.avatarUrl}
    />
  );
}

function AgentCopyableMessageGroup({
  children,
  copyText,
  occurredAtUnixMs,
  onCopyMessageText,
  speaker
}: {
  children: ReactNode;
  copyText: string | null;
  occurredAtUnixMs: number | null;
  onCopyMessageText: (text: string) => Promise<boolean>;
  speaker: AgentMessageRowVM["speaker"];
}): JSX.Element {
  "use memo";
  const timestamp = formatAgentMessageTimestamp(occurredAtUnixMs);
  const hasFooter = Boolean(timestamp || copyText);

  return (
    <div
      className={styles.messageGroup}
      data-agent-message-footer={hasFooter ? "true" : undefined}
      data-agent-message-speaker={speaker}
    >
      {children}
      {hasFooter ? (
        <div className={styles.messageFooter}>
          {timestamp ? (
            <span className={styles.messageTimestamp}>{timestamp}</span>
          ) : null}
          {copyText ? (
            <AgentMessageCopyButton
              copyText={copyText}
              onCopyMessageText={onCopyMessageText}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AgentMessageCopyButton({
  copyText,
  onCopyMessageText
}: {
  copyText: string;
  onCopyMessageText: (text: string) => Promise<boolean>;
}): JSX.Element {
  "use memo";
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const reset = window.setTimeout(() => {
      setCopied(false);
    }, MESSAGE_COPY_FEEDBACK_MS);
    return () => window.clearTimeout(reset);
  }, [copied]);
  const handleClick = useCallback(async () => {
    if (await onCopyMessageText(copyText)) {
      setCopied(true);
    }
  }, [copyText, onCopyMessageText]);
  const label = copied
    ? translate("agentHost.agentGui.messageCopied")
    : translate("agentHost.agentGui.copyMessage");

  return (
    <CanvasNodeGhostIconButton
      className={styles.messageCopyButton}
      aria-label={label}
      data-copied={copied ? "true" : "false"}
      onClick={handleClick}
    >
      {copied ? (
        <CheckIcon width={14} height={14} aria-hidden="true" />
      ) : (
        <CopyIcon width={14} height={14} aria-hidden="true" />
      )}
    </CanvasNodeGhostIconButton>
  );
}

function AgentSystemNoticeMessage({
  message
}: {
  message: AgentMessageContentVM;
}): JSX.Element {
  "use memo";
  const notice = message.systemNotice;
  const detail = notice?.detail?.trim() ?? "";
  const title = systemNoticeTitle(message);
  if (notice?.noticeKind === "transport_retry") {
    const retryText = transportRetryNoticeText(message);
    return (
      <div
        role="status"
        className="box-border w-full min-w-0 py-1 text-[13px] leading-5 text-[var(--text-primary)]"
      >
        {retryText}
      </div>
    );
  }
  if (isContextCompactionProgressNotice(message)) {
    return (
      <ContextCompactionProgressDivider
        startedAtUnixMs={message.occurredAtUnixMs}
      />
    );
  }
  if (isContextCompactionNotice(message)) {
    return (
      <ContextCompactionDivider
        text={translate("agentHost.agentGui.contextCompactionCompleted")}
      />
    );
  }
  if (isContextCompactionInterruptedNotice(message)) {
    return (
      <ContextCompactionDivider
        text={translate("agentHost.agentGui.contextCompactionInterrupted")}
        detail={detail || null}
      />
    );
  }
  const isStatusNotice = systemNoticeIsStatus(message);
  return (
    <section
      role={isStatusNotice ? "status" : undefined}
      className={`box-border w-full min-w-0 rounded-[8px] border p-3 text-[13px] leading-5 text-[var(--text-primary)] ${SYSTEM_NOTICE_CLASS_NAME}`}
    >
      <div className="min-w-0">
        <div className="font-medium text-[var(--text-primary)]">{title}</div>
        {detail ? (
          <AgentMessageDetailsDisclosure detail={detail} className="mt-1" />
        ) : null}
      </div>
    </section>
  );
}

function systemNoticeIsStatus(message: AgentMessageContentVM): boolean {
  const notice = message.systemNotice;
  return (
    notice?.severity === "warning" ||
    notice?.severity === "error" ||
    notice?.noticeKind === "transport_fallback" ||
    isTransportFallbackNotice(message)
  );
}

function isTransportFallbackNotice(message: AgentMessageContentVM): boolean {
  const notice = message.systemNotice;
  const text = [notice?.title, notice?.detail, message.body]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return (
    text.includes("falling back from websockets") ||
    text.includes("https transport")
  );
}

function transportRetryNoticeText(message: AgentMessageContentVM): string {
  const notice = message.systemNotice;
  const detail = notice?.detail?.trim() ?? "";
  const progressText =
    transportRetryProgressText(detail) ??
    transportRetryProgressText(notice?.title ?? "") ??
    transportRetryProgressText(message.body);
  if (progressText) {
    return progressText;
  }
  return (
    notice?.title?.trim() ||
    message.body.trim() ||
    translate("agentHost.agentGui.systemNoticeTransportRetry")
  );
}

function transportRetryProgressText(value: string): string | null {
  const match = TRANSPORT_RETRY_PROGRESS_PATTERN.exec(value.trim());
  return match?.[1]?.replace(/\s+/g, " ").trim() || null;
}

function isContextCompactionNotice(message: AgentMessageContentVM): boolean {
  const notice = message.systemNotice;
  return notice?.command === "compact" && notice.commandStatus === "completed";
}

function isContextCompactionProgressNotice(
  message: AgentMessageContentVM
): boolean {
  const notice = message.systemNotice;
  return notice?.command === "compact" && notice.commandStatus === "running";
}

function isContextCompactionInterruptedNotice(
  message: AgentMessageContentVM
): boolean {
  const notice = message.systemNotice;
  return (
    notice?.command === "compact" &&
    (notice.commandStatus === "failed" || notice.commandStatus === "canceled")
  );
}

function ContextCompactionDivider({
  text,
  detail = null
}: {
  text: string;
  detail?: string | null;
}): JSX.Element {
  "use memo";
  return (
    <div
      role="status"
      className="box-border w-full min-w-0 py-2 text-[12px] leading-4 text-[var(--text-secondary)]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="h-px min-w-4 flex-1 bg-[var(--line-1)]"
        />
        <span className="shrink-0 whitespace-nowrap">{text}</span>
        <span
          aria-hidden="true"
          className="h-px min-w-4 flex-1 bg-[var(--line-1)]"
        />
      </div>
      {detail ? (
        <div className="mt-1 min-w-0 whitespace-pre-wrap break-words text-center leading-5">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

// Live compaction banner: the daemon replaces this notice in place with the
// "Context compacted." notice once the provider finishes, so the timer only
// runs while compaction is actually in flight.
function ContextCompactionProgressDivider({
  startedAtUnixMs
}: {
  startedAtUnixMs: number | null;
}): JSX.Element {
  "use memo";
  const elapsedSeconds = useElapsedSeconds(startedAtUnixMs);
  const label = translate("agentHost.agentGui.contextCompactionInProgress");
  const text =
    elapsedSeconds === null
      ? label
      : `${label} · ${formatElapsedSeconds(elapsedSeconds)}`;
  return <ContextCompactionDivider text={text} />;
}

function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Codex plan-mode proposals render as a framed card (mirrors the codex TUI
// treating the plan item as a distinct artifact rather than chat text).
function AgentPlanCardMessage({
  message,
  workspaceRoot,
  basePath,
  onLinkAction,
  workspaceAppIcons,
  previewMode = false
}: {
  message: AgentMessageContentVM;
  workspaceRoot: string | null;
  basePath: string;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  previewMode?: boolean;
}): JSX.Element {
  "use memo";
  return (
    <AgentPlanCard copyText={message.body}>
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
        enableImageZoom
        previewMode={previewMode}
      />
    </AgentPlanCard>
  );
}

function systemNoticeTitle(message: AgentMessageContentVM): string {
  const notice = message.systemNotice;
  switch (notice?.noticeKind) {
    case "transport_retry":
      return translate("agentHost.agentGui.systemNoticeTransportRetry");
    case "transport_fallback":
      return translate("agentHost.agentGui.systemNoticeTransportFallback");
    case "plan_implementation_pending_confirmation":
      return translate(
        "agentHost.agentGui.systemNoticePlanImplementationPendingConfirmation"
      );
    case "plan_implementation_completed":
      return translate(
        "agentHost.agentGui.systemNoticePlanImplementationCompleted"
      );
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
