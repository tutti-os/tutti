import type { AgentActivitySendInput } from "@tutti-os/agent-activity-core";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import { normalizeDesktopAgentGUIProvider } from "../../desktopAgentGUINodeState.ts";
import {
  createAgentSessionStartedTracker,
  resolveAgentSessionSource
} from "./agentSessionStartedAnalytics.ts";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface.ts";
import type {
  IWorkspaceAgentPromptSessionService,
  WorkspaceAgentPromptSessionCreateInput,
  WorkspaceAgentPromptSessionCreateResult
} from "../workspaceAgentPromptSessionService.interface.ts";

export interface WorkspaceAgentPromptSessionServiceDependencies {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceUserProjectService?: Pick<
    IWorkspaceUserProjectService,
    "isNoProjectPath"
  >;
}

export class WorkspaceAgentPromptSessionService implements IWorkspaceAgentPromptSessionService {
  readonly _serviceBrand = undefined;

  private readonly dependencies: WorkspaceAgentPromptSessionServiceDependencies;

  private readonly sessionStartedTracker: ReturnType<
    typeof createAgentSessionStartedTracker
  >;

  constructor(dependencies: WorkspaceAgentPromptSessionServiceDependencies) {
    this.dependencies = dependencies;
    this.sessionStartedTracker = createAgentSessionStartedTracker({
      reporterNow: dependencies.reporterNow,
      reporterService: dependencies.reporterService
    });
  }

  async createSession(
    input: WorkspaceAgentPromptSessionCreateInput
  ): Promise<WorkspaceAgentPromptSessionCreateResult> {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("workspace_agent.prompt_session_prompt_required");
    }

    const provider = normalizeDesktopAgentGUIProvider(input.provider);
    const agentSessionId =
      input.agentSessionId?.trim() || createWorkspaceAgentSessionId();
    const cwd = resolveWorkspaceAgentPromptSessionCwd(
      input,
      this.dependencies.workspaceUserProjectService
    );
    const title = input.title?.trim() || prompt;
    const activation =
      await this.dependencies.workspaceAgentActivityService.activateSession({
        agentSessionId,
        ...(cwd ? { cwd } : {}),
        initialContent: textPromptContent(prompt),
        mode: "new",
        provider,
        title,
        visible: input.visible ?? true,
        workspaceId: input.workspaceId
      });
    if (
      activation.activation.status === "failed" ||
      activation.session.status === "failed"
    ) {
      throw new Error(
        activation.error?.message ??
          activation.error?.code ??
          "workspace_agent.prompt_session_create_failed"
      );
    }

    await this.sessionStartedTracker.track({
      agentSessionId: activation.session.agentSessionId,
      hasProject: Boolean(activation.session.cwd?.trim()),
      permissionMode: null,
      provider: activation.session.provider || provider,
      source: resolveAgentSessionSource({
        mode: "new",
        source: input.source ?? undefined
      })
    });

    return {
      agentSessionId: activation.session.agentSessionId,
      provider: activation.session.provider || provider,
      status: activation.session.status ?? null
    };
  }
}

function textPromptContent(prompt: string): AgentActivitySendInput["content"] {
  const text = prompt.trim();
  return text ? [{ type: "text", text }] : [];
}

function resolveWorkspaceAgentPromptSessionCwd(
  input: WorkspaceAgentPromptSessionCreateInput,
  workspaceUserProjectService?: Pick<
    IWorkspaceUserProjectService,
    "isNoProjectPath"
  >
): string | undefined {
  const userProjectPath = input.userProjectPath?.trim();
  if (userProjectPath) {
    return workspaceUserProjectService?.isNoProjectPath(userProjectPath)
      ? undefined
      : userProjectPath;
  }
  const cwd = input.cwd?.trim();
  if (!cwd) {
    return undefined;
  }
  return workspaceUserProjectService?.isNoProjectPath(cwd) ? undefined : cwd;
}

function createWorkspaceAgentSessionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) {
    return randomUUID;
  }
  const bytes = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
