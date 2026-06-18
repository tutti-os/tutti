import { createElement, type HTMLAttributes, type ReactNode } from "react";
import { Button, PanelIcon, cn } from "@tutti-os/ui-system";
import { EditIcon } from "@tutti-os/ui-system/icons";

export interface AgentGuiWorkbenchHeaderCopy {
  collapseConversationRail: string;
  expandConversationRail: string;
  fallbackAgentLabel: string;
  newConversation: string;
}

export interface AgentGuiWorkbenchHeaderProps extends HTMLAttributes<HTMLElement> {
  copy: AgentGuiWorkbenchHeaderCopy;
  defaultActions?: ReactNode;
  isConversationRailAutoCollapsed: boolean;
  isConversationRailCollapsed: boolean;
  onCreateConversation?: () => void;
  onToggleConversationRail: (nextCollapsed: boolean) => void;
  title?: string;
}

export function AgentGuiWorkbenchHeader({
  className,
  copy,
  defaultActions,
  isConversationRailAutoCollapsed,
  isConversationRailCollapsed,
  onCreateConversation,
  onToggleConversationRail,
  title,
  ...headerProps
}: AgentGuiWorkbenchHeaderProps): ReactNode {
  const toggleLabel = isConversationRailCollapsed
    ? copy.expandConversationRail
    : copy.collapseConversationRail;

  return createElement(
    "header",
    {
      ...headerProps,
      className: cn(
        "flex h-full min-h-0 items-center justify-between gap-3 bg-[var(--background-panel)] px-2 pl-3",
        className
      )
    },
    createElement(
      "div",
      { className: "flex min-w-0 items-center gap-1" },
      createElement(
        "span",
        {
          className:
            "min-w-0 truncate text-[13px] font-semibold leading-5 text-[var(--text-primary)]"
        },
        title?.trim() || copy.fallbackAgentLabel
      ),
      createElement(
        Button as never,
        {
          "aria-label": toggleLabel,
          className: "cursor-pointer rounded-md",
          "data-agent-gui-conversation-rail-auto-collapsed":
            isConversationRailAutoCollapsed ? "true" : undefined,
          "data-agent-gui-conversation-rail-collapsed":
            isConversationRailCollapsed ? "true" : undefined,
          "data-testid": "agent-gui-toggle-conversation-rail",
          size: "icon-xs",
          title: toggleLabel,
          type: "button",
          variant: "ghost",
          onClick: (event) => {
            event.stopPropagation();
            onToggleConversationRail(!isConversationRailCollapsed);
          },
          onDoubleClick: (event) => event.stopPropagation(),
          onPointerDown: (event) => event.stopPropagation()
        },
        createElement(PanelIcon, { className: "size-[18px]" })
      ),
      isConversationRailCollapsed && onCreateConversation
        ? createElement(
            Button as never,
            {
              "aria-label": copy.newConversation,
              className: "cursor-pointer rounded-md",
              size: "icon-xs",
              title: copy.newConversation,
              type: "button",
              variant: "ghost",
              onClick: (event) => {
                event.stopPropagation();
                onCreateConversation();
              },
              onDoubleClick: (event) => event.stopPropagation(),
              onPointerDown: (event) => event.stopPropagation()
            },
            createElement(EditIcon, {
              "aria-hidden": true,
              className: "size-[16px]"
            })
          )
        : null
    ),
    createElement(
      "div",
      {
        className: "flex flex-none items-center gap-1",
        onDoubleClick: (event) => event.stopPropagation(),
        onPointerDown: (event) => event.stopPropagation()
      },
      defaultActions
    )
  );
}
