import type { JSX } from "react";
import { Sparkles, X } from "lucide-react";
import { cn } from "../../app/renderer/lib/utils";
import styles from "./AgentGUIChrome.styles";

export interface TuttiPlanReviewBannerLabels {
  title: string;
  hint: string;
  cancel: string;
}

/**
 * Persistent banner above the composer while a Tutti mode plan awaits review.
 * It carries the decision affordance contract: an empty composer send accepts
 * the plan, a typed send requests changes with that text as feedback, and the
 * banner's own action cancels the plan. Same dock slot and chrome styling as
 * the goal banner.
 */
export function TuttiPlanReviewBanner({
  labels,
  planTitle,
  submitting,
  onCancel
}: {
  labels: TuttiPlanReviewBannerLabels;
  planTitle: string;
  submitting: boolean;
  onCancel?: () => void;
}): JSX.Element {
  const description = planTitle.trim()
    ? `${planTitle.trim()} · ${labels.hint}`
    : labels.hint;
  return (
    <div className={styles.sessionChrome}>
      <section
        className={cn(styles.chromeCard, styles.chromeCardMuted)}
        role="status"
        data-testid="agent-gui-tutti-plan-banner"
      >
        <div className={styles.chromeMetaRow}>
          <div className={styles.chromeMessageSlot}>
            <span className={styles.chromeIcon}>
              <Sparkles aria-hidden className="size-3.5" />
            </span>
            <p
              className={cn(styles.chromeMessage, styles.chromeNoticeMessage)}
              title={`${labels.title} ${description}`}
            >
              <span className={styles.chromeNoticeTitle}>{labels.title}</span>
              <span
                className={styles.chromeNoticeDescription}
                data-testid="agent-gui-tutti-plan-banner-description"
              >
                {description}
              </span>
            </p>
          </div>
          {onCancel ? (
            <div className={styles.chromeGoalActions}>
              <button
                type="button"
                disabled={submitting}
                onClick={onCancel}
                title={labels.cancel}
                aria-label={labels.cancel}
                data-testid="agent-gui-tutti-plan-banner-cancel"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
