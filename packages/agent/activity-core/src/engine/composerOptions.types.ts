import type {
  AgentActivityComposerOptions,
  AgentActivityComposerOptionsLoadStatus,
  AgentActivityComposerSettings
} from "../types.ts";

export type ComposerOptionsSection = "core" | "capabilities" | "connectors";

/**
 * Per-target load bookkeeping. Replaces the former imperative cache
 * coordinator: `loadingSignature` deduplicates in-flight loads, `settledSignature`
 * decides whether a cached result still satisfies a request, and
 * `inFlightCommandId` guards against a superseded load settling late.
 */
export interface ComposerOptionsEntry {
  status: AgentActivityComposerOptionsLoadStatus;
  provider: string;
  loadingSignature: string | null;
  settledSignature: string | null;
  loadVersion: number;
  inFlightCommandId: string | null;
}

export interface ComposerOptionsState {
  optionsByTargetKey: Readonly<Record<string, AgentActivityComposerOptions>>;
  entriesByTargetKey: Readonly<Record<string, ComposerOptionsEntry>>;
  sectionOptionsByTargetKey: Readonly<
    Record<
      string,
      Readonly<
        Partial<Record<ComposerOptionsSection, AgentActivityComposerOptions>>
      >
    >
  >;
  sectionEntriesByTargetKey: Readonly<
    Record<
      string,
      Readonly<Partial<Record<ComposerOptionsSection, ComposerOptionsEntry>>>
    >
  >;
}

export interface ComposerOptionsLoadRequestedIntent {
  type: "composerOptions/loadRequested";
  commandId: string;
  agentSessionId?: string | null;
  targetKey: string;
  provider: string;
  workspaceId: string;
  cwd?: string | null;
  settings?: AgentActivityComposerSettings | null;
  force?: boolean;
  waitForFreshModelCatalog?: boolean;
  section?: ComposerOptionsSection;
}

export interface ComposerOptionsInvalidatedIntent {
  type: "composerOptions/invalidated";
  providers?: readonly string[];
  sections?: readonly ComposerOptionsSection[];
  targetKeys?: readonly string[];
}

export type ComposerOptionsIntent =
  | ComposerOptionsLoadRequestedIntent
  | ComposerOptionsInvalidatedIntent;

export interface ComposerOptionsLoadCommand {
  type: "composerOptions/load";
  commandId: string;
  agentSessionId?: string | null;
  correlationId: string;
  targetKey: string;
  provider: string;
  workspaceId: string;
  cwd?: string | null;
  settings?: AgentActivityComposerSettings | null;
  section?: ComposerOptionsSection;
  waitForFreshModelCatalog?: boolean;
}

export type ComposerOptionsCommand = ComposerOptionsLoadCommand;
