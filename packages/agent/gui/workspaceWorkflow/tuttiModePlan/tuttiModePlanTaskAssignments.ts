import type { TuttiModePlanTaskAssignmentInput } from "../workspaceWorkflowRuntime";
import type { TuttiModePlanPanelTaskViewModel } from "./tuttiModePlanPanelProjection";

/**
 * One task's in-panel assignment edits. `undefined` means "untouched — keep
 * the plan document value"; an empty string is an explicit clear that the
 * daemon persists as such.
 */
export interface TuttiModePlanTaskAssignmentDraft {
  agentTargetId?: string;
  modelPlanId?: string;
  model?: string;
  permissionModeId?: string;
  reasoningEffort?: string;
  /** Per-task parallel opt-in; undefined keeps the plan document value. */
  parallelizable?: boolean;
  /** Per-task acceptance bypass; undefined keeps the plan document value. */
  autoAccept?: boolean;
}

export type TuttiModePlanTaskAssignmentDrafts = Readonly<
  Record<string, TuttiModePlanTaskAssignmentDraft>
>;

/**
 * Applies one field edit. Changing the Agent invalidates the dependent
 * selections (plan, model, permission mode, reasoning effort) because their
 * option catalogs are agent-scoped; they reset to an explicit clear so an
 * incompatible document value can never ride along silently. The parallel
 * opt-in is agent-independent and survives an agent change.
 */
export function mergeTaskAssignmentDraft(
  drafts: TuttiModePlanTaskAssignmentDrafts,
  taskId: string,
  patch: TuttiModePlanTaskAssignmentDraft
): TuttiModePlanTaskAssignmentDrafts {
  const current = drafts[taskId] ?? {};
  const next: TuttiModePlanTaskAssignmentDraft =
    patch.agentTargetId !== undefined &&
    patch.agentTargetId !== current.agentTargetId
      ? {
          agentTargetId: patch.agentTargetId,
          modelPlanId: "",
          model: "",
          permissionModeId: "",
          reasoningEffort: "",
          ...(current.parallelizable !== undefined
            ? { parallelizable: current.parallelizable }
            : {}),
          ...(current.autoAccept !== undefined
            ? { autoAccept: current.autoAccept }
            : {})
        }
      : { ...current, ...patch };
  return { ...drafts, [taskId]: next };
}

/** The state a boolean toggle (parallel, auto-accept) displays: draft wins. */
export function effectiveTaskFlag(
  draftValue: boolean | undefined,
  documentValue: boolean
): boolean {
  return draftValue ?? documentValue;
}

/** The value a selector should display: draft edit wins over document value. */
export function effectiveTaskAssignmentValue(
  draftValue: string | undefined,
  documentValue: string | null
): string {
  if (draftValue !== undefined) return draftValue;
  return documentValue ?? "";
}

/**
 * Builds the decision payload. Only touched tasks are included, and only
 * touched fields are sent; untouched fields stay null-equivalent (omitted) so
 * the daemon keeps the plan document value.
 */
export function taskAssignmentInputsFromDrafts(
  drafts: TuttiModePlanTaskAssignmentDrafts,
  tasks: readonly TuttiModePlanPanelTaskViewModel[]
): TuttiModePlanTaskAssignmentInput[] {
  const knownTaskIds = new Set(tasks.map((task) => task.id));
  const inputs: TuttiModePlanTaskAssignmentInput[] = [];
  for (const task of tasks) {
    const draft = drafts[task.id];
    if (!draft) continue;
    const input: TuttiModePlanTaskAssignmentInput = { taskId: task.id };
    let touched = false;
    if (draft.agentTargetId !== undefined) {
      input.agentTargetId = draft.agentTargetId;
      touched = true;
    }
    if (draft.modelPlanId !== undefined) {
      input.modelPlanId = draft.modelPlanId;
      touched = true;
    }
    if (draft.model !== undefined) {
      input.model = draft.model;
      touched = true;
    }
    if (draft.permissionModeId !== undefined) {
      input.permissionModeId = draft.permissionModeId;
      touched = true;
    }
    if (draft.reasoningEffort !== undefined) {
      input.reasoningEffort = draft.reasoningEffort;
      touched = true;
    }
    if (draft.parallelizable !== undefined) {
      input.parallelizable = draft.parallelizable;
      touched = true;
    }
    if (draft.autoAccept !== undefined) {
      input.autoAccept = draft.autoAccept;
      touched = true;
    }
    if (touched) inputs.push(input);
  }
  // Drafts for tasks that vanished from the current revision are dropped.
  return inputs.filter((input) => knownTaskIds.has(input.taskId));
}
