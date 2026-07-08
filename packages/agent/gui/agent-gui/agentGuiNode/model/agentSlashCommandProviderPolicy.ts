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
  capability: "browserUse" | "computerUse";
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
      kind: "activateGoalMode";
    }
  | {
      kind: "submitPrompt";
      prompt: string;
      displayPrompt?: string;
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
      kind: "enableComputerUse";
      draft: string;
    }
  | {
      kind: "showReviewPicker";
    }
  | {
      kind: "toggleSpeed";
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
// `/plan` toggles plan mode locally (a negotiated capability) rather than
// reaching the agent as a prompt; surfaced only when plan mode is supported.
const ACP_LOCAL_TOGGLE_PLAN_COMMANDS = new Set(["plan"]);
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
// Cursor exposes only Tutti's local `/plan` toggle; every other slash entry is
// hidden from the composer palette.
const CURSOR_FALLBACK_COMMANDS: readonly AgentSessionCommand[] = [];
const CLAUDE_CODE_SLASH_PALETTE_COMMANDS = new Set([
  "compact",
  "context",
  "fast",
  "goal",
  "review",
  "status",
  "usage"
]);
const BROWSER_USE_CAPABILITY_COMMAND: AgentSlashCommandCapability = {
  kind: "capability",
  capability: "browserUse",
  name: "browser",
  aliases: ["浏览器"]
};
const COMPUTER_USE_CAPABILITY_COMMAND: AgentSlashCommandCapability = {
  kind: "capability",
  capability: "computerUse",
  name: "computer",
  aliases: ["电脑"]
};
const PLAN_MODE_COMMAND: AgentSessionCommand = { name: "plan" };

const PROVIDER_SLASH_POLICY: Record<
  "codex" | "claude-code" | "cursor",
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
  },
  cursor: {
    immediateCommands: new Set(),
    reviewPickerCommands: new Set(),
    fallbackCommands: CURSOR_FALLBACK_COMMANDS
  }
};

function providerSlashPolicy(
  provider: AgentSlashCommandProvider
): ProviderSlashPolicy | undefined {
  return provider === "codex" ||
    provider === "claude-code" ||
    provider === "cursor"
    ? PROVIDER_SLASH_POLICY[provider]
    : undefined;
}

function isACPProvider(provider: AgentSlashCommandProvider): boolean {
  return (
    provider === "codex" || provider === "claude-code" || provider === "cursor"
  );
}

export function resolveSlashCommandsForProvider({
  provider,
  commands,
  hasCompactableContext = true,
  compactSupported,
  planSupported = false,
  browserSupported = false,
  computerSupported = false
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
  planSupported?: boolean;
  browserSupported?: boolean;
  computerSupported?: boolean;
}): AgentSlashCommand[] {
  const mergedEntries = mergeSlashCommands(
    filterUnavailableSlashCommands(commands, {
      compactSupported,
      hasCompactableContext
    }),
    filterUnavailableSlashCommands(fallbackCommandsForProvider(provider), {
      compactSupported,
      hasCompactableContext
    })
  );
  // `/plan` is a local plan-mode toggle, not an agent prompt: drop any
  // agent-advertised `plan` and re-surface our own entry only when supported.
  const commandEntries = mergedEntries.filter((entry) => {
    const commandName = normalizedCommandName(entry);
    return (
      commandName !== "plan" &&
      isSlashPaletteCommandVisible(provider, commandName)
    );
  });
  const planEntries =
    planSupported && isACPProvider(provider) ? [PLAN_MODE_COMMAND] : [];
  const capabilityEntries: AgentSlashCommandCapability[] = [];
  if (browserSupported) {
    capabilityEntries.push(BROWSER_USE_CAPABILITY_COMMAND);
  }
  if (computerSupported) {
    capabilityEntries.push(COMPUTER_USE_CAPABILITY_COMMAND);
  }
  return [...commandEntries, ...planEntries, ...capabilityEntries];
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
  if (isComputerUseCapability(command)) {
    return {
      kind: "enableComputerUse",
      draft: draftForSlashCommand(command, currentDraft)
    };
  }
  const commandName = normalizedCommandName(command);
  if (isLocalTogglePlanCommand(provider, commandName)) {
    return { kind: "togglePlanMode" };
  }
  if (isGoalModeCommand(commandName)) {
    return { kind: "activateGoalMode" };
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
    displayPrompt: browserUseDisplayPrompt(invocation),
    enableBrowserUse: true
  };
}

function browserUseDisplayPrompt({ args }: { args: string }): string {
  const trimmedArgs = args.trim();
  return trimmedArgs ? `/browser ${trimmedArgs}` : "/browser";
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
  if (isLocalTogglePlanCommand(provider, commandName)) {
    return { kind: "togglePlanMode" };
  }
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

function isLocalTogglePlanCommand(
  provider: AgentSlashCommandProvider,
  commandName: string
): boolean {
  return (
    isACPProvider(provider) &&
    ACP_LOCAL_TOGGLE_PLAN_COMMANDS.has(commandName.trim().toLowerCase())
  );
}

function isGoalModeCommand(commandName: string): boolean {
  return commandName.trim().toLowerCase() === "goal";
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

function isSlashPaletteCommandVisible(
  provider: AgentSlashCommandProvider,
  commandName: string
): boolean {
  if (provider === "claude-code") {
    return CLAUDE_CODE_SLASH_PALETTE_COMMANDS.has(commandName);
  }
  if (provider === "cursor") {
    return false;
  }
  return true;
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

function isComputerUseCapability(
  command: AgentSlashCommand
): command is AgentSlashCommandCapability {
  return (
    "kind" in command &&
    command.kind === "capability" &&
    command.capability === "computerUse"
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
  }
): AgentSessionCommand[] {
  return commands.filter((command) => {
    const commandName = normalizedCommandName(command);
    if (commandName === "compact") {
      if (input.compactSupported === false) {
        return false;
      }
      return input.hasCompactableContext;
    }
    return true;
  });
}
