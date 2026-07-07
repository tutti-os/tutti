import {
  buildIssueManagerRunPrompt,
  buildIssueManagerTaskBreakdownPrompt,
  createIssueManagerI18nRuntime
} from "@tutti-os/workspace-issue-manager";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  IssueManagerAgentBreakdownLauncher,
  IssueManagerAgentBreakdownResult,
  IssueManagerAgentRunner,
  IssueManagerAgentRunResult
} from "@tutti-os/workspace-issue-manager/contracts";

export interface DesktopIssueManagerAgentSessionCreator {
  createSession(input: {
    agentSessionId: string;
    cwd?: string | null;
    prompt: string;
    provider: string;
    source?: string | null;
    title: string;
    userProjectPath?: string | null;
    workspaceId: string;
  }): Promise<{
    agentSessionId: string;
    provider?: string | null;
    status?: string | null;
  }>;
}

export interface DesktopIssueManagerAgentGuiLaunchInput {
  agentSessionId?: string;
  agentTargetId?: string | null;
  draftPrompt?: string;
  provider: string;
  userProjectPath?: string | null;
  workspaceId: string;
}

export function createDesktopIssueManagerAgentRunner(input: {
  agentSessionCreator?: DesktopIssueManagerAgentSessionCreator;
  i18n?: I18nRuntime<string>;
  launchAgentGui?: (
    input: DesktopIssueManagerAgentGuiLaunchInput
  ) => Promise<void> | void;
  workspaceId: string;
}): IssueManagerAgentRunner {
  return {
    async runTask(request): Promise<IssueManagerAgentRunResult> {
      const agentTargetId = resolveIssueManagerRequestAgentTargetId(
        request.agentTargetId,
        request.provider
      );
      const prompt = buildIssueManagerRunPrompt({
        copy: createIssueManagerI18nRuntime(input.i18n),
        issue: request.issue,
        task: request.task,
        workspaceRoot: "."
      });
      return openIssueManagerAgentDraft({
        agentTargetId,
        draftPrompt: prompt,
        launchAgentGui: input.launchAgentGui,
        provider: request.provider,
        userProjectPath: request.executionDirectory,
        workspaceId: input.workspaceId
      });
    }
  };
}

function openIssueManagerAgentDraft(input: {
  agentTargetId: string;
  draftPrompt: string;
  launchAgentGui?: (
    input: DesktopIssueManagerAgentGuiLaunchInput
  ) => Promise<void> | void;
  provider: string;
  userProjectPath?: string | null;
  workspaceId: string;
}): Promise<{
  errorMessage?: string;
  sessionId?: string;
  status: "opened" | "failed";
}> {
  const launchAgentGui = input.launchAgentGui;
  if (!launchAgentGui) {
    return Promise.resolve({
      errorMessage: "issue_manager.agent_gui_launch_unavailable",
      status: "failed"
    });
  }

  return Promise.resolve()
    .then(() =>
      launchAgentGui({
        agentTargetId: input.agentTargetId,
        draftPrompt: input.draftPrompt,
        provider: input.provider,
        userProjectPath: input.userProjectPath,
        workspaceId: input.workspaceId
      })
    )
    .then(() => ({
      status: "opened" as const
    }));
}

export function createDesktopIssueManagerAgentBreakdownLauncher(input: {
  agentSessionCreator?: DesktopIssueManagerAgentSessionCreator;
  i18n?: I18nRuntime<string>;
  launchAgentGui?: (
    input: DesktopIssueManagerAgentGuiLaunchInput
  ) => Promise<void> | void;
  workspaceId: string;
}): IssueManagerAgentBreakdownLauncher {
  return {
    async startBreakdown(request): Promise<IssueManagerAgentBreakdownResult> {
      const prompt = buildIssueManagerTaskBreakdownPrompt({
        copy: createIssueManagerI18nRuntime(input.i18n),
        issueDetail: {
          contextRefs: [...request.issueDetail.contextRefs],
          issue: request.issueDetail.issue,
          tasks: [...request.issueDetail.tasks]
        },
        workspaceId: input.workspaceId
      });
      const session = await openIssueManagerAgentDraft({
        agentTargetId: resolveIssueManagerRequestAgentTargetId(
          request.agentTargetId,
          request.provider
        ),
        draftPrompt: prompt,
        launchAgentGui: input.launchAgentGui,
        provider: request.provider,
        userProjectPath: request.executionDirectory,
        workspaceId: input.workspaceId
      });
      return session.errorMessage
        ? { errorMessage: session.errorMessage, status: session.status }
        : { status: session.status };
    }
  };
}

function resolveIssueManagerRequestAgentTargetId(
  agentTargetId: string | null | undefined,
  provider: string
): string {
  const normalizedAgentTargetId = agentTargetId?.trim();
  if (normalizedAgentTargetId) {
    return normalizedAgentTargetId;
  }
  switch (provider.trim()) {
    case "codex":
      return "local:codex";
    case "claude-code":
      return "local:claude-code";
    case "cursor":
      return "local:cursor";
    case "opencode":
      return "local:opencode";
    default:
      return "";
  }
}
