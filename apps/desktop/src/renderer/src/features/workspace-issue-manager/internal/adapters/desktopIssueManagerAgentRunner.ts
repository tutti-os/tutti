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
  provider: string;
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
      const prompt = buildIssueManagerRunPrompt({
        copy: createIssueManagerI18nRuntime(input.i18n),
        issue: request.issue,
        task: request.task,
        workspaceRoot: "."
      });
      const issueTitle = request.issue.title;
      const taskTitle = request.task?.title || issueTitle;

      return createAndOpenIssueManagerAgentSession({
        agentSessionCreator: input.agentSessionCreator,
        agentSessionId: request.agentSessionId,
        cwd: request.executionDirectory,
        launchAgentGui: input.launchAgentGui,
        prompt,
        provider: request.provider,
        source: "issue_manager",
        title: taskTitle,
        userProjectPath: request.executionDirectory,
        workspaceId: input.workspaceId
      });
    }
  };
}

function createAndOpenIssueManagerAgentSession(input: {
  agentSessionCreator?: DesktopIssueManagerAgentSessionCreator;
  agentSessionId: string;
  cwd?: string | null;
  launchAgentGui?: (
    input: DesktopIssueManagerAgentGuiLaunchInput
  ) => Promise<void> | void;
  prompt: string;
  provider: string;
  source?: string | null;
  title: string;
  userProjectPath?: string | null;
  workspaceId: string;
}): Promise<{
  errorMessage?: string;
  sessionId?: string;
  status: "opened" | "failed";
}> {
  if (!input.agentSessionCreator || !input.launchAgentGui) {
    return Promise.resolve({
      errorMessage: "issue_manager.agent_gui_launch_unavailable",
      status: "failed"
    });
  }

  return input.agentSessionCreator
    .createSession({
      agentSessionId: input.agentSessionId,
      cwd: input.cwd,
      prompt: input.prompt,
      provider: input.provider,
      source: input.source,
      title: input.title,
      userProjectPath: input.userProjectPath,
      workspaceId: input.workspaceId
    })
    .then(async (session) => {
      await input.launchAgentGui?.({
        agentSessionId: session.agentSessionId,
        provider: session.provider?.trim() || input.provider,
        workspaceId: input.workspaceId
      });
      return {
        sessionId: session.agentSessionId,
        status: "opened" as const
      };
    });
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
      const issueTitle = request.issueDetail.issue.title;

      const session = await createAndOpenIssueManagerAgentSession({
        agentSessionCreator: input.agentSessionCreator,
        agentSessionId: createIssueManagerAgentSessionId(),
        cwd: request.executionDirectory,
        launchAgentGui: input.launchAgentGui,
        prompt,
        provider: request.provider,
        source: "issue_manager_breakdown",
        title: issueTitle,
        userProjectPath: request.executionDirectory,
        workspaceId: input.workspaceId
      });
      return session.errorMessage
        ? { errorMessage: session.errorMessage, status: session.status }
        : { status: session.status };
    }
  };
}

function createIssueManagerAgentSessionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) {
    return randomUUID;
  }
  return `issue-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
