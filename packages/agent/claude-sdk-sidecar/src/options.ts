import { readFileSync, statSync } from "node:fs";
import type {
  Options as ClaudeQueryOptions,
  SdkPluginConfig
} from "@anthropic-ai/claude-agent-sdk";

const claudeSystemPromptFileEnv = "TUTTI_CLAUDE_SYSTEM_PROMPT_FILE";
const claudePluginDirEnv = "TUTTI_CLAUDE_PLUGIN_DIR";

export type ClaudeToolsOption = NonNullable<ClaudeQueryOptions["tools"]>;

export type SidecarClaudeOptions = {
  systemPromptAppend: string;
  planModeInstructions: string;
  allowedTools: string[];
  disallowedTools: string[];
  plugins: SdkPluginConfig[];
  extraArgs: Record<string, string | null>;
  tools: ClaudeToolsOption;
};

export function sidecarClaudeOptionsFromPayload(
  payload: Record<string, unknown>
): SidecarClaudeOptions {
  const env = stringRecordValue(payload.env);
  const explicitSystemPrompt = stringValue(payload.systemPromptAppend);
  const explicitPlugins = pluginListValue(payload.plugins);
  const extraArgs = stringRecordValue(payload.extraArgs);
  const pluginDir = explicitPlugins.length > 0 ? "" : env[claudePluginDirEnv];

  if (pluginDir) {
    let info;
    try {
      info = statSync(pluginDir);
    } catch (error) {
      throw new Error(`stat claude plugin dir: ${errorMessage(error)}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`claude plugin dir is not a directory: ${pluginDir}`);
    }
    if (!("plugin-dir" in extraArgs)) {
      extraArgs["plugin-dir"] = pluginDir;
    }
  }

  return {
    systemPromptAppend:
      explicitSystemPrompt ||
      claudeSystemPromptAppend(env[claudeSystemPromptFileEnv]),
    planModeInstructions: stringValue(payload.planModeInstructions),
    allowedTools: stringArrayValue(payload.allowedTools),
    disallowedTools: stringArrayValue(payload.disallowedTools),
    plugins:
      explicitPlugins.length > 0
        ? explicitPlugins
        : pluginDir
          ? [{ type: "local", path: pluginDir }]
          : [],
    extraArgs,
    tools: toolsValue(payload.tools) ?? {
      type: "preset",
      preset: "claude_code"
    }
  };
}

function claudeSystemPromptAppend(path: string | null | undefined): string {
  if (!path) {
    return "";
  }
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new Error(`read claude system prompt: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function claudeQueryOptionOverrides(
  options: SidecarClaudeOptions
): Pick<
  ClaudeQueryOptions,
  | "systemPrompt"
  | "tools"
  | "allowedTools"
  | "planModeInstructions"
  | "disallowedTools"
  | "plugins"
  | "extraArgs"
> {
  return {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(options.systemPromptAppend
        ? { append: options.systemPromptAppend }
        : {})
    },
    tools: options.tools,
    ...(options.allowedTools.length > 0
      ? { allowedTools: options.allowedTools }
      : {}),
    ...(options.planModeInstructions
      ? { planModeInstructions: options.planModeInstructions }
      : {}),
    ...(options.disallowedTools.length > 0
      ? { disallowedTools: options.disallowedTools }
      : {}),
    ...(options.plugins.length > 0 ? { plugins: options.plugins } : {}),
    ...(Object.keys(options.extraArgs).length > 0
      ? { extraArgs: options.extraArgs }
      : {})
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(stringValue).filter((item) => item !== "");
}

function stringRecordValue(value: unknown): Record<string, string | null> {
  const record = recordValue(value);
  if (!record) {
    return {};
  }
  const out: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(record)) {
    const name = stringValue(key);
    if (!name) {
      continue;
    }
    if (item === null) {
      out[name] = null;
      continue;
    }
    const text = stringValue(item);
    if (text) {
      out[name] = text;
    }
  }
  return out;
}

function pluginListValue(value: unknown): SdkPluginConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const plugins: SdkPluginConfig[] = [];
  for (const item of value) {
    const record = recordValue(item);
    if (!record || record.type !== "local") {
      continue;
    }
    const path = stringValue(record.path);
    if (!path) {
      continue;
    }
    plugins.push({
      type: "local",
      path,
      ...(record.skipMcpDiscovery === true ? { skipMcpDiscovery: true } : {})
    });
  }
  return plugins;
}

function toolsValue(value: unknown): ClaudeToolsOption | undefined {
  if (Array.isArray(value)) {
    return stringArrayValue(value);
  }
  const record = recordValue(value);
  if (record && record.type === "preset" && record.preset === "claude_code") {
    return { type: "preset", preset: "claude_code" };
  }
  return undefined;
}
