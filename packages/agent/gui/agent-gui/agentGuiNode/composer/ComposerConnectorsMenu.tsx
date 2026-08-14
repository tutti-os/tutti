import { useState } from "react";
import {
  Badge,
  CheckIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  LinkIcon,
  OpenLinkLinedIcon
} from "@tutti-os/ui-system";
import { cn } from "../../../app/renderer/lib/utils";
import styles from "../AgentGUINode.styles";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import connectorLinedIconUrl from "../../../app/renderer/assets/icons/connector-lined.svg";

const QUICK_CONNECTOR_LIMIT = 10;
const CONNECTOR_PREVIEW_LIMIT = 3;

export interface ComposerConnectorsMenuLabels {
  connectors: string;
  connectorConnected: string;
  connectorConnect: string;
  connectorAuthorize: string;
  connectorEmpty: string;
  connectorMore: string;
}

interface Props {
  connectors: readonly AgentGUIProviderSkillOption[];
  disabled: boolean;
  labels: ComposerConnectorsMenuLabels;
  onOpenConnector: (connectorKey: string) => void;
  onOpenConnectors: () => void;
}

function connectorOptions(
  options: readonly AgentGUIProviderSkillOption[]
): AgentGUIProviderSkillOption[] {
  return options.filter(
    (option) =>
      (option.sourceKind === "connector" || option.kind === "connector") &&
      Boolean(option.connectorKey?.trim())
  );
}

export function ComposerConnectorsMenu({
  connectors,
  disabled,
  labels,
  onOpenConnector,
  onOpenConnectors
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const normalizedConnectors = connectorOptions(connectors);
  const quickConnectors = normalizedConnectors.slice(0, QUICK_CONNECTOR_LIMIT);
  const connectedConnectors = normalizedConnectors.filter(
    (connector) => connector.status === "available"
  );
  const previewConnectors = connectedConnectors.slice(
    0,
    CONNECTOR_PREVIEW_LIMIT
  );
  const additionalConnectorCount =
    connectedConnectors.length - previewConnectors.length;
  const requestOpenConnectors = (): void => {
    setOpen(false);
    onOpenConnectors();
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={labels.connectors}
          className={cn(
            styles.composerMenuTrigger,
            "group h-7 w-auto !gap-1 rounded-full border border-[var(--line-1)] bg-[var(--background-fronted)] px-1.5 text-[var(--agent-gui-text-secondary)] shadow-none hover:border-[var(--line-2)] hover:text-[var(--agent-gui-text-primary)] focus-visible:text-[var(--agent-gui-text-primary)] data-[state=open]:border-[var(--line-2)] data-[state=open]:text-[var(--agent-gui-text-primary)] disabled:pointer-events-none disabled:opacity-50"
          )}
          data-testid="agent-gui-composer-connectors-trigger"
          disabled={disabled}
        >
          {previewConnectors.length > 0 ? (
            <>
              <span className="inline-flex items-center gap-0.5">
                {previewConnectors.map((connector) => {
                  const connectorKey = connector.connectorKey!.trim();
                  return (
                    <ConnectorMenuIcon
                      key={connectorKey}
                      className="size-4"
                      iconUrl={connector.iconUrl}
                      label={connector.name}
                      testId={`agent-gui-composer-connector-preview-${connectorKey}`}
                    />
                  );
                })}
              </span>
              {additionalConnectorCount > 0 ? (
                <Badge
                  className="h-[18px] min-w-[18px] rounded-full px-1 text-[10px] font-medium"
                  data-testid="agent-gui-composer-connector-preview-count"
                  size="sm"
                  variant="muted"
                >
                  +{additionalConnectorCount}
                </Badge>
              ) : null}
            </>
          ) : (
            <>
              <span aria-hidden className="inline-block size-4 bg-current transition-colors" style={{ WebkitMaskImage: `url("${connectorLinedIconUrl}")`, WebkitMaskPosition: "center", WebkitMaskRepeat: "no-repeat", WebkitMaskSize: "contain", maskImage: `url("${connectorLinedIconUrl}")`, maskPosition: "center", maskRepeat: "no-repeat", maskSize: "contain" }} />
              <span>{labels.connectors}</span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[300px] max-w-[calc(100vw-24px)] p-1.5"
        side="top"
        sideOffset={8}
      >
        {quickConnectors.length > 0 ? (
          quickConnectors.map((connector) => {
            const connectorKey = connector.connectorKey!.trim();
            const connected = connector.status === "available";
            const actionLabel =
              connector.status === "authRequired"
                ? labels.connectorAuthorize
                : labels.connectorConnect;
            const requestConnect = (): void => {
              setOpen(false);
              onOpenConnector(connectorKey);
            };
            return (
              <DropdownMenuItem
                key={connectorKey}
                aria-disabled={connected}
                className="min-h-9 gap-2.5 px-2.5"
                data-testid={`agent-gui-composer-connector-${connectorKey}`}
                onSelect={(event) => {
                  event.preventDefault();
                  if (connected) {
                    return;
                  }
                  requestConnect();
                }}
              >
                <ConnectorMenuIcon
                  className="size-4"
                  iconUrl={connector.iconUrl}
                  label={connector.name}
                />
                <span className="min-w-0 flex-1 truncate">
                  {connector.name}
                </span>
                {connected ? (
                  <div
                    className="ml-auto inline-flex shrink-0 items-center gap-[4px] pl-3 text-xs text-[var(--success)]"
                    data-testid={`agent-gui-composer-connector-${connectorKey}-status`}
                  >
                    <CheckIcon
                      aria-hidden
                      className="size-4 text-[var(--success)]"
                    />
                    {labels.connectorConnected}
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label={`${actionLabel} ${connector.name}`}
                    className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-[4px] rounded-sm px-1 py-0.5 text-xs text-[var(--text-primary)] outline-none transition-colors hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
                    data-testid={`agent-gui-composer-connector-${connectorKey}-connect`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.detail === 0) {
                        requestConnect();
                      }
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (event.button !== 0 || event.ctrlKey) {
                        return;
                      }
                      event.preventDefault();
                      requestConnect();
                    }}
                  >
                    <LinkIcon aria-hidden className="size-4" />
                    {actionLabel}
                  </button>
                )}
              </DropdownMenuItem>
            );
          })
        ) : (
          <div className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">
            {labels.connectorEmpty}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="min-h-9 gap-2.5 px-2.5"
          data-testid="agent-gui-composer-more-connectors-entry"
          onClick={requestOpenConnectors}
          onPointerDown={(event) => {
            if (event.button !== 0 || event.ctrlKey) {
              return;
            }
            event.preventDefault();
            requestOpenConnectors();
          }}
        >
          <OpenLinkLinedIcon aria-hidden className="size-4" />
          <span>{labels.connectorMore}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectorMenuIcon({
  className,
  iconUrl,
  label,
  testId
}: {
  className?: string;
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
        className={cn(
          "size-4 shrink-0 rounded-[3px] object-contain",
          className
        )}
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
        "flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-[var(--background-tertiary)] text-[10px] font-medium text-[var(--text-secondary)]",
        className
      )}
      data-testid={testId}
    >
      {label.trim().charAt(0).toLocaleUpperCase() || "?"}
    </span>
  );
}
