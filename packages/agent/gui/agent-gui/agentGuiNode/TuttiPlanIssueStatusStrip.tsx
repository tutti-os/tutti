import type { JSX } from "react";
import { ArrowUpRight, ListChecks, LoaderCircle } from "lucide-react";
import { cn } from "../../app/renderer/lib/utils";
import styles from "./AgentGUIChrome.styles";

export interface TuttiPlanIssueStatusStripLabels {
  running: (count: string) => string;
  pendingAcceptance: (count: string) => string;
  failed: (count: string) => string;
  done: (done: string, total: string) => string;
  jump: string;
}

export interface TuttiPlanIssueStatusStripCounts {
  running: number;
  pendingAcceptance: number;
  failed: number;
  done: number;
  total: number;
}

/**
 * Lightweight always-on anchor above the composer while a session's accepted
 * plan Issue exists: it shows live subtask counts and jumps to the embedded
 * issue panel on click. It deliberately carries no turn semantics — the main
 * conversation stays idle while subtasks run, and this strip (plus the panel
 * it points at) is what expresses "work is in progress".
 */
export function TuttiPlanIssueStatusStrip({
  counts,
  labels,
  title,
  onJump
}: {
  counts: TuttiPlanIssueStatusStripCounts;
  labels: TuttiPlanIssueStatusStripLabels;
  title: string;
  onJump: () => void;
}): JSX.Element {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(labels.running(String(counts.running)));
  if (counts.pendingAcceptance > 0) {
    parts.push(labels.pendingAcceptance(String(counts.pendingAcceptance)));
  }
  if (counts.failed > 0) parts.push(labels.failed(String(counts.failed)));
  parts.push(labels.done(String(counts.done), String(counts.total)));
  const summary = parts.join(" · ");
  return (
    <div className={styles.sessionChrome}>
      <button
        type="button"
        onClick={onJump}
        title={labels.jump}
        className={cn(
          styles.chromeCard,
          styles.chromeCardMuted,
          "w-full cursor-pointer text-left"
        )}
        data-testid="agent-gui-tutti-plan-issue-strip"
      >
        <div className={styles.chromeMetaRow}>
          <div className={styles.chromeMessageSlot}>
            <span className={styles.chromeIcon}>
              {counts.running > 0 ? (
                <LoaderCircle
                  aria-hidden
                  className="size-3.5 animate-spin"
                  data-testid="agent-gui-tutti-plan-issue-strip-spinner"
                />
              ) : (
                <ListChecks aria-hidden className="size-3.5" />
              )}
            </span>
            <p
              className={cn(styles.chromeMessage, styles.chromeNoticeMessage)}
              title={`${title} · ${summary}`}
            >
              <span className={styles.chromeNoticeTitle}>{title}</span>
              <span
                className={styles.chromeNoticeDescription}
                data-testid="agent-gui-tutti-plan-issue-strip-summary"
              >
                {summary}
              </span>
            </p>
          </div>
          <div className={styles.chromeGoalActions}>
            <span aria-hidden className="flex items-center">
              <ArrowUpRight className="size-3.5" />
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}
