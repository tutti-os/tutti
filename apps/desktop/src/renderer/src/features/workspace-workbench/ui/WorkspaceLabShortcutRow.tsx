import { Button, DeleteIcon, Input } from "@tutti-os/ui-system";
import { formatDesktopShortcutBinding } from "@shared/preferences/index.ts";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { workspaceSettingsInputClass } from "./workspaceSettingsStyles.ts";

export function WorkspaceLabShortcutRow({
  description,
  disabled,
  label,
  value,
  onChange
}: {
  description?: string;
  disabled: boolean;
  label: string;
  value: string | null;
  onChange: (binding: string | null) => void;
}) {
  const { t } = useTranslation();
  const clearLabel = t("workspace.settings.lab.clearShortcutLabel", { label });
  return (
    <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {label}
        </strong>
        {description ? (
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex w-[220px] min-w-[220px] items-center gap-2 max-[560px]:w-full max-[560px]:min-w-0">
        <Input
          aria-label={label}
          className={cn(
            workspaceSettingsInputClass,
            "font-mono text-[12px]",
            disabled && "opacity-70"
          )}
          disabled={disabled}
          placeholder={t("workspace.settings.lab.shortcutUnbound")}
          readOnly
          value={value ?? ""}
          onKeyDown={(event) => {
            if (disabled) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (
              event.key === "Backspace" ||
              event.key === "Delete" ||
              event.key === "Escape"
            ) {
              onChange(null);
              return;
            }
            const binding = formatDesktopShortcutBinding({
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              key: event.key,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey
            });
            if (binding) {
              onChange(binding);
            }
          }}
        />
        <Button
          aria-label={clearLabel}
          disabled={disabled || value === null}
          size="icon-sm"
          title={clearLabel}
          type="button"
          variant="ghost"
          onClick={() => onChange(null)}
        >
          <DeleteIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
