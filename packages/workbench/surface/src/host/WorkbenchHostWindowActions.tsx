import { Button, CloseIcon, MinimizeIcon } from "@tutti-os/ui-system";
import type { WorkbenchWindowActionContext } from "../react/types.ts";
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
    <>
      {minimizable ? (
        <Button
          aria-label={i18n.t("actions.minimize")}
          className="order-1 rounded-md"
          data-workbench-action="minimize"
          size="icon-sm"
          type="button"
          variant="chrome"
          onClick={() => {
            context.genie?.minimizeNodeToAnchor(context.node.id, () =>
              context.controller.commands.minimizeNode(context.node.id)
            );
          }}
        >
          <MinimizeIcon className="size-3.5" />
        </Button>
      ) : null}
      {closable ? (
        <Button
          aria-label={i18n.t("actions.close")}
          className="order-3 rounded-md"
          data-workbench-action="close"
          size="icon-sm"
          type="button"
          variant="chrome"
          onClick={() => {
            host.requestNodeClose(context.node.id);
          }}
        >
          <CloseIcon className="size-3.5" />
        </Button>
      ) : null}
    </>
  );
}
