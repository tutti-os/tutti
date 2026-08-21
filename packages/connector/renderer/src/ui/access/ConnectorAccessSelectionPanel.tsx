import type { JSX } from "react";
import {
  ArrowLeftIcon,
  Avatar,
  Button,
  Checkbox,
  Spinner,
  cn
} from "@tutti-os/ui-system";

export interface ConnectorAccessSelectionItem {
  connectorKey: string;
  description?: string;
  disabled?: boolean;
  iconUrl?: string;
  name: string;
}

export type ConnectorAccessSelectionState =
  | { status: "loading" }
  | { status: "error" }
  | {
      items: readonly ConnectorAccessSelectionItem[];
      status: "ready";
    };

export interface ConnectorAccessSelectionPanelLabels {
  back: string;
  cancel: string;
  confirm: string;
  description: string;
  empty: string;
  error: string;
  loading: string;
  title: string;
}

export interface ConnectorAccessSelectionPanelProps {
  busy?: boolean;
  disabled?: boolean;
  labels: ConnectorAccessSelectionPanelLabels;
  onBack(): void;
  onCancel(): void;
  onSelectionChange(connectorKeys: string[]): void;
  onSubmit(): void;
  selectedConnectorKeys: readonly string[];
  state: ConnectorAccessSelectionState;
}

/**
 * Host-neutral controlled selector for choosing Connector access. The host
 * retains catalog, authorization, admission, persistence, and copy ownership.
 */
export function ConnectorAccessSelectionPanel({
  busy = false,
  disabled = false,
  labels,
  onBack,
  onCancel,
  onSelectionChange,
  onSubmit,
  selectedConnectorKeys,
  state
}: ConnectorAccessSelectionPanelProps): JSX.Element {
  const selectedConnectorKeySet = new Set(selectedConnectorKeys);
  const interactionsDisabled = disabled || busy;

  const changeSelection = (connectorKey: string, selected: boolean): void => {
    const nextSelection = new Set(selectedConnectorKeys);
    if (selected) {
      nextSelection.add(connectorKey);
    } else {
      nextSelection.delete(connectorKey);
    }
    onSelectionChange(Array.from(nextSelection));
  };

  return (
    <section
      aria-busy={busy}
      aria-disabled={disabled || undefined}
      aria-label={labels.title}
      className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
    >
      <header className="pb-3">
        <div className="flex items-center gap-1">
          <Button
            aria-label={labels.back}
            disabled={interactionsDisabled}
            onClick={onBack}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeftIcon aria-hidden className="size-4" />
          </Button>
          <h2 className="m-0 min-w-0 truncate text-sm font-semibold leading-5 text-[var(--text-primary)]">
            {labels.title}
          </h2>
        </div>
        <p className="mb-0 mt-1 text-[11px] leading-[1.4] text-[var(--text-secondary)]">
          {labels.description}
        </p>
      </header>

      <div className="min-h-0 overflow-y-auto">
        {state.status === "loading" ? (
          <div
            aria-label={labels.loading}
            className="flex min-h-20 items-center justify-center"
            role="status"
          >
            <Spinner size={16} />
          </div>
        ) : state.status === "error" ? (
          <div
            className="rounded-md border border-dashed border-[var(--border-1)] px-3 py-4 text-xs text-[var(--text-secondary)]"
            role="alert"
          >
            {labels.error}
          </div>
        ) : state.items.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--border-1)] px-3 py-4 text-xs text-[var(--text-secondary)]">
            {labels.empty}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {state.items.map((item) => {
              const checked = selectedConnectorKeySet.has(item.connectorKey);
              const itemDisabled =
                interactionsDisabled || item.disabled === true;

              return (
                <label
                  aria-disabled={itemDisabled || undefined}
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left",
                    itemDisabled
                      ? "cursor-not-allowed opacity-60"
                      : "cursor-pointer hover:bg-[var(--transparency-hover)]"
                  )}
                  key={item.connectorKey}
                >
                  <Avatar
                    aria-hidden="true"
                    className="text-[10px]"
                    label={item.name}
                    size={28}
                    src={item.iconUrl}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
                      {item.name}
                    </span>
                    {item.description ? (
                      <span className="block truncate text-[11px] text-[var(--text-secondary)]">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                  <Checkbox
                    aria-label={item.name}
                    checked={checked}
                    disabled={itemDisabled}
                    onCheckedChange={(nextChecked) =>
                      changeSelection(item.connectorKey, nextChecked === true)
                    }
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>

      <footer className="pt-3">
        <div className="flex justify-end gap-2">
          <Button
            disabled={interactionsDisabled}
            onClick={onCancel}
            size="dialog"
            type="button"
            variant="ghost"
          >
            {labels.cancel}
          </Button>
          <Button
            aria-busy={busy}
            disabled={interactionsDisabled}
            onClick={onSubmit}
            size="dialog"
            type="button"
          >
            {busy ? <Spinner size={14} /> : null}
            {labels.confirm}
          </Button>
        </div>
      </footer>
    </section>
  );
}
