import {
  Button,
  Checkbox,
  CloseIcon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import type { DesktopI18nKey } from "../../../../../shared/i18n/index.ts";
import type {
  WorkspaceAgentDefinition,
  WorkspaceAutomationRuleDraft,
  WorkspaceAutomationRuleFeedback,
  WorkspaceAutomationRuleTrigger,
  WorkspaceAutomationTargetCatalog,
  WorkspaceAutomationTargetOption
} from "../services/workspaceSettingsTypes";
import {
  workspaceSettingsInputClass,
  workspaceSettingsSelectContentClass,
  workspaceSettingsSelectTriggerClass
} from "./workspaceSettingsFieldStyles";

const NO_SOURCE_VALUE = "__all_sources__";
const NO_TARGET_AGENT_VALUE = "__no_target_agent__";
const DEFAULT_PERMISSION_MODE_VALUE = "__target_default__";

/**
 * The draft may briefly hold a permission mode the rendered catalog does not
 * offer: while a switched target's catalog is still loading (selections are
 * pruned only once the catalog answers) or after a failed catalog load. A
 * Select value without a matching item renders empty trigger text, so the
 * display falls back to the "use the target Agent's default" sentinel until
 * the mode resolves in the ready catalog.
 */
function permissionModeSelectValue(
  permissionModeId: string,
  catalogReady: boolean,
  permissionModes: readonly { readonly id: string }[]
): string {
  if (
    permissionModeId &&
    catalogReady &&
    permissionModes.some((mode) => mode.id === permissionModeId)
  ) {
    return permissionModeId;
  }
  return DEFAULT_PERMISSION_MODE_VALUE;
}
const textareaClass =
  "min-h-[88px] resize-y border-[var(--border-1)] bg-[var(--transparency-block)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] hover:bg-[var(--transparency-hover)] focus-visible:border-[var(--border-focus)] focus-visible:ring-0";
const selectContentStyle = { zIndex: "var(--z-panel-popover)" } as const;

export interface WorkspaceAutomationRuleEditorProps {
  agents: readonly WorkspaceAgentDefinition[];
  draft: Readonly<WorkspaceAutomationRuleDraft>;
  feedback: WorkspaceAutomationRuleFeedback | null;
  saving: boolean;
  targetCatalog: Readonly<WorkspaceAutomationTargetCatalog> | null;
  targetOptions: readonly WorkspaceAutomationTargetOption[];
  onCancel: () => void;
  onRetryTargetCatalog: () => void;
  onSave: () => void;
  onSelectTarget: (targetAgentID: string) => void;
  onUpdate: (patch: Partial<WorkspaceAutomationRuleDraft>) => void;
}

/**
 * Editor for one automation rule. A triggered rule always launches a new
 * session for the selected target Agent with the source session mentioned,
 * so the form is a single target plus permission narrowing — there is no
 * action choice. Permission-mode and tool option catalogs follow the
 * selected target Agent's capability directory.
 */
export function WorkspaceAutomationRuleEditor({
  agents,
  draft,
  feedback,
  saving,
  targetCatalog,
  targetOptions,
  onCancel,
  onRetryTargetCatalog,
  onSave,
  onSelectTarget,
  onUpdate
}: WorkspaceAutomationRuleEditorProps) {
  const { t } = useTranslation();
  // A stored target that no longer resolves stays visible under its raw id
  // so editing never silently retargets the rule.
  const staleTarget =
    draft.targetAgentId &&
    !targetOptions.some((option) => option.id === draft.targetAgentId)
      ? draft.targetAgentId
      : null;
  const catalogReady =
    targetCatalog !== null &&
    !targetCatalog.loading &&
    !targetCatalog.loadFailed &&
    targetCatalog.agentTargetId === draft.targetAgentId;
  const editing = draft.automationRuleId !== null;

  return (
    <section className="flex w-full flex-col gap-4 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {editing
              ? t("workspace.settings.apps.automationRules.editTitle", {
                  rule: draft.name
                })
              : t("workspace.settings.apps.automationRules.addRule")}
          </strong>
          <p className="m-0 mt-1 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.editorDescription")}
          </p>
        </div>
        <Button
          aria-label={t("common.cancel")}
          size="icon"
          type="button"
          variant="ghost"
          onClick={onCancel}
        >
          <CloseIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.nameLabel")}
          </span>
          <Input
            className={workspaceSettingsInputClass}
            placeholder={t(
              "workspace.settings.apps.automationRules.namePlaceholder"
            )}
            type="text"
            value={draft.name}
            onChange={(event) => onUpdate({ name: event.currentTarget.value })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.triggerLabel")}
          </span>
          <Select
            value={draft.trigger}
            onValueChange={(value) =>
              onUpdate({ trigger: value as WorkspaceAutomationRuleTrigger })
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.apps.automationRules.triggerLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={selectContentStyle}
            >
              <SelectItem value="on_task_complete">
                {t(
                  "workspace.settings.apps.automationRules.triggers.onTaskComplete"
                )}
              </SelectItem>
              <SelectItem value="on_task_failed">
                {t(
                  "workspace.settings.apps.automationRules.triggers.onTaskFailed"
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.sourceAgentLabel")}
          </span>
          <Select
            value={draft.sourceWorkspaceAgentId || NO_SOURCE_VALUE}
            onValueChange={(value) =>
              onUpdate({
                sourceWorkspaceAgentId: value === NO_SOURCE_VALUE ? "" : value
              })
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.apps.automationRules.sourceAgentLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={selectContentStyle}
            >
              <SelectItem value={NO_SOURCE_VALUE}>
                {t("workspace.settings.apps.automationRules.allAgents")}
              </SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.targetAgentLabel")}
          </span>
          <Select
            value={draft.targetAgentId || NO_TARGET_AGENT_VALUE}
            onValueChange={(value) => {
              if (value !== NO_TARGET_AGENT_VALUE) {
                onSelectTarget(value);
              }
            }}
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.apps.automationRules.targetAgentLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={selectContentStyle}
            >
              <SelectItem disabled value={NO_TARGET_AGENT_VALUE}>
                {t("workspace.settings.apps.automationRules.chooseTargetAgent")}
              </SelectItem>
              {targetOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
              {staleTarget ? (
                <SelectItem value={staleTarget}>{staleTarget}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.permissionModeLabel")}
          </span>
          <Select
            disabled={
              !catalogReady || targetCatalog.permissionModes.length === 0
            }
            value={permissionModeSelectValue(
              draft.permissionModeId,
              catalogReady,
              targetCatalog?.permissionModes ?? []
            )}
            onValueChange={(value) =>
              onUpdate({
                permissionModeId:
                  value === DEFAULT_PERMISSION_MODE_VALUE ? "" : value
              })
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.apps.automationRules.permissionModeLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={selectContentStyle}
            >
              <SelectItem value={DEFAULT_PERMISSION_MODE_VALUE}>
                {t(
                  "workspace.settings.apps.automationRules.permissionModeDefault"
                )}
              </SelectItem>
              {catalogReady
                ? targetCatalog.permissionModes.map((mode) => (
                    <SelectItem key={mode.id} value={mode.id}>
                      {mode.label}
                    </SelectItem>
                  ))
                : null}
            </SelectContent>
          </Select>
          <TargetCatalogStatus
            targetCatalog={targetCatalog}
            onRetry={onRetryTargetCatalog}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.allowedToolsLabel")}
          </span>
          <AllowedToolsSelection
            catalogReady={catalogReady}
            draft={draft}
            targetCatalog={targetCatalog}
            onUpdate={onUpdate}
          />
          <span className="text-[10px] leading-[1.3] text-[var(--text-tertiary)]">
            {t("workspace.settings.apps.automationRules.allowedToolsHint")}
          </span>
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.automationRules.promptLabel")}
        </span>
        <Textarea
          className={textareaClass}
          placeholder={t(
            "workspace.settings.apps.automationRules.promptPlaceholder"
          )}
          value={draft.prompt}
          onChange={(event) => onUpdate({ prompt: event.currentTarget.value })}
        />
      </label>

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.maxRunsLabel")}
          </span>
          <Input
            className={workspaceSettingsInputClass}
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={draft.maxRunsPerSession}
            onChange={(event) =>
              onUpdate({ maxRunsPerSession: event.currentTarget.value })
            }
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.maxTokensLabel")}
          </span>
          <Input
            className={workspaceSettingsInputClass}
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={draft.maxTotalTokensPerSession}
            onChange={(event) =>
              onUpdate({
                maxTotalTokensPerSession: event.currentTarget.value
              })
            }
          />
        </label>
      </div>
      <p className="m-0 -mt-2 text-[10px] leading-[1.4] text-[var(--text-tertiary)]">
        {t("workspace.settings.apps.automationRules.budgetDescription")}
      </p>

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          <Switch
            aria-label={t(
              "workspace.settings.apps.automationRules.enabledLabel"
            )}
            checked={draft.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          {t("workspace.settings.apps.automationRules.enabledLabel")}
        </label>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={saving} type="button" onClick={onSave}>
            {saving
              ? t("workspace.settings.apps.automationRules.saving")
              : t("workspace.settings.apps.automationRules.save")}
          </Button>
        </div>
      </div>

      {feedback ? (
        <p className="m-0 text-[12px] leading-[1.4] text-[var(--state-danger)]">
          {t(resolveFeedbackKey(feedback))}
        </p>
      ) : null}
    </section>
  );
}

function TargetCatalogStatus({
  targetCatalog,
  onRetry
}: {
  targetCatalog: Readonly<WorkspaceAutomationTargetCatalog> | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (targetCatalog?.loading) {
    return (
      <span className="text-[10px] leading-[1.3] text-[var(--text-tertiary)]">
        {t("workspace.settings.apps.automationRules.targetOptionsLoading")}
      </span>
    );
  }
  if (targetCatalog?.loadFailed) {
    return (
      <span className="flex items-center gap-2 text-[10px] leading-[1.3] text-[var(--state-danger)]">
        {t("workspace.settings.apps.automationRules.targetOptionsLoadFailed")}
        <Button size="sm" type="button" variant="ghost" onClick={onRetry}>
          {t("workspace.settings.apps.automationRules.retry")}
        </Button>
      </span>
    );
  }
  return null;
}

function AllowedToolsSelection({
  catalogReady,
  draft,
  targetCatalog,
  onUpdate
}: {
  catalogReady: boolean;
  draft: Readonly<WorkspaceAutomationRuleDraft>;
  targetCatalog: Readonly<WorkspaceAutomationTargetCatalog> | null;
  onUpdate: (patch: Partial<WorkspaceAutomationRuleDraft>) => void;
}) {
  const { t } = useTranslation();
  if (!catalogReady || !targetCatalog || targetCatalog.tools.length === 0) {
    return (
      <p className="m-0 rounded-[6px] border border-dashed border-[var(--border-1)] px-2.5 py-2 text-[11px] leading-[1.4] text-[var(--text-tertiary)]">
        {t("workspace.settings.apps.automationRules.toolsEmpty")}
      </p>
    );
  }
  const selected = new Set(draft.allowedTools);
  return (
    <div className="flex max-h-[132px] flex-col gap-1 overflow-y-auto rounded-[6px] border border-[var(--border-1)] p-2">
      {targetCatalog.tools.map((tool) => (
        <label
          key={tool.id}
          className="flex items-center gap-2 text-[12px] text-[var(--text-primary)]"
        >
          <Checkbox
            checked={selected.has(tool.id)}
            onCheckedChange={(checked) => {
              const next = new Set(selected);
              if (checked === true) {
                next.add(tool.id);
              } else {
                next.delete(tool.id);
              }
              onUpdate({ allowedTools: [...next] });
            }}
          />
          <span className="min-w-0 truncate">{tool.label}</span>
        </label>
      ))}
    </div>
  );
}

function resolveFeedbackKey(
  feedback: WorkspaceAutomationRuleFeedback
): DesktopI18nKey {
  switch (feedback.kind) {
    case "invalidBudget":
      return "workspace.settings.apps.automationRules.invalidBudget";
    case "requiredFields":
      return "workspace.settings.apps.automationRules.requiredFields";
    default:
      return "workspace.settings.apps.automationRules.saveFailed";
  }
}
