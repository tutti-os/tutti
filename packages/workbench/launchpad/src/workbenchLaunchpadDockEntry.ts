import { createElement, type ReactNode } from "react";
import type { WorkbenchHostDockEntry } from "@tutti-os/workbench-surface";
import {
  workbenchLaunchpadDockActionId,
  workbenchLaunchpadDockEntryId
} from "./launchpadModel.ts";

export function createWorkbenchLaunchpadDockIcon(input: {
  tileIconUrls: readonly string[];
}): ReactNode {
  return createElement(
    "span",
    {
      "aria-hidden": "true",
      className: "workspace-launchpad-dock-icon"
    },
    input.tileIconUrls.map((src, index) =>
      createElement(
        "span",
        {
          className: "workspace-launchpad-dock-icon__tile",
          key: `${src}:${index}`
        },
        createElement("img", {
          alt: "",
          draggable: false,
          src
        })
      )
    )
  );
}

export function createWorkbenchLaunchpadDockEntry(input: {
  label: string;
  order?: number;
  tileIconUrls: readonly string[];
}): WorkbenchHostDockEntry {
  return {
    clickActionId: workbenchLaunchpadDockActionId,
    icon: createWorkbenchLaunchpadDockIcon({
      tileIconUrls: input.tileIconUrls
    }),
    id: workbenchLaunchpadDockEntryId,
    label: input.label,
    launchBehavior: "enabled",
    order: input.order ?? 0,
    sectionId: "launchpad",
    typeId: workbenchLaunchpadDockEntryId,
    visibility: "always"
  };
}
