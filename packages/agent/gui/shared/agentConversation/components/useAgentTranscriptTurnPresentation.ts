import { useMemo } from "react";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import {
  buildAgentTurnWorkSectionModel,
  type AgentTurnWorkSectionModel
} from "./agentTurnWorkSectionModel";
import type { AgentTranscriptTurnGroup } from "./agentTranscriptModel";
import type { AgentTranscriptVirtualLayoutEntry } from "./agentTranscriptVirtualizerLayout";

const AGENT_TRANSCRIPT_DISCLOSURE_TURN_GAP_PX = 24;
const AGENT_TRANSCRIPT_LEGACY_TURN_GAP_PX = 12;

export function useAgentTranscriptTurnPresentation(
  conversation: AgentConversationVM,
  turnGroups: readonly AgentTranscriptTurnGroup[]
): {
  canonicalTurnById: ReadonlyMap<
    string,
    NonNullable<AgentConversationVM["sourceDetail"]["sessionTurns"]>[number]
  >;
  turnWorkSectionModelByKey: ReadonlyMap<
    string,
    AgentTurnWorkSectionModel | null
  >;
  virtualEntries: readonly AgentTranscriptVirtualLayoutEntry[];
} {
  const canonicalTurnById = useMemo(
    () =>
      new Map(
        (conversation.sourceDetail.sessionTurns ?? []).map((turn) => [
          turn.turnId,
          turn
        ])
      ),
    [conversation.sourceDetail.sessionTurns]
  );
  const turnWorkSectionModelByKey = useMemo(
    () =>
      new Map(
        turnGroups.map((group) => {
          const isActiveTurn =
            group.turnId !== null &&
            group.turnId === conversation.sourceDetail.session.activeTurnId;
          return [
            group.key,
            buildAgentTurnWorkSectionModel(
              group,
              group.turnId
                ? (canonicalTurnById.get(group.turnId) ?? null)
                : null,
              isActiveTurn,
              {
                collapseIntermediateAssistantReplies:
                  !conversation.sourceDetail.session.imported
              }
            )
          ] as const;
        })
      ),
    [
      canonicalTurnById,
      conversation.sourceDetail.session.activeTurnId,
      conversation.sourceDetail.session.imported,
      turnGroups
    ]
  );
  const virtualEntries = useMemo(
    () =>
      turnGroups.map((group) => ({
        gapAfterPx: turnWorkSectionModelByKey.get(group.key)
          ? AGENT_TRANSCRIPT_DISCLOSURE_TURN_GAP_PX
          : AGENT_TRANSCRIPT_LEGACY_TURN_GAP_PX,
        key: group.key
      })),
    [turnGroups, turnWorkSectionModelByKey]
  );

  return {
    canonicalTurnById,
    turnWorkSectionModelByKey,
    virtualEntries
  };
}
