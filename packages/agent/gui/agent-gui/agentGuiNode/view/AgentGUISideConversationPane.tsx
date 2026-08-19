import { useCallback, useRef, useState, type CSSProperties } from "react";
import { MessageCirclePlus } from "lucide-react";
import { PanelIcon } from "@tutti-os/ui-system";
import { ScrollArea } from "@tutti-os/ui-system/components";
import type { AgentSideConversationViewState } from "../../../agentSideConversationViewProjection";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { AgentTranscriptVirtualScrollController } from "../../../shared/agentConversation/components/AgentTranscriptView";
import { AgentComposer, type AgentComposerProps } from "../AgentComposer";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import { AgentGUIConversationTimelinePane } from "./AgentGUIConversationTimelinePane";
import { useTranslation } from "../../../i18n/index";
import styles from "../AgentGUINode.styles";

const SIDE_TIMELINE_CONTENT_STYLE: CSSProperties = {
  width: "100%",
  minWidth: "100%",
  minHeight: "100%",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: "24px"
};

export interface AgentGUISideConversationPaneProps {
  active: AgentSideConversationViewState;
  availableSkills: readonly AgentGUIProviderSkillOption[];
  composerProps: AgentComposerProps;
  conversationFlowLabels: {
    thinkingLabel: string;
    toolCallsLabel: (count: number) => string;
    processing: string;
    turnSummary: string;
    userMessageLocator: string;
  };
  isVisible: boolean;
  loadingLabel: string;
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  onClose(): void;
  onFocusChange(focused: boolean): void;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
}

export function AgentGUISideConversationPane({
  active,
  availableSkills,
  composerProps,
  conversationFlowLabels,
  isVisible,
  loadingLabel,
  workspaceAppIcons,
  onClose,
  onFocusChange,
  onLinkAction
}: AgentGUISideConversationPaneProps): React.JSX.Element {
  const { t } = useTranslation();
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineContentRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollControllerRef =
    useRef<AgentTranscriptVirtualScrollController | null>(null);
  const [followEndMode, setFollowEndMode] = useState<"following" | "detached">(
    "following"
  );
  const [widthPx, setWidthPx] = useState(440);

  const resize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const pane = handle.parentElement;
    const workbench = pane?.parentElement;
    if (!pane || !workbench) return;
    const paneRight = pane.getBoundingClientRect().right;
    const maxWidth = Math.min(
      600,
      Math.max(360, workbench.getBoundingClientRect().width - 320)
    );
    handle.setPointerCapture(event.pointerId);
    const onPointerMove = (moveEvent: PointerEvent) => {
      setWidthPx(
        Math.min(maxWidth, Math.max(360, paneRight - moveEvent.clientX))
      );
    };
    const finish = () => {
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
    };
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }, []);

  return (
    <section
      className={styles.sidePane}
      style={{ "--agent-gui-side-pane-width": `${widthPx}px` } as CSSProperties}
      aria-label={t("agentHost.agentGui.sidePanelTitle")}
      data-testid="agent-gui-side-panel"
      onFocusCapture={() => onFocusChange(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          onFocusChange(false);
        }
      }}
    >
      <div
        className={styles.sideResizeHandle}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("agentHost.agentGui.sideResize")}
        tabIndex={0}
        onPointerDown={resize}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setWidthPx((current) =>
            Math.min(
              600,
              Math.max(360, current + (event.key === "ArrowLeft" ? 24 : -24))
            )
          );
        }}
      />
      <header className={styles.sideHeader}>
        <button
          type="button"
          className={styles.sideCloseButton}
          aria-label={t("agentHost.agentGui.sideCollapse")}
          title={t("agentHost.agentGui.sideCollapse")}
          onClick={onClose}
          disabled={active.status === "closing"}
        >
          <PanelIcon aria-hidden="true" className="size-[18px]" />
        </button>
      </header>
      <ScrollArea
        scrollbarMode="native"
        className={styles.sideTimelineFrame}
        viewportRef={timelineRef}
        viewportContentRef={timelineContentRef}
        viewportTestId="agent-gui-side-timeline"
        viewportClassName={styles.sideTimeline}
        viewportContentStyle={SIDE_TIMELINE_CONTENT_STYLE}
        viewportProps={{
          onScroll: (event) => {
            const viewport = event.currentTarget;
            const distance =
              viewport.scrollHeight -
              viewport.clientHeight -
              viewport.scrollTop;
            setFollowEndMode(distance <= 24 ? "following" : "detached");
          }
        }}
      >
        <AgentGUIConversationTimelinePane
          conversation={active.conversation}
          followEndMode={followEndMode}
          isLoading={false}
          isLoadingOlderMessages={false}
          isVisible={isVisible}
          loadingLabel={loadingLabel}
          empty={
            <div
              className={styles.sideEmptyState}
              data-testid="agent-gui-side-empty-state"
            >
              <MessageCirclePlus
                aria-hidden="true"
                className={styles.sideEmptyStateIcon}
                size={30}
                strokeWidth={1.75}
              />
              <strong className={styles.sideEmptyStateTitle}>
                {t("agentHost.agentGui.sideEmptyTitle")}
              </strong>
              <p className={styles.sideEmptyStateDescription}>
                {t("agentHost.agentGui.sideEmptyDescription")}
              </p>
            </div>
          }
          onLinkAction={onLinkAction}
          availableSkills={availableSkills}
          workspaceAppIcons={workspaceAppIcons}
          labels={conversationFlowLabels}
          virtualScrollControllerRef={virtualScrollControllerRef}
        />
        {active.error ? (
          <p className={styles.sideError}>
            {active.error === "content_unsupported"
              ? t("agentHost.agentGui.sideContentUnsupported")
              : t("agentHost.agentGui.sideOperationFailed")}
          </p>
        ) : null}
      </ScrollArea>
      <div className={styles.sideComposer}>
        <AgentComposer {...composerProps} />
      </div>
    </section>
  );
}
