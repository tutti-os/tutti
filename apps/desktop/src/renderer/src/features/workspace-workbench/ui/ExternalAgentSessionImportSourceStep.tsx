import type {
  ExternalAgentImportArchiveKind,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { Button, Checkbox, UploadIcon } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { resolveWorkspaceAgentGuiLabel } from "../services/workspaceAgentProviderCatalog";

const externalImportListCheckboxClass =
  "focus-visible:!ring-0 focus-visible:border-[var(--border-1)] data-[state=checked]:focus-visible:border-[var(--text-primary)]";

const externalImportListItemClass =
  "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-[8px] bg-[var(--transparency-block)] p-3 transition-colors hover:bg-[var(--transparency-hover)]";

export function ExternalAgentSessionImportSourceStep({
  disabled,
  onSelectArchive,
  onToggle,
  providers,
  selectedProviders
}: {
  disabled: boolean;
  onSelectArchive: (archiveKind: ExternalAgentImportArchiveKind) => void;
  onToggle: (provider: WorkspaceAgentProvider, checked: boolean) => void;
  providers: WorkspaceAgentProvider[];
  selectedProviders: Set<WorkspaceAgentProvider>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[13px] leading-[1.4] text-[var(--text-secondary)]">
          {t("workspace.externalImport.providerDescription")}
        </p>
        <div className="flex flex-col gap-2">
          {providers.map((provider) => {
            const checked = selectedProviders.has(provider);
            const label = resolveWorkspaceAgentGuiLabel(provider);
            return (
              <label key={provider} className={externalImportListItemClass}>
                <Checkbox
                  aria-label={t("workspace.externalImport.selectProvider", {
                    label
                  })}
                  checked={checked}
                  className={externalImportListCheckboxClass}
                  disabled={disabled}
                  onCheckedChange={(value) =>
                    onToggle(provider, value === true)
                  }
                />
                <span className="min-w-0 text-[13px] font-semibold text-[var(--text-primary)]">
                  {label}
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <ExternalImportArchiveCard
          disabled={disabled}
          title={t("workspace.externalImport.archiveOptionTitle")}
          description={t("workspace.externalImport.archiveOptionDescription")}
          buttonLabel={t("workspace.externalImport.chooseArchive")}
          onSelect={() => onSelectArchive("claude")}
        />
        <ExternalImportArchiveCard
          disabled={disabled}
          title={t("workspace.externalImport.chatgptOptionTitle")}
          description={t("workspace.externalImport.chatgptOptionDescription")}
          buttonLabel={t("workspace.externalImport.chooseChatgptArchive")}
          onSelect={() => onSelectArchive("chatgpt")}
        />
      </div>
    </div>
  );
}

function ExternalImportArchiveCard({
  buttonLabel,
  description,
  disabled,
  onSelect,
  title
}: {
  buttonLabel: string;
  description: string;
  disabled: boolean;
  onSelect: () => void;
  title: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3">
      <div className="min-w-0 flex-1">
        <strong className="block text-[13px] font-semibold text-[var(--text-primary)]">
          {title}
        </strong>
        <p className="mb-0 mt-1 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
          {description}
        </p>
      </div>
      <Button
        disabled={disabled}
        size="sm"
        type="button"
        variant="secondary"
        onClick={onSelect}
      >
        <UploadIcon className="size-4" />
        {buttonLabel}
      </Button>
    </div>
  );
}
