import type { JSX } from "react";
import { ListFilter } from "lucide-react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@tutti-os/ui-system";
import { useTranslation } from "../i18n/index";
import {
  messageCenterGroupLabel,
  type MessageCenterGroupBy,
  type MessageCenterProviderOption,
  type MessageCenterStatusFilter,
  type MessageCenterStatusOption
} from "./workspaceAgentMessageCenterViewModel";

export function MessageCenterViewMenu({
  filtersActive = false,
  groupBy,
  providerFilters,
  providerOptions,
  statusFilters,
  statusOptions,
  onClearFilters,
  onGroupByChange,
  onProviderToggle,
  onStatusToggle
}: {
  filtersActive?: boolean;
  groupBy: MessageCenterGroupBy;
  providerFilters: Set<string> | null;
  providerOptions: MessageCenterProviderOption[];
  statusFilters: Set<MessageCenterStatusFilter> | null;
  statusOptions: MessageCenterStatusOption[];
  onClearFilters: () => void;
  onGroupByChange: (groupBy: MessageCenterGroupBy) => void;
  onProviderToggle: (provider: string) => void;
  onStatusToggle: (status: MessageCenterStatusFilter) => void;
}): JSX.Element {
  "use memo";
  const { t } = useTranslation();

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("agentHost.workspaceAgentMessageCenterViewOptions")}
          title={t("agentHost.workspaceAgentMessageCenterViewOptions")}
          className={cn(
            "relative size-8 shrink-0 rounded-md border bg-[var(--background-fronted)] shadow-none",
            filtersActive
              ? "border-[var(--border-focus)] text-[var(--accent)]"
              : "border-[var(--line-2)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          )}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          <ListFilter className="size-4" strokeWidth={2.1} aria-hidden="true" />
          {filtersActive ? (
            <span
              aria-label={t(
                "agentHost.workspaceAgentMessageCenterFilterActive"
              )}
              className="absolute -right-0.5 -top-0.5 size-2 rounded-full border border-[var(--background-panel)] bg-[var(--accent)]"
            />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="min-w-[240px] p-1.5"
        style={{ zIndex: "var(--z-dialog-popover)" }}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        <DropdownMenuLabel>
          {t("agentHost.workspaceAgentMessageCenterGroupBy")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={groupBy}
          onValueChange={(value) =>
            onGroupByChange(value as MessageCenterGroupBy)
          }
        >
          {(["priority", "status", "agent", "time"] as const).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {messageCenterGroupLabel(value, t)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {t("agentHost.workspaceAgentMessageCenterFilterStatus")}
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {statusOptions.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              aria-label={`${option.label} ${option.count}`}
              checked={
                statusFilters === null || statusFilters.has(option.value)
              }
              onCheckedChange={() => onStatusToggle(option.value)}
              onSelect={(event) => event.preventDefault()}
            >
              <MessageCenterOptionWithCount
                count={option.count}
                label={option.label}
              />
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>

        {providerOptions.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {t("agentHost.workspaceAgentMessageCenterFilterAgent")}
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {providerOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  aria-label={`${option.label} ${option.count}`}
                  checked={
                    providerFilters === null ||
                    providerFilters.has(option.value)
                  }
                  onCheckedChange={() => onProviderToggle(option.value)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <MessageCenterOptionWithCount
                    count={option.count}
                    label={option.label}
                  />
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onClearFilters}>
            {t("agentHost.workspaceAgentMessageCenterClearFilters")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MessageCenterOptionWithCount({
  count,
  label
}: {
  count: number;
  label: string;
}): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-[11px] text-[var(--text-tertiary)]">
        {count}
      </span>
    </span>
  );
}
