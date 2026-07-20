import { useCallback, useMemo, useState } from "react";
import {
  Button,
  ChatIcon,
  CloseIcon,
  CopyIcon,
  FileTextIcon,
  TuttiMark
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { Toast } from "@renderer/lib/toast";
import {
  createFileShareDemoData,
  type FileShareComment
} from "../services/fileShareLinkMockData.ts";

type SidePanel = "comments" | "conversation" | null;
type ViewMode = "source" | "preview";

const commentAvatarColors = [
  "var(--accent-primary)",
  "var(--accent-warning)",
  "var(--accent-positive)"
] as const;

/** A local-only interactive reference implementation for a shared file link. */
export function FileShareLinkDemo() {
  const { t } = useTranslation();
  const demo = useMemo(() => createFileShareDemoData(t), [t]);
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [activePanel, setActivePanel] = useState<SidePanel>(null);
  const [comments, setComments] = useState<FileShareComment[]>(demo.comments);

  const togglePanel = useCallback((panel: Exclude<SidePanel, null>) => {
    setActivePanel((previous) => (previous === panel ? null : panel));
  }, []);

  const addComment = useCallback(
    (content: string) => {
      setComments((previous) => [
        ...previous,
        {
          author: t("workspace.workbenchDesktop.fileShare.demoOwnerName"),
          avatar: t("workspace.workbenchDesktop.fileShare.demoUserInitial"),
          content,
          id: `comment-${crypto.randomUUID()}`,
          timestamp: t("workspace.workbenchDesktop.fileShare.justNow")
        }
      ]);
    },
    [t]
  );

  return (
    <section className="flex size-full flex-col overflow-hidden bg-[var(--background-panel)] text-[var(--text-primary)]">
      <ShareHeader
        file={demo.file}
        viewMode={viewMode}
        onChangeViewMode={setViewMode}
      />
      <div className="relative flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto">
          {viewMode === "preview" ? (
            <MarkdownPreviewBody />
          ) : (
            <pre className="mx-auto max-w-3xl whitespace-pre-wrap px-8 py-10 font-mono text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
              {demo.markdownSource}
            </pre>
          )}
        </main>

        {activePanel === null ? (
          <div className="absolute right-6 bottom-8 z-30 flex flex-col items-center gap-3">
            <FloatingEntryButton
              label={t("workspace.workbenchDesktop.fileShare.comments")}
              onClick={() => togglePanel("comments")}
            >
              <ChatIcon className="size-[18px]" />
            </FloatingEntryButton>
            <FloatingEntryButton
              dark
              label={t("workspace.workbenchDesktop.fileShare.conversation")}
              onClick={() => togglePanel("conversation")}
            >
              <TuttiMark className="size-5" />
            </FloatingEntryButton>
          </div>
        ) : null}

        {activePanel === "comments" ? (
          <CommentsPanel
            comments={comments}
            fileName={demo.file.name}
            onAddComment={addComment}
            onClose={() => setActivePanel(null)}
          />
        ) : null}
        {activePanel === "conversation" ? (
          <LinkedConversationPanel
            conversation={demo.conversation}
            onClose={() => setActivePanel(null)}
          />
        ) : null}
      </div>
    </section>
  );
}

function ShareHeader({
  file,
  viewMode,
  onChangeViewMode
}: {
  file: {
    contentType: string;
    name: string;
    ownerAvatar: string;
    size: string;
  };
  viewMode: ViewMode;
  onChangeViewMode: (mode: ViewMode) => void;
}) {
  const { t } = useTranslation();

  return (
    <header className="relative flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line-2)] bg-[var(--background-fronted)] px-4">
      <span className="flex size-7 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--text-inverted)]">
        <TuttiMark className="size-4" />
      </span>
      <span className="text-[15px] font-extrabold tracking-tight">
        {t("workspace.workbenchDesktop.fileShare.productName")}
      </span>
      <span className="h-5 w-px bg-[var(--line-2)]" />
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[13px] font-bold">{file.name}</span>
        <span className="hidden truncate text-[11px] text-[var(--text-tertiary)] sm:inline">
          {file.contentType} · {file.size}
        </span>
      </div>
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center rounded-lg bg-[var(--background-hover)] p-0.5">
        <SegmentButton
          active={viewMode === "source"}
          onClick={() => onChangeViewMode("source")}
        >
          {t("workspace.workbenchDesktop.fileShare.source")}
        </SegmentButton>
        <SegmentButton
          active={viewMode === "preview"}
          onClick={() => onChangeViewMode("preview")}
        >
          {t("workspace.workbenchDesktop.fileShare.preview")}
        </SegmentButton>
      </div>
      <span className="ml-auto flex size-8 items-center justify-center rounded-full bg-[var(--accent-positive)] text-[13px] font-medium text-white">
        {file.ownerAvatar}
      </span>
    </header>
  );
}

function SegmentButton({
  active,
  children,
  onClick
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      size="xs"
      type="button"
      variant={active ? "secondary" : "ghost"}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function FloatingEntryButton({
  children,
  dark,
  label,
  onClick
}: {
  children: React.ReactNode;
  dark?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="group relative">
      <Button
        aria-label={label}
        className={`size-12 rounded-full shadow-lg ${dark ? "bg-[var(--text-primary)] text-[var(--text-inverted)] hover:bg-[var(--text-primary-hover)]" : "border border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
        size="icon"
        type="button"
        variant="ghost"
        onClick={onClick}
      >
        {children}
      </Button>
      <span className="pointer-events-none absolute top-1/2 right-full mr-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-[var(--text-primary)] px-2 py-1 text-[11px] text-[var(--text-inverted)] opacity-0 transition-opacity group-hover:opacity-100">
        {label}
      </span>
    </div>
  );
}

function CommentsPanel({
  comments,
  fileName,
  onAddComment,
  onClose
}: {
  comments: FileShareComment[];
  fileName: string;
  onAddComment: (content: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  const submit = () => {
    const content = draft.trim();
    if (!content) return;
    onAddComment(content);
    setDraft("");
  };

  const copyInstruction = async (comment: FileShareComment) => {
    try {
      await navigator.clipboard.writeText(
        t("workspace.workbenchDesktop.fileShare.copyInstruction", {
          comment: comment.content,
          fileName
        })
      );
      Toast.tips(
        t("workspace.workbenchDesktop.fileShare.copySuccessTitle"),
        t("workspace.workbenchDesktop.fileShare.copySuccessDescription")
      );
    } catch {
      Toast.Error(t("workspace.workbenchDesktop.fileShare.copyFailed"));
    }
  };

  return (
    <SidePanelShell
      title={t("workspace.workbenchDesktop.fileShare.comments")}
      titleExtra={
        <span className="rounded-full bg-[var(--background-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
          {comments.length}
        </span>
      }
      onClose={onClose}
      footer={
        <div className="shrink-0 border-t border-[var(--line-2)] bg-[var(--background-fronted)] px-4 py-3">
          <div className="flex flex-col rounded-xl border border-[var(--line-2)] focus-within:border-[var(--border-focus)]">
            <textarea
              className="w-full resize-none bg-transparent px-3 py-2 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
              placeholder={t(
                "workspace.workbenchDesktop.fileShare.draftPlaceholder"
              )}
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="flex items-center justify-between px-2 pb-2">
              <span className="text-[10px] text-[var(--text-tertiary)]">
                {t("workspace.workbenchDesktop.fileShare.enterToSend")}
              </span>
              <Button
                disabled={!draft.trim()}
                size="xs"
                type="button"
                onClick={submit}
              >
                {t("workspace.workbenchDesktop.fileShare.send")}
              </Button>
            </div>
          </div>
        </div>
      }
    >
      <div className="h-full overflow-y-auto px-4 py-3">
        {comments.length === 0 ? (
          <div className="mt-16 text-center text-xs text-[var(--text-tertiary)]">
            {t("workspace.workbenchDesktop.fileShare.emptyComments")}
          </div>
        ) : (
          comments.map((comment, index) => (
            <article key={comment.id} className="group mb-5 flex gap-2.5">
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium text-white"
                style={{
                  backgroundColor:
                    commentAvatarColors[index % commentAvatarColors.length]
                }}
              >
                {comment.avatar}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--text-primary)]">
                    {comment.author}
                  </span>
                  <span className="text-[10px] text-[var(--text-tertiary)]">
                    {comment.timestamp}
                  </span>
                  <Button
                    aria-label={t(
                      "workspace.workbenchDesktop.fileShare.copyInstructionLabel"
                    )}
                    className="ml-auto size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    size="icon-xs"
                    title={t(
                      "workspace.workbenchDesktop.fileShare.copyInstructionLabel"
                    )}
                    type="button"
                    variant="ghost"
                    onClick={() => void copyInstruction(comment)}
                  >
                    <CopyIcon className="size-3" />
                  </Button>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text-secondary)]">
                  {comment.content}
                </p>
              </div>
            </article>
          ))
        )}
      </div>
    </SidePanelShell>
  );
}

function LinkedConversationPanel({
  conversation,
  onClose
}: {
  conversation: ReturnType<typeof createFileShareDemoData>["conversation"];
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <SidePanelShell
      title={t("workspace.workbenchDesktop.fileShare.conversation")}
      onClose={onClose}
      footer={
        <div className="shrink-0 border-t border-[var(--line-2)] px-4 py-3">
          <Button
            className="w-full"
            type="button"
            onClick={() =>
              Toast.tips(
                t(
                  "workspace.workbenchDesktop.fileShare.demoConversationUnavailable"
                )
              )
            }
          >
            {t("workspace.workbenchDesktop.fileShare.openFullConversation")}
          </Button>
        </div>
      }
    >
      <div className="px-4 py-3">
        <section className="mb-4 rounded-xl border border-[var(--line-2)] bg-[var(--background-hover)] px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--text-inverted)]">
              <TuttiMark className="size-3.5" />
            </span>
            <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {conversation.title}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--text-secondary)]">
            {t("workspace.workbenchDesktop.fileShare.demoConversationWith", {
              agent: conversation.agentName,
              owner: conversation.ownerName
            })}{" "}
            ·{" "}
            {t(
              "workspace.workbenchDesktop.fileShare.demoConversationUpdatedAt",
              {
                updatedAt: conversation.updatedAt
              }
            )}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
            {t(
              "workspace.workbenchDesktop.fileShare.currentFileFromConversation"
            )}
          </p>
        </section>
        {conversation.messages.map((message) => (
          <article key={message.id} className="mb-4">
            <div className="flex items-center gap-2">
              <span className="flex size-5 items-center justify-center rounded-full bg-[var(--background-hover)] text-[9px] font-medium text-[var(--text-secondary)]">
                {message.sender.charAt(0)}
              </span>
              <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
                {message.sender}
              </span>
              <span className="text-[10px] text-[var(--text-tertiary)]">
                {message.timestamp}
              </span>
            </div>
            <div className="ml-7 mt-1">
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                {message.content}
              </p>
              {message.artifact ? (
                <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-2)] bg-[var(--background-fronted)] px-2.5 py-1.5">
                  <FileTextIcon className="size-3 text-[var(--text-secondary)]" />
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    {message.artifact.name}
                  </span>
                  <span className="text-[10px] text-[var(--text-tertiary)]">
                    {message.artifact.meta}
                  </span>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </SidePanelShell>
  );
}

function SidePanelShell({
  children,
  footer,
  title,
  titleExtra,
  onClose
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
  title: string;
  titleExtra?: React.ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <aside className="absolute inset-y-0 right-0 z-40 flex w-[360px] flex-col border-l border-[var(--line-2)] bg-[var(--background-fronted)] shadow-[-8px_0_24px_var(--shadow-elevated)]">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--line-2)] px-4 py-3">
        <span className="text-sm font-bold text-[var(--text-primary)]">
          {title}
        </span>
        {titleExtra}
        <Button
          aria-label={t("workspace.workbenchDesktop.fileShare.panelClose")}
          className="ml-auto"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={onClose}
        >
          <CloseIcon className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer}
    </aside>
  );
}

function MarkdownPreviewBody() {
  const { t } = useTranslation();

  return (
    <article className="mx-auto max-w-3xl px-8 py-10 text-[13px] leading-relaxed text-[var(--text-secondary)]">
      <h1 className="mb-4 text-2xl font-bold text-[var(--text-primary)]">
        {t("workspace.workbenchDesktop.fileShare.demoReportTitle")}
      </h1>
      <p className="mb-6">
        {t("workspace.workbenchDesktop.fileShare.demoReportBody")}
      </p>
      <h2 className="mb-2 text-lg font-semibold text-[var(--text-primary)]">
        {t("workspace.workbenchDesktop.fileShare.preview")}
      </h2>
      <p>
        {t("workspace.workbenchDesktop.fileShare.currentFileFromConversation")}
      </p>
    </article>
  );
}
