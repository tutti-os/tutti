import type { AgentActivitySessionDetailSnapshot } from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentSessionDetailResponse } from "@tutti-os/client-tuttid-ts";
import {
  agentActivitySessionFromTuttidSession,
  agentActivityTurnFromTuttidTurn,
  type AgentActivitySessionMappingOptions
} from "./mappers.ts";

/**
 * Maps one authoritative tuttid detail response without performing transport
 * or dispatch work. Hosts feed the returned aggregate to the engine through a
 * single `session/detailSnapshotReceived` intent so root, child, and Turn
 * state cannot become observably half-applied.
 */
export function agentActivitySessionDetailFromTuttid(
  workspaceId: string,
  expectedAgentSessionId: string,
  detail: WorkspaceAgentSessionDetailResponse,
  options: AgentActivitySessionMappingOptions
): AgentActivitySessionDetailSnapshot {
  assertTuttidSessionDetailContract(expectedAgentSessionId, detail);
  return {
    session: agentActivitySessionFromTuttidSession(
      workspaceId,
      detail.session,
      options
    ),
    childSessions: detail.childSessions.map((session) =>
      agentActivitySessionFromTuttidSession(workspaceId, session, options)
    ),
    turns: detail.turns.map(agentActivityTurnFromTuttidTurn)
  };
}

function assertTuttidSessionDetailContract(
  expectedAgentSessionId: string,
  detail: WorkspaceAgentSessionDetailResponse
): void {
  const expectedId = trimmedString(expectedAgentSessionId);
  const rootId = trimmedString(detail.session?.id);
  if (!expectedId || rootId !== expectedId) {
    throw detailContractError(
      `root Session id ${JSON.stringify(rootId)} does not match requested id ${JSON.stringify(expectedId)}`
    );
  }
  if (!Array.isArray(detail.childSessions) || !Array.isArray(detail.turns)) {
    throw detailContractError(
      "childSessions and turns must be authoritative arrays"
    );
  }
  const hierarchyRootId =
    detail.session.kind === "root"
      ? rootId
      : trimmedString(detail.session.rootAgentSessionId);
  if (
    (detail.session.kind !== "root" && detail.session.kind !== "child") ||
    !hierarchyRootId
  ) {
    throw detailContractError(
      "requested Session hierarchy identity is invalid"
    );
  }

  const childrenById = new Map<
    string,
    WorkspaceAgentSessionDetailResponse["childSessions"][number]
  >();
  for (const child of detail.childSessions) {
    const childId = trimmedString(child.id);
    if (
      !childId ||
      childId === rootId ||
      child.kind !== "child" ||
      trimmedString(child.rootAgentSessionId) !== hierarchyRootId ||
      childrenById.has(childId)
    ) {
      throw detailContractError(
        `child Session identity ${JSON.stringify(childId)} is invalid`
      );
    }
    childrenById.set(childId, child);
  }

  for (const child of detail.childSessions) {
    assertDescendsFromRequestedSession(child, rootId, childrenById);
  }
  for (const turn of detail.turns) {
    const turnId = trimmedString(turn.turnId);
    const ownerId = trimmedString(turn.agentSessionId);
    if (!turnId || ownerId !== rootId) {
      throw detailContractError(
        `Turn ${JSON.stringify(turnId)} must be owned by requested Session ${JSON.stringify(rootId)}`
      );
    }
  }
}

function assertDescendsFromRequestedSession(
  child: WorkspaceAgentSessionDetailResponse["childSessions"][number],
  requestedSessionId: string,
  childrenById: ReadonlyMap<
    string,
    WorkspaceAgentSessionDetailResponse["childSessions"][number]
  >
): void {
  const childId = trimmedString(child.id);
  const visited = new Set<string>([childId]);
  let parentId = trimmedString(child.parentAgentSessionId);
  while (parentId && parentId !== requestedSessionId) {
    if (visited.has(parentId)) {
      throw detailContractError(
        `child Session ${JSON.stringify(childId)} contains a parent cycle`
      );
    }
    visited.add(parentId);
    parentId = trimmedString(childrenById.get(parentId)?.parentAgentSessionId);
  }
  if (parentId !== requestedSessionId) {
    throw detailContractError(
      `child Session ${JSON.stringify(childId)} is outside the requested Session hierarchy`
    );
  }
}

function detailContractError(reason: string): Error {
  return new Error(`Protocol v2 contract error: ${reason}`);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
