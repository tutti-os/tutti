import type { AgentSessionCommand } from "../../../shared/agentSessionTypes";
import {
  buildTuttiBrowserUseSubmitPrompt,
  parseTuttiBrowserUseInvocation
} from "./agentBrowserUseSubmit";
import {
  draftForSlashCommand,
  mergeSlashCommands,
  parseSlashCommandInvocation,
  promptForSlashCommand
} from "./agentSlashCommands";

export type AgentSlashCommandProvider = "codex" | "claude-code" | string;

export interface AgentSlashCommandCapability {
  aliases?: readonly string[];
  capability: "browserUse";
  kind: "capability";
  name: string;
}

export type AgentSlashCommand =
  | AgentSessionCommand
  | AgentSlashCommandCapability;

export type SlashCommandSelectionEffect =
  | {
      kind: "fillDraft";
      draft: string;
    }
  | {
      kind: "submitPrompt";
      prompt: string;
      enableBrowserUse?: boolean;
    }
  | {
      kind: "showStatus";
    }
  | {
      kind: "togglePlanMode";
    }
  | {
      kind: "enableBrowserUse";
      draft: string;
    }
  | {
      kind: "showReviewPicker";
    }
  | {
      kind: "toggleSpeed";
    }
  | {
      kind: "blockCommand";
    };

interface ResolveSlashCommandSelectionEffectInput {
  provider: AgentSlashCommandProvider;
  command: AgentSlashCommand;
  currentDraft: string;
}

interface ResolveSlashCommandSubmitEffectInput {
  provider: AgentSlashCommandProvider;
  commands: readonly AgentSlashCommand[];
  draft: string;
}

interface ProviderSlashPolicy {
  /** Commands submitted immediately on selection instead of filling a draft. */
  immediateCommands: ReadonlySet<string>;
  /** Commands that open the shared review target picker when invoked bare. */
  reviewPickerCommands: ReadonlySet<string>;
  /** Commands surfaced when the agent advertises none of its own. */
  fallbackCommands: readonly AgentSessionCommand[];
}

const REVIEW_COMMAND = "review";
// `compact` is locally handled and submitted immediately for every provider.
const UNIVERSAL_IMMEDIATE_COMMANDS = new Set(["compact"]);
// Commands blocked or handled locally across the ACP providers below.
const ACP_BLOCKED_COMMANDS = new Set(["plan"]);
const ACP_LOCAL_STATUS_COMMANDS = new Set(["status"]);
// `/fast` toggles the orthogonal speed dimension locally rather than reaching
// the agent as a prompt; supported for codex and claude-code.
const ACP_LOCAL_TOGGLE_SPEED_COMMANDS = new Set(["fast"]);
const ACP_FALLBACK_COMMANDS: readonly AgentSessionCommand[] = [
  { name: "compact" },
  { name: "status" },
  { name: "fast" },
  { name: "goal" }
];
const CODEX_FALLBACK_COMMANDS: readonly AgentSessionCommand[] = [
  ...ACP_FALLBACK_COMMANDS,
  { name: REVIEW_COMMAND }
];
const CLAUDE_CODE_FALLBACK_COMMANDS: readonly AgentSessionCommand[] = [
  ...ACP_FALLBACK_COMMANDS,
  { name: REVIEW_COMMAND }
];
const BROWSER_USE_CAPABILITY_COMMAND: AgentSlashCommandCapability = {
  kind: "capability",
  capability: "browserUse",
  name: "browser",
  aliases: ["浏览器"]
};

const PROVIDER_SLASH_POLICY: Record<
  "codex" | "claude-code",
  ProviderSlashPolicy
> = {
  codex: {
    immediateCommands: new Set(["init", "compact"]),
    reviewPickerCommands: new Set([REVIEW_COMMAND]),
    fallbackCommands: CODEX_FALLBACK_COMMANDS
  },
  "claude-code": {
    immediateCommands: new Set(["compact", "context", "usage"]),
    reviewPickerCommands: new Set([REVIEW_COMMAND]),
    fallbackCommands: CLAUDE_CODE_FALLBACK_COMMANDS
  }
};

function providerSlashPolicy(
  provider: AgentSlashCommandProvider
): ProviderSlashPolicy | undefined {
  return provider === "codex" || provider === "claude-code"
    ? PROVIDER_SLASH_POLICY[provider]
    : undefined;
}

function isACPProvider(provider: AgentSlashCommandProvider): boolean {
  return provider === "codex" || provider === "claude-code";
}

export function resolveSlashCommandsForProvider({
  provider,
  commands,
  hasCompactableContext = true,
  compactSupported,
  browserSupported = false
}: {
  provider: AgentSlashCommandProvider;
  commands: readonly AgentSessionCommand[];
  hasCompactableContext?: boolean;
  /**
   * Negotiated `compact` capability. `false` drops the command entirely
   * (including provider fallbacks); `undefined`/`null` means unknown and
   * keeps the legacy `hasCompactableContext` behavior.
   */
  compactSupported?: boolean | null;
  browserSupported?: boolean;
}): AgentSlashCommand[] {
  const commandEntries = mergeSlashCommands(
    filterUnavailableSlashCommands(commands, {
      compactSupported,
      hasCompactableContext,
      provider
    }),
    filterUnavailableSlashCommands(fallbackCommandsForProvider(provider), {
      compactSupported,
      hasCompactableContext,
      provider
    })
  );
  if (!browserSupported) {
    return commandEntries;
  }
  return [...commandEntries, BROWSER_USE_CAPABILITY_COMMAND];
}

export function resolveSlashCommandSelectionEffect({
  provider,
  command,
  currentDraft
}: ResolveSlashCommandSelectionEffectInput): SlashCommandSelectionEffect {
  if (isBrowserUseCapability(command)) {
    return {
      kind: "enableBrowserUse",
      draft: draftForSlashCommand(command, currentDraft)
    };
  }
  const commandName = normalizedCommandName(command);
  if (isBlockedSlashCommand(provider, commandName)) {
    return { kind: "blockCommand" };
  }
  if (isLocalToggleSpeedCommand(provider, commandName)) {
    return { kind: "toggleSpeed" };
  }
  if (isLocalStatusCommand(provider, commandName)) {
    return { kind: "showStatus" };
  }
  // Picking codex `/review` from the palette never carries args (the palette
  // closes once a space is typed), so always open the target picker.
  if (isReviewPickerCommand(provider, commandName)) {
    return { kind: "showReviewPicker" };
  }
  if (isImmediateCommand(provider, commandName)) {
    return {
      kind: "submitPrompt",
      prompt: promptForSlashCommand(command)
    };
  }
  return {
    kind: "fillDraft",
    draft: draftForSlashCommand(command, currentDraft)
  };
}

export function resolveTuttiBrowserUseSubmitEffect(input: {
  browserSupported: boolean;
  commands: readonly AgentSlashCommand[];
  draft: string;
}): SlashCommandSelectionEffect | null {
  if (!input.browserSupported) {
    return null;
  }
  const invocation = parseTuttiBrowserUseInvocation(input.draft);
  if (!invocation) {
    return null;
  }
  const command = input.commands.find((candidate) =>
    slashCommandMatchesInvocation(candidate, invocation.commandName)
  );
  if (!command || !isBrowserUseCapability(command)) {
    return null;
  }
  return {
    kind: "submitPrompt",
    prompt: buildTuttiBrowserUseSubmitPrompt(invocation.args),
    enableBrowserUse: true
  };
}

export function resolveSlashCommandSubmitEffect({
  provider,
  commands,
  draft
}: ResolveSlashCommandSubmitEffectInput): SlashCommandSelectionEffect | null {
  const invocation = parseSlashCommandInvocation(draft);
  if (!invocation) {
    return null;
  }
  if (isBlockedSlashCommand(provider, invocation.commandName)) {
    return { kind: "blockCommand" };
  }
  const command = commands.find((candidate) =>
    slashCommandMatchesInvocation(candidate, invocation.commandName)
  );
  if (!command) {
    return null;
  }
  if (isBrowserUseCapability(command)) {
    return null;
  }
  const commandName = normalizedCommandName(command);
  if (isLocalToggleSpeedCommand(provider, commandName)) {
    return { kind: "toggleSpeed" };
  }
  if (isLocalStatusCommand(provider, commandName)) {
    return { kind: "showStatus" };
  }
  // Bare `/review` opens the target picker; `/review <text>` keeps the legacy
  // behavior of submitting the text straight through as a custom review.
  if (isReviewPickerCommand(provider, commandName)) {
    return invocation.args.trim() === "" ? { kind: "showReviewPicker" } : null;
  }
  if (isImmediateCommand(provider, commandName)) {
    return {
      kind: "submitPrompt",
      prompt: invocation.normalizedPrompt
    };
  }
  return null;
}

function isBlockedSlashCommand(
  provider: AgentSlashCommandProvider,
  commandName: string
): boolean {
  return (
    isACPProvider(provider) &&
    ACP_BLOCKED_COMMANDS.has(commandName.trim().toLowerCase())
  );
}

function isReviewPickerCommand(
  provider: AgentSlashCommandProvider,
  commandName: string
): boolean {
  return (
    providerSlashPolicy(provider)?.reviewPickerCommands.has(commandName) ??
    false
  );
}

function fallbackCommandsForProvider(
  provider: AgentSlashCommandProvider
): readonly AgentSessionCommand[] {
  return providerSlashPolicy(provider)?.fallbackCommands ?? [];
}

function isLocalStatusCommand(
  provider: AgentSlashCommandProvider,
  commandName: string
): boolean {
  return isACPProvider(provider) && ACP_LOCAL_STATUS_COMMANDS.has(commandName);
}

function isLocalToggleSpeedCommand(
  provider: AgentSlashCommandProvider,
  commandName: string
): boolean {
  return (
    isACPProvider(provider) && ACP_LOCAL_TOGGLE_SPEED_COMMANDS.has(commandName)
  );
}

function isImmediateCommand(
  provider: AgentSlashCommandProvider,
  commandName: string
): boolean {
  if (UNIVERSAL_IMMEDIATE_COMMANDS.has(commandName)) {
    return true;
  }
  return (
    providerSlashPolicy(provider)?.immediateCommands.has(commandName) ?? false
  );
}

function normalizedCommandName(command: { name: string }): string {
  return command.name.trim().toLowerCase();
}

function isBrowserUseCapability(
  command: AgentSlashCommand
): command is AgentSlashCommandCapability {
  return (
    "kind" in command &&
    command.kind === "capability" &&
    command.capability === "browserUse"
  );
}

function slashCommandMatchesInvocation(
  command: AgentSlashCommand,
  commandName: string
): boolean {
  const normalizedInvocation = commandName.trim().toLowerCase();
  if (normalizedCommandName(command) === normalizedInvocation) {
    return true;
  }
  const aliases = "aliases" in command ? (command.aliases ?? []) : [];
  return aliases.some(
    (alias) => alias.trim().toLowerCase() === normalizedInvocation
  );
}

function filterUnavailableSlashCommands(
  commands: readonly AgentSessionCommand[],
  input: {
    compactSupported?: boolean | null;
    hasCompactableContext: boolean;
    provider: AgentSlashCommandProvider;
  }
): AgentSessionCommand[] {
  return commands.filter((command) => {
    const commandName = normalizedCommandName(command);
    if (
      isACPProvider(input.provider) &&
      ACP_BLOCKED_COMMANDS.has(commandName)
    ) {
      return false;
    }
    if (commandName === "compact") {
      if (input.compactSupported === false) {
        return false;
      }
      return input.hasCompactableContext;
    }
    return true;
  });
}
