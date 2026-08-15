import { useState } from "react";
import {
  Badge,
  Button,
  CheckIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  LinkIcon,
  OpenLinkLinedIcon
} from "@tutti-os/ui-system";
import { cn } from "@tutti-os/ui-system/utils";

const QUICK_CONNECTOR_LIMIT = 10;
const CONNECTOR_PREVIEW_LIMIT = 3;

export type ConnectorComposerItemStatus =
  | "authorization_required"
  | "connected"
  | "setup_required";

export interface ConnectorComposerItem {
  connectorKey: string;
  iconUrl?: string;
  name: string;
  status: ConnectorComposerItemStatus;
}

export interface ConnectorComposerMenuLabels {
  authorize: string;
  connect: string;
  connected: string;
  connectors: string;
  empty: string;
  more: string;
}

export interface ConnectorComposerMenuProps {
  disabled?: boolean;
  items: readonly ConnectorComposerItem[];
  labels: ConnectorComposerMenuLabels;
  onOpenChange?: (open: boolean) => void;
  onOpenConnector: (connectorKey: string) => void;
  onOpenMarket: () => void;
}

/**
 * Host-neutral Connector entry for compact composers. Hosts provide the
 * authoritative item projection and route the two semantic open intents.
 */
export function ConnectorComposerMenu({
  disabled = false,
  items,
  labels,
  onOpenChange,
  onOpenConnector,
  onOpenMarket
}: ConnectorComposerMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const normalizedItems = normalizeConnectorItems(items);
  const quickItems = normalizedItems.slice(0, QUICK_CONNECTOR_LIMIT);
  const connectedItems = normalizedItems.filter(
    (item) => item.status === "connected"
  );
  const previewItems = connectedItems.slice(0, CONNECTOR_PREVIEW_LIMIT);
  const additionalConnectorCount = connectedItems.length - previewItems.length;
  const closeAndRun = (action: () => void): void => {
    setOpen(false);
    action();
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={labels.connectors}
          className="w-auto rounded-full px-1.5"
          data-testid="connector-market-composer-trigger"
          disabled={disabled}
          size="sm"
          type="button"
          variant="outline"
        >
          {previewItems.length > 0 ? (
            <>
              <span className="inline-flex items-center gap-0.5">
                {previewItems.map((item) => (
                  <ConnectorComposerIcon
                    key={item.connectorKey}
                    iconUrl={item.iconUrl}
                    label={item.name}
                    testId={`connector-market-composer-preview-${item.connectorKey}`}
                  />
                ))}
              </span>
              {additionalConnectorCount > 0 ? (
                <Badge
                  className="h-[18px] min-w-[18px] rounded-full px-1 text-[10px] font-medium"
                  data-testid="connector-market-composer-preview-count"
                  size="sm"
                  variant="muted"
                >
                  +{additionalConnectorCount}
                </Badge>
              ) : null}
            </>
          ) : (
            <>
              <LinkIcon aria-hidden className="size-4" />
              <span>{labels.connectors}</span>
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[300px] max-w-[calc(100vw-24px)] p-1.5"
        side="top"
        sideOffset={8}
      >
        {quickItems.length > 0 ? (
          quickItems.map((item) => {
            const connected = item.status === "connected";
            const actionLabel =
              item.status === "authorization_required"
                ? labels.authorize
                : labels.connect;
            return (
              <DropdownMenuItem
                key={item.connectorKey}
                aria-disabled={connected}
                className="min-h-9 gap-2.5 px-2.5"
                data-testid={`connector-market-composer-item-${item.connectorKey}`}
                onSelect={(event) => {
                  event.preventDefault();
                  if (!connected) {
                    closeAndRun(() => onOpenConnector(item.connectorKey));
                  }
                }}
              >
                <ConnectorComposerIcon
                  iconUrl={item.iconUrl}
                  label={item.name}
                />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {connected ? (
                  <span
                    className="ml-auto inline-flex shrink-0 items-center gap-1 pl-3 text-xs text-[var(--success)]"
                    data-testid={`connector-market-composer-status-${item.connectorKey}`}
                  >
                    <CheckIcon aria-hidden className="size-4" />
                    {labels.connected}
                  </span>
                ) : (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1 pl-3 text-xs text-[var(--text-primary)]">
                    <LinkIcon aria-hidden className="size-4" />
                    {actionLabel}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })
        ) : (
          <div className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">
            {labels.empty}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="min-h-9 gap-2.5 px-2.5"
          data-testid="connector-market-composer-more"
          onSelect={(event) => {
            event.preventDefault();
            closeAndRun(onOpenMarket);
          }}
        >
          <OpenLinkLinedIcon aria-hidden className="size-4" />
          <span>{labels.more}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function normalizeConnectorItems(
  items: readonly ConnectorComposerItem[]
): ConnectorComposerItem[] {
  const normalizedItems: ConnectorComposerItem[] = [];
  const seenConnectorKeys = new Set<string>();
  for (const item of items) {
    const connectorKey = item.connectorKey.trim();
    if (!connectorKey || seenConnectorKeys.has(connectorKey)) {
      continue;
    }
    seenConnectorKeys.add(connectorKey);
    normalizedItems.push({ ...item, connectorKey });
  }
  return normalizedItems;
}

function ConnectorComposerIcon({
  iconUrl,
  label,
  testId
}: {
  iconUrl?: string;
  label: string;
  testId?: string;
}): React.JSX.Element {
  const normalizedIconUrl = iconUrl?.trim() ?? "";
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  if (normalizedIconUrl && failedIconUrl !== normalizedIconUrl) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className="size-4 shrink-0 rounded-[3px] object-contain"
        data-testid={testId}
        src={normalizedIconUrl}
        onError={() => setFailedIconUrl(normalizedIconUrl)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[3px]",
        "bg-[var(--background-tertiary)] text-[10px] font-medium text-[var(--text-secondary)]"
      )}
      data-testid={testId}
    >
      {label.trim().charAt(0).toLocaleUpperCase() || "?"}
    </span>
  );
}
