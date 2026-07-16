import { useEffect, useState, type JSX } from "react";
import { CirclePause, CirclePlay, Pencil, Target, Trash2 } from "lucide-react";
import { cn } from "../../app/renderer/lib/utils";
import styles from "./AgentGUIChrome.styles";

export interface AgentGoalBannerLabels {
  titleActive: string;
  titlePaused: string;
  titleBlocked: string;
  titleUsageLimited: string;
  titleBudgetLimited: string;
  titleComplete: string;
  budgetUsage: (used: number, budget: number) => string;
  clearHint: string;
  editAction: string;
  pauseAction: string;
  resumeAction: string;
  clearAction: string;
}

export interface AgentGoalBannerProps {
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed?: number;
  durationMs?: number;
  optimistic?: boolean;
  labels: AgentGoalBannerLabels;
  /** Called with the edited objective when the inline edit is confirmed. */
  onEditObjective?: (objective: string) => void;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  onClearGoal?: () => void;
}

// Statuses from which the goal can be resumed with /goal active.
const RESUMABLE_GOAL_STATUSES = new Set([
  "paused",
  "blocked",
  "usagelimited",
  "budgetlimited"
]);

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

/** Leading banner title carrying the goal status ("Active goal" / 进行中的目标). */
export function goalStatusTitle(
  status: string,
  labels: AgentGoalBannerLabels
): string {
  switch (normalizeGoalStatus(status)) {
    case "paused":
      return labels.titlePaused;
    case "blocked":
      return labels.titleBlocked;
    case "usagelimited":
      return labels.titleUsageLimited;
    case "budgetlimited":
      return labels.titleBudgetLimited;
    case "complete":
    case "completed":
    case "done":
      return labels.titleComplete;
    default:
      return labels.titleActive;
  }
}

/** Compact elapsed-time rendering matching the codex goal bar: 42s, 5m 12s, 1h 4m. */
export function formatGoalElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

export function describeGoal(input: {
  objective: string;
  elapsedSeconds?: number | null;
  tokenBudget?: number;
  tokensUsed?: number;
  labels: AgentGoalBannerLabels;
}): string {
  const detailParts = [input.objective.trim()];
  if (typeof input.elapsedSeconds === "number") {
    detailParts.push(formatGoalElapsed(input.elapsedSeconds));
  }
  if (typeof input.tokenBudget === "number" && input.tokenBudget > 0) {
    const used =
      typeof input.tokensUsed === "number" && input.tokensUsed >= 0
        ? input.tokensUsed
        : 0;
    detailParts.push(input.labels.budgetUsage(used, input.tokenBudget));
  }
  return detailParts.join(" · ");
}

/**
 * Persistent banner that surfaces the active thread goal directly above the
 * composer, in the same dock slot as the session error/notice chrome, aligned
 * with the codex desktop goal bar: "<status title> <objective> · <elapsed>"
 * plus icon controls for edit / pause-resume / delete.
 *
 * The elapsed time is the server-reported canonical durationMs; while the goal
 * is active the banner ticks it forward locally between goal updates.
 * Optimistic Goal projections never show or start the timer; after canonical
 * provider state arrives, an omitted zero-valued duration starts from zero.
 */
export function AgentGoalBanner({
  objective,
  status,
  tokenBudget,
  tokensUsed,
  durationMs,
  optimistic = false,
  labels,
  onEditObjective,
  onPauseGoal,
  onResumeGoal,
  onClearGoal
}: AgentGoalBannerProps): JSX.Element {
  "use memo";
  // null = not editing; otherwise the in-progress edit text.
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const normalizedStatus = normalizeGoalStatus(status);
  const isActive = normalizedStatus === "" || normalizedStatus === "active";
  const serverSeconds = optimistic
    ? null
    : typeof durationMs === "number" && durationMs >= 0
      ? Math.floor(durationMs / 1000)
      : isActive
        ? 0
        : null;
  const [localElapsed, setLocalElapsed] = useState(0);
  useEffect(() => {
    setLocalElapsed(0);
    if (!isActive || serverSeconds === null) {
      return;
    }
    const startedAtMs = Date.now();
    const timer = window.setInterval(() => {
      setLocalElapsed(Math.floor((Date.now() - startedAtMs) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isActive, serverSeconds]);
  const elapsedSeconds =
    serverSeconds === null
      ? null
      : serverSeconds + (isActive ? localElapsed : 0);

  const title = goalStatusTitle(status, labels);
  const description = describeGoal({
    objective,
    elapsedSeconds,
    tokenBudget,
    tokensUsed,
    labels
  });
  const fullMessage = `${title} ${description}`;
  const showPause = onPauseGoal !== undefined && isActive;
  const showResume =
    onResumeGoal !== undefined && RESUMABLE_GOAL_STATUSES.has(normalizedStatus);
  const hasActions =
    onEditObjective !== undefined ||
    showPause ||
    showResume ||
    onClearGoal !== undefined;
  const commitEdit = (): void => {
    const next = (editDraft ?? "").trim();
    setEditDraft(null);
    if (next !== "" && next !== objective.trim()) {
      onEditObjective?.(next);
    }
  };
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
            {editDraft !== null ? (
              <input
                className={styles.chromeGoalEditInput}
                value={editDraft}
                autoFocus
                aria-label={labels.editAction}
                data-testid="agent-gui-goal-banner-edit-input"
                onChange={(event) => setEditDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitEdit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setEditDraft(null);
                  }
                }}
                onBlur={() => setEditDraft(null)}
              />
            ) : (
              <p
                className={cn(styles.chromeMessage, styles.chromeNoticeMessage)}
                title={fullMessage}
              >
                <span className={styles.chromeNoticeTitle}>{title}</span>
                <span
                  className={styles.chromeNoticeDescription}
                  data-testid="agent-gui-goal-banner-description"
                >
                  {description}
                </span>
              </p>
            )}
          </div>
          {hasActions ? (
            <div className={styles.chromeGoalActions}>
              {onEditObjective !== undefined && editDraft === null ? (
                <button
                  type="button"
                  onClick={() => setEditDraft(objective)}
                  title={labels.editAction}
                  aria-label={labels.editAction}
                  data-testid="agent-gui-goal-banner-edit"
                >
                  <Pencil aria-hidden className="size-3.5" />
                </button>
              ) : null}
              {showPause ? (
                <button
                  type="button"
                  onClick={onPauseGoal}
                  title={labels.pauseAction}
                  aria-label={labels.pauseAction}
                  data-testid="agent-gui-goal-banner-pause"
                >
                  <CirclePause aria-hidden className="size-3.5" />
                </button>
              ) : null}
              {showResume ? (
                <button
                  type="button"
                  onClick={onResumeGoal}
                  title={labels.resumeAction}
                  aria-label={labels.resumeAction}
                  data-testid="agent-gui-goal-banner-resume"
                >
                  <CirclePlay aria-hidden className="size-3.5" />
                </button>
              ) : null}
              {onClearGoal !== undefined ? (
                <button
                  type="button"
                  onClick={onClearGoal}
                  title={labels.clearAction}
                  aria-label={labels.clearAction}
                  data-testid="agent-gui-goal-banner-clear"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </button>
              ) : null}
            </div>
          ) : (
            <span
              className={styles.chromeGoalHint}
              data-testid="agent-gui-goal-banner-clear-hint"
            >
              {labels.clearHint}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
