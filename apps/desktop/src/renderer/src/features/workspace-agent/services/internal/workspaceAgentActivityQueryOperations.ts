import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { agentActivitySessionFromTuttidSession } from "../desktopAgentActivityAdapter.ts";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface.ts";
import { normalizeWorkspaceId } from "./workspaceAgentActivityDiagnostics.ts";

export class WorkspaceAgentActivityQueryOperations {
  private readonly tuttidClient: TuttidClient;

  constructor(tuttidClient: TuttidClient) {
    this.tuttidClient = tuttidClient;
  }

  async listAgentGeneratedFiles(
    input: Parameters<
      IWorkspaceAgentActivityService["listAgentGeneratedFiles"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["listAgentGeneratedFiles"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentTargetIds = input.agentTargetIds
      ?.map((agentTargetId) => agentTargetId.trim())
      .filter(Boolean);
    if (input.agentTargetIds && agentTargetIds?.length === 0) {
      return {
        entries: [],
        hasMore: false,
        workspaceId
      };
    }
    return this.tuttidClient.listWorkspaceAgentGeneratedFiles(
      workspaceId,
      {
        agentTargetIds,
        cursor: input.cursor?.trim() || undefined,
        limit: input.limit,
        query: input.query?.trim() || undefined,
        sectionKey: input.sectionKey.trim()
      },
      { signal: input.signal }
    );
  }

  async listSessionsPage(
    input: Parameters<IWorkspaceAgentActivityService["listSessionsPage"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionsPage"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response = await this.tuttidClient.listWorkspaceAgentSessions(
      workspaceId,
      {
        agentTargetId: input.agentTargetId?.trim() || undefined,
        cursor: input.cursor?.trim() || undefined,
        limit: input.limit,
        searchQuery: input.searchQuery?.trim() || undefined
      },
      { signal: input.signal }
    );
    return {
      hasMore: response.hasMore,
      nextCursor: response.nextCursor,
      sessions: response.sessions.map((session) =>
        agentActivitySessionFromTuttidSession(workspaceId, session)
      ),
      workspaceId: response.workspaceId
    };
  }

  async listSessionSections(
    input: Parameters<IWorkspaceAgentActivityService["listSessionSections"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionSections"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response = await this.tuttidClient.listWorkspaceAgentSessionSections(
      workspaceId,
      {
        agentTargetId: input.agentTargetId?.trim() || undefined,
        limitPerSection: input.limitPerSection
      },
      { signal: input.signal }
    );
    const pinned = response.pinned;
    return {
      pinned: {
        hasMore: pinned.hasMore,
        nextCursor: pinned.nextCursor,
        sessions: pinned.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(workspaceId, session)
        ),
        totalCount: pinned.totalCount
      },
      sections: response.sections.map((section) => ({
        hasMore: section.hasMore,
        kind: section.kind,
        nextCursor: section.nextCursor,
        sectionKey: section.sectionKey,
        sessions: section.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(workspaceId, session)
        ),
        totalCount: section.totalCount,
        userProject: section.userProject
      })),
      workspaceId: response.workspaceId
    };
  }

  async listPinnedSessionsPage(
    input: Parameters<
      IWorkspaceAgentActivityService["listPinnedSessionsPage"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["listPinnedSessionsPage"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.tuttidClient.listWorkspaceAgentPinnedSessionPage(
        workspaceId,
        {
          agentTargetId: input.agentTargetId?.trim() || undefined,
          cursor: input.cursor?.trim() || undefined,
          limit: input.limit
        },
        { signal: input.signal }
      );
    return {
      hasMore: response.page.hasMore,
      nextCursor: response.page.nextCursor,
      sessions: response.page.sessions.map((session) =>
        agentActivitySessionFromTuttidSession(workspaceId, session)
      ),
      totalCount: response.page.totalCount
    };
  }

  async listSessionSectionPage(
    input: Parameters<
      IWorkspaceAgentActivityService["listSessionSectionPage"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionSectionPage"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.tuttidClient.listWorkspaceAgentSessionSectionPage(
        workspaceId,
        {
          agentTargetId: input.agentTargetId?.trim() || undefined,
          cursor: input.cursor?.trim() || undefined,
          limit: input.limit,
          sectionKey: input.sectionKey
        },
        { signal: input.signal }
      );
    return {
      hasMore: response.section.hasMore,
      kind: response.section.kind,
      nextCursor: response.section.nextCursor,
      sectionKey: response.section.sectionKey,
      sessions: response.section.sessions.map((session) =>
        agentActivitySessionFromTuttidSession(workspaceId, session)
      ),
      totalCount: response.section.totalCount,
      userProject: response.section.userProject
    };
  }

  async listSessionSectionDeletionCandidates(
    input: Parameters<
      IWorkspaceAgentActivityService["listSessionSectionDeletionCandidates"]
    >[0]
  ): ReturnType<
    IWorkspaceAgentActivityService["listSessionSectionDeletionCandidates"]
  > {
    const response =
      await this.tuttidClient.listWorkspaceAgentSessionSectionDeletionCandidates(
        normalizeWorkspaceId(input.workspaceId),
        {
          agentTargetId: input.agentTargetId?.trim() || undefined,
          excludePinned: input.excludePinned,
          sectionKey: input.sectionKey
        },
        { signal: input.signal }
      );
    return {
      agentTargetId: response.agentTargetId,
      excludePinned: response.excludePinned,
      sectionKey: response.sectionKey,
      sessionIds: response.sessionIds,
      workspaceId: response.workspaceId
    };
  }
}
