import {
  buildIssueManagerRunPrompt,
  buildIssueManagerTaskBreakdownPrompt,
  createIssueManagerAgentLaunchMessages,
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
    agentTargetId: string;
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
      const copy = createIssueManagerI18nRuntime(input.i18n);
      const messages = createIssueManagerAgentLaunchMessages(copy);
      const agentTargetId = resolveIssueManagerRequestAgentTargetIdOrError(
        request.agentTargetId
      );
      if (!agentTargetId) {
        return {
          errorMessage: messages.agentTargetRequired,
          status: "failed"
        };
      }
      const prompt = buildIssueManagerRunPrompt({
        copy,
        issue: request.issue,
        task: request.task,
        workspaceRoot: "."
      });
      return openIssueManagerAgentDraft({
        agentTargetId,
        agentGuiLaunchUnavailableMessage: messages.agentGuiLaunchUnavailable,
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
  agentGuiLaunchUnavailableMessage: string;
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
      errorMessage: input.agentGuiLaunchUnavailableMessage,
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
      const copy = createIssueManagerI18nRuntime(input.i18n);
      const messages = createIssueManagerAgentLaunchMessages(copy);
      const agentTargetId = resolveIssueManagerRequestAgentTargetIdOrError(
        request.agentTargetId
      );
      if (!agentTargetId) {
        return {
          errorMessage: messages.agentTargetRequired,
          status: "failed"
        };
      }
      const prompt = buildIssueManagerTaskBreakdownPrompt({
        copy,
        issueDetail: {
          contextRefs: [...request.issueDetail.contextRefs],
          issue: request.issueDetail.issue,
          tasks: [...request.issueDetail.tasks]
        },
        workspaceId: input.workspaceId
      });
      const session = await openIssueManagerAgentDraft({
        agentTargetId,
        agentGuiLaunchUnavailableMessage: messages.agentGuiLaunchUnavailable,
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

function resolveIssueManagerRequestAgentTargetIdOrError(
  agentTargetId: string | null | undefined
): string | null {
  const normalizedAgentTargetId = agentTargetId?.trim();
  if (normalizedAgentTargetId) {
    return normalizedAgentTargetId;
  }
  return null;
}
