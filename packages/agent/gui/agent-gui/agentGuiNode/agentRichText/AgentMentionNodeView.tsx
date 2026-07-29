import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode
} from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { MentionPill } from "@tutti-os/ui-system/components";
import { Spinner } from "@tutti-os/ui-system";
import { CloseIcon } from "@tutti-os/ui-system/icons";
import { useTranslation } from "../../../i18n/index";
import {
  resolveAgentMentionFileThumbnailUrl,
  resolveAgentMentionFileVisualKind
} from "../../shared/mentionFilePresentation";
import { managedAgentRoundedIconUrl } from "../../../shared/managedAgentIcons";
import { getAgentCustomMentionKind } from "../../../shared/agentCustomMentionKinds";
import { AGENT_RICH_TEXT_CARET_ANCHOR } from "./agentRichTextCaretAnchor";
import { resolveAgentSessionMentionIconUrl } from "./agentMentionPresentation";
import { agentExternalPromptFileErrorI18nKey } from "../model/agentExternalPromptFiles";

type AgentMentionNodeViewKind =
  | "file"
  | "agent-target"
  | "session"
  | "workspace-app"
  | "workspace-reference"
  | "workspace-app-factory"
  | "workspace-issue"
  | "custom";

function parseFileCountAttr(value: unknown): number {
  const parsed =
    typeof value === "string" ? Number.parseInt(value.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

interface AgentMentionNodeViewModel {
  attachmentStatus?: "uploading" | "ready" | "error";
  attachmentErrorLabel?: string;
  ariaLabel: string;
  /** 宿主注册的自定义 mention kind(kind === "custom" 专用)。 */
  customKind?: string;
  directoryPath: string;
  entryKind: string;
  href: string;
  iconUrl?: string;
  kind: AgentMentionNodeViewKind;
  label: string;
  summary?: string;
  thumbnailUrl?: string;
  /** 引用文件数量(workspace-reference 专用)。 */
  fileCount?: number;
}

type AgentMentionWrapperProps = ComponentPropsWithoutRef<"span">;
type AgentMentionWrapper = (props: AgentMentionWrapperProps) => JSX.Element;

function AgentMentionNodeWrapper(props: AgentMentionWrapperProps): JSX.Element {
  return <NodeViewWrapper as="span" {...props} />;
}

function AgentMentionStaticWrapper(
  props: AgentMentionWrapperProps
): JSX.Element {
  return <span {...props} />;
}

const AgentMentionTooltipProviderContext = createContext(true);

export function AgentMentionTooltipProviderScope({
  children,
  withTooltipProvider
}: {
  children: ReactNode;
  withTooltipProvider: boolean;
}): JSX.Element {
  return (
    <AgentMentionTooltipProviderContext value={withTooltipProvider}>
      {children}
    </AgentMentionTooltipProviderContext>
  );
}

function attrString(attrs: Record<string, unknown>, key: string): string {
  const value = attrs[key];
  return typeof value === "string" ? value : "";
}

function normalizeKind(value: string): AgentMentionNodeViewKind {
  if (value === "session" || value === "agent-session") {
    return "session";
  }
  if (value === "workspace-issue") {
    return "workspace-issue";
  }
  if (value === "workspace-app") {
    return "workspace-app";
  }
  if (value === "workspace-reference") {
    return "workspace-reference";
  }
  if (value === "workspace-app-factory") {
    return "workspace-app-factory";
  }
  if (value === "agent-target") {
    return "agent-target";
  }
  if (value === "custom") {
    return "custom";
  }
  return "file";
}

function dirnameFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return path.startsWith("/") ? "/" : "";
  }
  return `/${parts.slice(0, -1).join("/")}`;
}

function mentionViewModel(
  attrs: Record<string, unknown>,
  t: (key: string) => string
): AgentMentionNodeViewModel {
  const kind = normalizeKind(attrString(attrs, "kind"));
  const name = attrString(attrs, "name");
  const href = attrString(attrs, "href");

  if (kind === "session") {
    const label = attrString(attrs, "title").trim() || name.trim();
    const agentTargetId = attrString(attrs, "agentTargetId").trim();
    return {
      ariaLabel:
        `${t("agentHost.agentGui.mentionKindSession")} ${label}`.trim(),
      directoryPath: "",
      entryKind: "",
      href,
      iconUrl: resolveAgentSessionMentionIconUrl({
        agentIconUrl: attrString(attrs, "iconUrl"),
        agentTargetId,
        href
      }),
      kind,
      label
    };
  }

  if (kind === "workspace-issue") {
    return {
      ariaLabel: `${t("agentHost.agentGui.mentionKindIssue")} ${name}`.trim(),
      directoryPath: "",
      entryKind: "",
      href,
      kind,
      label: name
    };
  }

  if (kind === "workspace-app") {
    return {
      ariaLabel: `${t("agentHost.agentGui.mentionKindApp")} ${name}`.trim(),
      directoryPath: "",
      entryKind: "",
      href,
      iconUrl: attrString(attrs, "iconUrl").trim() || undefined,
      kind,
      label: name
    };
  }

  if (kind === "workspace-reference") {
    return {
      ariaLabel: `${t("agentHost.agentGui.mentionKindApp")} ${name}`.trim(),
      directoryPath: "",
      entryKind: "",
      href,
      iconUrl: attrString(attrs, "iconUrl").trim() || undefined,
      kind,
      label: name,
      fileCount: parseFileCountAttr(attrs.fileCount)
    };
  }

  if (kind === "workspace-app-factory") {
    return {
      ariaLabel:
        `${t("agentHost.agentGui.mentionKindAppFactory")} ${name}`.trim(),
      directoryPath: "",
      entryKind: "",
      href,
      kind,
      label: name
    };
  }

  if (kind === "agent-target") {
    const agentProviderId = attrString(attrs, "agentProviderId").trim();
    return {
      ariaLabel: `${t("agentHost.agentGui.mentionKindAgent")} ${name}`.trim(),
      directoryPath: "",
      entryKind: "",
      href,
      iconUrl:
        attrString(attrs, "iconUrl").trim() ||
        managedAgentRoundedIconUrl(agentProviderId),
      kind,
      label: name
    };
  }

  if (kind === "custom") {
    return {
      ariaLabel:
        `${t("agentHost.agentGui.mentionKindReference")} ${name}`.trim(),
      customKind: attrString(attrs, "customKind").trim(),
      directoryPath: "",
      entryKind: "",
      href,
      kind,
      label: name,
      summary: attrString(attrs, "preview").trim() || undefined
    };
  }

  const path = attrString(attrs, "path") || href;
  const entryKind = attrString(attrs, "entryKind") || "unknown";
  return {
    attachmentStatus:
      attrString(attrs, "attachmentStatus") === "uploading" ||
      attrString(attrs, "attachmentStatus") === "error"
        ? (attrString(attrs, "attachmentStatus") as "uploading" | "error")
        : attrString(attrs, "attachmentId")
          ? "ready"
          : undefined,
    attachmentErrorLabel:
      attrString(attrs, "attachmentStatus") === "error"
        ? t(
            agentExternalPromptFileErrorI18nKey(
              attrString(attrs, "attachmentErrorCode")
            )
          )
        : undefined,
    ariaLabel: name,
    directoryPath: attrString(attrs, "directoryPath") || dirnameFromPath(path),
    entryKind,
    href: href || path,
    kind,
    label: name,
    thumbnailUrl: resolveAgentMentionFileThumbnailUrl({
      entryKind,
      href: href || path,
      name,
      path,
      thumbnailUrl: attrString(attrs, "thumbnailUrl")
    })
  };
}

function fileVisualKind(entryKind: string, path: string): string {
  return resolveAgentMentionFileVisualKind({ entryKind, path });
}

function hasPromptContentAfterMentionRemoval(
  doc: NodeViewProps["editor"]["state"]["doc"]
): boolean {
  let hasContent = false;
  doc.descendants((node) => {
    if (hasContent) {
      return false;
    }
    if (node.type.name === "agentFileMention") {
      hasContent = true;
      return false;
    }
    if (
      node.isText &&
      node.textContent.replaceAll(AGENT_RICH_TEXT_CARET_ANCHOR, "").trim()
        .length > 0
    ) {
      hasContent = true;
      return false;
    }
    return true;
  });
  return hasContent;
}

function AgentMentionLegacyFileView({
  isEditable,
  mention,
  onRemove,
  removeActionAriaLabel,
  selected,
  Wrapper
}: {
  isEditable: boolean;
  mention: AgentMentionNodeViewModel;
  onRemove?: MouseEventHandler<HTMLButtonElement>;
  removeActionAriaLabel?: string;
  selected: boolean;
  Wrapper: AgentMentionWrapper;
}): JSX.Element {
  return (
    <Wrapper
      aria-label={
        mention.attachmentErrorLabel
          ? `${mention.ariaLabel}, ${mention.attachmentErrorLabel}`
          : mention.ariaLabel
      }
      className={`agent-rich-text-mention-node group tsh-agent-object-token tsh-agent-object-token--file ${
        selected ? "is-selected" : ""
      }`}
      contentEditable={false}
      data-agent-file-directory-path={mention.directoryPath}
      data-agent-file-entry-kind={mention.entryKind}
      data-agent-file-mention="true"
      {...(mention.thumbnailUrl
        ? {}
        : {
            "data-agent-file-visual-kind": fileVisualKind(
              mention.entryKind,
              mention.href || mention.label
            )
          })}
      data-agent-mention-href={mention.href}
      data-agent-mention-kind={mention.kind}
      data-uploading={
        mention.attachmentStatus === "uploading" ? "true" : undefined
      }
      data-upload-error={
        mention.attachmentStatus === "error" ? "true" : undefined
      }
      title={mention.attachmentErrorLabel ?? undefined}
      {...(mention.thumbnailUrl
        ? { "data-agent-mention-thumbnail-url": mention.thumbnailUrl }
        : {})}
    >
      {mention.thumbnailUrl ? (
        <span
          className="agent-gui-node__mention-file-thumb relative"
          data-agent-mention-file-thumb="true"
          aria-hidden={isEditable ? undefined : true}
        >
          <img
            src={mention.thumbnailUrl}
            alt=""
            className={`h-full w-full object-cover transition-opacity ${
              isEditable
                ? "group-hover:opacity-0 group-focus-within:opacity-0"
                : ""
            }`}
            decoding="async"
            loading="lazy"
            draggable={false}
          />
          {isEditable ? (
            <button
              aria-label={removeActionAriaLabel}
              className="absolute left-1/2 top-1/2 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center text-[var(--text-secondary)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
              type="button"
              onMouseDown={onRemove}
            >
              <CloseIcon className="size-3.5" />
            </button>
          ) : null}
        </span>
      ) : (
        <span
          className="relative grid size-4 shrink-0 place-items-center"
          aria-hidden={isEditable ? undefined : true}
        >
          {mention.attachmentStatus === "uploading" ? (
            <Spinner
              className={
                isEditable
                  ? "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                  : undefined
              }
              size={14}
              strokeWidth={2.4}
              trackColor="var(--transparency-hover)"
              testId="agent-gui-composer-file-upload-spinner"
            />
          ) : (
            <span
              className={`tsh-agent-object-token__icon transition-opacity ${
                isEditable
                  ? "group-hover:opacity-0 group-focus-within:opacity-0"
                  : ""
              }`}
              aria-hidden="true"
            />
          )}
          {isEditable ? (
            <button
              aria-label={removeActionAriaLabel}
              className="absolute left-1/2 top-1/2 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center text-[var(--text-secondary)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
              type="button"
              onMouseDown={onRemove}
            >
              <CloseIcon className="size-3.5" />
            </button>
          ) : null}
        </span>
      )}
      <span className="tsh-agent-object-token__main">{mention.label}</span>
    </Wrapper>
  );
}

function AgentMentionView({
  attrs,
  isEditable,
  onRemove,
  removeActionAriaLabel,
  selected,
  Wrapper
}: {
  attrs: Record<string, unknown>;
  isEditable: boolean;
  onRemove?: MouseEventHandler<HTMLButtonElement>;
  removeActionAriaLabel?: string;
  selected: boolean;
  Wrapper: AgentMentionWrapper;
}): JSX.Element {
  const { t } = useTranslation();
  const withTooltipProvider = useContext(AgentMentionTooltipProviderContext);
  const mention = mentionViewModel(attrs, t);

  if (mention.kind === "file") {
    return (
      <AgentMentionLegacyFileView
        isEditable={isEditable}
        mention={mention}
        onRemove={onRemove}
        removeActionAriaLabel={removeActionAriaLabel}
        selected={selected}
        Wrapper={Wrapper}
      />
    );
  }

  if (
    mention.kind === "workspace-app" ||
    mention.kind === "workspace-reference" ||
    mention.kind === "agent-target"
  ) {
    return (
      <Wrapper
        aria-label={mention.ariaLabel}
        className={`agent-rich-text-mention-node inline-flex max-w-[min(100%,var(--agent-mention-max-width,16rem))] align-middle ${
          selected ? "is-selected" : ""
        }`}
        contentEditable={false}
        data-agent-file-mention="true"
        data-agent-mention-href={mention.href}
        data-agent-mention-icon-url={mention.iconUrl}
        data-agent-mention-kind={mention.kind}
      >
        <MentionPill
          aria-label={mention.ariaLabel}
          className="top-0 h-6 max-w-[min(100%,var(--agent-mention-max-width,16rem))] py-0 align-middle leading-6"
          data-agent-mention-kind={mention.kind}
          iconUrl={mention.iconUrl}
          iconContainerProps={{
            "data-agent-mention-app-icon":
              mention.kind === "agent-target" ? undefined : "true",
            "data-agent-mention-session-icon":
              mention.kind === "agent-target" ? "true" : undefined,
            "data-workspace-app-icon":
              mention.kind === "agent-target" ? undefined : "true"
          }}
          kind={mention.kind === "agent-target" ? "session" : "app"}
          label={mention.label}
          removable={isEditable}
          removeButtonProps={
            isEditable
              ? {
                  "aria-label": removeActionAriaLabel,
                  onMouseDown: onRemove
                }
              : undefined
          }
          withTooltipProvider={withTooltipProvider}
        />
      </Wrapper>
    );
  }

  if (mention.kind === "custom") {
    // 宿主注册的自定义 mention:优先用注册的 renderChip,缺省用通用双行卡
    // (第一行 name,第二行 summary)。点击经 rich-text surface 的 link click 委托
    // (data-agent-mention-href)上抛 onLinkAction,由宿主二次解析 href。
    const definition = getAgentCustomMentionKind(mention.customKind ?? "");
    const removeAction = isEditable ? (
      <button
        aria-label={removeActionAriaLabel}
        className="inline-flex size-4 shrink-0 items-center justify-center text-[var(--text-secondary)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
        type="button"
        onMouseDown={onRemove}
      >
        <CloseIcon className="size-3.5" />
      </button>
    ) : null;
    if (definition?.renderChip) {
      return (
        <Wrapper
          aria-label={mention.ariaLabel}
          className={`agent-rich-text-mention-node inline-grid max-w-[min(100%,var(--agent-mention-max-width,20rem))] align-middle ${
            selected ? "is-selected" : ""
          }`}
          contentEditable={false}
          data-agent-custom-mention="true"
          data-agent-file-mention="true"
          data-agent-mention-href={mention.href}
          data-agent-mention-kind={mention.customKind || mention.kind}
        >
          {definition.renderChip({
            href: mention.href,
            name: mention.label,
            summary: mention.summary,
            isEditable,
            removeAction
          })}
        </Wrapper>
      );
    }
    return (
      <Wrapper
        aria-label={mention.ariaLabel}
        className={`agent-rich-text-mention-node inline-grid max-w-[min(100%,var(--agent-mention-max-width,20rem))] align-middle ${
          selected ? "is-selected" : ""
        }`}
        contentEditable={false}
        data-agent-custom-mention="true"
        data-agent-file-mention="true"
        data-agent-mention-href={mention.href}
        data-agent-mention-kind={mention.customKind || mention.kind}
      >
        <span
          className="group relative grid max-w-full cursor-pointer gap-0.5 overflow-hidden rounded-[8px] border border-[var(--border-primary,rgba(0,0,0,0.08))] bg-block px-2.5 py-1.5 text-left align-middle"
          data-slot="mention-card"
        >
          <span className="flex min-w-0 items-center gap-1">
            <span
              aria-hidden="true"
              className="tsh-agent-object-token__kind-icon size-3.5 shrink-0"
            />
            <span className="truncate text-[13px] font-medium leading-[130%]">
              {mention.label}
            </span>
            {removeAction}
          </span>
          {mention.summary ? (
            <span className="truncate text-[12px] font-normal leading-[130%] text-[var(--text-tertiary)]">
              {mention.summary}
            </span>
          ) : null}
        </span>
      </Wrapper>
    );
  }

  return (
    <Wrapper
      className={`agent-rich-text-mention-node inline-flex max-w-[min(100%,var(--agent-mention-max-width,16rem))] align-middle ${
        selected ? "is-selected" : ""
      }`}
      contentEditable={false}
    >
      <MentionPill
        aria-label={mention.ariaLabel}
        className="top-0 h-6 py-0 align-middle leading-6"
        data-agent-mention-href={mention.href}
        data-agent-mention-kind={mention.kind}
        kind={mention.kind === "session" ? "session" : "issue"}
        iconUrl={mention.iconUrl}
        label={mention.label}
        removable={isEditable}
        removeButtonProps={
          isEditable
            ? {
                "aria-label": removeActionAriaLabel,
                onMouseDown: onRemove
              }
            : undefined
        }
        summary={mention.summary}
        withTooltipProvider={withTooltipProvider}
      />
    </Wrapper>
  );
}

export function AgentMentionReadonlyView({
  attrs
}: {
  attrs: Record<string, unknown>;
}): JSX.Element {
  return (
    <AgentMentionView
      attrs={attrs}
      isEditable={false}
      selected={false}
      Wrapper={AgentMentionStaticWrapper}
    />
  );
}

export function AgentMentionNodeView({
  deleteNode,
  editor,
  extension,
  node,
  selected
}: NodeViewProps): JSX.Element {
  const [isEditable, setIsEditable] = useState(editor.isEditable);
  const extensionOptions = extension.options as {
    removeActionAriaLabel?: string;
  };
  const removeActionAriaLabel =
    typeof extensionOptions.removeActionAriaLabel === "string"
      ? extensionOptions.removeActionAriaLabel
      : undefined;

  useEffect(() => {
    const syncEditable = () => {
      setIsEditable(editor.isEditable);
    };

    syncEditable();
    editor.on("transaction", syncEditable);
    editor.on("update", syncEditable);
    return () => {
      editor.off("transaction", syncEditable);
      editor.off("update", syncEditable);
    };
  }, [editor]);

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!editor.isEditable) {
      return;
    }
    deleteNode();
    if (!hasPromptContentAfterMentionRemoval(editor.state.doc)) {
      editor.commands.clearContent();
    }
  };

  return (
    <AgentMentionView
      attrs={node.attrs ?? {}}
      isEditable={isEditable}
      onRemove={handleRemove}
      removeActionAriaLabel={removeActionAriaLabel}
      selected={selected}
      Wrapper={AgentMentionNodeWrapper}
    />
  );
}
