import { useSyncExternalStore } from "react";
import type { AgentEnvPanelFocus } from "@tutti-os/agent-gui/agent-env";

export const REVEAL_STEP_MS = 450;
export const REVEAL_ALL = Number.MAX_SAFE_INTEGER;

export type WizardReportState =
  | "idle"
  | "confirming"
  | "reported"
  | "dismissed";

export interface AgentEnvWizardSnapshot {
  revealIndex: number;
  reportState: WizardReportState;
  copied: boolean;
  logExpanded: boolean;
  autoStartedSeq: number | null;
}

const INITIAL: AgentEnvWizardSnapshot = {
  revealIndex: REVEAL_ALL,
  reportState: "idle",
  copied: false,
  logExpanded: false,
  autoStartedSeq: null
};

let snapshot: AgentEnvWizardSnapshot = INITIAL;
const listeners = new Set<() => void>();

function set(next: Partial<AgentEnvWizardSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) {
    listener();
  }
}

export function resetWizardForOpen(focus: AgentEnvPanelFocus | null): void {
  set({
    revealIndex: focus === "detect" ? 0 : REVEAL_ALL,
    reportState: "idle",
    copied: false,
    logExpanded: false,
    autoStartedSeq: null
  });
}

export function restartWizardReveal(): void {
  set({
    revealIndex: 0,
    reportState: "idle",
    copied: false,
    logExpanded: false
  });
}

export function advanceWizardReveal(): void {
  set({ revealIndex: snapshot.revealIndex + 1 });
}

export function setWizardReportState(reportState: WizardReportState): void {
  set({ reportState });
}

export function setWizardCopied(copied: boolean): void {
  set({ copied });
}

export function toggleWizardLog(): void {
  set({ logExpanded: !snapshot.logExpanded });
}

export function markWizardAutoStarted(seq: number): void {
  set({ autoStartedSeq: seq });
}

export function getAgentEnvWizardSnapshot(): AgentEnvWizardSnapshot {
  return snapshot;
}

export function subscribeAgentEnvWizardStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentEnvWizardState(): AgentEnvWizardSnapshot {
  return useSyncExternalStore(
    subscribeAgentEnvWizardStore,
    getAgentEnvWizardSnapshot
  );
}

export function resetAgentEnvWizardStoreForTests(): void {
  snapshot = INITIAL;
  listeners.clear();
}
