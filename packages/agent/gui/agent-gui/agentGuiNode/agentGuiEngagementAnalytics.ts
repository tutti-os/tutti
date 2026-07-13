import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject
} from "react";

export const AGENT_GUI_PANEL_EXPOSURE_DWELL_MS = 1_000;
export const AGENT_GUI_PANEL_EXPOSURE_INTERSECTION_RATIO = 0.5;

export type AgentGUIComposerFocusMethod =
  | "keyboard"
  | "pointer"
  | "programmatic";

export type AgentGUIComposerContentType = "image" | "large_text" | "text";

export interface AgentGUIEngagementContext {
  agentSessionId: string | null;
  agentTargetId: string | null;
  composerReady: boolean;
  conversationState: "existing" | "new";
  provider: string;
}

export interface AgentGUIEngagementEventContext extends AgentGUIEngagementContext {
  panelVisitId: string;
}

export interface AgentGUIEngagementAnalytics {
  onChatInputContentEntered?: (
    input: AgentGUIEngagementEventContext & {
      contentType: AgentGUIComposerContentType;
      hadPrefill: boolean;
    }
  ) => Promise<void> | void;
  onChatInputFocused?: (
    input: AgentGUIEngagementEventContext & {
      focusMethod: AgentGUIComposerFocusMethod;
    }
  ) => Promise<void> | void;
  onChatPanelExposed?: (
    input: AgentGUIEngagementEventContext
  ) => Promise<void> | void;
}

export interface AgentGUIComposerEngagementAnalytics {
  contentEntered(input: {
    contentType: AgentGUIComposerContentType;
    hadPrefill: boolean;
  }): void;
  focused(focusMethod: AgentGUIComposerFocusMethod): void;
}

interface PendingComposerContentEntered {
  contentType: AgentGUIComposerContentType;
  hadPrefill: boolean;
}

interface AgentGUIPanelVisit {
  exposed: boolean;
  id: string;
  pendingContentEntered: PendingComposerContentEntered | null;
  pendingFocusMethod: AgentGUIComposerFocusMethod | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

export function useAgentGUIEngagementAnalytics(input: {
  analytics?: AgentGUIEngagementAnalytics;
  context: AgentGUIEngagementContext;
  elementRef: RefObject<HTMLElement | null>;
  isActive: boolean;
  previewMode: boolean;
}): AgentGUIComposerEngagementAnalytics | undefined {
  const { analytics, elementRef, isActive, previewMode } = input;
  const analyticsRef = useRef(analytics);
  const contextRef = useRef(input.context);
  const visitRef = useRef<AgentGUIPanelVisit | null>(null);
  const [documentFocused, setDocumentFocused] = useState(() =>
    documentHasFocus()
  );
  const [documentVisible, setDocumentVisible] = useState(() =>
    documentIsVisible()
  );
  const [intersectionRatio, setIntersectionRatio] = useState(0);
  const [presentationVisible, setPresentationVisible] = useState(true);

  analyticsRef.current = analytics;
  contextRef.current = input.context;

  const endVisit = useCallback(() => {
    const visit = visitRef.current;
    if (visit?.timeoutId !== null && visit?.timeoutId !== undefined) {
      clearTimeout(visit.timeoutId);
    }
    visitRef.current = null;
  }, []);

  useEffect(() => {
    if (!analytics || previewMode) {
      setDocumentFocused(false);
      setDocumentVisible(false);
      return undefined;
    }
    const updateDocumentState = () => {
      setDocumentFocused(documentHasFocus());
      setDocumentVisible(documentIsVisible());
    };
    updateDocumentState();
    document.addEventListener("visibilitychange", updateDocumentState);
    window.addEventListener("blur", updateDocumentState);
    window.addEventListener("focus", updateDocumentState);
    return () => {
      document.removeEventListener("visibilitychange", updateDocumentState);
      window.removeEventListener("blur", updateDocumentState);
      window.removeEventListener("focus", updateDocumentState);
    };
  }, [analytics, previewMode]);

  useEffect(() => {
    const element = elementRef.current;
    if (!analytics || previewMode || !element) {
      setIntersectionRatio(0);
      return undefined;
    }
    if (typeof IntersectionObserver === "undefined") {
      const updateIntersectionRatio = () => {
        setIntersectionRatio(elementViewportIntersectionRatio(element));
      };
      updateIntersectionRatio();
      window.addEventListener("resize", updateIntersectionRatio);
      return () =>
        window.removeEventListener("resize", updateIntersectionRatio);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((candidate) => candidate.target === element);
        setIntersectionRatio(entry?.intersectionRatio ?? 0);
      },
      {
        threshold: [0, AGENT_GUI_PANEL_EXPOSURE_INTERSECTION_RATIO, 1]
      }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [analytics, elementRef, previewMode]);

  useEffect(() => {
    const element = elementRef.current;
    if (!analytics || previewMode || !element) {
      setPresentationVisible(false);
      return undefined;
    }
    const workbenchWindow = element.closest<HTMLElement>(
      ".workbench-window-shell"
    );
    if (!workbenchWindow) {
      setPresentationVisible(true);
      return undefined;
    }
    const updatePresentationVisibility = () => {
      setPresentationVisible(
        workbenchWindow.dataset.presentationMode !== "mission-control" &&
          workbenchWindow.dataset.presentationVisibility !== "hidden" &&
          workbenchWindow.dataset.genieState !== "hidden" &&
          workbenchWindow.dataset.minimizedMount !== "hidden" &&
          workbenchWindow.getAttribute("aria-hidden") !== "true"
      );
    };
    updatePresentationVisibility();
    const observer = new MutationObserver(updatePresentationVisibility);
    observer.observe(workbenchWindow, {
      attributeFilter: [
        "aria-hidden",
        "data-genie-state",
        "data-minimized-mount",
        "data-presentation-mode",
        "data-presentation-visibility"
      ]
    });
    return () => observer.disconnect();
  }, [analytics, elementRef, previewMode]);

  const exposureEligible =
    Boolean(analytics) &&
    !previewMode &&
    isActive &&
    documentFocused &&
    documentVisible &&
    presentationVisible &&
    intersectionRatio >= AGENT_GUI_PANEL_EXPOSURE_INTERSECTION_RATIO;

  useEffect(() => {
    if (!exposureEligible) {
      endVisit();
      return undefined;
    }
    if (visitRef.current) {
      return undefined;
    }
    const visit: AgentGUIPanelVisit = {
      exposed: false,
      id: createPanelVisitId(),
      pendingContentEntered: null,
      pendingFocusMethod: null,
      timeoutId: null
    };
    visitRef.current = visit;
    visit.timeoutId = setTimeout(() => {
      if (visitRef.current !== visit) {
        return;
      }
      visit.timeoutId = null;
      visit.exposed = true;
      const eventContext = currentEventContext(contextRef.current, visit.id);
      reportAnalyticsEvent(
        analyticsRef.current?.onChatPanelExposed,
        eventContext
      );
      if (visit.pendingFocusMethod) {
        reportAnalyticsEvent(analyticsRef.current?.onChatInputFocused, {
          ...eventContext,
          focusMethod: visit.pendingFocusMethod
        });
      }
      if (visit.pendingContentEntered) {
        reportAnalyticsEvent(analyticsRef.current?.onChatInputContentEntered, {
          ...eventContext,
          ...visit.pendingContentEntered
        });
      }
    }, AGENT_GUI_PANEL_EXPOSURE_DWELL_MS);
    return undefined;
  }, [endVisit, exposureEligible]);

  useEffect(() => () => endVisit(), [endVisit]);

  const focused = useCallback((focusMethod: AgentGUIComposerFocusMethod) => {
    const visit = visitRef.current;
    if (!visit || visit.pendingFocusMethod) {
      return;
    }
    visit.pendingFocusMethod = focusMethod;
    if (!visit.exposed) {
      return;
    }
    reportAnalyticsEvent(analyticsRef.current?.onChatInputFocused, {
      ...currentEventContext(contextRef.current, visit.id),
      focusMethod
    });
  }, []);

  const contentEntered = useCallback(
    (content: PendingComposerContentEntered) => {
      const visit = visitRef.current;
      if (!visit || visit.pendingContentEntered) {
        return;
      }
      visit.pendingContentEntered = content;
      if (!visit.exposed) {
        return;
      }
      reportAnalyticsEvent(analyticsRef.current?.onChatInputContentEntered, {
        ...currentEventContext(contextRef.current, visit.id),
        ...content
      });
    },
    []
  );

  return analytics ? { contentEntered, focused } : undefined;
}

function currentEventContext(
  context: AgentGUIEngagementContext,
  panelVisitId: string
): AgentGUIEngagementEventContext {
  return { ...context, panelVisitId };
}

function reportAnalyticsEvent<T>(
  reporter: ((input: T) => Promise<void> | void) | undefined,
  input: T
): void {
  try {
    void Promise.resolve(reporter?.(input)).catch(() => undefined);
  } catch {
    // Analytics is best-effort and must never affect Agent GUI behavior.
  }
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

function elementViewportIntersectionRatio(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return 0;
  }
  const visibleWidth = Math.max(
    0,
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
  );
  const visibleHeight = Math.max(
    0,
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
  );
  return (visibleWidth * visibleHeight) / (rect.width * rect.height);
}
