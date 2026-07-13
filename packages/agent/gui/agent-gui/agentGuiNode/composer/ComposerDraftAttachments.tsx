import { FileText, X } from "lucide-react";
import { Spinner } from "@tutti-os/ui-system";
import { cn } from "../../../app/renderer/lib/utils";
import { translate } from "../../../i18n/index";
import { pastedTextPreview } from "../model/agentComposerDraft";
import type {
  AgentComposerDraftFile,
  AgentComposerDraftImage,
  AgentComposerDraftLargeText
} from "../model/agentGuiNodeTypes";
import { AgentComposerDraftImagePreview } from "./AgentComposerDraftPreview";
import { AGENT_COMPOSER_PASTED_TEXT_FILE_PREFIX } from "./composerDraftUtils";

interface Props {
  draftImages: AgentComposerDraftImage[];
  draftFiles: AgentComposerDraftFile[];
  draftLargeTexts: AgentComposerDraftLargeText[];
  removeLabel: string;
  onRemoveImage: (id: string) => void;
  onRemoveFile: (id: string) => void;
  onRemoveLargeText: (id: string) => void;
  onExpandLargeText: (id: string) => void;
}

export function ComposerDraftAttachments({
  draftImages,
  draftFiles: visibleDraftFiles,
  draftLargeTexts: visibleDraftLargeTexts,
  removeLabel,
  onRemoveImage: removeDraftImage,
  onRemoveFile: removeDraftFile,
  onRemoveLargeText: removeDraftLargeText,
  onExpandLargeText: expandDraftLargeTextToPrompt
}: Props) {
  const labels = { removeMention: removeLabel };
  return (
    <>
      {draftImages.length > 0 ? (
        <div
          className="mb-2 flex w-full max-w-full flex-wrap items-start gap-2"
          data-testid="agent-gui-composer-image-drafts"
        >
          {draftImages.map((image) => (
            <AgentComposerDraftImagePreview
              key={image.id}
              image={image}
              removeLabel={labels.removeMention}
              onRemove={removeDraftImage}
            />
          ))}
        </div>
      ) : null}
      {visibleDraftFiles.length > 0 || visibleDraftLargeTexts.length > 0 ? (
        <div
          className="mb-2 flex max-w-[520px] flex-wrap gap-2"
          data-testid="agent-gui-composer-file-drafts"
        >
          {visibleDraftLargeTexts.map((item, index) => {
            const displayName = `${AGENT_COMPOSER_PASTED_TEXT_FILE_PREFIX}-${index + 1}.txt`;
            const preview = pastedTextPreview(item.text) || displayName;
            const attachmentTitle = translate(
              "agentHost.agentGui.pastedTextAttachmentTitle"
            );
            const restoreLabel = translate(
              "agentHost.agentGui.pastedTextRestoreToComposer"
            );
            const canRestore = !item.uploading && item.text.trim() !== "";
            return (
              <div
                key={item.id}
                className={cn(
                  "group relative inline-flex max-w-full items-center gap-2 rounded-[10px] border border-[var(--line-1)] bg-[var(--background-fronted)] py-1.5 pl-1.5 pr-8 text-xs text-[var(--text-primary)]",
                  item.uploadError &&
                    "border-[color:color-mix(in_srgb,var(--danger)_55%,var(--line-1))]"
                )}
                data-testid="agent-gui-composer-large-text-draft"
                data-uploading={item.uploading ? "true" : undefined}
                data-upload-error={item.uploadError ? "true" : undefined}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 rounded-[8px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)] disabled:cursor-default"
                  disabled={!canRestore}
                  aria-label={restoreLabel}
                  title={canRestore ? restoreLabel : preview}
                  onClick={() => expandDraftLargeTextToPrompt(item.id)}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-[var(--transparency-hover)] text-[var(--text-secondary)]">
                    {item.uploading ? (
                      <Spinner
                        size={16}
                        strokeWidth={2.4}
                        trackColor="var(--transparency-hover)"
                        testId="agent-gui-composer-large-text-upload-spinner"
                      />
                    ) : (
                      <FileText size={16} strokeWidth={2} aria-hidden />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="max-w-[200px] truncate font-medium text-[var(--text-primary)]">
                      {preview}
                    </span>
                    <span className="max-w-[200px] truncate text-[11px] text-[var(--text-tertiary)]">
                      {attachmentTitle}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="absolute right-1.5 top-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)]"
                  aria-label={labels.removeMention}
                  title={labels.removeMention}
                  onClick={() => removeDraftLargeText(item.id)}
                >
                  <X size={12} strokeWidth={2.4} aria-hidden />
                </button>
              </div>
            );
          })}
          {visibleDraftFiles.map((file) => (
            <div
              key={file.id}
              className={cn(
                "group inline-flex max-w-full items-center gap-2 rounded-[6px] border border-[var(--line-1)] bg-[var(--background-fronted)] px-2 py-1 text-xs text-[var(--text-primary)]",
                file.uploadError &&
                  "border-[color:color-mix(in_srgb,var(--danger)_55%,var(--line-1))]"
              )}
              data-uploading={file.uploading ? "true" : undefined}
              data-upload-error={file.uploadError ? "true" : undefined}
              title={file.hostPath ?? file.path ?? file.name}
            >
              {file.uploading ? (
                <Spinner
                  className="shrink-0 text-[var(--text-primary)]"
                  size={14}
                  strokeWidth={2.4}
                  trackColor="var(--transparency-hover)"
                  testId="agent-gui-composer-file-upload-spinner"
                />
              ) : (
                <span
                  className="size-2 shrink-0 rounded-full bg-[var(--text-tertiary)]"
                  aria-hidden
                />
              )}
              <span className="min-w-0 max-w-[220px] truncate">
                {file.name}
              </span>
              <button
                type="button"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)]"
                aria-label={labels.removeMention}
                title={labels.removeMention}
                onClick={() => removeDraftFile(file.id)}
              >
                <X size={12} strokeWidth={2.4} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
