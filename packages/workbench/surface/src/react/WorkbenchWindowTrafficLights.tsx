import type { HTMLAttributes, MouseEvent, PointerEvent } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@tutti-os/ui-system";

type WorkbenchWindowTrafficLightTone = "close" | "minimize" | "maximize";

export interface WorkbenchWindowTrafficLightAction {
  disabled?: boolean;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  pressed?: boolean;
}

export interface WorkbenchWindowTrafficLightsProps extends HTMLAttributes<HTMLDivElement> {
  close?: WorkbenchWindowTrafficLightAction | null;
  maximize?: WorkbenchWindowTrafficLightAction | null;
  minimize?: WorkbenchWindowTrafficLightAction | null;
}

export function WorkbenchWindowTrafficLights({
  className,
  close,
  maximize,
  minimize,
  onDoubleClick,
  onPointerDown,
  ...props
}: WorkbenchWindowTrafficLightsProps) {
  return (
    <div
      {...props}
      className={["workbench-window-traffic-lights", className ?? null]
        .filter(Boolean)
        .join(" ")}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleClick?.(event);
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
    >
      {close ? (
        <WorkbenchWindowTrafficLightButton
          action="close"
          input={close}
          tone="close"
        />
      ) : null}
      {minimize ? (
        <WorkbenchWindowTrafficLightButton
          action="minimize"
          input={minimize}
          tone="minimize"
        />
      ) : null}
      {maximize ? (
        <WorkbenchWindowTrafficLightButton
          action="fullscreen"
          input={maximize}
          tone="maximize"
        />
      ) : null}
    </div>
  );
}

function WorkbenchWindowTrafficLightButton({
  action,
  input,
  tone
}: {
  action: "close" | "fullscreen" | "minimize";
  input: WorkbenchWindowTrafficLightAction;
  tone: WorkbenchWindowTrafficLightTone;
}) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (input.disabled) {
      return;
    }
    input.onClick(event);
  };
  const stopPointer = (event: PointerEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
  };

  const button = (
    <button
      aria-label={input.label}
      aria-pressed={input.pressed}
      className="workbench-window-traffic-light"
      data-workbench-action={action}
      data-workbench-traffic-light={tone}
      disabled={input.disabled}
      type="button"
      onClick={handleClick}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={stopPointer}
    />
  );

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="bottom">{input.label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
