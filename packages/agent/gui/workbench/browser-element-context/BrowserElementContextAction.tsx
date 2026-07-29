import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  InspectIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import { useActiveBrowserNodeWebview } from "@tutti-os/browser-node/react";
import { useEngineSelector } from "../../shared/engine/useEngineSelector.ts";
import { BrowserElementContextSelectionController } from "./browserElementContextSelectionController.ts";

export interface BrowserElementContextCopy {
  cancel: string;
  failed: string;
  select: string;
}

export function BrowserElementContextAction({
  copy,
  onAppendMention,
  onError,
  workspaceId
}: {
  copy: BrowserElementContextCopy;
  onAppendMention: (mention: string) => void;
  onError: (message: string) => void;
  workspaceId: string;
}): ReactNode {
  const activeWebview = useActiveBrowserNodeWebview();
  const [controller] = useState(
    () =>
      new BrowserElementContextSelectionController({
        failedCopy: copy.failed,
        onAppendMention,
        onError,
        workspaceId
      })
  );
  controller.configure({
    failedCopy: copy.failed,
    onAppendMention,
    onError,
    workspaceId
  });
  const state = useEngineSelector(controller, (snapshot) => snapshot.state);
  const bindAction = useCallback(
    (node: HTMLButtonElement | null) =>
      controller.bindAction(node, activeWebview),
    [activeWebview, controller]
  );
  const label = state === "selecting" ? copy.cancel : copy.select;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={state === "selecting"}
          className={cn(
            "nodrag shrink-0 rounded-md",
            state === "selecting" &&
              "bg-[var(--transparency-block)] text-[var(--text-primary)]"
          )}
          size="icon-sm"
          ref={bindAction}
          type="button"
          variant="chrome"
          onClick={() => controller.toggle(activeWebview)}
        >
          <InspectIcon className="size-[15px]" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
