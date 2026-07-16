import {
  Button,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@tutti-os/ui-system";
import {
  estimatePlanIssueDraftCost,
  type PlanIssueDraft,
  type PlanOrchestrationCatalog
} from "../planImplementationPresentation";
import { PlanIssueBudgetPresetSurface } from "./PlanIssueBudgetPresetSurface";

interface PlanIssueReviewLabels {
  title: string;
  reasoning: string;
  orchestration: string;
  budgetAuto: string;
  budgetFixed: string;
  tokenBudget: string;
  taskPreview: string;
  agentTarget: string;
  modelPlan: string;
  model: string;
  directory: string;
  dependencies: string;
  startOrchestration: string;
  createOnly: string;
  createAndStart: string;
  createAndStartParallel: string;
  estimatedCost: string;
  costUnavailable: string;
  costPartial: string;
  unassigned: string;
}

const UNASSIGNED_VALUE = "__tutti_unassigned__";

export function PlanIssueReviewSurface({
  draft,
  disabled,
  labels,
  onChange,
  onStartOrchestration,
  onCreate,
  assignmentCatalog
}: {
  draft: PlanIssueDraft;
  disabled: boolean;
  labels: PlanIssueReviewLabels;
  onChange: (updater: (current: PlanIssueDraft) => PlanIssueDraft) => void;
  onStartOrchestration: () => void;
  onCreate: (
    startExecution: boolean,
    executionMode?: "sequential" | "parallel"
  ) => void;
  assignmentCatalog?: PlanOrchestrationCatalog;
}) {
  const costEstimate = estimatePlanIssueDraftCost(draft, assignmentCatalog);
  return (
    <div className="grid gap-3 rounded-[10px] border border-[var(--line-2)] p-3 text-left">
      <div className="text-[13px] font-semibold text-[var(--text-primary)]">
        {labels.title}
      </div>
      <PlanIssueBudgetPresetSurface
        disabled={disabled}
        labels={labels}
        preset={{
          executionProfile: draft.executionProfile,
          budget: draft.budget
        }}
        taskCount={draft.tasks.length}
        onChange={(preset) =>
          onChange((current) => ({
            ...current,
            executionProfile: preset.executionProfile,
            budget: preset.budget
          }))
        }
      />
      {draft.stage === "budget" ? (
        <Button
          data-testid="agent-plan-implementation-start-orchestration"
          disabled={disabled}
          size="sm"
          type="button"
          onClick={onStartOrchestration}
        >
          {labels.startOrchestration}
        </Button>
      ) : (
        <>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                {labels.taskPreview}
              </span>
              <span
                className="text-[11px] text-[var(--text-secondary)]"
                data-testid="agent-plan-implementation-cost-estimate"
              >
                {labels.estimatedCost}:{" "}
                {formatCostEstimate(costEstimate, labels)}
              </span>
            </div>
            {draft.tasks.map((task, index) => (
              <div
                className="grid gap-2 rounded-[8px] border border-[var(--line-2)] p-2"
                key={task.sourceId}
              >
                <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                  {index + 1}. {task.title}
                </span>
                <PlanTaskDependencyField
                  disabled={disabled}
                  label={labels.dependencies}
                  task={task}
                  tasks={draft.tasks}
                  onChange={(dependencySourceIds) =>
                    onChange((current) =>
                      updateTask(current, task.sourceId, {
                        dependencySourceIds
                      })
                    )
                  }
                />
                <div className="grid gap-2">
                  <PlanTaskAssignmentFields
                    assignmentCatalog={assignmentCatalog}
                    disabled={disabled}
                    labels={labels}
                    task={task}
                    onChange={(update) =>
                      onChange((current) =>
                        updateTask(current, task.sourceId, update)
                      )
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="agent-plan-implementation-create-issue"
              disabled={disabled}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => onCreate(false)}
            >
              {labels.createOnly}
            </Button>
            <Button
              data-testid="agent-plan-implementation-create-and-start"
              disabled={disabled}
              size="sm"
              type="button"
              onClick={() => onCreate(true)}
            >
              {labels.createAndStart}
            </Button>
            <Button
              data-testid="agent-plan-implementation-create-and-start-parallel"
              disabled={disabled}
              size="sm"
              type="button"
              onClick={() => onCreate(true, "parallel")}
            >
              {labels.createAndStartParallel}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function PlanTaskDependencyField({
  disabled,
  label,
  task,
  tasks,
  onChange
}: {
  disabled: boolean;
  label: string;
  task: PlanIssueDraft["tasks"][number];
  tasks: ReadonlyArray<PlanIssueDraft["tasks"][number]>;
  onChange: (dependencySourceIds: string[]) => void;
}) {
  const candidates = tasks.filter(
    (candidate) => candidate.sourceId !== task.sourceId
  );
  return (
    <fieldset className="grid gap-1 text-[11px] text-[var(--text-secondary)]">
      <legend>{label}</legend>
      {candidates.length === 0 ? (
        <span>—</span>
      ) : (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {candidates.map((candidate, index) => {
            const checked = task.dependencySourceIds.includes(
              candidate.sourceId
            );
            return (
              <label
                className="flex min-w-0 items-center gap-1.5"
                key={candidate.sourceId}
              >
                <Checkbox
                  aria-label={`${label}: ${candidate.title}`}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(nextChecked) => {
                    const selected = new Set(task.dependencySourceIds);
                    if (nextChecked === true) {
                      selected.add(candidate.sourceId);
                    } else {
                      selected.delete(candidate.sourceId);
                    }
                    onChange(
                      candidates
                        .filter((option) => selected.has(option.sourceId))
                        .map((option) => option.sourceId)
                    );
                  }}
                />
                <span className="max-w-48 truncate">
                  {index + 1}. {candidate.title}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function PlanTaskAssignmentFields({
  assignmentCatalog,
  disabled,
  labels,
  task,
  onChange
}: {
  assignmentCatalog?: PlanOrchestrationCatalog;
  disabled: boolean;
  labels: PlanIssueReviewLabels;
  task: PlanIssueDraft["tasks"][number];
  onChange: (update: Partial<PlanIssueDraft["tasks"][number]>) => void;
}) {
  const availableAgents =
    assignmentCatalog?.agents.filter((agent) => agent.available) ?? [];
  const selectedAgent = availableAgents.find(
    (agent) => agent.agentTargetId === task.agentTargetId
  );
  const compatiblePlans =
    assignmentCatalog?.modelPlans.filter(
      (plan) =>
        plan.available &&
        (!selectedAgent?.modelPlanProtocol ||
          plan.protocol === selectedAgent.modelPlanProtocol)
    ) ?? [];
  const selectedPlan = compatiblePlans.find(
    (plan) => plan.id === task.modelPlanId
  );
  const selectedModelIsValid = selectedPlan?.models.some(
    (model) => model.id === task.model
  );

  return (
    <>
      <PlanTaskSelectField
        disabled={disabled || availableAgents.length === 0}
        label={labels.agentTarget}
        unassigned={labels.unassigned}
        value={task.agentTargetId}
        options={availableAgents.map((agent) => ({
          label: agent.name,
          value: agent.agentTargetId
        }))}
        onChange={(agentTargetId) => {
          const agent = availableAgents.find(
            (candidate) => candidate.agentTargetId === agentTargetId
          );
          const currentPlan = assignmentCatalog?.modelPlans.find(
            (plan) => plan.id === task.modelPlanId
          );
          const planRemainsCompatible = Boolean(
            currentPlan?.available &&
            (!agent?.modelPlanProtocol ||
              currentPlan.protocol === agent.modelPlanProtocol)
          );
          onChange({
            agentTargetId,
            ...(!planRemainsCompatible
              ? { modelPlanId: undefined, model: undefined }
              : {})
          });
        }}
      />
      <PlanTaskSelectField
        disabled={disabled || compatiblePlans.length === 0}
        label={labels.modelPlan}
        unassigned={labels.unassigned}
        value={task.modelPlanId}
        options={compatiblePlans.map((plan) => ({
          label: plan.name,
          value: plan.id
        }))}
        onChange={(modelPlanId) => {
          const plan = compatiblePlans.find(
            (candidate) => candidate.id === modelPlanId
          );
          const retainedModel = plan?.models.some(
            (model) => model.id === task.model
          )
            ? task.model
            : plan?.defaultModel;
          onChange({ modelPlanId, model: retainedModel });
        }}
      />
      <PlanTaskSelectField
        disabled={disabled || !selectedPlan}
        label={labels.model}
        unassigned={labels.unassigned}
        value={selectedModelIsValid ? task.model : undefined}
        options={(selectedPlan?.models ?? []).map((model) => ({
          label: model.tier ? `${model.name} · ${model.tier}` : model.name,
          value: model.id
        }))}
        onChange={(model) => onChange({ model })}
      />
    </>
  );
}

function PlanTaskSelectField({
  disabled,
  label,
  options,
  unassigned,
  value,
  onChange
}: {
  disabled: boolean;
  label: string;
  options: Array<{ label: string; value: string }>;
  unassigned: string;
  value?: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label className="grid gap-1 text-[11px] text-[var(--text-secondary)]">
      <span>{label}</span>
      <Select
        disabled={disabled}
        value={value ?? UNASSIGNED_VALUE}
        onValueChange={(nextValue) =>
          onChange(nextValue === UNASSIGNED_VALUE ? undefined : nextValue)
        }
      >
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED_VALUE}>{unassigned}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function updateTask(
  draft: PlanIssueDraft,
  sourceId: string,
  update: Partial<PlanIssueDraft["tasks"][number]>
): PlanIssueDraft {
  return {
    ...draft,
    tasks: draft.tasks.map((task) =>
      task.sourceId === sourceId ? { ...task, ...update } : task
    )
  };
}

function formatCostEstimate(
  estimate: ReturnType<typeof estimatePlanIssueDraftCost>,
  labels: Pick<PlanIssueReviewLabels, "costUnavailable" | "costPartial">
): string {
  if (estimate.amounts.length === 0) return labels.costUnavailable;
  const formatted = estimate.amounts
    .map(({ currency, lowerMicros, upperMicros }) => {
      const formatter = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: 4
      });
      const lower = formatter.format(lowerMicros / 1_000_000);
      const upper = formatter.format(upperMicros / 1_000_000);
      return lowerMicros === upperMicros ? lower : `${lower}–${upper}`;
    })
    .join(" + ");
  return estimate.pricedTaskCount < estimate.taskCount
    ? `${formatted} · ${labels.costPartial}`
    : formatted;
}
