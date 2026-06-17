/**
 * Tone → className maps for the {@link MentionStatusBadge} rendered inside a
 * {@link MentionRow}. The surface resolves a status into a data-only
 * {@link MentionRowStatusTag} (label + tone + variant); this module owns the
 * presentational mapping so the styling stays in one place and identical across
 * surfaces.
 */
export type MentionRowStatusTone =
  | "amber"
  | "blue"
  | "green"
  | "neutral"
  | "red";

export type MentionRowStatusVariant = "activity" | "issue";

/**
 * Background/text classes for the agent activity status badge. Ported verbatim
 * from the agent's `mentionStatusBadgeClassName` so the rendered DOM is
 * unchanged.
 */
export function activityMentionStatusBadgeClassName(
  tone: MentionRowStatusTone
): string {
  switch (tone) {
    case "blue":
      return "bg-sky-500/10 text-sky-700";
    case "amber":
      return "bg-[color:color-mix(in_srgb,var(--color-amber-500)_12%,transparent)] text-[var(--color-amber-500)]";
    case "green":
      return "bg-[var(--tsh-ui-pill-success-bg)] text-[var(--tsh-ui-pill-success-fg)]";
    case "red":
      return "bg-[var(--on-danger)] text-[var(--state-danger)]";
    default:
      return "bg-[var(--transparency-block)] text-[var(--text-secondary)]";
  }
}

/**
 * Background/text classes for the issue status badge. Ported verbatim from the
 * agent's `issueMentionStatusBadgeClassName` (keyed by the issue tone the
 * surface resolves).
 */
export function issueMentionStatusBadgeClassName(
  tone: MentionRowStatusTone
): string {
  switch (tone) {
    case "green":
      return "bg-[color:color-mix(in_srgb,var(--state-success)_12%,transparent)] text-[var(--state-success)]";
    case "red":
      return "bg-[var(--on-danger)] text-[var(--state-danger)]";
    default:
      return "bg-[var(--transparency-block)] text-[var(--text-secondary)]";
  }
}

export function mentionStatusBadgeClassName(input: {
  tone: MentionRowStatusTone;
  variant: MentionRowStatusVariant;
}): string {
  return input.variant === "issue"
    ? issueMentionStatusBadgeClassName(input.tone)
    : activityMentionStatusBadgeClassName(input.tone);
}

/**
 * Map a normalized agent-activity display status to its badge tone. Shared by
 * every `@`-mention surface that renders a session row (agent composer,
 * issue-manager) so the activity status badge color is identical across
 * surfaces. Mirrors the agent composer's local `mentionStatusTone` mapping
 * verbatim (the agent keeps its own copy producing identical values). The label
 * is resolved by each surface; only the tone lives here.
 */
export function activityMentionStatusTone(
  status: string
): MentionRowStatusTone {
  switch (status.trim().toLowerCase()) {
    case "working":
      return "blue";
    case "waiting":
    case "canceled":
      return "amber";
    case "completed":
    case "idle":
      return "green";
    case "failed":
      return "red";
    default:
      return "neutral";
  }
}

/**
 * Map an issue status string to its badge tone. Shared by every `@`-mention
 * surface that renders an issue row (agent composer, issue-manager) so the
 * status badge color is identical across surfaces. The label is resolved by
 * each surface's own i18n; only the tone lives here.
 */
export function issueMentionStatusTone(status: string): MentionRowStatusTone {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "green";
    case "failed":
    case "canceled":
      return "red";
    default:
      return "neutral";
  }
}
