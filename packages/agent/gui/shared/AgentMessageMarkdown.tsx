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
  resolveWorkspaceVideoMimeType,
  workspaceFileName as basenameWorkspacePath
} from "@tutti-os/workspace-file-manager/services";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useTextOverflow
} from "@tutti-os/ui-system/components";
import {
  isRichTextMentionHref,
  parseRichTextMentionHref
} from "@tutti-os/ui-rich-text/core";
import {
  getOptionalAgentHostApi,
  useOptionalAgentHostApi
} from "../agentActivityHost";
import {
  isDirectAgentGeneratedMediaPath,
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
const STANDARD_MARKDOWN_LINK_PROTOCOLS = [
  "http",
  "https",
  "irc",
  "ircs",
  "mailto",
  "tel",
  "xmpp"
] as const;
const WINDOWS_DRIVE_HREF_PROTOCOLS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
export const AGENT_MARKDOWN_PLAIN_TITLE_CLASSNAME =
  "[font-size:inherit] [line-height:inherit] text-inherit [&_a]:text-inherit [&_a]:font-inherit [&_a]:no-underline [&_a:hover]:no-underline [&_a:focus-visible]:no-underline [&_strong]:font-inherit [&_strong]:text-inherit";

const MARKDOWN_SANITIZE_SCHEMA: RehypeSanitizeOptions = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      "mention",
      ...STANDARD_MARKDOWN_LINK_PROTOCOLS,
      ...WINDOWS_DRIVE_HREF_PROTOCOLS
    ]
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
  previewMode?: boolean;
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
  previewMode = false,
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
      if (workspaceLinkSource && onLinkAction && workspaceRoot) {
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
          previewMode={previewMode}
        />
      ),
      code: (props: MarkdownDomProps<"code">) => (
        <MarkdownCode {...props} onLinkClick={handleLinkClick} />
      ),
      img: (props: MarkdownDomProps<"img">) => (
        <MarkdownMedia {...props} enableZoom={enableImageZoom} />
      ),
      p: (props: MarkdownDomProps<"p">) => (
        <MarkdownParagraph {...props} inline={inline} />
      ),
      ul: MarkdownUnorderedList,
      ol: MarkdownOrderedList,
      li: MarkdownListItem
    }),
    [enableImageZoom, handleLinkClick, inline, previewMode, workspaceAppIcons]
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
  previewMode,
  href,
  ...props
}: MarkdownDomProps<"a"> & {
  onLinkClick?: (href: string) => void;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  previewMode?: boolean;
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
        previewMode={previewMode === true}
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
  if (!isClickableMarkdownHref(targetHref)) {
    return (
      <MarkdownLinkContext.Provider value={true}>
        <span className={props.className} title={props.title}>
          {props.children}
        </span>
      </MarkdownLinkContext.Provider>
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
  previewMode,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  mention: ParsedMentionLink;
  onLinkClick?: (href: string) => void;
  previewMode: boolean;
}): JSX.Element {
  "use memo";
  // 标签截断时,hover 用设计系统 Tooltip 展示完整文本。trigger = 整个 chip(<a>),
  // 截断发生在内部 __main span,故在那上面测溢出。
  const tooltipText =
    mention.kind === "session"
      ? `${mention.participant}${mention.summary ? ` ${mention.summary}` : ""}`.trim()
      : mention.label;
  const { ref: mainRef, overflowing } =
    useTextOverflow<HTMLSpanElement>(tooltipText);
  const link = (
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
      data-agent-reference-source={mention.referenceSource}
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
      {mention.kind === "workspace-app" ||
      mention.kind === "workspace-reference" ? (
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
        <span className="tsh-agent-object-token__main" ref={mainRef}>
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
        <span className="tsh-agent-object-token__main" ref={mainRef}>
          {mention.label}
        </span>
      )}
    </a>
  );

  if (previewMode) {
    return link;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        {overflowing ? (
          <TooltipContent className="max-w-[min(420px,calc(100vw-32px))] whitespace-normal text-left [overflow-wrap:anywhere]">
            {tooltipText}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
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
  const isInsideLink = useContext(MarkdownLinkContext);
  const text = textFromReactNode(children).trim();
  const isLinkablePath =
    !isInsideLink &&
    onLinkClick &&
    !className &&
    (isExplicitWorkspaceFilePath(text) || isHttpUrl(text));
  if (isLinkablePath) {
    return (
      <PathLink href={text} onLinkClick={onLinkClick}>
        {children}
      </PathLink>
    );
  }
  return (
    <code {...props} className={className}>
      {children}
    </code>
  );
}

type MarkdownMediaKind = "image" | "video";

type MarkdownMediaState =
  | { status: "loading" }
  | { kind: MarkdownMediaKind; status: "ready"; src: string }
  | {
      status: "error";
      reason: "unsupported" | "read-failed";
      detail?: string;
    };

interface CachedMarkdownMedia {
  kind: MarkdownMediaKind;
  objectUrl: string;
  refCount: number;
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

const cachedMarkdownMedia = new Map<string, CachedMarkdownMedia>();
const CACHED_MARKDOWN_MEDIA_REVOKE_DELAY_MS = 250;

export function resetCachedMarkdownImagesForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    return;
  }
  for (const [path, entry] of cachedMarkdownMedia) {
    if (entry.revokeTimer) {
      clearTimeout(entry.revokeTimer);
    }
    URL.revokeObjectURL(entry.objectUrl);
    cachedMarkdownMedia.delete(path);
  }
}

function MarkdownMedia({
  node: _node,
  src,
  alt,
  className,
  title,
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
  const fallbackMediaKind =
    typeof src === "string" ? resolveMarkdownMediaKind(src) : null;
  const resolvedSrc =
    typeof src === "string" ? resolveRenderableMarkdownMediaSrc(src) : src;
  const [state, setState] = useState<MarkdownMediaState | null>(() =>
    canReadWorkspaceImage && workspacePath
      ? (peekCachedMarkdownMediaState(workspacePath) ?? { status: "loading" })
      : null
  );

  useEffect(() => {
    if (!workspacePath || !readWorkspaceImage) {
      setState(null);
      return;
    }

    const resolvedWorkspacePath = workspacePath;
    const resolvedReadWorkspaceImage = readWorkspaceImage;
    const cached = retainCachedMarkdownMedia(resolvedWorkspacePath);
    if (cached) {
      setState({ kind: cached.kind, status: "ready", src: cached.src });
      return () => {
        releaseCachedMarkdownMedia(resolvedWorkspacePath, cached.src);
      };
    }

    const mediaType = resolveMarkdownMediaType(resolvedWorkspacePath);
    if (!mediaType) {
      setState({
        status: "error",
        reason: "unsupported"
      });
      return;
    }
    const mediaKind = mediaType.kind;
    const mediaMimeType = mediaType.mimeType;

    let canceled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    async function loadWorkspaceMedia(): Promise<void> {
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
        objectUrl = cacheMarkdownMedia(
          resolvedWorkspacePath,
          mediaKind,
          new Blob([arrayBuffer], { type: mediaMimeType })
        );
        setState({ kind: mediaKind, status: "ready", src: objectUrl });
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

    void loadWorkspaceMedia();

    return () => {
      canceled = true;
      if (objectUrl) {
        releaseCachedMarkdownMedia(resolvedWorkspacePath, objectUrl);
      }
    };
  }, [canReadWorkspaceImage, workspacePath]);

  if (!workspacePath || !readWorkspaceImage) {
    if (fallbackMediaKind === "video") {
      if (!canRenderMarkdownVideoFallback(src)) {
        return <UnsupportedMarkdownMediaPreview />;
      }
      return (
        <video
          src={resolvedSrc}
          aria-label={alt || undefined}
          title={typeof title === "string" ? title : undefined}
          controls
          playsInline
          preload="metadata"
          className={cn(
            "mt-2 block max-h-[360px] max-w-full rounded-[8px] bg-[var(--transparency-block)]",
            className
          )}
        />
      );
    }

    if (!shouldEnableZoom) {
      return (
        <img
          {...props}
          src={resolvedSrc}
          alt={alt}
          title={title}
          className={className}
        />
      );
    }

    return (
      <ZoomableImage
        {...props}
        src={resolvedSrc}
        alt={alt}
        title={title}
        downloadName={resolveMarkdownImageDownloadName(src, alt)}
        className={className}
        wrapElement="span"
      />
    );
  }

  if (state?.status === "ready") {
    if (state.kind === "video") {
      return (
        <video
          src={state.src}
          aria-label={alt || undefined}
          title={typeof title === "string" ? title : undefined}
          controls
          playsInline
          preload="metadata"
          className={cn(
            "mt-2 block max-h-[360px] max-w-full rounded-[8px] bg-[var(--transparency-block)]",
            className
          )}
        />
      );
    }

    if (!shouldEnableZoom) {
      return (
        <img
          {...props}
          src={state.src}
          alt={alt}
          title={title}
          className={cn(
            "mt-2 block max-h-[360px] max-w-full rounded-[8px] bg-[var(--transparency-block)] object-contain",
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
        title={title}
        downloadName={resolveMarkdownImageDownloadName(workspacePath, alt)}
        className={cn(
          "mt-2 block max-h-[360px] max-w-full rounded-[8px] bg-[var(--transparency-block)] object-contain",
          className
        )}
        wrapElement="span"
      />
    );
  }

  return (
    <span className="mt-2 flex min-h-[160px] w-full items-center justify-center rounded-[8px] bg-[var(--transparency-block)] px-5 py-5 text-center text-[13px] leading-5 text-[var(--text-tertiary)]">
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

function UnsupportedMarkdownMediaPreview(): JSX.Element {
  const { t } = useTranslation();
  return (
    <span className="mt-2 flex min-h-[160px] w-full items-center justify-center rounded-[8px] bg-[var(--transparency-block)] px-5 py-5 text-center text-[13px] leading-5 text-[var(--text-tertiary)]">
      {t("agentHost.workspaceFileManager.previewUnsupported")}
    </span>
  );
}

function resolveMarkdownImageDownloadName(
  src: unknown,
  alt: unknown
): string | undefined {
  if (typeof src === "string") {
    const pathName = basenameWorkspacePath(src.trim());
    if (pathName) {
      return pathName;
    }
  }
  return typeof alt === "string" ? alt.trim() || undefined : undefined;
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

function isHomeRelativePath(path: string): boolean {
  const candidate = path.trim();
  return (
    candidate.length > 0 &&
    !/\s/.test(candidate) &&
    (candidate === "~" ||
      candidate.startsWith("~/") ||
      candidate.startsWith("~\\"))
  );
}

function isWindowsAbsolutePath(path: string): boolean {
  const candidate = path.trim();
  return /^[A-Za-z]:[\\/]/.test(candidate) && !/\s/.test(candidate);
}

function isExplicitWorkspaceFilePath(path: string): boolean {
  const candidate = path.trim();
  if (!candidate || candidate.includes("://")) {
    return false;
  }
  return (
    isLocalAbsolutePath(candidate) ||
    isHomeRelativePath(candidate) ||
    isWindowsAbsolutePath(candidate)
  );
}

function isClickableMarkdownHref(href: string): boolean {
  const target = href.trim();
  return Boolean(
    target &&
    (isStandardMarkdownLinkHref(target) ||
      isRichTextMentionHref(target) ||
      isExplicitWorkspaceFilePath(target))
  );
}

function isStandardMarkdownLinkHref(href: string): boolean {
  const target = href.trim();
  if (!target || isExplicitWorkspaceFilePath(target)) {
    return false;
  }
  if (target.startsWith("#")) {
    return target.length > 1;
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  const protocol = url.protocol.replace(/:$/, "").toLowerCase();
  return STANDARD_MARKDOWN_LINK_PROTOCOLS.includes(
    protocol as (typeof STANDARD_MARKDOWN_LINK_PROTOCOLS)[number]
  );
}

function resolveRenderableMarkdownMediaSrc(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) {
    return src;
  }
  if (!isLocalAbsolutePath(trimmed) || trimmed.startsWith("/workspace/")) {
    return src;
  }
  return new URL(trimmed, "file://").toString();
}

function canRenderMarkdownVideoFallback(src: unknown): boolean {
  if (typeof src !== "string") {
    return false;
  }
  const trimmed = src.trim();
  if (!isLocalAbsolutePath(trimmed) || trimmed.startsWith("/workspace/")) {
    return true;
  }
  return isDirectAgentGeneratedMediaPath(trimmed);
}

function resolveMarkdownMediaKind(
  pathOrName: string
): MarkdownMediaKind | null {
  return resolveMarkdownMediaType(pathOrName)?.kind ?? null;
}

function resolveMarkdownMediaType(
  pathOrName: string
): { kind: MarkdownMediaKind; mimeType: string } | null {
  const imageMimeType = resolveWorkspaceImageMimeType(pathOrName);
  if (imageMimeType) {
    return { kind: "image", mimeType: imageMimeType };
  }
  const videoMimeType = resolveWorkspaceVideoMimeType(pathOrName);
  if (videoMimeType) {
    return { kind: "video", mimeType: videoMimeType };
  }
  return null;
}

function peekCachedMarkdownMediaState(path: string): MarkdownMediaState | null {
  const entry = cachedMarkdownMedia.get(path);
  return entry
    ? { kind: entry.kind, status: "ready", src: entry.objectUrl }
    : null;
}

function retainCachedMarkdownMedia(
  path: string
): { kind: MarkdownMediaKind; src: string } | null {
  const entry = cachedMarkdownMedia.get(path);
  if (!entry) {
    return null;
  }
  entry.refCount += 1;
  if (entry.revokeTimer) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  return { kind: entry.kind, src: entry.objectUrl };
}

function cacheMarkdownMedia(
  path: string,
  kind: MarkdownMediaKind,
  blob: Blob
): string {
  const entry = cachedMarkdownMedia.get(path);
  if (entry) {
    entry.refCount += 1;
    if (entry.revokeTimer) {
      clearTimeout(entry.revokeTimer);
      entry.revokeTimer = null;
    }
    return entry.objectUrl;
  }
  const objectUrl = URL.createObjectURL(blob);
  cachedMarkdownMedia.set(path, {
    kind,
    objectUrl,
    refCount: 1,
    revokeTimer: null
  });
  return objectUrl;
}

function releaseCachedMarkdownMedia(path: string, objectUrl: string): void {
  const entry = cachedMarkdownMedia.get(path);
  if (!entry || entry.objectUrl !== objectUrl) {
    URL.revokeObjectURL(objectUrl);
    return;
  }
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0 || entry.revokeTimer) {
    return;
  }
  entry.revokeTimer = setTimeout(() => {
    const current = cachedMarkdownMedia.get(path);
    if (!current || current.objectUrl !== objectUrl || current.refCount > 0) {
      return;
    }
    cachedMarkdownMedia.delete(path);
    URL.revokeObjectURL(objectUrl);
  }, CACHED_MARKDOWN_MEDIA_REVOKE_DELAY_MS);
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

  return content;
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
  return isRichTextMentionHref(trimmed.slice(labelEnd + 2));
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
    if (!userLabel) {
      continue;
    }

    return content;
  }

  return content;
}

function markdownUrlTransform(value: string): string {
  const target = value.trim();
  return isRichTextMentionHref(target) ||
    isExplicitWorkspaceFilePath(target) ||
    isStandardMarkdownLinkHref(target)
    ? target
    : defaultUrlTransform(value);
}

type MentionKind =
  | "session"
  | "workspace-app"
  | "workspace-reference"
  | "workspace-app-factory"
  | "workspace-issue";

interface ParsedMentionLink {
  appId?: string;
  kind: MentionKind;
  label: string;
  iconUrl?: string;
  participant: string;
  referenceSource?: string;
  summary: string;
  /** 引用文件数量(workspace-reference 专用,来自 href 的 count 参数)。 */
  fileCount?: number;
}

function parseMentionLink(
  href: string,
  rawLabel: string,
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[] = [],
  appFactoryFallbackLabel = "Create app"
): ParsedMentionLink | null {
  const mention = parseRichTextMentionHref(href, rawLabel);
  if (!mention) {
    return null;
  }
  const resource = mention.providerId.trim().toLowerCase();
  const kind =
    resource === "agent-session"
      ? "session"
      : resource === "workspace-app"
        ? "workspace-app"
        : resource === "workspace-reference"
          ? "workspace-reference"
          : resource === "workspace-app-factory"
            ? "workspace-app-factory"
            : resource === "workspace-issue"
              ? "workspace-issue"
              : resource;
  if (
    kind !== "session" &&
    kind !== "workspace-app" &&
    kind !== "workspace-reference" &&
    kind !== "workspace-app-factory" &&
    kind !== "workspace-issue"
  ) {
    return null;
  }
  const entityId = mention.entityId.trim();
  if (!entityId) {
    return null;
  }
  const label =
    rawLabel.trim().replace(/^@+/, "").trim() ||
    (kind === "workspace-app-factory" ? appFactoryFallbackLabel : "");
  if (kind === "workspace-app" || kind === "workspace-app-factory") {
    const appId = kind === "workspace-app" ? entityId : "";
    const workspaceId = mention.scope?.workspaceId?.trim() || "";
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
  if (kind === "workspace-reference") {
    const source = mention.scope?.source?.trim() ?? "";
    const workspaceId = mention.scope?.workspaceId?.trim() || "";
    const appIconUrl =
      source === "app"
        ? resolveWorkspaceAppMentionIconUrl({
            appId: entityId,
            workspaceAppIcons,
            workspaceId
          })
        : undefined;
    return {
      kind,
      label,
      iconUrl: mention.scope?.icon?.trim() || appIconUrl,
      fileCount: referenceFileCountFromParam(mention.scope?.count ?? null),
      participant: label,
      referenceSource: source || undefined,
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

function referenceFileCountFromParam(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
