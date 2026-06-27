import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { ReferenceScope } from "@tutti-os/workspace-file-reference/contracts";
import type { ReferenceListItem } from "@tutti-os/workspace-file-reference/core";
import { createIssueReferenceListBackend } from "./issueReferenceListBackend.ts";
import {
  createAppReferenceListBackend,
  listReferenceSupportingApps
} from "./appReferenceListBackend.ts";

const scope: ReferenceScope = { workspaceId: "workspace-1" };

function firstGroupId(items: ReferenceListItem[]): string {
  const first = items[0];
  return first && first.type === "group" ? first.id : "";
}

// 议题 backend:topic → issue 的 group id 编码里带了 topicId,describeHandle 应据此
// 还原出 { source:"task", id: topicId, groupId: issueId }(顶层=topic、子级=issue)。
test("issue backend describeHandle round-trips topic + issue handles", async () => {
  const tuttidClient = {
    listWorkspaceIssueTopics: async () => ({
      topics: [{ topicId: "topic-1", title: "Launch" }]
    }),
    listWorkspaceIssues: async () => ({
      issues: [{ issueId: "issue-9", title: "Fix login" }],
      nextPageToken: null
    }),
    getWorkspaceIssueDetail: async () => ({
      issue: { title: "Fix login" },
      latestOutputs: []
    })
  } as unknown as TuttidClient;
  const backend = createIssueReferenceListBackend(tuttidClient);

  const topics = await backend.list(scope, { parentGroupId: null });
  const topicGroupId = firstGroupId(topics.items);
  const issues = await backend.list(scope, { parentGroupId: topicGroupId });
  const issueGroupId = firstGroupId(issues.items);

  assert.deepEqual(backend.describeHandle?.(topicGroupId), {
    source: "task",
    id: "topic-1"
  });
  assert.deepEqual(backend.describeHandle?.(issueGroupId), {
    source: "task",
    id: "topic-1",
    groupId: "issue-9"
  });
});

// 应用 backend:根层是 app group,describeHandle 还原出 { source:"app", id: appId }。
test("app backend describeHandle resolves the app handle", async () => {
  const tuttidClient = {
    listWorkspaceApps: async () => ({
      apps: [
        {
          appId: "app-7",
          displayName: "Design",
          installed: true,
          enabled: true,
          references: { listSupported: true, searchSupported: false }
        }
      ]
    })
  } as unknown as TuttidClient;
  const backend = createAppReferenceListBackend(tuttidClient);

  const apps = await backend.list(scope, { parentGroupId: null });
  const appGroupId = firstGroupId(apps.items);

  assert.deepEqual(backend.describeHandle?.(appGroupId), {
    source: "app",
    id: "app-7"
  });
});

test("app backend labels child groups with app and project names", async () => {
  const tuttidClient = {
    listWorkspaceApps: async () => ({
      apps: [
        {
          appId: "vibe-design",
          displayName: "Prototype Design",
          installed: true,
          enabled: true,
          references: { listSupported: true, searchSupported: false }
        }
      ]
    }),
    listWorkspaceAppReferences: async () => ({
      items: [
        {
          type: "group",
          id: "project-23232",
          displayName: "23232",
          referenceCount: 0
        }
      ],
      nextCursor: null
    })
  } as unknown as TuttidClient;
  const backend = createAppReferenceListBackend(tuttidClient);

  const result = await backend.list(scope, {
    parentGroupId: "app:vibe-design",
    cursor: null,
    filter: null
  });
  const childGroup = result.items[0];

  assert.equal(childGroup?.type, "group");
  assert.equal(
    childGroup && "parentLabel" in childGroup
      ? childGroup.parentLabel
      : undefined,
    "Prototype Design / 23232"
  );
});

test("app backend search includes matching app project groups", async () => {
  const calls: Array<{ endpoint: "list" | "search"; filterText?: string }> = [];
  const tuttidClient = {
    listWorkspaceApps: async () => ({
      apps: [
        {
          appId: "ai-media-canvas",
          displayName: "AI Canvas",
          installed: true,
          enabled: true,
          references: { listSupported: true, searchSupported: true }
        }
      ]
    }),
    listWorkspaceAppReferences: async (
      _workspaceId: string,
      _appId: string,
      input: { filterText?: string | null }
    ) => {
      calls.push({
        endpoint: "list",
        filterText: input.filterText ?? undefined
      });
      return {
        items: [
          {
            type: "group",
            id: "project-1",
            displayName: "My First Project",
            referenceCount: 0
          }
        ],
        nextCursor: null
      };
    },
    searchWorkspaceAppReferences: async () => {
      calls.push({ endpoint: "search" });
      return {
        items: [
          {
            type: "reference",
            reference: {
              kind: "file",
              displayName: "cover.png",
              path: "project-assets/cover.png",
              parentGroupLabel: "My First Project"
            }
          }
        ],
        nextCursor: null
      };
    }
  } as unknown as TuttidClient;
  const backend = createAppReferenceListBackend(tuttidClient);

  const result = await backend.search?.(scope, {
    query: "My First Project",
    limit: 20
  });

  assert.equal(result?.items[0]?.type, "group");
  assert.deepEqual(
    result?.items.map((item) => item.type),
    ["group", "reference"]
  );
  assert.equal(
    result?.items[0] && "parentLabel" in result.items[0]
      ? result.items[0].parentLabel
      : undefined,
    "AI Canvas / My First Project"
  );
  assert.deepEqual(calls, [
    { endpoint: "list", filterText: "My First Project" },
    { endpoint: "search" }
  ]);
});

test("app reference app discovery caches repeated workspace app listing", async () => {
  let listCalls = 0;
  const tuttidClient = {
    listWorkspaceApps: async () => {
      listCalls += 1;
      return {
        apps: [
          {
            appId: "ready-app",
            displayName: "Ready",
            installed: true,
            enabled: true,
            references: { listSupported: true, searchSupported: false }
          },
          {
            appId: "disabled-app",
            displayName: "Disabled",
            installed: true,
            enabled: false,
            references: { listSupported: true, searchSupported: false }
          }
        ]
      };
    }
  } as unknown as TuttidClient;

  const first = await listReferenceSupportingApps(tuttidClient, scope);
  const second = await listReferenceSupportingApps(tuttidClient, scope);

  assert.equal(listCalls, 1);
  assert.deepEqual(
    first.map((app) => app.appId),
    ["ready-app"]
  );
  assert.deepEqual(
    second.map((app) => app.appId),
    ["ready-app"]
  );
});

// 点击 chip 一键定位:locate 产出的「分组 id 路径」叶子,经 describeHandle 反解应回到原句柄。
test("app locate to a group round-trips via describeHandle", async () => {
  const backend = createAppReferenceListBackend({} as unknown as TuttidClient);
  const path = await backend.locate?.(scope, {
    appId: "app-7",
    groupId: "g-9"
  });
  assert.equal((path ?? []).length, 2); // [app 根, app 子分组]
  const leaf = path?.[path.length - 1] ?? "";
  assert.deepEqual(backend.describeHandle?.(leaf), {
    source: "app",
    id: "app-7",
    groupId: "g-9"
  });
});

test("issue locate to an issue round-trips topic + issue via describeHandle", async () => {
  const backend = createIssueReferenceListBackend(
    {} as unknown as TuttidClient
  );
  const path = await backend.locate?.(scope, {
    issueId: "issue-9",
    topicId: "topic-1"
  });
  assert.equal((path ?? []).length, 2); // [topic, issue]
  const leaf = path?.[path.length - 1] ?? "";
  assert.deepEqual(backend.describeHandle?.(leaf), {
    source: "task",
    id: "topic-1",
    groupId: "issue-9"
  });
});

test("issue locate to a whole topic resolves to the topic group", async () => {
  const backend = createIssueReferenceListBackend(
    {} as unknown as TuttidClient
  );
  const path = await backend.locate?.(scope, { topicId: "topic-1" });
  assert.equal((path ?? []).length, 1);
  assert.deepEqual(backend.describeHandle?.(path?.[0] ?? ""), {
    source: "task",
    id: "topic-1"
  });
});
