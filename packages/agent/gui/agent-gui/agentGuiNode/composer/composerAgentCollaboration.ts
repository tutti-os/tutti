import { parseAgentMentionMarkdown } from "../agentRichText/agentMentionMarkdown";

export interface AgentComposerCollaborationTargetMention {
  name: string;
  targetId: string;
  workspaceId: string;
}

/**
 * Extracts durable Agent target mentions from composer markdown. Plain-text
 * `@name` tokens are intentionally ignored because they do not carry a stable
 * workspace target identity.
 */
export function agentCollaborationTargetsFromPrompt(
  prompt: string
): AgentComposerCollaborationTargetMention[] {
  const targets: AgentComposerCollaborationTargetMention[] = [];
  const seenTargetIds = new Set<string>();
  let cursor = 0;
  while (cursor < prompt.length) {
    const parsed = parseAgentMentionMarkdown(prompt, cursor);
    if (!parsed) {
      cursor += 1;
      continue;
    }
    cursor = parsed.end;
    if (parsed.item.kind !== "agent-target") {
      continue;
    }
    const targetId = parsed.item.targetId.trim();
    if (!targetId || seenTargetIds.has(targetId)) {
      continue;
    }
    seenTargetIds.add(targetId);
    targets.push({
      name: parsed.item.name.trim() || targetId,
      targetId,
      workspaceId: parsed.item.workspaceId.trim()
    });
  }
  return targets;
}

/**
 * Removes transport-only mention URLs while retaining a readable `@Agent`
 * token in the delegated request that the target session receives.
 */
export function collaborationQuestionFromPrompt(prompt: string): string {
  let result = "";
  let cursor = 0;
  let segmentStart = 0;
  while (cursor < prompt.length) {
    const parsed = parseAgentMentionMarkdown(prompt, cursor);
    if (!parsed) {
      cursor += 1;
      continue;
    }
    if (parsed.item.kind !== "agent-target") {
      cursor = parsed.end;
      continue;
    }
    result += prompt.slice(segmentStart, cursor);
    const name = parsed.item.name.trim().replace(/^@+/, "");
    result += name ? `@${name}` : "@Agent";
    cursor = parsed.end;
    segmentStart = cursor;
  }
  return `${result}${prompt.slice(segmentStart)}`.trim();
}
