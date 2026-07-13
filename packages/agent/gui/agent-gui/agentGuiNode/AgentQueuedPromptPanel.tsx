import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import { ChevronRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@tutti-os/ui-system";
import {
  AgentMessageMarkdown,
  type AgentMessageMarkdownWorkspaceAppIcon
} from "../../shared/AgentMessageMarkdown";
import { useOptionalAgentActivityRuntime } from "../../agentActivityRuntime";
import type { AgentPromptContentBlock } from "../../shared/contracts/dto/agentSession";
import type { AgentGUIQueuedPromptVM } from "./model/agentGuiNodeTypes";
import {
  agentPromptContentDisplayText,
  agentPromptContentImageBlocks
} from "./model/agentComposerDraft";
import { ZoomableImage } from "../../app/renderer/components/ZoomableImage";
import { CanvasNodeGhostIconButton } from "../shared/CanvasNodeGhostIconButton";
import {
  CanvasNodeGuideLinedIcon,
  CanvasNodeMoreLinedIcon,
  CanvasNodeTrashLinedIcon
} from "../shared/canvasNodeChromeIcons";
import styles from "./AgentGUINode.styles";

const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];

type QueuedPromptImageBlock = AgentPromptContentBlock & {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  attachmentId?: string;
  data?: string;
  url?: string;
  path?: string;
};

interface AgentQueuedPromptPanelProps {
  queuedPrompts: readonly AgentGUIQueuedPromptVM[];
  drainingQueuedPromptId: string | null;
  labels: {
    queuedLabel: string;
    sendQueuedPromptNext: string;
    editQueuedPrompt: string;
    deleteQueuedPrompt: string;
    queuedPromptMoreActions: string;
  };
  onSendQueuedPromptNext: (queuedPromptId: string) => void;
  onRemoveQueuedPrompt: (queuedPromptId: string) => void;
  onEditQueuedPrompt: (queuedPromptId: string) => void;
  agentSessionId?: string | null;
  onLinkClick?: (href: string) => void;
  workspaceId?: string | null;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}

function queuedPromptImages(
  queuedPrompt: AgentGUIQueuedPromptVM
): QueuedPromptImageBlock[] {
  return agentPromptContentImageBlocks(queuedPrompt.content);
}

function queuedPromptImageDataUrl(
  image: QueuedPromptImageBlock
): string | null {
  const data = image.data?.trim() ?? "";
  const mimeType = image.mimeType.trim();
  if (!data || !mimeType) {
    return null;
  }
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

function queuedPromptImageHasSafeRemoteUrl(
  image: QueuedPromptImageBlock
): boolean {
  const value = image.url?.trim() ?? "";
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function queuedPromptImageImmediateSource(
  image: QueuedPromptImageBlock
): string | null {
  return queuedPromptImageDataUrl(image);
}

function queuedPromptImageKey(
  queuedPrompt: AgentGUIQueuedPromptVM,
  image: QueuedPromptImageBlock,
  index: number
): string {
  return [
    queuedPrompt.id,
    index,
    image.attachmentId?.trim() ?? "",
    image.path?.trim() ?? "",
    image.name?.trim() ?? "",
    image.mimeType
  ].join(":");
}

function AgentQueuedPromptImage({
  agentSessionId,
  image,
  imageKey,
  workspaceId
}: {
  agentSessionId?: string | null;
  image: QueuedPromptImageBlock;
  imageKey: string;
  workspaceId?: string | null;
}): React.JSX.Element | null {
  const runtime = useOptionalAgentActivityRuntime();
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const loadingKeyRef = useRef<string | null>(null);
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  const normalizedAgentSessionId = agentSessionId?.trim() ?? "";
  const attachmentId = image.attachmentId?.trim() ?? "";
  const path = image.path?.trim() ?? "";
  const source = queuedPromptImageImmediateSource(image) ?? loadedSource;

  if (source) {
    return (
      <ZoomableImage
        alt={image.name?.trim() || ""}
        className={styles.composerQueuedPromptImage}
        draggable={false}
        src={source}
        wrapElement="span"
      />
    );
  }
  if (
    !normalizedWorkspaceId ||
    (!attachmentId && !path) ||
    queuedPromptImageHasSafeRemoteUrl(image) ||
    (!runtime?.readSessionAttachment && !runtime?.readPromptAsset)
  ) {
    return null;
  }

  const loadSource = (element: HTMLSpanElement | null): void => {
    if (!element || loadingKeyRef.current === imageKey) {
      return;
    }
    loadingKeyRef.current = imageKey;
    const readAsset = async (): Promise<
      { data: string; mimeType: string } | undefined
    > => {
      if (attachmentId) {
        return await runtime.readSessionAttachment?.({
          workspaceId: normalizedWorkspaceId,
          agentSessionId: normalizedAgentSessionId,
          attachmentId
        });
      }
      return await runtime.readPromptAsset?.({
        workspaceId: normalizedWorkspaceId,
        agentSessionId: normalizedAgentSessionId,
        mimeType: image.mimeType,
        name: image.name,
        path
      });
    };
    void readAsset()
      .then((asset) => {
        if (!asset || !element.isConnected) {
          return;
        }
        setLoadedSource(`data:${asset.mimeType};base64,${asset.data}`);
      })
      .catch((error: unknown) => {
        console.warn(
          "[agent-gui]",
          JSON.stringify({
            event: "agent.gui.queued_prompt_image_load_failed",
            level: "warn",
            source: "agent-gui",
            workspaceId: normalizedWorkspaceId,
            details: {
              agentSessionId: normalizedAgentSessionId || null,
              attachmentId: attachmentId || null,
              path: path || null,
              error: error instanceof Error ? error.message : String(error)
            }
          })
        );
      });
  };

  return <span ref={loadSource} hidden />;
}

/**
 * Text shown for a queued prompt. Falls back to the display prompt so a
 * pasted-text-only queue entry (whose content is a structured pasted-text file
 * block with no text) still renders its reference instead of appearing blank.
 */
function queuedPromptDisplayText(queuedPrompt: AgentGUIQueuedPromptVM): string {
  const prompt = agentPromptContentDisplayText(queuedPrompt.content);
  if (prompt) {
    return prompt;
  }
  return queuedPrompt.displayPrompt?.trim() ?? "";
}

function queuedPromptTitle(queuedPrompt: AgentGUIQueuedPromptVM): string {
  const prompt = queuedPromptDisplayText(queuedPrompt);
  if (prompt) {
    return prompt;
  }
  return queuedPromptImages(queuedPrompt)
    .map((image) => image.name?.trim() ?? "")
    .filter(Boolean)
    .join(", ");
}

export function AgentQueuedPromptPanel({
  queuedPrompts,
  drainingQueuedPromptId,
  labels,
  onSendQueuedPromptNext,
  onRemoveQueuedPrompt,
  onEditQueuedPrompt,
  agentSessionId = null,
  onLinkClick,
  workspaceId = null,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS
}: AgentQueuedPromptPanelProps): React.JSX.Element {
  "use memo";
  const [isExpanded, setIsExpanded] = useState(false);
  const singlePromptTextRef = useRef<HTMLDivElement | null>(null);
  const queuedPromptListRef = useRef<HTMLDivElement | null>(null);
  const pointerHandledEditPromptIdRef = useRef<string | null>(null);
  const [isSinglePromptOverflowing, setIsSinglePromptOverflowing] =
    useState(false);
  const [expandedListMaxHeightPx, setExpandedListMaxHeightPx] = useState(280);
  const singlePromptHasImages =
    queuedPrompts.length === 1 &&
    queuedPromptImages(queuedPrompts[0]!).length > 0;
  const canExpand =
    queuedPrompts.length > 1 ||
    singlePromptHasImages ||
    isSinglePromptOverflowing;
  const panelStyle = {
    "--agent-gui-queued-prompt-expanded-height": `${expandedListMaxHeightPx}px`
  } as CSSProperties &
    Record<"--agent-gui-queued-prompt-expanded-height", string>;
  const toggleExpanded = (): void => {
    if (!canExpand) {
      return;
    }
    setIsExpanded((current) => !current);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!canExpand) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    toggleExpanded();
  };
  const editQueuedPrompt = (queuedPromptId: string): void => {
    pointerHandledEditPromptIdRef.current = null;
    onEditQueuedPrompt(queuedPromptId);
  };
  const handleEditQueuedPromptPointerDown = (
    event: PointerEvent,
    queuedPromptId: string
  ): void => {
    if (event.button !== 0 || event.ctrlKey) {
      return;
    }
    pointerHandledEditPromptIdRef.current = queuedPromptId;
    onEditQueuedPrompt(queuedPromptId);
  };
  const handleEditQueuedPromptSelect = (queuedPromptId: string): void => {
    if (pointerHandledEditPromptIdRef.current === queuedPromptId) {
      pointerHandledEditPromptIdRef.current = null;
      return;
    }
    editQueuedPrompt(queuedPromptId);
  };

  useLayoutEffect(() => {
    if (queuedPrompts.length !== 1) {
      setIsSinglePromptOverflowing(false);
      return;
    }

    const element = singlePromptTextRef.current;
    if (!element) {
      setIsSinglePromptOverflowing(false);
      return;
    }

    const measure = (): void => {
      setIsSinglePromptOverflowing(
        element.scrollWidth > element.clientWidth + 1
      );
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(element);
    return () => {
      resizeObserver?.disconnect();
    };
  }, [queuedPrompts]);

  useLayoutEffect(() => {
    if (!canExpand && isExpanded) {
      setIsExpanded(false);
    }
  }, [canExpand, isExpanded]);

  useLayoutEffect(() => {
    const element = queuedPromptListRef.current;
    if (!element) {
      return;
    }

    const measure = (): void => {
      const viewportCap =
        typeof window === "undefined"
          ? 280
          : Math.round(window.innerHeight * 0.38);
      setExpandedListMaxHeightPx(Math.max(32, Math.min(280, viewportCap)));
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [queuedPrompts]);

  return (
    <div
      className={styles.composerQueuedPromptPanel}
      data-expanded={isExpanded ? "true" : "false"}
      data-expandable={canExpand ? "true" : "false"}
      style={panelStyle}
      tabIndex={canExpand ? 0 : -1}
      onClick={toggleExpanded}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.composerQueuedPromptHeader}>
        <span className={styles.composerQueuedPromptLabel}>
          {labels.queuedLabel}
        </span>
        <span className={styles.composerQueuedPromptCount}>
          {queuedPrompts.length}
        </span>
        {canExpand ? (
          <ChevronRight
            aria-hidden="true"
            className={styles.composerQueuedPromptExpandCue}
            data-testid="agent-gui-composer-queued-prompt-expand-cue"
            size={16}
            strokeWidth={2}
          />
        ) : null}
      </div>
      <div
        ref={queuedPromptListRef}
        className={styles.composerQueuedPromptList}
      >
        {queuedPrompts.map((queuedPrompt) => {
          const isDraining = queuedPrompt.id === drainingQueuedPromptId;
          const images = queuedPromptImages(queuedPrompt);
          const displayText = queuedPromptDisplayText(queuedPrompt);
          const title = queuedPromptTitle(queuedPrompt);
          return (
            <div
              key={queuedPrompt.id}
              className={styles.composerQueuedPromptRow}
              data-testid={`agent-gui-composer-queued-prompt-${queuedPrompt.id}`}
              data-draining={isDraining ? "true" : "false"}
            >
              <div className={styles.composerQueuedPromptMain}>
                <div className={styles.composerQueuedPromptBody} title={title}>
                  {displayText ? (
                    <div
                      ref={
                        queuedPrompts.length === 1
                          ? singlePromptTextRef
                          : undefined
                      }
                      className={styles.composerQueuedPromptText}
                      onClick={(event) => {
                        if (
                          event.target instanceof Element &&
                          event.target.closest("a")
                        ) {
                          event.stopPropagation();
                        }
                      }}
                    >
                      <AgentMessageMarkdown
                        content={displayText}
                        className="agent-gui-node__composer-queued-prompt-markdown"
                        inline
                        onLinkClick={onLinkClick}
                        workspaceAppIcons={workspaceAppIcons}
                      />
                    </div>
                  ) : null}
                  {images.length > 0 ? (
                    <div className={styles.composerQueuedPromptImages}>
                      {images.slice(0, 3).map((image, index) => {
                        const imageKey = queuedPromptImageKey(
                          queuedPrompt,
                          image,
                          index
                        );
                        return (
                          <AgentQueuedPromptImage
                            key={imageKey}
                            agentSessionId={agentSessionId}
                            image={image}
                            imageKey={imageKey}
                            workspaceId={workspaceId}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className={styles.composerQueuedPromptActions}>
                <CanvasNodeGhostIconButton
                  aria-label={labels.sendQueuedPromptNext}
                  disabled={isDraining}
                  onClick={() => onSendQueuedPromptNext(queuedPrompt.id)}
                >
                  <CanvasNodeGuideLinedIcon aria-hidden="true" />
                </CanvasNodeGhostIconButton>
                <CanvasNodeGhostIconButton
                  aria-label={labels.deleteQueuedPrompt}
                  disabled={isDraining}
                  onClick={() => onRemoveQueuedPrompt(queuedPrompt.id)}
                >
                  <CanvasNodeTrashLinedIcon aria-hidden="true" />
                </CanvasNodeGhostIconButton>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <CanvasNodeGhostIconButton
                      aria-label={labels.queuedPromptMoreActions}
                      disabled={isDraining}
                      stopsEventPropagation={false}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <CanvasNodeMoreLinedIcon aria-hidden="true" />
                    </CanvasNodeGhostIconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className={styles.composerMenuContent}
                    sideOffset={8}
                  >
                    <DropdownMenuItem
                      className={styles.composerMenuItem}
                      disabled={isDraining}
                      onPointerDown={(event) => {
                        handleEditQueuedPromptPointerDown(
                          event,
                          queuedPrompt.id
                        );
                      }}
                      onSelect={() => {
                        handleEditQueuedPromptSelect(queuedPrompt.id);
                      }}
                    >
                      <span>{labels.editQueuedPrompt}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
