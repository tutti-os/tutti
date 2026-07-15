import { useState, type JSX } from "react";
import {
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport
} from "@tutti-os/ui-system";

interface AgentGUIContentToastProps {
  insetTopPx: number;
  message: string;
}

export function AgentGUIContentToast({
  insetTopPx,
  message
}: AgentGUIContentToastProps): JSX.Element {
  const [open, setOpen] = useState(true);

  return (
    <ToastProvider>
      <ToastRoot
        open={open}
        className="nodrag tsh-desktop-no-drag z-30 border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-[0_10px_30px_var(--toast-shadow-color)] [-webkit-app-region:no-drag]"
        data-testid="agent-gui-content-toast"
        variant="default"
        onOpenChange={setOpen}
      >
        <ToastTitle>{message}</ToastTitle>
      </ToastRoot>
      <ToastViewport
        className="nodrag tsh-desktop-no-drag absolute left-0 w-full translate-x-0 px-4 [-webkit-app-region:no-drag]"
        data-testid="agent-gui-content-toast-viewport"
        style={{ top: `${insetTopPx}px` }}
      />
    </ToastProvider>
  );
}
