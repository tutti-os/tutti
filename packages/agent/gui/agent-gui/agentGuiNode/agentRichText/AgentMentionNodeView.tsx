import { useEffect, useState, type JSX, type MouseEvent } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import {
  MentionPill,
  TruncatingPillLabel
} from "@tutti-os/ui-system/components";
import { CloseIcon } from "@tutti-os/ui-system/icons";
import { useTranslation } from "../../../i18n/index";
import {
  resolveAgentMentionFileThumbnailUrl,
  resolveAgentMentionFileVisualKind
} from "../../shared/mentionFilePresentation";
import { AGENT_RICH_TEXT_CARET_ANCHOR } from "./agentRichTextCaretAnchor";

type AgentMentionNodeViewKind =
  | "file"
  | "session"
  | "workspace-app"
  | "workspace-reference"
  | "workspace-app-factory"
  | "workspace-issue";

function parseFileCountAttr(value: unknown): number {
  const parsed =
    typeof value === "string" ? Number.parseInt(value.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

interface AgentMentionNodeViewModel {
  ariaLabel: string;
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
  return "file";
}

function normalizeSessionTitle(value: string): string {
  const trimmed = value.trim();
  const withoutMentionPrefix = trimmed.replace(/^@+/, "").trim();
  return withoutMentionPrefix || trimmed;
}

function parseDottedSessionText(
  value: string
): { participant: string; summary: string } | null {
  const parts = value
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  return {
    participant: `${parts[0]} & ${parts[1]}`,
    summary: normalizeSessionTitle(parts.slice(2).join(" "))
  };
}

function sessionPresentation(attrs: Record<string, unknown>): {
  label: string;
  summary: string;
} {
  const name = attrString(attrs, "name").trim();
  const initiatorName = attrString(attrs, "initiatorName").trim();
  const agentName = attrString(attrs, "agentName").trim();
  const title = normalizeSessionTitle(attrString(attrs, "title") || name);
  const inputPreview = attrString(attrs, "inputPreview").trim();

  if (initiatorName && agentName) {
    const dottedTitle = parseDottedSessionText(title);
    return {
      // i18n-check-ignore: Dynamic participant display names.
      label: `${initiatorName} & ${agentName}`,
      summary:
        dottedTitle?.summary || (title && title !== name ? title : inputPreview)
    };
  }

  const dottedName = parseDottedSessionText(name);
  if (dottedName) {
    return {
      label: dottedName.participant,
      summary: dottedName.summary
    };
  }

  return {
    label: name,
    summary: title && title !== name ? title : inputPreview
  };
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
    const presentation = sessionPresentation(attrs);
    const primary = `${presentation.label} ${presentation.summary}`.trim();
    return {
      ariaLabel:
        `${t("agentHost.agentGui.mentionKindSession")} ${primary}`.trim(),
      directoryPath: "",
      entryKind: "",
      href,
      kind,
      label: presentation.label,
      summary: presentation.summary
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

  const path = attrString(attrs, "path") || href;
  const entryKind = attrString(attrs, "entryKind") || "unknown";
  return {
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

function AgentMentionLegacyFileNodeView({
  deleteNode,
  editor,
  extension,
  node,
  selected
}: NodeViewProps): JSX.Element {
  const mention = mentionViewModel(node.attrs ?? {}, () => "");
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
    <NodeViewWrapper
      as="span"
      aria-label={mention.ariaLabel}
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
              className="absolute left-1/2 top-1/2 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--text-secondary)] opacity-0 transition-opacity hover:bg-transparency-block hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
              type="button"
              onMouseDown={handleRemove}
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
          <span
            className={`tsh-agent-object-token__icon transition-opacity ${
              isEditable
                ? "group-hover:opacity-0 group-focus-within:opacity-0"
                : ""
            }`}
            aria-hidden="true"
          />
          {isEditable ? (
            <button
              aria-label={removeActionAriaLabel}
              className="absolute left-1/2 top-1/2 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--text-secondary)] opacity-0 transition-opacity hover:bg-transparency-block hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
              type="button"
              onMouseDown={handleRemove}
            >
              <CloseIcon className="size-3.5" />
            </button>
          ) : null}
        </span>
      )}
      <span className="tsh-agent-object-token__main">{mention.label}</span>
    </NodeViewWrapper>
  );
}

export function AgentMentionNodeView(props: NodeViewProps): JSX.Element {
  const { deleteNode, editor, extension, node, selected } = props;
  const { t } = useTranslation();
  const mention = mentionViewModel(node.attrs ?? {}, t);
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

  if (mention.kind === "file") {
    return <AgentMentionLegacyFileNodeView {...props} />;
  }

  if (
    mention.kind === "workspace-app" ||
    mention.kind === "workspace-reference"
  ) {
    return (
      <NodeViewWrapper
        as="span"
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
        <span
          className="group relative top-0 inline-flex max-w-[min(100%,var(--agent-mention-max-width,16rem))] cursor-pointer items-center gap-1 overflow-hidden rounded-[4px] border border-transparent bg-transparent px-1 py-0 align-middle text-[13px] font-medium leading-6 text-[var(--agent-gui-mention-app-color,var(--tutti-purple))] no-underline transition-colors hover:border-transparent hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)]"
          data-agent-mention-kind={mention.kind}
          data-slot="mention-pill"
        >
          <span
            aria-hidden={isEditable ? undefined : true}
            className="relative grid size-4 shrink-0 place-items-center overflow-hidden rounded-[4px] bg-block"
            data-agent-mention-app-icon="true"
            data-workspace-app-icon="true"
          >
            {mention.iconUrl ? (
              <img
                src={mention.iconUrl}
                alt=""
                className={`size-full object-cover transition-opacity ${
                  isEditable
                    ? "group-hover:opacity-0 group-focus-within:opacity-0"
                    : ""
                }`}
                decoding="async"
                loading="lazy"
                draggable={false}
              />
            ) : (
              <span
                className={`tsh-agent-object-token__kind-icon size-4 transition-opacity ${
                  isEditable
                    ? "group-hover:opacity-0 group-focus-within:opacity-0"
                    : ""
                }`}
              />
            )}
            {isEditable ? (
              <button
                aria-label={removeActionAriaLabel}
                className="absolute left-1/2 top-1/2 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--text-secondary)] opacity-0 transition-opacity hover:bg-transparency-block hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
                type="button"
                onMouseDown={handleRemove}
              >
                <CloseIcon className="size-3.5" />
              </button>
            ) : null}
          </span>
          <TruncatingPillLabel tooltip={mention.label}>
            {mention.label}
          </TruncatingPillLabel>
        </span>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
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
        label={mention.label}
        removable={isEditable}
        removeButtonProps={
          isEditable
            ? {
                "aria-label": removeActionAriaLabel,
                onMouseDown: handleRemove
              }
            : undefined
        }
        summary={mention.summary}
      />
    </NodeViewWrapper>
  );
}
