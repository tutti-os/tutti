import { useComposedInputValue } from "@tutti-os/ui-react-hooks";
import {
  Button,
  ConfirmationDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input
} from "@tutti-os/ui-system";
import type { ReactElement } from "react";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import type { WorkspaceFileManagerHostFallbackAction } from "./workspaceFileManagerHostTypes.ts";

export function WorkspaceFileManagerCreateDialog({
  busy,
  copy,
  dialog,
  onClose,
  onConfirm,
  onNameChange
}: {
  busy: boolean;
  copy: WorkspaceFileManagerI18nRuntime;
  dialog: {
    errorMessage: string | null;
    kind: "directory" | "file";
    name: string;
  } | null;
  onClose: () => void;
  onConfirm: () => void;
  onNameChange: (name: string) => void;
}): ReactElement | null {
  const nameInput = useComposedInputValue({
    onCommit: onNameChange,
    value: dialog?.name ?? ""
  });

  if (!dialog) {
    return null;
  }

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent aria-busy={busy} showCloseButton={false}>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || nameInput.isComposing) {
              return;
            }
            onConfirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {dialog.kind === "directory"
                ? copy.t("createDirectoryLabel")
                : copy.t("createFileLabel")}
            </DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={
              dialog.kind === "directory"
                ? copy.t("createDirectoryPlaceholder")
                : copy.t("createFilePlaceholder")
            }
            value={nameInput.value}
            onBlur={nameInput.onBlur}
            onChange={nameInput.onChange}
            onCompositionEnd={nameInput.onCompositionEnd}
            onCompositionStart={nameInput.onCompositionStart}
          />
          {dialog.errorMessage ? (
            <p className="text-[13px] text-[var(--state-danger)]">
              {dialog.errorMessage}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={busy}
              size="dialog"
              type="button"
              variant="ghost"
              onClick={onClose}
            >
              {copy.t("cancelLabel")}
            </Button>
            <Button disabled={busy} size="dialog" type="submit">
              {copy.t("createActionLabel")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceFileManagerDeleteDialog({
  busy,
  copy,
  entry,
  onClose,
  onConfirm
}: {
  busy: boolean;
  copy: WorkspaceFileManagerI18nRuntime;
  entry: WorkspaceFileEntry | null;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement | null {
  if (!entry) {
    return null;
  }

  return (
    <ConfirmationDialog
      cancelLabel={copy.t("cancelLabel")}
      confirmBusy={busy}
      confirmLabel={busy ? copy.t("deletingLabel") : copy.t("deleteLabel")}
      description={copy.t("deleteConfirmDescription", { name: entry.name })}
      open
      title={copy.t("deleteLabel")}
      tone="destructive"
      onConfirm={onConfirm}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    />
  );
}

export function WorkspaceFileManagerUnsupportedDialog({
  copy,
  dialog,
  isViewing,
  onAction,
  onClose
}: {
  copy: WorkspaceFileManagerI18nRuntime;
  dialog: {
    actions?: WorkspaceFileManagerHostFallbackAction[] | null;
    message?: string | null;
    title?: string | null;
    entry?: WorkspaceFileEntry;
  } | null;
  isViewing: boolean;
  onAction: (action: WorkspaceFileManagerHostFallbackAction) => void;
  onClose: () => void;
}): ReactElement | null {
  if (!dialog) {
    return null;
  }

  const title = dialog.title ?? copy.t("unsupportedViewTitle");
  const body =
    dialog.message ??
    copy.t("unsupportedViewBody", { name: dialog.entry?.name ?? "" });
  const actions =
    dialog.actions?.filter((action) => action.kind !== "none") ?? [];

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (isViewing) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isViewing) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            disabled={isViewing}
            size="dialog"
            type="button"
            variant="ghost"
            onClick={onClose}
          >
            {copy.t("closeLabel")}
          </Button>
          {actions.map((action) => (
            <Button
              key={action.kind}
              disabled={isViewing}
              size="dialog"
              type="button"
              className="shadow-none"
              onClick={() => {
                onAction(action);
              }}
            >
              {action.label ??
                (action.kind === "download"
                  ? copy.t("downloadLabel")
                  : copy.t("openLabel"))}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
