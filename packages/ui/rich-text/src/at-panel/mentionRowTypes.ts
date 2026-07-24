import type { ReactNode } from "react";
import type { MentionFileVisualKind } from "./mentionFileVisualKind.ts";
import type {
  MentionRowStatusTone,
  MentionRowStatusVariant
} from "./mentionStatusTone.ts";

/**
 * A fully-resolved, display-ready status badge for a {@link MentionRowItem}.
 * The surface resolves the localized {@link label} and {@link tone}; the shared
 * row renderer only maps tone → className and renders the markup.
 */
export interface MentionRowStatusTag {
  label: string;
  tone: MentionRowStatusTone;
  /** Whether the status dot should pulse (activity variant only). */
  pulse?: boolean;
  variant: MentionRowStatusVariant;
  /**
   * Stable `data-status` attribute value (e.g. the normalized activity status
   * or issue status) preserved so existing DOM assertions keep matching.
   */
  dataStatus?: string;
}

export interface MentionRowFileItem {
  kind: "file";
  name: string;
  visualKind: MentionFileVisualKind;
  thumbnailUrl?: string | null;
  childCountLabel?: string | null;
  /** Optional file entry kind surfaced as a row data attribute. */
  entryKind?: string | null;
  /** Optional navigation marker surfaced as a row data attribute. */
  mentionNavigation?: string | null;
}

export interface MentionRowAppItem {
  kind: "app";
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  /** Optional availability badge rendered at the row's trailing edge. */
  statusTag?: MentionRowStatusTag | null;
}

export interface MentionRowAppFactoryItem {
  kind: "app-factory";
  name: string;
}

export interface MentionRowSessionItem {
  kind: "session";
  /** The "Initiator & Agent" participant line. */
  participant: string;
  /** Participant entities that truncate independently before the fixed suffix. */
  participantTruncatableSegments?: readonly string[] | null;
  /** Fixed separator rendered between independently truncatable entities. */
  participantSegmentSeparator?: string | null;
  /** Optional fixed participant suffix, including its separator. */
  participantFixedSuffix?: string | null;
  summary?: string | null;
  userAvatarUrl?: string | null;
  userAvatarPlaceholderUrl: string;
  agentIconUrl: string;
  /** When false, only the agent avatar is shown (e.g. local/my sessions). */
  showUserAvatar?: boolean;
  statusTag?: MentionRowStatusTag | null;
}

export interface MentionRowIssueItem {
  kind: "issue";
  title: string;
  creatorName?: string | null;
  statusTag?: MentionRowStatusTag | null;
}

export interface MentionRowPlainItem {
  kind: "plain";
  label: string;
  description?: string | null;
  leading?: ReactNode;
}

/**
 * The kind-discriminated view-model the shared {@link MentionRow} renders.
 * Carries ONLY display-ready fields — no surface types, no i18n calls, no asset
 * imports. Every surface maps its own items onto this so the rendered row stays
 * consistent across shared mention surfaces.
 */
export type MentionRowItem =
  | MentionRowFileItem
  | MentionRowAppItem
  | MentionRowAppFactoryItem
  | MentionRowSessionItem
  | MentionRowIssueItem
  | MentionRowPlainItem;
