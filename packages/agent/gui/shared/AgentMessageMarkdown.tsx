import {
  type CSSProperties,
  type AnchorHTMLAttributes,
  type ComponentPropsWithoutRef,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  createContext,
  startTransition,
  useCallback,
  useEffect,
  useContext,
  memo,
  useMemo,
  useState
} from "react";
import { useTranslation } from "../i18n/index";
import { ZoomableImage } from "../app/renderer/components/ZoomableImage";
import { cn } from "../app/renderer/lib/utils";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeSanitize, {
  defaultSchema,
  type Options as RehypeSanitizeOptions
} from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  resolveWorkspaceFileExtension,
  resolveWorkspaceImageMimeType,
  workspaceFileName as basenameWorkspacePath
} from "@tutti-os/workspace-file-manager/services";
import {
  getOptionalAgentHostApi,
  useOptionalAgentHostApi
} from "../agentActivityHost";
import {
  resolveWorkspaceLinkAction,
  type WorkspaceLinkAction,
  type WorkspaceLinkActionSource
} from "../actions/workspaceLinkActions";
import { resolveAgentWorkspaceFileVisualKind } from "./workspaceFileVisualKind";
import { stabilizeStreamingMarkdownTail } from "./streamingMarkdownTailStabilizer";
import { useStreamingVisibleText } from "./useStreamingVisibleText";

const COLLAPSED_LINE_LIMIT = 8;
const APPROX_CHARS_PER_LINE = 34;
const DEFERRED_LONG_MARKDOWN_CHAR_THRESHOLD = 4096;
const STREAMING_MARKDOWN_EMERGENCY_PLAIN_CHAR_THRESHOLD = 96_000;
const DEFERRED_LONG_MARKDOWN_FALLBACK_DELAY_MS = 80;
const DEFERRED_LONG_MARKDOWN_IDLE_TIMEOUT_MS = 700;
const STREAMING_MARKDOWN_FRAME_MS = 24;
const STREAMING_MARKDOWN_MAX_CHARS_PER_SECOND = 6_000;
const STREAMING_MARKDOWN_TAIL_FLUSH_CHARS = 0;
const PLAIN_SESSION_MENTION_AGENT_LABELS = [
  "Claude Code",
  "Nexight",
  "Codex"
] as const;
export const AGENT_MARKDOWN_PLAIN_TITLE_CLASSNAME =
  "[font-size:inherit] [line-height:inherit] text-inherit [&_a]:text-inherit [&_a]:font-inherit [&_a]:no-underline [&_a:hover]:no-underline [&_a:focus-visible]:no-underline [&_strong]:font-inherit [&_strong]:text-inherit";

const MARKDOWN_SANITIZE_SCHEMA: RehypeSanitizeOptions = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "mention"]
  }
};

export interface AgentMessageMarkdownWorkspaceLinkContext {
  workspaceRoot?: string | null;
  basePath?: string | null;
  source: WorkspaceLinkActionSource;
}

interface AgentMessageMarkdownProps {
  content: string;
  onLinkClick?: (href: string) => void;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  workspaceLinkContext?: AgentMessageMarkdownWorkspaceLinkContext | null;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  collapsible?: boolean;
  expandLabel?: string;
  className?: string;
  inline?: boolean;
  normalizePlainIssueMentionTitle?: boolean;
  deferLongContentRender?: boolean;
  enableImageZoom?: boolean;
  streaming?: boolean;
}

export interface AgentMessageMarkdownWorkspaceAppIcon {
  appId: string;
  iconUrl: string | null;
  workspaceId?: string | null;
}

const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];

type MarkdownDomProps<Tag extends keyof JSX.IntrinsicElements> =
  ComponentPropsWithoutRef<Tag> & {
    node?: unknown;
  };

const MarkdownLinkContext = createContext(false);

type ReactMarkdownComponents = ComponentPropsWithoutRef<
  typeof ReactMarkdown
>["components"];

export function AgentMessageMarkdown({
  content,
  onLinkClick,
  onLinkAction,
  workspaceLinkContext = null,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
  collapsible = false,
  expandLabel,
  className,
  inline = false,
  normalizePlainIssueMentionTitle = false,
  deferLongContentRender = false,
  enableImageZoom = false,
  streaming = false
}: AgentMessageMarkdownProps): JSX.Element {
  "use memo";
  const { t } = useTranslation();
  const visibleContent = useStreamingVisibleText(content, {
    enabled: streaming,
    frameMs: STREAMING_MARKDOWN_FRAME_MS,
    maxCharsPerSecond: STREAMING_MARKDOWN_MAX_CHARS_PER_SECOND,
    trailingFlushChars: STREAMING_MARKDOWN_TAIL_FLUSH_CHARS
  });
  const stabilizedContent = useMemo(
    () =>
      stabilizeStreamingMarkdownTail(visibleContent, {
        streaming
      }).content,
    [streaming, visibleContent]
  );
  const workspaceRoot = workspaceLinkContext?.workspaceRoot ?? null;
  const basePath = workspaceLinkContext?.basePath ?? null;
  const workspaceLinkSource = workspaceLinkContext?.source ?? null;
  const [isExpanded, setIsExpanded] = useState(false);
  const resolvedExpandLabel =
    expandLabel ?? t("agentHost.workspaceAgentMessageExpand");
  const shouldCollapse =
    collapsible && isLikelyLongerThanLineLimit(stabilizedContent);
  const isCollapsed = shouldCollapse && !isExpanded;
  const ContainerTag = inline ? "span" : "div";
  const contentSignature = useMemo(
    () => hashMarkdownProfilerContent(stabilizedContent),
    [stabilizedContent]
  );
  const normalizedContent = useMemo(
    () =>
      linkBareLocalAbsolutePaths(
        normalizeMentionMarkdownLinks(
          normalizePlainIssueMentionTitle
            ? normalizePlainIssueMentionTitleContent(
                normalizePlainSessionMentionTitle(stabilizedContent)
              )
            : normalizePlainSessionMentionTitle(stabilizedContent)
        )
      ),
    [normalizePlainIssueMentionTitle, stabilizedContent]
  );
  const isMentionOnly = isMentionOnlyMarkdownContent(normalizedContent);
  const shouldDeferMarkdownRender =
    deferLongContentRender &&
    !inline &&
    content.length >=
      (streaming
        ? STREAMING_MARKDOWN_EMERGENCY_PLAIN_CHAR_THRESHOLD
        : DEFERRED_LONG_MARKDOWN_CHAR_THRESHOLD) &&
    !isExpanded;
  const markdownRenderReady = useDeferredMarkdownRenderReady(
    contentSignature,
    shouldDeferMarkdownRender
  );
  const handleLinkClick = useCallback(
    (href: string): void => {
      if (workspaceLinkSource && onLinkAction) {
        const action = resolveWorkspaceLinkAction({
          href,
          workspaceRoot,
          basePath,
          source: workspaceLinkSource
        });
        if (action) {
          onLinkAction(action);
          return;
        }
      }
      onLinkClick?.(href);
    },
    [basePath, onLinkAction, onLinkClick, workspaceLinkSource, workspaceRoot]
  );
  const handleAnchorClickCapture = useCallback(
    (event: MouseEvent<HTMLElement>): void => {
      const href = resolveMarkdownAnchorHref(event.target);
      if (!href) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleLinkClick(href);
    },
    [handleLinkClick]
  );
  const markdownComponents = useMemo(
    () => ({
      a: (props: MarkdownDomProps<"a">) => (
        <MarkdownLink
          {...props}
          onLinkClick={handleLinkClick}
          workspaceAppIcons={workspaceAppIcons}
        />
      ),
      code: (props: MarkdownDomProps<"code">) => (
        <MarkdownCode {...props} onLinkClick={handleLinkClick} />
      ),
      img: (props: MarkdownDomProps<"img">) => (
        <MarkdownImage {...props} enableZoom={enableImageZoom} />
      ),
      p: (props: MarkdownDomProps<"p">) => (
        <MarkdownParagraph {...props} inline={inline} />
      ),
      ul: MarkdownUnorderedList,
      ol: MarkdownOrderedList,
      li: MarkdownListItem
    }),
    [enableImageZoom, handleLinkClick, inline, workspaceAppIcons]
  );

  return (
    <ContainerTag
      className="flex w-full min-w-0 flex-col items-start gap-1"
      data-workspace-agent-markdown-shell="true"
    >
      <ContainerTag
        className={cn(
          "relative w-full min-w-0 overflow-x-auto text-[13px] leading-[1.5] text-[var(--text-primary)] [overflow-wrap:anywhere]",
          "[&_>table:first-child]:mt-0 [&_p]:mb-2 [&_pre]:mb-2 [&_blockquote]:mb-2",
          "[&_hr]:my-4 [&_hr]:h-0 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-t-[color-mix(in_srgb,var(--text-primary)_14%,transparent)]",
          "[&_ul]:my-2 [&_ul]:max-w-full [&_ul]:rounded-[8px] [&_ul]:border [&_ul]:border-[var(--line-2)] [&_ul]:bg-[var(--background-panel)] [&_ul]:px-4 [&_ul]:py-2",
          "[&_ol]:my-2 [&_ol]:max-w-full [&_ol]:rounded-[8px] [&_ol]:border [&_ol]:border-[var(--line-2)] [&_ol]:bg-[var(--background-panel)] [&_ol]:px-4 [&_ol]:py-2",
          "[&_li>ul]:mt-1.5 [&_li>ul]:mb-0.5 [&_li>ul]:border-0 [&_li>ul]:px-0 [&_li>ul]:py-1",
          "[&_li>ol]:mt-1.5 [&_li>ol]:mb-0.5 [&_li>ol]:border-0 [&_li>ol]:px-0 [&_li>ol]:py-1",
          "[&_table]:my-2 [&_table]:w-max [&_table]:min-w-full [&_table]:max-w-full [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:overflow-hidden [&_table]:rounded-[8px] [&_table]:border [&_table]:border-[var(--line-2)] [&_table]:text-[13px] [&_table]:leading-[1.45]",
          "[&_th]:max-w-[280px] [&_th]:border-r [&_th]:border-b [&_th]:border-[var(--line-2)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:align-top [&_th]:font-semibold [&_th]:text-[var(--text-primary)] [&_th]:[overflow-wrap:anywhere] [&_th]:bg-[color-mix(in_srgb,var(--background-panel)_94%,var(--text-primary))]",
          "[&_td]:max-w-[280px] [&_td]:border-r [&_td]:border-b [&_td]:border-[var(--line-2)] [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_td]:[overflow-wrap:anywhere]",
          "[&_tr:last-child_th]:border-b-0 [&_tr:last-child_td]:border-b-0 [&_th:last-child]:border-r-0 [&_td:last-child]:border-r-0",
          "[&_a]:cursor-pointer [&_a]:font-semibold [&_a]:text-[var(--tutti-purple)] [&_a]:no-underline [&_a:hover]:underline [&_a:focus-visible]:underline",
          "[&_strong]:font-semibold",
          "[&_code]:inline [&_code]:rounded-[2px] [&_code]:bg-[var(--transparency-block)] [&_code]:px-1 [&_code]:py-[1px] [&_code]:font-[var(--tsh-font-mono)] [&_code]:text-[11px] [&_code]:leading-[1.35] [&_code]:text-[var(--text-primary)] [&_code]:[box-decoration-break:clone] [&_code]:[-webkit-box-decoration-break:clone] [&_code]:[overflow-wrap:anywhere] [&_code]:[word-break:break-word]",
          "[&_pre]:box-border [&_pre]:overflow-auto [&_pre]:rounded-[6px] [&_pre]:bg-[var(--transparency-block)] [&_pre]:px-2.5 [&_pre]:py-2",
          "[&_pre_code]:inline [&_pre_code]:h-auto [&_pre_code]:items-normal [&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[inherit] [&_pre_code]:leading-[inherit] [&_pre_code]:[white-space:pre-wrap] [&_pre_code]:[overflow-wrap:anywhere] [&_pre_code]:[word-break:break-word]",
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          inline &&
            "inline min-w-0 overflow-hidden align-baseline [&_p]:inline [&_p]:m-0",
          shouldCollapse &&
            "overflow-hidden transition-[max-height] duration-220 ease-out",
          isCollapsed &&
            "max-h-[calc(13px*1.5*8)] overflow-hidden [mask-image:linear-gradient(180deg,black_0%,black_calc(100%_-_36px),transparent_100%)] [-webkit-mask-image:linear-gradient(180deg,black_0%,black_calc(100%_-_36px),transparent_100%)] [&_pre]:overflow-hidden",
          shouldCollapse && !isCollapsed && "max-h-[72rem]",
          className
        )}
        data-workspace-agent-markdown="true"
        data-agent-mention-only={isMentionOnly ? "true" : undefined}
        data-collapsed={isCollapsed ? "true" : "false"}
        onClickCapture={handleAnchorClickCapture}
      >
        {markdownRenderReady ? (
          streaming ? (
            <StreamingMarkdownBlocks
              content={normalizedContent}
              components={markdownComponents}
            />
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[[rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]]}
              urlTransform={markdownUrlTransform}
              components={markdownComponents}
            >
              {normalizedContent}
            </ReactMarkdown>
          )
        ) : (
          <div
            className="whitespace-pre-wrap [overflow-wrap:anywhere]"
            data-workspace-agent-markdown-deferred="true"
          >
            {normalizedContent}
          </div>
        )}
      </ContainerTag>
      {shouldCollapse && !isExpanded ? (
        <button
          type="button"
          className="m-0 border-0 bg-transparent p-0 text-[11px] leading-[1.4] font-semibold text-[var(--tutti-purple)] hover:underline focus-visible:underline focus-visible:outline-none"
          onClick={() => setIsExpanded(true)}
        >
          {resolvedExpandLabel}
        </button>
      ) : null}
    </ContainerTag>
  );
}

function StreamingMarkdownBlocks({
  content,
  components
}: {
  content: string;
  components: ReactMarkdownComponents;
}): JSX.Element {
  const blocks = useMemo(
    () => splitStreamingMarkdownBlocks(content),
    [content]
  );
  return (
    <>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${index}:${hashMarkdownProfilerContent(block.initialKeyContent)}`}
          content={block.content}
          components={components}
        />
      ))}
    </>
  );
}

const MemoizedMarkdownBlock = memo(function MemoizedMarkdownBlock({
  content,
  components
}: {
  content: string;
  components: ReactMarkdownComponents;
}): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]]}
      urlTransform={markdownUrlTransform}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});

export interface StreamingMarkdownBlock {
  content: string;
  initialKeyContent: string;
}

export function splitStreamingMarkdownBlocks(
  content: string
): StreamingMarkdownBlock[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized) {
    return [{ content: "", initialKeyContent: "" }];
  }

  const lines = normalized.split("\n");
  const blocks: StreamingMarkdownBlock[] = [];
  const current: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  for (const line of lines) {
    current.push(line);
    const lineFence = parseStreamingFence(line);
    if (lineFence) {
      if (!fence) {
        fence = lineFence;
      } else if (
        lineFence.marker === fence.marker &&
        lineFence.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (!fence && line.trim() === "") {
      pushStreamingMarkdownBlock(blocks, current);
    }
  }
  pushStreamingMarkdownBlock(blocks, current);
  return blocks.length > 0
    ? blocks
    : [{ content: normalized, initialKeyContent: normalized }];
}

function pushStreamingMarkdownBlock(
  blocks: StreamingMarkdownBlock[],
  lines: string[]
): void {
  if (lines.length === 0) {
    return;
  }
  const content = lines.join("\n");
  if (!content) {
    lines.length = 0;
    return;
  }
  blocks.push({
    content,
    initialKeyContent: content
  });
  lines.length = 0;
}

function parseStreamingFence(
  line: string
): { marker: string; length: number } | null {
  const trimmed = line.trimStart();
  const marker = trimmed[0];
  if (marker !== "`" && marker !== "~") {
    return null;
  }
  let length = 0;
  while (trimmed[length] === marker) {
    length += 1;
  }
  return length >= 3 ? { marker, length } : null;
}

function resolveMarkdownAnchorHref(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const link = target.closest("[data-agent-link-href],a[href]");
  if (!(link instanceof HTMLElement)) {
    return null;
  }
  const dataHref = link.dataset.agentLinkHref?.trim();
  if (dataHref) {
    return dataHref;
  }
  if (link instanceof HTMLAnchorElement) {
    return link.getAttribute("href")?.trim() || null;
  }
  return null;
}

function activateMarkdownLink(
  event:
    | KeyboardEvent<HTMLElement>
    | MouseEvent<HTMLElement>
    | PointerEvent<HTMLElement>,
  href: string,
  onLinkClick?: (href: string) => void
): void {
  const target = href.trim();
  if (!target) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  onLinkClick?.(target);
}

function activateMarkdownLinkFromKey(
  event: KeyboardEvent<HTMLElement>,
  href: string,
  onLinkClick?: (href: string) => void
): void {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  activateMarkdownLink(event, href, onLinkClick);
}

function activateMarkdownLinkFromPointer(
  event: PointerEvent<HTMLElement>,
  href: string,
  onLinkClick?: (href: string) => void
): void {
  if (event.button !== 0) {
    return;
  }
  activateMarkdownLink(event, href, onLinkClick);
}

function useDeferredMarkdownRenderReady(
  contentSignature: string,
  shouldDefer: boolean
): boolean {
  const [readySignature, setReadySignature] = useState<string | null>(
    shouldDefer ? null : contentSignature
  );
  const renderReady = !shouldDefer || readySignature === contentSignature;

  useEffect(() => {
    if (!shouldDefer) {
      setReadySignature(contentSignature);
      return;
    }

    let canceled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let idleCallbackId: number | null = null;
    const markReady = (): void => {
      if (canceled) {
        return;
      }
      startTransition(() => {
        setReadySignature(contentSignature);
      });
    };

    if ("requestIdleCallback" in window) {
      idleCallbackId = window.requestIdleCallback(markReady, {
        timeout: DEFERRED_LONG_MARKDOWN_IDLE_TIMEOUT_MS
      });
    } else {
      timeoutId = setTimeout(
        markReady,
        DEFERRED_LONG_MARKDOWN_FALLBACK_DELAY_MS
      );
    }

    return () => {
      canceled = true;
      if (idleCallbackId !== null) {
        window.cancelIdleCallback(idleCallbackId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [contentSignature, shouldDefer]);

  return renderReady;
}

function hashMarkdownProfilerContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0;
  }
  return `${content.length}:${Math.abs(hash)}`;
}

function isLikelyLongerThanLineLimit(content: string): boolean {
  const normalizedLines = content.replace(/\r\n?/g, "\n").split("\n");
  if (normalizedLines.length > COLLAPSED_LINE_LIMIT) {
    return true;
  }
  const estimatedLineCount = normalizedLines.reduce((total, line) => {
    const trimmed = line.trim();
    const blockSpacing = /^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>)/.test(trimmed)
      ? 1
      : 0;
    return (
      total +
      Math.max(1, Math.ceil(trimmed.length / APPROX_CHARS_PER_LINE)) +
      blockSpacing
    );
  }, 0);
  return estimatedLineCount > COLLAPSED_LINE_LIMIT;
}

function MarkdownLink({
  node: _node,
  onClick: _onClick,
  onLinkClick,
  workspaceAppIcons,
  href,
  ...props
}: MarkdownDomProps<"a"> & {
  onLinkClick?: (href: string) => void;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}): JSX.Element {
  "use memo";
  const { t } = useTranslation();
  const targetHref = href?.trim() ?? "";
  const mention = targetHref
    ? parseMentionLink(
        targetHref,
        textFromReactNode(props.children),
        workspaceAppIcons ?? [],
        t("agentHost.agentGui.workspaceAppFactoryMentionFallback")
      )
    : null;
  if (mention) {
    return (
      <MentionLink
        {...props}
        href={targetHref}
        mention={mention}
        onLinkClick={onLinkClick}
      />
    );
  }
  const fileMention = targetHref
    ? parseWorkspaceFileMentionLink(
        targetHref,
        textFromReactNode(props.children)
      )
    : null;
  if (fileMention) {
    return (
      <WorkspaceFileMentionLink
        {...props}
        href={targetHref}
        mention={fileMention}
        onLinkClick={onLinkClick}
      />
    );
  }

  return (
    <MarkdownLinkContext.Provider value={true}>
      <a
        {...props}
        data-agent-link-href={targetHref}
        role="link"
        tabIndex={0}
        onClick={(event) => {
          activateMarkdownLink(event, targetHref, onLinkClick);
        }}
        onPointerDown={(event) => {
          activateMarkdownLinkFromPointer(event, targetHref, onLinkClick);
        }}
        onKeyDown={(event) => {
          activateMarkdownLinkFromKey(event, targetHref, onLinkClick);
        }}
      />
    </MarkdownLinkContext.Provider>
  );
}

interface ParsedWorkspaceFileMentionLink {
  label: string;
  href: string;
  entryKind: "file" | "directory";
  visualKind: string;
}

interface ParsedWorkspaceFileMentionTarget {
  path: string;
  explicitKind: "file" | "directory" | null;
}

function parseWorkspaceFileMentionTarget(
  href: string
): ParsedWorkspaceFileMentionTarget | null {
  const target = href.trim();
  if (!isLocalAbsolutePath(target)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(target, "https://tsh.local");
  } catch {
    return null;
  }
  const explicitKindValue =
    url.searchParams.get("kind") ??
    url.searchParams.get("refType") ??
    url.searchParams.get("entryKind") ??
    "";
  const normalizedKind = explicitKindValue.trim().toLowerCase();
  const explicitKind =
    normalizedKind === "folder" || normalizedKind === "directory"
      ? "directory"
      : normalizedKind === "file"
        ? "file"
        : null;
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") {
    return null;
  }

  return {
    path,
    explicitKind:
      explicitKind ?? (url.pathname.endsWith("/") ? "directory" : null)
  };
}

function resolveWorkspaceFileMentionEntryKind(
  path: string,
  label: string,
  explicitKind: "file" | "directory" | null
): "file" | "directory" {
  if (explicitKind) {
    return explicitKind;
  }
  if (resolveWorkspaceFileExtension(path)) {
    return "file";
  }

  const basename = basenameWorkspacePath(path);
  return basename === label ? "directory" : "file";
}

function parseWorkspaceFileMentionLink(
  href: string,
  rawLabel: string
): ParsedWorkspaceFileMentionLink | null {
  const label = rawLabel.trim();
  const target = parseWorkspaceFileMentionTarget(href);
  if (!target || !label.startsWith("@")) {
    return null;
  }
  const fileLabel = label.replace(/^@+/, "").trim();
  if (!fileLabel) {
    return null;
  }
  const entryKind = resolveWorkspaceFileMentionEntryKind(
    target.path,
    fileLabel,
    target.explicitKind
  );
  return {
    label: fileLabel,
    href: target.path,
    entryKind,
    visualKind: resolveAgentWorkspaceFileVisualKind(target.path, {
      refType: entryKind === "directory" ? "folder" : "file"
    })
  };
}

function WorkspaceFileMentionLink({
  onClick: _onClick,
  onLinkClick,
  href: _href,
  mention,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  mention: ParsedWorkspaceFileMentionLink;
  onLinkClick?: (href: string) => void;
}): JSX.Element {
  "use memo";
  return (
    <a
      {...props}
      className={cn(
        "tsh-workspace-file-link tsh-agent-object-token tsh-agent-object-token--file",
        props.className
      )}
      data-agent-file-mention="true"
      data-agent-mention-kind="file"
      data-agent-file-entry-kind={mention.entryKind}
      data-agent-file-visual-kind={mention.visualKind}
      data-agent-link-href={mention.href}
      data-agent-mention-href={mention.href}
      aria-label={mention.label}
      role="link"
      tabIndex={0}
      onClick={(event) => {
        activateMarkdownLink(event, mention.href, onLinkClick);
      }}
      onPointerDown={(event) => {
        activateMarkdownLinkFromPointer(event, mention.href, onLinkClick);
      }}
      onKeyDown={(event) => {
        activateMarkdownLinkFromKey(event, mention.href, onLinkClick);
      }}
    >
      <span className="tsh-agent-object-token__icon" aria-hidden="true" />
      <span className="tsh-agent-object-token__main">{mention.label}</span>
    </a>
  );
}

function MentionLink({
  onClick: _onClick,
  onLinkClick,
  href,
  mention,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  mention: ParsedMentionLink;
  onLinkClick?: (href: string) => void;
}): JSX.Element {
  "use memo";
  return (
    <a
      {...props}
      className={cn(
        "tsh-agent-object-token tsh-agent-object-token--entity",
        props.className
      )}
      data-agent-file-mention="true"
      data-agent-link-href={href}
      data-agent-mention-icon-url={mention.iconUrl}
      data-agent-mention-href={href}
      data-agent-mention-kind={mention.kind}
      aria-label={mention.label}
      role="link"
      tabIndex={0}
      onClick={(event) => {
        activateMarkdownLink(event, href, onLinkClick);
      }}
      onPointerDown={(event) => {
        activateMarkdownLinkFromPointer(event, href, onLinkClick);
      }}
      onKeyDown={(event) => {
        activateMarkdownLinkFromKey(event, href, onLinkClick);
      }}
    >
      {mention.kind === "workspace-app" ? (
        <span
          className="grid h-4 w-4 shrink-0 place-items-center overflow-hidden rounded-[4px] bg-block"
          aria-hidden="true"
          data-agent-mention-app-icon="true"
          data-workspace-app-icon="true"
        >
          {mention.iconUrl ? (
            <img
              src={mention.iconUrl}
              alt=""
              className="h-full w-full object-cover"
              decoding="async"
              loading="lazy"
              draggable={false}
            />
          ) : (
            <span className="tsh-agent-object-token__kind-icon h-4 w-4" />
          )}
        </span>
      ) : (
        <span className="tsh-agent-object-token__kind" aria-hidden="true">
          <span
            className="tsh-agent-object-token__kind-icon"
            aria-hidden="true"
          />
        </span>
      )}
      {mention.kind === "session" ? (
        <span className="tsh-agent-object-token__main">
          <span className="tsh-agent-object-token__participant">
            {mention.participant}
          </span>
          {mention.summary ? (
            <span className="tsh-agent-object-token__summary">
              {" "}
              {mention.summary}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="tsh-agent-object-token__main">{mention.label}</span>
      )}
    </a>
  );
}

function MarkdownCode({
  node: _node,
  children,
  className,
  onLinkClick,
  ...props
}: MarkdownDomProps<"code"> & {
  onLinkClick?: (href: string) => void;
}): JSX.Element {
  "use memo";
  const text = textFromReactNode(children).trim();
  if (
    !className &&
    onLinkClick &&
    (isLocalAbsolutePath(text) || isHttpUrl(text))
  ) {
    return (
      <code {...props} className={className}>
        <PathLink href={text} onLinkClick={onLinkClick}>
          {children}
        </PathLink>
      </code>
    );
  }
  return (
    <code {...props} className={className}>
      {children}
    </code>
  );
}

type MarkdownImageState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | {
      status: "error";
      reason: "unsupported" | "read-failed";
      detail?: string;
    };

interface CachedMarkdownImage {
  objectUrl: string;
  refCount: number;
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

const cachedMarkdownImages = new Map<string, CachedMarkdownImage>();
const CACHED_MARKDOWN_IMAGE_REVOKE_DELAY_MS = 250;

export function resetCachedMarkdownImagesForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    return;
  }
  for (const [path, entry] of cachedMarkdownImages) {
    if (entry.revokeTimer) {
      clearTimeout(entry.revokeTimer);
    }
    URL.revokeObjectURL(entry.objectUrl);
    cachedMarkdownImages.delete(path);
  }
}

function MarkdownImage({
  node: _node,
  src,
  alt,
  className,
  enableZoom = false,
  ...props
}: MarkdownDomProps<"img"> & {
  enableZoom?: boolean;
}): JSX.Element {
  "use memo";
  const { t } = useTranslation();
  const isInsideLink = useContext(MarkdownLinkContext);
  const agentHostApi = useOptionalAgentHostApi() ?? getOptionalAgentHostApi();
  const workspacePath =
    typeof src === "string" && isLocalAbsolutePath(src) ? src.trim() : null;
  const readWorkspaceImage = workspacePath
    ? agentHostApi?.workspace?.readFile
    : undefined;
  const canReadWorkspaceImage = Boolean(workspacePath && readWorkspaceImage);
  const shouldEnableZoom = enableZoom && !isInsideLink;
  const resolvedSrc =
    typeof src === "string" ? resolveRenderableMarkdownImageSrc(src) : src;
  const [state, setState] = useState<MarkdownImageState | null>(() =>
    canReadWorkspaceImage && workspacePath
      ? (peekCachedMarkdownImageState(workspacePath) ?? { status: "loading" })
      : null
  );

  useEffect(() => {
    if (!workspacePath || !readWorkspaceImage) {
      setState(null);
      return;
    }

    const resolvedWorkspacePath = workspacePath;
    const resolvedReadWorkspaceImage = readWorkspaceImage;
    const cachedSrc = retainCachedMarkdownImage(resolvedWorkspacePath);
    if (cachedSrc) {
      setState({ status: "ready", src: cachedSrc });
      return () => {
        releaseCachedMarkdownImage(resolvedWorkspacePath, cachedSrc);
      };
    }

    const resolvedMimeType = resolveWorkspaceImageMimeType(
      resolvedWorkspacePath
    );
    if (!resolvedMimeType) {
      setState({
        status: "error",
        reason: "unsupported"
      });
      return;
    }
    const imageMimeType = resolvedMimeType;

    let canceled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    async function loadWorkspaceImage(): Promise<void> {
      try {
        const result = await resolvedReadWorkspaceImage({
          path: resolvedWorkspacePath
        });
        if (canceled) {
          return;
        }
        const bytes =
          result.bytes instanceof Uint8Array
            ? result.bytes
            : new Uint8Array(result.bytes);
        const arrayBuffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
        objectUrl = cacheMarkdownImage(
          resolvedWorkspacePath,
          new Blob([arrayBuffer], { type: imageMimeType })
        );
        setState({ status: "ready", src: objectUrl });
      } catch (error) {
        if (!canceled) {
          setState({
            status: "error",
            reason: "read-failed",
            detail: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    void loadWorkspaceImage();

    return () => {
      canceled = true;
      if (objectUrl) {
        releaseCachedMarkdownImage(resolvedWorkspacePath, objectUrl);
      }
    };
  }, [canReadWorkspaceImage, workspacePath]);

  if (!workspacePath || !readWorkspaceImage) {
    if (!shouldEnableZoom) {
      return (
        <img {...props} src={resolvedSrc} alt={alt} className={className} />
      );
    }

    return (
      <ZoomableImage
        {...props}
        src={resolvedSrc}
        alt={alt}
        className={className}
        wrapElement="span"
      />
    );
  }

  if (state?.status === "ready") {
    if (!shouldEnableZoom) {
      return (
        <img
          {...props}
          src={state.src}
          alt={alt}
          className={cn(
            "block max-h-[360px] max-w-full rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] object-contain",
            className
          )}
        />
      );
    }

    return (
      <ZoomableImage
        {...props}
        src={state.src}
        alt={alt}
        className={cn(
          "block max-h-[360px] max-w-full rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] object-contain",
          className
        )}
        wrapElement="span"
      />
    );
  }

  return (
    <span className="flex min-h-[160px] w-full items-center justify-center rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] px-5 py-5 text-center text-[13px] leading-5 text-[var(--text-tertiary)]">
      {state?.status === "error"
        ? state.reason === "unsupported"
          ? t("agentHost.workspaceFileManager.previewUnsupported")
          : t("agentHost.workspaceFileManager.previewReadFailed", {
              message: state.detail ?? ""
            })
        : t("agentHost.workspaceFileManager.previewLoading")}
    </span>
  );
}

const MARKDOWN_ORDERED_LIST_STYLE: CSSProperties = {
  listStylePosition: "outside",
  margin: "12px 0 8px",
  paddingInlineStart: 34,
  paddingInlineEnd: 16
};

const MARKDOWN_UNORDERED_LIST_STYLE: CSSProperties = {
  margin: "12px 0 8px",
  paddingInlineStart: 0
};

const MARKDOWN_LIST_ITEM_STYLE: CSSProperties = {
  margin: "4px 0"
};

function MarkdownUnorderedList({
  node: _node,
  className,
  style,
  ...props
}: MarkdownDomProps<"ul">): JSX.Element {
  "use memo";
  return (
    <ul
      {...props}
      className={cn(
        '[&_li]:relative [&_li]:list-none [&_li]:pl-[34px] [&_li::before]:absolute [&_li::before]:left-4 [&_li::before]:top-[0.78em] [&_li::before]:h-1.5 [&_li::before]:w-1.5 [&_li::before]:-translate-y-1/2 [&_li::before]:rounded-full [&_li::before]:bg-[var(--text-tertiary)] [&_li::before]:content-[""]',
        className
      )}
      style={{ ...MARKDOWN_UNORDERED_LIST_STYLE, ...style }}
    />
  );
}

function MarkdownOrderedList({
  node: _node,
  style,
  ...props
}: MarkdownDomProps<"ol">): JSX.Element {
  "use memo";
  return (
    <ol
      {...props}
      style={{
        ...MARKDOWN_ORDERED_LIST_STYLE,
        listStyleType: "decimal",
        ...style
      }}
    />
  );
}

function MarkdownListItem({
  node: _node,
  style,
  ...props
}: MarkdownDomProps<"li">): JSX.Element {
  "use memo";
  return <li {...props} style={{ ...MARKDOWN_LIST_ITEM_STYLE, ...style }} />;
}

function MarkdownParagraph({
  node: _node,
  inline,
  ...props
}: MarkdownDomProps<"p"> & {
  inline: boolean;
}): JSX.Element {
  "use memo";
  if (inline) {
    return <span {...props} />;
  }
  return <p {...props} />;
}

function isLocalAbsolutePath(path: string): boolean {
  const candidate = path.trim();
  return (
    candidate.length > 1 &&
    candidate.startsWith("/") &&
    !candidate.startsWith("//") &&
    !candidate.includes("://") &&
    !/\s/.test(candidate)
  );
}

function resolveRenderableMarkdownImageSrc(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) {
    return src;
  }
  if (!isLocalAbsolutePath(trimmed) || trimmed.startsWith("/workspace/")) {
    return src;
  }
  return new URL(trimmed, "file://").toString();
}

function peekCachedMarkdownImageState(path: string): MarkdownImageState | null {
  const src = cachedMarkdownImages.get(path)?.objectUrl ?? null;
  return src ? { status: "ready", src } : null;
}

function retainCachedMarkdownImage(path: string): string | null {
  const entry = cachedMarkdownImages.get(path);
  if (!entry) {
    return null;
  }
  entry.refCount += 1;
  if (entry.revokeTimer) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  return entry.objectUrl;
}

function cacheMarkdownImage(path: string, blob: Blob): string {
  const entry = cachedMarkdownImages.get(path);
  if (entry) {
    entry.refCount += 1;
    if (entry.revokeTimer) {
      clearTimeout(entry.revokeTimer);
      entry.revokeTimer = null;
    }
    return entry.objectUrl;
  }
  const objectUrl = URL.createObjectURL(blob);
  cachedMarkdownImages.set(path, {
    objectUrl,
    refCount: 1,
    revokeTimer: null
  });
  return objectUrl;
}

function releaseCachedMarkdownImage(path: string, objectUrl: string): void {
  const entry = cachedMarkdownImages.get(path);
  if (!entry || entry.objectUrl !== objectUrl) {
    URL.revokeObjectURL(objectUrl);
    return;
  }
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0 || entry.revokeTimer) {
    return;
  }
  entry.revokeTimer = setTimeout(() => {
    const current = cachedMarkdownImages.get(path);
    if (!current || current.objectUrl !== objectUrl || current.refCount > 0) {
      return;
    }
    cachedMarkdownImages.delete(path);
    URL.revokeObjectURL(objectUrl);
  }, CACHED_MARKDOWN_IMAGE_REVOKE_DELAY_MS);
}

function isHttpUrl(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || /\s/.test(candidate)) {
    return false;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function linkBareLocalAbsolutePaths(content: string): string {
  let out = "";
  for (let index = 0; index < content.length; ) {
    const markdownLinkEnd = markdownLinkEndIndex(content, index);
    if (markdownLinkEnd > index) {
      out += content.slice(index, markdownLinkEnd);
      index = markdownLinkEnd;
      continue;
    }

    const codeSpanEnd = codeSpanEndIndex(content, index);
    if (codeSpanEnd > index) {
      out += content.slice(index, codeSpanEnd);
      index = codeSpanEnd;
      continue;
    }

    if (isLocalPathStart(content, index)) {
      const end = bareLocalPathEndIndex(content, index);
      const rawPath = trimTrailingPathPunctuation(content.slice(index, end));
      const trailing = content.slice(index + rawPath.length, end);
      if (isLocalAbsolutePath(rawPath)) {
        out += `[${escapeMarkdownLinkLabel(rawPath)}](${rawPath})${trailing}`;
      } else {
        out += content.slice(index, end);
      }
      index = end;
      continue;
    }

    out += content[index];
    index += 1;
  }
  return out;
}

function normalizePlainIssueMentionTitleContent(content: string): string {
  const trimmed = content.trim();
  if (
    trimmed !== content ||
    !trimmed.startsWith("@") ||
    trimmed.includes("\n") ||
    markdownLinkEndIndex(trimmed, 0) === trimmed.length
  ) {
    return content;
  }

  const label = trimmed.replace(/^@+/, "").trim();
  if (!label) {
    return content;
  }

  return `[@${escapeMarkdownLinkLabel(label)}](mention://workspace-issue?source=plain-title)`;
}

function normalizeMentionMarkdownLinks(content: string): string {
  return content
    .replace(/\]([\t ]*\r?\n[\t ]*)+\((mention:\/\/)/g, "]($2")
    .replace(/\]\((mention:\/\/[A-Za-z0-9.-]+)\)\?([^\s)]+)/g, "]($1?$2)");
}

function isMentionOnlyMarkdownContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (markdownLinkEndIndex(trimmed, 0) !== trimmed.length) {
    return false;
  }
  const labelEnd = trimmed.indexOf("]");
  return trimmed.slice(labelEnd + 2).startsWith("mention://");
}

function normalizePlainSessionMentionTitle(content: string): string {
  const trimmed = content.trim();
  if (
    trimmed !== content ||
    !trimmed.startsWith("@") ||
    trimmed.includes("\n")
  ) {
    return content;
  }

  for (const agentLabel of PLAIN_SESSION_MENTION_AGENT_LABELS) {
    const separator = ` & ${agentLabel}`;
    const separatorIndex = trimmed.indexOf(separator);
    if (separatorIndex <= 1) {
      continue;
    }

    const userLabel = trimmed.slice(1, separatorIndex).trim();
    const summary = trimmed.slice(separatorIndex + separator.length).trim();
    if (!userLabel) {
      continue;
    }

    const mentionLabel = [userLabel, agentLabel, summary]
      .filter(Boolean)
      .join(" · ");
    return `[@${escapeMarkdownLinkLabel(mentionLabel)}](mention://agent-session?source=plain-title)`;
  }

  return content;
}

function markdownUrlTransform(value: string): string {
  return value.startsWith("mention://") ? value : defaultUrlTransform(value);
}

type MentionKind =
  | "session"
  | "workspace-app"
  | "workspace-app-factory"
  | "workspace-issue";

interface ParsedMentionLink {
  appId?: string;
  kind: MentionKind;
  label: string;
  iconUrl?: string;
  participant: string;
  summary: string;
}

function parseMentionLink(
  href: string,
  rawLabel: string,
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[] = [],
  appFactoryFallbackLabel = "Create app"
): ParsedMentionLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "mention:") {
    return null;
  }
  const resource = url.hostname.trim().toLowerCase();
  const kind =
    resource === "agent-session"
      ? "session"
      : resource === "workspace-app"
        ? "workspace-app"
        : resource === "workspace-app-factory"
          ? "workspace-app-factory"
          : resource === "workspace-issue"
            ? "workspace-issue"
            : resource;
  if (
    kind !== "session" &&
    kind !== "workspace-app" &&
    kind !== "workspace-app-factory" &&
    kind !== "workspace-issue"
  ) {
    return null;
  }
  const label =
    rawLabel.trim().replace(/^@+/, "").trim() ||
    (kind === "workspace-app-factory" ? appFactoryFallbackLabel : "");
  if (kind === "workspace-app" || kind === "workspace-app-factory") {
    const appId = url.searchParams.get("appId")?.trim() || "";
    const workspaceId = url.searchParams.get("workspaceId")?.trim() || "";
    return {
      kind,
      ...(kind === "workspace-app" ? { appId } : {}),
      label,
      ...(kind === "workspace-app"
        ? {
            iconUrl: resolveWorkspaceAppMentionIconUrl({
              appId,
              workspaceAppIcons,
              workspaceId
            })
          }
        : {}),
      participant: label,
      summary: ""
    };
  }
  if (kind === "workspace-issue") {
    return {
      kind,
      label,
      participant: label,
      summary: ""
    };
  }
  const sessionLabel = parseSessionMentionLabel(label);
  return {
    kind,
    label,
    participant: sessionLabel.participant,
    summary: sessionLabel.summary
  };
}

function resolveWorkspaceAppMentionIconUrl(input: {
  appId: string;
  workspaceId: string;
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}): string | undefined {
  const appId = input.appId.trim();
  if (!appId) {
    return undefined;
  }
  const workspaceId = input.workspaceId.trim();
  const exactMatch = input.workspaceAppIcons.find(
    (icon) =>
      icon.appId.trim() === appId &&
      (icon.workspaceId?.trim() ?? "") === workspaceId &&
      icon.iconUrl?.trim()
  );
  const fallbackMatch = input.workspaceAppIcons.find(
    (icon) => icon.appId.trim() === appId && icon.iconUrl?.trim()
  );
  return (
    exactMatch?.iconUrl?.trim() || fallbackMatch?.iconUrl?.trim() || undefined
  );
}

function parseSessionMentionLabel(label: string): {
  participant: string;
  summary: string;
} {
  const dottedParts = label
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  if (dottedParts.length >= 3) {
    return {
      participant: `${dottedParts[0]} & ${dottedParts[1]}`,
      summary: dottedParts.slice(2).join(" ")
    };
  }
  return {
    participant: label,
    summary: ""
  };
}

function markdownLinkEndIndex(content: string, index: number): number {
  if (content[index] !== "[") {
    return -1;
  }
  const labelEnd = content.indexOf("]", index + 1);
  if (labelEnd < 0 || content[labelEnd + 1] !== "(") {
    return -1;
  }
  const hrefEnd = content.indexOf(")", labelEnd + 2);
  return hrefEnd < 0 ? -1 : hrefEnd + 1;
}

function codeSpanEndIndex(content: string, index: number): number {
  if (content[index] !== "`") {
    return -1;
  }
  let tickCount = 1;
  while (content[index + tickCount] === "`") {
    tickCount += 1;
  }
  const fence = "`".repeat(tickCount);
  const end = content.indexOf(fence, index + tickCount);
  return end < 0 ? -1 : end + tickCount;
}

function isLocalPathStart(content: string, index: number): boolean {
  if (content[index] !== "/" || content[index + 1] === "/") {
    return false;
  }
  const previous = content[index - 1];
  return (
    previous === undefined ||
    /\s/.test(previous) ||
    previous === "(" ||
    previous === "["
  );
}

function bareLocalPathEndIndex(content: string, index: number): number {
  let end = index;
  while (end < content.length) {
    const char = content[end];
    if (!char || /[\s<>[\](){}"'`]/.test(char)) {
      break;
    }
    end += 1;
  }
  return end;
}

function trimTrailingPathPunctuation(path: string): string {
  return path.replace(/[.,;:!?，。；：！？]+$/g, "");
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/([\\[\]])/g, "\\$1");
}

function PathLink({
  href,
  children,
  onLinkClick
}: {
  href: string;
  children: ReactNode;
  onLinkClick: (href: string) => void;
}): JSX.Element {
  "use memo";
  return (
    <a
      className="cursor-pointer"
      data-agent-link-href={href}
      role="link"
      tabIndex={0}
      onClick={(event) => {
        activateMarkdownLink(event, href, onLinkClick);
      }}
      onPointerDown={(event) => {
        activateMarkdownLinkFromPointer(event, href, onLinkClick);
      }}
      onKeyDown={(event) => {
        activateMarkdownLinkFromKey(event, href, onLinkClick);
      }}
    >
      {children}
    </a>
  );
}

function textFromReactNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textFromReactNode).join("");
  }
  return "";
}
