import { Button, Checkbox } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import type {
  WorkspaceAgentCapabilityOption,
  WorkspaceAgentDraft
} from "../services/workspaceSettingsTypes";
import {
  createWorkspaceAgentCapabilitySelectionPatch,
  workspaceAgentCapabilityIsSelected,
  workspaceAgentSelectableCapabilityOptions
} from "./workspaceAgentCapabilities";

export function WorkspaceAgentCapabilitySelection({
  catalog,
  draft,
  loadFailed,
  loading,
  onRefresh,
  onUpdate
}: {
  catalog: readonly WorkspaceAgentCapabilityOption[];
  draft: Readonly<WorkspaceAgentDraft>;
  loadFailed: boolean;
  loading: boolean;
  onRefresh: () => void;
  onUpdate: (patch: Partial<WorkspaceAgentDraft>) => void;
}) {
  const { t } = useTranslation();
  const options = workspaceAgentSelectableCapabilityOptions(catalog);
  const groups = [
    {
      id: "skills",
      label: t("workspace.settings.apps.agents.capabilityGroups.skills"),
      options: options.filter((option) => option.kind === "skill")
    },
    {
      id: "plugins",
      label: t("workspace.settings.apps.agents.capabilityGroups.plugins"),
      options: options.filter((option) => option.kind === "plugin")
    },
    {
      id: "connectors",
      label: t("workspace.settings.apps.agents.capabilityGroups.connectors"),
      options: options.filter(
        (option) =>
          option.kind === "connector" ||
          option.kind === "mcpServer" ||
          option.kind === "mcpTool"
      )
    }
  ].filter((group) => group.options.length > 0);

  return (
    <section className="grid gap-3 rounded-[8px] border border-[var(--border-1)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.capabilitiesTitle")}
          </div>
          <p className="m-0 mt-1 text-[10px] leading-[1.35] text-[var(--text-tertiary)]">
            {t(
              draft.capabilitiesExplicit
                ? "workspace.settings.apps.agents.capabilitiesExplicitDescription"
                : "workspace.settings.apps.agents.capabilitiesAutomaticDescription"
            )}
          </p>
        </div>
        {draft.capabilitiesExplicit ? (
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() =>
              onUpdate({
                capabilitiesExplicit: false,
                skills: "",
                tools: ""
              })
            }
          >
            {t("workspace.settings.apps.agents.restoreAutomaticCapabilities")}
          </Button>
        ) : null}
      </div>

      {loading ? (
        <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
          {t("workspace.settings.apps.agents.capabilitiesLoading")}
        </p>
      ) : null}
      {loadFailed ? (
        <div className="flex items-center justify-between gap-3">
          <p className="m-0 text-[11px] text-[var(--state-danger)]">
            {t("workspace.settings.apps.agents.capabilitiesLoadFailed")}
          </p>
          <Button size="sm" type="button" variant="ghost" onClick={onRefresh}>
            {t("workspace.settings.apps.agents.retry")}
          </Button>
        </div>
      ) : null}
      {!loading && !loadFailed && groups.length === 0 ? (
        <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
          {t("workspace.settings.apps.agents.noCompatibleCapabilities")}
        </p>
      ) : null}

      {groups.map((group) => (
        <section className="grid gap-2" key={group.id}>
          <div className="text-[10px] font-medium uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
            {group.label}
          </div>
          <div className="grid grid-cols-2 gap-2 max-[760px]:grid-cols-1">
            {group.options.map((option) => {
              const checked = workspaceAgentCapabilityIsSelected(draft, option);
              return (
                <div
                  className="rounded-[7px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-2.5"
                  key={option.id}
                >
                  <label className="flex cursor-pointer items-start gap-2">
                    <Checkbox
                      aria-label={option.label}
                      checked={checked}
                      disabled={option.status === "unsupported"}
                      onCheckedChange={(nextChecked) =>
                        onUpdate(
                          createWorkspaceAgentCapabilitySelectionPatch(
                            draft,
                            options,
                            option.id,
                            nextChecked === true
                          )
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <strong className="text-[11px] font-medium text-[var(--text-primary)]">
                          {option.label}
                        </strong>
                        <span className="text-[9px] text-[var(--text-tertiary)]">
                          {t(
                            `workspace.settings.apps.agents.capabilityStatuses.${option.status}`
                          )}
                        </span>
                      </span>
                      {option.description ? (
                        <span className="mt-1 block text-[10px] leading-[1.35] text-[var(--text-secondary)]">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                  <details className="mt-1.5 pl-6">
                    <summary className="cursor-pointer text-[9px] text-[var(--text-tertiary)]">
                      {t("workspace.settings.apps.agents.capabilityDetails")}
                    </summary>
                    <div className="mt-1 break-all text-[9px] leading-[1.35] text-[var(--text-tertiary)]">
                      {option.id}
                      {option.trigger ? ` · ${option.trigger}` : ""}
                      {option.path ? ` · ${option.path}` : ""}
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </section>
  );
}
