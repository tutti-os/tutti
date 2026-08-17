import type { AgentConversationVM } from "@tutti-os/agent-gui/conversation-projection";
import {
  NativeControlGlyph,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
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
type ThinkingContent = MessageRow["thinking"][number];
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
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  return (
    <>
      {conversation.rows.map((row) => (
        <View key={row.id} style={styles.rowFrame}>
          <MobileTranscriptRow
            media={media}
            onLinkPress={onLinkPress}
            row={row}
          />
        </View>
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
        <MobileThinkingBlock
          key={thinking.id}
          onLinkPress={onLinkPress}
          thinking={thinking}
        />
      ))}
      {messageBodies.map((message) => (
        <View key={message.id} style={styles.messageContent}>
          {message.systemNotice ? (
            <Text
              style={[
                styles.noticeTitle,
                message.systemNotice.semanticKind ===
                  "context-handoff-required" && styles.noticeErrorTitle
              ]}
            >
              {message.systemNotice.semanticKind === "context-handoff-required"
                ? t("contextHandoffRequired")
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
          {message.systemNotice?.semanticKind === "context-handoff-required" ? (
            <Text style={styles.noticeDetail}>
              {[t("contextHandoffRequiredDetail"), message.systemNotice.detail]
                .filter(Boolean)
                .join("\n")}
            </Text>
          ) : message.systemNotice?.detail ? (
            <Text style={styles.noticeDetail}>
              {message.systemNotice.detail}
            </Text>
          ) : null}
          {message.visibleError?.detail ? (
            message.visibleError.detailAvailable ? (
              <MobileRawErrorDisclosure detail={message.visibleError.detail} />
            ) : (
              <Text style={styles.errorText}>
                {message.visibleError.detail}
              </Text>
            )
          ) : null}
        </View>
      ))}
    </View>
  );
}

function MobileThinkingBlock({
  onLinkPress,
  thinking
}: {
  onLinkPress(href: string): boolean;
  thinking: ThinkingContent;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const hasBody = thinking.body.trim().length > 0;
  const statusKind = thinking.statusKind ?? null;
  const statusLabel = toolStatusLabel(statusKind, null);
  const [expanded, setExpanded] = useState(
    hasBody &&
      (statusKind === "working" ||
        statusKind === "failed" ||
        statusKind === "waiting")
  );
  const accessibilityLabel = [
    t("reasoning"),
    statusLabel,
    hasBody ? (expanded ? t("hideDetails") : t("showDetails")) : null
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <View style={styles.thinkingBlock}>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: !hasBody, expanded }}
        disabled={!hasBody}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [
          styles.thinkingHeader,
          pressed && styles.pressed
        ]}
      >
        <View style={styles.disclosureHeaderLine}>
          <NativeControlGlyph
            color={toolStatusColor(theme, statusKind)}
            size={8}
            variant="status"
          />
          <Text style={styles.thinkingLabel}>{t("reasoning")}</Text>
          {statusLabel ? (
            <Text style={styles.thinkingStatus}>{statusLabel}</Text>
          ) : null}
          {hasBody ? (
            <NativeControlGlyph
              color={theme.color.muted}
              direction={expanded ? "up" : "down"}
              size={16}
              variant="chevron"
            />
          ) : null}
        </View>
      </Pressable>
      {expanded && hasBody ? (
        <View style={styles.thinkingBody}>
          <MobileMarkdownText
            content={thinking.body}
            onLinkPress={onLinkPress}
            streaming={statusKind === "working"}
            textColor={theme.color.textSecondary}
          />
        </View>
      ) : null}
    </View>
  );
}

function MobileRawErrorDisclosure({ detail }: { detail: string }) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.errorDisclosureContainer}>
      <Pressable
        accessibilityLabel={expanded ? t("hideRawError") : t("showRawError")}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [
          styles.errorDisclosure,
          pressed && styles.pressed
        ]}
      >
        <Text style={styles.errorDisclosureLabel}>{t("rawError")}</Text>
        <NativeControlGlyph
          color={theme.color.danger}
          direction={expanded ? "up" : "down"}
          size={16}
          variant="chevron"
        />
      </Pressable>
      {expanded ? <Text style={styles.errorText}>{detail}</Text> : null}
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
  const label =
    row.summary?.trim() || t("toolCalls", { count: row.calls.length });
  const singleCall = row.calls[0];
  const hasDetails = row.entries.length > 0;
  const statusKind = toolGroupStatusKind(row.calls);
  const statusLabel = toolStatusLabel(statusKind, null);
  const countLabel =
    row.calls.length === 1
      ? t("tool")
      : t("toolCalls", { count: row.calls.length });
  const [expanded, setExpanded] = useState(
    hasDetails &&
      (statusKind === "working" ||
        statusKind === "failed" ||
        statusKind === "waiting")
  );
  if (!row.grouped && singleCall) {
    return (
      <View style={styles.toolGroup}>
        <MobileToolCallRow call={singleCall} />
      </View>
    );
  }
  const accessibilityLabel = [
    label,
    statusLabel,
    hasDetails ? (expanded ? t("hideDetails") : t("showDetails")) : null
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <View style={styles.toolGroup}>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: !hasDetails, expanded }}
        disabled={!hasDetails}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.toolHeader, pressed && styles.pressed]}
      >
        <View style={styles.disclosureHeaderLine}>
          <NativeControlGlyph
            color={toolStatusColor(theme, statusKind)}
            size={8}
            variant="status"
          />
          <View style={styles.toolHeaderText}>
            <Text numberOfLines={1} style={styles.toolTitle}>
              {label}
            </Text>
            <Text style={styles.toolMeta}>
              {[countLabel, statusLabel].filter(Boolean).join(" · ")}
            </Text>
          </View>
          {hasDetails ? (
            <NativeControlGlyph
              color={theme.color.muted}
              direction={expanded ? "up" : "down"}
              size={16}
              variant="chevron"
            />
          ) : null}
        </View>
      </Pressable>
      {expanded && hasDetails ? (
        <View style={styles.toolList}>
          {row.entries.map((entry) =>
            entry.kind === "thinking" ? (
              <MobileThinkingBlock
                key={entry.thinking.id}
                onLinkPress={onLinkPress}
                thinking={entry.thinking}
              />
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
      <View style={styles.toolCallStatusDot}>
        <NativeControlGlyph
          color={toolStatusColor(theme, call.statusKind)}
          size={8}
          variant="status"
        />
      </View>
      <View style={styles.toolCallContent}>
        <View style={styles.toolCallHeader}>
          <Text numberOfLines={1} style={styles.toolCallName}>
            {call.name}
          </Text>
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
          <Text numberOfLines={2} style={styles.toolCallSummary}>
            {summary}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function toolGroupStatusKind(
  calls: readonly ToolCall[]
): ToolCall["statusKind"] {
  for (const statusKind of [
    "failed",
    "working",
    "waiting",
    "canceled",
    "completed"
  ] as const) {
    if (calls.some((call) => call.statusKind === statusKind)) return statusKind;
  }
  return null;
}

function toolStatusColor(
  theme: NativeTheme,
  statusKind: ToolCall["statusKind"]
): string {
  switch (statusKind) {
    case "working":
      return theme.color.accent;
    case "completed":
      return theme.color.success;
    case "failed":
      return theme.color.danger;
    case "canceled":
    case "waiting":
    default:
      return theme.color.muted;
  }
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
      <NativeControlGlyph
        color={theme.color.accent}
        size={8}
        variant="status"
      />
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
        <View style={styles.disclosureHeaderLine}>
          <Text style={styles.summaryTitle}>{label}</Text>
          <NativeControlGlyph
            color={theme.color.muted}
            direction={expanded ? "up" : "down"}
            size={16}
            variant="chevron"
          />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.fileList}>
          {row.files.map((file) => (
            <View key={file.messageId} style={styles.fileRow}>
              <NativeControlGlyph
                color={theme.color.muted}
                size={6}
                variant="status"
              />
              <Text numberOfLines={1} style={styles.fileName}>
                {file.label}
              </Text>
            </View>
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
    errorDisclosure: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small,
      justifyContent: "space-between",
      minHeight: theme.control.regular
    },
    errorDisclosureContainer: { marginTop: theme.space.small },
    errorDisclosureLabel: { color: theme.color.danger, fontSize: 13 },
    errorText: { color: theme.color.danger, fontSize: 14, lineHeight: 21 },
    disclosureHeaderLine: {
      alignItems: "center",
      alignSelf: "stretch",
      flexDirection: "row",
      gap: theme.space.small,
      paddingHorizontal: theme.space.medium
    },
    fileList: {
      borderTopColor: theme.color.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: theme.space.small,
      paddingHorizontal: theme.space.medium,
      paddingVertical: theme.space.small
    },
    fileName: {
      color: theme.color.textSecondary,
      flex: 1,
      fontSize: 13
    },
    fileRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small,
      minHeight: theme.control.compact
    },
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
      maxWidth: "86%"
    },
    assistantMessage: {
      alignSelf: "stretch",
      marginBottom: theme.space.small,
      maxWidth: "100%",
      paddingVertical: theme.space.small
    },
    messageContent: { gap: theme.space.small },
    noticeDetail: {
      color: theme.color.textSecondary,
      fontSize: 14,
      lineHeight: 21
    },
    noticeErrorTitle: { color: theme.color.danger },
    noticeTitle: { color: theme.color.text, fontSize: 14, fontWeight: "700" },
    pressed: { opacity: 0.72 },
    processing: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small,
      minHeight: theme.control.compact,
      paddingHorizontal: theme.space.medium
    },
    processingText: { color: theme.color.muted, fontSize: 13 },
    rowFrame: {
      alignSelf: "center",
      maxWidth: 760,
      width: "100%"
    },
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
      borderLeftColor: theme.color.border,
      borderLeftWidth: 2,
      marginVertical: 2
    },
    thinkingBody: {
      paddingBottom: theme.space.small,
      paddingHorizontal: theme.space.medium
    },
    thinkingHeader: {
      justifyContent: "center",
      minHeight: theme.control.regular
    },
    thinkingLabel: {
      color: theme.color.muted,
      flex: 1,
      fontSize: 13,
      fontWeight: "700"
    },
    thinkingStatus: { color: theme.color.muted, fontSize: 11 },
    toolCall: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: theme.space.small,
      minHeight: theme.control.regular,
      paddingHorizontal: theme.space.medium,
      paddingVertical: theme.space.small
    },
    toolCallContent: { flex: 1, gap: 3, minWidth: 0 },
    toolCallHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small,
      justifyContent: "space-between"
    },
    toolCallName: {
      color: theme.color.text,
      flex: 1,
      fontSize: 13,
      fontWeight: "700"
    },
    toolCallStatus: { color: theme.color.muted, fontSize: 11 },
    toolCallStatusFailed: { color: theme.color.danger },
    toolCallSummary: {
      color: theme.color.textSecondary,
      fontSize: 13,
      lineHeight: 18
    },
    toolCallStatusDot: { paddingTop: 5 },
    toolGroup: {
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden"
    },
    toolHeader: {
      justifyContent: "center",
      minHeight: theme.control.regular,
      paddingVertical: theme.space.small
    },
    toolHeaderText: { flex: 1, gap: 2, minWidth: 0 },
    toolList: {
      borderTopColor: theme.color.border,
      borderTopWidth: StyleSheet.hairlineWidth
    },
    toolMeta: { color: theme.color.muted, fontSize: 12 },
    toolTitle: { color: theme.color.text, fontSize: 14, fontWeight: "700" },
    turnSummary: {
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden"
    },
    userMessage: {
      alignSelf: "flex-end",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: theme.space.medium,
      paddingHorizontal: theme.space.medium,
      paddingVertical: theme.space.small
    }
  });
}
