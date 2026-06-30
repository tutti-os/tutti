import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceWorkbenchDesktopI18nKeys,
  type WorkspaceWorkbenchDesktopI18nKey,
  type WorkspaceWorkbenchDesktopI18nRuntime
} from "../../../../../../shared/i18n/index.ts";
import {
  createAgentQuitGuardRequest,
  type AgentQuitGuardSession
} from "./workspaceAgentQuitGuard.ts";

test("agent quit guard is omitted when all agent sessions are idle", () => {
  assert.equal(
    createAgentQuitGuardRequest({
      i18n: createTestI18n(),
      sessions: [
        createSession("ready-session", { status: "ready" }),
        createSession("completed-session", { status: "completed" })
      ]
    }),
    null
  );
});

test("agent quit guard summarizes running and waiting agent sessions", () => {
  const request = createAgentQuitGuardRequest({
    i18n: createTestI18n(),
    sessions: [
      createSession("running-session", {
        provider: "codex",
        status: "running",
        title: "Refactor desktop shutdown"
      }),
      createSession("waiting-session", {
        provider: "claude-code",
        title: "Review generated files",
        turnPhase: "waiting_approval"
      }),
      createSession("completed-session", {
        provider: "gemini",
        status: "completed",
        title: "Already done"
      })
    ]
  });

  assert.equal(request?.title, "Quit while agents are running?");
  assert.equal(request?.variant, "destructive");
  assert.equal(
    request?.details,
    [
      "Codex: Refactor desktop shutdown",
      "Claude Code: Review generated files"
    ].join("\n")
  );
});

test("agent quit guard caps details for many running sessions", () => {
  const request = createAgentQuitGuardRequest({
    i18n: createTestI18n(),
    sessions: Array.from({ length: 7 }, (_, index) =>
      createSession(`session-${index}`, {
        provider: "codex",
        status: "working",
        title: `Task ${index}`
      })
    )
  });

  assert.equal(
    request?.details,
    [
      "Codex: Task 0",
      "Codex: Task 1",
      "Codex: Task 2",
      "Codex: Task 3",
      "Codex: Task 4",
      "and 2 more"
    ].join("\n")
  );
});

function createSession(
  agentSessionId: string,
  overrides: Partial<AgentQuitGuardSession>
): AgentQuitGuardSession {
  return {
    agentSessionId,
    provider: "codex",
    status: "ready",
    ...overrides
  };
}

function createTestI18n(): WorkspaceWorkbenchDesktopI18nRuntime {
  const dictionary: Partial<Record<WorkspaceWorkbenchDesktopI18nKey, string>> =
    {
      [workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.cancel]:
        "Keep Tutti open",
      [workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.confirm]:
        "Quit and stop agents",
      [workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.description]:
        "Local agent sessions are still running.",
      [workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.detailsMore]:
        "and {{count}} more",
      [workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.title]:
        "Quit while agents are running?"
    };
  return {
    has(key) {
      return key in dictionary;
    },
    t(key, params) {
      const template = dictionary[key] ?? key;
      return template.replaceAll("{{count}}", String(params?.count ?? ""));
    },
    tFirst(keys, params) {
      const key = keys.find((item) => this.has(item)) ?? keys[0];
      return key ? this.t(key, params) : "";
    }
  };
}
