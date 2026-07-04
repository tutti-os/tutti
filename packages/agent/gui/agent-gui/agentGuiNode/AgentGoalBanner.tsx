import type { JSX } from "react";
import { Target } from "lucide-react";
import { cn } from "../../app/renderer/lib/utils";
import styles from "./AgentGUIChrome.styles";

export interface AgentGoalBannerLabels {
  goalLabel: string;
  statusActive: string;
  statusPaused: string;
  statusBlocked: string;
  statusUsageLimited: string;
  statusBudgetLimited: string;
  statusComplete: string;
  budgetUsage: (used: number, budget: number) => string;
  clearHint: string;
}

export interface AgentGoalBannerProps {
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed?: number;
  labels: AgentGoalBannerLabels;
}

// Statuses that mean the goal is finished. We hide the banner for these so a
// trivial objective that Codex immediately marks complete does not linger above
// the composer.
const TERMINAL_GOAL_STATUSES = new Set(["complete", "completed", "done"]);

function normalizeGoalStatus(status: string | null | undefined): string {
  return (status ?? "").trim().toLowerCase();
}

/**
 * Decide whether the goal banner should render. Visible only when an objective
 * is set and the goal has not reached a terminal status.
 */
export function isGoalBannerVisible(
  objective: string | null | undefined,
  status: string | null | undefined
): boolean {
  if ((objective ?? "").trim() === "") {
    return false;
  }
  return !TERMINAL_GOAL_STATUSES.has(normalizeGoalStatus(status));
}

export function goalStatusLabel(
  status: string,
  labels: AgentGoalBannerLabels
): string {
  switch (normalizeGoalStatus(status)) {
    case "paused":
      return labels.statusPaused;
    case "blocked":
      return labels.statusBlocked;
    case "usagelimited":
      return labels.statusUsageLimited;
    case "budgetlimited":
      return labels.statusBudgetLimited;
    case "complete":
    case "completed":
    case "done":
      return labels.statusComplete;
    default:
      return labels.statusActive;
  }
}

export function describeGoal(input: {
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed?: number;
  labels: AgentGoalBannerLabels;
}): string {
  const trimmedObjective = input.objective.trim();
  const detailParts = [goalStatusLabel(input.status, input.labels)];
  if (typeof input.tokenBudget === "number" && input.tokenBudget > 0) {
    const used =
      typeof input.tokensUsed === "number" && input.tokensUsed >= 0
        ? input.tokensUsed
        : 0;
    detailParts.push(input.labels.budgetUsage(used, input.tokenBudget));
  }
  return `${trimmedObjective} · ${detailParts.join(" · ")}`;
}

/**
 * Persistent banner that surfaces the active thread goal directly above the
 * composer, in the same dock slot as the session error/notice chrome. Reuses
 * the muted chrome card styling so it reads as informational, not an error.
 *
 * Read-only by design: clearing the goal is done by typing `/goal clear` in the
 * composer. The banner only hints at that command rather than offering its own
 * (potentially destructive) control.
 */
export function AgentGoalBanner({
  objective,
  status,
  tokenBudget,
  tokensUsed,
  labels
}: AgentGoalBannerProps): JSX.Element {
  "use memo";
  const description = describeGoal({
    objective,
    status,
    tokenBudget,
    tokensUsed,
    labels
  });
  const fullMessage = `${labels.goalLabel} ${description}`;
  return (
    <div className={styles.sessionChrome}>
      <section
        className={cn(styles.chromeCard, styles.chromeCardMuted)}
        role="status"
        data-testid="agent-gui-goal-banner"
      >
        <div className={styles.chromeMetaRow}>
          <div className={styles.chromeMessageSlot}>
            <span className={styles.chromeIcon}>
              <Target aria-hidden className="size-3.5" />
            </span>
            <p
              className={cn(styles.chromeMessage, styles.chromeNoticeMessage)}
              title={fullMessage}
            >
              <span className={styles.chromeNoticeTitle}>
                {labels.goalLabel}
              </span>
              <span className={styles.chromeNoticeDescription}>
                {description}
              </span>
            </p>
          </div>
          <span
            className={styles.chromeGoalHint}
            data-testid="agent-gui-goal-banner-clear-hint"
          >
            {labels.clearHint}
          </span>
        </div>
      </section>
    </div>
  );
}
