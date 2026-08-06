import { useRef, useState } from "react";
import {
  NativeButton,
  NativeIconButton,
  NativeListRow,
  NativeSheet,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { t } from "../i18n";
import type { MobileConnectionSnapshot } from "../services/mobileApplicationService";
import type { DeviceLinkPathScope } from "../services/mobileDomain";
import type { WorkspaceActivitySnapshot } from "../services/workspaceActivityService";
import {
  MobileKeyboardAvoidingView,
  mobileKeyboardDismissMode
} from "./MobileKeyboardAvoidingView";
import { MobileFolderGlyph } from "./MobileLocationGlyphs";

type ConversationDialog =
  | { kind: "actions"; sessionId: string }
  | { kind: "delete"; sessionId: string }
  | { kind: "rename"; sessionId: string }
  | null;

type LatencyState = "idle" | "measuring" | "done";

export function MobileConversationsView({
  connectionPhase,
  deviceName,
  model,
  onBack,
  onDeleteSession,
  onLoadMoreSessions,
  onMeasureLatency,
  onNewSession,
  onRenameSession,
  onRefreshSessions,
  onSelectSession,
  onTogglePinned,
  pathScope,
  workspaceName
}: {
  connectionPhase: MobileConnectionSnapshot["phase"];
  deviceName: string;
  model: WorkspaceActivitySnapshot;
  onBack(): void;
  onDeleteSession(id: string): Promise<void>;
  onLoadMoreSessions(sectionId: string): void;
  onMeasureLatency(): Promise<number | null>;
  onNewSession(): void;
  onRenameSession(id: string, title: string): Promise<void>;
  onRefreshSessions(): Promise<void>;
  onSelectSession(id: string): void;
  onTogglePinned(id: string): Promise<void>;
  pathScope: DeviceLinkPathScope | null;
  workspaceName: string;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [dialog, setDialog] = useState<ConversationDialog>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(
    () => new Set()
  );
  const [refreshing, setRefreshing] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [connectionInfoOpen, setConnectionInfoOpen] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [latencyState, setLatencyState] = useState<LatencyState>("idle");
  const lastStatusTapAtRef = useRef(0);
  const searchQuery = searchDraft.trim().toLocaleLowerCase();
  const actionSession = dialog
    ? model.railSections
        .flatMap((section) => section.items)
        .find((session) => session.id === dialog.sessionId)
    : null;

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (actionPending) return;
    setActionPending(true);
    try {
      await action();
      setDialog(null);
    } finally {
      setActionPending(false);
    }
  };

  const toggleSection = (sectionId: string): void => {
    setCollapsedSectionIds((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  };

  const refreshRail = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshSessions();
    } finally {
      setRefreshing(false);
    }
  };

  const openConnectionInfo = (): void => {
    setConnectionInfoOpen(true);
    setLatencyState("measuring");
    setLatencyMs(null);
    void onMeasureLatency().then((ms) => {
      setLatencyMs(ms);
      setLatencyState("done");
    });
  };

  const handleStatusPress = (): void => {
    const now = Date.now();
    if (now - lastStatusTapAtRef.current < 350) {
      lastStatusTapAtRef.current = 0;
      openConnectionInfo();
      return;
    }
    lastStatusTapAtRef.current = now;
  };

  return (
    <MobileKeyboardAvoidingView style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerButtonSlot}>
          <NativeIconButton
            accessibilityLabel={t("backToDevices")}
            icon={<Text style={styles.backIcon}>←</Text>}
            onPress={onBack}
            style={styles.headerButton}
            variant="secondary"
          />
        </View>
        <Text numberOfLines={1} style={styles.title}>
          {deviceName || t("desktopFallback")}
        </Text>
        <View style={styles.headerButtonSlot}>
          <Pressable
            accessibilityLabel={t("connectionInfo")}
            accessibilityRole="button"
            onPress={handleStatusPress}
            style={({ pressed }) => [
              styles.statusButton,
              pressed && styles.pressed
            ]}
          >
            <View
              style={[
                styles.statusDot,
                connectionPhase === "connected"
                  ? styles.statusDotConnected
                  : connectionPhase === "failed"
                    ? styles.statusDotFailed
                    : styles.statusDotPending
              ]}
            />
          </Pressable>
        </View>
      </View>

      <View style={styles.projectSection}>
        <Text style={styles.groupTitle}>{t("projects")}</Text>
        <View style={styles.projectRow}>
          <MobileFolderGlyph color={theme.color.text} size={18} />
          <Text numberOfLines={1} style={styles.projectName}>
            {workspaceName}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        keyboardDismissMode={mobileKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            onRefresh={() => void refreshRail()}
            refreshing={refreshing}
            tintColor={theme.color.textSecondary}
          />
        }
        style={styles.sessionScroller}
      >
        {model.railStatus === "loading" && model.railSections.length === 0 ? (
          <View style={styles.feedback}>
            <ActivityIndicator color={theme.color.accent} size="small" />
          </View>
        ) : model.railErrorCode && model.railSections.length === 0 ? (
          <View style={styles.feedback}>
            <Text style={styles.feedbackText}>{t("genericError")}</Text>
            <NativeButton
              label={t("retry")}
              onPress={() => void refreshRail()}
              size="compact"
              variant="ghost"
            />
          </View>
        ) : model.railSections.length === 0 ? (
          <Text style={styles.empty}>{t("emptySessions")}</Text>
        ) : (
          <>
            {model.railErrorCode ? (
              <View style={styles.inlineError}>
                <Text style={styles.inlineErrorText}>{t("genericError")}</Text>
                <NativeButton
                  label={t("retry")}
                  onPress={() => void refreshRail()}
                  size="compact"
                  variant="ghost"
                />
              </View>
            ) : null}
            {model.railSections.map((section) => {
              const collapsed = collapsedSectionIds.has(section.id);
              const effectiveCollapsed = collapsed && !searchQuery;
              const visibleItems = searchQuery
                ? section.items.filter((session) =>
                    (session.title || t("untitledSession"))
                      .toLocaleLowerCase()
                      .includes(searchQuery)
                  )
                : section.items;
              if (searchQuery && !visibleItems.length && !section.hasMore)
                return null;
              return (
                <View key={section.id} style={styles.section}>
                  <Pressable
                    accessibilityLabel={
                      effectiveCollapsed
                        ? t("expandSection")
                        : t("collapseSection")
                    }
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled: Boolean(searchQuery),
                      expanded: !effectiveCollapsed
                    }}
                    disabled={Boolean(searchQuery)}
                    onPress={() => toggleSection(section.id)}
                    style={({ pressed }) => pressed && styles.pressed}
                  >
                    <View style={styles.sectionHeader}>
                      <Text numberOfLines={1} style={styles.sectionTitle}>
                        {sectionTitle(section)}
                      </Text>
                      <Text style={styles.sectionCount}>
                        {section.totalCount}
                      </Text>
                      <Text style={styles.sectionChevron}>
                        {effectiveCollapsed ? "›" : "⌄"}
                      </Text>
                    </View>
                  </Pressable>
                  {!effectiveCollapsed
                    ? visibleItems.map((session) => {
                        const selected =
                          session.id === model.selectedAgentSessionId;
                        return (
                          <NativeListRow
                            accessibilityLabel={
                              session.title || t("untitledSession")
                            }
                            key={session.id}
                            onPress={() => {
                              onSelectSession(session.id);
                            }}
                            selected={selected}
                            title={session.title || t("untitledSession")}
                            trailing={
                              <View style={styles.sessionTrailing}>
                                <Text style={styles.sessionTime}>
                                  {formatSessionTime(
                                    session.sortTimeUnixMs ??
                                      session.updatedAtUnixMs
                                  )}
                                </Text>
                                <NativeIconButton
                                  accessibilityLabel={t("moreActions")}
                                  icon={<Text style={styles.moreIcon}>⋯</Text>}
                                  onPress={(event) => {
                                    event.stopPropagation();
                                    setDialog({
                                      kind: "actions",
                                      sessionId: session.id
                                    });
                                  }}
                                  style={styles.moreButton}
                                />
                              </View>
                            }
                          />
                        );
                      })
                    : null}
                  {!effectiveCollapsed && section.hasMore ? (
                    <Pressable
                      disabled={section.loadingMore}
                      onPress={() => onLoadMoreSessions(section.id)}
                      style={({ pressed }) => [
                        styles.loadMoreButton,
                        pressed && styles.pressed
                      ]}
                    >
                      {section.loadingMore ? (
                        <ActivityIndicator
                          color={theme.color.accent}
                          size="small"
                        />
                      ) : (
                        <Text style={styles.loadMoreLabel}>
                          {t("loadMoreSessions")}
                        </Text>
                      )}
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>

      <View style={styles.bottomDock}>
        <View style={styles.searchPill}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            onChangeText={setSearchDraft}
            placeholder={t("searchChats")}
            placeholderTextColor={theme.color.muted}
            style={styles.searchInput}
            value={searchDraft}
          />
        </View>
        <View style={styles.chatButtonSlot}>
          <NativeButton
            disabled={model.targets.length === 0}
            label={t("chat")}
            leading={<Text style={styles.chatIcon}>＋</Text>}
            onPress={() => {
              onNewSession();
            }}
            size="large"
            style={styles.chatButton}
          />
        </View>
      </View>
      <Modal
        animationType="fade"
        onRequestClose={() => setConnectionInfoOpen(false)}
        transparent
        visible={connectionInfoOpen}
      >
        <Pressable
          onPress={() => setConnectionInfoOpen(false)}
          style={styles.infoBackdrop}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={styles.infoCard}
          >
            <Text style={styles.infoTitle}>{t("connectionInfo")}</Text>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>{t("connectionStatus")}</Text>
              <View style={styles.infoValueRow}>
                <View
                  style={[
                    styles.infoDot,
                    connectionPhase === "connected"
                      ? styles.statusDotConnected
                      : connectionPhase === "failed"
                        ? styles.statusDotFailed
                        : styles.statusDotPending
                  ]}
                />
                <Text style={styles.infoValue}>
                  {connectionPhase === "connected"
                    ? t("statusConnected")
                    : connectionPhase === "failed"
                      ? t("statusFailed")
                      : connectionPhase === "reconnecting"
                        ? t("statusReconnecting")
                        : t("statusSynchronizing")}
                </Text>
              </View>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>{t("connectionPath")}</Text>
              <Text style={styles.infoValue}>
                {pathScope === "local_subnet"
                  ? t("connectionPathLan")
                  : pathScope === "public_internet"
                    ? t("connectionPathPublic")
                    : pathScope === "private_network"
                      ? t("connectionPathPrivate")
                      : t("connectionPathUnknown")}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>{t("connectionTransport")}</Text>
              <Text style={styles.infoValue}>
                {t("connectionTransportP2p")}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>{t("connectionLatency")}</Text>
              <Text style={styles.infoValue}>
                {latencyState === "measuring"
                  ? t("connectionLatencyMeasuring")
                  : latencyMs !== null
                    ? `${latencyMs} ms`
                    : t("connectionLatencyUnavailable")}
              </Text>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      {dialog && actionSession ? (
        <NativeSheet
          closeAccessibilityLabel={t("closeSheet")}
          onOpenChange={(open) => {
            if (!open && !actionPending) setDialog(null);
          }}
          open
        >
          <View style={styles.actionSheet}>
            <Text numberOfLines={2} style={styles.actionTitle}>
              {actionSession.title || t("untitledSession")}
            </Text>
            {dialog.kind === "actions" ? (
              <>
                <ActionButton
                  disabled={actionPending}
                  label={
                    actionSession.pinnedAtUnixMs
                      ? t("unpinSession")
                      : t("pinSession")
                  }
                  onPress={() =>
                    void runAction(() => onTogglePinned(actionSession.id))
                  }
                />
                <ActionButton
                  disabled={actionPending}
                  label={t("renameSession")}
                  onPress={() => {
                    setRenameDraft(actionSession.title);
                    setDialog({
                      kind: "rename",
                      sessionId: actionSession.id
                    });
                  }}
                />
                <ActionButton
                  danger
                  disabled={actionPending}
                  label={t("deleteSession")}
                  onPress={() =>
                    setDialog({
                      kind: "delete",
                      sessionId: actionSession.id
                    })
                  }
                />
              </>
            ) : dialog.kind === "rename" ? (
              <>
                <TextInput
                  autoFocus
                  editable={!actionPending}
                  onChangeText={setRenameDraft}
                  placeholder={t("untitledSession")}
                  placeholderTextColor={theme.color.muted}
                  selectTextOnFocus
                  style={styles.renameInput}
                  value={renameDraft}
                />
                <View style={styles.actionRow}>
                  <ActionButton
                    compact
                    disabled={actionPending}
                    label={t("cancel")}
                    onPress={() => setDialog(null)}
                  />
                  <ActionButton
                    compact
                    disabled={actionPending || !renameDraft.trim()}
                    label={t("save")}
                    onPress={() =>
                      void runAction(() =>
                        onRenameSession(actionSession.id, renameDraft)
                      )
                    }
                  />
                </View>
              </>
            ) : (
              <>
                <Text style={styles.deleteDescription}>
                  {t("deleteSessionDescription")}
                </Text>
                <View style={styles.actionRow}>
                  <ActionButton
                    compact
                    disabled={actionPending}
                    label={t("cancel")}
                    onPress={() => setDialog(null)}
                  />
                  <ActionButton
                    compact
                    danger
                    disabled={actionPending}
                    label={t("deleteSessionConfirm")}
                    onPress={() =>
                      void runAction(() => onDeleteSession(actionSession.id))
                    }
                  />
                </View>
              </>
            )}
            {actionPending ? (
              <ActivityIndicator
                color={theme.color.accent}
                size="small"
                style={styles.actionPending}
              />
            ) : null}
          </View>
        </NativeSheet>
      ) : null}
    </MobileKeyboardAvoidingView>
  );
}

function ActionButton({
  compact = false,
  danger = false,
  disabled = false,
  label,
  onPress
}: {
  compact?: boolean;
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onPress(): void;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  return (
    <NativeButton
      disabled={disabled}
      label={label}
      onPress={onPress}
      size={compact ? "compact" : "regular"}
      style={compact ? styles.actionButtonCompact : undefined}
      variant={danger ? "destructiveGhost" : "ghost"}
    />
  );
}

function sectionTitle(
  section: WorkspaceActivitySnapshot["railSections"][number]
): string {
  if (section.kind === "pinned") return t("pinned");
  if (section.kind === "project") {
    const label = section.label || t("projects");
    return section.pinnedProject ? `${label} · ${t("pinned")}` : label;
  }
  return t("recentSessions");
}

function formatSessionTime(unixMs: number): string {
  if (!unixMs) return "";
  const date = new Date(unixMs);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short" });
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    actionButtonCompact: { flex: 1 },
    actionPending: { marginTop: theme.space.small },
    actionRow: {
      flexDirection: "row",
      gap: theme.space.small,
      marginTop: theme.space.small
    },
    actionSheet: {
      paddingBottom: theme.space.large,
      paddingHorizontal: theme.space.large,
      paddingTop: theme.space.medium
    },
    actionTitle: {
      color: theme.color.textSecondary,
      fontSize: 13,
      fontWeight: "600",
      lineHeight: 18,
      marginBottom: theme.space.small
    },
    backIcon: {
      color: theme.color.text,
      fontSize: 22,
      fontWeight: "400",
      lineHeight: 26
    },
    bottomDock: {
      alignItems: "center",
      backgroundColor: theme.color.background,
      flexDirection: "row",
      gap: theme.space.small,
      paddingBottom: theme.space.small,
      paddingTop: theme.space.small,
      zIndex: 2
    },
    chatButton: {
      backgroundColor: theme.color.text,
      borderRadius: theme.control.large / 2,
      height: theme.control.large,
      width: "100%"
    },
    chatButtonSlot: {
      flexShrink: 0,
      height: theme.control.large,
      width: 104
    },
    chatIcon: { color: theme.color.background, fontSize: 18 },
    deleteDescription: {
      color: theme.color.textSecondary,
      fontSize: 14,
      lineHeight: 20
    },
    root: {
      backgroundColor: theme.color.background,
      flex: 1,
      paddingHorizontal: theme.space.medium,
      paddingTop: theme.space.medium
    },
    empty: {
      color: theme.color.muted,
      lineHeight: 22,
      paddingHorizontal: theme.space.small,
      paddingVertical: theme.space.xlarge,
      textAlign: "center"
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between"
    },
    headerButton: {
      alignItems: "center",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      height: 40,
      justifyContent: "center",
      width: 40
    },
    headerButtonSlot: {
      flexShrink: 0,
      height: 40,
      width: 40
    },
    infoBackdrop: {
      backgroundColor: theme.color.scrim,
      flex: 1,
      paddingHorizontal: theme.space.medium,
      paddingTop: 96
    },
    infoCard: {
      alignSelf: "flex-end",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 12,
      gap: theme.space.small,
      maxWidth: 320,
      padding: theme.space.medium,
      shadowColor: theme.color.text,
      shadowOffset: { height: 10, width: 0 },
      shadowOpacity: 0.16,
      shadowRadius: 24,
      width: "100%"
    },
    infoDot: {
      borderRadius: 4,
      height: 8,
      width: 8
    },
    infoLabel: {
      color: theme.color.muted,
      fontSize: 13
    },
    infoRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      minHeight: 24
    },
    infoTitle: {
      color: theme.color.text,
      fontSize: 15,
      fontWeight: "700",
      marginBottom: 2
    },
    infoValue: {
      color: theme.color.text,
      flexShrink: 1,
      fontSize: 13,
      fontWeight: "600",
      textAlign: "right"
    },
    infoValueRow: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 1,
      gap: 6
    },
    feedback: {
      alignItems: "center",
      gap: theme.space.small,
      paddingVertical: theme.space.xlarge
    },
    feedbackText: { color: theme.color.textSecondary, fontSize: 14 },
    inlineError: {
      alignItems: "center",
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: theme.space.medium
    },
    inlineErrorText: { color: theme.color.danger, flex: 1, fontSize: 12 },
    list: {
      gap: theme.space.medium,
      paddingBottom: theme.space.medium,
      paddingTop: theme.space.small
    },
    loadMoreButton: {
      alignItems: "center",
      minHeight: 40,
      paddingVertical: theme.space.small
    },
    loadMoreLabel: {
      color: theme.color.accent,
      fontSize: 13,
      fontWeight: "600"
    },
    moreButton: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 40
    },
    moreIcon: {
      color: theme.color.muted,
      fontSize: 13,
      fontWeight: "900",
      letterSpacing: 1
    },
    pressed: { opacity: 0.7 },
    groupTitle: {
      color: theme.color.textSecondary,
      fontSize: 13,
      fontWeight: "600",
      letterSpacing: 0.4,
      marginBottom: theme.space.small
    },
    projectName: {
      color: theme.color.text,
      flexShrink: 1,
      fontSize: 16,
      fontWeight: "600",
      minWidth: 0
    },
    projectRow: {
      alignItems: "center",
      alignSelf: "stretch",
      flexDirection: "row",
      gap: theme.space.small,
      minHeight: 36,
      width: "100%"
    },
    projectSection: {
      paddingBottom: theme.space.small,
      paddingTop: theme.space.small
    },
    renameInput: {
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      color: theme.color.text,
      fontSize: 16,
      minHeight: 48,
      paddingHorizontal: theme.space.medium
    },
    searchIcon: {
      color: theme.color.textSecondary,
      fontSize: 18,
      lineHeight: 22
    },
    searchInput: {
      color: theme.color.text,
      flex: 1,
      fontSize: 15,
      height: "100%",
      minWidth: 0,
      paddingVertical: 0
    },
    searchPill: {
      alignItems: "center",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.control.large / 2,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      flexDirection: "row",
      gap: theme.space.small,
      height: theme.control.large,
      minWidth: 0,
      paddingHorizontal: theme.space.medium
    },
    section: { gap: 2 },
    sectionCount: {
      color: theme.color.muted,
      fontSize: 11,
      fontWeight: "600"
    },
    sectionChevron: {
      color: theme.color.muted,
      fontSize: 16,
      lineHeight: 18
    },
    sectionHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small,
      minHeight: 28,
      paddingHorizontal: theme.space.small
    },
    sectionTitle: {
      color: theme.color.text,
      flex: 1,
      fontSize: 15,
      fontWeight: "600",
      letterSpacing: 0.2
    },
    sessionScroller: { flex: 1 },
    sessionTime: { color: theme.color.muted, fontSize: 12 },
    sessionTrailing: {
      alignItems: "center",
      flexShrink: 0,
      flexDirection: "row",
      gap: 2
    },
    statusButton: {
      alignItems: "center",
      height: 40,
      justifyContent: "center",
      width: 40
    },
    statusDot: {
      borderRadius: 6,
      height: 12,
      width: 12
    },
    statusDotConnected: { backgroundColor: theme.color.success },
    statusDotFailed: { backgroundColor: theme.color.danger },
    statusDotPending: { backgroundColor: theme.color.accent },
    title: {
      color: theme.color.text,
      flex: 1,
      fontSize: 17,
      fontWeight: "600",
      paddingHorizontal: theme.space.small,
      textAlign: "center"
    }
  });
}
