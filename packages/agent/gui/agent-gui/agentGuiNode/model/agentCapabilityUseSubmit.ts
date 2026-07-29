export type AgentCapabilityUse = "browserUse" | "computerUse";

interface AgentCapabilityUseConfig {
  aliases: readonly string[];
  commandName: string;
  submitPrefix: string;
  nativePluginPath: string;
  nativePluginName: string;
  nativeTrigger: string;
}

const AGENT_CAPABILITY_USE_CONFIG: Record<
  AgentCapabilityUse,
  AgentCapabilityUseConfig
> = {
  browserUse: {
    aliases: ["browser", "浏览器"],
    commandName: "browser",
    submitPrefix:
      "Use the injected browser-use skill and only the tutti browser CLI. Do not use any other browser skill, CDP scripts, or direct browser automation.",
    nativePluginPath: "plugin://browser@openai-bundled",
    nativePluginName: "Browser",
    nativeTrigger: "$browser"
  },
  computerUse: {
    aliases: ["computer", "电脑"],
    commandName: "computer",
    submitPrefix:
      "Use the injected computer-use skill and only the tutti computer CLI. Do not use any other computer-use skill, accessibility script, or direct desktop automation.",
    nativePluginPath: "plugin://computer-use@openai-bundled",
    nativePluginName: "Computer Use",
    nativeTrigger: "$computer-use"
  }
};

export interface AgentCapabilityUseInvocation {
  args: string;
  commandName: string;
}

export interface AgentCapabilityUseNativePlugin {
  name: string;
  path: string;
  trigger: string;
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

export function resolveAgentCapabilityUseNativePlugin(
  capability: AgentCapabilityUse,
  skills: readonly {
    kind?: string;
    path?: string;
    name?: string;
    trigger?: string;
  }[]
): AgentCapabilityUseNativePlugin | null {
  const config = AGENT_CAPABILITY_USE_CONFIG[capability];
  const match = skills.find(
    (skill) =>
      skill.kind === "plugin" &&
      skill.path?.trim() === config.nativePluginPath &&
      skill.trigger?.trim()
  );
  if (!match?.path || !match.trigger) {
    return null;
  }
  return {
    name: match.name?.trim() || config.nativePluginName,
    path: match.path.trim(),
    trigger: match.trigger.trim()
  };
}

export function buildAgentCapabilityUseSubmitPrompt(
  capability: AgentCapabilityUse,
  args: string,
  nativePlugin?: AgentCapabilityUseNativePlugin | null
): string {
  const config = AGENT_CAPABILITY_USE_CONFIG[capability];
  const trimmedArgs = args.trim();
  if (nativePlugin) {
    const prefix = `${nativePlugin.trigger} Use the Codex native ${nativePlugin.name} plugin (${nativePlugin.path}).`;
    return trimmedArgs ? `${prefix}\n\n${trimmedArgs}` : prefix;
  }
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
