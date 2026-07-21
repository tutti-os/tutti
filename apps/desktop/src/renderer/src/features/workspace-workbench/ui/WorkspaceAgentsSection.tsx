import {
  AddIcon,
  Button,
  DeleteIcon,
  EditIcon,
  StatusDot
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import type {
  WorkspaceAgentDefinition,
  WorkspaceModelPlan,
  WorkspaceSettingsWorkspaceAgentsSnapshotState
} from "../services/workspaceSettingsTypes";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { WorkspaceAgentEditor } from "./WorkspaceAgentEditor";

/**
 * Manages the explicit workspace Agent directory. An Agent is a named,
 * selectable Harness + ModelPlan configuration, not a role binding on a fixed
 * provider entry.
 */
export function WorkspaceAgentsSection() {
  const { t } = useTranslation();
  const { service, state } = useWorkspaceSettingsService();
  const agentsState = state.agents;
  const draft = agentsState.draft;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.apps.agents.title")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.35] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.description")}
          </p>
        </div>
        <Button
          className="shrink-0"
          disabled={
            draft !== null || agentsState.loading || agentsState.loadFailed
          }
          size="sm"
          type="button"
          onClick={() => service.agents.beginDraft()}
        >
          <AddIcon aria-hidden="true" className="size-3.5" />
          {t("workspace.settings.apps.agents.addAgent")}
        </Button>
      </div>

      {agentsState.loadFailed ? (
        <div className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3">
          <p className="m-0 text-[12px] text-[var(--state-danger)]">
            {t("workspace.settings.apps.agents.loadFailed")}
          </p>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              void service.agents.refresh();
            }}
          >
            {t("workspace.settings.apps.agents.retry")}
          </Button>
        </div>
      ) : null}

      {!agentsState.loading &&
      !agentsState.loadFailed &&
      agentsState.agents.length === 0 &&
      draft === null ? (
        <div className="flex flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-[var(--border-1)] bg-[var(--transparency-block)] px-4 py-8 text-center">
          <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
            {t("workspace.settings.apps.agents.emptyTitle")}
          </p>
          <p className="m-0 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.emptyDescription")}
          </p>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-2">
          {agentsState.agents.map((agent) =>
            draft?.agentId === agent.id ? (
              <WorkspaceAgentEditor
                key={agent.id}
                agent={agent}
                capabilityCatalog={agentsState.capabilityCatalog}
                capabilityCatalogLoadFailed={
                  agentsState.capabilityCatalogLoadFailed
                }
                capabilityCatalogLoading={agentsState.capabilityCatalogLoading}
                draft={draft}
                feedback={agentsState.feedback}
                harnessTargets={agentsState.harnessTargets}
                modelPlans={state.modelPlans.plans}
                generating={agentsState.generating}
                recommendingFallback={agentsState.recommendingFallback}
                saving={agentsState.saving}
                onCancel={() => service.agents.cancelDraft()}
                onGenerate={() => {
                  void service.agents.generateDraft();
                }}
                onRefreshCapabilityCatalog={() => {
                  void service.agents.refreshCapabilityCatalog();
                }}
                onRecommendFallback={() => {
                  void service.agents.addRecommendedFallback();
                }}
                onSave={() => {
                  void service.agents.saveDraft();
                }}
                onUpdate={(patch) => service.agents.updateDraft(patch)}
              />
            ) : (
              <WorkspaceAgentRow
                key={agent.id}
                agent={agent}
                agentsState={agentsState}
                modelPlan={
                  state.modelPlans.plans.find(
                    (plan) => plan.id === agent.modelPlanId
                  ) ?? null
                }
              />
            )
          )}
          {draft?.agentId === null ? (
            <WorkspaceAgentEditor
              agent={null}
              capabilityCatalog={agentsState.capabilityCatalog}
              capabilityCatalogLoadFailed={
                agentsState.capabilityCatalogLoadFailed
              }
              capabilityCatalogLoading={agentsState.capabilityCatalogLoading}
              draft={draft}
              feedback={agentsState.feedback}
              harnessTargets={agentsState.harnessTargets}
              modelPlans={state.modelPlans.plans}
              generating={agentsState.generating}
              recommendingFallback={agentsState.recommendingFallback}
              saving={agentsState.saving}
              onCancel={() => service.agents.cancelDraft()}
              onGenerate={() => {
                void service.agents.generateDraft();
              }}
              onRefreshCapabilityCatalog={() => {
                void service.agents.refreshCapabilityCatalog();
              }}
              onRecommendFallback={() => {
                void service.agents.addRecommendedFallback();
              }}
              onSave={() => {
                void service.agents.saveDraft();
              }}
              onUpdate={(patch) => service.agents.updateDraft(patch)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function WorkspaceAgentRow({
  agent,
  agentsState,
  modelPlan
}: {
  agent: WorkspaceAgentDefinition;
  agentsState: WorkspaceSettingsWorkspaceAgentsSnapshotState;
  modelPlan: WorkspaceModelPlan | null;
}) {
  const { t } = useTranslation();
  const { service } = useWorkspaceSettingsService();
  const confirmingDelete = agentsState.confirmingDeleteAgentID === agent.id;
  const deleting = agentsState.deletingAgentID === agent.id;
  const harnessAvailable =
    agent.harness.available && agent.harness.enabled !== false;
  const tone = !harnessAvailable ? "red" : agent.enabled ? "green" : "neutral";
  const statusLabel = !harnessAvailable
    ? t("workspace.settings.apps.agents.harnessUnavailable")
    : agent.enabled
      ? t("workspace.settings.apps.agents.enabled")
      : t("workspace.settings.apps.agents.disabled");

  return (
    <section className="flex w-full flex-col gap-3 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {agent.name}
            </strong>
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--transparency-block)] px-2 py-0.5">
              <StatusDot size="sm" tone={tone} />
              <span className="text-[11px] text-[var(--text-secondary)]">
                {statusLabel}
              </span>
            </span>
            {agent.source === "legacy_binding" ? (
              <span className="text-[10px] text-[var(--text-tertiary)]">
                {t("workspace.settings.apps.agents.migrated")}
              </span>
            ) : null}
          </div>
          {agent.purpose ? (
            <p className="m-0 mt-1 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
              {agent.purpose}
            </p>
          ) : null}
        </div>

        {confirmingDelete ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[12px] text-[var(--text-secondary)]">
              {t("workspace.settings.apps.agents.deleteConfirm")}
            </span>
            <Button
              disabled={deleting}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                void service.agents.confirmDeleteAgent(agent.id);
              }}
            >
              {deleting
                ? t("workspace.settings.apps.agents.deleting")
                : t("workspace.settings.apps.agents.delete")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => service.agents.cancelDeleteAgent()}
            >
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              aria-label={t("workspace.settings.apps.agents.edit")}
              disabled={agentsState.draft !== null}
              size="icon"
              title={t("workspace.settings.apps.agents.edit")}
              type="button"
              variant="ghost"
              onClick={() => service.agents.beginEditAgent(agent.id)}
            >
              <EditIcon aria-hidden="true" size={15} />
            </Button>
            <Button
              aria-label={t("workspace.settings.apps.agents.delete")}
              disabled={agentsState.deletingAgentID !== null}
              size="icon"
              title={t("workspace.settings.apps.agents.delete")}
              type="button"
              variant="ghost"
              onClick={() => service.agents.requestDeleteAgent(agent.id)}
            >
              <DeleteIcon aria-hidden="true" size={15} />
            </Button>
          </div>
        )}
      </div>

      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] max-[640px]:grid-cols-1">
        <WorkspaceAgentMetadata
          label={t("workspace.settings.apps.agents.harnessLabel")}
          value={
            agent.harness.name ||
            agent.harness.provider ||
            agent.harness.agentTargetId
          }
        />
        <WorkspaceAgentMetadata
          label={t("workspace.settings.apps.agents.modelPlanLabel")}
          value={
            modelPlan
              ? `${modelPlan.name}${agent.defaultModel ? ` · ${agent.defaultModel}` : ""}`
              : t("workspace.settings.apps.agents.noModelPlan")
          }
        />
      </dl>

      {agentsState.feedback?.kind === "deleteFailed" && confirmingDelete ? (
        <p className="m-0 text-[12px] text-[var(--state-danger)]">
          {t("workspace.settings.apps.agents.deleteFailed")}
        </p>
      ) : null}
    </section>
  );
}

function WorkspaceAgentMetadata({
  label,
  value
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[var(--text-tertiary)]">{label}</dt>
      <dd className="m-0 mt-0.5 truncate text-[var(--text-secondary)]">
        {value}
      </dd>
    </div>
  );
}
