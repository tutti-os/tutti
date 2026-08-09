import {
  type AgentActivityInteraction,
  type AgentActivitySessionSettings
} from "@tutti-os/agent-activity-core";
import { resolveAgentConversationNavigationAction } from "@tutti-os/agent-gui/conversation-projection";
import { createAgentConversationFollowEndController } from "@tutti-os/agent-gui/agent-conversation/follow-end";
import {
  NativeButton,
  NativeControlGlyph,
  NativeIconButton,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { MobileComposerDock } from "../components/MobileComposerDock";
import { MobileConversationInteractionDock } from "../components/MobileConversationInteractionDock";
import { MobileConversationTimeline } from "../components/MobileConversationTimeline";
import {
  MobileKeyboardAvoidingView,
  mobileKeyboardDismissMode
} from "../components/MobileKeyboardAvoidingView";
import {
  MobileComputerGlyph,
  MobileFolderGlyph
} from "../components/MobileLocationGlyphs";
import { t } from "../i18n";
import type { WorkspaceActivitySnapshot } from "../services/workspaceActivityService";
import type { WorkspaceMediaSnapshot } from "../services/workspaceMediaService";
import type { MobileQuickPromptLibrarySnapshot } from "../services/mobileQuickPromptLibraryService";
import {
  conversationDistanceFromBottom,
  initialConversationScrollGeometry,
  updateConversationScrollGeometry
} from "./conversationScrollGeometry";
import { createConversationScrollScheduler } from "./conversationScrollScheduler";

export function ConversationScreenView({
  deviceName,
  media,
  model,
  onBack,
  onDraftChange,
  onLoadOlder,
  onRefreshQuickPrompts,
  onRespond,
  onOpenSession,
  onSelectProject,
  onSelectTarget,
  onSend,
  onStop,
  onUpdateComposerSettings,
  quickPromptLibrary,
  workspaceId,
  workspaceName
}: {
  deviceName: string;
  model: WorkspaceActivitySnapshot;
  media: WorkspaceMediaSnapshot;
  onBack(): void;
  onDraftChange(value: string): void;
  onLoadOlder(): void;
  onRefreshQuickPrompts(): Promise<void>;
  onRespond(
    interaction: AgentActivityInteraction,
    input: {
      action?: string;
      optionId?: string;
      payload?: Readonly<Record<string, unknown>>;
    }
  ): void;
  onOpenSession(id: string): void;
  onSelectProject(path: string | null): void;
  onSelectTarget(id: string): void;
  onSend(): void;
  onStop(): void;
  onUpdateComposerSettings(settings: AgentActivitySessionSettings): void;
  quickPromptLibrary: MobileQuickPromptLibrarySnapshot;
  workspaceId: string;
  workspaceName: string;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const followEndControllerRef = useRef(
    createAgentConversationFollowEndController()
  );
  const followEndController = followEndControllerRef.current;
  const scrollGeometry = useRef(initialConversationScrollGeometry);
  const scrollScheduler = useRef<
    ReturnType<typeof createConversationScrollScheduler> | undefined
  >(undefined);
  if (!scrollScheduler.current) {
    scrollScheduler.current = createConversationScrollScheduler({
      getFollowState: () => followEndControllerRef.current.getSnapshot(),
      onScrollToEnd: (animated) => scroll.current?.scrollToEnd({ animated })
    });
  }
  const window = model.selectedAgentSessionId
    ? model.activity.sessionMessageWindowsById?.[model.selectedAgentSessionId]
    : null;

  const scheduleScrollToBottom = useCallback(
    (animated: boolean, intent: "auto-follow" | "requested") => {
      scrollScheduler.current?.schedule(animated, intent);
    },
    []
  );

  useEffect(() => {
    followEndController.dispatch("conversation-changed");
    scrollGeometry.current = updateConversationScrollGeometry(
      scrollGeometry.current,
      { type: "conversation-changed" }
    );
    setShowScrollToBottom(false);
    scheduleScrollToBottom(false, "auto-follow");
    return () => scrollScheduler.current?.cancel();
  }, [
    followEndController,
    model.selectedAgentSessionId,
    scheduleScrollToBottom
  ]);

  const scrollToBottom = (animated: boolean) => {
    followEndController.dispatch("scroll-to-end-requested");
    setShowScrollToBottom(false);
    scheduleScrollToBottom(animated, "requested");
  };
  const openConversationLink = (href: string): boolean => {
    if (!model.conversation) return false;
    const action = resolveAgentConversationNavigationAction({
      href,
      source: "agent-markdown"
    });
    if (!action) return false;
    if (action.type === "open-url") {
      void Linking.openURL(action.url).catch(() => undefined);
      return true;
    }
    if (
      action.type === "open-agent-session" &&
      action.workspaceId === workspaceId
    ) {
      onOpenSession(action.agentSessionId);
      return true;
    }
    return true;
  };

  return (
    <MobileKeyboardAvoidingView style={styles.root}>
      <View style={styles.conversationHeader}>
        <View style={styles.headerContent}>
          <NativeIconButton
            accessibilityLabel={t("sessions")}
            onPress={onBack}
            icon={
              <NativeControlGlyph
                color={theme.color.text}
                size={20}
                variant="back"
              />
            }
            style={styles.headerCircleButton}
            variant="ghost"
          />
          <View style={styles.conversationTitle}>
            <Text numberOfLines={1} style={styles.sessionTitle}>
              {model.creating
                ? t("newSession")
                : model.selectedSession?.title || workspaceName}
            </Text>
            <View style={styles.locationRow}>
              <View style={styles.locationItem}>
                <MobileFolderGlyph
                  color={theme.color.textSecondary}
                  size={14}
                />
                <Text numberOfLines={1} style={styles.locationLabel}>
                  {workspaceName}
                </Text>
              </View>
              <View style={styles.locationItem}>
                <MobileComputerGlyph
                  color={theme.color.textSecondary}
                  size={14}
                />
                <Text numberOfLines={1} style={styles.locationLabel}>
                  {deviceName || t("desktopFallback")}
                </Text>
              </View>
            </View>
          </View>
        </View>
      </View>

      {model.loading ? (
        <View
          accessibilityLabel={t("loading")}
          accessibilityLiveRegion="polite"
          style={styles.loadingSkeleton}
        >
          <View style={styles.loadingColumn}>
            <View style={[styles.skeletonBlock, styles.skeletonShort]} />
            <View style={[styles.skeletonBlock, styles.skeletonLong]} />
          </View>
        </View>
      ) : model.selectedSession && !model.creating ? (
        <View style={styles.conversationBody}>
          <ScrollView
            contentContainerStyle={styles.messageList}
            keyboardDismissMode={mobileKeyboardDismissMode}
            keyboardShouldPersistTaps="handled"
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onContentSizeChange={(_width, height) => {
              scrollGeometry.current = updateConversationScrollGeometry(
                scrollGeometry.current,
                { height, type: "content-size-changed" }
              );
              if (followEndController.getSnapshot() === "following") {
                scheduleScrollToBottom(false, "auto-follow");
              }
            }}
            onLayout={({ nativeEvent }) => {
              scrollGeometry.current = updateConversationScrollGeometry(
                scrollGeometry.current,
                {
                  height: nativeEvent.layout.height,
                  type: "layout-changed"
                }
              );
              if (followEndController.getSnapshot() === "following") {
                scheduleScrollToBottom(false, "auto-follow");
              }
            }}
            onScrollBeginDrag={() => {
              scrollScheduler.current?.cancel();
              followEndController.dispatch("user-scrolled-away");
              setShowScrollToBottom(true);
            }}
            onScroll={({ nativeEvent }) => {
              if (
                nativeEvent.contentOffset.y < 48 &&
                window?.hasOlderMessages
              ) {
                onLoadOlder();
              }
              const distanceFromBottom =
                nativeEvent.contentSize.height -
                nativeEvent.layoutMeasurement.height -
                nativeEvent.contentOffset.y;
              const scrollingTowardEnd =
                nativeEvent.contentOffset.y > scrollGeometry.current.offsetY;
              scrollGeometry.current = updateConversationScrollGeometry(
                scrollGeometry.current,
                {
                  contentHeight: nativeEvent.contentSize.height,
                  offsetY: nativeEvent.contentOffset.y,
                  type: "scrolled",
                  viewportHeight: nativeEvent.layoutMeasurement.height
                }
              );
              if (
                followEndController.getSnapshot() === "detached" &&
                scrollingTowardEnd &&
                distanceFromBottom <= 1
              ) {
                followEndController.dispatch("user-reached-end");
              }
              setShowScrollToBottom(
                followEndController.getSnapshot() === "detached"
              );
            }}
            onTouchStart={() => {
              const distanceFromBottom = conversationDistanceFromBottom(
                scrollGeometry.current
              );
              if (distanceFromBottom > 48) {
                scrollScheduler.current?.cancel();
                followEndController.dispatch("user-scrolled-away");
                setShowScrollToBottom(true);
              }
            }}
            ref={scroll}
            scrollEventThrottle={16}
            style={styles.messageScroller}
          >
            {window?.hasOlderMessages ? (
              <Text style={styles.loadOlder}>{t("loading")}</Text>
            ) : null}
            {!model.conversation || model.conversation.rows.length === 0 ? (
              <Text style={[styles.emptyText, styles.transcriptFrame]}>
                {t("emptyConversation")}
              </Text>
            ) : (
              <MobileConversationTimeline
                conversation={model.conversation}
                media={media}
                onLinkPress={openConversationLink}
              />
            )}
          </ScrollView>
          {showScrollToBottom ? (
            <NativeButton
              label={t("scrollToBottom")}
              onPress={() => scrollToBottom(true)}
              size="regular"
              style={styles.scrollToBottom}
              variant="secondary"
            />
          ) : null}
        </View>
      ) : model.creating ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>{t("newSessionHint")}</Text>
        </View>
      ) : (
        <View style={styles.center}>
          <Text style={styles.emptyText}>{t("emptySessions")}</Text>
        </View>
      )}

      {model.errorCode ? (
        <Text style={styles.inlineError}>{t("genericError")}</Text>
      ) : null}
      <MobileConversationInteractionDock
        interactionStates={model.interactionStates}
        interactions={model.pendingInteractions}
        onRespond={onRespond}
      />
      {model.selectedSession || model.creating ? (
        <MobileComposerDock
          model={model}
          quickPromptLibrary={quickPromptLibrary}
          onDraftChange={onDraftChange}
          onRefreshQuickPrompts={onRefreshQuickPrompts}
          onSelectProject={onSelectProject}
          onSelectTarget={onSelectTarget}
          onSend={onSend}
          onStop={onStop}
          onUpdate={onUpdateComposerSettings}
        />
      ) : null}
    </MobileKeyboardAvoidingView>
  );
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    center: {
      alignItems: "center",
      flex: 1,
      gap: theme.space.medium,
      justifyContent: "center",
      padding: theme.space.large
    },
    conversationHeader: {
      alignItems: "center",
      backgroundColor: theme.color.background,
      borderBottomColor: theme.color.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: theme.space.small,
      paddingVertical: theme.space.small / 2
    },
    headerContent: {
      alignItems: "center",
      alignSelf: "center",
      flexDirection: "row",
      gap: theme.space.small,
      maxWidth: 760,
      width: "100%"
    },
    conversationBody: { flex: 1, minHeight: 0, position: "relative" },
    conversationTitle: {
      alignItems: "flex-start",
      flex: 1,
      justifyContent: "center",
      minWidth: 0,
      paddingRight: theme.space.small
    },
    emptyText: {
      color: theme.color.textSecondary,
      fontSize: 15,
      lineHeight: 22,
      textAlign: "center"
    },
    headerCircleButton: {
      alignItems: "center",
      borderRadius: theme.control.regular / 2,
      flexShrink: 0,
      height: theme.control.regular,
      justifyContent: "center",
      width: theme.control.regular
    },
    inlineError: {
      backgroundColor: theme.color.panel,
      color: theme.color.danger,
      fontSize: 12,
      padding: theme.space.small,
      textAlign: "center"
    },
    loadOlder: {
      alignSelf: "center",
      color: theme.color.muted,
      fontSize: 12,
      maxWidth: 760,
      paddingVertical: theme.space.small,
      textAlign: "center",
      width: "100%"
    },
    loadingColumn: {
      alignSelf: "center",
      gap: theme.space.medium,
      maxWidth: 760,
      width: "100%"
    },
    loadingSkeleton: {
      flex: 1,
      paddingHorizontal: theme.space.medium,
      paddingTop: theme.space.xlarge
    },
    locationLabel: {
      color: theme.color.textSecondary,
      flexShrink: 1,
      fontSize: 12,
      lineHeight: 16
    },
    locationItem: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 1,
      gap: 4,
      minWidth: 0
    },
    locationRow: {
      flexDirection: "row",
      gap: theme.space.small,
      marginTop: 2,
      overflow: "hidden"
    },
    messageList: {
      gap: theme.space.small,
      paddingBottom: theme.space.xlarge,
      paddingHorizontal: theme.space.medium,
      paddingTop: theme.space.medium
    },
    messageScroller: { flex: 1 },
    root: { backgroundColor: theme.color.background, flex: 1 },
    scrollToBottom: {
      bottom: theme.space.medium,
      borderRadius: theme.control.regular / 2,
      position: "absolute",
      right: theme.space.medium
    },
    skeletonBlock: {
      backgroundColor: theme.color.panel,
      borderRadius: theme.radius.large
    },
    skeletonLong: { height: 96 },
    skeletonShort: {
      alignSelf: "flex-end",
      height: 64,
      width: "78%"
    },
    sessionTitle: {
      color: theme.color.text,
      fontSize: 17,
      fontWeight: "700",
      lineHeight: 22,
      textAlign: "left"
    },
    transcriptFrame: {
      alignSelf: "center",
      maxWidth: 760,
      width: "100%"
    }
  });
}
