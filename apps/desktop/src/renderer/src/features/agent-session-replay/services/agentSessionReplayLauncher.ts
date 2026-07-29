import type { DesktopRuntimeApi } from "@preload/types";
import type { AgentSessionReplayService } from "./agentSessionReplayService.ts";

export interface AgentSessionReplayLauncher {
  launch(cassetteId: string): Promise<{
    completion: Promise<void>;
  }>;
}

export function createAgentSessionReplayLauncher(input: {
  runtimeApi: Pick<
    DesktopRuntimeApi,
    "launchAgentSessionReplay" | "waitForAgentSessionReplay"
  >;
  service: Pick<
    AgentSessionReplayService,
    | "completeReplayRun"
    | "failReplayRun"
    | "markReplayRunRunning"
    | "prepareReplayRun"
  >;
  workspaceId: string;
}): AgentSessionReplayLauncher {
  return {
    async launch(cassetteId) {
      const prepared = await input.service.prepareReplayRun(cassetteId);
      try {
        await input.service.markReplayRunRunning(prepared.run.id);
        await input.runtimeApi.launchAgentSessionReplay({
          cassetteId,
          cassetteDirectory: prepared.cassetteDirectory,
          runId: prepared.run.id,
          workspaceId: input.workspaceId
        });
      } catch (error) {
        try {
          await input.service.failReplayRun(prepared.run.id, error);
        } catch {
          // Preserve the runtime/verification failure as the user-facing cause.
        }
        throw error;
      }
      const completion = (async () => {
        try {
          const completed = await input.runtimeApi.waitForAgentSessionReplay({
            runId: prepared.run.id
          });
          await input.service.completeReplayRun(completed.runId);
        } catch (error) {
          try {
            await input.service.failReplayRun(prepared.run.id, error);
          } catch {
            // Preserve the runtime/verification failure as the user-facing cause.
          }
          throw error;
        }
      })();
      void completion.catch(() => undefined);
      return { completion };
    }
  };
}
