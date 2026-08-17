import assert from "node:assert/strict";
import test from "node:test";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { WorkspaceDeletedConversation } from "../workspaceSettingsTypes.ts";
import { WorkspaceDeletedConversationsController } from "./workspaceDeletedConversationsController.ts";
import { createWorkspaceSettingsStore } from "./workspaceSettingsStore.ts";

test("deleted conversations load in update-time order and continue from the cursor", async () => {
  const calls: Array<{ cursor: string | null; workspaceID: string }> = [];
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const controller = new WorkspaceDeletedConversationsController({
    client: createClient({
      async listWorkspaceDeletedAgentSessions(workspaceID, input) {
        calls.push({ cursor: input.cursor, workspaceID });
        if (!input.cursor) {
          return {
            hasMore: true,
            nextCursor: "cursor-2",
            projectOptions: [
              {
                projectAvailable: false,
                projectLabel: "Removed project",
                projectPath: "/projects/removed",
                railSectionKey: "project:/projects/removed"
              }
            ],
            sessions: [
              createConversation("session-old", 100),
              createConversation("session-new", 300)
            ],
            totalCount: 3,
            workspaceTotalCount: 3
          };
        }
        return {
          hasMore: false,
          projectOptions: [],
          sessions: [createConversation("session-middle", 200)],
          totalCount: 3,
          workspaceTotalCount: 3
        };
      }
    }),
    notifications: createNotifications(),
    store
  });

  await controller.refresh();
  assert.deepEqual(
    store.deletedConversations.sessions.map(
      (session) => session.agentSessionId
    ),
    ["session-new", "session-old"]
  );
  assert.equal(store.deletedConversations.workspaceTotalCount, 3);
  assert.equal(
    store.deletedConversations.projectOptions[0]?.projectAvailable,
    false
  );

  await controller.loadMore();
  assert.deepEqual(calls, [
    { cursor: null, workspaceID: "workspace-1" },
    { cursor: "cursor-2", workspaceID: "workspace-1" }
  ]);
  assert.deepEqual(
    store.deletedConversations.sessions.map(
      (session) => session.agentSessionId
    ),
    ["session-new", "session-middle", "session-old"]
  );
});

test("restore removes only the restored row and leaves the settings surface in place", async () => {
  const restored: string[] = [];
  const messages: string[] = [];
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.activeSection = "deletedConversations";
  store.deletedConversations.sessions = [
    createConversation("session-1", 200),
    createConversation("session-2", 100)
  ];
  store.deletedConversations.totalCount = 2;
  store.deletedConversations.workspaceTotalCount = 2;
  const controller = new WorkspaceDeletedConversationsController({
    client: createClient({
      async restoreWorkspaceDeletedAgentSession(workspaceID, sessionID) {
        restored.push(`${workspaceID}:${sessionID}`);
      }
    }),
    notifications: createNotifications(messages),
    store
  });

  assert.equal(await controller.restore("session-1"), true);
  assert.deepEqual(restored, ["workspace-1:session-1"]);
  assert.deepEqual(
    store.deletedConversations.sessions.map(
      (session) => session.agentSessionId
    ),
    ["session-2"]
  );
  assert.equal(store.activeSection, "deletedConversations");
  assert.deepEqual(messages, ["Conversation restored."]);
});

test("a stale page cannot reinsert a restored conversation", async () => {
  let resolvePage:
    | ((
        page: Awaited<
          ReturnType<
            ReturnType<typeof createClient>["listWorkspaceDeletedAgentSessions"]
          >
        >
      ) => void)
    | undefined;
  const pendingPage = new Promise<
    Awaited<
      ReturnType<
        ReturnType<typeof createClient>["listWorkspaceDeletedAgentSessions"]
      >
    >
  >((resolve) => {
    resolvePage = resolve;
  });
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.deletedConversations.sessions = [
    createConversation("session-1", 200),
    createConversation("session-2", 100)
  ];
  store.deletedConversations.hasMore = true;
  store.deletedConversations.nextCursor = "cursor-2";
  store.deletedConversations.totalCount = 2;
  store.deletedConversations.workspaceTotalCount = 2;
  const controller = new WorkspaceDeletedConversationsController({
    client: createClient({
      listWorkspaceDeletedAgentSessions: async () => await pendingPage
    }),
    notifications: createNotifications(),
    store
  });

  const loadMore = controller.loadMore();
  assert.equal(await controller.restore("session-1"), true);
  resolvePage?.({
    hasMore: false,
    projectOptions: [],
    sessions: [createConversation("session-1", 200)],
    totalCount: 2,
    workspaceTotalCount: 2
  });
  await loadMore;

  assert.deepEqual(
    store.deletedConversations.sessions.map(
      (session) => session.agentSessionId
    ),
    ["session-2"]
  );
  assert.equal(store.deletedConversations.loadingMore, false);
});

test("restore reloads a project filter started while the operation is pending", async () => {
  let finishRestore: (() => void) | undefined;
  const restorePending = new Promise<void>((resolve) => {
    finishRestore = resolve;
  });
  let resolveStaleFilterPage:
    | ((page: ReturnType<typeof deletedConversationPage>) => void)
    | undefined;
  const staleFilterPage = new Promise<
    ReturnType<typeof deletedConversationPage>
  >((resolve) => {
    resolveStaleFilterPage = resolve;
  });
  const listRailSectionKeys: Array<string | null> = [];
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.deletedConversations.sessions = [createConversation("session-1", 200)];
  store.deletedConversations.totalCount = 1;
  store.deletedConversations.workspaceTotalCount = 2;
  const controller = new WorkspaceDeletedConversationsController({
    client: createClient({
      async listWorkspaceDeletedAgentSessions(_workspaceID, input) {
        listRailSectionKeys.push(input.railSectionKey);
        if (listRailSectionKeys.length === 1) {
          return await staleFilterPage;
        }
        return deletedConversationPage([createConversation("session-2", 100)]);
      },
      restoreWorkspaceDeletedAgentSession: async () => await restorePending
    }),
    notifications: createNotifications(),
    store
  });

  const restore = controller.restore("session-1");
  controller.selectProject({
    kind: "project",
    railSectionKey: "project:/projects/filtered"
  });
  finishRestore?.();
  assert.equal(await restore, true);

  resolveStaleFilterPage?.(
    deletedConversationPage([createConversation("session-1", 200)])
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(listRailSectionKeys, [
    "project:/projects/filtered",
    "project:/projects/filtered"
  ]);
  assert.deepEqual(
    store.deletedConversations.sessions.map(
      (session) => session.agentSessionId
    ),
    ["session-2"]
  );
  assert.deepEqual(store.deletedConversations.projectFilter, {
    kind: "project",
    railSectionKey: "project:/projects/filtered"
  });
});

test("permanent delete reloads a project filter started while the operation is pending", async () => {
  let finishPurge: (() => void) | undefined;
  const purgePending = new Promise<void>((resolve) => {
    finishPurge = resolve;
  });
  let resolveStaleFilterPage:
    | ((page: ReturnType<typeof deletedConversationPage>) => void)
    | undefined;
  const staleFilterPage = new Promise<
    ReturnType<typeof deletedConversationPage>
  >((resolve) => {
    resolveStaleFilterPage = resolve;
  });
  let listCalls = 0;
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.deletedConversations.sessions = [createConversation("session-1", 200)];
  store.deletedConversations.totalCount = 1;
  store.deletedConversations.workspaceTotalCount = 2;
  const controller = new WorkspaceDeletedConversationsController({
    client: createClient({
      async listWorkspaceDeletedAgentSessions() {
        listCalls += 1;
        if (listCalls === 1) {
          return await staleFilterPage;
        }
        return deletedConversationPage([createConversation("session-2", 100)]);
      },
      purgeWorkspaceDeletedAgentSession: async () => await purgePending
    }),
    notifications: createNotifications(),
    store
  });

  const purge = controller.purgeOne("session-1");
  controller.selectProject({
    kind: "project",
    railSectionKey: "project:/projects/filtered"
  });
  finishPurge?.();
  assert.equal(await purge, true);

  resolveStaleFilterPage?.(
    deletedConversationPage([createConversation("session-1", 200)])
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(listCalls, 2);
  assert.deepEqual(
    store.deletedConversations.sessions.map(
      (session) => session.agentSessionId
    ),
    ["session-2"]
  );
});

test("a restore response from the previous workspace cannot mutate the current workspace", async () => {
  let finishRestore: (() => void) | undefined;
  const restorePending = new Promise<void>((resolve) => {
    finishRestore = resolve;
  });
  const messages: string[] = [];
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-a";
  store.deletedConversations.sessions = [
    createConversation("shared-session", 200)
  ];
  store.deletedConversations.totalCount = 1;
  store.deletedConversations.workspaceTotalCount = 1;
  const controller = new WorkspaceDeletedConversationsController({
    client: createClient({
      restoreWorkspaceDeletedAgentSession: async () => await restorePending
    }),
    notifications: createNotifications(messages),
    store
  });

  const restore = controller.restore("shared-session");
  store.workspaceID = "workspace-b";
  controller.reset();
  store.deletedConversations.sessions = [
    createConversation("shared-session", 100)
  ];
  store.deletedConversations.totalCount = 1;
  store.deletedConversations.workspaceTotalCount = 1;
  finishRestore?.();

  assert.equal(await restore, true);
  assert.deepEqual(
    store.deletedConversations.sessions.map(
      (session) => session.agentSessionId
    ),
    ["shared-session"]
  );
  assert.equal(store.deletedConversations.workspaceTotalCount, 1);
  assert.deepEqual(messages, []);
});

test("delete all ignores filters and resets the empty surface", async () => {
  const messages: string[] = [];
  const purged: string[] = [];
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.deletedConversations.search = "matching title";
  store.deletedConversations.projectFilter = {
    kind: "project",
    railSectionKey: "project:/projects/one"
  };
  store.deletedConversations.sessions = [createConversation("session-1", 100)];
  store.deletedConversations.totalCount = 1;
  store.deletedConversations.workspaceTotalCount = 4;
  const controller = new WorkspaceDeletedConversationsController({
    client: createClient({
      async purgeWorkspaceDeletedAgentSessions(workspaceID) {
        purged.push(workspaceID);
        return { removedSessions: 9 };
      }
    }),
    notifications: createNotifications(messages),
    store
  });

  assert.equal(await controller.purgeAll(), true);
  assert.deepEqual(purged, ["workspace-1"]);
  assert.equal(store.deletedConversations.sessions.length, 0);
  assert.equal(store.deletedConversations.workspaceTotalCount, 0);
  assert.equal(store.deletedConversations.search, "");
  assert.deepEqual(store.deletedConversations.projectFilter, { kind: "all" });
  assert.deepEqual(messages, ["Permanently deleted 4 conversations."]);
});

test("a failed delete all reloads the current filter after fencing an in-flight refresh", async () => {
  let resolveStalePage:
    | ((page: ReturnType<typeof deletedConversationPage>) => void)
    | undefined;
  const stalePage = new Promise<ReturnType<typeof deletedConversationPage>>(
    (resolve) => {
      resolveStalePage = resolve;
    }
  );
  let rejectPurge: ((error: Error) => void) | undefined;
  const purgePending = new Promise<never>((_resolve, reject) => {
    rejectPurge = reject;
  });
  const listInputs: Array<{
    railSectionKey: string | null;
    search: string | null;
  }> = [];
  const messages: string[] = [];
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.deletedConversations.search = "current title";
  store.deletedConversations.projectFilter = {
    kind: "project",
    railSectionKey: "project:/projects/current"
  };
  store.deletedConversations.sessions = [createConversation("session-1", 100)];
  store.deletedConversations.totalCount = 1;
  store.deletedConversations.workspaceTotalCount = 1;
  const controller = new WorkspaceDeletedConversationsController({
    client: createClient({
      async listWorkspaceDeletedAgentSessions(_workspaceID, input) {
        listInputs.push({
          railSectionKey: input.railSectionKey,
          search: input.search
        });
        if (listInputs.length === 1) {
          return await stalePage;
        }
        return deletedConversationPage([
          createConversation("session-current", 200)
        ]);
      },
      purgeWorkspaceDeletedAgentSessions: async () => await purgePending
    }),
    notifications: createNotifications(messages),
    store
  });

  const staleRefresh = controller.refresh();
  const purge = controller.purgeAll();
  rejectPurge?.(new Error("busy"));

  assert.equal(await purge, false);
  resolveStalePage?.(
    deletedConversationPage([createConversation("session-stale", 50)])
  );
  await staleRefresh;

  assert.deepEqual(listInputs, [
    {
      railSectionKey: "project:/projects/current",
      search: "current title"
    },
    {
      railSectionKey: "project:/projects/current",
      search: "current title"
    }
  ]);
  assert.deepEqual(
    store.deletedConversations.sessions.map(
      (session) => session.agentSessionId
    ),
    ["session-current"]
  );
  assert.equal(store.deletedConversations.loadFailed, false);
  assert.deepEqual(messages, [
    "The conversations could not be permanently deleted. Finish active Agent work and try again."
  ]);
});

test("delete all from the previous workspace cannot clear current workspace state", async () => {
  let finishPurge: (() => void) | undefined;
  const purgePending = new Promise<void>((resolve) => {
    finishPurge = resolve;
  });
  const messages: string[] = [];
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-a";
  store.deletedConversations.sessions = [createConversation("session-a", 1)];
  store.deletedConversations.workspaceTotalCount = 1;
  const controller = new WorkspaceDeletedConversationsController({
    client: createClient({
      async purgeWorkspaceDeletedAgentSessions() {
        await purgePending;
        return { removedSessions: 1 };
      }
    }),
    notifications: createNotifications(messages),
    store
  });

  const purge = controller.purgeAll();
  store.workspaceID = "workspace-b";
  controller.reset();
  store.deletedConversations.search = "keep me";
  store.deletedConversations.sessions = [createConversation("session-b", 2)];
  store.deletedConversations.totalCount = 1;
  store.deletedConversations.workspaceTotalCount = 1;
  finishPurge?.();

  assert.equal(await purge, true);
  assert.equal(store.deletedConversations.search, "keep me");
  assert.deepEqual(
    store.deletedConversations.sessions.map(
      (session) => session.agentSessionId
    ),
    ["session-b"]
  );
  assert.equal(store.deletedConversations.workspaceTotalCount, 1);
  assert.deepEqual(messages, []);
});

function createClient(
  overrides: Partial<
    ConstructorParameters<
      typeof WorkspaceDeletedConversationsController
    >[0]["client"]
  >
): ConstructorParameters<
  typeof WorkspaceDeletedConversationsController
>[0]["client"] {
  return {
    listWorkspaceDeletedAgentSessions: async () => ({
      hasMore: false,
      projectOptions: [],
      sessions: [],
      totalCount: 0,
      workspaceTotalCount: 0
    }),
    purgeWorkspaceDeletedAgentSession: async () => {},
    purgeWorkspaceDeletedAgentSessions: async () => ({ removedSessions: 0 }),
    restoreWorkspaceDeletedAgentSession: async () => {},
    ...overrides
  };
}

function createConversation(
  agentSessionId: string,
  updatedAtUnixMs: number
): WorkspaceDeletedConversation {
  return {
    agentSessionId,
    deletedAtUnixMs: 1_000,
    projectAvailable: true,
    projectLabel: "Project",
    projectPath: "/projects/project",
    railSectionKey: "project:/projects/project",
    restorable: true,
    title: agentSessionId,
    unavailableReason: null,
    updatedAtUnixMs
  };
}

function deletedConversationPage(sessions: WorkspaceDeletedConversation[]) {
  return {
    hasMore: false,
    projectOptions: [],
    sessions,
    totalCount: sessions.length,
    workspaceTotalCount: sessions.length
  };
}

function createNotifications(messages: string[] = []): NotificationService {
  return {
    _serviceBrand: undefined,
    error(input) {
      messages.push(input.title);
    },
    info() {},
    notify(input) {
      messages.push(input.title);
    },
    success(input) {
      messages.push(input.title);
    },
    warning(input) {
      messages.push(input.title);
    }
  };
}
