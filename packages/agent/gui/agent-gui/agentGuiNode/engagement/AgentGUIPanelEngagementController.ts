import type {
  AgentGUIComposerContentType,
  AgentGUIComposerFocusMethod,
  AgentGUIEngagementContext,
  AgentGUIEngagementEvent,
  AgentGUIEngagementEventSink,
  AgentGUIQuickPromptType
} from "./agentGUIEngagement.types";

export const AGENT_GUI_PANEL_EXPOSURE_DWELL_MS = 1_000;
export const AGENT_GUI_PANEL_EXPOSURE_INTERSECTION_RATIO = 0.5;

interface PendingContentEntered {
  contentType: AgentGUIComposerContentType;
  hadPrefill: boolean;
}

type PendingQuickPromptEvent =
  | { source: "composer_input"; type: "quick_prompt_panel_opened" }
  | {
      promptType: AgentGUIQuickPromptType;
      source: "composer_input";
      type: "quick_prompt_used";
    };

interface AgentGUIPanelEngagementInput {
  context: AgentGUIEngagementContext;
  contextKey: string;
  isActive: boolean;
  isVisible: boolean;
  onEvent?: AgentGUIEngagementEventSink;
}

interface AgentGUIPanelVisit {
  exposed: boolean;
  id: string;
  pendingContentEntered: PendingContentEntered | null;
  pendingFocusMethod: AgentGUIComposerFocusMethod | null;
  pendingQuickPromptEvents: PendingQuickPromptEvent[];
  timeoutId: ReturnType<typeof setTimeout> | null;
}

export class AgentGUIPanelEngagementController {
  private documentFocused = documentHasFocus();
  private documentVisible = documentIsVisible();
  private intersectionObserver: IntersectionObserver | null = null;
  private intersectionRatio: number;
  private visit: AgentGUIPanelVisit | null = null;

  constructor(
    private readonly options: {
      element: HTMLElement;
      getInput: () => AgentGUIPanelEngagementInput;
      initialIntersectionRatio: number;
      visitContextKey: string;
    }
  ) {
    this.intersectionRatio = options.initialIntersectionRatio;
  }

  attach(): void {
    document.addEventListener("visibilitychange", this.updateDocumentState);
    window.addEventListener("blur", this.updateDocumentState);
    window.addEventListener("focus", this.updateDocumentState);
    if (typeof IntersectionObserver === "undefined") {
      // Under-count rather than weaken the 50% exposure guarantee.
      this.intersectionRatio = 0;
    } else {
      this.intersectionObserver = new IntersectionObserver(
        this.updateIntersection,
        {
          threshold: [0, AGENT_GUI_PANEL_EXPOSURE_INTERSECTION_RATIO, 1]
        }
      );
      this.intersectionObserver.observe(this.options.element);
    }
    this.reconcileVisit();
  }

  dispose(): number {
    document.removeEventListener("visibilitychange", this.updateDocumentState);
    window.removeEventListener("blur", this.updateDocumentState);
    window.removeEventListener("focus", this.updateDocumentState);
    this.intersectionObserver?.disconnect();
    this.endVisit();
    return this.intersectionRatio;
  }

  focused(focusMethod: AgentGUIComposerFocusMethod): void {
    this.reconcileVisit();
    const visit = this.visit;
    if (!visit || visit.pendingFocusMethod) return;
    visit.pendingFocusMethod = focusMethod;
    if (!visit.exposed) return;
    this.report({
      ...this.eventForVisit(visit, "composer_focused"),
      focusMethod
    });
  }

  contentEntered(content: PendingContentEntered): void {
    this.reconcileVisit();
    const visit = this.visit;
    if (!visit || visit.pendingContentEntered) return;
    visit.pendingContentEntered = content;
    if (!visit.exposed) return;
    this.report({
      ...this.eventForVisit(visit, "composer_content_entered"),
      ...content
    });
  }

  quickPromptPanelOpened(): void {
    this.reportQuickPromptEvent({
      source: "composer_input",
      type: "quick_prompt_panel_opened"
    });
  }

  quickPromptUsed(promptType: AgentGUIQuickPromptType): void {
    this.reportQuickPromptEvent({
      promptType,
      source: "composer_input",
      type: "quick_prompt_used"
    });
  }

  private readonly updateDocumentState = (): void => {
    this.documentFocused = documentHasFocus();
    this.documentVisible = documentIsVisible();
    this.reconcileVisit();
  };

  private readonly updateIntersection: IntersectionObserverCallback = (
    entries
  ): void => {
    const entry = entries.find(
      (candidate) => candidate.target === this.options.element
    );
    this.intersectionRatio = entry?.intersectionRatio ?? 0;
    this.reconcileVisit();
  };

  private reconcileVisit(): void {
    if (!this.isExposureEligible()) {
      this.endVisit();
      return;
    }
    if (this.visit) return;

    const visit: AgentGUIPanelVisit = {
      exposed: false,
      id: createPanelVisitId(),
      pendingContentEntered: null,
      pendingFocusMethod: null,
      pendingQuickPromptEvents: [],
      timeoutId: null
    };
    this.visit = visit;
    // timing: a panel must remain eligible for the full dwell before exposure.
    visit.timeoutId = setTimeout(
      () => this.exposeVisit(visit),
      AGENT_GUI_PANEL_EXPOSURE_DWELL_MS
    );
  }

  private exposeVisit(visit: AgentGUIPanelVisit): void {
    if (this.visit !== visit || !this.isExposureEligible()) return;
    visit.timeoutId = null;
    visit.exposed = true;
    this.report(this.eventForVisit(visit, "panel_exposed"));
    if (visit.pendingFocusMethod) {
      this.report({
        ...this.eventForVisit(visit, "composer_focused"),
        focusMethod: visit.pendingFocusMethod
      });
    }
    if (visit.pendingContentEntered) {
      this.report({
        ...this.eventForVisit(visit, "composer_content_entered"),
        ...visit.pendingContentEntered
      });
    }
    for (const event of visit.pendingQuickPromptEvents) {
      this.report({ ...this.eventForVisit(visit, event.type), ...event });
    }
  }

  private endVisit(): void {
    if (this.visit?.timeoutId !== null && this.visit?.timeoutId !== undefined) {
      clearTimeout(this.visit.timeoutId);
    }
    this.visit = null;
  }

  private isExposureEligible(): boolean {
    const input = this.options.getInput();
    return (
      Boolean(input.onEvent) &&
      input.contextKey === this.options.visitContextKey &&
      input.isActive &&
      input.isVisible &&
      this.documentFocused &&
      this.documentVisible &&
      this.intersectionRatio >= AGENT_GUI_PANEL_EXPOSURE_INTERSECTION_RATIO
    );
  }

  private eventForVisit<TType extends AgentGUIEngagementEvent["type"]>(
    visit: AgentGUIPanelVisit,
    type: TType
  ): AgentGUIEngagementContext & { panelVisitId: string; type: TType } {
    return {
      ...this.options.getInput().context,
      panelVisitId: visit.id,
      type
    };
  }

  private report(event: AgentGUIEngagementEvent): void {
    const sink = this.options.getInput().onEvent;
    if (!sink) return;
    try {
      void Promise.resolve(sink(event)).catch(reportEngagementFailure);
    } catch (error) {
      reportEngagementFailure(error);
    }
  }

  private reportQuickPromptEvent(event: PendingQuickPromptEvent): void {
    this.reconcileVisit();
    const visit = this.visit;
    if (!visit) return;
    if (!visit.exposed) {
      visit.pendingQuickPromptEvents.push(event);
      return;
    }
    this.report({ ...this.eventForVisit(visit, event.type), ...event });
  }
}

function reportEngagementFailure(error: unknown): void {
  console.warn("[agent-gui] engagement event reporting failed", error);
}

function createPanelVisitId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `agent-gui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function documentHasFocus(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

function documentIsVisible(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "visible"
  );
}
