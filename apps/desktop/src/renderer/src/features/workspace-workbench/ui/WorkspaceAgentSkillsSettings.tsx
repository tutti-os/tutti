import { useEffect, useState } from "react";
import { useService } from "@tutti-os/infra/di";
import type {
  AgentActivityComposerOptions,
  AgentActivityComposerSkillOption
} from "@tutti-os/agent-activity-core";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import { useTranslation } from "@renderer/i18n";
import { resolveWorkspaceAgentGuiLabel } from "../services/workspaceAgentProviderCatalog";

const workspaceAgentSkillsProviders = ["codex", "claude-code"] as const;

type WorkspaceAgentSkillsProvider =
  (typeof workspaceAgentSkillsProviders)[number];

type WorkspaceAgentSkillsGroupState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "loaded";
      skills: readonly AgentActivityComposerSkillOption[];
    };

type WorkspaceAgentSkillsGroupsState = Record<
  WorkspaceAgentSkillsProvider,
  WorkspaceAgentSkillsGroupState
>;

function initialWorkspaceAgentSkillsGroupsState(): WorkspaceAgentSkillsGroupsState {
  return {
    codex: { status: "loading" },
    "claude-code": { status: "loading" }
  };
}

function composerSkillsFromOptions(
  value: unknown
): readonly AgentActivityComposerSkillOption[] {
  const skills = (value as Partial<AgentActivityComposerOptions> | null)
    ?.skills;
  return Array.isArray(skills) ? skills : [];
}

export function WorkspaceAgentSkillsSettings({
  workspaceId
}: {
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const agentActivityService = useService(IWorkspaceAgentActivityService);
  const [groups, setGroups] = useState<WorkspaceAgentSkillsGroupsState>(
    initialWorkspaceAgentSkillsGroupsState
  );

  useEffect(() => {
    let cancelled = false;
    setGroups(initialWorkspaceAgentSkillsGroupsState());
    for (const provider of workspaceAgentSkillsProviders) {
      void agentActivityService
        .getComposerOptions({ provider, workspaceId })
        .then((options) => {
          if (cancelled) {
            return;
          }
          setGroups((previous) => ({
            ...previous,
            [provider]: {
              status: "loaded",
              skills: composerSkillsFromOptions(options)
            }
          }));
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          setGroups((previous) => ({
            ...previous,
            [provider]: { status: "error" }
          }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [agentActivityService, workspaceId]);

  return (
    <div className="flex w-full flex-col gap-8 pb-[22px] pt-5">
      <div className="flex w-full flex-col gap-2">
        <strong className="text-[14px] font-semibold text-[var(--text-primary)]">
          {t("workspace.settings.agent.skills.title")}
        </strong>
        <p className="m-0 text-[13px] leading-[1.35] text-[var(--text-secondary)]">
          {t("workspace.settings.agent.skills.projectScopeNote")}
        </p>
      </div>

      {workspaceAgentSkillsProviders.map((provider) => (
        <WorkspaceAgentSkillsProviderGroup
          key={provider}
          group={groups[provider]}
          provider={provider}
        />
      ))}
    </div>
  );
}

function WorkspaceAgentSkillsProviderGroup({
  group,
  provider
}: {
  group: WorkspaceAgentSkillsGroupState;
  provider: WorkspaceAgentSkillsProvider;
}) {
  const { t } = useTranslation();

  return (
    <section className="flex w-full flex-col gap-3">
      <strong className="text-[14px] font-semibold text-[var(--text-primary)]">
        {resolveWorkspaceAgentGuiLabel(provider)}
      </strong>
      {group.status === "loading" ? (
        <p className="m-0 text-[13px] leading-[1.35] text-[var(--text-secondary)]">
          {t("common.loading")}
        </p>
      ) : group.status === "error" ? (
        <p className="m-0 text-[13px] leading-[1.35] text-[var(--state-danger)]">
          {t("workspace.settings.agent.skills.loadFailed")}
        </p>
      ) : group.skills.length === 0 ? (
        <p className="m-0 text-[13px] leading-[1.35] text-[var(--text-secondary)]">
          {t("workspace.settings.agent.skills.empty")}
        </p>
      ) : (
        <ul className="m-0 flex w-full list-none flex-col gap-2 p-0">
          {group.skills.map((skill) => (
            <WorkspaceAgentSkillRow key={skill.trigger} skill={skill} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkspaceAgentSkillRow({
  skill
}: {
  skill: AgentActivityComposerSkillOption;
}) {
  const { t } = useTranslation();
  const sourceKindLabel = resolveWorkspaceAgentSkillSourceKindLabel(
    t,
    skill.sourceKind
  );
  const badgeLabel =
    skill.sourceKind === "plugin" && skill.pluginName
      ? `${sourceKindLabel} · ${skill.pluginName}`
      : sourceKindLabel;

  return (
    <li className="flex w-full min-w-0 items-center gap-2 rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] px-3 py-2">
      <code className="shrink-0 font-mono text-[12px] text-[var(--text-primary)]">
        {skill.trigger}
      </code>
      <span className="shrink-0 text-[13px] font-medium text-[var(--text-primary)]">
        {skill.name}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">
        {skill.description ?? ""}
      </span>
      <span
        aria-label={t("workspace.settings.agent.skills.sourceLabel")}
        className="inline-flex shrink-0 items-center rounded-full border border-[var(--border-1)] bg-[var(--transparency-block)] px-2 py-0.5 text-[11px] leading-[1.4] text-[var(--text-secondary)]"
      >
        {badgeLabel}
      </span>
    </li>
  );
}

function resolveWorkspaceAgentSkillSourceKindLabel(
  t: ReturnType<typeof useTranslation>["t"],
  sourceKind: AgentActivityComposerSkillOption["sourceKind"]
): string {
  switch (sourceKind) {
    case "project":
      return t("workspace.settings.agent.skills.sourceKinds.project");
    case "personal":
      return t("workspace.settings.agent.skills.sourceKinds.personal");
    case "bundled":
      return t("workspace.settings.agent.skills.sourceKinds.bundled");
    case "plugin":
      return t("workspace.settings.agent.skills.sourceKinds.plugin");
    case "system":
      return t("workspace.settings.agent.skills.sourceKinds.system");
    case "tutti-injected":
      return t("workspace.settings.agent.skills.sourceKinds.tuttiInjected");
  }
}
