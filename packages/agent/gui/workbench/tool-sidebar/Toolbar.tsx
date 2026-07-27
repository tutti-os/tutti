import type { ComponentType, ReactNode } from "react";
import {
  AddLinedIcon,
  Button,
  ChatIcon,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FolderIcon,
  MaximizeIcon,
  NavApplicationsLinedIcon,
  PanelIcon,
  RestoreIcon,
  TaskIcon,
  TerminalLinedIcon,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  WebIcon,
  type IconProps
} from "@tutti-os/ui-system";
import {
  formatAgentToolReminderCount,
  type AgentToolPanelDefinition,
  type AgentToolPanelId
} from "./model.ts";

export interface AgentToolSidebarCopy {
  close: string;
  closeRightPanel: string;
  expand: string;
  newTab: string;
  openRightPanel: string;
  resizeSidebar: string;
  shrink: string;
  tool: string;
}

export type AgentToolSidebarReminderCounts = Partial<
  Record<AgentToolPanelId, number>
>;

const iconByPanel = {
  apps: NavApplicationsLinedIcon,
  browser: WebIcon,
  files: FolderIcon,
  messages: ChatIcon,
  tasks: TaskIcon,
  terminal: TerminalLinedIcon
} satisfies Record<AgentToolPanelId, ComponentType<IconProps>>;

export function AgentToolPanelIcon({
  panel,
  ...iconProps
}: IconProps & { panel: AgentToolPanelId }): ReactNode {
  const Icon = iconByPanel[panel];
  return <Icon {...iconProps} />;
}

export function AgentToolSidebarToolbar({
  activePanel,
  copy,
  isExpanded,
  isOpen,
  panels,
  quickActionPanels = [],
  reminders = {},
  onAddPanel,
  onOpenPanel,
  onToggleExpansion,
  onToggleSidebar
}: {
  activePanel: AgentToolPanelId | null;
  copy: AgentToolSidebarCopy;
  isExpanded: boolean;
  isOpen: boolean;
  panels: readonly AgentToolPanelDefinition[];
  quickActionPanels?: readonly AgentToolPanelId[];
  reminders?: AgentToolSidebarReminderCounts;
  onAddPanel: (panel: AgentToolPanelId) => void;
  onOpenPanel: (panel: AgentToolPanelId) => void;
  onToggleExpansion: () => void;
  onToggleSidebar: () => void;
}): ReactNode {
  const label = isOpen ? copy.closeRightPanel : copy.openRightPanel;
  const labelByPanel = new Map(panels.map((panel) => [panel.id, panel.label]));
  const quickActions = quickActionPanels.filter((panel) =>
    labelByPanel.has(panel)
  );

  return (
    <TooltipProvider>
      <nav
        aria-label={copy.tool}
        className={cn(
          "nodrag pointer-events-auto flex h-[var(--agent-gui-workbench-header-height,44px)] items-center gap-1 [-webkit-app-region:no-drag]",
          activePanel === null && isOpen && "ml-auto"
        )}
        data-standalone-agent-tool-sidebar-toolbar="true"
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {activePanel ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={copy.newTab}
                className="text-[var(--text-secondary)]"
                size="icon-sm"
                type="button"
                variant="chrome"
              >
                <AddLinedIcon aria-hidden className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-36"
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {panels.map((panel) => (
                <DropdownMenuItem
                  key={panel.id}
                  onSelect={() => onAddPanel(panel.id)}
                >
                  <AgentToolPanelIcon
                    aria-hidden
                    className="size-4"
                    panel={panel.id}
                  />
                  <span>{panel.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {activePanel === null && !isOpen
          ? quickActions.map((panel) => (
              <ToolbarQuickActionTooltip
                key={panel}
                label={labelByPanel.get(panel) ?? panel}
              >
                <Button
                  aria-label={labelByPanel.get(panel) ?? panel}
                  aria-pressed={false}
                  className="relative text-[var(--text-secondary)]"
                  data-standalone-agent-tool-sidebar-quick-action={panel}
                  size="icon-sm"
                  type="button"
                  variant="chrome"
                  onClick={() => onOpenPanel(panel)}
                >
                  <AgentToolPanelIcon
                    aria-hidden
                    className="size-4"
                    panel={panel}
                  />
                  <ReminderBadge count={reminders[panel]} />
                </Button>
              </ToolbarQuickActionTooltip>
            ))
          : null}
        {activePanel ? (
          <Button
            aria-label={`${isExpanded ? copy.shrink : copy.expand} ${labelByPanel.get(activePanel) ?? activePanel}`}
            aria-pressed={isExpanded}
            className="text-[var(--text-secondary)]"
            size="icon-sm"
            type="button"
            variant="chrome"
            onClick={onToggleExpansion}
          >
            {isExpanded ? (
              <RestoreIcon aria-hidden className="size-3.5" />
            ) : (
              <MaximizeIcon aria-hidden className="size-3.5" />
            )}
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={label}
              aria-pressed={isOpen}
              className="relative"
              data-standalone-agent-tool-sidebar-toggle="true"
              size="icon-sm"
              type="button"
              variant={isOpen && activePanel !== null ? "secondary" : "chrome"}
              onClick={onToggleSidebar}
            >
              <PanelIcon aria-hidden className="size-[18px] -scale-x-100" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      </nav>
    </TooltipProvider>
  );
}

function ToolbarQuickActionTooltip({
  children,
  label
}: {
  children: ReactNode;
  label: string;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function ReminderBadge({ count }: { count?: number }): ReactNode {
  const label = formatAgentToolReminderCount(count);
  return label ? (
    <span className="absolute -top-1 -right-1 inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--accent-codex)] px-1 text-[9px] leading-4 font-semibold text-[var(--white-stationary)]">
      {label}
    </span>
  ) : null;
}
