import assert from "node:assert/strict";
import test from "node:test";
import { createIssueManagerFeature } from "../core/index.ts";
import { createIssueManagerControllerService } from "./createIssueManagerControllerService.ts";

test("createIssueManagerControllerService creates sessions with a live store", async () => {
  const service = createIssueManagerControllerService();
  const session = service.createSession({
    feature: createIssueManagerFeature({
      agentRunner: {
        async runTask() {
          return {
            status: "completed" as const
          };
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
          return {
            issues: []
          };
        },
        async listTasks() {
          return {
            tasks: []
          };
        },
        async listTopics() {
          return {
            topics: [
              {
                createdAtUnix: 1,
                isDefault: true,
                lastActivityAtUnix: 1,
                pinnedAtUnix: 0,
                summary: "",
                title: "Default",
                topicId: "topic-1",
                updatedAtUnix: 1,
                workspaceId: "workspace-1"
              }
            ]
          };
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
          return {
            displayName: "Local",
            userId: "local"
          };
        }
      }
    }),
    workspaceId: "workspace-1"
  });

  session.retain();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(session.store.nodeState.selectedAgentTargetId, "local:codex");
  assert.deepEqual(session.getSnapshot().issues.value, []);

  session.release();
});
