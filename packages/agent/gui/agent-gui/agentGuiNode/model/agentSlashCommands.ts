import type { AgentSessionCommand } from "../../../shared/agentSessionTypes";

export interface SlashCommandSearchItem {
  aliases?: readonly string[];
  description?: string;
  name: string;
}

interface SlashCommandQueryMatch {
  query: string;
  prefix: string;
}

export interface SlashCommandInvocation {
  args: string;
  commandName: string;
  leadingWhitespace: string;
  normalizedPrompt: string;
}

export function getSlashCommandQueryMatch(
  draft: string
): SlashCommandQueryMatch | null {
  const match = /^(\s*)\/([^\s]*)$/.exec(draft);
  if (!match) {
    return null;
  }
  return {
    query: match[2] ?? "",
    prefix: match[1] ?? ""
  };
}

export function getSlashCommandQuery(draft: string): string | null {
  return getSlashCommandQueryMatch(draft)?.query ?? null;
}

export function filterSlashCommands<T extends SlashCommandSearchItem>(
  commands: readonly T[],
  query: string
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...commands];
  }
  return commands.filter((command) => {
    const name = command.name.trim().toLowerCase();
    const description = command.description?.trim().toLowerCase() ?? "";
    const aliases = command.aliases ?? [];
    return (
      name.startsWith(normalizedQuery) ||
      aliases.some((alias) =>
        alias.trim().toLowerCase().startsWith(normalizedQuery)
      ) ||
      description.includes(normalizedQuery)
    );
  });
}

export function mergeSlashCommands(
  primaryCommands: readonly AgentSessionCommand[],
  fallbackCommands: readonly AgentSessionCommand[]
): AgentSessionCommand[] {
  const merged: AgentSessionCommand[] = [];
  const seen = new Set<string>();
  const append = (command: AgentSessionCommand): void => {
    const name = command.name.trim();
    if (!name) {
      return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push({ ...command, name });
  };
  for (const command of primaryCommands) {
    append(command);
  }
  for (const command of fallbackCommands) {
    append(command);
  }
  return merged;
}

export function parseSlashCommandInvocation(
  draft: string
): SlashCommandInvocation | null {
  const match = /^(\s*)\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(draft);
  if (!match) {
    return null;
  }
  const commandName = (match[2] ?? "").trim();
  if (!commandName) {
    return null;
  }
  const args = match[3] ?? "";
  const normalizedPrompt = args ? `/${commandName} ${args}` : `/${commandName}`;
  return {
    args,
    commandName,
    leadingWhitespace: match[1] ?? "",
    normalizedPrompt
  };
}

export function moveSlashCommandHighlight(
  currentIndex: number,
  itemCount: number,
  delta: number
): number {
  if (itemCount <= 0) {
    return 0;
  }
  return (currentIndex + delta + itemCount) % itemCount;
}

export function clampSlashCommandHighlight(
  currentIndex: number,
  itemCount: number
): number {
  if (itemCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(currentIndex, 0), itemCount - 1);
}

export function draftForSlashCommand(
  command: AgentSessionCommand,
  currentDraft = ""
): string {
  const commandDraft = `/${command.name.trim()} `;
  const match = getSlashCommandQueryMatch(currentDraft);
  return match ? `${match.prefix}${commandDraft}` : commandDraft;
}

export function promptForSlashCommand(command: AgentSessionCommand): string {
  return `/${command.name.trim()}`;
}

export function labelForSlashCommand(command: AgentSessionCommand): string {
  return command.name.trim();
}
