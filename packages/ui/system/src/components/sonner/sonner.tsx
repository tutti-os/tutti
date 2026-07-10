import type * as React from "react";
import {
  Toaster as SonnerToaster,
  toast,
  type ExternalToast,
  type ToasterProps
} from "sonner";

import {
  FailedFilledIcon,
  LoadingIcon,
  SuccessFilledIcon,
  WarningFilledIcon,
  WarningLinedIcon
} from "#icons/system-icons";

function Toaster({ toastOptions, style, ...props }: ToasterProps) {
  return (
    <SonnerToaster
      closeButton
      expand={false}
      gap={8}
      position="top-right"
      visibleToasts={4}
      icons={{
        error: <FailedFilledIcon className="size-4" />,
        info: <WarningLinedIcon className="size-4" />,
        loading: <LoadingIcon className="size-4 animate-spin" />,
        success: <SuccessFilledIcon className="size-4" />,
        warning: <WarningFilledIcon className="size-4" />
      }}
      style={
        {
          "--normal-bg": "var(--background-fronted)",
          "--normal-border": "var(--line-2)",
          "--normal-text": "var(--text-primary)",
          "--border-radius": "8px",
          zIndex: "var(--z-toast)",
          ...style
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast:
            "group pointer-events-auto min-h-14 rounded-[8px] border border-[var(--line-2)] bg-[var(--background-fronted)] p-3 text-[var(--text-primary)] shadow-[0_14px_40px_var(--shadow-elevated)]",
          title: "text-[13px] font-medium leading-5 text-[var(--text-primary)]",
          description:
            "mt-0.5 text-[11px] leading-[1.3] text-[var(--text-secondary)]",
          actionButton:
            "h-7 rounded-[6px] bg-[var(--text-primary)] px-2.5 text-[11px] font-normal text-[var(--text-inverted)] transition-colors hover:bg-[var(--text-primary-hover)]",
          cancelButton:
            "h-7 rounded-[6px] bg-[var(--transparency-block)] px-2.5 text-[11px] font-normal text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)]",
          closeButton:
            "border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]",
          icon: "text-[var(--accent)]",
          ...toastOptions?.classNames
        }
      }}
      {...props}
    />
  );
}

export { Toaster, toast };
export type { ExternalToast, ToasterProps };
