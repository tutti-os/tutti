import { useCallback, type JSX, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "../../../app/renderer/components/ui/context-menu";
import { copyImageToClipboard } from "../lib/copyImageToClipboard";
import { translate } from "../../../i18n/index";

export function ConversationImageContextMenu({
  src,
  children
}: {
  src: string;
  children: ReactNode;
}): JSX.Element {
  const handleCopy = useCallback(() => {
    void copyImageToClipboard(src);
  }, [src]);
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopy}>
          {translate("agentHost.agentGui.copyImage")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
