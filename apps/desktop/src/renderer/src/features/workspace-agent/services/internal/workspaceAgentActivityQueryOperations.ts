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
    return this.tuttidClient.listWorkspaceAgentGeneratedFiles(
      normalizeWorkspaceId(input.workspaceId),
      {
        limit: input.limit,
        query: input.query?.trim() || undefined,
        sessionCwd: input.sessionCwd?.trim() || undefined
      }
    );
  }

  async listSessionsPage(
    input: Parameters<IWorkspaceAgentActivityService["listSessionsPage"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionsPage"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response = await this.tuttidClient.listWorkspaceAgentSessions(
      workspaceId,
      {
        limit: input.limit,
        searchQuery: input.searchQuery?.trim() || undefined
      },
      { signal: input.signal }
    );
    return {
      hasMore: false,
      nextCursor: undefined,
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
    const pinned = response.pinned ?? { hasMore: false, sessions: [] };
    return {
      pinned: {
        hasMore: pinned.hasMore,
        nextCursor: pinned.nextCursor,
        sessions: pinned.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(workspaceId, session)
        )
      },
      sections: response.sections.map((section) => ({
        hasMore: section.hasMore,
        kind: section.kind,
        nextCursor: section.nextCursor,
        sectionKey: section.sectionKey,
        sessions: section.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(workspaceId, session)
        ),
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
      )
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
      userProject: response.section.userProject
    };
  }

  async countSessionSection(
    input: Parameters<IWorkspaceAgentActivityService["countSessionSection"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["countSessionSection"]> {
    const response = await this.tuttidClient.countWorkspaceAgentSessionSection(
      normalizeWorkspaceId(input.workspaceId),
      {
        agentTargetId: input.agentTargetId?.trim() || undefined,
        sectionKey: input.sectionKey
      },
      { signal: input.signal }
    );
    return {
      agentTargetId: response.agentTargetId,
      count: response.count,
      sectionKey: response.sectionKey,
      workspaceId: response.workspaceId
    };
  }
}
