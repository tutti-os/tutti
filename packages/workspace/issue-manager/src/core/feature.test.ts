import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { workspaceUserProjectI18nResources } from "@tutti-os/workspace-user-project/i18n";
import {
  createIssueManagerFeature,
  normalizeIssueManagerNodeState
} from "./feature.ts";

describe("normalizeIssueManagerNodeState", () => {
  it("fills defaults and trims selected ids", () => {
    assert.deepEqual(
      normalizeIssueManagerNodeState({
        issueSearchQuery: "  checkout ",
        selectedAgentProvider: "  openclaw ",
        selectedIssueId: " issue-1 ",
        selectedTaskId: "   "
      }),
      {
        activeTopicId: null,
        issueSearchQuery: "checkout",
        issueStatusFilter: "all",
        selectedAgentProvider: "openclaw",
        selectedExecutionDirectory: null,
        selectedIssueId: "issue-1",
        selectedTaskId: null,
        taskListCollapsed: false
      }
    );
  });

  it("normalizes collapsed state to a boolean", () => {
    assert.equal(
      normalizeIssueManagerNodeState({
        issueSearchQuery: "",
        issueStatusFilter: "all",
        selectedAgentProvider: "codex",
        selectedIssueId: null,
        selectedTaskId: null,
        taskListCollapsed: true
      }).taskListCollapsed,
      true
    );

    assert.equal(
      normalizeIssueManagerNodeState({
        issueSearchQuery: "",
        issueStatusFilter: "all",
        selectedAgentProvider: "codex",
        selectedIssueId: null,
        selectedTaskId: null,
        taskListCollapsed: null
      }).taskListCollapsed,
      false
    );
  });
});

describe("createIssueManagerFeature", () => {
  it("keeps invite collaborator visible by default", () => {
    const feature = createIssueManagerFeature(createFeatureInput());

    assert.equal(feature.ui.showInviteCollaborator, true);
  });

  it("scopes workspace user project copy from host locale resources", () => {
    const feature = createIssueManagerFeature({
      ...createFeatureInput(),
      i18n: createI18nRuntime({
        dictionaries: [workspaceUserProjectI18nResources["zh-CN"]]
      })
    });

    assert.equal(
      feature.workspaceUserProjectI18n.tFirst(["projectSelect.addProject"]),
      "添加项目"
    );
  });
});

function createFeatureInput() {
  return {
    agentRunner: {
      async runTask() {
        return { status: "completed" as const };
      }
    },
    backend: {
      async addContextRefs() {
        return [];
      },
      async completeRun() {
        throw new Error("not implemented");
      },
      async createIssue() {
        throw new Error("not implemented");
      },
      async createTopic() {
        throw new Error("not implemented");
      },
      async createRun() {
        throw new Error("not implemented");
      },
      async createTask() {
        throw new Error("not implemented");
      },
      async deleteIssue() {
        return { removed: true };
      },
      async deleteTask() {
        return { removed: true };
      },
      async deleteTopic() {
        return { removed: true };
      },
      async getIssueDetail() {
        throw new Error("not implemented");
      },
      async getTaskDetail() {
        throw new Error("not implemented");
      },
      async listIssues() {
        return { issues: [] };
      },
      async listTasks() {
        return { tasks: [] };
      },
      async listTopics() {
        return { topics: [] };
      },
      async removeContextRef() {
        return { removed: true };
      },
      async updateIssue() {
        throw new Error("not implemented");
      },
      async updateTask() {
        throw new Error("not implemented");
      },
      async updateTopic() {
        throw new Error("not implemented");
      }
    },
    identityAdapter: {
      currentUser() {
        return { userId: "local" };
      }
    }
  };
}
