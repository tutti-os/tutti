import type { JSX } from "react";
import { Gauge, Sparkles, X } from "lucide-react";
import { cn } from "../../app/renderer/lib/utils";
import styles from "./AgentGUIChrome.styles";
import {
  TuttiBudgetPopover,
  type TuttiBudgetPopoverLabels
} from "./composer/TuttiBudgetPopover";

export interface TuttiPlanReviewBannerLabels {
  title: string;
  hint: string;
  /** Hint shown when the session intensity diverged from the plan's. */
  hintReplan: string;
  cancel: string;
}

/**
 * Persistent banner above the composer while a Tutti mode plan awaits review.
 * It carries the decision affordance contract: an empty composer send accepts
 * the plan, a typed send requests changes with that text as feedback, and the
 * banner's own action cancels the plan. The banner also hosts the intensity
 * entry for the pending review; once the session intensity diverges from the
 * plan's, the hint flips to the re-plan wording (an empty send then requests
 * a re-plan at the new intensity instead of accepting). Same dock slot and
 * chrome styling as the goal banner.
 */
export function TuttiPlanReviewBanner({
  labels,
  planTitle,
  submitting,
  intensity,
  intensityDiverged = false,
  intensityPopoverLabels,
  onIntensityChange,
  onCancel
}: {
  labels: TuttiPlanReviewBannerLabels;
  planTitle: string;
  submitting: boolean;
  intensity?: number;
  intensityDiverged?: boolean;
  intensityPopoverLabels?: TuttiBudgetPopoverLabels;
  onIntensityChange?: (value: number) => void;
  onCancel?: () => void;
}): JSX.Element {
  const hint = intensityDiverged ? labels.hintReplan : labels.hint;
  const description = planTitle.trim() ? `${planTitle.trim()} · ${hint}` : hint;
  const showIntensity =
    onIntensityChange !== undefined &&
    intensityPopoverLabels !== undefined &&
    intensity !== undefined;
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
          {showIntensity || onCancel ? (
            <div className={styles.chromeGoalActions}>
              {showIntensity ? (
                <TuttiBudgetPopover
                  intensity={intensity}
                  labels={intensityPopoverLabels}
                  onConfirm={onIntensityChange}
                >
                  <button
                    type="button"
                    disabled={submitting}
                    title={intensityPopoverLabels.title}
                    aria-label={intensityPopoverLabels.intensityLabel}
                    data-testid="agent-gui-tutti-plan-banner-intensity"
                    className={cn(
                      "flex items-center gap-1",
                      intensityDiverged && "text-[var(--tutti-purple)]"
                    )}
                  >
                    <Gauge aria-hidden className="size-3.5" />
                    <span className="text-[11px] tabular-nums">
                      {intensity}
                    </span>
                  </button>
                </TuttiBudgetPopover>
              ) : null}
              {onCancel ? (
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
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
