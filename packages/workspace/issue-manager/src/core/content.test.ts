import assert from "node:assert/strict";
import test from "node:test";
import {
  appendIssueManagerWorkspaceFileLinksToContent,
  buildIssueManagerRunPrompt,
  buildIssueManagerTaskBreakdownPrompt,
  createIssueManagerMentionMarkdown,
  extractIssueManagerMentionsFromContent,
  extractIssueManagerWorkspaceFileLinksFromContent
} from "./index.ts";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createIssueManagerI18nRuntime,
  issueManagerI18nResources
} from "../i18n/index.ts";
import { createRichTextMentionAttrs } from "@tutti-os/ui-rich-text/plugins";

test("issue-manager content helpers append and extract workspace references", () => {
  const content = appendIssueManagerWorkspaceFileLinksToContent(
    "Existing note",
    [
      {
        kind: "file",
        name: "README.md",
        path: "/workspace/docs/README.md"
      },
      {
        kind: "folder",
        name: "docs",
        path: "/workspace/docs"
      }
    ]
  );

  assert.equal(
    content,
    "Existing note [README.md](/workspace/docs/README.md) [docs](/workspace/docs/)"
  );
  assert.match(content, /\[README\.md\]\(\/workspace\/docs\/README\.md\)/);
  assert.match(content, /\[docs\]\(\/workspace\/docs\/\)/);
  assert.deepEqual(extractIssueManagerWorkspaceFileLinksFromContent(content), [
    {
      href: "/workspace/docs/README.md",
      kind: "file",
      name: "README.md",
      path: "/workspace/docs/README.md"
    },
    {
      href: "/workspace/docs/",
      kind: "folder",
      name: "docs",
      path: "/workspace/docs/"
    }
  ]);
});

test("issue-manager run prompt keeps execute handoff issue-scoped", () => {
  const prompt = buildIssueManagerRunPrompt({
    issue: {
      issueId: "issue-1",
      workspaceId: "workspace-1",
      title: "Plan migration",
      content: "[spec](/workspace/docs/spec.md)",
      status: "running",
      creatorUserId: "local",
      topicId: "topic-1"
    },
    workspaceRoot: "/tmp/workspace"
  });

  assert.match(prompt, /Handle this issue reference/);
  assert.match(
    prompt,
    /\[@Plan migration\]\(mention:\/\/workspace-issue\/issue-1\?workspaceId=workspace-1&topicId=topic-1&mode=execute\)/
  );
  assert.doesNotMatch(prompt, /Port renderer/);
  assert.doesNotMatch(prompt, /taskId=/);
  assert.doesNotMatch(prompt, /runId=/);
  assert.doesNotMatch(prompt, /outputDir=/);
  assert.doesNotMatch(prompt, /Task 标题：Port renderer/);
  assert.doesNotMatch(prompt, /建议输出目录：/);
  assert.doesNotMatch(prompt, /\/tmp\/workspace\/docs\/spec\.md/);
  assert.doesNotMatch(prompt, /issue task run create/);
  assert.doesNotMatch(prompt, /issue task run complete/);
  assert.doesNotMatch(prompt, /Agent Provider/);
  assert.doesNotMatch(prompt, /Agent Session ID/);
});

test("issue-manager run prompt targets selected task when provided", () => {
  const prompt = buildIssueManagerRunPrompt({
    issue: {
      issueId: "issue-1",
      workspaceId: "workspace-1",
      title: "Plan migration",
      content: "[spec](/workspace/docs/spec.md)",
      status: "running",
      creatorUserId: "local",
      topicId: "topic-1"
    },
    task: {
      issueId: "issue-1",
      priority: "high",
      status: "not_started",
      taskId: "task-1",
      title: "Port renderer",
      workspaceId: "workspace-1",
      creatorUserId: "local"
    },
    workspaceRoot: "/tmp/workspace"
  });

  assert.match(
    prompt,
    /\[@Plan migration \/ Port renderer\]\(mention:\/\/workspace-issue\/issue-1\?workspaceId=workspace-1&topicId=topic-1&mode=execute&taskId=task-1\)/
  );
  assert.doesNotMatch(prompt, /runId=/);
  assert.doesNotMatch(prompt, /outputDir=/);
});

test("issue-manager run prompt follows injected locale copy", () => {
  const prompt = buildIssueManagerRunPrompt({
    copy: createIssueManagerI18nRuntime(
      createI18nRuntime({ dictionaries: [issueManagerI18nResources["zh-CN"]] })
    ),
    issue: {
      issueId: "issue-1",
      workspaceId: "workspace-1",
      title: "Plan migration",
      content: "",
      status: "running",
      creatorUserId: "local",
      topicId: "topic-1"
    },
    workspaceRoot: "/tmp/workspace"
  });

  assert.match(prompt, /请处理这个 Issue 引用/);
  assert.doesNotMatch(prompt, /Handle this issue reference/);
});

test("issue-manager task breakdown prompt captures issue context", () => {
  const prompt = buildIssueManagerTaskBreakdownPrompt({
    issueDetail: {
      contextRefs: [
        {
          contextRefId: "ctx-1",
          displayName: "spec.md",
          issueId: "issue-1",
          parentKind: "issue",
          path: "/workspace/docs/spec.md",
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
      tasks: [
        {
          creatorUserId: "local",
          issueId: "issue-1",
          priority: "high",
          status: "not_started",
          taskId: "task-1",
          title: "Audit shell",
          workspaceId: "workspace-1"
        }
      ]
    },
    workspaceId: "workspace-1"
  });

  assert.match(
    prompt,
    /\[@Plan migration\]\(mention:\/\/workspace-issue\/issue-1\?workspaceId=workspace-1&topicId=topic-1&mode=breakdown\)/
  );
  assert.match(prompt, /Break this issue reference down into executable tasks/);
  assert.doesNotMatch(prompt, /现有子事项数：1/);
  assert.doesNotMatch(prompt, /引用资料数：1/);
});

test("issue-manager task breakdown prompt follows injected locale copy", () => {
  const prompt = buildIssueManagerTaskBreakdownPrompt({
    copy: createIssueManagerI18nRuntime(
      createI18nRuntime({ dictionaries: [issueManagerI18nResources["zh-CN"]] })
    ),
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
    workspaceId: "workspace-1"
  });

  assert.match(prompt, /请基于这个 Issue 引用做任务拆解/);
  assert.doesNotMatch(
    prompt,
    /Break this issue reference down into executable tasks/
  );
});

test("issue-manager prompts escape markdown-sensitive issue mention labels", () => {
  const prompt = buildIssueManagerRunPrompt({
    issue: {
      issueId: "issue-1",
      title: "[iOS] Login \\ refresh",
      content: "",
      createdAtUnix: 1,
      creatorDisplayName: "Local User",
      creatorUserId: "local",
      status: "running",
      topicId: "topic-1",
      updatedAtUnix: 1,
      workspaceId: "workspace-1"
    },
    workspaceRoot: "/tmp/workspace"
  });

  assert.match(
    prompt,
    /\[@\\\[iOS\\\] Login \\\\ refresh\]\(mention:\/\/workspace-issue\/issue-1\?workspaceId=workspace-1&topicId=topic-1&mode=execute\)/
  );
});

test("issue-manager content helpers round-trip rich text mentions", () => {
  const mention = createRichTextMentionAttrs("user", {
    entityId: "u_123",
    label: "Alice"
  });
  const content = `Follow up with ${createIssueManagerMentionMarkdown(mention)} today`;

  assert.deepEqual(extractIssueManagerMentionsFromContent(content), [
    {
      trigger: "@",
      providerId: "user",
      entityId: "u_123",
      label: "Alice"
    }
  ]);
});
