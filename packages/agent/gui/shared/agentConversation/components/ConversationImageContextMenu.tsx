import {
  useCallback,
  type CSSProperties,
  type JSX,
  type ReactNode
} from "react";
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
  children,
  asChild = false,
  contentStyle
}: {
  src: string;
  children: ReactNode;
  /**
   * Attach the right-click listener directly to the child element instead of a
   * wrapper span. Used for the zoomed image, whose positioning the zoom library
   * manages and must not be disturbed by an extra wrapper element.
   */
  asChild?: boolean;
  /**
   * Override the menu content style. Used by the zoomed image to raise the
   * menu above the zoom modal (which sits above the default popover z-index).
   */
  contentStyle?: CSSProperties;
}): JSX.Element {
  const handleCopy = useCallback(() => {
    void copyImageToClipboard(src);
  }, [src]);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild={asChild}>{children}</ContextMenuTrigger>
      <ContextMenuContent style={contentStyle}>
        <ContextMenuItem onSelect={handleCopy}>
          {translate("agentHost.agentGui.copyImage")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
