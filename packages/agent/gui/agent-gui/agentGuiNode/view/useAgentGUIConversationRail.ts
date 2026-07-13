import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import { filterAgentGUIConversationSummaries } from "../model/agentGuiConversationFilter";
import { buildAgentGUIConversationSummaries } from "../model/agentGuiConversationModel";
import {
  AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER,
  conversationRailPageCursor,
  mergeConversationRailPageItems,
  projectRuntimeSectionsToConversationSections,
  stabilizeConversationSections,
  updateConversationSectionsFromSummaries,
  type ConversationRailSectionPageState
} from "./agentGUIConversationRailData";

const AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE = 5;

export interface AgentGUIConversationRailInput {
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  conversationQuery: string;
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  labels: AgentGUIViewLabels;
  previewMode: boolean;
  sectionAgentTargetFallbackId: string | null;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  workspaceId: string;
}

export function useAgentGUIConversationRail({
  conversationFilter,
  conversationQuery,
  conversations,
  labels,
  previewMode,
  sectionAgentTargetFallbackId,
  userProjects,
  workspaceId
}: AgentGUIConversationRailInput): {
  loadMoreSectionConversations: (section: ConversationSection) => void;
  runtimeSectionsEnabled: boolean;
  runtimeRailSections: ConversationSection[] | null;
  runtimeRailSectionsPending: boolean;
  sectionPageStates: ReadonlyMap<string, ConversationRailSectionPageState>;
} {
  const agentActivityRuntime = useAgentActivityRuntime();
  const [runtimeRailSections, setRuntimeRailSections] = useState<
    ConversationSection[] | null
  >(null);
  const [runtimeRailSectionsPending, setRuntimeRailSectionsPending] =
    useState(false);
  const [sectionPageStates, setSectionPageStates] = useState<
    ReadonlyMap<string, ConversationRailSectionPageState>
  >(() => new Map());
  const conversationsRef = useRef(conversations);
  const pagingRequestSequenceRef = useRef(0);
  const pagingAbortControllersRef = useRef(new Map<string, AbortController>());
  const workspaceIdRef = useRef(workspaceId);
  const runtimeListSessionSections = agentActivityRuntime.listSessionSections;
  const runtimeListSessionSectionPage =
    agentActivityRuntime.listSessionSectionPage;
  const runtimeListPinnedSessionsPage =
    agentActivityRuntime.listPinnedSessionsPage;
  const runtimeSectionsEnabled =
    !previewMode &&
    Boolean(runtimeListSessionSections) &&
    Boolean(runtimeListSessionSectionPage);
  const sectionAgentTargetId =
    conversationFilter.kind === "agentTarget"
      ? conversationFilter.agentTargetId.trim()
      : (sectionAgentTargetFallbackId?.trim() ?? "");
  const userProjectPaths = useMemo(
    () =>
      userProjects
        .map((project) => project.path.trim())
        .filter((path) => path.length > 0),
    [userProjects]
  );
  const userProjectPathKey = useMemo(
    () => JSON.stringify(userProjectPaths),
    [userProjectPaths]
  );
  const sectionProjectionLabels = useMemo(
    () => ({
      sectionConversations: labels.sectionConversations,
      sectionPinned: labels.sectionPinned
    }),
    [labels.sectionConversations, labels.sectionPinned]
  );

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    const workspaceChanged = workspaceIdRef.current !== workspaceId;
    workspaceIdRef.current = workspaceId;
    pagingRequestSequenceRef.current += 1;
    for (const controller of pagingAbortControllersRef.current.values()) {
      controller.abort();
    }
    pagingAbortControllersRef.current.clear();
    if (workspaceChanged) {
      setRuntimeRailSections(null);
    }
    setSectionPageStates(new Map());
    return () => {
      pagingRequestSequenceRef.current += 1;
      for (const controller of pagingAbortControllersRef.current.values()) {
        controller.abort();
      }
      pagingAbortControllersRef.current.clear();
    };
  }, [conversationFilter, userProjectPathKey, workspaceId]);

  const conversationMembershipKey = useMemo(
    () =>
      conversations
        .map(
          (conversation) =>
            `${conversation.id}:${conversation.pinnedAtUnixMs ?? 0}`
        )
        .join("|"),
    [conversations]
  );

  useEffect(() => {
    if (!runtimeSectionsEnabled || !runtimeListSessionSections) {
      setRuntimeRailSectionsPending(false);
      return;
    }
    const requestSequence = pagingRequestSequenceRef.current;
    const abortController = new AbortController();
    setRuntimeRailSectionsPending(true);
    void runtimeListSessionSections({
      agentTargetId: sectionAgentTargetId || undefined,
      limitPerSection: AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
      signal: abortController.signal,
      workspaceId
    })
      .then((page) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== pagingRequestSequenceRef.current
        ) {
          return;
        }
        const sections = projectRuntimeSectionsToConversationSections({
          conversationFilter,
          labels: sectionProjectionLabels,
          pinned: page.pinned,
          sections: page.sections,
          workspaceId: page.workspaceId
        });
        const sectionsWithSummaries = updateConversationSectionsFromSummaries(
          sections,
          conversationsRef.current,
          {
            sectionConversationsLabel: labels.sectionConversations,
            sectionPinnedLabel: labels.sectionPinned
          }
        );
        setRuntimeRailSections((current) =>
          stabilizeConversationSections(
            current,
            sectionsWithSummaries ?? sections
          )
        );
        setRuntimeRailSectionsPending(false);
        setSectionPageStates(() => {
          const next = new Map<string, ConversationRailSectionPageState>();
          if (page.pinned) {
            next.set("pinned", {
              hasMore: page.pinned.hasMore,
              isLoading: false,
              nextCursor: page.pinned.nextCursor ?? null
            });
          }
          for (const section of page.sections) {
            next.set(section.sectionKey, {
              hasMore: section.hasMore,
              isLoading: false,
              nextCursor: section.nextCursor ?? null
            });
          }
          return next;
        });
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          requestSequence !== pagingRequestSequenceRef.current
        ) {
          return;
        }
        setRuntimeRailSections([]);
        setRuntimeRailSectionsPending(false);
      });
    return () => {
      abortController.abort();
    };
  }, [
    conversationFilter,
    conversationMembershipKey,
    labels.sectionConversations,
    runtimeListSessionSections,
    runtimeSectionsEnabled,
    sectionProjectionLabels,
    sectionAgentTargetId,
    userProjectPathKey,
    workspaceId
  ]);

  useEffect(() => {
    if (!runtimeSectionsEnabled) {
      return;
    }
    const filteredConversations = filterAgentGUIConversationSummaries(
      conversations,
      conversationFilter
    );
    setRuntimeRailSections((current) =>
      updateConversationSectionsFromSummaries(current, filteredConversations, {
        sectionConversationsLabel: labels.sectionConversations,
        sectionPinnedLabel: labels.sectionPinned
      })
    );
  }, [
    conversationFilter,
    conversations,
    labels.sectionConversations,
    labels.sectionPinned,
    runtimeSectionsEnabled
  ]);

  const loadMoreSectionConversations = useCallback(
    (section: ConversationSection) => {
      if (previewMode || conversationQuery.trim()) {
        return;
      }
      const currentPageState = sectionPageStates.get(section.id);
      if (currentPageState?.isLoading || currentPageState?.hasMore === false) {
        return;
      }
      if (section.kind === "pinned" && !runtimeListPinnedSessionsPage) {
        return;
      }
      if (section.kind !== "pinned" && !runtimeListSessionSectionPage) {
        return;
      }
      const fallbackCursor = conversationRailPageCursor(section.items);
      const cursor = currentPageState?.nextCursor ?? fallbackCursor;
      const requestSequence = pagingRequestSequenceRef.current;
      const abortController = new AbortController();
      pagingAbortControllersRef.current.set(section.id, abortController);
      setSectionPageStates((current) => {
        const next = new Map(current);
        next.set(section.id, {
          hasMore: currentPageState?.hasMore ?? true,
          isLoading: true,
          nextCursor: currentPageState?.nextCursor ?? null
        });
        return next;
      });
      if (section.kind === "pinned") {
        const listPinnedSessionsPage = runtimeListPinnedSessionsPage;
        if (!listPinnedSessionsPage) {
          return;
        }
        void listPinnedSessionsPage({
          agentTargetId: sectionAgentTargetId || undefined,
          cursor: cursor || undefined,
          limit: AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
          signal: abortController.signal,
          workspaceId
        })
          .then((page) => {
            if (
              abortController.signal.aborted ||
              requestSequence !== pagingRequestSequenceRef.current
            ) {
              return;
            }
            const pageConversations = buildAgentGUIConversationSummaries({
              conversationFilter,
              provider: AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER,
              snapshot: {
                composerOptionsByTargetKey: {},
                presences: [],
                sessionMessagesById: {},
                sessions: page.sessions,
                workspaceId
              },
              userProjects: []
            }).filter((conversation) => (conversation.pinnedAtUnixMs ?? 0) > 0);
            setRuntimeRailSections((current) => {
              if (!current) {
                return current;
              }
              return current.map((candidate) =>
                candidate.id === section.id
                  ? {
                      ...candidate,
                      items: mergeConversationRailPageItems(
                        candidate.items,
                        pageConversations
                      )
                    }
                  : candidate
              );
            });
            setSectionPageStates((current) => {
              const next = new Map(current);
              next.set(section.id, {
                hasMore: page.hasMore,
                isLoading: false,
                nextCursor: page.nextCursor ?? null
              });
              return next;
            });
          })
          .catch(() => {
            if (
              abortController.signal.aborted ||
              requestSequence !== pagingRequestSequenceRef.current
            ) {
              return;
            }
            setSectionPageStates((current) => {
              const next = new Map(current);
              const existing = next.get(section.id);
              next.set(section.id, {
                hasMore: existing?.hasMore ?? true,
                isLoading: false,
                nextCursor: existing?.nextCursor ?? null
              });
              return next;
            });
          })
          .finally(() => {
            if (
              pagingAbortControllersRef.current.get(section.id) ===
              abortController
            ) {
              pagingAbortControllersRef.current.delete(section.id);
            }
          });
        return;
      }
      const listSessionSectionPage = runtimeListSessionSectionPage;
      if (!listSessionSectionPage) {
        return;
      }
      void listSessionSectionPage({
        agentTargetId: sectionAgentTargetId || undefined,
        cursor: cursor || undefined,
        limit: AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
        sectionKey: section.id,
        signal: abortController.signal,
        workspaceId
      })
        .then((pageSection) => {
          if (
            abortController.signal.aborted ||
            requestSequence !== pagingRequestSequenceRef.current
          ) {
            return;
          }
          const pageConversations = buildAgentGUIConversationSummaries({
            conversationFilter,
            provider: AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER,
            snapshot: {
              composerOptionsByTargetKey: {},
              presences: [],
              sessionMessagesById: {},
              sessions: pageSection.sessions,
              workspaceId
            },
            userProjects: []
          }).map((conversation) => ({
            ...conversation,
            project: section.kind === "project" ? section.project : null
          }));
          setRuntimeRailSections((current) => {
            if (!current) {
              return current;
            }
            return current.map((candidate) =>
              candidate.id === section.id
                ? {
                    ...candidate,
                    items: mergeConversationRailPageItems(
                      candidate.items,
                      pageConversations
                    )
                  }
                : candidate
            );
          });
          setSectionPageStates((current) => {
            const next = new Map(current);
            next.set(section.id, {
              hasMore: pageSection.hasMore,
              isLoading: false,
              nextCursor: pageSection.nextCursor ?? null
            });
            return next;
          });
        })
        .catch(() => {
          if (
            abortController.signal.aborted ||
            requestSequence !== pagingRequestSequenceRef.current
          ) {
            return;
          }
          setSectionPageStates((current) => {
            const next = new Map(current);
            const existing = next.get(section.id);
            next.set(section.id, {
              hasMore: existing?.hasMore ?? true,
              isLoading: false,
              nextCursor: existing?.nextCursor ?? null
            });
            return next;
          });
        })
        .finally(() => {
          if (
            pagingAbortControllersRef.current.get(section.id) ===
            abortController
          ) {
            pagingAbortControllersRef.current.delete(section.id);
          }
        });
    },
    [
      conversationFilter,
      conversationQuery,
      previewMode,
      runtimeListPinnedSessionsPage,
      runtimeListSessionSectionPage,
      sectionAgentTargetId,
      sectionPageStates,
      workspaceId
    ]
  );

  return {
    loadMoreSectionConversations,
    runtimeSectionsEnabled,
    runtimeRailSections,
    runtimeRailSectionsPending,
    sectionPageStates
  };
}
