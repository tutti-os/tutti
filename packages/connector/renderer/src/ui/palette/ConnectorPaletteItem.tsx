import { LinkIcon } from "@tutti-os/ui-system";
import { cn } from "@tutti-os/ui-system/utils";
import { useState } from "react";

export type ConnectorPaletteItemStatus =
  | "connected"
  | "setup_required"
  | "unsupported";

export interface ConnectorPaletteItemModel {
  connectorKey: string;
  description?: string;
  iconUrl?: string;
  label: string;
  status: ConnectorPaletteItemStatus;
}

export interface ConnectorPaletteItemLabels {
  connected: string;
  notConnected: string;
  unsupported: string;
}

export interface ConnectorPaletteItemProps {
  item: ConnectorPaletteItemModel;
  labels: ConnectorPaletteItemLabels;
  onSetup(): void;
}

/** Connector-owned content rendered inside a host palette option row. */
export function ConnectorPaletteItem({
  item,
  labels,
  onSetup
}: ConnectorPaletteItemProps): React.JSX.Element {
  const statusLabel =
    item.status === "connected"
      ? labels.connected
      : item.status === "unsupported"
        ? labels.unsupported
        : labels.notConnected;

  return (
    <>
      <span
        aria-hidden="true"
        className="flex w-4 shrink-0 items-center justify-center self-center text-[var(--text-secondary)]"
      >
        <ConnectorPaletteIcon iconUrl={item.iconUrl} />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-[8px] overflow-hidden leading-[16px]">
        <span className="flex min-w-0 max-w-[48%] shrink-0 items-center gap-[8px] overflow-hidden">
          <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
            {item.label}
          </span>
        </span>
        {item.description ? (
          <span className="min-w-0 flex-1 truncate text-[13px] font-normal text-[var(--text-secondary)]">
            {item.description}
          </span>
        ) : null}
      </span>
      {item.status === "setup_required" ? (
        <button
          aria-label={statusLabel}
          className="nodrag ml-1 flex h-5 min-h-5 shrink-0 items-center rounded-[4px] border-0 bg-[var(--transparency-hover)] px-2 py-0 text-[11px] font-semibold leading-[14px] text-[var(--text-secondary)] outline-none transition-colors duration-150 hover:bg-[var(--transparency-active)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--agent-gui-focus-ring,var(--border-focus))]"
          title={statusLabel}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSetup();
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {statusLabel}
        </button>
      ) : (
        <span
          className={cn(
            "ml-1 shrink-0 text-[11px] font-medium",
            item.status === "connected"
              ? "text-[var(--state-success)]"
              : "text-[var(--text-secondary)]"
          )}
        >
          {statusLabel}
        </span>
      )}
    </>
  );
}

function ConnectorPaletteIcon({
  iconUrl
}: {
  iconUrl?: string;
}): React.JSX.Element {
  const normalizedIconUrl = iconUrl?.trim() ?? "";
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const showBrandIcon =
    normalizedIconUrl.length > 0 && failedIconUrl !== normalizedIconUrl;

  return (
    <span className="flex size-4 items-center justify-center">
      {showBrandIcon ? (
        <img
          alt=""
          aria-hidden="true"
          className="size-4 rounded-[3px] object-contain"
          src={normalizedIconUrl}
          onError={() => setFailedIconUrl(normalizedIconUrl)}
        />
      ) : (
        <LinkIcon aria-hidden className="size-4" />
      )}
    </span>
  );
}
