import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceLinkAction } from "@contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import { runDesktopAgentGUILinkAction } from "./desktopAgentGUILinkActions.ts";

test("desktop agent gui link actions launch workspace files with resolved action path", async () => {
  const launchedFiles: unknown[] = [];
  const action: WorkspaceLinkAction = {
    directoryPath: "/Users/local/project",
    path: "/Users/local/project/a.md",
    source: "agent-markdown",
    type: "open-workspace-file",
    workspaceRoot: "/"
  };

  const handled = await runDesktopAgentGUILinkAction(action, {
    getAgentSession: failGetAgentSession,
    homeDirectory: "/Users/local",
    launchAgentGui: failLaunchAgentGui,
    launchWorkspaceIssueManager: failLaunchWorkspaceIssueManager,
    launchWorkspaceFiles(input) {
      launchedFiles.push(input);
      return true;
    },
    openBrowserUrl: failOpenBrowserUrl,
    workspaceId: "workspace-1"
  });

  assert.equal(handled, true);
  assert.deepEqual(launchedFiles, [
    {
      homeDirectory: "/Users/local",
      path: "/Users/local/project/a.md",
      source: "agent_command",
      validateExists: true,
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent gui project menu opens the project folder path in workspace files", async () => {
  const launchedFiles: unknown[] = [];
  const action: WorkspaceLinkAction = {
    directoryPath: "/Users/local/project",
    mode: "open",
    path: "/Users/local/project",
    source: "agent-project-menu",
    type: "open-workspace-file",
    workspaceRoot: "/Users/local/project"
  };

  const handled = await runDesktopAgentGUILinkAction(action, {
    getAgentSession: failGetAgentSession,
    homeDirectory: "/Users/local",
    launchAgentGui: failLaunchAgentGui,
    launchWorkspaceIssueManager: failLaunchWorkspaceIssueManager,
    launchWorkspaceFiles(input) {
      launchedFiles.push(input);
      return true;
    },
    openBrowserUrl: failOpenBrowserUrl,
    workspaceId: "workspace-1"
  });

  assert.equal(handled, true);
  assert.deepEqual(launchedFiles, [
    {
      homeDirectory: "/Users/local",
      mode: "open",
      path: "/Users/local/project",
      source: "agent_command",
      validateExists: true,
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent gui link actions reveal local asset previews in workspace files", async () => {
  const launchedFiles: unknown[] = [];
  const handled = await runDesktopAgentGUILinkAction(
    {
      name: "photo.png",
      path: "/var/cache/tsh/local-assets/room-1/user-1/photo.png",
      source: "agent-markdown",
      type: "open-local-asset-preview"
    },
    {
      getAgentSession: failGetAgentSession,
      homeDirectory: "/Users/local",
      launchAgentGui: failLaunchAgentGui,
      launchWorkspaceIssueManager: failLaunchWorkspaceIssueManager,
      launchWorkspaceFiles(input) {
        launchedFiles.push(input);
        return true;
      },
      openBrowserUrl: failOpenBrowserUrl,
      workspaceId: "workspace-1"
    }
  );

  assert.equal(handled, true);
  assert.deepEqual(launchedFiles, [
    {
      homeDirectory: "/Users/local",
      path: "/var/cache/tsh/local-assets/room-1/user-1/photo.png",
      source: "agent_command",
      validateExists: true,
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent gui link actions validate pasted text archives before opening", async () => {
  const launchedFiles: unknown[] = [];
  const handled = await runDesktopAgentGUILinkAction(
    {
      href: "mention://pasted-text/archive-1?path=%2Farchive%2Fmissing.txt",
      kind: "pasted-text",
      source: "agent-markdown",
      type: "open-custom-mention"
    },
    {
      getAgentSession: failGetAgentSession,
      homeDirectory: "/Users/local",
      launchAgentGui: failLaunchAgentGui,
      launchWorkspaceIssueManager: failLaunchWorkspaceIssueManager,
      launchWorkspaceFiles(input) {
        launchedFiles.push(input);
        return true;
      },
      openBrowserUrl: failOpenBrowserUrl,
      workspaceId: "workspace-1"
    }
  );

  assert.equal(handled, true);
  assert.deepEqual(launchedFiles, [
    {
      homeDirectory: "/Users/local",
      path: "/archive/missing.txt",
      source: "agent_command",
      validateExists: true,
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent gui link actions open urls through the workspace browser", async () => {
  const openedUrls: unknown[] = [];

  const handled = await runDesktopAgentGUILinkAction(
    {
      source: "agent-markdown",
      type: "open-url",
      url: "https://example.com"
    },
    {
      getAgentSession: failGetAgentSession,
      launchAgentGui: failLaunchAgentGui,
      launchWorkspaceIssueManager: failLaunchWorkspaceIssueManager,
      launchWorkspaceFiles: failLaunchWorkspaceFiles,
      openBrowserUrl(input) {
        openedUrls.push(input);
        return true;
      },
      workspaceId: "workspace-1"
    }
  );

  assert.equal(handled, true);
  assert.deepEqual(openedUrls, [
    {
      reuseIfOpen: true,
      source: "agent_command",
      url: "https://example.com",
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent gui link actions launch agent sessions in the same workspace", async () => {
  const launchedSessions: unknown[] = [];

  const handled = await runDesktopAgentGUILinkAction(
    {
      agentSessionId: "session-1",
      source: "agent-markdown",
      type: "open-agent-session",
      workspaceId: "workspace-1"
    },
    {
      async getAgentSession() {
        return {
          agentTargetId: "local:claude-code",
          provider: "claude-code"
        };
      },
      launchAgentGui(input) {
        launchedSessions.push(input);
        return true;
      },
      launchWorkspaceIssueManager: failLaunchWorkspaceIssueManager,
      launchWorkspaceFiles: failLaunchWorkspaceFiles,
      openBrowserUrl: failOpenBrowserUrl,
      workspaceId: "workspace-1"
    }
  );

  assert.equal(handled, true);
  assert.deepEqual(launchedSessions, [
    {
      agentSessionId: "session-1",
      agentTargetId: "local:claude-code",
      provider: "claude-code",
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent gui link actions safely reject unavailable session mentions", async () => {
  const handled = await runDesktopAgentGUILinkAction(
    {
      agentSessionId: "missing-session",
      source: "agent-markdown",
      type: "open-agent-session",
      workspaceId: "workspace-1"
    },
    {
      async getAgentSession() {
        throw new Error("session not found");
      },
      launchAgentGui: failLaunchAgentGui,
      launchWorkspaceIssueManager: failLaunchWorkspaceIssueManager,
      launchWorkspaceFiles: failLaunchWorkspaceFiles,
      openBrowserUrl: failOpenBrowserUrl,
      workspaceId: "workspace-1"
    }
  );

  assert.equal(handled, false);
});

test("desktop agent gui link actions launch workspace issue manager in the same workspace", async () => {
  const launchedIssues: unknown[] = [];

  const handled = await runDesktopAgentGUILinkAction(
    {
      issueId: "issue-1",
      mode: "execute",
      outputDir: "issues/issue-1/tasks/task-1/runs/run-1",
      runId: "run-1",
      source: "agent-markdown",
      taskId: "task-1",
      topicId: "topic-1",
      type: "open-workspace-issue",
      workspaceId: "workspace-1"
    },
    {
      getAgentSession: failGetAgentSession,
      launchAgentGui: failLaunchAgentGui,
      launchWorkspaceIssueManager(input) {
        launchedIssues.push(input);
        return true;
      },
      launchWorkspaceFiles: failLaunchWorkspaceFiles,
      openBrowserUrl: failOpenBrowserUrl,
      workspaceId: "workspace-1"
    }
  );

  assert.equal(handled, true);
  assert.deepEqual(launchedIssues, [
    {
      issueId: "issue-1",
      mode: "execute",
      outputDir: "issues/issue-1/tasks/task-1/runs/run-1",
      runId: "run-1",
      taskId: "task-1",
      topicId: "topic-1",
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent gui link actions launch workspace apps in the same workspace", async () => {
  const launchedApps: unknown[] = [];

  const handled = await runDesktopAgentGUILinkAction(
    {
      appId: "ai-media-canvas",
      source: "agent-markdown",
      type: "open-workspace-app",
      workspaceId: "workspace-1"
    },
    {
      getAgentSession: failGetAgentSession,
      launchAgentGui: failLaunchAgentGui,
      launchWorkspaceApp(input) {
        launchedApps.push(input);
        return true;
      },
      launchWorkspaceIssueManager: failLaunchWorkspaceIssueManager,
      launchWorkspaceFiles: failLaunchWorkspaceFiles,
      openBrowserUrl: failOpenBrowserUrl,
      workspaceId: "workspace-1"
    }
  );

  assert.equal(handled, true);
  assert.deepEqual(launchedApps, [
    {
      appId: "ai-media-canvas",
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent gui link actions route issue-manager app mentions to issue manager", async () => {
  const launchedIssues: unknown[] = [];

  const handled = await runDesktopAgentGUILinkAction(
    {
      appId: "issue-manager",
      source: "agent-markdown",
      type: "open-workspace-app",
      workspaceId: "workspace-1"
    },
    {
      getAgentSession: failGetAgentSession,
      launchAgentGui: failLaunchAgentGui,
      launchWorkspaceApp: failLaunchWorkspaceApp,
      launchWorkspaceIssueManager(input) {
        launchedIssues.push(input);
        return true;
      },
      launchWorkspaceFiles: failLaunchWorkspaceFiles,
      openBrowserUrl: failOpenBrowserUrl,
      workspaceId: "workspace-1"
    }
  );

  assert.equal(handled, true);
  assert.deepEqual(launchedIssues, [
    {
      workspaceId: "workspace-1"
    }
  ]);
});

function failLaunchAgentGui(): never {
  throw new Error("agent gui should not launch");
}

function failGetAgentSession(): never {
  throw new Error("agent session should not load");
}

function failLaunchWorkspaceApp(): never {
  throw new Error("workspace app should not launch");
}

function failLaunchWorkspaceFiles(): never {
  throw new Error("workspace files should not launch");
}

function failLaunchWorkspaceIssueManager(): never {
  throw new Error("workspace issue manager should not launch");
}

function failOpenBrowserUrl(): never {
  throw new Error("browser url should not open");
}
