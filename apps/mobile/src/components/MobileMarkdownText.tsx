import {
  EnrichedMarkdownText,
  type MarkdownStyle
} from "react-native-enriched-markdown";
import { type NativeTheme, useNativeTheme } from "@tutti-os/ui-system/native";
import { useMemo } from "react";
import { Linking } from "react-native";
import { t } from "../i18n";

/**
 * Native presentation of AgentGUI-projected Markdown.
 *
 * Conversation semantics and content normalization remain owned by AgentGUI.
 * This component owns only the React Native renderer, its semantic-token theme,
 * and safe handoff of external links to the operating system.
 */
export function MobileMarkdownText({
  content,
  onLinkPress,
  streaming = false,
  textColor
}: {
  content: string;
  onLinkPress?: (href: string) => boolean;
  streaming?: boolean;
  textColor?: string;
}) {
  const theme = useNativeTheme();
  const markdownStyle = useMemo(
    () => createMarkdownStyle(theme, textColor ?? theme.color.text),
    [textColor, theme]
  );

  return (
    <EnrichedMarkdownText
      allowTrailingMargin={false}
      flavor="github"
      markdown={content}
      markdownStyle={markdownStyle}
      onLinkPress={({ url }) => {
        if (onLinkPress?.(url)) {
          return;
        }
        if (isSystemExternalLink(url)) {
          void Linking.openURL(url).catch(() => undefined);
        }
      }}
      selectable
      selectionColor={theme.color.accent}
      selectionHandleColor={theme.color.accent}
      selectionMenuConfig={{
        copy: { label: t("copy") },
        copyAsMarkdown: { label: t("copyAsMarkdown") },
        copyImageUrl: { label: t("copyImageUrl") }
      }}
      streamingAnimation={streaming}
      streamingConfig={{ tableMode: "progressive" }}
    />
  );
}

function isSystemExternalLink(value: string): boolean {
  const schemeEnd = value.indexOf(":");
  if (schemeEnd <= 0) {
    return false;
  }
  const scheme = value.slice(0, schemeEnd).toLowerCase();
  return (
    scheme === "https" ||
    scheme === "http" ||
    scheme === "mailto" ||
    scheme === "tel"
  );
}

function createMarkdownStyle(theme: NativeTheme, color: string): MarkdownStyle {
  return {
    blockquote: {
      backgroundColor: theme.color.background,
      borderColor: theme.color.border,
      borderWidth: 2,
      color,
      gapWidth: theme.space.small,
      lineHeight: 23,
      marginBottom: theme.space.small
    },
    code: {
      backgroundColor: theme.color.background,
      borderColor: theme.color.border,
      color,
      fontSize: 14
    },
    codeBlock: {
      backgroundColor: theme.color.background,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: 1,
      color,
      fontSize: 14,
      lineHeight: 21,
      marginBottom: theme.space.small,
      padding: theme.space.medium
    },
    h1: headingStyle(theme, color, 22),
    h2: headingStyle(theme, color, 20),
    h3: headingStyle(theme, color, 18),
    h4: headingStyle(theme, color, 17),
    h5: headingStyle(theme, color, 16),
    h6: headingStyle(theme, color, 16),
    link: { color: theme.color.accent, underline: true },
    linkVariants: {
      "^mention://": {
        backgroundColor: theme.color.panelRaised,
        color: theme.color.accent,
        underline: false
      }
    },
    list: {
      bulletColor: theme.color.muted,
      color,
      gapWidth: theme.space.small,
      lineHeight: 24,
      marginBottom: theme.space.small,
      marginLeft: theme.space.medium,
      markerColor: theme.color.muted,
      markerFontWeight: "600"
    },
    paragraph: {
      color,
      fontSize: 16,
      lineHeight: 24,
      marginBottom: theme.space.small
    },
    table: {
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: 1,
      cellPaddingHorizontal: theme.space.small,
      cellPaddingVertical: theme.space.small,
      color,
      fontSize: 14,
      headerBackgroundColor: theme.color.panelRaised,
      headerTextColor: theme.color.text,
      rowEvenBackgroundColor: theme.color.panel,
      rowOddBackgroundColor: theme.color.background
    },
    taskList: {
      borderColor: theme.color.border,
      checkedColor: theme.color.accent,
      checkmarkColor: theme.color.background
    }
  };
}

function headingStyle(theme: NativeTheme, color: string, fontSize: number) {
  return {
    color,
    fontSize,
    fontWeight: "700",
    lineHeight: fontSize + 6,
    marginBottom: theme.space.small,
    marginTop: theme.space.small
  } as const;
}
