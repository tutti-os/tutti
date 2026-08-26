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
  const config = AGENT_CAPABILITY_USE_CONFIG[capability];
  const commandToken = (match[2] ?? "").trim();
  const parsedToken = parseCapabilityCommandToken(commandToken, config.aliases);
  if (!parsedToken) {
    return null;
  }
  const trailingArgs = match[3] ?? "";
  const args = [parsedToken.adjacentArgs, trailingArgs]
    .filter((part) => part !== "")
    .join(" ");
  return {
    commandName: parsedToken.commandName,
    args
  };
}

function parseCapabilityCommandToken(
  token: string,
  aliases: readonly string[]
): { adjacentArgs: string; commandName: string } | null {
  const normalizedToken = token.toLowerCase();
  for (const alias of aliases) {
    const normalizedAlias = alias.toLowerCase();
    if (normalizedToken === normalizedAlias) {
      return { adjacentArgs: "", commandName: normalizedAlias };
    }
    if (!normalizedToken.startsWith(normalizedAlias)) {
      continue;
    }
    const adjacentArgs = token.slice(alias.length);
    if (isAdjacentCapabilityArgument(adjacentArgs)) {
      return { adjacentArgs, commandName: normalizedAlias };
    }
  }
  return null;
}

function isAdjacentCapabilityArgument(value: string): boolean {
  const firstCharacter = Array.from(value)[0];
  return Boolean(firstCharacter && !/[a-z0-9_-]/i.test(firstCharacter));
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
