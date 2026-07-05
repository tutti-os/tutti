import { type JSX, type ReactNode } from "react";
import {
  Badge,
  AgentSessionsIcon,
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IssueIcon,
  cn
} from "@tutti-os/ui-system";
import { WorkspaceUserProjectSelect } from "@tutti-os/workspace-user-project/ui";
import type {
  IssueManagerFileReference,
  IssueManagerRun,
  IssueManagerRunOutput
} from "../../../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";
import {
  formatIssueManagerTimestamp,
  resolveIssueManagerStatusLabel
} from "../../../services/controllerModel.ts";
import type { IssueManagerController } from "../../react/index.ts";
import { issueManagerStatusBadgeVariant } from "../status/IssueManagerStatusBadge.ts";

const providerMenuItemClassName =
  "min-h-8 overflow-hidden rounded-md px-2.5 py-1.5 text-[13px] font-normal leading-[1.2] text-[var(--text-primary)]";
const providerActionTriggerClassName = "font-[var(--font-weight-emphasis-cjk)]";

export function IssueManagerRunActionTrigger({
  controller,
  disabled = false,
  triggerClassName,
  triggerVariant = "default"
}: {
  controller: IssueManagerController;
  disabled?: boolean;
  triggerClassName?: string;
  triggerVariant?: IssueManagerProviderActionTriggerVariant;
}): JSX.Element {
  return (
    <IssueManagerProviderActionMenu
      controller={controller}
      disabled={disabled}
      icon={<AgentSessionsIcon size={16} />}
      label={controller.copy.t("actions.askAgentToRun")}
      triggerClassName={triggerClassName}
      triggerVariant={triggerVariant}
      onSelectAgentTarget={(agentTargetId) => controller.runTask(agentTargetId)}
    />
  );
}

export function IssueManagerBreakdownActionTrigger({
  controller,
  disabled = false,
  triggerClassName,
  triggerVariant = "default"
}: {
  controller: IssueManagerController;
  disabled?: boolean;
  triggerClassName?: string;
  triggerVariant?: IssueManagerProviderActionTriggerVariant;
}): JSX.Element {
  return (
    <IssueManagerProviderActionMenu
      controller={controller}
      disabled={disabled}
      icon={<IssueIcon size={16} />}
      label={controller.copy.t("actions.askAgentToBreakdown")}
      triggerClassName={triggerClassName}
      triggerVariant={triggerVariant}
      triggerButtonVariant="secondary"
      onSelectAgentTarget={(agentTargetId) =>
        controller.startTaskBreakdown(agentTargetId)
      }
    />
  );
}

type IssueManagerProviderActionTriggerVariant = "button" | "default";

function IssueManagerProviderActionMenu({
  controller,
  disabled,
  icon,
  label,
  onSelectAgentTarget,
  triggerButtonVariant,
  triggerClassName,
  triggerVariant
}: {
  controller: IssueManagerController;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onSelectAgentTarget: (agentTargetId: string) => Promise<void>;
  triggerButtonVariant?: "secondary";
  triggerClassName?: string;
  triggerVariant: IssueManagerProviderActionTriggerVariant;
}): JSX.Element {
  const agentTargetOptions = controller.agentTargetOptions;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          className={cn(
            "min-w-0",
            "[&[data-state=open]_[data-issue-manager-provider-chevron=true]]:rotate-180",
            providerActionTriggerClassName,
            triggerClassName
          )}
          disabled={disabled}
          size={triggerVariant === "button" ? "dialog" : "default"}
          type="button"
          variant={triggerButtonVariant}
        >
          {icon}
          <span className="truncate">{label}</span>
          <ChevronDownIcon
            className="shrink-0 transition-transform duration-200"
            data-issue-manager-provider-chevron="true"
            size={14}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[220px] min-w-[220px]"
        style={{ zIndex: "var(--z-panel-popover)" }}
      >
        {agentTargetOptions.length === 0 ? (
          <DropdownMenuItem className={providerMenuItemClassName} disabled>
            {controller.copy.t("messages.noAgentProviders")}
          </DropdownMenuItem>
        ) : (
          agentTargetOptions.map((option) => (
            <DropdownMenuItem
              className={providerMenuItemClassName}
              disabled={option.disabled === true}
              key={option.agentTargetId ?? option.provider}
              title={option.disabledReason}
              onSelect={() => {
                const agentTargetId = option.agentTargetId?.trim();
                if (agentTargetId) {
                  void onSelectAgentTarget(agentTargetId);
                }
              }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 pr-1">
                <IssueManagerAgentProviderIcon
                  fallbackIcon={<AgentSessionsIcon aria-hidden size={15} />}
                  iconUrl={option.iconUrl}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IssueManagerAgentProviderIcon({
  fallbackIcon,
  iconUrl
}: {
  fallbackIcon: ReactNode;
  iconUrl?: string | null;
}): JSX.Element {
  const normalizedIconUrl = iconUrl?.trim();

  if (!normalizedIconUrl) {
    return <>{fallbackIcon}</>;
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0 rounded-[4px] object-contain"
      decoding="async"
      draggable={false}
      src={normalizedIconUrl}
    />
  );
}

export function IssueManagerExecutionDirectoryTrigger({
  className,
  controller,
  disabled = false
}: {
  className?: string;
  controller: IssueManagerController;
  disabled?: boolean;
}): JSX.Element | null {
  if (!controller.canSelectExecutionDirectory) {
    return null;
  }

  return (
    <WorkspaceUserProjectSelect
      classNames={{
        content: "w-[240px] min-w-[240px]",
        item: "min-h-7 overflow-hidden rounded-md py-1 pr-7 pl-2.5 text-[13px] font-normal leading-[1.2] text-[var(--text-primary)]",
        trigger: cn(
          "group inline-flex min-h-7 max-w-[240px] min-w-0 items-center gap-1.5 overflow-hidden rounded-md border-0 bg-transparent px-0.5 py-0 text-[13px] font-normal leading-[1.2] text-[var(--text-secondary)] shadow-none outline-none hover:bg-transparent hover:text-[var(--text-primary)] focus:bg-transparent focus:text-[var(--text-primary)] focus-visible:bg-transparent focus-visible:ring-0 disabled:bg-transparent disabled:text-[var(--text-disabled)]",
          className
        )
      }}
      contentAlign="end"
      disabled={disabled}
      i18n={controller.workspaceUserProjectI18n}
      service={controller.executionDirectoryProjectService}
      selectedProjectPath={controller.nodeState.selectedExecutionDirectory}
      unlistedProjectLabel={controller.copy.t(
        "labels.customExecutionDirectory"
      )}
      onProjectPathChange={(path: string | null) => {
        void controller.useExecutionDirectory(path);
      }}
    />
  );
}

export function IssueManagerRunPanels({
  copy,
  onOpen,
  outputs,
  recentRuns
}: {
  copy: IssueManagerI18nRuntime;
  onOpen: (reference: IssueManagerFileReference) => Promise<void>;
  outputs: readonly IssueManagerRunOutput[];
  recentRuns: readonly IssueManagerRun[];
}): JSX.Element {
  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border-1 bg-transparent px-4 py-4">
        <h4 className="mb-3 text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
          {copy.t("labels.recentRuns")}
        </h4>
        {recentRuns.length === 0 ? (
          <p className="text-[13px] leading-5 text-[var(--text-secondary)]">
            {copy.t("messages.noRecentRuns")}
          </p>
        ) : (
          <div className="grid gap-2.5">
            {recentRuns.map((run) => (
              <div
                className="rounded-lg border border-[var(--border-2)] bg-transparent px-3.5 py-3"
                key={run.runId}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
                      {run.summary || run.runId}
                    </p>
                    <p className="mt-1 text-[11px] leading-[1.55] text-[var(--text-secondary)]">
                      {formatIssueManagerTimestamp(
                        run.updatedAtUnix ?? run.createdAtUnix
                      )}
                    </p>
                  </div>
                  <Badge variant={issueManagerStatusBadgeVariant(run.status)}>
                    {resolveIssueManagerStatusLabel(copy, run.status)}
                  </Badge>
                </div>
                {run.errorMessage ? (
                  <p className="mt-2 text-[11px] text-[var(--state-danger)]">
                    {run.errorMessage}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border-1 bg-transparent px-4 py-4">
        <h4 className="mb-3 text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
          {copy.t("labels.outputs")}
        </h4>
        {outputs.length === 0 ? (
          <p className="text-[13px] leading-5 text-[var(--text-secondary)]">
            {copy.t("messages.noOutputs")}
          </p>
        ) : (
          <div className="grid gap-2.5">
            {outputs.map((output) => (
              <button
                className="rounded-lg border border-[var(--border-2)] bg-transparent px-3.5 py-3 text-left transition-colors hover:bg-transparency-hover"
                key={output.outputId}
                type="button"
                onClick={() => {
                  void onOpen({
                    displayName: output.displayName,
                    kind: "file",
                    path: output.path
                  });
                }}
              >
                <p className="truncate text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
                  {output.displayName}
                </p>
                <p className="mt-1 truncate text-[11px] leading-[1.55] text-[var(--text-secondary)]">
                  {output.path}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
