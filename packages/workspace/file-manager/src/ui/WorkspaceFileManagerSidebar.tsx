import {
  FolderIcon,
  RecentLinedIcon,
  ScrollArea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import type { ReactElement } from "react";
import type {
  WorkspaceFileLocation,
  WorkspaceFileExternalLocation,
  WorkspaceFileLocationSection
} from "../services/workspaceFileManagerTypes.ts";

export function WorkspaceFileManagerSidebar({
  disabled,
  locationSections,
  selectedLocationId,
  onSelectLocation
}: {
  disabled: boolean;
  locationSections: readonly WorkspaceFileLocationSection[];
  selectedLocationId: string | null;
  onSelectLocation: (location: WorkspaceFileLocation) => void;
}): ReactElement | null {
  const visibleSections = locationSections.filter(
    (section) => section.locations.length > 0
  );
  if (visibleSections.length === 0) {
    return null;
  }

  return (
    <aside className="@max-[600px]/workspace-file-manager:hidden flex w-[188px] min-w-[188px] flex-col border-r border-[var(--border-1)] bg-[var(--background-panel)]">
      <ScrollArea className="min-h-0 flex-1">
        <TooltipProvider delayDuration={350}>
          <div className="flex flex-col gap-3 px-2 py-3">
            {visibleSections.map((section) => (
              <section key={section.id} className="min-w-0">
                <h2 className="mb-1 px-2 text-[11px] font-medium uppercase tracking-normal text-[var(--text-tertiary)]">
                  {section.label}
                </h2>
                <div className="flex flex-col gap-0.5">
                  {section.locations.map((location) => (
                    <WorkspaceFileManagerSidebarLocation
                      key={location.id}
                      active={location.id === selectedLocationId}
                      disabled={disabled}
                      location={location}
                      onSelectLocation={onSelectLocation}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </TooltipProvider>
      </ScrollArea>
    </aside>
  );
}

function WorkspaceFileManagerSidebarLocation({
  active,
  disabled,
  location,
  onSelectLocation
}: {
  active: boolean;
  disabled: boolean;
  location: WorkspaceFileLocation;
  onSelectLocation: (location: WorkspaceFileLocation) => void;
}): ReactElement {
  const Icon = location.kind === "recent" ? RecentLinedIcon : FolderIcon;
  const content = (
    <button
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 min-w-0 items-center gap-2 rounded-md border border-transparent px-2 text-left text-sm text-[var(--text-secondary)] transition-colors",
        active
          ? "border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-none"
          : "hover:bg-[var(--transparency-block)] hover:text-[var(--text-primary)]",
        disabled && "pointer-events-none opacity-60"
      )}
      disabled={disabled}
      type="button"
      onClick={() => {
        onSelectLocation(location);
      }}
    >
      {location.kind === "external" && location.iconUrl ? (
        <ExternalLocationIcon location={location} />
      ) : (
        <Icon className="size-4 flex-none" />
      )}
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {location.label}
      </span>
    </button>
  );

  if (!location.contextLabel) {
    return content;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="right">{location.contextLabel}</TooltipContent>
    </Tooltip>
  );
}

function ExternalLocationIcon({
  location
}: {
  location: WorkspaceFileExternalLocation;
}): ReactElement {
  return (
    <img
      alt=""
      className="size-4 flex-none rounded-[3px] object-cover"
      src={location.iconUrl ?? undefined}
    />
  );
}
