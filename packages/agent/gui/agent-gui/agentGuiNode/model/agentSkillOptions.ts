import type { AgentGUIProviderSkillOption } from "./agentGuiNodeTypes";

export function skillTriggerForPrefix(
  skill: AgentGUIProviderSkillOption,
  prefix: "$" | "/" | undefined
): string {
  const trigger = skill.trigger.trim();
  if (!trigger) {
    return "";
  }
  if (prefix === undefined || trigger.startsWith(prefix)) {
    return trigger;
  }
  if (trigger.startsWith("$") || trigger.startsWith("/")) {
    return `${prefix}${trigger.slice(1)}`;
  }
  return `${prefix}${trigger}`;
}

export function labelForProviderSkill(
  skill: AgentGUIProviderSkillOption,
  prefix: "$" | "/" | undefined
): string {
  return stripSkillTriggerPrefix(skillTriggerForPrefix(skill, prefix));
}

export function promptForProviderSkills(input: {
  prompt: string;
  skills: readonly AgentGUIProviderSkillOption[];
}): string {
  let prompt = input.prompt;
  for (const skill of input.skills) {
    if (!skill.invocation) {
      continue;
    }
    const nativePrefix = skill.invocation === "promptItem" ? "$" : "/";
    const nativeTrigger = skillTriggerForPrefix(skill, nativePrefix);
    const aliasPrefix = nativePrefix === "$" ? "/" : "$";
    const aliasTrigger = skillTriggerForPrefix(skill, aliasPrefix);
    if (!nativeTrigger || !aliasTrigger || nativeTrigger === aliasTrigger) {
      continue;
    }
    prompt = replaceSkillTriggerToken(prompt, aliasTrigger, nativeTrigger);
  }
  return prompt;
}

export function skillDescriptionForDisplay(
  description: string | undefined
): string | undefined {
  const line = description
    ?.split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line || undefined;
}

function replaceSkillTriggerToken(
  prompt: string,
  from: string,
  to: string
): string {
  return prompt.replace(
    new RegExp(`(^|\\s)${escapeRegExp(from)}(?=$|\\s)`, "g"),
    (_match, separator: string) => `${separator}${to}`
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSkillTriggerPrefix(trigger: string): string {
  if (trigger.startsWith("$") || trigger.startsWith("/")) {
    return trigger.slice(1);
  }
  return trigger;
}
