import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  RadioIndicator,
  cn
} from "@tutti-os/ui-system";
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { BrowserNodeFeature } from "../core/feature.ts";
import type {
  BrowserNodeChromeProfile,
  BrowserNodeChromeProfileId,
  BrowserNodeCookieImportResult
} from "../core/types.ts";
import { initialChromeProfileSelection } from "./chromeCookieImportUiModel.ts";
import { BrowserNodeChromeProfileAvatar } from "./BrowserNodeChromeProfileAvatar.tsx";

export function BrowserNodeChromeImportDialog({
  feature,
  nodeId,
  onOpenChange,
  onResult,
  open,
  profiles
}: {
  feature: BrowserNodeFeature;
  nodeId: string;
  onOpenChange(open: boolean): void;
  onResult?(result: BrowserNodeCookieImportResult): void;
  open: boolean;
  profiles: readonly BrowserNodeChromeProfile[];
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const operationId = useRef<string | null>(null);
  const profileButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedId, setSelectedId] =
    useState<BrowserNodeChromeProfileId | null>(() =>
      initialChromeProfileSelection(profiles)
    );

  useEffect(() => {
    if (open) {
      setSelectedId(initialChromeProfileSelection(profiles));
    }
  }, [open, profiles]);

  const importProfile = (): void => {
    if (!selectedId || !feature.chromeCookieImport) {
      return;
    }
    setBusy(true);
    const nextOperationId = globalThis.crypto.randomUUID();
    operationId.current = nextOperationId;
    void feature.chromeCookieImport
      .importProfile({
        nodeId,
        operationId: nextOperationId,
        profileId: selectedId
      })
      .then((result) => {
        onResult?.(result);
        onOpenChange(false);
      })
      .catch(() => {
        onResult?.({
          canceled: false,
          failed: 0,
          failureCode: "unavailable",
          failureStage: "database",
          imported: 0,
          partial: false,
          skipped: 0,
          status: "failed"
        });
      })
      .finally(() => {
        operationId.current = null;
        setBusy(false);
      });
  };

  const closeOrCancel = (): void => {
    if (operationId.current && feature.chromeCookieImport) {
      void feature.chromeCookieImport.cancelImport(operationId.current);
    }
    onOpenChange(false);
  };

  const focusProfile = (index: number): void => {
    const profile = profiles[index];
    if (!profile) {
      return;
    }
    setSelectedId(profile.id);
    profileButtons.current[index]?.focus();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : closeOrCancel())}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {feature.i18n.t("chromeImport.dialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {feature.i18n.t("chromeImport.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <div
          className="grid max-h-72 gap-2 overflow-y-auto py-1"
          role="radiogroup"
        >
          {profiles.map((profile, index) => (
            <ChromeProfileButton
              key={profile.id}
              buttonRef={(button) => {
                profileButtons.current[index] = button;
              }}
              index={index}
              profileCount={profiles.length}
              profile={profile}
              selected={profile.id === selectedId}
              tabStop={
                profile.id === selectedId ||
                (selectedId === null && index === 0)
              }
              onMove={focusProfile}
              onSelect={() => setSelectedId(profile.id)}
            />
          ))}
        </div>
        <DialogFooter>
          <Button
            size="dialog"
            type="button"
            variant="outline"
            onClick={closeOrCancel}
          >
            {feature.i18n.t("chromeImport.cancel")}
          </Button>
          <Button
            disabled={!selectedId || busy}
            size="dialog"
            type="button"
            onClick={importProfile}
          >
            {busy
              ? feature.i18n.t("chromeImport.importing")
              : feature.i18n.t("chromeImport.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChromeProfileButton({
  buttonRef,
  index,
  onMove,
  onSelect,
  profile,
  profileCount,
  selected,
  tabStop
}: {
  buttonRef(button: HTMLButtonElement | null): void;
  index: number;
  onMove(index: number): void;
  onSelect(): void;
  profile: BrowserNodeChromeProfile;
  profileCount: number;
  selected: boolean;
  tabStop: boolean;
}): JSX.Element {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % profileCount;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + profileCount) % profileCount;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = profileCount - 1;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      onMove(nextIndex);
    }
  };

  return (
    <button
      ref={buttonRef}
      aria-checked={selected}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
        selected
          ? "border-[var(--tutti-purple)] bg-[color-mix(in_srgb,var(--tutti-purple)_8%,transparent)]"
          : "border-border bg-[var(--transparency-block)] hover:bg-[var(--transparency-hover)]"
      )}
      role="radio"
      tabIndex={tabStop ? 0 : -1}
      type="button"
      onKeyDown={handleKeyDown}
      onClick={onSelect}
    >
      <BrowserNodeChromeProfileAvatar profile={profile} />
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
          {profile.name}
        </span>
        {profile.email ? (
          <span className="block truncate text-[11px] text-[var(--text-secondary)]">
            {profile.email}
          </span>
        ) : null}
      </span>
      <RadioIndicator checked={selected} className="ml-auto" />
    </button>
  );
}
