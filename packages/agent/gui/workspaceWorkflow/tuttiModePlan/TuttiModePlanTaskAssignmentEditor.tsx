import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@tutti-os/ui-system";
import type { TuttiModePlanAssignmentCatalog } from "./useTuttiModePlanPanels";
import type { TuttiModePlanPanelTaskViewModel } from "./tuttiModePlanPanelProjection";
import {
  effectiveTaskAssignmentValue,
  type TuttiModePlanTaskAssignmentDraft
} from "./tuttiModePlanTaskAssignments";

export interface TuttiModePlanTaskAssignmentEditorLabels {
  agentTarget: string;
  modelPlan: string;
  model: string;
  permissionMode: string;
  reasoningEffort: string;
  notSpecified: string;
  assignmentOptionsLoading: string;
}

const CLEAR_VALUE = "__tutti_plan_assignment_clear__";

function toSelectValue(value: string): string {
  return value === "" ? CLEAR_VALUE : value;
}

function fromSelectValue(value: string): string {
  return value === CLEAR_VALUE ? "" : value;
}

/**
 * Per-task assignment selectors for the single review checkpoint. Option
 * catalogs are agent-scoped and supplied by the host; the editor only chooses
 * among them and reports draft edits upward.
 */
export function TuttiModePlanTaskAssignmentEditor({
  catalog,
  disabled,
  draft,
  labels,
  onEdit,
  task
}: {
  catalog: TuttiModePlanAssignmentCatalog;
  disabled: boolean;
  draft: TuttiModePlanTaskAssignmentDraft;
  labels: TuttiModePlanTaskAssignmentEditorLabels;
  onEdit(patch: TuttiModePlanTaskAssignmentDraft): void;
  task: TuttiModePlanPanelTaskViewModel;
}): React.JSX.Element {
  const agentValue = effectiveTaskAssignmentValue(
    draft.agentTargetId,
    task.agentTargetId
  );
  const planValue = effectiveTaskAssignmentValue(
    draft.modelPlanId,
    task.modelPlanId
  );
  const modelValue = effectiveTaskAssignmentValue(draft.model, task.model);
  const permissionValue = effectiveTaskAssignmentValue(
    draft.permissionModeId,
    task.permissionModeId
  );
  const effortValue = effectiveTaskAssignmentValue(
    draft.reasoningEffort,
    task.reasoningEffort
  );
  // Options for document-referenced agents are preloaded by the panels hook
  // alongside the snapshot refresh; user-driven agent changes trigger the
  // (deduplicated) load from the change handler, so no component effect is
  // needed here.
  const agentDetail = agentValue
    ? (catalog.optionsByAgentId[agentValue] ?? null)
    : null;
  const selectedPlan =
    agentDetail?.modelPlans.find((plan) => plan.modelPlanId === planValue) ??
    null;
  const modelOptions = selectedPlan
    ? selectedPlan.models
    : (agentDetail?.models ?? []);
  const detailPending = Boolean(agentValue) && !agentDetail;

  return (
    <div
      className="mt-3 grid gap-x-4 gap-y-2 border-t border-border/70 pt-3 sm:grid-cols-2"
      data-testid={`tutti-plan-task-assignment-${task.id}`}
    >
      <AssignmentField label={labels.agentTarget}>
        <Select
          disabled={disabled}
          value={toSelectValue(agentValue)}
          onValueChange={(value) => {
            const nextAgent = fromSelectValue(value);
            if (nextAgent) catalog.loadAgentOptions(nextAgent);
            onEdit({ agentTargetId: nextAgent });
          }}
        >
          <SelectTrigger
            aria-label={labels.agentTarget}
            className="h-8 w-full text-xs"
          >
            <SelectValue placeholder={labels.notSpecified} />
          </SelectTrigger>
          <SelectContent className="nodrag">
            <SelectItem value={CLEAR_VALUE}>{labels.notSpecified}</SelectItem>
            {(catalog.agents ?? []).map((agent) => (
              <SelectItem key={agent.agentTargetId} value={agent.agentTargetId}>
                {agent.label}
              </SelectItem>
            ))}
            {agentValue &&
            !(catalog.agents ?? []).some(
              (agent) => agent.agentTargetId === agentValue
            ) ? (
              <SelectItem value={agentValue}>{agentValue}</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </AssignmentField>
      <AssignmentField label={labels.modelPlan}>
        <AssignmentValueSelect
          ariaLabel={labels.modelPlan}
          disabled={disabled || !agentValue || detailPending}
          notSpecifiedLabel={labels.notSpecified}
          options={(agentDetail?.modelPlans ?? []).map((plan) => ({
            label: plan.label,
            value: plan.modelPlanId
          }))}
          pending={detailPending}
          pendingLabel={labels.assignmentOptionsLoading}
          value={planValue}
          onChange={(value) => onEdit({ modelPlanId: value, model: "" })}
        />
      </AssignmentField>
      <AssignmentField label={labels.model}>
        <AssignmentValueSelect
          ariaLabel={labels.model}
          disabled={disabled || !agentValue || detailPending}
          notSpecifiedLabel={labels.notSpecified}
          options={modelOptions.map((model) => ({
            label: model,
            value: model
          }))}
          pending={detailPending}
          pendingLabel={labels.assignmentOptionsLoading}
          value={modelValue}
          onChange={(value) => onEdit({ model: value })}
        />
      </AssignmentField>
      <AssignmentField label={labels.permissionMode}>
        <AssignmentValueSelect
          ariaLabel={labels.permissionMode}
          disabled={disabled || !agentValue || detailPending}
          notSpecifiedLabel={labels.notSpecified}
          options={(agentDetail?.permissionModes ?? []).map((mode) => ({
            label: mode.label,
            value: mode.id
          }))}
          pending={detailPending}
          pendingLabel={labels.assignmentOptionsLoading}
          value={permissionValue}
          onChange={(value) => onEdit({ permissionModeId: value })}
        />
      </AssignmentField>
      <AssignmentField label={labels.reasoningEffort}>
        <AssignmentValueSelect
          ariaLabel={labels.reasoningEffort}
          disabled={disabled || !agentValue || detailPending}
          notSpecifiedLabel={labels.notSpecified}
          options={(agentDetail?.reasoningEfforts ?? []).map((effort) => ({
            label: effort,
            value: effort
          }))}
          pending={detailPending}
          pendingLabel={labels.assignmentOptionsLoading}
          value={effortValue}
          onChange={(value) => onEdit({ reasoningEffort: value })}
        />
      </AssignmentField>
    </div>
  );
}

function AssignmentField({
  children,
  label
}: {
  children: React.ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <div className="grid gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function AssignmentValueSelect({
  ariaLabel,
  disabled,
  notSpecifiedLabel,
  onChange,
  options,
  pending,
  pendingLabel,
  value
}: {
  ariaLabel: string;
  disabled: boolean;
  notSpecifiedLabel: string;
  onChange(value: string): void;
  options: readonly { label: string; value: string }[];
  pending: boolean;
  pendingLabel: string;
  value: string;
}): React.JSX.Element {
  const known = options.some((option) => option.value === value);
  return (
    <Select
      disabled={disabled}
      value={toSelectValue(value)}
      onValueChange={(next) => onChange(fromSelectValue(next))}
    >
      <SelectTrigger aria-label={ariaLabel} className="h-8 w-full text-xs">
        <SelectValue placeholder={pending ? pendingLabel : notSpecifiedLabel} />
      </SelectTrigger>
      <SelectContent className="nodrag">
        <SelectItem value={CLEAR_VALUE}>{notSpecifiedLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
        {value && !known ? (
          <SelectItem value={value}>{value}</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}
