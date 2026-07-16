import {
  createElement,
  lazy,
  Suspense,
  useState,
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
import openLinkLinedIconUrl from "../app/renderer/assets/icons/open-link-lined.svg";
import { useAgentGuiWorkbenchBodyRenderError } from "./bodyRenderErrorRegistry.ts";

const LazyAgentRichTextReadonly = lazy(() =>
  import("../shared/AgentRichTextReadonly.tsx").then((module) => ({
    default: module.AgentRichTextReadonly
  }))
);

const headerChromeIconButtonClassName =
  "agent-gui-workbench-header__icon-button";

const conversationRailToggleButtonClassName =
  "agent-gui-workbench-header__icon-button agent-gui-workbench-header__rail-toggle";

const detachedWindowButtonClassName =
  "agent-gui-workbench-header__icon-button agent-gui-workbench-header__detached-window";

const headerChromeIconClassName = "agent-gui-workbench-header__icon";

export interface AgentGuiWorkbenchHeaderCopy {
  collapseConversationRail: string;
  close?: string;
  expandConversationRail: string;
  fallbackAgentLabel: string;
  maximize?: string;
  minimize?: string;
  newConversation: string;
  openDetachedWindow?: string;
  restore?: string;
  untitledConversation?: string;
}

export interface AgentGuiWorkbenchHeaderProps extends HTMLAttributes<HTMLElement> {
  copy: AgentGuiWorkbenchHeaderCopy;
  agentTitle?: string | null;
  defaultActions?: ReactNode;
  displayMode?: WorkbenchDisplayMode;
  isConversationRailAutoCollapsed: boolean;
  isConversationRailCollapsed: boolean;
  conversationRailWidthPx?: number | null;
  conversationIconUrl?: string | null;
  conversationIconFallbackUrl?: string | null;
  hasConversation?: boolean;
  providerRailWidthPx?: number | null;
  primaryAccessory?: ReactNode;
  secondaryAccessory?: ReactNode;
  conversationTitle?: string | null;
  conversationTitleDisplayPrompt?: string | null;
  nodeId: string;
  onCreateConversation?: () => void;
  onOpenDetachedWindow?: () => void;
  onToggleConversationRail: (nextCollapsed: boolean) => void;
  showAppTitle?: boolean;
  showConversationRailToggle?: boolean;
  showWindowControls?: boolean;
  title?: string;
  windowActions?: Pick<
    WorkbenchHostNodeHeaderWindowActions,
    "close" | "minimize" | "toggleDisplayMode"
  >;
}

export function AgentGuiWorkbenchHeader({
  className,
  copy,
  agentTitle,
  defaultActions: _defaultActions,
  displayMode,
  isConversationRailAutoCollapsed,
  isConversationRailCollapsed,
  conversationRailWidthPx,
  conversationIconUrl,
  conversationIconFallbackUrl,
  hasConversation = false,
  providerRailWidthPx,
  primaryAccessory,
  secondaryAccessory,
  conversationTitle,
  conversationTitleDisplayPrompt,
  nodeId,
  onCreateConversation,
  onOpenDetachedWindow,
  onToggleConversationRail,
  showAppTitle = true,
  showConversationRailToggle = true,
  showWindowControls = true,
  title: _title,
  windowActions,
  ...headerProps
}: AgentGuiWorkbenchHeaderProps): ReactNode {
  const hasBodyRenderError = useAgentGuiWorkbenchBodyRenderError(nodeId);
  const toggleLabel = isConversationRailCollapsed
    ? copy.expandConversationRail
    : copy.collapseConversationRail;
  const appTitle = _title?.trim() || copy.fallbackAgentLabel;
  const sessionTitle = hasBodyRenderError
    ? ""
    : conversationTitle?.trim() ||
      (hasConversation ? copy.untitledConversation?.trim() : "") ||
      "";
  const sessionTitleDisplayPrompt = hasBodyRenderError
    ? ""
    : conversationTitleDisplayPrompt?.trim() || "";
  const collapsedTitle = sessionTitle || agentTitle?.trim() || "";
  const sessionIconUrl = conversationIconUrl?.trim() || "";
  const sessionIconFallbackUrl = conversationIconFallbackUrl?.trim() || "";
  const hasExpandedIdentity = Boolean(
    collapsedTitle || sessionIconUrl || sessionIconFallbackUrl
  );
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
          "--agent-gui-workbench-header-rail-width": `${Math.round(
            conversationRailWidthPx +
              (typeof providerRailWidthPx === "number" &&
              Number.isFinite(providerRailWidthPx)
                ? providerRailWidthPx
                : 0)
          )}px`
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
      "data-agent-gui-workbench-header-has-session": sessionTitle
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
      showWindowControls
        ? createElement(
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
          )
        : null,
      showAppTitle && !isConversationRailCollapsed
        ? createElement(
            "div",
            {
              className: "agent-gui-workbench-header__agent-brand"
            },
            createElement(
              "span",
              {
                className: "agent-gui-workbench-header__agent-name"
              },
              appTitle
            )
          )
        : null,
      primaryAccessory
        ? createElement(
            "div",
            {
              className: "agent-gui-workbench-header__primary-accessory"
            },
            primaryAccessory
          )
        : null,
      onOpenDetachedWindow && !hasBodyRenderError
        ? createDetachedWindowButton({
            label: copy.openDetachedWindow ?? "Open in detached window",
            onOpenDetachedWindow
          })
        : null,
      showConversationRailToggle
        ? createConversationRailToggleButton({
            isAutoCollapsed: isConversationRailAutoCollapsed,
            isCollapsed: isConversationRailCollapsed,
            label: toggleLabel,
            onToggleConversationRail
          })
        : null,
      isConversationRailCollapsed && onCreateConversation
        ? createNewConversationButton({
            label: copy.newConversation,
            onCreateConversation
          })
        : null,
      isConversationRailCollapsed && collapsedTitle
        ? createElement(
            "span",
            {
              className: "agent-gui-workbench-header__session-title"
            },
            createSessionHeaderIconSlot({
              fallbackSrc: sessionIconFallbackUrl,
              src: sessionIconUrl,
              testId: "agent-gui-window-session-icon"
            }),
            createElement(
              "span",
              {
                className: "agent-gui-workbench-header__title-text"
              },
              collapsedTitle
            )
          )
        : null,
      isConversationRailCollapsed && secondaryAccessory
        ? createElement(
            "div",
            {
              className: "agent-gui-workbench-header__secondary-accessory"
            },
            secondaryAccessory
          )
        : null
    ),
    !isConversationRailCollapsed && (hasExpandedIdentity || secondaryAccessory)
      ? createElement(
          "div",
          {
            className: "agent-gui-workbench-header__detail"
          },
          hasExpandedIdentity
            ? createElement(
                "div",
                {
                  className: "agent-gui-workbench-header__detail-title",
                  "data-testid": "agent-gui-window-detail-title"
                },
                createSessionHeaderIconSlot({
                  fallbackSrc: sessionIconFallbackUrl,
                  src: sessionIconUrl,
                  testId: "agent-gui-window-detail-title-icon"
                }),
                sessionTitleDisplayPrompt
                  ? createElement(
                      Suspense,
                      {
                        fallback: createElement(
                          "span",
                          {
                            className: "agent-gui-workbench-header__title-text"
                          },
                          sessionTitle
                        )
                      },
                      createElement(LazyAgentRichTextReadonly, {
                        className:
                          "agent-gui-workbench-header__title-text agent-gui-workbench-header__rich-title",
                        editorClassName:
                          "agent-gui-workbench-header__rich-title-editor",
                        value: sessionTitleDisplayPrompt
                      })
                    )
                  : sessionTitle
                    ? createElement(
                        "span",
                        {
                          className: "agent-gui-workbench-header__title-text"
                        },
                        sessionTitle
                      )
                    : null
              )
            : null,
          secondaryAccessory
            ? createElement(
                "div",
                {
                  className: "agent-gui-workbench-header__secondary-accessory"
                },
                secondaryAccessory
              )
            : null
        )
      : null
  );
}

function createConversationRailToggleButton({
  isAutoCollapsed,
  isCollapsed,
  label,
  onToggleConversationRail
}: {
  isAutoCollapsed: boolean;
  isCollapsed: boolean;
  label: string;
  onToggleConversationRail: (nextCollapsed: boolean) => void;
}): ReactNode {
  const button = createElement(
    Button as never,
    {
      "aria-label": label,
      className: conversationRailToggleButtonClassName,
      "data-agent-gui-conversation-rail-auto-collapsed": isAutoCollapsed
        ? "true"
        : undefined,
      "data-agent-gui-conversation-rail-collapsed": isCollapsed
        ? "true"
        : undefined,
      "data-testid": "agent-gui-toggle-conversation-rail",
      size: "icon-sm",
      type: "button",
      variant: "ghost",
      onClick: (event) => {
        event.stopPropagation();
        onToggleConversationRail(!isCollapsed);
      },
      onDoubleClick: (event) => event.stopPropagation(),
      onPointerDown: (event) => event.stopPropagation()
    },
    createElement(PanelIcon, { className: headerChromeIconClassName })
  );

  return createElement(TooltipProvider, {
    children: createElement(
      Tooltip,
      null,
      createElement(TooltipTrigger, { asChild: true }, button),
      createElement(TooltipContent, { side: "bottom" }, label)
    ),
    delayDuration: 250,
    skipDelayDuration: 0
  });
}

function createDetachedWindowButton({
  label,
  onOpenDetachedWindow
}: {
  label: string;
  onOpenDetachedWindow: () => void;
}): ReactNode {
  const button = createElement(
    Button as never,
    {
      "aria-label": label,
      className: detachedWindowButtonClassName,
      "data-testid": "agent-gui-open-detached-window",
      size: "icon-sm",
      type: "button",
      variant: "ghost",
      onClick: (event) => {
        event.stopPropagation();
        onOpenDetachedWindow();
      },
      onDoubleClick: (event) => event.stopPropagation(),
      onPointerDown: (event) => event.stopPropagation()
    },
    createElement("span", {
      "aria-hidden": true,
      className: headerChromeIconClassName,
      "data-agent-gui-icon": "open-link-lined",
      style: {
        backgroundColor: "currentColor",
        display: "block",
        WebkitMaskImage: `url("${openLinkLinedIconUrl}")`,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskImage: `url("${openLinkLinedIconUrl}")`,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain"
      }
    })
  );

  return createElement(TooltipProvider, {
    children: createElement(
      Tooltip,
      null,
      createElement(TooltipTrigger, { asChild: true }, button),
      createElement(TooltipContent, { side: "bottom" }, label)
    ),
    delayDuration: 250,
    skipDelayDuration: 0
  });
}

function createNewConversationButton({
  label,
  onCreateConversation
}: {
  label: string;
  onCreateConversation: () => void;
}): ReactNode {
  const button = createElement(
    Button as never,
    {
      "aria-label": label,
      className: headerChromeIconButtonClassName,
      size: "icon-sm",
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
  );

  return createElement(TooltipProvider, {
    children: createElement(
      Tooltip,
      null,
      createElement(TooltipTrigger, { asChild: true }, button),
      createElement(TooltipContent, { side: "bottom" }, label)
    ),
    delayDuration: 250,
    skipDelayDuration: 0
  });
}

function createSessionHeaderIconSlot({
  src,
  fallbackSrc,
  testId
}: {
  src: string;
  fallbackSrc: string;
  testId: string;
}): ReactNode {
  // While the session's provider is still resolving (e.g. a freshly created
  // session) there is no icon URL yet. Render a neutral skeleton block rather
  // than flashing a wrong/default provider icon; it is replaced once the real
  // icon arrives.
  if (!src) {
    return createElement("span", {
      "aria-hidden": "true",
      className:
        "agent-gui-workbench-header__session-icon agent-gui-workbench-header__session-icon--pending",
      "data-testid": `${testId}-pending`
    });
  }
  return createElement(SessionHeaderIcon, {
    key: `${src}::${fallbackSrc}`,
    fallbackSrc,
    src,
    testId
  });
}

function SessionHeaderIcon({
  src,
  fallbackSrc,
  testId
}: {
  src: string;
  fallbackSrc?: string;
  testId: string;
}): ReactNode {
  const [useFallback, setUseFallback] = useState(false);
  const [hidden, setHidden] = useState(false);

  const hasFallback = Boolean(fallbackSrc) && fallbackSrc !== src;
  const effectiveSrc = useFallback && fallbackSrc ? fallbackSrc : src;

  if (hidden) {
    return null;
  }

  return createElement("img", {
    alt: "",
    className: "agent-gui-workbench-header__session-icon",
    "data-testid": testId,
    draggable: false,
    src: effectiveSrc,
    onError: () => {
      // On load failure, fall back to the bundled provider icon once; if that
      // also fails (or there is none), hide the img so the browser's broken
      // image glyph never shows.
      if (!useFallback && hasFallback) {
        setUseFallback(true);
      } else {
        setHidden(true);
      }
    }
  });
}

function createTrafficLightButton(input: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  testId: string;
  tone: "close" | "minimize" | "maximize";
}): ReactNode {
  const iconName =
    input.tone === "maximize"
      ? input.pressed
        ? "unfullscreen"
        : "fullscreen"
      : input.tone;
  return createElement(
    "button",
    {
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
    },
    createElement(TrafficLightIcon, {
      "aria-hidden": true,
      className: "agent-gui-workbench-header__traffic-light-icon",
      "data-agent-gui-workbench-traffic-light-icon": iconName,
      iconName
    })
  );
}

function TrafficLightIcon({
  className,
  iconName,
  ...props
}: {
  className: string;
  iconName: "close" | "fullscreen" | "minimize" | "unfullscreen";
  "aria-hidden": true;
  "data-agent-gui-workbench-traffic-light-icon": string;
}): ReactNode {
  return createElement(
    "svg",
    {
      ...props,
      className,
      fill: "currentColor",
      viewBox: "0 0 24 24",
      xmlns: "http://www.w3.org/2000/svg"
    },
    createElement("path", { d: trafficLightIconPathByName[iconName] })
  );
}

const trafficLightIconPathByName = {
  close:
    "M16.9395 4.93953C17.5253 4.35374 18.4748 4.35374 19.0606 4.93953C19.6463 5.52532 19.6464 6.47486 19.0606 7.06062L14.1212 12.0001L19.0606 16.9395C19.6463 17.5253 19.6464 18.4749 19.0606 19.0606C18.4749 19.6464 17.5253 19.6463 16.9395 19.0606L12.0001 14.1212L7.06062 19.0606C6.47486 19.6464 5.52532 19.6463 4.93953 19.0606C4.35374 18.4748 4.35374 17.5253 4.93953 16.9395L9.87898 12.0001L4.93953 7.06062C4.35374 6.47484 4.35374 5.52532 4.93953 4.93953C5.52532 4.35374 6.47484 4.35374 7.06062 4.93953L12.0001 9.87898L16.9395 4.93953Z",
  fullscreen:
    "M18.1465 7.85352C18.4615 7.53861 18.9999 7.76165 19 8.20703V18.5C19 18.7761 18.7761 19 18.5 19H8.20703C7.76165 18.9999 7.53861 18.4615 7.85352 18.1465L18.1465 7.85352ZM15.793 5C16.2384 5.00006 16.4614 5.53855 16.1465 5.85352L5.85352 16.1465C5.53855 16.4614 5.00006 16.2384 5 15.793V5.5C5 5.22386 5.22386 5 5.5 5H15.793Z",
  minimize:
    "M5 10.5H19C19.8284 10.5 20.5 11.1716 20.5 12C20.5 12.8284 19.8284 13.5 19 13.5H5C4.17157 13.5 3.5 12.8284 3.5 12C3.5 11.1716 4.17157 10.5 5 10.5Z",
  unfullscreen:
    "M20.793 12C21.2384 12.0001 21.4614 12.5386 21.1465 12.8536L12.8536 21.1465C12.5386 21.4614 12.0001 21.2384 12.0001 20.793V12.5C12.0001 12.2239 12.2239 12 12.5001 12H20.793ZM11.1465 2.85356C11.4615 2.53864 12 2.76166 12.0001 3.20708V11.5C12 11.7761 11.7762 12 11.5001 12H3.20708C2.76166 12 2.53864 11.4615 2.85357 11.1465L11.1465 2.85356Z"
} as const;
