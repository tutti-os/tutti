import type * as React from "react";
import type { ExternalAgentImportResultResponse } from "@tutti-os/client-tuttid-ts";
import { SuccessFilledIcon } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";

export function ExternalAgentSessionImportResultSummary({
  archive,
  result
}: {
  archive: boolean;
  result: ExternalAgentImportResultResponse;
}) {
  const { t } = useTranslation();
  return (
    <div aria-live="polite" className="flex flex-col gap-4" role="status">
      <CenteredExternalAgentSessionImportState
        icon={
          <SuccessFilledIcon className="size-7 text-[var(--tutti-purple)]" />
        }
        text={t(
          archive
            ? "workspace.externalImport.archiveResult"
            : "workspace.externalImport.result",
          {
            messages: result.importedMessages,
            projects: result.importedProjects,
            sessions: result.importedSessions
          }
        )}
      />
      {result.skippedSessions > 0 ? (
        <p className="m-0 text-center text-[12px] text-[var(--text-secondary)]">
          {t("workspace.externalImport.resultSkipped", {
            count: result.skippedSessions
          })}
        </p>
      ) : null}
      {result.errors.length > 0 ? (
        <div className="rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3">
          <strong className="text-[12px] font-semibold text-[var(--text-primary)]">
            {t("workspace.externalImport.errors")}
          </strong>
          <ul className="mt-2 flex flex-col gap-1 p-0 text-[12px] text-[var(--text-secondary)]">
            {result.errors.map((item, index) => (
              <li key={`${item.sourcePath ?? "error"}-${index}`}>
                {item.sourcePath ? `${item.sourcePath}: ` : ""}
                {item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function CenteredExternalAgentSessionImportState({
  ariaLive,
  icon,
  role,
  text
}: {
  ariaLive?: React.AriaAttributes["aria-live"];
  icon: React.ReactNode;
  role?: React.AriaRole;
  text: string;
}) {
  return (
    <div
      aria-live={ariaLive}
      className="flex min-h-[220px] flex-col items-center justify-center gap-3 text-center text-[13px] text-[var(--text-secondary)]"
      role={role}
    >
      <div className="text-[var(--text-primary)]">{icon}</div>
      <p className="m-0 max-w-[360px] leading-[1.4]">{text}</p>
    </div>
  );
}
