import { type JSX } from "react";
import { Button } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";

export function AgentEnvReportConsent({
  onCancel,
  onAgree,
  t
}: {
  onCancel: () => void;
  onAgree: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}): JSX.Element {
  return (
    <div className="shrink-0 border-t border-[var(--border-1)] bg-[var(--transparency-block)] px-5 py-3">
      <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
        {t("workspace.agentEnv.reportConsentTitle")}
      </p>
      <p className="m-0 mt-1 text-[12px] text-[var(--text-secondary)]">
        {t("workspace.agentEnv.reportConsentBody")}
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          {t("workspace.agentEnv.reportConsentCancel")}
        </Button>
        <Button size="sm" type="button" onClick={onAgree}>
          {t("workspace.agentEnv.reportConsentAgree")}
        </Button>
      </div>
    </div>
  );
}
