import type {
  AgentTarget,
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { remoteTuttidClient } from "../services/remoteTuttidClient";
import { theme } from "../theme";
import {
  mergeMessages,
  resolvePendingSubmission,
  type PendingSubmission
} from "./workspaceConversationModel";

interface WorkspaceScreenProps {
  deviceName: string;
  onDisconnect(): Promise<void>;
}

export function WorkspaceScreen({
  deviceName,
  onDisconnect
}: WorkspaceScreenProps) {
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<WorkspaceSummary | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);

  const load = useCallback(async () => {
    setError(false);
    setLoading(true);
    try {
      const response = await remoteTuttidClient.listWorkspaces();
      setWorkspaces(response.workspaces);
      if (response.workspaces.length === 1) {
        setSelected(response.workspaces[0] ?? null);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (selected) {
    return (
      <ConversationWorkspace
        backLabel={
          workspaces.length > 1 ? t("backToWorkspaces") : t("backToDevices")
        }
        deviceName={deviceName}
        onBack={
          workspaces.length > 1
            ? () => setSelected(null)
            : () => void onDisconnect()
        }
        workspace={selected}
      />
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.pageHeader}>
        <View>
          <Text style={styles.eyebrow}>{deviceName}</Text>
          <Text style={styles.pageTitle}>{t("sessions")}</Text>
        </View>
        <PrimaryButton
          label={t("cancel")}
          onPress={() => void onDisconnect()}
          secondary
          style={styles.compactButton}
        />
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.accent} size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{t("genericError")}</Text>
          <PrimaryButton label={t("retry")} onPress={() => void load()} />
        </View>
      ) : workspaces.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>{t("noWorkspace")}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.workspaceList}>
          {workspaces.map((workspace) => (
            <Pressable
              key={workspace.id}
              onPress={() => setSelected(workspace)}
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

interface ConversationWorkspaceProps {
  backLabel: string;
  deviceName: string;
  onBack(): void;
  workspace: WorkspaceSummary;
}

function ConversationWorkspace({
  backLabel,
  deviceName,
  onBack,
  workspace
}: ConversationWorkspaceProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ambiguousSubmissionKeys, setAmbiguousSubmissionKeys] = useState<
    Record<string, boolean>
  >({});
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<WorkspaceAgentSessionMessage[]>([]);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sessions, setSessions] = useState<WorkspaceAgentSession[]>([]);
  const [selectedTargetID, setSelectedTargetID] = useState<string | null>(null);
  const [targets, setTargets] = useState<AgentTarget[]>([]);
  const latestVersion = useRef(0);
  const pendingSubmissions = useRef<Record<string, PendingSubmission>>({});
  const scroll = useRef<ScrollView>(null);
  const sessionsLoadSequence = useRef(0);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedID) ?? null,
    [selectedID, sessions]
  );
  const draftKey = creating ? "new" : (selectedID ?? "none");
  const draft = drafts[draftKey] ?? "";
  const ambiguousSubmission = ambiguousSubmissionKeys[draftKey] === true;
  const setDraft = (value: string) =>
    setDrafts((current) => ({ ...current, [draftKey]: value }));

  const loadSessions = useCallback(async () => {
    const sequence = ++sessionsLoadSequence.current;
    const response = await remoteTuttidClient.listWorkspaceAgentSessions(
      workspace.id,
      { limit: 100 }
    );
    if (sequence !== sessionsLoadSequence.current) {
      return;
    }
    const roots = response.sessions.filter(
      (session) => session.kind === "root" && session.visible
    );
    setSessions(roots);
    setSelectedID((current) =>
      current && roots.some((session) => session.id === current)
        ? current
        : (roots[0]?.id ?? null)
    );
  }, [workspace.id]);

  useEffect(() => {
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const schedulePoll = () => {
      if (active) {
        pollTimer = setTimeout(() => void poll(), 2_000);
      }
    };
    const poll = async () => {
      try {
        await loadSessions();
      } catch {
        if (active) {
          setError(true);
        }
      } finally {
        schedulePoll();
      }
    };
    const run = async () => {
      try {
        const [, catalog] = await Promise.all([
          loadSessions(),
          remoteTuttidClient.listAgentTargets()
        ]);
        if (active) {
          const enabled = catalog.targets.filter(
            (target) =>
              target.enabled &&
              (!target.availability || target.availability.status === "ready")
          );
          setTargets(enabled);
          setSelectedTargetID((current) =>
            current && enabled.some((target) => target.id === current)
              ? current
              : enabled.length === 1
                ? (enabled[0]?.id ?? null)
                : null
          );
          setError(false);
        }
      } catch {
        if (active) {
          setError(true);
        }
      } finally {
        if (active) {
          setLoading(false);
          schedulePoll();
        }
      }
    };
    void run();
    return () => {
      active = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [loadSessions]);

  useEffect(() => {
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    latestVersion.current = 0;
    setMessages([]);
    if (!selectedID) {
      return () => {
        active = false;
      };
    }
    const loadMessages = async () => {
      try {
        const response =
          await remoteTuttidClient.listWorkspaceAgentSessionMessages(
            workspace.id,
            selectedID,
            latestVersion.current > 0
              ? { afterVersion: latestVersion.current, order: "asc" }
              : { limit: 500, order: "asc" }
          );
        if (!active) {
          return;
        }
        latestVersion.current = Math.max(
          latestVersion.current,
          response.latestVersion
        );
        setMessages((current) =>
          mergeMessages(
            latestVersion.current === response.latestVersion &&
              current.length === 0
              ? []
              : current,
            response.messages
          )
        );
        setError(false);
      } catch {
        if (active) {
          setError(true);
        }
      } finally {
        if (active) {
          pollTimer = setTimeout(() => void loadMessages(), 1_000);
        }
      }
    };
    void loadMessages();
    return () => {
      active = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [selectedID, workspace.id]);

  const send = async () => {
    const text = draft.trim();
    if ((!selectedSession && !creating) || !text || sending) {
      return;
    }
    const existingSubmission = pendingSubmissions.current[draftKey] ?? null;
    const submission = resolvePendingSubmission(existingSubmission, {
      agentSessionID: selectedSession?.id ?? null,
      agentTargetID: selectedTargetID,
      creating,
      text
    });
    pendingSubmissions.current[draftKey] = submission;
    setSending(true);
    setDraft("");
    let delivered = false;
    try {
      if (creating) {
        if (!selectedTargetID) {
          throw new Error("agent target is required");
        }
        const created = await remoteTuttidClient.createWorkspaceAgentSession(
          workspace.id,
          {
            agentSessionId: submission.agentSessionID,
            agentTargetId: submission.agentTargetID!,
            clientSubmitId: submission.clientSubmitID,
            initialContent: [{ text, type: "text" }],
            submitDiagnostics: {
              blockCount: 1,
              promptLength: text.length,
              source: "mobile"
            }
          }
        );
        setCreating(false);
        setSelectedID(created.id);
      } else if (selectedSession) {
        await remoteTuttidClient.sendWorkspaceAgentSessionInput(
          workspace.id,
          selectedSession.id,
          {
            clientSubmitId: submission.clientSubmitID,
            content: [{ text, type: "text" }],
            submitDiagnostics: {
              blockCount: 1,
              promptLength: text.length,
              source: "mobile"
            }
          }
        );
      }
      delivered = true;
      delete pendingSubmissions.current[draftKey];
      setAmbiguousSubmissionKeys((current) => {
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
    } catch {
      setDraft(text);
      setError(true);
      setAmbiguousSubmissionKeys((current) => ({
        ...current,
        [draftKey]: true
      }));
    } finally {
      setSending(false);
    }
    if (delivered) {
      await loadSessions().catch(() => setError(true));
    }
  };

  const stop = async () => {
    if (!selectedSession?.activeTurnId) {
      return;
    }
    try {
      await remoteTuttidClient.cancelWorkspaceAgentTurn(
        workspace.id,
        selectedSession.id,
        selectedSession.activeTurnId
      );
      await loadSessions();
    } catch {
      setError(true);
    }
  };

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
            {selectedSession?.title || workspace.name}
          </Text>
          <Text numberOfLines={1} style={styles.deviceCaption}>
            {deviceName} · {workspace.name}
          </Text>
        </View>
        <View style={styles.onlineDot} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.accent} size="large" />
        </View>
      ) : selectedSession && !creating ? (
        <ScrollView
          contentContainerStyle={styles.messageList}
          onContentSizeChange={() =>
            scroll.current?.scrollToEnd({ animated: false })
          }
          ref={scroll}
        >
          {messages.length === 0 ? (
            <Text style={styles.emptyText}>{t("emptyConversation")}</Text>
          ) : (
            messages.map((message) => (
              <MobileMessageRow key={message.messageId} message={message} />
            ))
          )}
          {selectedSession.pendingInteractions.map((interaction) => (
            <MobileInteractionCard
              interaction={interaction}
              key={`${interaction.agentSessionId}:${interaction.turnId}:${interaction.requestId}`}
              onSubmit={async (input) => {
                await remoteTuttidClient.submitWorkspaceAgentInteractive(
                  workspace.id,
                  interaction.agentSessionId,
                  interaction.requestId,
                  { ...input, turnId: interaction.turnId }
                );
                await loadSessions();
              }}
            />
          ))}
        </ScrollView>
      ) : creating ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>{t("newSessionHint")}</Text>
          <ScrollView
            contentContainerStyle={styles.targetList}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {targets.map((target) => (
              <Pressable
                key={target.id}
                disabled={ambiguousSubmission}
                onPress={() => {
                  setSelectedTargetID(target.id);
                }}
                style={[
                  styles.targetChip,
                  target.id === selectedTargetID && styles.targetChipSelected
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

      {error ? (
        <Text style={styles.inlineError}>{t("genericError")}</Text>
      ) : null}
      {selectedSession || creating ? (
        <View style={styles.composer}>
          <TextInput
            editable={!sending && !ambiguousSubmission}
            multiline
            onChangeText={setDraft}
            placeholder={t("messageHint")}
            placeholderTextColor={theme.color.muted}
            style={styles.input}
            value={draft}
          />
          {selectedSession?.activeTurnId && !creating ? (
            <PrimaryButton
              label={t("stop")}
              onPress={() => void stop()}
              secondary
              style={styles.sendButton}
            />
          ) : (
            <PrimaryButton
              disabled={!draft.trim() || (creating && !selectedTargetID)}
              label={ambiguousSubmission ? t("retry") : t("send")}
              loading={sending}
              onPress={() => void send()}
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
                  key={session.id}
                  onPress={() => {
                    setCreating(false);
                    setSelectedID(session.id);
                    setDrawerOpen(false);
                  }}
                  style={[
                    styles.sessionCard,
                    session.id === selectedID && styles.sessionCardSelected
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
              disabled={targets.length === 0}
              label={t("newSession")}
              onPress={() => {
                setCreating(true);
                setSelectedID(null);
                setDrawerOpen(false);
              }}
            />
            <PrimaryButton label={backLabel} onPress={onBack} secondary />
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
  chevron: {
    color: theme.color.muted,
    fontSize: 30
  },
  close: {
    color: theme.color.textSecondary,
    fontSize: 32,
    lineHeight: 34
  },
  compactButton: {
    height: 40
  },
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
  conversationTitle: {
    flex: 1,
    marginHorizontal: theme.space.small
  },
  deviceCaption: {
    color: theme.color.muted,
    fontSize: 12,
    marginTop: 3
  },
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
  drawerList: {
    gap: theme.space.small,
    paddingVertical: theme.space.large
  },
  drawerScrim: {
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  drawerTitle: {
    color: theme.color.text,
    fontSize: 24,
    fontWeight: "700"
  },
  emptyText: {
    color: theme.color.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center"
  },
  error: {
    color: theme.color.danger,
    fontSize: 14
  },
  eyebrow: {
    color: theme.color.accent,
    fontSize: 12,
    fontWeight: "700"
  },
  iconButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44
  },
  iconText: {
    color: theme.color.text,
    fontSize: 22
  },
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
  messageList: {
    gap: theme.space.medium,
    padding: theme.space.large
  },
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
  pressed: {
    opacity: 0.7
  },
  root: {
    backgroundColor: theme.color.background,
    flex: 1
  },
  sendButton: {
    minWidth: 76
  },
  sessionCard: {
    backgroundColor: theme.color.panel,
    borderColor: theme.color.border,
    borderRadius: theme.radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    padding: theme.space.medium
  },
  sessionCardMeta: {
    color: theme.color.muted,
    fontSize: 12,
    marginTop: 6
  },
  sessionCardSelected: {
    borderColor: theme.color.accent
  },
  sessionCardTitle: {
    color: theme.color.text,
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 20
  },
  sessionTitle: {
    color: theme.color.text,
    fontSize: 16,
    fontWeight: "700"
  },
  targetChip: {
    borderColor: theme.color.border,
    borderRadius: theme.radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.space.medium,
    paddingVertical: theme.space.small
  },
  targetChipSelected: {
    borderColor: theme.color.accent
  },
  targetChipText: {
    color: theme.color.text,
    fontSize: 13
  },
  targetList: {
    gap: theme.space.small
  },
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
