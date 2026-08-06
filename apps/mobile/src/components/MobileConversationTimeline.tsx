import type { AgentConversationVM } from "@tutti-os/agent-gui/conversation-projection";
import { type NativeTheme, useNativeTheme } from "@tutti-os/ui-system/native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import type { WorkspaceMediaSnapshot } from "../services/workspaceMediaService";
import {
  MobileConversationImages,
  MobileGeneratedImage
} from "./MobileConversationImages";
import { MobileMarkdownText } from "./MobileMarkdownText";

type TranscriptRow = AgentConversationVM["rows"][number];
type MessageRow = Extract<TranscriptRow, { kind: "message" }>;
type ToolGroupRow = Extract<TranscriptRow, { kind: "tool-group" }>;
type ToolCall = ToolGroupRow["calls"][number];

/**
 * React Native rendering of the AgentGUI canonical conversation VM.
 *
 * AgentGUI owns the message, thinking, tool, processing, and turn-summary
 * projection. Mobile owns only compact touch-first presentation and local
 * disclosure state.
 */
export function MobileConversationTimeline({
  conversation,
  media,
  onLinkPress
}: {
  conversation: AgentConversationVM;
  media: WorkspaceMediaSnapshot;
  onLinkPress(href: string): boolean;
}) {
  return (
    <>
      {conversation.rows.map((row) => (
        <MobileTranscriptRow
          key={row.id}
          media={media}
          onLinkPress={onLinkPress}
          row={row}
        />
      ))}
    </>
  );
}

function MobileTranscriptRow({
  media,
  onLinkPress,
  row
}: {
  media: WorkspaceMediaSnapshot;
  onLinkPress(href: string): boolean;
  row: TranscriptRow;
}) {
  switch (row.kind) {
    case "message":
      return (
        <MobileMessageRow media={media} onLinkPress={onLinkPress} row={row} />
      );
    case "tool-group":
      return <MobileToolGroupRow onLinkPress={onLinkPress} row={row} />;
    case "processing":
      return <MobileProcessingRow label={row.label} />;
    case "turn-summary":
      return <MobileTurnSummaryRow row={row} />;
    case "goal-control":
      return <MobileGoalControlRow body={row.body} />;
    case "generated-image":
      return <MobileGeneratedImage prompt={row.prompt} uri={row.uri} />;
  }
}

function MobileMessageRow({
  media,
  onLinkPress,
  row
}: {
  media: WorkspaceMediaSnapshot;
  onLinkPress(href: string): boolean;
  row: MessageRow;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const user = row.speaker === "user";
  const messageBodies = row.messages.filter(
    (message) =>
      message.body.trim().length > 0 ||
      (message.images?.length ?? 0) > 0 ||
      Boolean(message.visibleError) ||
      Boolean(message.systemNotice)
  );

  return (
    <View
      style={[
        styles.message,
        user ? styles.userMessage : styles.assistantMessage
      ]}
    >
      <View
        accessible
        accessibilityLabel={user ? t("you") : t("agent")}
        accessibilityRole="text"
        style={styles.speakerAccessibilityLabel}
      />
      {row.thinking.map((thinking) => (
        <View key={thinking.id} style={styles.thinkingBlock}>
          <Text style={styles.thinkingLabel}>{t("reasoning")}</Text>
          {thinking.body.trim() ? (
            <MobileMarkdownText
              content={thinking.body}
              onLinkPress={onLinkPress}
              streaming={thinking.statusKind === "working"}
              textColor={theme.color.textSecondary}
            />
          ) : null}
        </View>
      ))}
      {messageBodies.map((message) => (
        <View key={message.id} style={styles.messageContent}>
          {message.systemNotice ? (
            <Text style={styles.noticeTitle}>
              {message.systemNotice.semanticKind === "context-recovery-pending"
                ? t("contextRecoveryScheduled")
                : message.systemNotice.title}
            </Text>
          ) : null}
          {message.body.trim() ? (
            <MobileMarkdownText
              content={message.body}
              onLinkPress={onLinkPress}
              streaming={message.statusKind === "working"}
              textColor={
                message.visibleError ? theme.color.danger : theme.color.text
              }
            />
          ) : null}
          {message.images?.length ? (
            <MobileConversationImages images={message.images} media={media} />
          ) : null}
          {message.systemNotice?.semanticKind === "context-recovery-pending" ? (
            <Text style={styles.noticeDetail}>
              {[
                t("contextRecoveryScheduledDetail"),
                message.systemNotice.detail
              ]
                .filter(Boolean)
                .join("\n")}
            </Text>
          ) : message.systemNotice?.detail ? (
            <Text style={styles.noticeDetail}>
              {message.systemNotice.detail}
            </Text>
          ) : null}
          {message.visibleError?.detail ? (
            <Text style={styles.errorText}>{message.visibleError.detail}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function MobileToolGroupRow({
  onLinkPress,
  row
}: {
  onLinkPress(href: string): boolean;
  row: ToolGroupRow;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [expanded, setExpanded] = useState(false);
  const label =
    row.summary?.trim() || t("toolCalls", { count: row.calls.length });
  const singleCall = row.calls[0];
  if (!row.grouped && singleCall) {
    return <MobileToolCallRow call={singleCall} />;
  }
  const hasDetails = row.entries.length > 0;

  return (
    <View style={styles.toolGroup}>
      <Pressable
        accessibilityLabel={expanded ? t("hideDetails") : t("showDetails")}
        accessibilityRole="button"
        accessibilityState={{ disabled: !hasDetails, expanded }}
        disabled={!hasDetails}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.toolHeader, pressed && styles.pressed]}
      >
        <View style={styles.toolHeaderText}>
          <Text numberOfLines={1} style={styles.toolTitle}>
            {label}
          </Text>
          <Text style={styles.toolMeta}>
            {row.calls.length === 1
              ? t("tool")
              : t("toolCalls", { count: row.calls.length })}
          </Text>
        </View>
        {hasDetails ? (
          <Text style={styles.disclosure}>{expanded ? "−" : "+"}</Text>
        ) : null}
      </Pressable>
      {expanded && hasDetails ? (
        <View style={styles.toolList}>
          {row.entries.map((entry) =>
            entry.kind === "thinking" ? (
              <View key={entry.thinking.id} style={styles.toolThinking}>
                <Text style={styles.thinkingLabel}>{t("reasoning")}</Text>
                {entry.thinking.body.trim() ? (
                  <MobileMarkdownText
                    content={entry.thinking.body}
                    onLinkPress={onLinkPress}
                    streaming={entry.thinking.statusKind === "working"}
                    textColor={theme.color.textSecondary}
                  />
                ) : null}
              </View>
            ) : (
              <MobileToolCallRow call={entry.call} key={entry.call.id} />
            )
          )}
        </View>
      ) : null}
    </View>
  );
}

function MobileToolCallRow({ call }: { call: ToolCall }) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const summary = call.compactSummary?.trim() || call.summary.trim();
  const status = toolStatusLabel(call.statusKind, call.status);
  return (
    <View style={styles.toolCall}>
      <View style={styles.toolCallHeader}>
        <Text style={styles.toolCallName}>{call.name}</Text>
        {status ? (
          <Text
            style={[
              styles.toolCallStatus,
              call.statusKind === "failed" && styles.toolCallStatusFailed
            ]}
          >
            {status}
          </Text>
        ) : null}
      </View>
      {summary ? (
        <Text numberOfLines={3} style={styles.toolCallSummary}>
          {summary}
        </Text>
      ) : null}
    </View>
  );
}

function toolStatusLabel(
  statusKind: ToolCall["statusKind"],
  status: ToolCall["status"]
): string {
  switch (statusKind) {
    case "working":
      return t("running");
    case "completed":
      return t("completed");
    case "failed":
      return t("failed");
    case "canceled":
      return t("canceled");
    case "waiting":
      return t("waiting");
    default:
      return status?.trim() || "";
  }
}

function MobileProcessingRow({ label }: { label: string | null | undefined }) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  return (
    <View accessibilityLiveRegion="polite" style={styles.processing}>
      <View style={styles.processingDot} />
      <Text style={styles.processingText}>
        {label?.trim() || t("processing")}
      </Text>
    </View>
  );
}

function MobileTurnSummaryRow({
  row
}: {
  row: Extract<TranscriptRow, { kind: "turn-summary" }>;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [expanded, setExpanded] = useState(false);
  const label = t("changedFiles", { count: row.fileCount });

  return (
    <View style={styles.turnSummary}>
      <Pressable
        accessibilityLabel={expanded ? t("hideDetails") : t("showDetails")}
        accessibilityRole="button"
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.toolHeader, pressed && styles.pressed]}
      >
        <Text style={styles.summaryTitle}>{label}</Text>
        <Text style={styles.disclosure}>{expanded ? "−" : "+"}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.fileList}>
          {row.files.map((file) => (
            <Text
              key={file.messageId}
              numberOfLines={1}
              style={styles.fileName}
            >
              {file.label}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function MobileGoalControlRow({ body }: { body: string }) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  return body.trim() ? (
    <View style={styles.goalControl}>
      <Text style={styles.goalControlText}>{body}</Text>
    </View>
  ) : null;
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    disclosure: { color: theme.color.muted, fontSize: 18, lineHeight: 18 },
    errorText: { color: theme.color.danger, fontSize: 14, lineHeight: 21 },
    fileList: { gap: theme.space.small, paddingTop: theme.space.small },
    fileName: { color: theme.color.textSecondary, fontSize: 13 },
    goalControl: {
      borderLeftColor: theme.color.accent,
      borderLeftWidth: 2,
      paddingHorizontal: theme.space.medium,
      paddingVertical: theme.space.small
    },
    goalControlText: {
      color: theme.color.textSecondary,
      fontSize: 13,
      lineHeight: 19
    },
    message: {
      alignSelf: "flex-start",
      borderRadius: theme.radius.large,
      gap: theme.space.small,
      maxWidth: "88%"
    },
    assistantMessage: {
      alignSelf: "stretch",
      maxWidth: "100%"
    },
    messageContent: { gap: theme.space.small },
    noticeDetail: {
      color: theme.color.textSecondary,
      fontSize: 14,
      lineHeight: 21
    },
    noticeTitle: { color: theme.color.text, fontSize: 14, fontWeight: "700" },
    pressed: { opacity: 0.72 },
    processing: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small,
      paddingHorizontal: theme.space.small,
      paddingVertical: theme.space.small
    },
    processingDot: {
      backgroundColor: theme.color.accent,
      borderRadius: 4,
      height: 8,
      width: 8
    },
    processingText: { color: theme.color.muted, fontSize: 13 },
    speakerAccessibilityLabel: {
      height: 1,
      position: "absolute",
      width: 1
    },
    summaryTitle: {
      color: theme.color.text,
      flex: 1,
      fontSize: 14,
      fontWeight: "700"
    },
    thinkingBlock: {
      backgroundColor: theme.color.background,
      borderRadius: theme.radius.medium,
      gap: 4,
      padding: theme.space.small
    },
    thinkingLabel: {
      color: theme.color.muted,
      fontSize: 11,
      fontWeight: "700"
    },
    toolCall: {
      borderTopColor: theme.color.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: 3,
      paddingTop: theme.space.small
    },
    toolCallHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small,
      justifyContent: "space-between"
    },
    toolCallName: { color: theme.color.text, fontSize: 13, fontWeight: "700" },
    toolCallStatus: { color: theme.color.muted, fontSize: 11 },
    toolCallStatusFailed: { color: theme.color.danger },
    toolCallSummary: {
      color: theme.color.textSecondary,
      fontSize: 13,
      lineHeight: 18
    },
    toolGroup: {
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      padding: theme.space.medium
    },
    toolHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small
    },
    toolHeaderText: { flex: 1, gap: 2 },
    toolList: { gap: theme.space.small, paddingTop: theme.space.small },
    toolMeta: { color: theme.color.muted, fontSize: 12 },
    toolThinking: {
      borderTopColor: theme.color.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: 4,
      paddingTop: theme.space.small
    },
    toolTitle: { color: theme.color.text, fontSize: 14, fontWeight: "700" },
    turnSummary: {
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      padding: theme.space.medium
    },
    userMessage: {
      alignSelf: "flex-end",
      backgroundColor: theme.color.panel,
      padding: theme.space.medium
    }
  });
}
