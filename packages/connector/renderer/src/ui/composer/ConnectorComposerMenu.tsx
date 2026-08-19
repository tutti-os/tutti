import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  ConnectorLinedIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  LinkIcon,
  OpenLinkLinedIcon,
  Switch
} from "@tutti-os/ui-system";
import { cn } from "@tutti-os/ui-system/utils";

const QUICK_CONNECTOR_LIMIT = 10;
const CONNECTOR_PREVIEW_LIMIT = 3;

export type ConnectorComposerItemStatus =
  | "authorization_required"
  | "connected"
  | "setup_required"
  | "disabled"
  | "unsupported";

export interface ConnectorComposerItem {
  connectorKey: string;
  iconUrl?: string;
  name: string;
  /** Caller-localized, credential-free presentation detail or disabled reason. */
  description?: string;
  /** Composer-local selection; authorization remains represented by status. */
  selected?: boolean;
  status: ConnectorComposerItemStatus;
}

export interface ConnectorComposerMenuLabels {
  authorize: string;
  connect: string;
  connected: string;
  connectors: string;
  empty: string;
  loading: string;
  more: string;
  selected?: string;
}

export interface ConnectorComposerMenuProps {
  disabled?: boolean;
  items: readonly ConnectorComposerItem[];
  labels: ConnectorComposerMenuLabels;
  loading?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenConnector?: (connectorKey: string) => void;
  onOpenMarket?: () => void;
  onRuntimeEnabledChange?: (
    connectorKey: string,
    enabled: boolean
  ) => void | Promise<void>;
  onSelectConnector?: (connectorKey: string, selected: boolean) => void;
  /** Keeps the catalog inspectable while suppressing every mutation intent. */
  readOnly?: boolean;
}

/**
 * Host-neutral Connector entry for compact composers. Hosts provide the
 * authoritative item projection and route the two semantic open intents.
 */
export function ConnectorComposerMenu({
  disabled = false,
  items,
  labels,
  loading = false,
  onOpenChange,
  onOpenConnector,
  onOpenMarket,
  onRuntimeEnabledChange,
  onSelectConnector,
  readOnly = false
}: ConnectorComposerMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [runtimeIntents, setRuntimeIntents] = useState<
    Record<string, { desired: boolean; pending: boolean }>
  >({});
  const normalizedItems = normalizeConnectorItems(items);
  const quickItems = normalizedItems.slice(0, QUICK_CONNECTOR_LIMIT);
  const connectedItems = normalizedItems.filter(
    (item) => item.status === "connected"
  );
  const previewItems = connectedItems.slice(0, CONNECTOR_PREVIEW_LIMIT);
  const additionalConnectorCount = connectedItems.length - previewItems.length;
  const closeAndRun = (action: () => void): void => {
    setOpen(false);
    onOpenChange?.(false);
    action();
  };
  useEffect(() => {
    setRuntimeIntents((current) => {
      let next = current;
      for (const item of normalizedItems) {
        const intent = current[item.connectorKey];
        const enabled = item.status === "connected";
        if (!intent?.pending && intent?.desired === enabled) {
          if (next === current) {
            next = { ...current };
          }
          delete next[item.connectorKey];
        }
      }
      return next;
    });
  }, [items]);

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
              <ConnectorLinedIcon aria-hidden className="size-4" />
              <span>{labels.connectors}</span>
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[240px] max-w-[calc(100vw-24px)] p-1.5"
        side="top"
        sideOffset={8}
      >
        {quickItems.length > 0 ? (
          quickItems.map((item) => {
            const connected = item.status === "connected";
            const installed = connected || item.status === "disabled";
            const selected = connected && item.selected === true;
            const runtimeIntent = runtimeIntents[item.connectorKey];
            const runtimeEnabled = runtimeIntent?.desired ?? connected;
            const actionLabel =
              item.status === "authorization_required"
                ? labels.authorize
                : labels.connect;
            return (
              <div key={item.connectorKey} className="relative" role="none">
                <DropdownMenuItem
                  className={cn("min-h-9 gap-2.5 px-2.5", installed && "pr-14")}
                  data-testid={`connector-market-composer-item-${item.connectorKey}`}
                  data-selected={selected ? "true" : undefined}
                  disabled={
                    readOnly ||
                    (connected ? !onSelectConnector : !onOpenConnector)
                  }
                  onPointerDown={(event) => {
                    if (event.button !== 0 || event.ctrlKey) {
                      return;
                    }
                    event.preventDefault();
                    closeAndRun(() => {
                      if (connected) {
                        onSelectConnector?.(item.connectorKey, !selected);
                        return;
                      }
                      onOpenConnector?.(item.connectorKey);
                    });
                  }}
                  onSelect={(event) => {
                    event.preventDefault();
                    closeAndRun(() => {
                      if (connected) {
                        onSelectConnector?.(item.connectorKey, !selected);
                        return;
                      }
                      onOpenConnector?.(item.connectorKey);
                    });
                  }}
                >
                  <ConnectorComposerIcon
                    iconUrl={item.iconUrl}
                    label={item.name}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {!installed && !readOnly ? (
                    <div className="ml-auto inline-flex shrink-0 items-center gap-1 pl-3 text-xs text-[var(--text-primary)]">
                      <LinkIcon aria-hidden className="size-4" />
                      {actionLabel}
                    </div>
                  ) : null}
                </DropdownMenuItem>
                {installed ? (
                  <Switch
                    aria-label={item.name}
                    checked={runtimeEnabled}
                    className="absolute top-1/2 right-2.5 z-10 -translate-y-1/2"
                    data-testid={`connector-market-composer-status-${item.connectorKey}`}
                    disabled={
                      readOnly ||
                      !onRuntimeEnabledChange ||
                      runtimeIntent?.pending === true
                    }
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onCheckedChange={(nextEnabled) => {
                      if (!onRuntimeEnabledChange) {
                        return;
                      }
                      setRuntimeIntents((current) => ({
                        ...current,
                        [item.connectorKey]: {
                          desired: nextEnabled,
                          pending: true
                        }
                      }));
                      void Promise.resolve(
                        onRuntimeEnabledChange(item.connectorKey, nextEnabled)
                      ).then(
                        () =>
                          setRuntimeIntents((current) => {
                            const intent = current[item.connectorKey];
                            if (!intent || intent.desired !== nextEnabled) {
                              return current;
                            }
                            return {
                              ...current,
                              [item.connectorKey]: {
                                desired: nextEnabled,
                                pending: false
                              }
                            };
                          }),
                        () =>
                          setRuntimeIntents((current) => {
                            const intent = current[item.connectorKey];
                            if (!intent || intent.desired !== nextEnabled) {
                              return current;
                            }
                            const next = { ...current };
                            delete next[item.connectorKey];
                            return next;
                          })
                      );
                    }}
                  />
                ) : null}
              </div>
            );
          })
        ) : loading ? (
          <div
            className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]"
            data-testid="connector-market-composer-loading"
          >
            {labels.loading}
          </div>
        ) : (
          <div className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">
            {labels.empty}
          </div>
        )}
        {onOpenMarket ? <DropdownMenuSeparator /> : null}
        {onOpenMarket ? (
          <DropdownMenuItem
            className="min-h-9 gap-2.5 px-2.5"
            data-testid="connector-market-composer-more"
            onPointerDown={(event) => {
              if (event.button !== 0 || event.ctrlKey) {
                return;
              }
              event.preventDefault();
              closeAndRun(onOpenMarket);
            }}
            onSelect={(event) => {
              event.preventDefault();
              closeAndRun(onOpenMarket);
            }}
          >
            <OpenLinkLinedIcon aria-hidden className="size-4" />
            <span>{labels.more}</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function normalizeConnectorItems(
  items: readonly ConnectorComposerItem[]
): ConnectorComposerItem[] {
  const selectedItems: ConnectorComposerItem[] = [];
  const connectedItems: ConnectorComposerItem[] = [];
  const remainingItems: ConnectorComposerItem[] = [];
  const seenConnectorKeys = new Set<string>();
  for (const item of items) {
    const connectorKey = item.connectorKey.trim();
    if (!connectorKey || seenConnectorKeys.has(connectorKey)) {
      continue;
    }
    seenConnectorKeys.add(connectorKey);
    const normalizedItem = { ...item, connectorKey };
    if (normalizedItem.status === "connected" && normalizedItem.selected) {
      selectedItems.push(normalizedItem);
    } else if (normalizedItem.status === "connected") {
      connectedItems.push(normalizedItem);
    } else {
      remainingItems.push(normalizedItem);
    }
  }
  return [...selectedItems, ...connectedItems, ...remainingItems];
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
