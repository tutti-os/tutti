export type AgentCapabilityUse = "browserUse" | "computerUse";

interface AgentCapabilityUseConfig {
  aliases: readonly string[];
  commandName: string;
  submitPrefix: string;
}

const AGENT_CAPABILITY_USE_CONFIG: Record<
  AgentCapabilityUse,
  AgentCapabilityUseConfig
> = {
  browserUse: {
    aliases: ["browser", "浏览器"],
    commandName: "browser",
    submitPrefix:
      "Use the injected browser-use skill and only the tutti browser CLI. Do not use any other browser skill, CDP scripts, or direct browser automation."
  },
  computerUse: {
    aliases: ["computer", "电脑"],
    commandName: "computer",
    submitPrefix:
      "Use the injected computer-use skill and only the tutti computer CLI. Do not use any other computer-use skill, accessibility script, or direct desktop automation."
  }
};

export interface AgentCapabilityUseInvocation {
  args: string;
  commandName: string;
}

export function parseAgentCapabilityUseInvocation(
  draft: string,
  capability: AgentCapabilityUse
): AgentCapabilityUseInvocation | null {
  const match = /^(\s*)[$/]([^\s]+)(?:\s+([\s\S]*))?$/.exec(draft);
  if (!match) {
    return null;
  }
  const commandName = (match[2] ?? "").trim().toLowerCase();
  const config = AGENT_CAPABILITY_USE_CONFIG[capability];
  if (!config.aliases.includes(commandName)) {
    return null;
  }
  return {
    commandName,
    args: match[3] ?? ""
  };
}

export function buildAgentCapabilityUseSubmitPrompt(
  capability: AgentCapabilityUse,
  args: string
): string {
  const config = AGENT_CAPABILITY_USE_CONFIG[capability];
  const trimmedArgs = args.trim();
  return trimmedArgs
    ? `${config.submitPrefix}\n\n${trimmedArgs}`
    : config.submitPrefix;
}

export function agentCapabilityUseDisplayPrompt(
  capability: AgentCapabilityUse,
  args: string
): string {
  const commandName = AGENT_CAPABILITY_USE_CONFIG[capability].commandName;
  const trimmedArgs = args.trim();
  return trimmedArgs ? `/${commandName} ${trimmedArgs}` : `/${commandName}`;
}
