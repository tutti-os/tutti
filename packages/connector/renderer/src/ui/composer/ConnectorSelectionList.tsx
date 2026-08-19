import { Avatar, CloseIcon } from "@tutti-os/ui-system";

export interface ConnectorSelectionItem {
  connectorKey: string;
  iconUrl?: string;
  name: string;
}

export interface ConnectorSelectionListProps {
  items: readonly ConnectorSelectionItem[];
  removeLabel: string;
  onRemove(connectorKey: string): void;
}

/** Host-neutral compact selection chips for a Connector-enabled composer. */
export function ConnectorSelectionList({
  items,
  removeLabel,
  onRemove
}: ConnectorSelectionListProps): React.JSX.Element | null {
  if (items.length === 0) {
    return null;
  }

  return (
    <div
      className="mb-2 flex w-full max-w-full flex-wrap items-center gap-2"
      data-testid="agent-gui-composer-connector-drafts"
    >
      {items.map((item) => (
        <span
          key={item.connectorKey}
          className="inline-flex h-8 max-w-[240px] items-center gap-2 rounded-full border border-[var(--line-1)] bg-[var(--background-fronted)] py-1 pl-1 pr-2 text-xs text-[var(--text-primary)]"
          data-connector-key={item.connectorKey}
        >
          <Avatar
            aria-hidden="true"
            className="rounded-md"
            imageClassName="size-4 object-contain"
            label={item.name}
            size={24}
            src={item.iconUrl}
          />
          <span className="min-w-0 truncate font-medium">{item.name}</span>
          <button
            type="button"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)]"
            aria-label={removeLabel}
            title={removeLabel}
            onClick={() => onRemove(item.connectorKey)}
          >
            <CloseIcon aria-hidden className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
