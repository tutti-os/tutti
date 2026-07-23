import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../app/renderer/lib/utils";
import styles from "./AgentGUIChrome.styles";

/**
 * Product-neutral composer accessory that expands upward from its persistent
 * banner. The disclosure trigger and trailing actions are siblings so actions
 * never become nested interactive controls.
 */
export function AgentComposerDisclosureCard({
  actions,
  children,
  expanded,
  icon,
  labels,
  onExpandedChange,
  summary,
  testId,
  title
}: {
  actions?: ReactNode;
  children: ReactNode;
  expanded: boolean;
  icon: ReactNode;
  labels: {
    collapse: string;
    expand: string;
  };
  onExpandedChange(expanded: boolean): void;
  summary: string;
  testId: string;
  title: string;
}): React.JSX.Element {
  const panelId = useId();
  const disclosureLabel = expanded ? labels.collapse : labels.expand;

  return (
    <div className={styles.sessionChrome}>
      <section
        className={styles.composerDisclosure}
        data-expanded={expanded ? "true" : "false"}
        data-testid={testId}
      >
        {expanded ? (
          <div
            id={panelId}
            className={styles.composerDisclosurePanel}
            data-testid={`${testId}-panel`}
          >
            {children}
          </div>
        ) : null}
        <div
          className={cn(
            styles.chromeCard,
            styles.chromeCardMuted,
            styles.composerDisclosureBanner
          )}
        >
          <button
            type="button"
            className={styles.composerDisclosureTrigger}
            aria-controls={panelId}
            aria-expanded={expanded}
            aria-label={disclosureLabel}
            title={disclosureLabel}
            onClick={() => onExpandedChange(!expanded)}
          >
            <span className={styles.chromeIcon}>{icon}</span>
            <span
              className={cn(styles.chromeMessage, styles.chromeNoticeMessage)}
              title={`${title} · ${summary}`}
            >
              <span className={styles.chromeNoticeTitle}>{title}</span>
              <span
                className={styles.chromeNoticeDescription}
                aria-live="polite"
              >
                {summary}
              </span>
            </span>
            <ChevronDown
              aria-hidden
              className={cn(
                styles.composerDisclosureChevron,
                expanded && styles.composerDisclosureChevronExpanded
              )}
            />
          </button>
          {actions ? (
            <div className={styles.chromeGoalActions}>{actions}</div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
