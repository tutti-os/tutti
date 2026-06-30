import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopIssueManagerAgentBreakdownLauncher,
  createDesktopIssueManagerAgentRunner,
  type DesktopIssueManagerAgentGuiLaunchInput,
  type DesktopIssueManagerAgentSessionCreator
} from "./desktopIssueManagerAgentRunner.ts";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { issueManagerI18nResources } from "@tutti-os/workspace-issue-manager";

test("desktop issue-manager agent runner opens execute prompt as an agent draft", async () => {
  let capturedCreate: AgentSessionCreateInput | undefined;
  let capturedLaunch: DesktopIssueManagerAgentGuiLaunchInput | undefined;
  const runner = createDesktopIssueManagerAgentRunner({
    agentSessionCreator: createAgentSessionCreator((input) => {
      capturedCreate = input;
    }),
    launchAgentGui(input) {
      capturedLaunch = input;
    },
    workspaceId: "workspace-1"
  });

  const result = await runner.runTask(createRunRequest());

  const capturedPrompt = capturedLaunch?.draftPrompt ?? "";
  assert.equal(capturedCreate, undefined);
  assert.equal(capturedLaunch?.agentSessionId, undefined);
  assert.equal(capturedLaunch?.provider, "codex");
  assert.equal(capturedLaunch?.userProjectPath, undefined);
  assert.equal(capturedLaunch?.workspaceId, "workspace-1");
  assert.match(capturedPrompt, /Handle this task reference/);
  assert.match(
    capturedPrompt,
    /\[@Plan migration \/ Port renderer\]\(mention:\/\/workspace-issue\/issue-1\?workspaceId=workspace-1&topicId=topic-1&mode=execute&taskId=task-1\)/
  );
  assert.doesNotMatch(capturedPrompt, /runId=/);
  assert.doesNotMatch(capturedPrompt, /outputDir=/);
  assert.doesNotMatch(capturedPrompt, /Task 标题：Port renderer/);
  assert.doesNotMatch(
    capturedPrompt,
    /工作目录：\/Users\/liying\/\.tutti-dev\/sessions\/2026-06-03-001/
  );
  assert.doesNotMatch(capturedPrompt, /建议输出目录：/);
  assert.doesNotMatch(capturedPrompt, /docs\/spec\.md/);
  assert.doesNotMatch(capturedPrompt, /docs\/design\.md/);
  assert.doesNotMatch(capturedPrompt, /Tutti Issue Run Context/);
  assert.doesNotMatch(capturedPrompt, /Agent Provider：codex/);
  assert.doesNotMatch(capturedPrompt, /Agent Session ID：agent-session-1/);
  assert.deepEqual(result, { status: "opened" });
});

test("desktop issue-manager agent runner reports unavailable agent GUI launcher", async () => {
  const runner = createDesktopIssueManagerAgentRunner({
    workspaceId: "workspace-1"
  });

  const result = await runner.runTask(createRunRequest());

  assert.deepEqual(result, {
    errorMessage: "issue_manager.agent_gui_launch_unavailable",
    status: "failed"
  });
});

test("desktop issue-manager agent runner sends localized execute prompt", async () => {
  let capturedPrompt = "";
  const runner = createDesktopIssueManagerAgentRunner({
    i18n: createI18nRuntime({
      dictionaries: [issueManagerI18nResources["zh-CN"]]
    }),
    launchAgentGui(input) {
      capturedPrompt = input.draftPrompt ?? "";
    },
    workspaceId: "workspace-1"
  });

  await runner.runTask(createRunRequest());

  assert.match(capturedPrompt, /请处理这个任务引用/);
  assert.doesNotMatch(capturedPrompt, /Handle this task reference/);
});

test("desktop issue-manager agent runner passes selected execution directory to the draft launch", async () => {
  let capturedCreate: AgentSessionCreateInput | undefined;
  let capturedLaunch: DesktopIssueManagerAgentGuiLaunchInput | undefined;
  const runner = createDesktopIssueManagerAgentRunner({
    agentSessionCreator: createAgentSessionCreator((input) => {
      capturedCreate = input;
    }),
    launchAgentGui(input) {
      capturedLaunch = input;
    },
    workspaceId: "workspace-1"
  });

  const result = await runner.runTask(
    createRunRequest({ executionDirectory: "/Users/example/project/tutti" })
  );
  const prompt = capturedLaunch?.draftPrompt ?? "";

  assert.equal(capturedCreate, undefined);
  assert.equal(capturedLaunch?.userProjectPath, "/Users/example/project/tutti");
  assert.doesNotMatch(prompt, /\/Users\/example\/project\/tutti/);
  assert.match(prompt, /mention:\/\/workspace-issue/);
  assert.equal(result.status, "opened");
});

test("desktop issue-manager agent breakdown launcher opens breakdown prompt as an agent draft", async () => {
  let capturedCreate: AgentSessionCreateInput | undefined;
  let capturedLaunch: DesktopIssueManagerAgentGuiLaunchInput | undefined;
  const launcher = createDesktopIssueManagerAgentBreakdownLauncher({
    agentSessionCreator: createAgentSessionCreator((input) => {
      capturedCreate = input;
    }, "breakdown-session-1"),
    launchAgentGui(input) {
      capturedLaunch = input;
    },
    workspaceId: "workspace-1"
  });

  const result = await launcher.startBreakdown({
    issueDetail: {
      contextRefs: [
        {
          contextRefId: "ctx-1",
          displayName: "spec.md",
          issueId: "issue-1",
          parentKind: "issue",
          path: "/workspace/spec.md",
          refType: "file",
          workspaceId: "workspace-1"
        }
      ],
      issue: {
        content: "Need a phased migration",
        creatorUserId: "local",
        issueId: "issue-1",
        status: "not_started",
        title: "Plan migration",
        topicId: "topic-1",
        workspaceId: "workspace-1"
      },
      tasks: []
    },
    executionDirectory: "/Users/example/project/tutti",
    provider: "gemini",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(result, { status: "opened" });
  assert.equal(capturedCreate, undefined);
  assert.equal(capturedLaunch?.agentSessionId, undefined);
  assert.match(
    capturedLaunch?.draftPrompt ?? "",
    /Break this task reference down into executable tasks/
  );
  assert.match(
    capturedLaunch?.draftPrompt ?? "",
    /mention:\/\/workspace-issue\/issue-1\?workspaceId=workspace-1&topicId=topic-1&mode=breakdown/
  );
  assert.equal(capturedLaunch?.provider, "gemini");
  assert.equal(capturedLaunch?.userProjectPath, "/Users/example/project/tutti");
  assert.equal(capturedLaunch?.workspaceId, "workspace-1");
  assert.doesNotMatch(capturedLaunch?.draftPrompt ?? "", /引用资料数：1/);
});

test("desktop issue-manager agent breakdown launcher sends localized prompt", async () => {
  let capturedPrompt = "";
  const launcher = createDesktopIssueManagerAgentBreakdownLauncher({
    i18n: createI18nRuntime({
      dictionaries: [issueManagerI18nResources["zh-CN"]]
    }),
    launchAgentGui(input) {
      capturedPrompt = input.draftPrompt ?? "";
    },
    workspaceId: "workspace-1"
  });

  await launcher.startBreakdown({
    issueDetail: {
      contextRefs: [],
      issue: {
        content: "Need a phased migration",
        creatorUserId: "local",
        issueId: "issue-1",
        status: "not_started",
        title: "Plan migration",
        topicId: "topic-1",
        workspaceId: "workspace-1"
      },
      tasks: []
    },
    provider: "gemini",
    workspaceId: "workspace-1"
  });

  assert.match(capturedPrompt, /请基于这个任务引用做任务拆解/);
  assert.doesNotMatch(
    capturedPrompt,
    /Break this task reference down into executable tasks/
  );
});

type AgentSessionCreateInput = Parameters<
  DesktopIssueManagerAgentSessionCreator["createSession"]
>[0];

function createAgentSessionCreator(
  capture: (input: AgentSessionCreateInput) => void,
  resultAgentSessionId?: string
): DesktopIssueManagerAgentSessionCreator {
  return {
    async createSession(input) {
      capture(input);
      return {
        agentSessionId: resultAgentSessionId ?? input.agentSessionId,
        provider: input.provider,
        status: "running"
      };
    }
  };
}

function createRunRequest(input?: { executionDirectory?: string | null }) {
  return {
    ...(input?.executionDirectory
      ? { executionDirectory: input.executionDirectory }
      : {}),
    issue: {
      content: "[spec](/workspace/docs/spec.md)",
      creatorUserId: "local",
      issueId: "issue-1",
      status: "running" as const,
      title: "Plan migration",
      topicId: "topic-1",
      workspaceId: "workspace-1"
    },
    provider: "codex",
    task: {
      content: "[design](/workspace/docs/design.md)",
      creatorUserId: "local",
      issueId: "issue-1",
      priority: "high" as const,
      status: "not_started" as const,
      taskId: "task-1",
      title: "Port renderer",
      workspaceId: "workspace-1"
    },
    workspaceId: "workspace-1"
  };
}
