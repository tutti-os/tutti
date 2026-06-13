import assert from "node:assert/strict";
import test from "node:test";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface.ts";
import { WorkspaceAgentPromptSessionService } from "./workspaceAgentPromptSessionService.ts";

test("workspace agent prompt session service creates a new session with initial prompt content", async () => {
  let capturedActivation: unknown;
  const service = new WorkspaceAgentPromptSessionService({
    workspaceAgentActivityService: {
      _serviceBrand: undefined,
      async activateSession(input) {
        capturedActivation = input;
        return {
          activation: { mode: "new", status: "attached" },
          session: {
            agentSessionId: input.agentSessionId,
            cwd: input.cwd,
            provider: input.provider ?? "codex",
            status: "running"
          }
        };
      }
    } as IWorkspaceAgentActivityService
  });

  const result = await service.createSession({
    agentSessionId: "session-1",
    cwd: "/workspace/project",
    prompt: "  Build the feature  ",
    provider: "codex",
    source: "issue_manager",
    title: "Build feature",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(capturedActivation, {
    agentSessionId: "session-1",
    cwd: "/workspace/project",
    initialContent: [{ type: "text", text: "Build the feature" }],
    mode: "new",
    provider: "codex",
    title: "Build feature",
    visible: true,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(result, {
    agentSessionId: "session-1",
    provider: "codex",
    status: "running"
  });
});

test("workspace agent prompt session service rejects failed activation", async () => {
  const service = new WorkspaceAgentPromptSessionService({
    workspaceAgentActivityService: {
      _serviceBrand: undefined,
      async activateSession(input) {
        return {
          activation: { mode: "new", status: "failed" },
          error: { message: "provider unavailable" },
          session: {
            agentSessionId: input.agentSessionId,
            provider: input.provider ?? "codex",
            status: "failed"
          }
        };
      }
    } as IWorkspaceAgentActivityService
  });

  await assert.rejects(
    () =>
      service.createSession({
        prompt: "Build",
        provider: "codex",
        workspaceId: "workspace-1"
      }),
    /provider unavailable/
  );
});

test("workspace agent prompt session service maps user project selection to cwd", async () => {
  let capturedActivation: unknown;
  const service = new WorkspaceAgentPromptSessionService({
    workspaceAgentActivityService: {
      _serviceBrand: undefined,
      async activateSession(input) {
        capturedActivation = input;
        return {
          activation: { mode: "new", status: "attached" },
          session: {
            agentSessionId: input.agentSessionId,
            cwd: input.cwd,
            provider: input.provider ?? "codex",
            status: "running"
          }
        };
      }
    } as IWorkspaceAgentActivityService,
    workspaceUserProjectService: {
      isNoProjectPath(path) {
        return path === "/workspace/no-project";
      }
    }
  });

  await service.createSession({
    agentSessionId: "session-2",
    cwd: "/workspace/fallback",
    prompt: "Build",
    provider: "codex",
    userProjectPath: "/workspace/project",
    workspaceId: "workspace-1"
  });

  assert.equal(
    (capturedActivation as { cwd?: string }).cwd,
    "/workspace/project"
  );

  await service.createSession({
    agentSessionId: "session-3",
    cwd: "/workspace/fallback",
    prompt: "Build",
    provider: "codex",
    userProjectPath: "/workspace/no-project",
    workspaceId: "workspace-1"
  });

  assert.equal((capturedActivation as { cwd?: string }).cwd, undefined);
});
