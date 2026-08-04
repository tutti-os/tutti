import type {
  AgentActivitySession,
  AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import {
  createAgentGUIConversationRailQueryController,
  type AgentGUIConversationRailQueryController,
  type AgentGUIConversationRailQuerySnapshot,
  type ConversationRailQueryRuntime
} from "@tutti-os/agent-gui/conversation-rail-controller";
import type {
  TuttidClient,
  UserProject,
  WorkspaceAgentSession,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import { ObservableService } from "./observableService";
import type { ClockPort } from "./servicePorts";

const SESSION_POLL_MS = 2_000;
const SESSION_PAGE_SIZE = 30;
const SESSION_SECTION_LIMIT_MAX = 100;

export type WorkspaceConversationRailSectionKind =
  | "pinned"
  | "project"
  | "conversations";

export interface WorkspaceConversationRailMembership {
  hasMore: boolean;
  id: string;
  kind: WorkspaceConversationRailSectionKind;
  nextCursor: string | null;
  project: UserProject | null;
  sectionKey: string | null;
  sessionIds: readonly string[];
  totalCount: number;
}

export interface WorkspaceConversationRailSnapshot {
  errorCode: "request_failed" | null;
  loadingMoreSectionId: string | null;
  sections: readonly WorkspaceConversationRailMembership[];
  status: "idle" | "loading" | "ready";
}

interface WorkspaceConversationRailServiceDependencies {
  engine: AgentSessionEngine;
  getActiveConversationId(): string | null;
  mapSession(session: WorkspaceAgentSession): AgentActivitySession;
}

/**
 * Mobile host wrapper around the shared headless conversation-Rail controller.
 *
 * The shared controller owns section membership, cursor paging, stale-request
 * fences, cache refresh, and canonical Engine ingestion. Mobile owns only its
 * disconnected polling cadence and foreground/background availability.
 */
export class WorkspaceConversationRailService extends ObservableService<WorkspaceConversationRailSnapshot> {
  readonly _serviceBrand: undefined;
  private readonly controller: AgentGUIConversationRailQueryController;
  private disposed = false;
  private liveConnected = false;
  private paused = false;
  private attached = false;
  private controllerDetach: (() => void) | null = null;
  private loadPromise: Promise<void> | null = null;
  private pollTask: { cancel(): void } | null = null;
  private snapshot: WorkspaceConversationRailSnapshot = {
    errorCode: null,
    loadingMoreSectionId: null,
    sections: [],
    status: "idle"
  };
  private readonly unsubscribeController: () => void;

  constructor(
    readonly workspace: WorkspaceSummary,
    client: TuttidClient,
    private readonly clock: ClockPort,
    dependencies: WorkspaceConversationRailServiceDependencies
  ) {
    super();
    this.controller = createAgentGUIConversationRailQueryController({
      engine: dependencies.engine,
      getActiveConversationId: dependencies.getActiveConversationId,
      runtime: createMobileConversationRailRuntime({
        client,
        mapSession: dependencies.mapSession,
        workspaceId: workspace.id
      }),
      scheduler: {
        schedule: (delayMs, task) => this.clock.schedule(delayMs, task)
      },
      sectionPageSize: SESSION_PAGE_SIZE,
      sectionRefreshLimitMax: SESSION_SECTION_LIMIT_MAX,
      workspaceId: workspace.id
    });
    this.unsubscribeController = this.controller.subscribe((snapshot) => {
      this.applyControllerSnapshot(snapshot);
    });
    this.controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });
    this.applyControllerSnapshot(this.controller.getSnapshot());
  }

  getSnapshot = (): WorkspaceConversationRailSnapshot => this.snapshot;

  start(): Promise<void> {
    if (this.disposed || this.paused) return Promise.resolve();
    this.ensureAttached();
    return this.refresh();
  }

  refresh(): Promise<void> {
    if (this.paused || this.disposed) return Promise.resolve();
    this.ensureAttached();
    if (this.snapshot.status === "idle") {
      this.snapshot = { ...this.snapshot, status: "loading" };
      this.emitChange();
    }
    const request = this.controller
      .refresh()
      .then(() => undefined)
      .finally(() => {
        if (this.loadPromise === request) this.loadPromise = null;
        this.schedulePoll();
      });
    this.loadPromise = request;
    return request;
  }

  async reconcile(): Promise<WorkspaceConversationRailSnapshot> {
    await this.refresh();
    if (this.disposed || this.paused) {
      throw new Error("mobile conversation rail is unavailable");
    }
    return this.snapshot;
  }

  async loadMore(sectionId: string): Promise<void> {
    if (this.paused || this.disposed) return;
    this.pollTask?.cancel();
    this.pollTask = null;
    const querySectionId = mobileRailQuerySectionId(sectionId);
    this.controller.loadMoreSectionConversations({ id: querySectionId });
    if (
      this.controller.getSnapshot().sectionPageStates.get(querySectionId)
        ?.isLoading
    ) {
      await this.waitForSectionPage(querySectionId);
    }
    this.schedulePoll();
  }

  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    this.pollTask?.cancel();
    this.pollTask = null;
    this.detachController();
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    this.ensureAttached();
    void this.refresh();
  }

  setLiveConnected(connected: boolean): void {
    if (this.liveConnected === connected || this.disposed) return;
    this.liveConnected = connected;
    this.pollTask?.cancel();
    this.pollTask = null;
    if (!connected) this.schedulePoll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pollTask?.cancel();
    this.pollTask = null;
    this.loadPromise = null;
    this.detachController();
    this.unsubscribeController();
    this.clearListeners();
  }

  private applyControllerSnapshot(
    snapshot: AgentGUIConversationRailQuerySnapshot
  ): void {
    if (this.disposed) return;
    const sections = (snapshot.runtimeRailMemberships ?? []).map(
      (membership): WorkspaceConversationRailMembership => {
        const page = snapshot.sectionPageStates.get(membership.id);
        return {
          hasMore: page?.hasMore ?? false,
          id: mobileRailDisplaySectionId(membership.id, membership.kind),
          kind: membership.kind,
          nextCursor: page?.nextCursor ?? null,
          project: membership.project
            ? {
                createdAtUnixMs: membership.project.createdAtUnixMs ?? 0,
                id: membership.project.id,
                label: membership.project.label,
                lastUsedAtUnixMs: membership.project.lastUsedAtUnixMs ?? 0,
                path: membership.project.path,
                pinnedAtUnixMs: membership.project.pinnedAtUnixMs,
                sectionKey: membership.project.sectionKey ?? membership.id,
                updatedAtUnixMs: membership.project.updatedAtUnixMs ?? 0
              }
            : null,
          sectionKey: membership.kind === "pinned" ? null : membership.id,
          sessionIds: membership.sessionIds,
          totalCount: page?.totalCount ?? membership.sessionIds.length
        };
      }
    );
    const loadingMoreSectionId =
      [...snapshot.sectionPageStates].find(
        ([, state]) => state.isLoading
      )?.[0] ?? null;
    const next: WorkspaceConversationRailSnapshot = {
      errorCode: snapshot.runtimeRailFailed ? "request_failed" : null,
      loadingMoreSectionId:
        loadingMoreSectionId === null
          ? null
          : mobileRailDisplaySectionId(
              loadingMoreSectionId,
              loadingMoreSectionId === "pinned" ? "pinned" : "conversations"
            ),
      sections,
      status:
        snapshot.runtimeRailMemberships === null &&
        snapshot.runtimeRailSectionsPending
          ? "loading"
          : "ready"
    };
    if (sameRailSnapshot(this.snapshot, next)) return;
    this.snapshot = next;
    this.emitChange();
  }

  private ensureAttached(): void {
    if (this.attached || this.disposed || this.paused) return;
    this.attached = true;
    this.controllerDetach = this.controller.attach();
  }

  private detachController(): void {
    if (!this.attached) return;
    this.attached = false;
    this.controllerDetach?.();
    this.controllerDetach = null;
  }

  private waitForSectionPage(sectionId: string): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = this.controller.subscribe((snapshot) => {
        if (
          this.disposed ||
          this.paused ||
          snapshot.sectionPageStates.get(sectionId)?.isLoading !== true
        ) {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  private schedulePoll(): void {
    this.pollTask?.cancel();
    if (this.disposed || this.paused || this.liveConnected) return;
    this.pollTask = this.clock.schedule(SESSION_POLL_MS, () => {
      this.pollTask = null;
      void this.refresh();
    });
  }
}

function mobileRailQuerySectionId(sectionId: string): string {
  return sectionId.startsWith("section:")
    ? sectionId.slice("section:".length)
    : sectionId;
}

function mobileRailDisplaySectionId(
  sectionId: string,
  kind: WorkspaceConversationRailSectionKind
): string {
  return kind === "pinned" ? "pinned" : `section:${sectionId}`;
}

function createMobileConversationRailRuntime(input: {
  client: TuttidClient;
  mapSession(session: WorkspaceAgentSession): AgentActivitySession;
  workspaceId: string;
}): ConversationRailQueryRuntime {
  return {
    async listPinnedSessionsPage(query) {
      const response = await input.client.listWorkspaceAgentPinnedSessionPage(
        input.workspaceId,
        {
          ...(query.agentTargetId
            ? { agentTargetId: query.agentTargetId }
            : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit === undefined ? {} : { limit: query.limit })
        },
        { signal: query.signal }
      );
      return {
        hasMore: response.page.hasMore,
        ...(response.page.nextCursor
          ? { nextCursor: response.page.nextCursor }
          : {}),
        sessions: response.page.sessions.map(input.mapSession),
        totalCount: response.page.totalCount
      };
    },
    async listSessionSectionPage(query) {
      const response = await input.client.listWorkspaceAgentSessionSectionPage(
        input.workspaceId,
        {
          ...(query.agentTargetId
            ? { agentTargetId: query.agentTargetId }
            : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          sectionKey: query.sectionKey
        },
        { signal: query.signal }
      );
      return {
        hasMore: response.section.hasMore,
        kind: response.section.kind,
        ...(response.section.nextCursor
          ? { nextCursor: response.section.nextCursor }
          : {}),
        sectionKey: response.section.sectionKey,
        sessions: response.section.sessions.map(input.mapSession),
        totalCount: response.section.totalCount,
        ...(response.section.userProject
          ? { userProject: response.section.userProject }
          : {})
      };
    },
    async listSessionSections(query) {
      const response = await input.client.listWorkspaceAgentSessionSections(
        input.workspaceId,
        {
          ...(query.agentTargetId
            ? { agentTargetId: query.agentTargetId }
            : {}),
          ...(query.limitPerSection === undefined
            ? {}
            : { limitPerSection: query.limitPerSection })
        },
        { signal: query.signal }
      );
      return {
        ...(response.pinned.totalCount > 0
          ? {
              pinned: {
                hasMore: response.pinned.hasMore,
                ...(response.pinned.nextCursor
                  ? { nextCursor: response.pinned.nextCursor }
                  : {}),
                sessions: response.pinned.sessions.map(input.mapSession),
                totalCount: response.pinned.totalCount
              }
            }
          : {}),
        sections: response.sections.map((section) => ({
          hasMore: section.hasMore,
          kind: section.kind,
          ...(section.nextCursor ? { nextCursor: section.nextCursor } : {}),
          sectionKey: section.sectionKey,
          sessions: section.sessions.map(input.mapSession),
          totalCount: section.totalCount,
          ...(section.userProject ? { userProject: section.userProject } : {})
        })),
        workspaceId: input.workspaceId
      };
    }
  };
}

function sameRailSnapshot(
  left: WorkspaceConversationRailSnapshot,
  right: WorkspaceConversationRailSnapshot
): boolean {
  return (
    left.errorCode === right.errorCode &&
    left.loadingMoreSectionId === right.loadingMoreSectionId &&
    left.status === right.status &&
    left.sections.length === right.sections.length &&
    left.sections.every((section, index) => {
      const other = right.sections[index];
      return (
        other !== undefined &&
        section.id === other.id &&
        section.hasMore === other.hasMore &&
        section.nextCursor === other.nextCursor &&
        section.totalCount === other.totalCount &&
        section.project === other.project &&
        section.sessionIds.length === other.sessionIds.length &&
        section.sessionIds.every(
          (sessionId, sessionIndex) =>
            sessionId === other.sessionIds[sessionIndex]
        )
      );
    })
  );
}
