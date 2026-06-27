import {
  cloneElement,
  isValidElement,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactElement
} from "react";
import Zoom from "react-medium-image-zoom";
import { useTranslation } from "../../../i18n/index";
import { cn } from "../lib/utils";
import { ConversationImageContextMenu } from "../../../shared/agentConversation/components/ConversationImageContextMenu";

interface ZoomableImageProps extends ComponentPropsWithoutRef<"img"> {
  wrapElement?: "div" | "span";
}

export function ZoomableImage({
  className,
  wrapElement = "div",
  ...props
}: ZoomableImageProps): JSX.Element {
  const { t } = useTranslation();

  const renderZoomContent = ({
    buttonUnzoom,
    img
  }: {
    buttonUnzoom: ReactElement<HTMLButtonElement>;
    img: ReactElement | null;
  }): JSX.Element => {
    const zoomSrc =
      isValidElement(img) &&
      typeof (img.props as { src?: unknown }).src === "string"
        ? (img.props as { src: string }).src
        : null;
    return (
      <>
        {img && zoomSrc ? (
          <ConversationImageContextMenu
            src={zoomSrc}
            asChild
            contentStyle={{ zIndex: "var(--z-dialog-popover)" }}
          >
            {img}
          </ConversationImageContextMenu>
        ) : (
          img
        )}
        {cloneElement(buttonUnzoom, {
          className: cn(
            buttonUnzoom.props.className,
            "nodrag tsh-desktop-no-drag"
          )
        })}
      </>
    );
  };

  return (
    <Zoom
      a11yNameButtonZoom={t("common.expandImage")}
      a11yNameButtonUnzoom={t("common.minimizeImage")}
      classDialog="tsh-zoom-dialog nodrag tsh-desktop-no-drag"
      wrapElement={wrapElement}
      zoomMargin={24}
      ZoomContent={renderZoomContent}
    >
      <img
        {...props}
        className={cn("nodrag tsh-desktop-no-drag cursor-zoom-in", className)}
      />
    </Zoom>
  );
}
