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
    <div className="mx-5 mb-4 shrink-0 rounded-[8px] border border-[var(--border-1)] bg-[var(--background-fronted)] px-4 py-3 shadow-[0_6px_16px_var(--shadow-elevated)]">
      <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
        {t("workspace.agentEnv.reportConsentTitle")}
      </p>
      <p className="m-0 mt-1 text-[12px] text-[var(--text-secondary)]">
        {t("workspace.agentEnv.reportConsentBody")}
      </p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
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
