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
import { type StandaloneAgentToolPanelId } from "./standaloneAgentToolSidebarModel.ts";

export type ToolSidebarCopy = Record<StandaloneAgentToolPanelId, string> & {
  closeRightPanel: string;
  close: string;
  expand: string;
  newTab: string;
  openRightPanel: string;
  shrink: string;
  tool: string;
};

export type ToolSidebarReminderCounts = Partial<
  Record<StandaloneAgentToolPanelId, number>
>;

const toolSidebarPanelIconById = {
  apps: NavApplicationsLinedIcon,
  browser: WebIcon,
  files: FolderIcon,
  messages: ChatIcon,
  tasks: TaskIcon,
  terminal: TerminalLinedIcon
} satisfies Record<StandaloneAgentToolPanelId, ComponentType<IconProps>>;

export function ToolSidebarPanelIcon({
  panel,
  ...iconProps
}: IconProps & { panel: StandaloneAgentToolPanelId }): ReactNode {
  const Icon = toolSidebarPanelIconById[panel];
  return <Icon {...iconProps} />;
}

export function StandaloneAgentToolSidebarToolbar({
  activePanel,
  copy,
  isOpen,
  isExpanded,
  reminders,
  onAddPanel,
  onOpenPanel,
  onToggleExpansion,
  onToggleSidebar
}: {
  activePanel: StandaloneAgentToolPanelId | null;
  copy: ToolSidebarCopy;
  isOpen: boolean;
  isExpanded: boolean;
  reminders: ToolSidebarReminderCounts;
  onAddPanel: (panel: StandaloneAgentToolPanelId) => void;
  onOpenPanel: (panel: StandaloneAgentToolPanelId) => void;
  onToggleExpansion: () => void;
  onToggleSidebar: () => void;
}): ReactNode {
  const label = isOpen ? copy.closeRightPanel : copy.openRightPanel;

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
              <DropdownMenuItem onSelect={() => onAddPanel("files")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="files"
                />
                <span>{copy.files}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPanel("terminal")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="terminal"
                />
                <span>{copy.terminal}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPanel("browser")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="browser"
                />
                <span>{copy.browser}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPanel("tasks")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="tasks"
                />
                <span>{copy.tasks}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPanel("apps")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="apps"
                />
                <span>{copy.apps}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddPanel("messages")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="messages"
                />
                <span>{copy.messages}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {activePanel === null && !isOpen ? (
          <>
            <ToolbarQuickActionTooltip label={copy.tasks}>
              <Button
                aria-label={copy.tasks}
                aria-pressed={activePanel === "tasks"}
                className="relative text-[var(--text-secondary)]"
                data-standalone-agent-tool-sidebar-quick-action="tasks"
                size="icon-sm"
                type="button"
                variant="chrome"
                onClick={() => onOpenPanel("tasks")}
              >
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="tasks"
                />
              </Button>
            </ToolbarQuickActionTooltip>
            <ToolbarQuickActionTooltip label={copy.apps}>
              <Button
                aria-label={copy.apps}
                aria-pressed={activePanel === "apps"}
                className="relative text-[var(--text-secondary)]"
                data-standalone-agent-tool-sidebar-quick-action="apps"
                size="icon-sm"
                type="button"
                variant="chrome"
                onClick={() => onOpenPanel("apps")}
              >
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="apps"
                />
              </Button>
            </ToolbarQuickActionTooltip>
            <ToolbarQuickActionTooltip label={copy.messages}>
              <Button
                aria-label={copy.messages}
                aria-pressed={activePanel === "messages"}
                className="relative text-[var(--text-secondary)]"
                data-standalone-agent-tool-sidebar-quick-action="messages"
                size="icon-sm"
                type="button"
                variant="chrome"
                onClick={() => onOpenPanel("messages")}
              >
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="messages"
                />
                <ReminderBadge count={reminders.messages} />
              </Button>
            </ToolbarQuickActionTooltip>
          </>
        ) : null}
        {activePanel ? (
          <Button
            aria-label={`${isExpanded ? copy.shrink : copy.expand} ${copy[activePanel]}`}
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
  if (!count || count < 1) return null;
  return (
    <span className="absolute -top-1 -right-1 inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--state-danger)] px-1 text-[9px] leading-4 font-semibold text-[var(--white-stationary)]">
      {count > 99 ? "99+" : Math.floor(count)}
    </span>
  );
}
