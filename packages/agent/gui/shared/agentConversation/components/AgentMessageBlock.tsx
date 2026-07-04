import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode
} from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { CheckIcon, CopyIcon } from "@tutti-os/ui-system/icons";
import { Button } from "../../../app/renderer/components/ui/button";
import { formatAgentMessageTimestamp } from "../../../app/renderer/shell/utils/format";
import { AgentPlanCard } from "./AgentPlanCard";
import { translate } from "../../../i18n/index";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
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
import { openAgentEnvPanel } from "../../agentEnv/agentEnvPanelStore";
import {
  classifyFailedAgentMessage,
  resolveAgentErrorPresentation
} from "../../agentEnv/agentErrorPresentation";
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
import { CanvasNodeGhostIconButton } from "../../../contexts/workspace/presentation/renderer/components/shared/CanvasNodeGhostIconButton";

const MESSAGE_COPY_FEEDBACK_MS = 1400;
const CONTEXT_COMPACTION_NOTICE_TITLE = "Context compacted.";
const CONTEXT_COMPACTION_IN_PROGRESS_TITLE = "Compacting context.";
const CONTEXT_COMPACTION_INTERRUPTED_TITLE = "Context compaction interrupted.";
const TRANSPORT_RETRY_PROGRESS_PATTERN =
  /\b(reconnect(?:ing)?(?:\s*(?:\.\.\.|…|[.。]+|:|-))?\s*\(?\d+\s*\/\s*\d+\)?)/i;
const SYSTEM_NOTICE_WARNING_CLASS_NAME =
  "border-[color-mix(in_srgb,var(--state-warning)_14%,transparent)] bg-[color-mix(in_srgb,var(--background-fronted)_100%,var(--state-warning)_6%)]";
const SYSTEM_NOTICE_ERROR_CLASS_NAME =
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
  rawTimelineJsonLabel = ""
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
        // Recover a structured error card from a failed message that the provider
        // reported as plain text (e.g. a dropped-login 401), so it still gets the
        // wizard call-to-action instead of a dead red message.
        const recoveredError =
          !isUser && !message.visibleError && message.statusKind === "failed"
            ? recoverVisibleErrorFromFailedMessage(message, provider)
            : null;
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
          ) : recoveredError ? (
            <AgentVisibleErrorMessage
              message={recoveredError}
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
              previewMode={previewMode}
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
      })}
    </div>
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

  return (
    <div className={styles.messageGroup} data-agent-message-speaker={speaker}>
      {children}
      {timestamp || copyText ? (
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

function AgentUserImageGrid({
  message
}: {
  message: AgentMessageContentVM;
}): JSX.Element {
  "use memo";
  const images = message.images ?? [];
  const { loadingIds, sources: loadedImages } =
    useAgentMessageImageSources(images);
  const columnCount = Math.min(Math.max(images.length, 1), 4);
  const thumbnailWidth = images.length === 1 ? "160px" : "80px";
  return (
    <div
      className={styles.userImageGrid}
      style={{
        gridTemplateColumns: `repeat(${columnCount}, ${thumbnailWidth})`
      }}
    >
      {images.map((image) => {
        const src = loadedImages.get(image.id) ?? imageDataUrl(image);
        const loading = !src && loadingIds.has(image.id);
        return (
          <div key={image.id} className={styles.userImageThumbnail}>
            {src ? (
              <ZoomableImage
                src={src}
                alt={image.name?.trim() || "image"}
                className="block max-h-20 w-full rounded-[7px] object-contain"
                draggable={false}
                downloadName={image.name?.trim() || "image.png"}
              />
            ) : loading ? (
              <div
                className="flex h-20 w-full items-center justify-center bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
                data-testid="agent-gui-message-image-loading"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-5 animate-spin text-[color-mix(in_srgb,var(--text-primary)_45%,transparent)]"
                  strokeWidth={2}
                />
              </div>
            ) : (
              <div className="h-20 w-full animate-pulse bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function useAgentMessageImageSources(images: readonly AgentMessageImageVM[]): {
  loadingIds: ReadonlySet<string>;
  sources: ReadonlyMap<string, string>;
} {
  const runtime = getOptionalAgentActivityRuntime();
  const [sources, setSources] = useState<Map<string, string>>(() => new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  const missingImages = useMemo(
    () =>
      images.filter(
        (image) =>
          !imageDataUrl(image) &&
          !sources.has(image.id) &&
          image.workspaceId &&
          image.agentSessionId &&
          (image.attachmentId || image.path)
      ),
    [images, sources]
  );

  useEffect(() => {
    if (
      (!runtime?.readSessionAttachment && !runtime?.readPromptAsset) ||
      missingImages.length === 0
    ) {
      return;
    }
    let canceled = false;
    for (const image of missingImages) {
      const readImage = image.attachmentId
        ? runtime.readSessionAttachment?.({
            workspaceId: image.workspaceId ?? "",
            agentSessionId: image.agentSessionId,
            attachmentId: image.attachmentId ?? ""
          })
        : runtime.readPromptAsset?.({
            workspaceId: image.workspaceId ?? "",
            agentSessionId: image.agentSessionId,
            mimeType: image.mimeType,
            name: image.name,
            path: image.path
          });
      if (!readImage) {
        continue;
      }
      setLoadingIds((current) => {
        if (current.has(image.id)) {
          return current;
        }
        const next = new Set(current);
        next.add(image.id);
        return next;
      });
      void readImage
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
        .catch(() => {})
        .finally(() => {
          if (canceled) {
            return;
          }
          setLoadingIds((current) => {
            if (!current.has(image.id)) {
              return current;
            }
            const next = new Set(current);
            next.delete(image.id);
            return next;
          });
        });
    }
    return () => {
      canceled = true;
    };
  }, [missingImages, runtime]);

  return { loadingIds, sources };
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
  if (isContextCompactionProgressNotice(message, title)) {
    return (
      <ContextCompactionProgressDivider
        startedAtUnixMs={message.occurredAtUnixMs}
      />
    );
  }
  if (isContextCompactionNotice(message, title)) {
    return (
      <ContextCompactionDivider
        text={translate("agentHost.agentGui.contextCompactionCompleted")}
      />
    );
  }
  if (isContextCompactionInterruptedNotice(message, title)) {
    return (
      <ContextCompactionDivider
        text={translate("agentHost.agentGui.contextCompactionInterrupted")}
      />
    );
  }
  const isStatusNotice = systemNoticeIsStatus(message);
  const noticeToneClassName = systemNoticeToneClassName(message);
  return (
    <section
      role={isStatusNotice ? "status" : undefined}
      className={`box-border w-full min-w-0 rounded-[8px] border p-3 text-[13px] leading-5 text-[var(--text-primary)] ${noticeToneClassName}`}
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

function systemNoticeToneClassName(message: AgentMessageContentVM): string {
  const notice = message.systemNotice;
  if (
    notice?.severity === "error" ||
    notice?.noticeKind === "transport_fallback" ||
    isTransportFallbackNotice(message)
  ) {
    return SYSTEM_NOTICE_ERROR_CLASS_NAME;
  }
  if (notice?.severity === "warning") {
    return SYSTEM_NOTICE_WARNING_CLASS_NAME;
  }
  return SYSTEM_NOTICE_WARNING_CLASS_NAME;
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

function isContextCompactionNotice(
  message: AgentMessageContentVM,
  title: string
): boolean {
  const notice = message.systemNotice;
  return (
    notice?.noticeKind === "system_notice" &&
    (notice.detail?.trim() ?? "") === "" &&
    title.trim() === CONTEXT_COMPACTION_NOTICE_TITLE
  );
}

function isContextCompactionProgressNotice(
  message: AgentMessageContentVM,
  title: string
): boolean {
  const notice = message.systemNotice;
  return (
    notice?.noticeKind === "system_notice" &&
    (notice.detail?.trim() ?? "") === "" &&
    title.trim() === CONTEXT_COMPACTION_IN_PROGRESS_TITLE
  );
}

function isContextCompactionInterruptedNotice(
  message: AgentMessageContentVM,
  title: string
): boolean {
  const notice = message.systemNotice;
  return (
    notice?.noticeKind === "system_notice" &&
    (notice.detail?.trim() ?? "") === "" &&
    title.trim() === CONTEXT_COMPACTION_INTERRUPTED_TITLE
  );
}

function ContextCompactionDivider({ text }: { text: string }): JSX.Element {
  "use memo";
  return (
    <div
      role="status"
      className="box-border flex w-full min-w-0 items-center gap-3 py-2 text-[12px] leading-4 text-[var(--text-secondary)]"
    >
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

function useElapsedSeconds(startUnixMs: number | null): number | null {
  const [nowUnixMs, setNowUnixMs] = useState(() => Date.now());
  useEffect(() => {
    if (startUnixMs === null) {
      return;
    }
    const timer = setInterval(() => setNowUnixMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startUnixMs]);
  if (startUnixMs === null) {
    return null;
  }
  return Math.max(0, Math.floor((nowUnixMs - startUnixMs) / 1000));
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
        deferLongContentRender
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

// Builds a synthetic visibleError from a plain failed message whose text is a
// recognizable env failure, so it renders as the structured remediation card.
function recoverVisibleErrorFromFailedMessage(
  message: AgentMessageContentVM,
  provider: string | null | undefined
): AgentMessageContentVM | null {
  const code = classifyFailedAgentMessage(message.body);
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

function AgentVisibleErrorMessage({
  message
}: {
  message: AgentMessageContentVM;
  onAuthLogin?: (provider?: string | null) => void;
}): JSX.Element {
  "use memo";
  const error = message.visibleError;
  const detail = error?.detail?.trim() ?? "";

  // One card for every run-failure code. The presentation (keyed on the codes
  // the daemon actually emits — see agentErrorPresentation) supplies a granular,
  // provider-aware message and, when the failure is something the env wizard can
  // detect or repair, a single deep-linking call-to-action. Transient/server-side
  // failures resolve to no focus, so no (misleading) wizard button is shown.
  const providerLabel = workspaceAgentProviderLabel(
    error?.provider ?? "unknown"
  );
  const presentation = resolveAgentErrorPresentation(error?.code);
  const headline = presentation?.messageKey
    ? translate(presentation.messageKey, { provider: providerLabel })
    : visibleErrorTitle(message);
  const focus = presentation?.focus ?? null;
  const actionKey = presentation?.actionKey ?? null;
  const hint = visibleErrorHint(message);
  return (
    <section
      role="alert"
      className="box-border w-full min-w-0 rounded-[8px] border border-[var(--on-danger-hover)] bg-[var(--on-danger)] p-3 text-[13px] leading-5 text-[var(--state-danger)]"
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
          {detail ? (
            <AgentMessageDetailsDisclosure
              detail={detail}
              className="mt-1"
              label={translate("agentHost.agentGui.visibleErrorRawDetails")}
            />
          ) : null}
        </div>
        {focus && actionKey ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-0.5 shrink-0"
            onClick={() =>
              openAgentEnvPanel({
                provider: error?.provider ?? "codex",
                focus
              })
            }
          >
            {translate(actionKey)}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function AgentMessageDetailsDisclosure({
  detail,
  className = "",
  label
}: {
  detail: string;
  className?: string;
  label?: string;
}): JSX.Element {
  "use memo";
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`${className} text-[11px] text-[var(--state-danger)]`}>
      <button
        type="button"
        className="inline-flex w-fit max-w-full min-w-0 cursor-pointer select-none items-center gap-1.5 border-0 bg-transparent p-0 text-left font-[inherit] text-[inherit] transition-colors duration-150 hover:text-[var(--state-danger-hover)]"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {label ?? translate("agentHost.agentGui.visibleErrorDetails")}
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
