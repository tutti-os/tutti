import {
  NativeButton,
  NativeIconButton,
  NativeListRow,
  NativeSheet,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View
} from "react-native";
import { t } from "../i18n";
import type { MobileConnectionSnapshot } from "../services/mobileApplicationService";
import type { DeviceLinkPathScope } from "../services/mobileDomain";
import type { WorkspaceActivitySnapshot } from "../services/workspaceActivityService";
import type { WorkspaceActivityConversation } from "../services/workspaceActivityTypes";
import {
  MobileKeyboardAvoidingView,
  mobileKeyboardDismissMode
} from "./MobileKeyboardAvoidingView";
import { MobileFolderGlyph, MobileSearchGlyph } from "./MobileLocationGlyphs";
import {
  searchConversationIds,
  useMobileActivityViewModel
} from "./mobileActivityViewModel";
import { createMobileActivityStyles as createStyles } from "./mobileActivityViewStyles";

type PriorityReason = "waiting" | "unread" | "active" | "retained-idle";
type Dialog = {
  kind: "actions" | "delete" | "rename";
  sessionId: string;
} | null;
type LatencyState = "idle" | "measuring" | "done";
const REFRESH_FEEDBACK_TIMEOUT_MS = 5_000;

export function MobileActivityView({
  connectionPhase,
  deviceName,
  model,
  onBack,
  onDeleteSession,
  onLoadMoreSearch,
  onMeasureLatency,
  onNewSession,
  onRenameSession,
  onRefreshSessions,
  onRetrySearch,
  onSearchQueryChange,
  onSelectSession,
  pathScope,
  workspaceId
}: {
  connectionPhase: MobileConnectionSnapshot["phase"];
  deviceName: string;
  model: WorkspaceActivitySnapshot;
  onBack(): void;
  onDeleteSession(id: string): Promise<void>;
  onLoadMoreSearch(): void;
  onMeasureLatency(): Promise<number | null>;
  onNewSession(): void;
  onRenameSession(id: string, title: string): Promise<void>;
  onRefreshSessions(): Promise<void>;
  onRetrySearch(): void;
  onSearchQueryChange(query: string): void;
  onSelectSession(id: string): void;
  pathScope: DeviceLinkPathScope | null;
  workspaceId: string;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [latencyState, setLatencyState] = useState<LatencyState>("idle");
  const statusTapAt = useRef(0);
  const searchQuery = searchDraft.trim();
  const searchMode = searchQuery.length > 0;
  useEffect(() => {
    if (!refreshing) return;
    const timeout = setTimeout(
      () => setRefreshing(false),
      REFRESH_FEEDBACK_TIMEOUT_MS
    );
    return () => clearTimeout(timeout);
  }, [refreshing]);
  const activity = useMobileActivityViewModel({
    conversations: model.activityConversations,
    ready: model.railStatus === "ready",
    scopeKey: workspaceId
  });
  const searchResolved =
    searchMode && model.search.resolvedQuery === searchQuery;
  const searchResults = searchResolved
    ? searchConversationIds(activity, model.search.sessionIds)
    : [];
  const actionSession = dialog
    ? (activity.conversationsById.get(dialog.sessionId) ?? null)
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

  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshSessions();
    } finally {
      setRefreshing(false);
    }
  };

  const measureConnection = (): void => {
    setInfoOpen(true);
    setLatencyState("measuring");
    setLatencyMs(null);
    void onMeasureLatency().then((value) => {
      setLatencyMs(value);
      setLatencyState("done");
    });
  };

  const onStatusPress = (): void => {
    const now = Date.now();
    if (now - statusTapAt.current < 350) {
      statusTapAt.current = 0;
      measureConnection();
    } else {
      statusTapAt.current = now;
    }
  };

  return (
    <MobileKeyboardAvoidingView style={styles.root}>
      <View style={styles.header}>
        <NativeIconButton
          accessibilityLabel={t("backToDevices")}
          icon={<Text style={styles.backIcon}>←</Text>}
          onPress={onBack}
          style={styles.headerButton}
          variant="secondary"
        />
        <Text numberOfLines={1} style={styles.title}>
          {deviceName || t("desktopFallback")}
        </Text>
        <Pressable
          accessibilityLabel={t("connectionInfo")}
          accessibilityRole="button"
          onPress={onStatusPress}
          style={({ pressed }) => [
            styles.statusButton,
            pressed && styles.pressed
          ]}
        >
          <View
            style={[
              styles.statusDot,
              connectionPhase === "connected"
                ? styles.connectedDot
                : connectionPhase === "failed"
                  ? styles.failedDot
                  : styles.pendingDot
            ]}
          />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        keyboardDismissMode={mobileKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
        onScrollEndDrag={() => {
          if (searchMode && model.search.hasMore) onLoadMoreSearch();
        }}
        refreshControl={
          <RefreshControl
            onRefresh={() => void refresh()}
            refreshing={refreshing}
            tintColor={theme.color.textSecondary}
          />
        }
        style={styles.scroller}
      >
        {model.railStatus === "loading" &&
        model.activityConversations.length === 0 ? (
          <Feedback loading styles={styles} theme={theme} />
        ) : model.railErrorCode && model.activityConversations.length === 0 ? (
          <Feedback
            onRetry={() => void refresh()}
            styles={styles}
            theme={theme}
          />
        ) : searchMode ? (
          <SearchResults
            loading={
              !searchResolved ||
              model.search.pending ||
              model.search.query !== searchQuery
            }
            model={model}
            onLoadMore={onLoadMoreSearch}
            onRetry={onRetrySearch}
            onSelectSession={onSelectSession}
            onRequestActions={(id) =>
              setDialog({ kind: "actions", sessionId: id })
            }
            results={searchResults}
            styles={styles}
            theme={theme}
          />
        ) : (
          <ActivitySections
            activity={activity}
            onSelectSession={onSelectSession}
            onRequestActions={(id) =>
              setDialog({ kind: "actions", sessionId: id })
            }
            styles={styles}
          />
        )}
      </ScrollView>

      <View style={styles.bottomDock}>
        <View style={styles.searchPill}>
          <MobileSearchGlyph color={theme.color.textSecondary} size={20} />
          <TextInput
            onChangeText={(value) => {
              setSearchDraft(value);
              onSearchQueryChange(value);
            }}
            placeholder={t("searchChats")}
            placeholderTextColor={theme.color.muted}
            style={styles.searchInput}
            value={searchDraft}
          />
        </View>
        <NativeButton
          disabled={model.targets.length === 0}
          label={t("chat")}
          leading={<Text style={styles.chatIcon}>＋</Text>}
          onPress={onNewSession}
          size="large"
          style={styles.chatButton}
        />
      </View>

      <ConnectionInfo
        connectionPhase={connectionPhase}
        latencyMs={latencyMs}
        latencyState={latencyState}
        onClose={() => setInfoOpen(false)}
        open={infoOpen}
        pathScope={pathScope}
        styles={styles}
      />

      {dialog && actionSession ? (
        <NativeSheet
          closeAccessibilityLabel={t("closeSheet")}
          onOpenChange={(open) => {
            if (!open && !actionPending) setDialog(null);
          }}
          open
        >
          <View style={styles.sheet}>
            <Text numberOfLines={2} style={styles.sheetTitle}>
              {actionSession.title || t("untitledSession")}
            </Text>
            {dialog.kind === "actions" ? (
              <>
                <ActionButton
                  disabled={actionPending}
                  label={t("renameSession")}
                  onPress={() => {
                    setRenameDraft(actionSession.title);
                    setDialog({ kind: "rename", sessionId: actionSession.id });
                  }}
                />
                <ActionButton
                  danger
                  disabled={actionPending}
                  label={t("deleteSession")}
                  onPress={() =>
                    setDialog({ kind: "delete", sessionId: actionSession.id })
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
              <ActivityIndicator color={theme.color.accent} size="small" />
            ) : null}
          </View>
        </NativeSheet>
      ) : null}
    </MobileKeyboardAvoidingView>
  );
}

function ActivitySections({
  activity,
  onRequestActions,
  onSelectSession,
  styles
}: {
  activity: ReturnType<typeof useMobileActivityViewModel>;
  onRequestActions(id: string): void;
  onSelectSession(id: string): void;
  styles: ReturnType<typeof createStyles>;
}) {
  const projection = activity.projection;
  if (!projection) return null;
  const rows: React.JSX.Element[] = [
    <Text key="priority" style={styles.sectionTitle}>
      {t("activityPriority")}
    </Text>
  ];
  if (projection.priorityIds.length === 0) {
    rows.push(
      <Text key="priority-empty" style={styles.emptyPriority}>
        {t("activityNothingNeedsAttention")}
      </Text>
    );
  } else {
    for (const id of projection.priorityIds) {
      const item = activity.conversationsById.get(id);
      if (item) {
        rows.push(
          <ActivityRow
            key={`priority:${id}`}
            conversation={item}
            onRequestActions={onRequestActions}
            onSelectSession={onSelectSession}
            priorityReason={projection.priorityReasonsById.get(id) ?? null}
            styles={styles}
          />
        );
      }
    }
  }
  for (const section of projection.recentSections) {
    rows.push(
      <Text key={section.dayStartUnixMs} style={styles.sectionTitle}>
        {activityDayLabel(
          section.dayStartUnixMs,
          projection.referenceDayStartUnixMs
        )}
      </Text>
    );
    for (const id of section.ids) {
      const item = activity.conversationsById.get(id);
      if (item) {
        rows.push(
          <ActivityRow
            key={`recent:${id}`}
            conversation={item}
            onRequestActions={onRequestActions}
            onSelectSession={onSelectSession}
            priorityReason={null}
            styles={styles}
          />
        );
      }
    }
  }
  return <View style={styles.sections}>{rows}</View>;
}

function SearchResults({
  loading,
  model,
  onLoadMore,
  onRequestActions,
  onRetry,
  onSelectSession,
  results,
  styles,
  theme
}: {
  loading: boolean;
  model: WorkspaceActivitySnapshot;
  onLoadMore(): void;
  onRequestActions(id: string): void;
  onRetry(): void;
  onSelectSession(id: string): void;
  results: readonly WorkspaceActivityConversation[];
  styles: ReturnType<typeof createStyles>;
  theme: NativeTheme;
}) {
  if (loading) return <Feedback loading styles={styles} theme={theme} />;
  if (model.search.failed) {
    return <Feedback onRetry={onRetry} styles={styles} theme={theme} />;
  }
  if (results.length === 0) {
    return <Text style={styles.empty}>{t("emptySessions")}</Text>;
  }
  return (
    <View style={styles.sections}>
      {results.map((item) => (
        <ActivityRow
          key={item.id}
          conversation={item}
          onRequestActions={onRequestActions}
          onSelectSession={onSelectSession}
          priorityReason={null}
          styles={styles}
        />
      ))}
      {model.search.hasMore ? (
        <Pressable
          disabled={model.search.loadingMore}
          onPress={onLoadMore}
          style={({ pressed }) => [styles.loadMore, pressed && styles.pressed]}
        >
          {model.search.loadingMore ? (
            <ActivityIndicator color={theme.color.accent} size="small" />
          ) : (
            <Text style={styles.loadMoreLabel}>{t("loadMoreSessions")}</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

function Feedback({
  loading = false,
  onRetry,
  styles,
  theme
}: {
  loading?: boolean;
  onRetry?(): void;
  styles: ReturnType<typeof createStyles>;
  theme: NativeTheme;
}) {
  return (
    <View style={styles.feedback}>
      {loading ? (
        <ActivityIndicator color={theme.color.accent} size="small" />
      ) : (
        <>
          <Text style={styles.feedbackText}>{t("genericError")}</Text>
          <NativeButton
            label={t("retry")}
            onPress={onRetry ?? (() => undefined)}
            size="compact"
            variant="ghost"
          />
        </>
      )}
    </View>
  );
}

function ActivityRow({
  conversation,
  onRequestActions,
  onSelectSession,
  priorityReason,
  styles
}: {
  conversation: WorkspaceActivityConversation;
  onRequestActions(id: string): void;
  onSelectSession(id: string): void;
  priorityReason: PriorityReason | null;
  styles: ReturnType<typeof createStyles>;
}) {
  const title = conversation.title || t("untitledSession");
  const projectLabel = conversation.project?.label?.trim();
  const secondary = projectLabel || t("activityConversationSource");
  const status = activityStatus(conversation, priorityReason);
  const statusStyle =
    conversation.status === "failed"
      ? styles.sessionStatusFailed
      : conversation.status === "working" ||
          conversation.status === "waiting" ||
          priorityReason
        ? styles.sessionStatusActive
        : null;
  return (
    <NativeListRow
      accessibilityLabel={`${title}, ${secondary}, ${status}`}
      description={
        projectLabel ? (
          <View style={styles.projectDescription}>
            <MobileFolderGlyph color={styles.projectLabel.color} size={14} />
            <Text numberOfLines={1} style={styles.projectLabel}>
              {projectLabel}
            </Text>
          </View>
        ) : (
          secondary
        )
      }
      onLongPress={() => onRequestActions(conversation.id)}
      onPress={() => onSelectSession(conversation.id)}
      title={title}
      titleNumberOfLines={1}
      trailing={
        statusStyle ? (
          <View style={styles.trailing}>
            <View
              accessibilityLabel={status}
              accessibilityRole="image"
              style={[styles.sessionStatusDot, statusStyle]}
            />
          </View>
        ) : undefined
      }
    />
  );
}

function ConnectionInfo({
  connectionPhase,
  latencyMs,
  latencyState,
  onClose,
  open,
  pathScope,
  styles
}: {
  connectionPhase: MobileConnectionSnapshot["phase"];
  latencyMs: number | null;
  latencyState: LatencyState;
  onClose(): void;
  open: boolean;
  pathScope: DeviceLinkPathScope | null;
  styles: ReturnType<typeof createStyles>;
}) {
  const status =
    connectionPhase === "connected"
      ? t("statusConnected")
      : connectionPhase === "failed"
        ? t("statusFailed")
        : connectionPhase === "reconnecting"
          ? t("statusReconnecting")
          : t("statusSynchronizing");
  const path =
    pathScope === "local_subnet"
      ? t("connectionPathLan")
      : pathScope === "public_internet"
        ? t("connectionPathPublic")
        : pathScope === "private_network"
          ? t("connectionPathPrivate")
          : t("connectionPathUnknown");
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      transparent
      visible={open}
    >
      <Pressable onPress={onClose} style={styles.infoBackdrop}>
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={styles.infoCard}
        >
          <Text style={styles.infoTitle}>{t("connectionInfo")}</Text>
          <InfoRow
            label={t("connectionStatus")}
            value={status}
            styles={styles}
          />
          <InfoRow label={t("connectionPath")} value={path} styles={styles} />
          <InfoRow
            label={t("connectionTransport")}
            value={t("connectionTransportP2p")}
            styles={styles}
          />
          <InfoRow
            label={t("connectionLatency")}
            value={
              latencyState === "measuring"
                ? t("connectionLatencyMeasuring")
                : latencyMs === null
                  ? t("connectionLatencyUnavailable")
                  : `${latencyMs} ms`
            }
            styles={styles}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function InfoRow({
  label,
  styles,
  value
}: {
  label: string;
  styles: ReturnType<typeof createStyles>;
  value: string;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
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

function activityStatus(
  conversation: WorkspaceActivityConversation,
  reason: PriorityReason | null
): string {
  if (reason === "waiting") return t("activityWaiting");
  if (reason === "unread") return t("activityUnreadResult");
  if (reason === "active") return t("running");
  if (reason === "retained-idle") return t("activityRecentlyActive");
  switch (conversation.status) {
    case "working":
      return t("running");
    case "waiting":
      return t("waiting");
    case "failed":
      return t("failed");
    case "completed":
      return t("completed");
    case "canceled":
      return t("canceled");
    default:
      return t("ready");
  }
}

function activityDayLabel(day: number, reference: number): string {
  if (day === reference) return t("activityToday");
  const yesterday = new Date(reference);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return t("activityYesterday");
  return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(day);
}
