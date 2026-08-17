import { useEffect, useState } from "react";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import type { AgentGUIAgentTarget } from "../../../types";
import type { AgentGUISessionLaunchMode } from "../model/agentSessionLaunchMode";

export interface SessionWorktreeLaunchState {
  mode: AgentGUISessionLaunchMode;
  visible: boolean;
  onModeChange: (mode: AgentGUISessionLaunchMode) => void;
}

export function useSessionWorktreeLaunch(input: {
  agentSessionId?: string | null;
  enabled?: boolean;
  mode?: AgentGUISessionLaunchMode;
  onModeChange?: (mode: AgentGUISessionLaunchMode) => void | Promise<void>;
  projectSectionKey?: string | null;
  selectedAgentTarget?: AgentGUIAgentTarget | null;
  selectedProjectPath?: string | null;
}): SessionWorktreeLaunchState {
  const hostApi = useOptionalAgentHostApi();
  const [support, setSupport] = useState<{
    key: string;
    supported: boolean;
  } | null>(null);
  const agentTargetId =
    input.selectedAgentTarget?.agentTargetId?.trim() ||
    input.selectedAgentTarget?.targetId.trim() ||
    "";
  const cwd = input.selectedProjectPath?.trim() ?? "";
  const projectSectionKey = input.projectSectionKey?.trim() ?? "";
  const resolveSupport = hostApi?.workspace.resolveSessionWorktreeSupport;
  const eligible =
    input.enabled === true &&
    !input.agentSessionId?.trim() &&
    input.selectedAgentTarget?.ownership === "self" &&
    Boolean(agentTargetId && cwd && projectSectionKey) &&
    typeof resolveSupport === "function" &&
    typeof input.onModeChange === "function";
  const probeKey = eligible ? `${agentTargetId}\u0000${cwd}` : "";

  useEffect(() => {
    let active = true;
    if (!eligible) {
      return () => {
        active = false;
      };
    }
    void Promise.resolve(resolveSupport!({ agentTargetId, cwd }))
      .then((result) => {
        if (active) {
          setSupport({ key: probeKey, supported: result.supported === true });
        }
      })
      .catch(() => {
        if (active) {
          setSupport({ key: probeKey, supported: false });
        }
      });
    return () => {
      active = false;
    };
  }, [agentTargetId, cwd, eligible, probeKey, resolveSupport]);

  const visible =
    eligible && support?.key === probeKey && support.supported === true;
  const mode = visible && input.mode === "worktree" ? "worktree" : "local";
  return {
    mode,
    visible,
    onModeChange: (nextMode) => {
      if (!visible || nextMode === mode) {
        return;
      }
      void input.onModeChange?.(nextMode);
    }
  };
}
