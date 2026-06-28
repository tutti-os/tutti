import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
  type MouseEvent,
  type JSX
} from "react";
import { Button } from "@tutti-os/ui-system";
import { CastIcon } from "../../app/renderer/components/icons/CastIcon";
import { ChevronDown } from "lucide-react";
import { cn } from "../../app/renderer/lib/utils";
import { approvalOptionDisplayLabel } from "../../shared/agentConversation/approvalOptionPresentation";
import type { AgentGUISessionChrome } from "./model/agentGuiNodeTypes";
import styles from "./AgentGUIChrome.styles";

interface AgentChromeNoticeProps {
  tone: "warning" | "danger";
  title: string;
  description?: string;
  icon?: ReactNode;
  role?: "alert" | "status";
  testId?: string;
}

interface AgentSessionChromeProps {
  chrome: AgentGUISessionChrome;
  isRespondingApproval: boolean;
  onSubmitApprovalOption: (requestId: string, optionId: string) => void;
  onAuthLogin?: () => void;
  onRetryActivation: () => void;
  onContinueInNewConversation: () => void;
  labels: {
    approvalRequired: string;
    authLogin?: string;
    authRequired: string;
    activatingSession: string;
    retryActivation: string;
    continueInNewConversation: string;
  };
}

function splitTrailingEllipsis(message: string): {
  label: string;
  ellipsis: string | null;
} {
  const match = message.match(/^(.*?)(\.{3}|…)\s*$/);
  if (!match) {
    return { label: message, ellipsis: null };
  }

  return {
    label: match[1] ?? message,
    ellipsis: match[2] ?? null
  };
}

function LoadingEllipsis(): JSX.Element {
  "use memo";
  return (
    <span className="tsh-inline-loading-ellipsis" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function AgentChromeNotice({
  tone,
  title,
  description,
  icon,
  role,
  testId
}: AgentChromeNoticeProps): JSX.Element {
  "use memo";
  const fullMessage = description ? `${title} ${description}` : title;
  return (
    <div className={styles.sessionChrome}>
      <section
        className={cn(
          styles.chromeCard,
          tone === "danger" ? styles.chromeCardDanger : styles.chromeCardWarning
        )}
        data-expandable="false"
        data-expanded="false"
        role={role}
        data-testid={testId}
      >
        <div className={styles.chromeMetaRow}>
          <div className={styles.chromeMessageSlot}>
            {icon ? <span className={styles.chromeIcon}>{icon}</span> : null}
            <p
              className={cn(styles.chromeMessage, styles.chromeNoticeMessage)}
              title={fullMessage}
            >
              <span className={styles.chromeNoticeTitle}>{title}</span>
              {description ? (
                <span className={styles.chromeNoticeDescription}>
                  {description}
                </span>
              ) : null}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

type ExpandableChromeCard = "auth" | "recovery";
const compactChromeCardHeightPx = 36;
const chromeCardExpandedHeightProperty =
  "--agent-gui-chrome-card-expanded-height";

function hasElementOverflow(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }

  return (
    element.scrollWidth > element.clientWidth + 1 ||
    element.scrollHeight > element.clientHeight + 1
  );
}

function areCardSetsEqual(
  left: ReadonlySet<ExpandableChromeCard>,
  right: ReadonlySet<ExpandableChromeCard>
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const card of left) {
    if (!right.has(card)) {
      return false;
    }
  }

  return true;
}

function parseCssPixelValue(value: string): number {
  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

function measureExpandedChromeCardHeight(element: HTMLElement | null): void {
  if (!element || element.dataset.expanded !== "true") {
    return;
  }

  const computedStyle = window.getComputedStyle(element);
  const borderBlockPx =
    parseCssPixelValue(computedStyle.borderTopWidth) +
    parseCssPixelValue(computedStyle.borderBottomWidth);
  const measuredHeightPx = Math.max(
    compactChromeCardHeightPx,
    Math.ceil(element.scrollHeight + borderBlockPx)
  );
  const nextHeight = `${measuredHeightPx}px`;

  if (
    element.style.getPropertyValue(chromeCardExpandedHeightProperty) !==
    nextHeight
  ) {
    element.style.setProperty(chromeCardExpandedHeightProperty, nextHeight);
  }
}

export function AgentSessionChrome({
  chrome,
  isRespondingApproval,
  onSubmitApprovalOption,
  onAuthLogin,
  onRetryActivation,
  onContinueInNewConversation,
  labels
}: AgentSessionChromeProps): JSX.Element | null {
  "use memo";
  const [expandedCards, setExpandedCards] = useState<
    ReadonlySet<ExpandableChromeCard>
  >(() => new Set());
  const [expandableCards, setExpandableCards] = useState<
    ReadonlySet<ExpandableChromeCard>
  >(() => new Set());
  const expandedCardsRef = useRef(expandedCards);
  expandedCardsRef.current = expandedCards;
  const authCardRef = useRef<HTMLElement | null>(null);
  const recoveryCardRef = useRef<HTMLElement | null>(null);
  const authMessageRef = useRef<HTMLParagraphElement | null>(null);
  const recoveryMessageRef = useRef<HTMLParagraphElement | null>(null);
  const visibleAuth =
    chrome.recovery?.kind === "activating" ? null : chrome.auth;
  const visibleRecovery = chrome.recovery;
  const recoveryMessage =
    visibleRecovery?.kind === "activating"
      ? labels.activatingSession
      : (visibleRecovery?.message ?? "");
  const recoveryHasInlineAction =
    (visibleRecovery?.kind === "failed" &&
      (visibleRecovery.followupAction === "continue-in-new-conversation" ||
        visibleRecovery.canRetry !== false)) ||
    (visibleRecovery?.kind === "connection-lost" &&
      visibleRecovery.canRetry !== false);
  const activatingMessage = splitTrailingEllipsis(recoveryMessage);
  const measureExpandableCards = useCallback((): void => {
    const nextExpandableCards = new Set<ExpandableChromeCard>();
    if (
      expandedCardsRef.current.has("auth") ||
      hasElementOverflow(authMessageRef.current)
    ) {
      nextExpandableCards.add("auth");
    }
    if (
      expandedCardsRef.current.has("recovery") ||
      hasElementOverflow(recoveryMessageRef.current)
    ) {
      nextExpandableCards.add("recovery");
    }

    setExpandableCards((current) =>
      areCardSetsEqual(current, nextExpandableCards)
        ? current
        : nextExpandableCards
    );
    setExpandedCards((current) => {
      const nextExpandedCards = new Set(
        [...current].filter((card) => nextExpandableCards.has(card))
      );
      return areCardSetsEqual(current, nextExpandedCards)
        ? current
        : nextExpandedCards;
    });
  }, []);
  const measureChromeLayout = useCallback((): void => {
    measureExpandedChromeCardHeight(authCardRef.current);
    measureExpandedChromeCardHeight(recoveryCardRef.current);
    measureExpandableCards();
  }, [measureExpandableCards]);
  useLayoutEffect(() => {
    measureChromeLayout();

    const ResizeObserverConstructor = window.ResizeObserver;
    if (ResizeObserverConstructor) {
      const resizeObserver = new ResizeObserverConstructor(measureChromeLayout);
      for (const element of [
        authCardRef.current,
        recoveryCardRef.current,
        authMessageRef.current,
        recoveryMessageRef.current
      ]) {
        if (element) {
          resizeObserver.observe(element);
          if (element.parentElement) {
            resizeObserver.observe(element.parentElement);
          }
        }
      }
      return () => resizeObserver.disconnect();
    }

    window.addEventListener("resize", measureChromeLayout);
    return () => window.removeEventListener("resize", measureChromeLayout);
  }, [
    expandedCards,
    visibleAuth?.message,
    measureChromeLayout,
    recoveryMessage
  ]);
  const hasContent =
    visibleAuth !== null ||
    chrome.approval !== null ||
    visibleRecovery !== null;

  if (!hasContent) {
    return null;
  }

  const toggleExpandedCard = (card: ExpandableChromeCard): void => {
    if (!expandableCards.has(card)) {
      return;
    }

    setExpandedCards((current) => {
      const next = new Set(current);
      if (next.has(card)) {
        next.delete(card);
      } else {
        next.add(card);
      }
      return next;
    });
  };
  const handleExpandableCardKeyDown =
    (card: ExpandableChromeCard) =>
    (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      toggleExpandedCard(card);
    };
  const stopCardToggle = (event: MouseEvent<HTMLElement>): void => {
    event.stopPropagation();
  };

  return (
    <div className={styles.sessionChrome}>
      {visibleAuth ? (
        <section
          ref={authCardRef}
          className={cn(styles.chromeCard, styles.chromeCardWarning)}
          data-expandable={expandableCards.has("auth") ? "true" : "false"}
          data-expanded={
            expandedCards.has("auth") && expandableCards.has("auth")
              ? "true"
              : "false"
          }
          tabIndex={expandableCards.has("auth") ? 0 : undefined}
          onClick={() => toggleExpandedCard("auth")}
          onKeyDown={handleExpandableCardKeyDown("auth")}
        >
          <div className={styles.chromeMetaRow}>
            <div className={styles.chromeMessageSlot}>
              <p
                ref={authMessageRef}
                className={styles.chromeMessage}
                title={visibleAuth.message}
              >
                {visibleAuth.message}
              </p>
              <ChevronDown
                aria-hidden="true"
                className={styles.chromeExpandCue}
                data-visible={expandableCards.has("auth") ? "true" : "false"}
                data-testid="agent-session-chrome-auth-expand-cue"
                size={16}
                strokeWidth={2}
              />
            </div>
            <div className={styles.chromeInlineActions}>
              {onAuthLogin ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    stopCardToggle(event);
                    onAuthLogin();
                  }}
                >
                  {labels.authLogin ?? labels.retryActivation}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  stopCardToggle(event);
                  onRetryActivation();
                }}
              >
                {labels.retryActivation}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {chrome.approval ? (
        <section className={cn(styles.chromeCard, styles.chromeCardAction)}>
          <div className={styles.chromeTitle}>{labels.approvalRequired}</div>
          <p className={styles.chromeMessage}>{chrome.approval.title}</p>
          <div className={styles.chromeActions}>
            {chrome.approval.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={isRespondingApproval}
                onClick={() =>
                  onSubmitApprovalOption(
                    chrome.approval?.requestId ?? "",
                    option.id
                  )
                }
              >
                {approvalOptionDisplayLabel(option)}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {visibleRecovery ? (
        <section
          ref={recoveryCardRef}
          role={visibleRecovery.kind === "failed" || visibleRecovery.kind === "connection-lost" ? "alert" : undefined}
          aria-live={
            visibleRecovery.kind === "failed" || visibleRecovery.kind === "connection-lost" ? "assertive" : undefined
          }
          data-expandable={expandableCards.has("recovery") ? "true" : "false"}
          data-expanded={
            expandedCards.has("recovery") && expandableCards.has("recovery")
              ? "true"
              : "false"
          }
          data-has-inline-actions={recoveryHasInlineAction ? "true" : "false"}
          tabIndex={expandableCards.has("recovery") ? 0 : undefined}
          className={cn(
            styles.chromeCard,
            visibleRecovery.kind === "failed"
              ? styles.chromeCardDanger
              : visibleRecovery.kind === "warning"
                ? styles.chromeCardDanger
                : visibleRecovery.kind === "connection-lost"
                  ? styles.chromeCardWarning
                  : visibleRecovery.kind === "activating"
                    ? styles.chromeCardConnecting
                    : styles.chromeCardMuted
          )}
          onClick={() => toggleExpandedCard("recovery")}
          onKeyDown={handleExpandableCardKeyDown("recovery")}
        >
          <div className={styles.chromeMetaRow}>
            <div className={styles.chromeMessageSlot}>
              {visibleRecovery.kind === "activating" ? (
                <CastIcon
                  active
                  aria-hidden="true"
                  className={styles.chromeIcon}
                  data-testid="agent-session-chrome-connecting-icon"
                  size={16}
                />
              ) : null}
              <p
                ref={recoveryMessageRef}
                className={styles.chromeMessage}
                aria-label={
                  visibleRecovery.kind === "activating"
                    ? recoveryMessage
                    : undefined
                }
                title={recoveryMessage}
              >
                {visibleRecovery.kind === "activating" ? (
                  <>
                    <span className="tsh-inline-loading-label">
                      {activatingMessage.label}
                    </span>
                    {activatingMessage.ellipsis ? <LoadingEllipsis /> : null}
                  </>
                ) : visibleRecovery.kind === "connection-lost" ? (
                  <>
                    <span className={styles.chromeNoticeTitle}>
                      {recoveryMessage}
                    </span>
                    {visibleRecovery.description ? (
                      <span className={styles.chromeNoticeDescription}>
                        {visibleRecovery.description}
                      </span>
                    ) : null}
                  </>
                ) : (
                  recoveryMessage
                )}
              </p>
              <ChevronDown
                aria-hidden="true"
                className={styles.chromeExpandCue}
                data-visible={
                  expandableCards.has("recovery") ? "true" : "false"
                }
                data-testid="agent-session-chrome-recovery-expand-cue"
                size={16}
                strokeWidth={2}
              />
            </div>
            <div className={styles.chromeInlineActions}>
              {visibleRecovery.kind === "failed" &&
              visibleRecovery.followupAction ===
                "continue-in-new-conversation" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.chromeDangerGhostButton}
                  onClick={(event) => {
                    stopCardToggle(event);
                    onContinueInNewConversation();
                  }}
                >
                  {labels.continueInNewConversation}
                </Button>
              ) : (visibleRecovery.kind === "failed" ||
                  visibleRecovery.kind === "connection-lost") &&
                visibleRecovery.canRetry !== false ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.chromeDangerGhostButton}
                  onClick={(event) => {
                    stopCardToggle(event);
                    onRetryActivation();
                  }}
                >
                  {labels.retryActivation}
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
