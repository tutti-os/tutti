import type { AgentSessionCommand } from "../../../shared/agentSessionTypes";
import type {
  AgentActivityComposerOptions,
  AgentActivitySlashCommandPolicy
} from "@tutti-os/agent-activity-core";
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

export type AgentSlashCommandProvider = string;

export interface AgentSlashCommandCapability {
  aliases?: readonly string[];
  capability: "browserUse" | "computerUse";
  kind: "capability";
  name: string;
}

export type AgentSlashCommand =
  | AgentSessionCommand
  | AgentSlashCommandCapability;

export type AgentSlashCommandPolicy = AgentActivitySlashCommandPolicy;

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
  policy?: AgentSlashCommandPolicy | null;
  command: AgentSlashCommand;
  currentDraft: string;
}

interface ResolveSlashCommandSubmitEffectInput {
  provider: AgentSlashCommandProvider;
  policy?: AgentSlashCommandPolicy | null;
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
  localGoalCommands: ReadonlySet<string>;
  localPlanCommands: ReadonlySet<string>;
  localStatusCommands: ReadonlySet<string>;
  localSpeedCommands: ReadonlySet<string>;
}

// `/plan` toggles plan mode locally (a negotiated capability) rather than
// reaching the agent as a prompt; surfaced only when plan mode is supported.
// `/fast` toggles the descriptor-advertised speed dimension locally.
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

function providerSlashPolicy(
  policy?: AgentSlashCommandPolicy | null
): ProviderSlashPolicy | undefined {
  if (policy) {
    const commandsForEffect = (
      effect: AgentSlashCommandPolicy["commandEffects"][number]["effect"]
    ) =>
      normalizedCommandSet(
        policy.commandEffects.flatMap((entry) =>
          entry.effect === effect ? [entry.command] : []
        )
      );
    return {
      fallbackCommands: policy.fallbackCommands.map((name) => ({ name })),
      immediateCommands: commandsForEffect("submitImmediate"),
      reviewPickerCommands: commandsForEffect("showReviewPicker"),
      localGoalCommands: commandsForEffect("activateGoalMode"),
      localPlanCommands: commandsForEffect("togglePlanMode"),
      localStatusCommands: commandsForEffect("showStatus"),
      localSpeedCommands: commandsForEffect("toggleSpeed")
    };
  }
  return undefined;
}

export function resolveSlashCommandsForProvider({
  provider: _provider,
  policy,
  commands,
  hasCompactableContext = true,
  compactSupported,
  planSupported = false,
  browserSupported = false,
  computerSupported = false
}: {
  provider: AgentSlashCommandProvider;
  policy?: AgentSlashCommandPolicy | null;
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
  const descriptorCommands = policy ? commands : [];
  const mergedEntries = mergeSlashCommands(
    filterUnavailableSlashCommands(descriptorCommands, {
      compactSupported,
      hasCompactableContext
    }),
    filterUnavailableSlashCommands(fallbackCommandsForPolicy(policy), {
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
      isSlashPaletteCommandVisible(commandName, policy)
    );
  });
  const planEntries =
    planSupported &&
    (providerSlashPolicy(policy)?.localPlanCommands.has("plan") ?? false)
      ? [PLAN_MODE_COMMAND]
      : [];
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
  provider: _provider,
  policy,
  command,
  currentDraft
}: ResolveSlashCommandSelectionEffectInput): SlashCommandSelectionEffect | null {
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
  if (!policy) {
    return null;
  }
  const commandName = normalizedCommandName(command);
  if (isLocalTogglePlanCommand(commandName, policy)) {
    return { kind: "togglePlanMode" };
  }
  if (isLocalGoalCommand(commandName, policy)) {
    return { kind: "activateGoalMode" };
  }
  if (isLocalToggleSpeedCommand(commandName, policy)) {
    return { kind: "toggleSpeed" };
  }
  if (isLocalStatusCommand(commandName, policy)) {
    return { kind: "showStatus" };
  }
  // A descriptor may route a bare palette command to a local picker.
  if (isReviewPickerCommand(commandName, policy)) {
    return { kind: "showReviewPicker" };
  }
  if (isImmediateCommand(commandName, policy)) {
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
  provider: _provider,
  policy,
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
  if (isLocalTogglePlanCommand(commandName, policy)) {
    return { kind: "togglePlanMode" };
  }
  if (isLocalGoalCommand(commandName, policy)) {
    return invocation.args.trim() === "" ? { kind: "activateGoalMode" } : null;
  }
  if (isLocalToggleSpeedCommand(commandName, policy)) {
    return { kind: "toggleSpeed" };
  }
  if (isLocalStatusCommand(commandName, policy)) {
    return { kind: "showStatus" };
  }
  // Bare `/review` opens the target picker; `/review <text>` keeps the legacy
  // behavior of submitting the text straight through as a custom review.
  if (isReviewPickerCommand(commandName, policy)) {
    return invocation.args.trim() === "" ? { kind: "showReviewPicker" } : null;
  }
  if (isImmediateCommand(commandName, policy)) {
    return {
      kind: "submitPrompt",
      prompt: invocation.normalizedPrompt
    };
  }
  return null;
}

function isLocalTogglePlanCommand(
  commandName: string,
  policy?: AgentSlashCommandPolicy | null
): boolean {
  return (
    providerSlashPolicy(policy)?.localPlanCommands.has(
      commandName.trim().toLowerCase()
    ) ?? false
  );
}

function isLocalGoalCommand(
  commandName: string,
  policy?: AgentSlashCommandPolicy | null
): boolean {
  return (
    providerSlashPolicy(policy)?.localGoalCommands.has(
      commandName.trim().toLowerCase()
    ) ?? false
  );
}

function isReviewPickerCommand(
  commandName: string,
  policy?: AgentSlashCommandPolicy | null
): boolean {
  return (
    providerSlashPolicy(policy)?.reviewPickerCommands.has(commandName) ?? false
  );
}

function fallbackCommandsForPolicy(
  policy?: AgentSlashCommandPolicy | null
): readonly AgentSessionCommand[] {
  return providerSlashPolicy(policy)?.fallbackCommands ?? [];
}

function isSlashPaletteCommandVisible(
  commandName: string,
  policy?: AgentSlashCommandPolicy | null
): boolean {
  if (policy?.commandCatalogAuthoritative === true) {
    return (
      policy.fallbackCommands.some(
        (command) => command.trim().toLowerCase() === commandName
      ) ||
      policy.commandEffects.some(
        (descriptor) => descriptor.command.trim().toLowerCase() === commandName
      )
    );
  }
  return true;
}

function isLocalStatusCommand(
  commandName: string,
  policy?: AgentSlashCommandPolicy | null
): boolean {
  return (
    providerSlashPolicy(policy)?.localStatusCommands.has(commandName) ?? false
  );
}

function isLocalToggleSpeedCommand(
  commandName: string,
  policy?: AgentSlashCommandPolicy | null
): boolean {
  return (
    providerSlashPolicy(policy)?.localSpeedCommands.has(commandName) ?? false
  );
}

function isImmediateCommand(
  commandName: string,
  policy?: AgentSlashCommandPolicy | null
): boolean {
  return (
    providerSlashPolicy(policy)?.immediateCommands.has(commandName) ?? false
  );
}

function normalizedCommandSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(
    values.map((value) => value.trim().toLowerCase()).filter(Boolean)
  );
}

export function slashCommandPolicyFromComposerOptions(
  options: AgentActivityComposerOptions | null
): AgentSlashCommandPolicy | null {
  return options?.slashCommandPolicy ?? null;
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
