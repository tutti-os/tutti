import type {
  AgentTarget,
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceAgent,
  WorkspaceWorkflowSnapshot,
  WorkspaceWorkflowTaskAssignment
} from "@tutti-os/client-tuttid-ts";
import type {
  TuttiModePlanAssignmentAgentDetail,
  TuttiModePlanAssignmentAgentOption,
  TuttiModePlanAssignmentOptionsSource,
  TuttiModePlanReviewSnapshot,
  TuttiModePlanReviewRuntime,
  TuttiModePlanTaskAssignmentInput,
  TuttiPlanIssueSnapshot,
  TuttiPlanIssueSource
} from "@tutti-os/agent-gui";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";

export interface DesktopTuttiModePlanReviewRuntimeInput {
  tuttidClient: Pick<
    TuttidClient,
    | "listPendingWorkspaceWorkflows"
    | "decideWorkspaceWorkflowCheckpoint"
    | "listAgentTargets"
    | "listWorkspaceAgents"
    | "getAgentProviderComposerOptions"
    | "listModelPlans"
    | "listWorkspaceIssues"
    | "listWorkspaceIssueTopics"
    | "getWorkspaceIssueDetail"
  >;
  eventStreamClient?: Pick<
    TuttidEventStreamClient,
    "connect" | "subscribe" | "subscribeConnectionState"
  > | null;
  onEventStreamError?: (error: unknown) => void;
}

function toReviewSnapshot(
  snapshot: WorkspaceWorkflowSnapshot
): TuttiModePlanReviewSnapshot {
  const workflow = snapshot.workflow;
  return {
    workflow: {
      id: workflow.id,
      workspaceId: workflow.workspaceId,
      type: workflow.type,
      owner: workflow.owner,
      triggerKind: workflow.triggerKind,
      sourceSessionId: workflow.sourceSessionId,
      sourceTurnId: workflow.sourceTurnId,
      sourceToolCallId: workflow.sourceToolCallId,
      status: workflow.status,
      currentRevisionId: workflow.currentRevisionId
    },
    revisions: snapshot.revisions.map((revision) => ({
      id: revision.id,
      workflowId: revision.workflowId,
      sequence: revision.sequence,
      schemaVersion: revision.schemaVersion,
      documentPath: revision.documentPath,
      sha256: revision.sha256,
      producedByTurnId: revision.producedByTurnId,
      createdAtUnixMs: revision.createdAtUnixMs,
      document: {
        schema: revision.document.schema,
        phase: revision.document.phase,
        title: revision.document.title,
        topicId: revision.document.topicId,
        markdownBody: revision.document.markdownBody,
        execution: { ...revision.document.execution },
        budget: { ...revision.document.budget },
        tasks: revision.document.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          content: task.content,
          priority: task.priority,
          agentTargetId: task.agentTargetId,
          modelPlanId: task.modelPlanId,
          model: task.model,
          permissionModeId: task.permissionModeId,
          reasoningEffort: task.reasoningEffort,
          executionDirectory: task.executionDirectory,
          dependsOn: [...task.dependsOn],
          parallelizable: task.parallelizable
        }))
      }
    })),
    checkpoints: snapshot.checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      workflowId: checkpoint.workflowId,
      kind: checkpoint.kind,
      revisionId: checkpoint.revisionId,
      status: checkpoint.status,
      decidedBy: checkpoint.decidedBy,
      decisionReason: checkpoint.decisionReason,
      createdAtUnixMs: checkpoint.createdAtUnixMs,
      updatedAtUnixMs: checkpoint.updatedAtUnixMs,
      decidedAtUnixMs: checkpoint.decidedAtUnixMs
    }))
  };
}

function toTaskAssignmentRequest(
  assignments: readonly TuttiModePlanTaskAssignmentInput[] | undefined
): WorkspaceWorkflowTaskAssignment[] | undefined {
  if (!assignments || assignments.length === 0) return undefined;
  return assignments.map((assignment) => ({
    taskId: assignment.taskId,
    // undefined stays omitted so the daemon keeps the plan document value;
    // empty strings are explicit clears and must survive serialization.
    ...(assignment.agentTargetId !== undefined &&
    assignment.agentTargetId !== null
      ? { agentTargetId: assignment.agentTargetId }
      : {}),
    ...(assignment.modelPlanId !== undefined && assignment.modelPlanId !== null
      ? { modelPlanId: assignment.modelPlanId }
      : {}),
    ...(assignment.model !== undefined && assignment.model !== null
      ? { model: assignment.model }
      : {}),
    ...(assignment.permissionModeId !== undefined &&
    assignment.permissionModeId !== null
      ? { permissionModeId: assignment.permissionModeId }
      : {}),
    ...(assignment.reasoningEffort !== undefined &&
    assignment.reasoningEffort !== null
      ? { reasoningEffort: assignment.reasoningEffort }
      : {}),
    ...(assignment.parallelizable !== undefined &&
    assignment.parallelizable !== null
      ? { parallelizable: assignment.parallelizable }
      : {})
  }));
}

interface AssignmentAgentDirectoryEntry {
  agentTargetId: string;
  label: string;
  provider: string;
}

function workspaceAgentIsSelectable(agent: WorkspaceAgent): boolean {
  return (
    agent.harness.available &&
    agent.harness.enabled !== false &&
    Boolean(agent.harness.provider)
  );
}

function createAssignmentOptionsSource(
  tuttidClient: DesktopTuttiModePlanReviewRuntimeInput["tuttidClient"]
): TuttiModePlanAssignmentOptionsSource {
  // Cache per workspace; a failed load clears itself so the next panel
  // refresh can retry instead of pinning an empty directory.
  const directoryPromises = new Map<
    string,
    Promise<readonly AssignmentAgentDirectoryEntry[]>
  >();
  const loadDirectory = (
    workspaceId: string
  ): Promise<readonly AssignmentAgentDirectoryEntry[]> => {
    const cached = directoryPromises.get(workspaceId);
    if (cached) return cached;
    // Built-in Harness targets and workspace Agents coexist in the assignment
    // directory, mirroring the AgentGUI rail: built-ins keep their placement
    // and workspace Agents are appended, deduped by agentTargetId.
    const request = Promise.all([
      tuttidClient.listAgentTargets(),
      tuttidClient.listWorkspaceAgents(workspaceId)
    ])
      .then(([targetResponse, workspaceAgentResponse]) => {
        const entries: AssignmentAgentDirectoryEntry[] = [];
        const seen = new Set<string>();
        for (const target of targetResponse.targets) {
          if (!target.enabled || seen.has(target.id)) continue;
          seen.add(target.id);
          entries.push({
            agentTargetId: target.id,
            label: target.name,
            provider: target.provider
          });
        }
        for (const agent of workspaceAgentResponse.agents) {
          if (!workspaceAgentIsSelectable(agent) || seen.has(agent.id)) {
            continue;
          }
          seen.add(agent.id);
          entries.push({
            agentTargetId: agent.id,
            label: agent.name,
            provider: agent.harness.provider ?? ""
          });
        }
        return entries;
      })
      .catch((error: unknown) => {
        directoryPromises.delete(workspaceId);
        throw error;
      });
    directoryPromises.set(workspaceId, request);
    return request;
  };

  return {
    async listAgents({
      workspaceId
    }): Promise<readonly TuttiModePlanAssignmentAgentOption[]> {
      const entries = await loadDirectory(workspaceId);
      return entries.map((entry) => ({
        agentTargetId: entry.agentTargetId,
        label: entry.label
      }));
    },

    async loadAgentOptions({
      workspaceId,
      agentTargetId
    }): Promise<TuttiModePlanAssignmentAgentDetail> {
      const entries = await loadDirectory(workspaceId);
      const entry = entries.find(
        (candidate) => candidate.agentTargetId === agentTargetId
      );
      if (!entry || !entry.provider) {
        return {
          models: [],
          modelPlans: [],
          permissionModes: [],
          reasoningEfforts: []
        };
      }
      const [composerOptions, plans] = await Promise.all([
        tuttidClient.getAgentProviderComposerOptions(
          entry.provider as AgentTarget["provider"],
          { agentTargetId }
        ),
        tuttidClient.listModelPlans(workspaceId).catch(() => null)
      ]);
      const planProtocol =
        resolveAgentGUIProviderCatalogIdentity(entry.provider)
          ?.modelPlanProtocol || null;
      const compatiblePlans = (plans?.plans ?? []).filter(
        (plan) =>
          plan.enabled &&
          (plan.status === "ready" || plan.status === "pending_first_use") &&
          planProtocol !== null &&
          plan.protocol === planProtocol
      );
      return {
        models: composerOptions.modelConfig.options.map(
          (option) => option.value
        ),
        modelPlans: compatiblePlans.map((plan) => ({
          modelPlanId: plan.id,
          label: plan.name,
          models: plan.models.map((model) => model.id)
        })),
        permissionModes: composerOptions.permissionConfig.modes.map((mode) => ({
          id: mode.id,
          label: mode.label
        })),
        reasoningEfforts: composerOptions.reasoningConfig.options.map(
          (option) => option.value
        )
      };
    }
  };
}

/**
 * Desktop transport adapter for Tutti-owned workspace workflows. Workflow
 * rules and state transitions remain authoritative in tuttid.
 */
export function createDesktopTuttiModePlanReviewRuntime(
  input: DesktopTuttiModePlanReviewRuntimeInput
): TuttiModePlanReviewRuntime {
  let connectionStarted = false;

  return {
    async listPending({ workspaceId, sourceSessionId }) {
      const snapshots = await input.tuttidClient.listPendingWorkspaceWorkflows(
        workspaceId,
        sourceSessionId
      );
      return snapshots.map(toReviewSnapshot);
    },

    async decide(decision) {
      await input.tuttidClient.decideWorkspaceWorkflowCheckpoint(
        decision.workspaceId,
        decision.workflowId,
        decision.checkpointId,
        {
          decision: decision.decision,
          decidedBy: decision.decidedBy,
          reason: decision.reason,
          taskAssignments: toTaskAssignmentRequest(decision.taskAssignments)
        }
      );
    },

    subscribe(workspaceId, listener) {
      const eventStreamClient = input.eventStreamClient;
      if (!eventStreamClient) return () => undefined;

      const unsubscribe = eventStreamClient.subscribe(
        "workspace.workflow.updated",
        (event) => {
          if (event.scope?.workspaceId !== workspaceId) return;
          listener({ kind: "workflow_updated", workspaceId, ...event.payload });
        },
        { scope: { workspaceId } }
      );
      const unsubscribeConnection = eventStreamClient.subscribeConnectionState(
        (state) => {
          if (state === "connected") {
            listener({ kind: "connection_restored", workspaceId });
          }
        }
      );

      if (!connectionStarted) {
        connectionStarted = true;
        void eventStreamClient.connect().catch((error: unknown) => {
          input.onEventStreamError?.(error);
        });
      }

      return () => {
        unsubscribe();
        unsubscribeConnection();
      };
    },

    assignmentOptions: createAssignmentOptionsSource(input.tuttidClient),
    planIssues: createPlanIssueSource(input)
  };
}

// Read-only source for the conversation's embedded plan-issue panel: resolve
// "the tutti-mode-plan Issue this session produced" from the issue list and
// relay live issue updates. Mutations stay in the Issue Manager.
function createPlanIssueSource(
  input: DesktopTuttiModePlanReviewRuntimeInput
): TuttiPlanIssueSource {
  return {
    async getSessionPlanIssue({
      workspaceId,
      sourceSessionId
    }): Promise<TuttiPlanIssueSnapshot | null> {
      // Issue listing is topic-scoped; sweep every topic for the newest
      // tutti-mode-plan Issue this session produced.
      const topics =
        await input.tuttidClient.listWorkspaceIssueTopics(workspaceId);
      const candidates = (
        await Promise.all(
          topics.topics.map(async (topic) => {
            const list = await input.tuttidClient.listWorkspaceIssues(
              workspaceId,
              { pageSize: 100, topicId: topic.topicId }
            );
            return list.issues;
          })
        )
      ).flat();
      const match = candidates
        .filter(
          (issue) =>
            issue.planningSource === "tutti_mode_plan" &&
            issue.sourceSessionId === sourceSessionId
        )
        .sort((left, right) => right.updatedAtUnix - left.updatedAtUnix)[0];
      if (!match) return null;
      const detail = await input.tuttidClient.getWorkspaceIssueDetail(
        workspaceId,
        match.issueId
      );
      return {
        issueId: detail.issue.issueId,
        topicId: detail.issue.topicId,
        title: detail.issue.title,
        tasks: detail.tasks.map((task) => ({
          taskId: task.taskId,
          title: task.title,
          content: task.content,
          status: task.status,
          sortIndex: task.sortIndex,
          parallelizable: task.parallelizable === true,
          dependencyTaskIds: [...task.dependencyTaskIds]
        }))
      };
    },
    subscribeIssueUpdates(workspaceId, listener) {
      const eventStreamClient = input.eventStreamClient;
      if (!eventStreamClient) return () => undefined;
      return eventStreamClient.subscribe(
        "workspace.issue.updated",
        (event) => {
          listener({ issueId: event.payload.issueId });
        },
        { scope: { workspaceId } }
      );
    }
  };
}
