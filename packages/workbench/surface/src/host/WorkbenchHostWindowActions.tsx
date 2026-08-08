import { memo } from "react";
import type { WorkbenchWindowActionContext } from "../react/types.ts";
import { WorkbenchWindowTrafficLights } from "../react/WorkbenchWindowTrafficLights.tsx";
import type {
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition
} from "./types.ts";
import type { WorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

interface WorkbenchHostWindowActionsProps {
  context: WorkbenchWindowActionContext<WorkbenchHostNodeData>;
  host: WorkbenchHostHandle;
  i18n: WorkbenchHostI18nRuntime;
  nodeDefinitions: Map<string, WorkbenchHostNodeDefinition>;
}

function WorkbenchHostWindowActionsComponent({
  context,
  host,
  i18n,
  nodeDefinitions
}: WorkbenchHostWindowActionsProps) {
  const definition = nodeDefinitions.get(context.node.data.typeId);
  if (!definition) {
    return null;
  }

  const minimizable = definition.window?.minimizable !== false;
  const closable = definition.window?.closable !== false;

  return (
    <WorkbenchWindowTrafficLights
      close={
        closable
          ? {
              label: i18n.t("actions.close"),
              onClick: () => {
                host.requestNodeClose(context.node.id);
              }
            }
          : null
      }
      minimize={
        minimizable
          ? {
              label: i18n.t("actions.minimize"),
              onClick: () => {
                context.genie.minimizeNodeToAnchor(context.node.id, () =>
                  context.controller.commands.minimizeNode(context.node.id)
                );
              }
            }
          : null
      }
    />
  );
}

function areWorkbenchHostWindowActionsPropsEqual(
  previous: WorkbenchHostWindowActionsProps,
  next: WorkbenchHostWindowActionsProps
): boolean {
  return (
    previous.host === next.host &&
    previous.i18n === next.i18n &&
    previous.nodeDefinitions === next.nodeDefinitions &&
    previous.context.controller === next.context.controller &&
    previous.context.genie === next.context.genie &&
    previous.context.node.id === next.context.node.id &&
    previous.context.node.data.typeId === next.context.node.data.typeId
  );
}

export const WorkbenchHostWindowActions = memo(
  WorkbenchHostWindowActionsComponent,
  areWorkbenchHostWindowActionsPropsEqual
);
