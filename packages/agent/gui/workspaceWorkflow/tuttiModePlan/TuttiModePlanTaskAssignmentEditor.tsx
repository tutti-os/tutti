import { Split } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  cn
} from "@tutti-os/ui-system";
import composerStyles from "../../agent-gui/agentGuiNode/AgentGUINode.styles";
import type { TuttiModePlanAssignmentCatalog } from "./useTuttiModePlanPanels";
import type { TuttiModePlanPanelTaskViewModel } from "./tuttiModePlanPanelProjection";
import {
  effectiveTaskAssignmentValue,
  effectiveTaskParallelizable,
  type TuttiModePlanTaskAssignmentDraft
} from "./tuttiModePlanTaskAssignments";

export interface TuttiModePlanTaskAssignmentEditorLabels {
  agentTarget: string;
  model: string;
  permissionMode: string;
  reasoningEffort: string;
  parallelizable: string;
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
 * Mirrors the composer permission-mode trigger tones so the plan panel's
 * permission controls pick up the same accent/success/warning colors.
 */
export function permissionModeAssignmentTone(
  value: string | null | undefined
): "accent" | "success" | "warning" | undefined {
  switch (value?.trim().toLowerCase().replace(/\s+/g, "-") || undefined) {
    case "read-only":
    case "readonly":
    case "ask-for-approval":
      return "success";
    case "auto":
    case "default":
    case "accept-edits":
    case "acceptedits":
      return "accent";
    case "full-access":
    case "bypasspermissions":
      return "warning";
    default:
      return undefined;
  }
}

/**
 * Per-task assignment selectors for the single review checkpoint, rendered as
 * one composer-styled row. Option catalogs are agent-scoped and supplied by
 * the host; the editor only chooses among them and reports draft edits upward.
 *
 * Model plans are deliberately not exposed here: a plan enters orchestration
 * by configuring an agent target bound to it, so the row offers only agent /
 * model / permission mode / reasoning effort. An explicit model choice clears
 * any document-stamped plan pin so the two can never contradict.
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
  const modelValue = effectiveTaskAssignmentValue(draft.model, task.model);
  const permissionValue = effectiveTaskAssignmentValue(
    draft.permissionModeId,
    task.permissionModeId
  );
  const effortValue = effectiveTaskAssignmentValue(
    draft.reasoningEffort,
    task.reasoningEffort
  );
  const parallelizable = effectiveTaskParallelizable(
    draft.parallelizable,
    task.parallelizable
  );
  // Options for document-referenced agents are preloaded by the panels hook
  // alongside the snapshot refresh; user-driven agent changes trigger the
  // (deduplicated) load from the change handler, so no component effect is
  // needed here.
  const agentDetail = agentValue
    ? (catalog.optionsByAgentId[agentValue] ?? null)
    : null;
  const modelOptions = agentDetail?.models ?? [];
  const detailPending = Boolean(agentValue) && !agentDetail;
  const agentLabel = agentValue
    ? ((catalog.agents ?? []).find(
        (agent) => agent.agentTargetId === agentValue
      )?.label ?? agentValue)
    : null;

  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-0.5 border-t border-border/70 pt-2"
      data-testid={`tutti-plan-task-assignment-${task.id}`}
    >
      <Select
        disabled={disabled}
        value={toSelectValue(agentValue)}
        onValueChange={(value) => {
          const nextAgent = fromSelectValue(value);
          if (nextAgent) catalog.loadAgentOptions(nextAgent);
          onEdit({ agentTargetId: nextAgent });
        }}
      >
        <AssignmentSelectTrigger
          fieldLabel={labels.agentTarget}
          value={agentLabel}
        />
        <AssignmentSelectContent>
          <AssignmentSelectItem value={CLEAR_VALUE}>
            {labels.notSpecified}
          </AssignmentSelectItem>
          {(catalog.agents ?? []).map((agent) => (
            <AssignmentSelectItem
              key={agent.agentTargetId}
              value={agent.agentTargetId}
            >
              {agent.label}
            </AssignmentSelectItem>
          ))}
          {agentValue &&
          !(catalog.agents ?? []).some(
            (agent) => agent.agentTargetId === agentValue
          ) ? (
            <AssignmentSelectItem value={agentValue}>
              {agentValue}
            </AssignmentSelectItem>
          ) : null}
        </AssignmentSelectContent>
      </Select>
      <AssignmentValueSelect
        disabled={disabled || !agentValue || detailPending}
        fieldLabel={labels.model}
        notSpecifiedLabel={labels.notSpecified}
        options={modelOptions.map((model) => ({
          label: model,
          value: model
        }))}
        pending={detailPending}
        pendingLabel={labels.assignmentOptionsLoading}
        value={modelValue}
        onChange={(value) => onEdit({ model: value, modelPlanId: "" })}
      />
      <AssignmentValueSelect
        disabled={disabled || !agentValue || detailPending}
        fieldLabel={labels.permissionMode}
        notSpecifiedLabel={labels.notSpecified}
        options={(agentDetail?.permissionModes ?? []).map((mode) => ({
          label: mode.label,
          value: mode.id
        }))}
        pending={detailPending}
        pendingLabel={labels.assignmentOptionsLoading}
        tone={permissionModeAssignmentTone(permissionValue)}
        value={permissionValue}
        onChange={(value) => onEdit({ permissionModeId: value })}
      />
      <AssignmentValueSelect
        disabled={disabled || !agentValue || detailPending}
        fieldLabel={labels.reasoningEffort}
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
      <button
        type="button"
        disabled={disabled}
        aria-pressed={parallelizable}
        aria-label={labels.parallelizable}
        title={labels.parallelizable}
        data-permission-tone={parallelizable ? "accent" : undefined}
        data-testid={`tutti-plan-task-parallel-toggle-${task.id}`}
        className={cn("w-auto max-w-full", composerStyles.composerMenuTrigger)}
        onClick={() => onEdit({ parallelizable: !parallelizable })}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Split aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{labels.parallelizable}</span>
        </span>
      </button>
    </div>
  );
}

function AssignmentSelectTrigger({
  fieldLabel,
  pending = false,
  pendingLabel,
  tone,
  value
}: {
  fieldLabel: string;
  pending?: boolean;
  pendingLabel?: string;
  tone?: "accent" | "success" | "warning" | undefined;
  value: string | null;
}): React.JSX.Element {
  const placeholder = pending && pendingLabel ? pendingLabel : fieldLabel;
  return (
    <SelectTrigger
      aria-label={fieldLabel}
      title={fieldLabel}
      data-permission-tone={value !== null ? tone : undefined}
      className={cn(
        "w-auto max-w-full",
        composerStyles.composerMenuTrigger,
        pending && "animate-pulse"
      )}
    >
      <span className="flex min-w-0 flex-1 items-center">
        <span
          className={cn(
            "truncate",
            value === null && "text-[var(--agent-gui-text-tertiary)]"
          )}
        >
          {value ?? placeholder}
        </span>
      </span>
    </SelectTrigger>
  );
}

function AssignmentSelectContent({
  children
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SelectContent
      className={cn(
        "nodrag",
        composerStyles.composerMenuContent,
        "min-w-[190px]"
      )}
    >
      {children}
    </SelectContent>
  );
}

function AssignmentSelectItem({
  children,
  value
}: {
  children: React.ReactNode;
  value: string;
}): React.JSX.Element {
  return (
    <SelectItem className={composerStyles.composerMenuItem} value={value}>
      {children}
    </SelectItem>
  );
}

function AssignmentValueSelect({
  disabled,
  fieldLabel,
  notSpecifiedLabel,
  onChange,
  options,
  pending,
  pendingLabel,
  tone,
  value
}: {
  disabled: boolean;
  fieldLabel: string;
  notSpecifiedLabel: string;
  onChange(value: string): void;
  options: readonly { label: string; value: string }[];
  pending: boolean;
  pendingLabel: string;
  tone?: "accent" | "success" | "warning" | undefined;
  value: string;
}): React.JSX.Element {
  const known = options.some((option) => option.value === value);
  const selectedLabel = value
    ? (options.find((option) => option.value === value)?.label ?? value)
    : null;
  return (
    <Select
      disabled={disabled}
      value={toSelectValue(value)}
      onValueChange={(next) => onChange(fromSelectValue(next))}
    >
      <AssignmentSelectTrigger
        fieldLabel={fieldLabel}
        pending={pending}
        pendingLabel={pendingLabel}
        tone={tone}
        value={selectedLabel}
      />
      <AssignmentSelectContent>
        <AssignmentSelectItem value={CLEAR_VALUE}>
          {notSpecifiedLabel}
        </AssignmentSelectItem>
        {options.map((option) => (
          <AssignmentSelectItem key={option.value} value={option.value}>
            {option.label}
          </AssignmentSelectItem>
        ))}
        {value && !known ? (
          <AssignmentSelectItem value={value}>{value}</AssignmentSelectItem>
        ) : null}
      </AssignmentSelectContent>
    </Select>
  );
}
