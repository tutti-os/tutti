import type { AgentActivityInteraction } from "@tutti-os/agent-activity-core";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import {
  MobileInteractionCard,
  MobileMessageRow
} from "../components/MobileConversationRows";
import { PrimaryButton } from "../components/PrimaryButton";
import { t } from "../i18n";
import type { WorkspaceActivitySnapshot } from "../services/workspaceActivityService";
import type { WorkspaceCatalogSnapshot } from "../services/workspaceCatalogService";
import { theme } from "../theme";

export function WorkspacePickerView({
  deviceName,
  model,
  onDisconnect,
  onRetry,
  onSelect
}: {
  deviceName: string;
  model: WorkspaceCatalogSnapshot;
  onDisconnect(): void;
  onRetry(): void;
  onSelect(workspace: WorkspaceSummary): void;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.pageHeader}>
        <View>
          <Text style={styles.eyebrow}>{deviceName}</Text>
          <Text style={styles.pageTitle}>{t("sessions")}</Text>
        </View>
        <PrimaryButton
          label={t("cancel")}
          onPress={onDisconnect}
          secondary
          style={styles.compactButton}
        />
      </View>
      {model.status !== "ready" ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.accent} size="large" />
        </View>
      ) : model.errorCode ? (
        <View style={styles.center}>
          <Text style={styles.error}>{t("genericError")}</Text>
          <PrimaryButton label={t("retry")} onPress={onRetry} />
        </View>
      ) : model.workspaces.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>{t("noWorkspace")}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.workspaceList}>
          {model.workspaces.map((workspace) => (
            <Pressable
              key={workspace.id}
              onPress={() => onSelect(workspace)}
              style={({ pressed }) => [
                styles.workspaceCard,
                pressed && styles.pressed
              ]}
            >
              <Text style={styles.workspaceName}>{workspace.name}</Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

export function ConversationWorkspaceView({
  deviceName,
  model,
  onBack,
  onDraftChange,
  onLoadOlder,
  onNewSession,
  onRespond,
  onSelectSession,
  onSelectTarget,
  onSend,
  onStop,
  workspace
}: {
  deviceName: string;
  model: WorkspaceActivitySnapshot;
  onBack(): void;
  onDraftChange(value: string): void;
  onLoadOlder(): void;
  onNewSession(): void;
  onRespond(
    interaction: AgentActivityInteraction,
    input: {
      action?: string;
      optionId?: string;
      payload?: Readonly<Record<string, unknown>>;
    }
  ): void;
  onSelectSession(id: string): void;
  onSelectTarget(id: string): void;
  onSend(): void;
  onStop(): void;
  workspace: WorkspaceSummary;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const sessions = model.activity.sessions.filter(
    (session) => session.kind !== "child" && session.visible
  );
  const messages = model.selectedAgentSessionId
    ? (model.activity.sessionMessagesById[model.selectedAgentSessionId] ?? [])
    : [];
  const window = model.selectedAgentSessionId
    ? model.activity.sessionMessageWindowsById?.[model.selectedAgentSessionId]
    : null;

  return (
    <View style={styles.root}>
      <View style={styles.conversationHeader}>
        <Pressable
          accessibilityLabel={t("sessions")}
          onPress={() => setDrawerOpen(true)}
          style={styles.iconButton}
        >
          <Text style={styles.iconText}>☰</Text>
        </Pressable>
        <View style={styles.conversationTitle}>
          <Text numberOfLines={1} style={styles.sessionTitle}>
            {model.selectedSession?.title || workspace.name}
          </Text>
          <Text numberOfLines={1} style={styles.deviceCaption}>
            {deviceName || t("desktopFallback")} · {workspace.name}
          </Text>
        </View>
        <View style={styles.onlineDot} />
      </View>

      {model.loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.accent} size="large" />
        </View>
      ) : model.selectedSession && !model.creating ? (
        <ScrollView
          contentContainerStyle={styles.messageList}
          onContentSizeChange={() =>
            scroll.current?.scrollToEnd({ animated: false })
          }
          onScroll={({ nativeEvent }) => {
            if (nativeEvent.contentOffset.y < 48 && window?.hasOlderMessages) {
              onLoadOlder();
            }
          }}
          ref={scroll}
          scrollEventThrottle={100}
        >
          {window?.hasOlderMessages ? (
            <Text style={styles.loadOlder}>{t("loading")}</Text>
          ) : null}
          {messages.length === 0 ? (
            <Text style={styles.emptyText}>{t("emptyConversation")}</Text>
          ) : (
            messages.map((message) => (
              <MobileMessageRow key={message.messageId} message={message} />
            ))
          )}
          {model.selectedSession.pendingInteractions.map((interaction) => (
            <MobileInteractionCard
              interaction={interaction}
              key={`${interaction.agentSessionId}:${interaction.turnId}:${interaction.requestId}`}
              onSubmit={async (input) => onRespond(interaction, input)}
            />
          ))}
        </ScrollView>
      ) : model.creating ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>{t("newSessionHint")}</Text>
          <ScrollView
            contentContainerStyle={styles.targetList}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {model.targets.map((target) => (
              <Pressable
                key={target.id}
                onPress={() => onSelectTarget(target.id)}
                style={[
                  styles.targetChip,
                  target.id === model.selectedAgentTargetId &&
                    styles.targetChipSelected
                ]}
              >
                <Text style={styles.targetChipText}>{target.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : (
        <View style={styles.center}>
          <Text style={styles.emptyText}>{t("emptySessions")}</Text>
        </View>
      )}

      {model.errorCode ? (
        <Text style={styles.inlineError}>{t("genericError")}</Text>
      ) : null}
      {model.selectedSession || model.creating ? (
        <View style={styles.composer}>
          <TextInput
            editable={!model.sending}
            multiline
            onChangeText={onDraftChange}
            placeholder={t("messageHint")}
            placeholderTextColor={theme.color.muted}
            style={styles.input}
            value={model.draft}
          />
          {model.selectedSession?.activeTurnId && !model.creating ? (
            <PrimaryButton
              label={t("stop")}
              onPress={onStop}
              secondary
              style={styles.sendButton}
            />
          ) : (
            <PrimaryButton
              disabled={
                !model.draft.trim() ||
                (model.creating && !model.selectedAgentTargetId)
              }
              label={model.ambiguousSubmission ? t("retry") : t("send")}
              loading={model.sending}
              onPress={onSend}
              style={styles.sendButton}
            />
          )}
        </View>
      ) : null}

      {drawerOpen ? (
        <View style={styles.drawerLayer}>
          <Pressable
            onPress={() => setDrawerOpen(false)}
            style={styles.drawerScrim}
          />
          <View style={styles.drawer}>
            <View style={styles.drawerHeader}>
              <Text style={styles.drawerTitle}>{t("sessions")}</Text>
              <Pressable onPress={() => setDrawerOpen(false)}>
                <Text style={styles.close}>×</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.drawerList}>
              {sessions.map((session) => (
                <Pressable
                  key={session.agentSessionId}
                  onPress={() => {
                    onSelectSession(session.agentSessionId);
                    setDrawerOpen(false);
                  }}
                  style={[
                    styles.sessionCard,
                    session.agentSessionId === model.selectedAgentSessionId &&
                      styles.sessionCardSelected
                  ]}
                >
                  <Text numberOfLines={2} style={styles.sessionCardTitle}>
                    {session.title || t("untitledSession")}
                  </Text>
                  <Text style={styles.sessionCardMeta}>
                    {session.activeTurnId ? t("running") : t("ready")}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <PrimaryButton
              disabled={model.targets.length === 0}
              label={t("newSession")}
              onPress={() => {
                onNewSession();
                setDrawerOpen(false);
              }}
            />
            <PrimaryButton
              label={t("backToWorkspaces")}
              onPress={onBack}
              secondary
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    flex: 1,
    gap: theme.space.medium,
    justifyContent: "center",
    padding: theme.space.large
  },
  chevron: { color: theme.color.muted, fontSize: 30 },
  close: { color: theme.color.textSecondary, fontSize: 32, lineHeight: 34 },
  compactButton: { height: 40 },
  composer: {
    alignItems: "flex-end",
    borderTopColor: theme.color.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: theme.space.small,
    padding: theme.space.medium
  },
  conversationHeader: {
    alignItems: "center",
    borderBottomColor: theme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    minHeight: 64,
    paddingHorizontal: theme.space.medium
  },
  conversationTitle: { flex: 1, marginHorizontal: theme.space.small },
  deviceCaption: { color: theme.color.muted, fontSize: 12, marginTop: 3 },
  drawer: {
    backgroundColor: theme.color.background,
    bottom: 0,
    left: 0,
    padding: theme.space.large,
    position: "absolute",
    top: 0,
    width: "86%"
  },
  drawerHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  drawerLayer: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  drawerList: { gap: theme.space.small, paddingVertical: theme.space.large },
  drawerScrim: {
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  drawerTitle: { color: theme.color.text, fontSize: 24, fontWeight: "700" },
  emptyText: {
    color: theme.color.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center"
  },
  error: { color: theme.color.danger, fontSize: 14 },
  eyebrow: { color: theme.color.accent, fontSize: 12, fontWeight: "700" },
  iconButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44
  },
  iconText: { color: theme.color.text, fontSize: 22 },
  inlineError: {
    backgroundColor: theme.color.panel,
    color: theme.color.danger,
    fontSize: 12,
    padding: theme.space.small,
    textAlign: "center"
  },
  input: {
    backgroundColor: theme.color.panel,
    borderColor: theme.color.border,
    borderRadius: theme.radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    color: theme.color.text,
    flex: 1,
    fontSize: 16,
    maxHeight: 132,
    minHeight: 48,
    paddingHorizontal: theme.space.medium,
    paddingVertical: 12
  },
  loadOlder: { color: theme.color.muted, fontSize: 12, textAlign: "center" },
  messageList: { gap: theme.space.medium, padding: theme.space.large },
  onlineDot: {
    backgroundColor: theme.color.success,
    borderRadius: 5,
    height: 10,
    width: 10
  },
  pageHeader: {
    alignItems: "center",
    borderBottomColor: theme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: theme.space.large
  },
  pageTitle: {
    color: theme.color.text,
    fontSize: 27,
    fontWeight: "700",
    marginTop: 4
  },
  pressed: { opacity: 0.7 },
  root: { backgroundColor: theme.color.background, flex: 1 },
  sendButton: { minWidth: 76 },
  sessionCard: {
    backgroundColor: theme.color.panel,
    borderColor: theme.color.border,
    borderRadius: theme.radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    padding: theme.space.medium
  },
  sessionCardMeta: { color: theme.color.muted, fontSize: 12, marginTop: 6 },
  sessionCardSelected: { borderColor: theme.color.accent },
  sessionCardTitle: {
    color: theme.color.text,
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 20
  },
  sessionTitle: { color: theme.color.text, fontSize: 16, fontWeight: "700" },
  targetChip: {
    borderColor: theme.color.border,
    borderRadius: theme.radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.space.medium,
    paddingVertical: theme.space.small
  },
  targetChipSelected: { borderColor: theme.color.accent },
  targetChipText: { color: theme.color.text, fontSize: 13 },
  targetList: { gap: theme.space.small },
  workspaceCard: {
    alignItems: "center",
    backgroundColor: theme.color.panel,
    borderColor: theme.color.border,
    borderRadius: theme.radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: theme.space.large
  },
  workspaceList: {
    gap: theme.space.medium,
    padding: theme.space.large
  },
  workspaceName: {
    color: theme.color.text,
    flex: 1,
    fontSize: 17,
    fontWeight: "700"
  }
});
