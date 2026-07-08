import assert from "node:assert/strict";
import test from "node:test";
import {
  tuttiAgentAssetUrls,
  tuttiIssueAssetUrls
} from "../../../../../../shared/tuttiAssetProtocol.ts";
import { resolveDesktopWorkspaceAppIconEntries } from "./desktopWorkspaceAppIcons.ts";

test("desktop workspace app icon entries use App Center icon fields", () => {
  const entries = resolveDesktopWorkspaceAppIconEntries({
    apps: [
      {
        appId: "automation",
        availableIconUrl: "available-automation.png",
        iconUrl: "stored-automation.png"
      },
      {
        appId: "notes",
        availableIconUrl: "available-notes.png",
        iconUrl: null
      }
    ],
    workspaceId: "workspace-1"
  });

  assert.deepEqual(entries, [
    {
      appId: "automation",
      iconUrl: "stored-automation.png",
      workspaceId: "workspace-1"
    },
    {
      appId: "notes",
      iconUrl: "available-notes.png",
      workspaceId: "workspace-1"
    },
    {
      appId: "agent-codex",
      iconUrl: tuttiAgentAssetUrls.codex,
      workspaceId: "workspace-1"
    },
    {
      appId: "agent-claude-code",
      iconUrl: tuttiAgentAssetUrls.claudeCode,
      workspaceId: "workspace-1"
    },
    {
      appId: "agent-tutti-agent",
      iconUrl: tuttiAgentAssetUrls.tuttiAgent,
      workspaceId: "workspace-1"
    },
    {
      appId: "issue-manager",
      iconUrl: tuttiIssueAssetUrls.default,
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop workspace app icon entries seed built-in agent app icons", () => {
  const entries = resolveDesktopWorkspaceAppIconEntries({
    apps: [],
    workspaceId: "workspace-1"
  });

  assert.deepEqual(entries, [
    {
      appId: "agent-codex",
      iconUrl: tuttiAgentAssetUrls.codex,
      workspaceId: "workspace-1"
    },
    {
      appId: "agent-claude-code",
      iconUrl: tuttiAgentAssetUrls.claudeCode,
      workspaceId: "workspace-1"
    },
    {
      appId: "agent-tutti-agent",
      iconUrl: tuttiAgentAssetUrls.tuttiAgent,
      workspaceId: "workspace-1"
    },
    {
      appId: "issue-manager",
      iconUrl: tuttiIssueAssetUrls.default,
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop workspace app icon entries keep App Center agent icons", () => {
  const entries = resolveDesktopWorkspaceAppIconEntries({
    apps: [
      {
        appId: "agent-codex",
        availableIconUrl: tuttiAgentAssetUrls.codex,
        iconUrl: "stored-agent-codex.png"
      }
    ],
    workspaceId: "workspace-1"
  });

  assert.deepEqual(entries, [
    {
      appId: "agent-codex",
      iconUrl: "stored-agent-codex.png",
      workspaceId: "workspace-1"
    },
    {
      appId: "agent-claude-code",
      iconUrl: tuttiAgentAssetUrls.claudeCode,
      workspaceId: "workspace-1"
    },
    {
      appId: "agent-tutti-agent",
      iconUrl: tuttiAgentAssetUrls.tuttiAgent,
      workspaceId: "workspace-1"
    },
    {
      appId: "issue-manager",
      iconUrl: tuttiIssueAssetUrls.default,
      workspaceId: "workspace-1"
    }
  ]);
});
