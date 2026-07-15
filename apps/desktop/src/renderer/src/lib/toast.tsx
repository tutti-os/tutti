import * as React from "react";
import { useExternalStoreSnapshot } from "@tutti-os/ui-react-hooks";
import {
  ToastDescription,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
  Toaster
} from "@tutti-os/ui-system";
import { enqueueDesktopToast, type DesktopToastItem } from "./toastQueue";

const toastLimit = 4;
const workspaceChromeHeightPx = 52;
const toastChromeGapPx = 8;
const desktopToastTopOffset = `${workspaceChromeHeightPx + toastChromeGapPx}px`;
const desktopSonnerToastClassName =
  "group pointer-events-auto flex min-h-14 w-[min(360px,calc(100vw-16px))] flex-col items-start !overflow-visible rounded-[8px] border border-[var(--line-2)] bg-[var(--background-fronted)] p-3 text-[var(--text-primary)] shadow-[0_14px_40px_var(--shadow-elevated)]";
const desktopSonnerActionButtonClassName =
  "!ml-auto !mr-0 mt-2 h-7 self-end rounded-[6px] bg-[var(--text-primary)] px-2.5 text-[11px] font-normal text-[var(--text-inverted)] transition-colors hover:bg-[var(--text-primary-hover)]";
const desktopSonnerCloseButtonClassName =
  "!top-0 !right-0 !left-auto border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-secondary)] !shadow-none [transform:translate(35%,-35%)!important] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]";
let nextToastID = 0;
let toasts: DesktopToastItem[] = [];
const listeners = new Set<() => void>();

export const Toast = {
  Error(title: string, description?: string): void {
    pushToast({
      description,
      title,
      tone: "destructive"
    });
  },
  Success(title: string, description?: string): void {
    pushToast({
      description,
      title,
      tone: "success"
    });
  },
  tips(title: string, description?: string): void {
    pushToast({
      description,
      title,
      tone: "default"
    });
  }
};

export function DesktopToastProvider({
  children
}: {
  children: React.ReactNode;
}) {
  const snapshot = useExternalStoreSnapshot({
    getSnapshot: getToastSnapshot,
    subscribe: subscribeToToasts
  });

  return (
    <ToastProvider swipeDirection="right">
      {children}
      <Toaster
        icons={{ info: null }}
        offset={{ top: desktopToastTopOffset }}
        toastOptions={{
          classNames: {
            actionButton: desktopSonnerActionButtonClassName,
            closeButton: desktopSonnerCloseButtonClassName,
            content: "w-full",
            toast: desktopSonnerToastClassName
          }
        }}
      />
      {snapshot.map((toast) => (
        <ToastRoot
          key={toast.id}
          variant={toast.tone}
          onOpenChange={(open) => {
            if (!open) {
              dismissToast(toast.id);
            }
          }}
        >
          <ToastTitle>{toast.title}</ToastTitle>
          {toast.description ? (
            <ToastDescription>{toast.description}</ToastDescription>
          ) : null}
        </ToastRoot>
      ))}
      <ToastViewport style={{ top: desktopToastTopOffset }} />
    </ToastProvider>
  );
}

function pushToast(input: Omit<DesktopToastItem, "id">): void {
  const id = `desktop-toast-${++nextToastID}`;
  const nextToasts = enqueueDesktopToast(toasts, { ...input, id }, toastLimit);
  if (nextToasts === toasts) {
    return;
  }
  toasts = nextToasts;
  emitToastChange();
}

function dismissToast(id: string): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emitToastChange();
}

function subscribeToToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getToastSnapshot(): DesktopToastItem[] {
  return toasts;
}

function emitToastChange(): void {
  for (const listener of listeners) {
    listener();
  }
}
