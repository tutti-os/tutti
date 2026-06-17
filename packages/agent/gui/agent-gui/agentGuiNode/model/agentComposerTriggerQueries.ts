import { findRichTextTriggerQuery } from "@tutti-os/ui-rich-text/editor";
import type { RichTextTriggerConfig } from "@tutti-os/ui-rich-text/types";
import type { AgentGUIProviderSkillOption } from "./agentGuiNodeTypes";
import { skillTriggerForPrefix } from "./agentSkillOptions";

const agentComposerTriggerConfigs: readonly RichTextTriggerConfig[] = [
  { trigger: "/", boundary: "whitespace" },
  { trigger: "$", boundary: "whitespace" }
];

export interface AgentComposerTriggerQueryMatch {
  end: number;
  prefix: "$" | "/";
  query: string;
  start: number;
}

export function getAgentComposerTriggerQueryMatch(
  draft: string
): AgentComposerTriggerQueryMatch | null {
  const query = findRichTextTriggerQuery(
    draft,
    draft.length,
    agentComposerTriggerConfigs
  );
  if (!query || (query.trigger !== "/" && query.trigger !== "$")) {
    return null;
  }
  return {
    end: query.to,
    prefix: query.trigger,
    query: query.keyword,
    start: query.from
  };
}

export function getPromptStartSlashCommandQuery(draft: string): string | null {
  const match = getAgentComposerTriggerQueryMatch(draft);
  if (!match || match.prefix !== "/") {
    return null;
  }
  return match.start === leadingWhitespaceLength(draft) ? match.query : null;
}

export function draftForSlashCommandTrigger(input: {
  commandName: string;
  currentDraft?: string;
}): string {
  const commandDraft = `/${input.commandName.trim()} `;
  const currentDraft = input.currentDraft ?? "";
  const match = getAgentComposerTriggerQueryMatch(currentDraft);
  return match?.prefix === "/" &&
    match.start === leadingWhitespaceLength(currentDraft)
    ? `${currentDraft.slice(0, match.start)}${commandDraft}`
    : commandDraft;
}

export function filterProviderSkillsForTrigger(input: {
  skills: readonly AgentGUIProviderSkillOption[];
  query: string;
  triggerPrefix: "$" | "/";
}): AgentGUIProviderSkillOption[] {
  const normalizedQuery = input.query.trim().toLowerCase();
  return input.skills.filter((skill) => {
    const trigger = skillTriggerForPrefix(skill, input.triggerPrefix);
    if (!normalizedQuery) {
      return true;
    }
    const name = skill.name.trim().toLowerCase();
    const normalizedTrigger = trigger.trim().toLowerCase();
    const description = skill.description?.trim().toLowerCase() ?? "";
    return (
      name.startsWith(normalizedQuery) ||
      normalizedTrigger.slice(1).startsWith(normalizedQuery) ||
      description.includes(normalizedQuery)
    );
  });
}

export function draftForProviderSkillTrigger(input: {
  skill: AgentGUIProviderSkillOption;
  currentDraft?: string;
  match?: AgentComposerTriggerQueryMatch | null;
}): string {
  const currentDraft = input.currentDraft ?? "";
  const match =
    input.match === undefined
      ? getAgentComposerTriggerQueryMatch(currentDraft)
      : input.match;
  const trigger = skillTriggerForPrefix(input.skill, match?.prefix);
  if (!trigger) {
    return currentDraft;
  }
  if (!match) {
    return `${trigger} `;
  }
  return `${currentDraft.slice(0, match.start)}${trigger} ${currentDraft.slice(
    match.end
  )}`;
}

function leadingWhitespaceLength(value: string): number {
  const match = /^(\s*)/.exec(value);
  return match?.[1]?.length ?? 0;
}
