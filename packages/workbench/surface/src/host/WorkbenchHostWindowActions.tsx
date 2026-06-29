import type { WorkbenchWindowActionContext } from "../react/types.ts";
import { WorkbenchWindowTrafficLights } from "../react/WorkbenchWindowTrafficLights.tsx";
import type {
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition
} from "./types.ts";
import type { WorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

export function WorkbenchHostWindowActions({
  context,
  host,
  i18n,
  nodeDefinitions
}: {
  context: WorkbenchWindowActionContext<WorkbenchHostNodeData>;
  host: WorkbenchHostHandle;
  i18n: WorkbenchHostI18nRuntime;
  nodeDefinitions: Map<string, WorkbenchHostNodeDefinition>;
}) {
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
