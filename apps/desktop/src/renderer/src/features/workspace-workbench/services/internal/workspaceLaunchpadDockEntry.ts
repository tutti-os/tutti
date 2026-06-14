import { createElement } from "react";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import type { WorkbenchHostDockEntry } from "@tutti-os/workbench-surface";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import {
  workspaceLaunchpadDockActionId,
  workspaceLaunchpadDockEntryId
} from "./workspaceLaunchpadModel.ts";

const workspaceDockAgentGeminiUrl = new URL(
  "../../../../assets/workspace-canvas/dock/default/gemini.png",
  import.meta.url
).href;
const workspaceDockAgentNexightUrl = new URL(
  "../../../../assets/workspace-canvas/dock/default/tutti.png",
  import.meta.url
).href;
const workspaceDockAgentOpenclawUrl = new URL(
  "../../../../assets/workspace-canvas/dock/default/openclaw.png",
  import.meta.url
).href;
const workspaceDockAgentHermesUrl = new URL(
  "../../../../assets/workspace-canvas/dock/default/hermes.png",
  import.meta.url
).href;
export function createWorkspaceLaunchpadDockEntry(input: {
  agentStatuses: readonly AgentProviderStatus[];
  apps: readonly WorkspaceAppCenterApp[];
  fallbackIconUrl: string;
  label: string;
  tileIconUrls?: readonly string[];
}): WorkbenchHostDockEntry {
  return {
    clickActionId: workspaceLaunchpadDockActionId,
    icon: createWorkspaceLaunchpadDockIcon(
      input.tileIconUrls ?? [
        workspaceDockAgentNexightUrl,
        workspaceDockAgentHermesUrl,
        workspaceDockAgentOpenclawUrl,
        workspaceDockAgentGeminiUrl
      ]
    ),
    id: workspaceLaunchpadDockEntryId,
    label: input.label,
    launchBehavior: "enabled",
    order: 0,
    sectionId: "launchpad",
    typeId: workspaceLaunchpadDockEntryId,
    visibility: "always"
  };
}

function createWorkspaceLaunchpadDockIcon(iconUrls: readonly string[]) {
  return createElement(
    "span",
    {
      "aria-hidden": "true",
      className: "workspace-launchpad-dock-icon"
    },
    iconUrls.map((src, index) =>
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
