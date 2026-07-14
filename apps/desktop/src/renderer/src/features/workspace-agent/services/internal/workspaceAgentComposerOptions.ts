import type {
  AgentActivityComposerSettings,
  AgentSessionEngine
} from "@tutti-os/agent-activity-core";

export function loadWorkspaceAgentComposerOptions(input: {
  agentTargetId: string;
  commandId: string;
  cwd?: string | null;
  engine: AgentSessionEngine;
  force?: boolean;
  provider: string;
  settings: AgentActivityComposerSettings;
  signal?: AbortSignal;
  workspaceId: string;
}): Promise<unknown> {
  input.engine.dispatch({
    commandId: input.commandId,
    type: "composerOptions/loadRequested",
    targetKey: input.agentTargetId,
    provider: input.provider,
    cwd: input.cwd,
    force: input.force,
    settings: input.settings,
    workspaceId: input.workspaceId
  });
  const readResult = () => {
    const state = input.engine.getSnapshot().composerOptions;
    return {
      options: state.optionsByTargetKey[input.agentTargetId],
      status: state.entriesByTargetKey[input.agentTargetId]?.status
    };
  };
  const current = readResult();
  if (current.status === "ready") return Promise.resolve(current.options);
  if (current.status === "error") {
    return Promise.reject(new Error("composer_options_load_failed"));
  }
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const onAbort = () => {
      unsubscribe();
      reject(
        input.signal?.reason ?? new Error("composer_options_load_aborted")
      );
    };
    const settle = () => {
      const result = readResult();
      if (result.status === "ready") {
        unsubscribe();
        input.signal?.removeEventListener("abort", onAbort);
        resolve(result.options);
      } else if (result.status === "error") {
        unsubscribe();
        input.signal?.removeEventListener("abort", onAbort);
        reject(new Error("composer_options_load_failed"));
      }
    };
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    unsubscribe = input.engine.subscribe(settle);
    settle();
  });
}
