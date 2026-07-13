import type { ComponentType, ReactNode } from "react";
import {
  AddLinedIcon,
  Button,
  ChatIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FolderIcon,
  MaximizeIcon,
  NavApplicationsLinedIcon,
  PanelIcon,
  RestoreIcon,
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
  isExpanded,
  reminders,
  onOpenPanel,
  onToggleExpansion,
  onToggleSidebar
}: {
  activePanel: StandaloneAgentToolPanelId | null;
  copy: ToolSidebarCopy;
  isExpanded: boolean;
  reminders: ToolSidebarReminderCounts;
  onOpenPanel: (panel: StandaloneAgentToolPanelId) => void;
  onToggleExpansion: () => void;
  onToggleSidebar: () => void;
}): ReactNode {
  const reminderCount = Object.values(reminders).reduce(
    (total, value) => total + (value ?? 0),
    0
  );
  const label = activePanel ? copy.closeRightPanel : copy.openRightPanel;

  return (
    <TooltipProvider>
      <nav
        aria-label={copy.tool}
        className="nodrag pointer-events-auto flex h-[var(--agent-gui-workbench-header-height,44px)] items-center gap-1 [-webkit-app-region:no-drag]"
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
              <DropdownMenuItem onSelect={() => onOpenPanel("files")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="files"
                />
                <span>{copy.files}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpenPanel("terminal")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="terminal"
                />
                <span>{copy.terminal}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpenPanel("browser")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="browser"
                />
                <span>{copy.browser}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpenPanel("apps")}>
                <ToolSidebarPanelIcon
                  aria-hidden
                  className="size-4"
                  panel="apps"
                />
                <span>{copy.apps}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpenPanel("messages")}>
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
        {activePanel === null ? (
          <>
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
              aria-pressed={activePanel !== null}
              className="relative"
              data-standalone-agent-tool-sidebar-toggle="true"
              size="icon-sm"
              type="button"
              variant={activePanel ? "secondary" : "chrome"}
              onClick={onToggleSidebar}
            >
              <PanelIcon aria-hidden className="size-[18px] -scale-x-100" />
              <ReminderBadge count={reminderCount} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      </nav>
    </TooltipProvider>
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
