import { useEffect, useState } from "react";
import type { AgentGUIProps, AgentHostInputApi } from "@tutti-os/agent-gui";
import type { DesktopRuntimeApi } from "@preload/types";

import { mergeDesktopAgentProbeSnapshots } from "./desktopAgentProbeSnapshot.ts";

type DesktopAgentProbeState = NonNullable<
  AgentGUIProps["runtimeRequests"]["agentProbes"]
>;

interface UseDesktopAgentProbesInput {
  previewMode: boolean;
  providers: string[];
  refreshSequence: number;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  workspaceAgentProbes: AgentHostInputApi["workspaceAgentProbes"];
  workspaceId: string;
}

export function useDesktopAgentProbes({
  previewMode,
  providers,
  refreshSequence,
  runtimeApi,
  workspaceAgentProbes,
  workspaceId
}: UseDesktopAgentProbesInput): DesktopAgentProbeState | null {
  const [state, setState] = useState<DesktopAgentProbeState | null>(null);
  const providersKey = providers.join("\u0000");

  useEffect(() => {
    if (previewMode) return;
    if (providers.length === 0) {
      setState(null);
      return;
    }
    if (!workspaceAgentProbes) return;

    // AgentGUI mount is local-only. Usage begins after an explicit tooltip/menu
    // open or refresh advances refreshSequence.
    const includeUsage = desktopAgentProbeIncludesUsage(refreshSequence);
    let canceled = false;
    setState((current) => ({
      isLoadingAvailability: current === null || current.snapshot === null,
      isLoadingUsage: includeUsage,
      snapshot: current?.snapshot ?? null,
      usageLoadFailed: current?.usageLoadFailed ?? false
    }));
    void workspaceAgentProbes
      .list({
        includeUsage,
        providers,
        refresh: true,
        workspaceId
      })
      .then((snapshot) => {
        if (canceled) return;
        setState((current) => ({
          isLoadingAvailability: false,
          isLoadingUsage: false,
          snapshot: mergeDesktopAgentProbeSnapshots(
            current?.snapshot ?? null,
            snapshot
          ),
          usageLoadFailed: includeUsage
            ? false
            : (current?.usageLoadFailed ?? false)
        }));
      })
      .catch((error: unknown) => {
        if (canceled) return;
        setState((current) => ({
          isLoadingAvailability: false,
          isLoadingUsage: false,
          snapshot: current?.snapshot ?? null,
          usageLoadFailed: includeUsage
            ? true
            : (current?.usageLoadFailed ?? false)
        }));
        void runtimeApi?.logTerminalDiagnostic({
          details: {
            error: error instanceof Error ? error.message : String(error),
            providers: providers.join(",")
          },
          event: "agent.gui.probe.usage_failed",
          level: "warn",
          workspaceId
        });
      });
    return () => {
      canceled = true;
    };
  }, [
    previewMode,
    providers,
    providersKey,
    refreshSequence,
    runtimeApi,
    workspaceAgentProbes,
    workspaceId
  ]);

  return state;
}

export function desktopAgentProbeIncludesUsage(
  refreshSequence: number
): boolean {
  return refreshSequence > 0;
}
