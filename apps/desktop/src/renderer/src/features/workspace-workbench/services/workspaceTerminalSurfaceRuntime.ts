import type { TerminalNodeFeature } from "@tutti-os/workspace-terminal";
import type {
  TerminalNodeExternalState,
  TerminalSessionDescriptor
} from "@tutti-os/workspace-terminal/contracts";
import type { WorkbenchContribution } from "@tutti-os/workbench-surface";

export interface WorkspaceTerminalSurfaceRuntime {
  createSession(input?: {
    cwd?: string | null;
    initialInput?: string | null;
  }): Promise<TerminalSessionDescriptor>;
  feature: TerminalNodeFeature;
  getExternalState(sessionId: string | null): TerminalNodeExternalState | null;
  subscribe(listener: () => void): () => void;
}

const workspaceTerminalSurfaceRuntimeByContribution = new WeakMap<
  WorkbenchContribution,
  WorkspaceTerminalSurfaceRuntime
>();

export function getWorkspaceTerminalSurfaceRuntime(
  contribution: WorkbenchContribution
): WorkspaceTerminalSurfaceRuntime | null {
  return (
    workspaceTerminalSurfaceRuntimeByContribution.get(contribution) ?? null
  );
}

export function registerWorkspaceTerminalSurfaceRuntime(
  contribution: WorkbenchContribution,
  runtime: WorkspaceTerminalSurfaceRuntime
): void {
  workspaceTerminalSurfaceRuntimeByContribution.set(contribution, runtime);
}
