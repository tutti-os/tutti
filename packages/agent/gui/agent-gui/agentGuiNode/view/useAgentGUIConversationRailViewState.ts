import { useCallback, useLayoutEffect, useReducer, useRef } from "react";
import {
  AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
  agentGUIConversationRailScopedViewState,
  reduceAgentGUIConversationRailViewState,
  type AgentGUIConversationRailRevealRequest
} from "../model/agentGuiConversationRailViewState";
import { useStableEventCallback } from "./agentGUIViewUtils";

interface UseAgentGUIConversationRailViewStateInput {
  activeConversationId: string | null;
  contentReady: boolean;
  groupedConversationIdentityKey: string;
  revealRequest: AgentGUIConversationRailRevealRequest | null;
  searchQuery: string;
  scopeKey: string;
}

interface RailScrollNavigationState {
  handledRevealRevision: number;
  navigationKey: string | null;
  phase: "scope-pending" | "steady";
}

function applyRailScrollNavigation(input: {
  activeConversationId: string | null;
  contentReady: boolean;
  conversationItemElements: ReadonlyMap<string, HTMLDivElement>;
  current: RailScrollNavigationState;
  navigationKey: string;
  rememberedScrollTop: number | undefined;
  revealRequest: AgentGUIConversationRailRevealRequest | null;
  searchActive: boolean;
  viewport: HTMLDivElement;
}): RailScrollNavigationState {
  const activeConversationId = input.activeConversationId?.trim() || null;
  const current =
    input.current.navigationKey === input.navigationKey
      ? input.current
      : {
          handledRevealRevision: input.current.handledRevealRevision,
          navigationKey: input.navigationKey,
          phase: "scope-pending" as const
        };
  if (!input.contentReady) return current;
  if (current.phase === "scope-pending") {
    if (input.searchActive) {
      input.viewport.scrollTop = 0;
    } else if (input.rememberedScrollTop !== undefined) {
      input.viewport.scrollTop = input.rememberedScrollTop;
    } else if (activeConversationId) {
      const activeElement =
        input.conversationItemElements.get(activeConversationId);
      if (activeElement) {
        activeElement.scrollIntoView({ block: "nearest" });
      } else {
        return current;
      }
    } else {
      input.viewport.scrollTop = 0;
    }
    return {
      handledRevealRevision: current.handledRevealRevision,
      navigationKey: input.navigationKey,
      phase: "steady"
    };
  }
  const revealRequest = input.revealRequest;
  if (
    !revealRequest ||
    revealRequest.revision <= current.handledRevealRevision ||
    revealRequest.agentSessionId !== activeConversationId
  ) {
    return current;
  }
  const activeElement = input.conversationItemElements.get(
    revealRequest.agentSessionId
  );
  if (!activeElement) return current;
  activeElement.scrollIntoView({ block: "nearest" });
  return { ...current, handledRevealRevision: revealRequest.revision };
}

export function useAgentGUIConversationRailViewState(
  input: UseAgentGUIConversationRailViewStateInput
) {
  const [viewState, dispatch] = useReducer(
    reduceAgentGUIConversationRailViewState,
    new Map()
  );
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const conversationItemElementsRef = useRef(new Map<string, HTMLDivElement>());
  const scrollTopByScopeRef = useRef(new Map<string, number>());
  const navigationRef = useRef<RailScrollNavigationState>({
    handledRevealRevision: 0,
    navigationKey: null,
    phase: "scope-pending"
  });
  const normalizedSearchQuery = input.searchQuery.trim();
  const searchActive = normalizedSearchQuery.length > 0;
  const navigationKey = searchActive
    ? `${input.scopeKey}:search:${normalizedSearchQuery}`
    : input.scopeKey;
  const scopedViewState = agentGUIConversationRailScopedViewState(
    viewState,
    input.scopeKey
  );

  useLayoutEffect(() => {
    const viewport = conversationListRef.current;
    if (!viewport) return;
    const recordScrollTop = () => {
      const navigation = navigationRef.current;
      if (
        !searchActive &&
        navigation.navigationKey === navigationKey &&
        navigation.phase === "steady"
      ) {
        scrollTopByScopeRef.current.set(input.scopeKey, viewport.scrollTop);
      }
    };
    viewport.addEventListener("scroll", recordScrollTop, { passive: true });
    const previousNavigation = navigationRef.current;
    const nextNavigation = applyRailScrollNavigation({
      activeConversationId: input.activeConversationId,
      contentReady: input.contentReady,
      conversationItemElements: conversationItemElementsRef.current,
      current: previousNavigation,
      navigationKey,
      rememberedScrollTop: searchActive
        ? undefined
        : scrollTopByScopeRef.current.get(input.scopeKey),
      revealRequest: input.revealRequest,
      searchActive,
      viewport
    });
    navigationRef.current = nextNavigation;
    if (
      nextNavigation.phase === "steady" &&
      nextNavigation !== previousNavigation
    ) {
      recordScrollTop();
    }
    return () => {
      viewport.removeEventListener("scroll", recordScrollTop);
    };
  }, [
    input.activeConversationId,
    input.contentReady,
    input.groupedConversationIdentityKey,
    input.revealRequest,
    input.scopeKey,
    navigationKey,
    searchActive
  ]);

  const registerConversationItemElement = useCallback(
    (itemId: string, element: HTMLDivElement | null) => {
      if (element) {
        conversationItemElementsRef.current.set(itemId, element);
      } else {
        conversationItemElementsRef.current.delete(itemId);
      }
    },
    []
  );
  const setSectionVisibleItemLimit = useStableEventCallback(
    (sectionId: string, limit: number) => {
      dispatch({
        type: "section-visible-limit-set",
        limit,
        scopeKey: input.scopeKey,
        sectionId
      });
    }
  );
  const toggleProjectSectionCollapsed = useStableEventCallback(
    (sectionId: string) => {
      dispatch({
        type: "section-collapsed-toggled",
        scopeKey: input.scopeKey,
        sectionId
      });
    }
  );

  return {
    collapsedSectionIds: scopedViewState.collapsedSectionIds,
    conversationListRef,
    registerConversationItemElement,
    setSectionVisibleItemLimit,
    toggleProjectSectionCollapsed,
    visibleItemLimitForSection: (sectionId: string) =>
      scopedViewState.visibleItemLimitBySectionId.get(sectionId) ??
      AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
  };
}
