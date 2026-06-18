import type { UiLanguage } from "../../contexts/settings/domain/agentSettings";
import { normalizeAgentTitleText } from "./agentTitleText";

const MARKDOWN_LINK_PATTERN = /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;
const MARKDOWN_LABEL_ESCAPE_PATTERN = /\\([\\[\]()])/g;
const SESSION_MENTION_DISPLAY_PREFIX_BY_LANGUAGE: Record<UiLanguage, string> = {
  "zh-CN": "@会话 · ",
  en: "@session · "
};
const PLAIN_SESSION_AGENT_LABELS = [
  "Claude Code",
  "Gemini CLI",
  "Hermes Agent",
  "OpenClaw",
  "Nexight",
  "Gemini",
  "Hermes",
  "Codex"
] as const;

export interface FormatAgentSessionMentionTextOptions {
  language?: UiLanguage;
}

export function formatAgentSessionMentionText(
  value: string | null | undefined,
  options: FormatAgentSessionMentionTextOptions = {}
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const sessionMentionDisplayPrefix = sessionMentionDisplayPrefixForLanguage(
    options.language
  );

  const withSessionMentionsNormalized = trimmed.replace(
    MARKDOWN_LINK_PATTERN,
    (fullMatch, rawLabel: string, href: string) => {
      const normalizedHref = href.trim().toLowerCase();
      if (normalizedHref.startsWith("mention://agent-session")) {
        return formatSessionLabel(
          unescapeMarkdownLabel(rawLabel),
          sessionMentionDisplayPrefix
        );
      }
      if (normalizedHref.startsWith("mention://workspace-issue")) {
        return formatIssueLabel(unescapeMarkdownLabel(rawLabel));
      }
      if (!normalizedHref.startsWith("mention://")) {
        return fullMatch;
      }
      return unescapeMarkdownLabel(rawLabel);
    }
  );
  const normalized = normalizeAgentTitleText(withSessionMentionsNormalized);
  if (isPlainSessionMentionText(normalized, sessionMentionDisplayPrefix)) {
    return formatSessionLabel(normalized, sessionMentionDisplayPrefix);
  }
  return normalized;
}

function isPlainSessionMentionText(
  value: string,
  sessionMentionDisplayPrefix: string
): boolean {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("@") ||
    trimmed.startsWith(sessionMentionDisplayPrefix)
  ) {
    return false;
  }

  return PLAIN_SESSION_AGENT_LABELS.some((agentLabel) => {
    const ampersandSeparator = ` & ${agentLabel}`;
    const ampersandIndex = trimmed.indexOf(ampersandSeparator);
    if (ampersandIndex > 1) {
      const trailing = trimmed.slice(
        ampersandIndex + ampersandSeparator.length
      );
      if (trailing === "" || trailing.startsWith(" ")) {
        return true;
      }
    }

    const dottedSeparator = ` · ${agentLabel} · `;
    return trimmed.indexOf(dottedSeparator) > 1;
  });
}

function sessionMentionDisplayPrefixForLanguage(
  language: UiLanguage | undefined
): string {
  return SESSION_MENTION_DISPLAY_PREFIX_BY_LANGUAGE[language ?? "en"];
}

function formatSessionLabel(
  label: string,
  sessionMentionDisplayPrefix: string
): string {
  const normalizedLabel = label.trim().replace(/^@+/, "").trim();
  return normalizedLabel
    ? `${sessionMentionDisplayPrefix}${normalizedLabel}`
    : label.trim();
}

function formatIssueLabel(label: string): string {
  const normalizedLabel = label.trim().replace(/^@+/, "").trim();
  return normalizedLabel ? `@Task · ${normalizedLabel}` : label.trim();
}

function unescapeMarkdownLabel(label: string): string {
  return label.replace(MARKDOWN_LABEL_ESCAPE_PATTERN, "$1");
}
