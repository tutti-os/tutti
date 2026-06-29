import {
  createElement,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from "react";
import type {
  WorkbenchDisplayMode,
  WorkbenchHostNodeHeaderWindowActions
} from "@tutti-os/workbench-surface";
import {
  Button,
  PanelIcon,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import { CreateChatIcon } from "@tutti-os/ui-system/icons";

const headerChromeIconButtonClassName =
  "agent-gui-workbench-header__icon-button";

const conversationRailToggleButtonClassName =
  "agent-gui-workbench-header__icon-button agent-gui-workbench-header__rail-toggle";

const headerChromeIconClassName = "agent-gui-workbench-header__icon";

export interface AgentGuiWorkbenchHeaderCopy {
  collapseConversationRail: string;
  close?: string;
  expandConversationRail: string;
  fallbackAgentLabel: string;
  maximize?: string;
  minimize?: string;
  newConversation: string;
  restore?: string;
}

export interface AgentGuiWorkbenchHeaderProps extends HTMLAttributes<HTMLElement> {
  copy: AgentGuiWorkbenchHeaderCopy;
  defaultActions?: ReactNode;
  displayMode?: WorkbenchDisplayMode;
  iconUrl?: string;
  isConversationRailAutoCollapsed: boolean;
  isConversationRailCollapsed: boolean;
  conversationRailWidthPx?: number | null;
  conversationTitle?: string | null;
  onCreateConversation?: () => void;
  onToggleConversationRail: (nextCollapsed: boolean) => void;
  title?: string;
  windowActions?: Pick<
    WorkbenchHostNodeHeaderWindowActions,
    "close" | "minimize" | "toggleDisplayMode"
  >;
}

export function AgentGuiWorkbenchHeader({
  className,
  copy,
  defaultActions: _defaultActions,
  displayMode,
  iconUrl,
  isConversationRailAutoCollapsed,
  isConversationRailCollapsed,
  conversationRailWidthPx,
  conversationTitle,
  onCreateConversation,
  onToggleConversationRail,
  title,
  windowActions,
  ...headerProps
}: AgentGuiWorkbenchHeaderProps): ReactNode {
  const toggleLabel = isConversationRailCollapsed
    ? copy.expandConversationRail
    : copy.collapseConversationRail;
  const appTitle = title?.trim() || copy.fallbackAgentLabel;
  const sessionTitle = conversationTitle?.trim() || "";
  const safeDisplayMode = displayMode ?? "floating";
  const safeWindowActions = windowActions ?? {
    close: () => undefined,
    minimize: () => undefined,
    toggleDisplayMode: () => undefined
  };
  const displayModeLabel =
    safeDisplayMode === "fullscreen"
      ? (copy.restore ?? "Restore")
      : (copy.maximize ?? "Maximize");
  const headerStyle = {
    ...(headerProps.style ?? {}),
    ...(typeof conversationRailWidthPx === "number" &&
    Number.isFinite(conversationRailWidthPx)
      ? {
          "--agent-gui-workbench-header-rail-width": `${Math.round(conversationRailWidthPx)}px`
        }
      : {})
  } as CSSProperties;

  return createElement(
    "header",
    {
      ...headerProps,
      className: cn("agent-gui-workbench-header", className),
      "data-agent-gui-workbench-header": "true",
      "data-agent-gui-workbench-header-collapsed": isConversationRailCollapsed
        ? "true"
        : "false",
      style: headerStyle
    },
    createElement(
      "div",
      {
        className: "agent-gui-workbench-header__primary",
        "data-agent-gui-workbench-header-primary": "true"
      },
      createElement(
        "div",
        {
          className: "agent-gui-workbench-header__traffic-lights",
          onDoubleClick: (event) => event.stopPropagation(),
          onPointerDown: (event) => event.stopPropagation()
        },
        createTrafficLightButton({
          label: copy.close ?? "Close",
          onClick: safeWindowActions.close,
          testId: "agent-gui-window-close",
          tone: "close"
        }),
        createTrafficLightButton({
          label: copy.minimize ?? "Minimize",
          onClick: safeWindowActions.minimize,
          testId: "agent-gui-window-minimize",
          tone: "minimize"
        }),
        createTrafficLightButton({
          label: displayModeLabel,
          onClick: safeWindowActions.toggleDisplayMode,
          pressed: safeDisplayMode === "fullscreen",
          testId: "agent-gui-window-toggle-display-mode",
          tone: "maximize"
        })
      ),
      createElement(
        "div",
        {
          className: "agent-gui-workbench-header__agent-brand"
        },
        iconUrl
          ? createElement("img", {
              alt: "",
              "aria-hidden": true,
              className: "agent-gui-workbench-header__agent-icon",
              "data-agent-gui-workbench-header-icon": "true",
              "data-testid": "agent-gui-window-title-icon",
              draggable: false,
              src: iconUrl
            })
          : null,
        createElement(
          "span",
          {
            className: "agent-gui-workbench-header__agent-name"
          },
          appTitle
        )
      ),
      createElement(
        Button as never,
        {
          "aria-label": toggleLabel,
          className: conversationRailToggleButtonClassName,
          "data-agent-gui-conversation-rail-auto-collapsed":
            isConversationRailAutoCollapsed ? "true" : undefined,
          "data-agent-gui-conversation-rail-collapsed":
            isConversationRailCollapsed ? "true" : undefined,
          "data-testid": "agent-gui-toggle-conversation-rail",
          size: "icon-sm",
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
        createElement(PanelIcon, { className: headerChromeIconClassName })
      ),
      isConversationRailCollapsed && onCreateConversation
        ? createElement(
            Button as never,
            {
              "aria-label": copy.newConversation,
              className: headerChromeIconButtonClassName,
              size: "icon-sm",
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
            createElement(CreateChatIcon, {
              "aria-hidden": true,
              className: headerChromeIconClassName
            })
          )
        : null,
      isConversationRailCollapsed && sessionTitle
        ? createElement(
            "span",
            {
              className: "agent-gui-workbench-header__session-title"
            },
            createElement(
              "span",
              {
                className: "agent-gui-workbench-header__title-text"
              },
              sessionTitle
            )
          )
        : null
    ),
    !isConversationRailCollapsed && sessionTitle
      ? createElement(
          "div",
          {
            className: "agent-gui-workbench-header__detail-title",
            "data-testid": "agent-gui-window-detail-title"
          },
          createElement(
            "span",
            {
              className: "agent-gui-workbench-header__title-text"
            },
            sessionTitle
          )
        )
      : null
  );
}

function createTrafficLightButton(input: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  testId: string;
  tone: "close" | "minimize" | "maximize";
}): ReactNode {
  const button = createElement("button", {
    "aria-label": input.label,
    "aria-pressed": input.pressed,
    className: "agent-gui-workbench-header__traffic-light",
    "data-agent-gui-workbench-traffic-light": input.tone,
    "data-testid": input.testId,
    type: "button",
    onClick: (event) => {
      event.stopPropagation();
      input.onClick();
    },
    onDoubleClick: (event) => event.stopPropagation(),
    onPointerDown: (event) => event.stopPropagation()
  });

  return createElement(TooltipProvider, {
    children: createElement(
      Tooltip,
      null,
      createElement(TooltipTrigger, { asChild: true }, button),
      createElement(TooltipContent, { side: "bottom" }, input.label)
    ),
    delayDuration: 250,
    skipDelayDuration: 0
  });
}
