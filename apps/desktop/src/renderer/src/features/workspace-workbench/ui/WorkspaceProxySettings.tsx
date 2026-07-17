import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import {
  desktopProxyModes,
  desktopProxySettingsEqual,
  type DesktopProxyMode,
  type DesktopProxySettings
} from "@shared/preferences";

export function WorkspaceProxySettings({
  changing,
  onChange,
  settings
}: {
  changing: DesktopProxySettings | null;
  onChange: (settings: DesktopProxySettings) => void;
  settings: DesktopProxySettings;
}) {
  const { t } = useTranslation();
  const effective = changing ?? settings;
  const [mode, setMode] = useState<DesktopProxyMode>(effective.mode);
  const [port, setPort] = useState(String(effective.port));

  useEffect(() => {
    setMode(effective.mode);
    setPort(String(effective.port));
  }, [effective.mode, effective.port]);

  const parsedPort = Number(port);
  const validPort =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  const draft: DesktopProxySettings = {
    mode,
    port: validPort ? parsedPort : effective.port
  };
  const dirty = validPort && !desktopProxySettingsEqual(draft, effective);
  const disabled = changing !== null;

  return (
    <div className="order-3 flex w-full items-start justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t("workspace.settings.general.proxyLabel")}
        </strong>
        <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
          {t("workspace.settings.general.proxyDescription")}
        </p>
      </div>
      <div className="flex w-[300px] min-w-[300px] flex-col gap-2 max-[560px]:w-full max-[560px]:min-w-0">
        <Select
          disabled={disabled}
          value={mode}
          onValueChange={(value) => setMode(value as DesktopProxyMode)}
        >
          <SelectTrigger
            aria-label={t("workspace.settings.general.proxyModeLabel")}
            className="h-8 w-full border-0 bg-[var(--transparency-block)] px-3 text-[13px] shadow-none hover:bg-[var(--transparency-hover)] focus:ring-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={{ zIndex: "var(--z-panel-popover)" }}>
            {desktopProxyModes.map((option) => (
              <SelectItem key={option} value={option}>
                {option === "system"
                  ? t("workspace.settings.general.proxyModeOptions.system")
                  : t("workspace.settings.general.proxyModeOptions.manual")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {mode === "manual" ? (
          <Input
            aria-invalid={!validPort}
            aria-label={t("workspace.settings.general.proxyPortLabel")}
            disabled={disabled}
            inputMode="numeric"
            max={65535}
            min={1}
            placeholder="7890"
            type="number"
            value={port}
            onChange={(event) => setPort(event.currentTarget.value)}
          />
        ) : null}
        {!validPort ? (
          <span className="text-[12px] text-[var(--state-danger)]">
            {t("workspace.settings.general.proxyPortInvalid")}
          </span>
        ) : null}
        <Button
          className="self-end px-4 max-[560px]:w-full"
          disabled={disabled || !dirty}
          size="sm"
          type="button"
          onClick={() => onChange(draft)}
        >
          {changing
            ? t("workspace.settings.general.proxyApplying")
            : t("workspace.settings.general.proxyApply")}
        </Button>
      </div>
    </div>
  );
}
