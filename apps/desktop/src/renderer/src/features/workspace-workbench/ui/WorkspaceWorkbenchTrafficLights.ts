import {
  createElement,
  type HTMLAttributes,
  type MouseEvent,
  type SVGProps
} from "react";
import type {
  WorkbenchDisplayMode,
  WorkbenchHostNodeHeaderWindowActions
} from "@tutti-os/workbench-surface";
import { cn } from "@tutti-os/ui-system";
import {
  workspaceWorkbenchDesktopI18nKeys,
  type WorkspaceWorkbenchDesktopI18nRuntime
} from "../../../../../shared/i18n/index.ts";

type WorkspaceWorkbenchTrafficLightTone = "close" | "maximize" | "minimize";

export function WorkspaceWorkbenchTrafficLights({
  className,
  displayMode,
  i18n,
  windowActions
}: {
  className?: string;
  displayMode: WorkbenchDisplayMode;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  windowActions: Pick<
    WorkbenchHostNodeHeaderWindowActions,
    "close" | "minimize" | "toggleDisplayMode"
  >;
}): React.JSX.Element {
  const isFullscreen = displayMode === "fullscreen";

  return createElement(
    "div",
    {
      className: cn(
        "group/traffic-lights inline-flex shrink-0 items-center gap-2",
        className
      ),
      onDoubleClick: (event: MouseEvent<HTMLDivElement>) =>
        event.stopPropagation(),
      onPointerDown: (event: MouseEvent<HTMLDivElement>) =>
        event.stopPropagation()
    },
    createElement(WorkspaceWorkbenchTrafficLightButton, {
      label: i18n.t(workspaceWorkbenchDesktopI18nKeys.windowControls.close),
      tone: "close",
      onClick: windowActions.close
    }),
    createElement(WorkspaceWorkbenchTrafficLightButton, {
      label: i18n.t(workspaceWorkbenchDesktopI18nKeys.windowControls.minimize),
      tone: "minimize",
      onClick: windowActions.minimize
    }),
    createElement(WorkspaceWorkbenchTrafficLightButton, {
      label: i18n.t(
        isFullscreen
          ? workspaceWorkbenchDesktopI18nKeys.windowControls.restore
          : workspaceWorkbenchDesktopI18nKeys.windowControls.maximize
      ),
      pressed: isFullscreen,
      tone: "maximize",
      onClick: windowActions.toggleDisplayMode
    })
  );
}

function WorkspaceWorkbenchTrafficLightButton({
  label,
  onClick,
  pressed,
  tone
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  tone: WorkspaceWorkbenchTrafficLightTone;
}): React.JSX.Element {
  const iconName =
    tone === "maximize" ? (pressed ? "unfullscreen" : "fullscreen") : tone;
  const button = createElement(
    "button",
    {
      "aria-label": label,
      "aria-pressed": pressed,
      className: cn(
        "relative -m-1 inline-flex size-5 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 opacity-[0.78] outline-none transition-opacity duration-150 before:absolute before:inset-1 before:rounded-full before:bg-[color-mix(in_srgb,var(--text-tertiary)_72%,transparent)] before:content-[''] group-hover/traffic-lights:opacity-100 group-focus-within/traffic-lights:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background-panel)]",
        tone === "close" &&
          "group-hover/traffic-lights:before:bg-[#ff5f57] group-focus-within/traffic-lights:before:bg-[#ff5f57]",
        tone === "minimize" &&
          "group-hover/traffic-lights:before:bg-[#ffbd2e] group-focus-within/traffic-lights:before:bg-[#ffbd2e]",
        tone === "maximize" &&
          "group-hover/traffic-lights:before:bg-[#28c840] group-focus-within/traffic-lights:before:bg-[#28c840]"
      ),
      "data-workspace-workbench-traffic-light": tone,
      type: "button",
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onClick();
      },
      onDoubleClick: (event) => event.stopPropagation(),
      onPointerDown: (event) => event.stopPropagation()
    },
    createElement(WorkspaceWorkbenchTrafficLightIcon, {
      "aria-hidden": "true",
      className:
        "pointer-events-none absolute inset-[5px] z-[1] size-[10px] text-[color-mix(in_srgb,#000_68%,transparent)] opacity-0 transition-opacity duration-150 group-hover/traffic-lights:opacity-100 group-focus-within/traffic-lights:opacity-100",
      "data-workspace-workbench-traffic-light-icon": iconName,
      iconName
    } as SVGProps<SVGSVGElement> &
      HTMLAttributes<SVGSVGElement> & {
        iconName: "close" | "fullscreen" | "minimize" | "unfullscreen";
      })
  );

  return button;
}

function WorkspaceWorkbenchTrafficLightIcon({
  className,
  iconName,
  ...props
}: SVGProps<SVGSVGElement> & {
  iconName: "close" | "fullscreen" | "minimize" | "unfullscreen";
}): React.JSX.Element {
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
