import type { NativeTheme } from "@tutti-os/ui-system/native";
import { StyleSheet } from "react-native";

export function createMobileActivityStyles(theme: NativeTheme) {
  return StyleSheet.create({
    actionButtonCompact: { flex: 1 },
    actionRow: { flexDirection: "row", gap: theme.space.small },
    backIcon: { color: theme.color.text, fontSize: 22 },
    bottomDock: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small,
      paddingVertical: theme.space.small
    },
    chatButton: {
      backgroundColor: theme.color.text,
      borderRadius: theme.control.large / 2,
      flexShrink: 0,
      height: theme.control.large,
      width: 104
    },
    chatIcon: { color: theme.color.background, fontSize: 18 },
    deleteDescription: { color: theme.color.textSecondary, lineHeight: 20 },
    empty: {
      color: theme.color.muted,
      padding: theme.space.xlarge,
      textAlign: "center"
    },
    emptyPriority: {
      color: theme.color.muted,
      paddingHorizontal: theme.space.small,
      paddingVertical: theme.space.small
    },
    feedback: {
      alignItems: "center",
      gap: theme.space.small,
      paddingVertical: theme.space.xlarge
    },
    feedbackText: { color: theme.color.textSecondary },
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between"
    },
    headerButton: {
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      height: 40,
      width: 40
    },
    infoBackdrop: {
      backgroundColor: theme.color.scrim,
      flex: 1,
      padding: theme.space.medium,
      paddingTop: 96
    },
    infoCard: {
      alignSelf: "flex-end",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      gap: theme.space.small,
      padding: theme.space.medium,
      width: "100%"
    },
    infoLabel: { color: theme.color.muted, fontSize: 13 },
    infoRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between"
    },
    infoTitle: { color: theme.color.text, fontWeight: "700" },
    infoValue: {
      color: theme.color.text,
      flexShrink: 1,
      fontSize: 13,
      textAlign: "right"
    },
    list: { gap: theme.space.medium, paddingBottom: theme.space.medium },
    loadMore: { alignItems: "center", padding: theme.space.medium },
    loadMoreLabel: { color: theme.color.accent, fontWeight: "600" },
    pendingDot: { backgroundColor: theme.color.accent },
    pressed: { opacity: 0.7 },
    renameInput: {
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      color: theme.color.text,
      minHeight: 48,
      paddingHorizontal: theme.space.medium
    },
    root: {
      backgroundColor: theme.color.background,
      flex: 1,
      padding: theme.space.medium
    },
    searchInput: {
      color: theme.color.text,
      flex: 1,
      fontSize: 15,
      height: "100%"
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
      paddingHorizontal: theme.space.medium
    },
    scroller: { flex: 1 },
    sections: { gap: 2 },
    sectionTitle: {
      color: theme.color.text,
      fontSize: 15,
      fontWeight: "600",
      marginTop: theme.space.small,
      paddingHorizontal: theme.space.small
    },
    sheet: {
      gap: theme.space.small,
      padding: theme.space.large
    },
    sheetTitle: { color: theme.color.textSecondary, fontWeight: "600" },
    projectDescription: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 1,
      gap: theme.space.small / 2
    },
    projectLabel: {
      color: theme.color.muted,
      flexShrink: 1,
      fontSize: theme.space.small
    },
    statusButton: {
      alignItems: "center",
      height: 40,
      justifyContent: "center",
      width: 40
    },
    statusDot: { borderRadius: 6, height: 12, width: 12 },
    sessionStatusActive: { backgroundColor: theme.color.accent },
    sessionStatusDot: { borderRadius: 3, height: 6, width: 6 },
    sessionStatusFailed: { backgroundColor: theme.color.danger },
    connectedDot: { backgroundColor: theme.color.success },
    failedDot: { backgroundColor: theme.color.danger },
    title: {
      color: theme.color.text,
      flex: 1,
      fontSize: 17,
      fontWeight: "600",
      textAlign: "center"
    },
    trailing: { alignItems: "center", flexDirection: "row", gap: 2 }
  });
}
